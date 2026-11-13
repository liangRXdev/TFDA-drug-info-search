/**
 * 分享／深連結測試（docs/plan-formulary-share.md 驗收 D1–D9、E1–E4、E6、E7、F1）。
 * 頁面端以 jsdom 驗證 #q=／#share=；SW 端以 vm 執行 sw.js、送入真正的 Request。
 * 只用合成字串。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { makePage, helpers, tick, BASE, root } from './helpers/page.mjs';
import { SHARE_TARGET } from './share-contract.mjs';

const drug = (lic, name, ing) => ({
  licenseNumber: lic, chName: name, enName: name, ingredients: ing,
  isNhi: true, isRawMaterial: false, nhiMatches: [{ code: 'AA' + lic.padStart(8, '0').slice(-8), atcCode: '' }],
});
const EVIL = '<img src=x onerror=alert(1)>';
const DRUGS = [
  drug('1', 'Cozaar Tablets', 'LOSARTAN POTASSIUM'),          // 只在成分命中 losartan
  drug('2', 'Hyzaar Tablets', 'LOSARTAN;;HYDROCHLOROTHIAZIDE'),
  drug('3', 'Diovan Tablets', 'VALSARTAN'),
  drug('4', 'Amoxicillin Capsules', 'AMOXICILLIN'),
  drug('5', 'Lostan 50 Tab', 'SOMETHING'),                    // 品名含數字
  drug('6', `X${EVIL}Y Tab`, 'EVILINE'),                     // 品名含整段 XSS 字串（使高亮真的發生）
  drug('7', 'Losartan 50 mg Tab', 'LOSARTAN'),
];
const hashUrl = text => `${BASE}#q=${encodeURIComponent(text)}`;

// 計次 spy：包住全域 searchDrugs（app.js 內部呼叫走同一個全域綁定）
function spySearch(win) {
  const calls = [];
  const orig = win.searchDrugs;
  win.searchDrugs = (...args) => { calls.push({ args, value: win.document.getElementById('searchInput').value }); return orig(...args); };
  return calls;
}

async function sharePage(url, opts = {}) {
  let calls;
  const page = await makePage({ drugs: DRUGS, formulary: false, url, ...opts, beforeInit: w => { calls = spySearch(w); } });
  if (opts.data !== 'defer') await tick();
  return { ...page, h: helpers(page.win), calls: () => calls };
}

const activeScopes = doc => [...doc.querySelectorAll('.scope-btn.active')].map(b => b.dataset.scope);

// ── D 頁面端 ───────────────────────────────────────────────────
describe('D 深連結 #q=', () => {
  test('D1 只在成分出現的字串：範圍切到「全部」(both) 且結果正確', async () => {
    const { doc, h, calls } = await sharePage(hashUrl('losartan potassium'));
    assert.equal(doc.getElementById('searchInput').value, 'losartan potassium');
    assert.deepEqual(activeScopes(doc), ['both']);
    assert.deepEqual(h.licenses(), ['1']);
    assert.equal(calls().length, 1);
  });

  test('D2 空白與 #share=url：新開頁不搜尋', async () => {
    for (const url of [`${BASE}#q=`, hashUrl('   \n  '), `${BASE}#share=url`]) {
      const { doc, calls } = await sharePage(url);
      assert.equal(calls().length, 0, url);
      assert.equal(doc.getElementById('resultsSection').classList.contains('active'), false, url);
    }
    const { h } = await sharePage(`${BASE}#share=url`);
    assert.match(h.errorText(), /僅支援分享文字/);
  });

  test('D2 畫面已有結果時收到空白或 #share=url：結果與搜尋框不變、不搜尋', async () => {
    const { win, doc, h, calls } = await sharePage(BASE);
    await h.search('valsartan');
    const before = { lics: h.licenses(), value: doc.getElementById('searchInput').value, n: calls().length };
    for (const hash of ['#q=%20%20', '#share=url']) {
      win.location.hash = hash;
      await tick();
      assert.deepEqual(h.licenses(), before.lics, hash);
      assert.equal(doc.getElementById('searchInput').value, before.value);
      assert.equal(calls().length, before.n);
    }
  });

  test('D3 CRLF／CR／LF 取第一個非空白行；兩個入口都驗', async () => {
    for (const sep of ['\r\n', '\r', '\n']) {
      const text = `  ${sep}valsartan${sep}losartan${sep}`;
      const fresh = await sharePage(hashUrl(text));
      assert.equal(fresh.doc.getElementById('searchInput').value, 'valsartan', JSON.stringify(sep));
      assert.deepEqual(fresh.h.licenses(), ['3']);

      const loaded = await sharePage(BASE);
      loaded.win.location.hash = '#q=' + encodeURIComponent(text);
      await tick(150);
      assert.equal(loaded.doc.getElementById('searchInput').value, 'valsartan');
      assert.deepEqual(loaded.h.licenses(), ['3']);
    }
  });

  test('D3 60 字搜尋；61 字完整填入、不搜尋、有提示', async () => {
    const sixty = '藥'.repeat(58) + '😀a';                // 以 code point 計 60
    assert.equal([...sixty].length, 60);
    const a = await sharePage(hashUrl(sixty));
    assert.equal(a.calls().length, 1);

    const sixtyOne = sixty + 'b';
    const b = await sharePage(hashUrl(sixtyOne));
    assert.equal(b.doc.getElementById('searchInput').value, sixtyOne, '不得截短');
    assert.equal(b.calls().length, 0);
    assert.match(b.h.errorText(), /超過 60 字/);
  });

  test('D4 含數字且 0 筆：只以完整字串搜尋一次、提示但不改寫', async () => {
    const { doc, h, calls } = await sharePage(hashUrl('Amoxicillin 500 mg'));
    assert.equal(calls().length, 1);
    assert.equal(calls()[0].value, 'Amoxicillin 500 mg');
    assert.equal(doc.getElementById('searchInput').value, 'Amoxicillin 500 mg');
    assert.equal(h.cards().length, 0);
    assert.match(h.errorText(), /只留藥名/);
  });

  test('D4 反例：有結果且含數字、0 筆但不含數字，都不出現該提示', async () => {
    const withResult = await sharePage(hashUrl('lostan 50'));
    assert.deepEqual(withResult.h.licenses(), ['5']);
    assert.doesNotMatch(withResult.h.errorText(), /只留藥名/);
    const noDigit = await sharePage(hashUrl('nothinghere'));
    assert.equal(noDigit.h.cards().length, 0);
    assert.doesNotMatch(noDigit.h.errorText(), /只留藥名/);
  });

  test('D5 待執行：資料載完後恰好搜尋一次', async () => {
    const p = await sharePage(hashUrl('valsartan'), { data: 'defer' });
    assert.equal(p.calls().length, 0);
    p.release();
    await tick(150);
    assert.equal(p.calls().length, 1);
    assert.deepEqual(p.h.licenses(), ['3']);
    assert.equal(p.doc.getElementById('suggestBox').classList.contains('active'), false, '建議清單不得蓋住結果');
  });

  test('D5 連續兩次分享只搜尋後者', async () => {
    const p = await sharePage(hashUrl('aaa'), { data: 'defer' });
    p.win.location.hash = '#q=valsartan';
    await tick();
    p.release();
    await tick(150);
    assert.deepEqual(p.calls().map(c => c.value), ['valsartan']);
  });

  test('D5 分享後使用者修改搜尋框 → 載完不搜尋', async () => {
    const p = await sharePage(hashUrl('valsartan'), { data: 'defer' });
    const input = p.doc.getElementById('searchInput');
    // 改過再改回原字：只比對最終文字的實作會誤判為「沒改過」而照樣搜尋
    for (const v of ['valsartanx', 'valsartan']) {
      input.value = v;
      input.dispatchEvent(new p.win.Event('input', { bubbles: true }));
    }
    p.release();
    await tick(250);
    assert.equal(p.calls().length, 0);
  });

  test('D5 資料載入失敗 → 不搜尋、搜尋框保留文字', async () => {
    const p = await sharePage(hashUrl('valsartan'), { data: 'fail' });
    await tick();
    assert.equal(p.calls().length, 0);
    assert.equal(p.doc.getElementById('searchInput').value, 'valsartan');
  });

  test('D5 已有待執行 A，再收到空白／61 字／解碼失敗／#share=error → 都不得搜尋 A', async () => {
    for (const next of ['#q=%20', '#q=' + encodeURIComponent('x'.repeat(61)), '#q=%E0%A4%A', '#share=error']) {
      const p = await sharePage(hashUrl('valsartan'), { data: 'defer' });
      p.win.location.hash = next;
      await tick();
      p.release();
      await tick(150);
      assert.equal(p.calls().length, 0, next);
    }
  });

  test('D6 資料未載入前 fragment 已清除；載入失敗亦同；不寫入 console', async () => {
    const secret = 'ZZTEST 王○明 losartan';
    for (const data of ['defer', 'fail']) {
      const p = await sharePage(hashUrl(secret), { data });
      assert.equal(p.win.location.hash, '', data);
      assert.ok(!p.win.location.href.includes('ZZTEST'));
      assert.ok(!p.win.location.href.includes(encodeURIComponent('ZZTEST')));
      assert.equal(p.win.history.state, null);
      if (p.release) { p.release(); await tick(150); }
      await tick();
      assert.ok(!p.consoleLines.some(l => l.includes('ZZTEST')), 'console 不得出現分享文字');
    }
  });

  test('D7 解碼失敗：不搜尋、搜尋框不變、有提示、fragment 已清除', async () => {
    const p = await sharePage(`${BASE}#q=%E0%A4%A`);
    assert.equal(p.calls().length, 0);
    assert.equal(p.doc.getElementById('searchInput').value, '');
    assert.match(p.h.errorText(), /無法解讀/);
    assert.equal(p.win.location.hash, '');
  });

  test('D8 含 HTML 的分享文字：原樣進搜尋框並真的高亮，無注入元素', async () => {
    const p = await sharePage(hashUrl(EVIL));
    assert.equal(p.doc.getElementById('searchInput').value, EVIL);
    assert.deepEqual(p.h.licenses(), ['6']);
    const name = p.h.cardOf('6').querySelector('.drug-name-ch');
    assert.equal(name.textContent, `X${EVIL}Y Tab`);
    assert.equal(name.querySelector('.hl').textContent, EVIL, '高亮須確實發生');
    assert.equal(p.doc.querySelectorAll('body img, body [onerror]').length, 0);
  });

  test('D9 #share=error：不搜尋、有提示、fragment 已清除', async () => {
    const p = await sharePage(`${BASE}#share=error`);
    assert.equal(p.calls().length, 0);
    assert.match(p.h.errorText(), /讀取失敗/);
    assert.equal(p.win.location.hash, '');
  });
});

// ── E Service Worker ──────────────────────────────────────────
const SCOPE = BASE;
const swSrc = readFileSync(join(root, 'sw.js'), 'utf-8');

function makeSw() {
  const listeners = {};
  const spy = { fetch: 0, put: 0, addAll: [] };
  const ctx = {
    URL, Response, Request, console,
    self: {
      addEventListener: (type, fn) => { listeners[type] = fn; },
      location: new URL(SCOPE),
      registration: { scope: SCOPE },
      clients: { matchAll: async () => [], claim: async () => {} },
      skipWaiting: () => {},
    },
    caches: {
      async match() { return undefined; },
      async open() {
        return {
          async match() { return undefined; },
          async put() { spy.put += 1; },
          async addAll(list) { spy.addAll.push(...list); },
        };
      },
      async keys() { return []; },
      async delete() { return true; },
    },
    fetch: async () => { spy.fetch += 1; return new Response('network', { status: 200 }); },
  };
  vm.createContext(ctx);
  vm.runInContext(swSrc, ctx);
  return { listeners, spy };
}

async function dispatch(sw, request) {
  let responded = 'not-handled';
  const waits = [];
  sw.listeners.fetch({ request, respondWith(p) { responded = p; }, waitUntil(p) { waits.push(p); } });
  const resp = await responded;
  await Promise.all(waits);
  return resp;
}

// 依分享契約建立真正的 POST（不使用假的 formData）
function shareRequest(fields, { url = new URL(SHARE_TARGET.action, SCOPE).href, contentType = SHARE_TARGET.enctype, body } = {}) {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) form.set(SHARE_TARGET.params[k], v);
  return new Request(url, { method: SHARE_TARGET.method, headers: { 'Content-Type': contentType }, body: body ?? form.toString() });
}

const fragmentOf = resp => new URL(resp.headers.get('Location')).hash;
const decodedQ = resp => decodeURIComponent(fragmentOf(resp).replace(/^#q=/, ''));

describe('E 分享入口（sw.js）', () => {
  test('E1 POST ./share → 303 到 scope#q=，不發網路請求、不寫快取', async () => {
    const sw = makeSw();
    const resp = await dispatch(sw, shareRequest({ text: 'losartan 50 mg', title: '標題', url: '' }));
    assert.equal(resp.status, 303);
    const loc = new URL(resp.headers.get('Location'));
    assert.equal(loc.origin + loc.pathname, SCOPE);
    assert.equal(decodedQ(resp), 'losartan 50 mg');
    assert.ok(!fragmentOf(resp).includes('+'), '空白不得變成 +');
    assert.equal(sw.spy.fetch, 0);
    assert.equal(sw.spy.put, 0);
  });

  test('E2 各分支：只有網址、讀取失敗、超長截斷、GET', async () => {
    const sw = makeSw();
    assert.equal(fragmentOf(await dispatch(sw, shareRequest({ text: '', url: 'https://example.com/x' }))), '#share=url');
    const broken = shareRequest({}, { contentType: 'multipart/form-data; boundary=zz', body: 'not multipart' });
    assert.equal(fragmentOf(await dispatch(sw, broken)), '#share=error');

    const crossing = 'a'.repeat(499) + '😀' + 'b'.repeat(100);
    const got1 = decodedQ(await dispatch(sw, shareRequest({ text: crossing })));
    assert.equal(got1, 'a'.repeat(499) + '😀');
    const after = 'a'.repeat(500) + '😀' + 'b'.repeat(99);
    const got2 = decodedQ(await dispatch(sw, shareRequest({ text: after })));
    assert.equal(got2, 'a'.repeat(500));
    assert.ok(got1.isWellFormed() && got2.isWellFormed(), '不得產生半個代理對');

    const get = await dispatch(sw, new Request(new URL('./share?text=secret', SCOPE).href));
    assert.equal(get.status, 303);
    assert.equal(get.headers.get('Location'), SCOPE);
    assert.equal(sw.spy.fetch, 0);
    assert.equal(sw.spy.put, 0);
  });

  test('E3 反例：其他路徑的 share 不被分享分支處理', async () => {
    for (const url of ['https://example.org/NHI-drug-price-history/share', SCOPE + 'shared', SCOPE + 'x/share']) {
      const sw = makeSw();
      const resp = await dispatch(sw, shareRequest({ text: 'x' }, { url }));
      assert.notEqual(resp?.status, 303, url);
      assert.equal(sw.spy.fetch, 1, `${url} 應走一般同源網路分支`);
    }
  });

  test('E4 反例：一般導覽仍為 network-first', async () => {
    const sw = makeSw();
    const resp = await dispatch(sw, new Request(SCOPE));
    assert.equal(await resp.text(), 'network');
    assert.equal(sw.spy.fetch, 1);
  });

  test('E6 install 實際預快取 formulary.js；script 順序；版本與 CI 關卡', async () => {
    const sw = makeSw();
    const waits = [];
    sw.listeners.install({ waitUntil(p) { waits.push(p); } });
    await Promise.all(waits);
    assert.ok(sw.spy.addAll.includes('./formulary.js'));
    assert.ok(sw.spy.addAll.includes('./app.js'));

    const html = readFileSync(join(root, 'index.html'), 'utf-8');
    const fIdx = html.indexOf('<script src="./formulary.js"></script>');
    const aIdx = html.indexOf('<script src="./app.js"></script>');
    assert.ok(fIdx > 0 && fIdx < aIdx, 'formulary.js 須在 app.js 之前');

    const v = Number(/const STATIC_CACHE = 'tfda-static-v(\d+)'/.exec(swSrc)[1]);
    assert.ok(v > 11);
    const yml = readFileSync(join(root, '.github', 'workflows', 'test.yml'), 'utf-8');
    assert.match(yml, /for f in [^;]*\bformulary\.js\b[^;]*; do/);
  });

  test('E7 端到端：SW 轉址的 Location 交給頁面，搜尋框與結果正確', async () => {
    const sw = makeSw();
    const resp = await dispatch(sw, shareRequest({ text: 'Losartan 50 mg' }));
    const p = await sharePage(resp.headers.get('Location'));
    assert.equal(p.doc.getElementById('searchInput').value, 'Losartan 50 mg');
    assert.deepEqual(p.h.licenses(), ['7']);
    assert.equal(p.win.location.hash, '');
  });
});

// ── F1 每個測試檔都在 npm test 裡 ────────────────────────────────
test('F1 package.json 的 test 指令包含 tests/ 下每一個 .spec.mjs', () => {
  const script = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).scripts.test;
  const specs = readdirSync(join(root, 'tests')).filter(f => f.endsWith('.spec.mjs'));
  assert.ok(specs.length >= 8);
  for (const f of specs) assert.ok(script.includes(`tests/${f}`), `npm test 缺少 ${f}`);
});
