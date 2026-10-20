/**
 * 美國處方藥仿單參考區塊的前端測試（docs/plan-us-label.md §9：A2 文案、B4、C1–C3、§8.2）。
 *
 * 與 xss.spec.mjs 相同做法：jsdom 載入 index.html，再於同一個 window 執行 app.js。
 * fetch 以假路由取代：先餵入主資料讓 initDatabase() 記下 usLabelRulesVersion，
 * 再依各測試切換 us_label_data.json 的回應。
 *
 * 測試順序有意義：fetchUsLabelData() 成功後會快取（single-flight），
 * 失敗路徑必須排在第一次成功之前。
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const RULES = 1;
const SETID = '0a1b2c3d-1111-2222-3333-444455556666';
const SETID_B = '9f8e7d6c-1111-2222-3333-444455556666';

let win;
let usLabelResponse = () => Promise.reject(new Error('not set'));
let usLabelCalls = 0;

const jsonResp = (obj, init = {}) => ({
  ok: init.status ? init.status < 400 : true,
  status: init.status || 200,
  json: async () => (typeof obj === 'string' ? JSON.parse(obj) : obj),
});

const src = (id, extra = {}) => ({ id, v: '3', name: 'COUMADIN', mfr: 'BMS', app: 'NDA009218', eff: '20250115', ...extra });

const DATA = {
  _meta: { matchRulesVersion: RULES, openfdaExportDate: '2026-10-16' },
  data: {
    'ORAL|WARFARIN': { s: 'bw', n: 3, m: 2, r: src(SETID), bw: ['WARNING: BLEEDING RISK\nMajor bleeding.'],
      preg: { st: 'ok', sec: 'pregnancy', t: ['8.1 Pregnancy Risk Summary', 'Contraindicated.'] },
      lact: { st: 'ok', sec: '8.2 Lactation', t: ['8.2 Lactation Risk Summary ...'] } },
    'ORAL|X': { s: 'bw', n: 3, m: 1, r: src(SETID), b: src(SETID_B, { name: 'GENERIC X', app: 'ANDA1' }),
      bw: ['B SOURCE BW'], preg: { st: 'none' }, lact: { st: 'unextractable' } },
    'ORAL|AMLODIPINE': { s: 'nobw', n: 5, m: 0, r: src(SETID, { name: 'NORVASC' }),
      preg: { st: 'none' }, lact: { st: 'ok', sec: 'nursing_mothers', t: ['Old format.'] } },
    'TOPICAL|NOTHING': { s: 'nomatch' },
    'ORAL|DOWN': { s: 'unavailable' },
    'ORAL|BROKEN': { s: 'nobw', n: 1, m: 0, r: src(SETID), bw: ['should not be here'] },
  },
};

before(async () => {
  const html = readFileSync(join(root, 'index.html'), 'utf-8');
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://example.org/',
    beforeParse(w) {
      w.fetch = (url) => {
        const u = String(url);
        if (u.endsWith('drugs_data.json')) {
          return Promise.resolve(jsonResp({ _meta: { totalRecords: 1, usLabelRulesVersion: RULES }, data: [] }));
        }
        if (u.endsWith('data_version.json')) {
          return Promise.resolve(jsonResp({ generatedAt: '2026-10-20T00:00:00', usLabelGeneratedAt: '2026-10-20T00:00:00' }));
        }
        if (u.endsWith('us_label_data.json')) {
          usLabelCalls++;
          return usLabelResponse();
        }
        return Promise.reject(new Error('unexpected ' + u));
      };
    },
  });
  win = dom.window;
  win.eval(readFileSync(join(root, 'app.js'), 'utf-8'));
  await win.initDatabase();
});

function mountCard(drug) {
  const div = win.document.createElement('div');
  div.innerHTML = win.buildCard({ licenseNumber: 'X', ...drug }, '');
  win.document.getElementById('resultsContainer').appendChild(div);
  return div;
}

async function openSection(drug) {
  const card = mountCard(drug);
  const details = card.querySelector('details.us-label');
  await win.loadUsLabelInto(details);
  return details;
}

const text = el => el.textContent.replace(/\s+/g, ' ');
const NEGATIVE = /無 Boxed Warning|未列 Boxed Warning|沒有 Boxed Warning(?!」)/;

// ── 區塊是否出現（不需載入）──────────────────────────────────────
describe('buildUsLabelSection', () => {
  test('notApplicable（原料藥等）不顯示區塊', () => {
    assert.equal(mountCard({ usLabelStatus: 'notApplicable' }).querySelector('details.us-label'), null);
  });

  test('noMatch 直接顯示 ③，不需載入資料檔', () => {
    const d = mountCard({ usLabelStatus: 'noMatch' }).querySelector('details.us-label');
    assert.equal(d.dataset.usReady, '1');
    assert.match(text(d), /查無可對應的美國處方藥仿單/);
  });

  test('unavailable 與缺欄位都顯示不可用，不出現任何 BW 結論', () => {
    for (const drug of [{ usLabelStatus: 'unavailable' }, {}]) {
      const d = mountCard(drug).querySelector('details.us-label');
      assert.match(text(d), /暫時無法提供/);
      assert.doesNotMatch(text(d), /Boxed Warning/);
    }
  });

  test('有鍵者摺疊、預設不展開，並帶 data-us-key', () => {
    const d = mountCard({ usLabelKey: 'ORAL|WARFARIN' }).querySelector('details.us-label');
    assert.equal(d.open, false);
    assert.equal(d.dataset.usKey, 'ORAL|WARFARIN');
  });
});

// ── B4：載入失敗一律不可用（須排在第一次成功之前）──────────────────
describe('載入失敗 → 不可用（B4）', () => {
  const cases = [
    ['404', () => Promise.resolve(jsonResp({}, { status: 404 }))],
    ['非 JSON', () => Promise.resolve({ ok: true, status: 200, json: async () => { throw new SyntaxError('x'); } })],
    ['網路錯誤', () => Promise.reject(new TypeError('offline'))],
    ['規則版本不符', () => Promise.resolve(jsonResp({ ...DATA, _meta: { matchRulesVersion: RULES + 1 } }))],
    ['data 為陣列', () => Promise.resolve(jsonResp({ _meta: { matchRulesVersion: RULES }, data: [] }))],
  ];
  for (const [name, resp] of cases) {
    test(name, async () => {
      usLabelResponse = resp;
      const d = await openSection({ usLabelKey: 'ORAL|WARFARIN' });
      assert.match(text(d), /暫時無法提供/);
      assert.doesNotMatch(text(d), /BLEEDING|未找到 Boxed Warning|8\.1 Pregnancy/);
      assert.notEqual(d.dataset.usReady, '1', '失敗不得標記為已載入（才能重試）');
    });
  }

  test('失敗後再展開且成功 → 顯示正確內容（重試）', async () => {
    usLabelResponse = () => Promise.reject(new TypeError('offline'));
    const card = mountCard({ usLabelKey: 'ORAL|WARFARIN' });
    const d = card.querySelector('details.us-label');
    await win.loadUsLabelInto(d);
    assert.match(text(d), /暫時無法提供/);
    usLabelResponse = () => Promise.resolve(jsonResp(DATA));
    await win.loadUsLabelInto(d);
    assert.match(text(d), /WARNING: BLEEDING RISK/);
    assert.equal(d.dataset.usReady, '1');
  });
});

// ── 成功後的呈現（資料檔已快取）──────────────────────────────────
describe('呈現（A2、A9、§6.4）', () => {
  test('① 顯示 BW 原文、N/M、代表仿單與固定警示', async () => {
    const d = await openSection({ usLabelKey: 'ORAL|WARFARIN' });
    const t = text(d);
    assert.match(t, /以下為 openFDA 收錄之美國處方藥仿單內容.*並非本品項的台灣核准資訊/);
    assert.match(t, /WARNING: BLEEDING RISK/);
    assert.match(t, /3 份參考仿單中，2 份列有 Boxed Warning/);
    assert.match(t, /代表仿單：COUMADIN · BMS · NDA009218 · 生效日 2025-01-15/);
    assert.match(t, /8\.1 Pregnancy Risk Summary/);
    assert.match(t, /8\.2 Lactation/);
    assert.match(t, /另有 2 份仿單/);
    assert.match(t, /openFDA 資料日期 2026-10-16/);
    // 原文換行保留在 pre-wrap 區塊內
    assert.match(d.querySelector('.us-label-bw .us-label-text').textContent, /RISK\nMajor/);
  });

  test('① 代表仿單無 BW → 標示 BW 取自另一份仿單並列出其來源', async () => {
    const d = await openSection({ usLabelKey: 'ORAL|X' });
    const t = text(d);
    assert.match(t, /代表仿單中未找到 Boxed Warning，以下取自另一份仿單：GENERIC X/);
    assert.match(t, /B SOURCE BW/);
    const hrefs = [...d.querySelectorAll('a')].map(a => a.getAttribute('href'));
    assert.ok(hrefs.includes(`https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=${SETID_B}`));
    assert.match(t, /無法自動擷取此段落，請見 DailyMed/);
    assert.match(t, /代表仿單中未找到此段落/);
  });

  test('② 只做正面陳述：含「未找到」與「不代表本成分沒有」，不得出現否定措辭', async () => {
    const d = await openSection({ usLabelKey: 'ORAL|AMLODIPINE' });
    const t = text(d);
    assert.match(t, /5 份美國處方藥仿單中未找到 Boxed Warning/);
    assert.match(t, /不代表本成分沒有 Boxed Warning/);
    assert.doesNotMatch(t, /無 Boxed Warning|未列 Boxed Warning/);
    assert.match(t, /Nursing Mothers（舊格式）/);
    assert.ok(d.querySelector('a[href^="https://dailymed.nlm.nih.gov/dailymed/search.cfm?"]'));
  });

  test('③ 與鍵層級 unavailable', async () => {
    assert.match(text(await openSection({ usLabelKey: 'TOPICAL|NOTHING' })), /查無可對應/);
    const d = await openSection({ usLabelKey: 'ORAL|DOWN' });
    assert.match(text(d), /暫時無法提供/);
  });

  test('主資料有鍵但資料檔缺此鍵 → 不可用', async () => {
    const d = await openSection({ usLabelKey: 'ORAL|MISSING' });
    assert.match(text(d), /暫時無法提供/);
    assert.doesNotMatch(text(d), /Boxed Warning/);
  });

  test('違反資料契約的條目（② 卻帶 BW）→ 不可用，不顯示 BW', async () => {
    const d = await openSection({ usLabelKey: 'ORAL|BROKEN' });
    assert.match(text(d), /暫時無法提供/);
    assert.doesNotMatch(text(d), /should not be here/);
  });

  test('原型鍵不會讀到 Object.prototype', async () => {
    const d = await openSection({ usLabelKey: '__proto__' });
    assert.match(text(d), /暫時無法提供/);
  });
});

// ── §8.2 併發：只抓一次、每張卡片只顯示自己的鍵 ─────────────────────
describe('併發與身分隔離（§8.2、B4）', () => {
  test('兩張不同鍵的卡片同時展開：各自顯示自己的內容', async () => {
    const a = mountCard({ usLabelKey: 'ORAL|WARFARIN' }).querySelector('details.us-label');
    const b = mountCard({ usLabelKey: 'ORAL|AMLODIPINE' }).querySelector('details.us-label');
    await Promise.all([win.loadUsLabelInto(a), win.loadUsLabelInto(b)]);
    assert.match(text(a), /BLEEDING/);
    assert.doesNotMatch(text(a), /NORVASC/);
    assert.match(text(b), /NORVASC/);
    assert.doesNotMatch(text(b), /BLEEDING/);
  });

  test('成功後不重複下載資料檔', async () => {
    const before = usLabelCalls;
    await openSection({ usLabelKey: 'ORAL|WARFARIN' });
    await openSection({ usLabelKey: 'ORAL|AMLODIPINE' });
    assert.equal(usLabelCalls, before);
  });

  test('點擊 summary 觸發載入（事件委派，無 inline handler）', async () => {
    const card = mountCard({ usLabelKey: 'ORAL|WARFARIN' });
    const summary = card.querySelector('.us-label-summary');
    assert.equal(summary.getAttribute('onclick'), null);
    summary.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    for (let i = 0; i < 5 && card.querySelector('details').dataset.usReady !== '1'; i++) {
      await new Promise(r => setTimeout(r, 0));
    }
    assert.match(text(card), /BLEEDING/);
  });
});

// ── C1–C3：惡意資料 ─────────────────────────────────────────────
describe('惡意資料（C1–C3）', () => {
  const evil = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  const evilSrc = { id: 'javascript:alert(1)', v: evil, name: evil, mfr: evil, app: evil, eff: evil };
  const entry = { s: 'bw', n: 2, m: 1, r: evilSrc, b: { ...evilSrc, id: `${SETID}"onmouseover="x` },
    bw: [evil, 'javascript:alert(3)'], preg: { st: 'ok', sec: evil, t: [evil] },
    lact: { st: 'ok', sec: 'nursing_mothers', t: [evil] } };

  let div;
  before(() => {
    div = win.document.createElement('div');
    div.innerHTML = win.renderUsLabel(entry, `ORAL|${evil}`, { openfdaExportDate: evil });
  });

  test('惡意文字以純文字保留，不產生可執行節點或事件屬性', () => {
    assert.equal(div.querySelectorAll('script, img').length, 0);
    for (const el of div.querySelectorAll('*')) {
      for (const attr of el.attributes) assert.ok(!attr.name.toLowerCase().startsWith('on'), attr.name);
    }
    assert.ok(div.textContent.includes('<img src=x onerror=alert(1)>'), '原文應以純文字保留，不是被刪掉');
    assert.ok(div.textContent.includes('javascript:alert(3)'));
  });

  test('非 UUID 的 set_id 不產生連結；所有 href 皆為 DailyMed https', () => {
    const hrefs = [...div.querySelectorAll('a[href]')].map(a => a.getAttribute('href'));
    for (const h of hrefs) {
      assert.match(h, /^https:\/\/dailymed\.nlm\.nih\.gov\/dailymed\/(search\.cfm\?|drugInfo\.cfm\?setid=[0-9a-f-]{36}$)/, h);
    }
    assert.ok(!hrefs.some(h => h.includes('drugInfo')), '兩個來源的 set_id 都不合法，不應有 drugInfo 連結');
  });

  test('搜尋連結的查詢字串已編碼', () => {
    const a = div.querySelector('a[href*="search.cfm"]');
    if (a) assert.doesNotMatch(a.getAttribute('href'), /[<>" ]/);
  });

  test('dailyMedSetUrl：只接受 UUID', () => {
    assert.equal(win.dailyMedSetUrl(SETID), `https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=${SETID}`);
    for (const bad of ['', null, 'javascript:alert(1)', `${SETID}x`, `${SETID}"`, '../x']) {
      assert.equal(win.dailyMedSetUrl(bad), '', String(bad));
    }
  });

  test('safeUrl：DailyMed 放行，偽裝網域與 http 拒絕，原有官方網域仍放行', () => {
    assert.equal(win.safeUrl('https://dailymed.nlm.nih.gov/dailymed/x'), 'https://dailymed.nlm.nih.gov/dailymed/x');
    for (const bad of ['https://dailymed.nlm.nih.gov.evil.com/x', 'https://evildailymed.nlm.nih.gov/x',
      'https://dailymed.nlm.nih.gov@evil.com/x', 'http://dailymed.nlm.nih.gov/x', 'https://nlm.nih.gov/x',
      'https://www.nih.gov/x']) {
      assert.equal(win.safeUrl(bad), '', bad);
    }
    assert.equal(win.safeUrl('https://mcp.fda.gov.tw/im_detail_1/x'), 'https://mcp.fda.gov.tw/im_detail_1/x');
    assert.equal(win.safeUrl('https://info.nhi.gov.tw/INAE3000/INAE3000S01'), 'https://info.nhi.gov.tw/INAE3000/INAE3000S01');
  });
});

// ── B5：SW 的仿單檔驗證函式（node 隔離執行 sw.js）──────────────────────
describe('sw.js 驗證函式（B5）', () => {
  let sw;
  before(() => {
    const ctx = { self: { addEventListener() {}, location: { origin: 'https://example.org' } }, URL, Response, console };
    vm.createContext(ctx);
    vm.runInContext(readFileSync(join(root, 'sw.js'), 'utf-8'), ctx);
    sw = ctx;
  });

  const resp = (body, ctype = 'application/json') => new Response(
    typeof body === 'string' ? body : JSON.stringify(body), { headers: { 'Content-Type': ctype } });

  test('合法資料 → 接受', async () => {
    // 整份檔案只要有一個條目違反契約（ORAL|BROKEN）就整份拒絕，保留舊快取
    assert.equal(await sw.isValidDataResponse(resp(DATA), sw.isValidUsLabelData), false);
    const ok = { _meta: { matchRulesVersion: 1 }, data: { 'ORAL|WARFARIN': DATA.data['ORAL|WARFARIN'], 'TOPICAL|NOTHING': { s: 'nomatch' } } };
    assert.equal(await sw.isValidDataResponse(resp(ok), sw.isValidUsLabelData), true);
  });

  test('HTML 的 200、狀態與內容矛盾、缺來源、空資料 → 拒絕', async () => {
    const bad = [
      [resp('<html>error</html>', 'text/html')],
      [resp({ _meta: { matchRulesVersion: 1 }, data: { k: { s: 'nobw', n: 1, m: 0, r: { id: 'x' }, bw: ['x'] } } })],
      [resp({ _meta: { matchRulesVersion: 1 }, data: { k: { s: 'bw', n: 1, m: 1, bw: ['x'] } } })],
      [resp({ _meta: { matchRulesVersion: 1 }, data: {} })],
      [resp({ _meta: {}, data: { k: { s: 'nomatch' } } })],
    ];
    for (const [r] of bad) assert.equal(await sw.isValidDataResponse(r, sw.isValidUsLabelData), false);
  });

  test('主資料驗證行為不變', async () => {
    assert.equal(await sw.isValidDataResponse(resp({ _meta: { totalRecords: 3 }, data: [] }), sw.isValidDrugsData), true);
    assert.equal(await sw.isValidDataResponse(resp({ _meta: { totalRecords: 0 }, data: [] }), sw.isValidDrugsData), false);
    assert.equal(await sw.isValidDataResponse(resp('<html>', 'text/html'), sw.isValidDrugsData), false);
  });

  test('路由只認完整檔名', () => {
    const u = p => new URL('https://example.org' + p);
    assert.equal(sw.dataFileOf(u('/TFDA-drug-info-search/us_label_data.json')), 'us_label_data.json');
    assert.equal(sw.dataFileOf(u('/TFDA-drug-info-search/drugs_data.json')), 'drugs_data.json');
    assert.equal(sw.dataFileOf(u('/x/evil_us_label_data.json')), null);
  });

  test('前端與 SW 的條目驗證對同一批案例判定一致', () => {
    const cases = [...Object.values(DATA.data), null, {}, { s: 'nomatch', n: 1 },
      { s: 'bw', n: 1, m: 2, r: { id: 'x' }, bw: ['t'] }, { s: 'bw', n: 1, m: 1, r: { id: 'x' }, bw: ['  '] }];
    for (const c of cases) assert.equal(sw.isValidUsLabelEntry(c), win.isValidUsLabelEntry(c), JSON.stringify(c));
  });
});
