/**
 * ATC 搜尋的前端測試（docs/plan-atc-search.md 驗收條件）。
 *
 * 與其他 spec 相同：jsdom 載入 index.html 後在同一個 window 執行 app.js，
 * fetch 以假資料取代，再透過全域函式與 DOM 操作驗證。
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const nhi = (lic, en, ing, atc, extraAtc = []) => ({
  licenseNumber: lic, chName: en, enName: en, ingredients: ing, isNhi: true, isRawMaterial: false,
  nhiAtcCode: atc,
  nhiMatches: [{ code: 'AC00000000', atcCode: atc }, ...extraAtc.map(a => ({ code: 'BC00000000', atcCode: a }))],
});

const DRUGS = [
  nhi('L1', 'Cozaar Tablets', 'LOSARTAN POTASSIUM', 'C09CA01'),
  nhi('L2', 'Losartan Inj', 'LOSARTAN POTASSIUM', 'C09CA01'),             // 劑型篩選用（INJ → 注射劑）
  nhi('V1', 'Diovan Tablets', 'VALSARTAN', 'C09CA03'),
  nhi('K1', 'Capoten Tablets', 'CAPTOPRIL', 'C09AA01'),
  nhi('I1', 'Aprovel Tablets', 'IRBESARTAN', 'C09CA'),                    // 只登載到上層
  nhi('M1', 'Multi Tablets', 'METFORMIN HCL', 'A10BA02', ['c09ca06']),     // 次要代號（小寫）符合
  { licenseNumber: 'N1', chName: 'Losartan OTC', enName: 'Losartan OTC', ingredients: 'LOSARTAN',
    isNhi: false, isRawMaterial: false, nhiMatches: [] },                // 非健保：沒有 ATC
  nhi('X1', 'Evil Tablets', '<img src=x onerror=alert(1)>', 'C09CA08'),
  nhi('C99', 'C09 Brand Tablets', 'SOMETHING', 'N02BE01'),                // 品名含「C09」，ATC 不符
];

let win, doc;

before(async () => {
  const html = readFileSync(join(root, 'index.html'), 'utf-8');
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://example.org/',
    beforeParse(w) {
      w.fetch = (url) => {
        const u = String(url);
        if (u.endsWith('drugs_data.json')) {
          return Promise.resolve({ ok: true, status: 200, json: async () => ({ _meta: { totalRecords: DRUGS.length }, data: DRUGS }) });
        }
        if (u.endsWith('data_version.json')) return Promise.resolve({ ok: true, json: async () => ({}) });
        return Promise.reject(new Error('unexpected ' + u));
      };
    },
  });
  win = dom.window;
  doc = win.document;
  win.eval(readFileSync(join(root, 'app.js'), 'utf-8'));
  await win.initDatabase();
});

const tick = () => new Promise(r => setTimeout(r, 80));
const click = el => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
const scopeBtn = s => doc.querySelector(`.scope-btn[data-scope="${s}"]`);
const filterBtn = f => doc.querySelector(`.filter-btn[data-filter="${f}"]`);
const cards = () => [...doc.querySelectorAll('#resultsContainer .drug-card .badge-license')]
  .map(e => e.textContent.replace(/📋|\s|·.*/g, ''));
const container = () => doc.getElementById('resultsContainer');
const errorText = () => doc.getElementById('errorMsg').classList.contains('active') ? doc.getElementById('errorMsg').textContent : '';

async function searchAtc(q, scope = 'atc') {
  // 先清空再切範圍：範圍鈕在輸入框有值時會立即重搜，留下的舊搜尋會在稍後覆蓋本次結果
  doc.getElementById('searchInput').value = '';
  click(scopeBtn(scope));
  doc.getElementById('searchInput').value = q;
  win.searchDrugs();
  await tick();
}

describe('ATC 搜尋：比對', () => {
  before(() => click(filterBtn('all')));

  test('C09CA：開頭相符，不含 C09AA（ACEI）；次要代號符合也列出；登載恰為 C09CA 者列出', async () => {
    await searchAtc('C09CA');
    assert.deepEqual(cards().sort(), ['I1', 'L1', 'L2', 'M1', 'V1', 'X1']);
    assert.equal(container().querySelector('.atc-note-warn'), null, '與查詢同層不算「只登載到上層」');
  });

  test('C09CA01：只有 losartan；只登載到 C09CA 的不列入但有提示', async () => {
    await searchAtc('C09CA01');
    assert.deepEqual(cards().sort(), ['L1', 'L2']);
    const warn = container().querySelector('.atc-note-warn');
    assert.ok(warn, '應有上層代碼提示');
    assert.match(warn.textContent, /另有 1 筆的健保 ATC 只登載到\s*C09CA/);
  });

  test('非健保品項永遠不出現；固定顯示涵蓋範圍說明', async () => {
    await searchAtc('C09');
    assert.ok(!cards().includes('N1'));
    assert.match(container().querySelector('.atc-note').textContent, /僅涵蓋健保品項/);
  });

  test('小寫、空白、全形正規化', async () => {
    await searchAtc(' c09ca ');
    assert.deepEqual(cards().sort(), ['I1', 'L1', 'L2', 'M1', 'V1', 'X1']);
    await searchAtc('Ｃ０９ＣＡ０１');
    assert.deepEqual(cards().sort(), ['L1', 'L2']);
  });

  test('4 碼（第 4 層，如 C09C）合法', async () => {
    await searchAtc('C09C');
    assert.equal(errorText(), '');
    assert.deepEqual(cards().sort(), ['I1', 'L1', 'L2', 'M1', 'V1', 'X1']);
  });

  test('1 碼（解剖大類）允許', async () => {
    await searchAtc('C');
    assert.ok(cards().includes('K1') && cards().includes('L1'));
    assert.ok(!cards().includes('C99'));
  });

  // 合法長度只有 1／3／4／5／7 碼；C09C（4 碼）是合法的第 4 層
  for (const bad of ['C9', 'XYZ', 'losartan', 'C09CA0', 'C09CA011', '9C09']) {
    test(`格式不符不搜尋：${bad}`, async () => {
      await searchAtc(bad);
      assert.match(errorText(), /ATC 格式例/);
      assert.equal(doc.getElementById('resultsSection').classList.contains('active'), false);
    });
  }

  test('格式正確但查無 → 查無訊息＋涵蓋範圍說明', async () => {
    await searchAtc('Z99');
    assert.equal(errorText(), '');
    assert.match(container().textContent, /查無 ATC Z99 的健保品項/);
    assert.match(container().textContent, /僅涵蓋健保品項/);
  });

  test('「全部」範圍不使用 ATC 比對', async () => {
    await searchAtc('C09CA', 'both');
    assert.deepEqual(cards(), []);
    await searchAtc('C09', 'both');
    assert.deepEqual(cards(), ['C99']);           // 只因品名含 C09
    assert.equal(container().querySelector('.atc-summary'), null);
  });
});

describe('ATC 搜尋：分組摘要表', () => {
  const rows = () => [...container().querySelectorAll('.atc-table tbody tr')].map(tr => {
    const [code, ing, n] = [...tr.children].map(td => td.textContent.trim());
    return { code, ing, n: Number(n) };
  });
  const total = () => Number(/符合 (\d+) 筆/.exec(doc.getElementById('resultsMeta').textContent)[1]);

  before(() => click(filterBtn('all')));

  test('依代碼分組，計數加總等於篩選後總筆數；多 ATC 品項只算一次', async () => {
    await searchAtc('C09');
    const r = rows();
    assert.deepEqual(r.map(x => x.code), ['C09AA01', 'C09CA', 'C09CA01', 'C09CA03', 'C09CA06', 'C09CA08']);
    assert.equal(r.find(x => x.code === 'C09CA01').n, 2);
    assert.equal(r.find(x => x.code === 'C09CA01').ing, 'LOSARTAN POTASSIUM');
    assert.equal(r.reduce((s, x) => s + x.n, 0), total());
  });

  test('點代碼只顯示該組卡片；再點一次取消；「顯示全部」恢復', async () => {
    await searchAtc('C09');
    click(container().querySelector('.atc-row[data-atc="C09CA01"]'));
    assert.deepEqual(cards().sort(), ['L1', 'L2']);
    assert.equal(container().querySelector('.atc-row[data-atc="C09CA01"]').getAttribute('aria-pressed'), 'true');
    // 摘要表仍顯示整個類別（不因選定而縮小）
    assert.equal(rows().length, 6);
    click(container().querySelector('.atc-row[data-atc="C09CA01"]'));
    assert.equal(cards().length, 7);
    click(container().querySelector('.atc-row[data-atc="C09AA01"]'));
    click(container().querySelector('.atc-clear'));
    assert.equal(cards().length, 7);
  });

  test('篩選連動：劑型篩選改變摘要表計數', async () => {
    await searchAtc('C09CA01');
    assert.equal(rows()[0].n, 2);
    const inj = [...doc.querySelectorAll('.dosage-btn')].find(b => b.dataset.dosage === '注射劑');
    click(inj);
    assert.equal(rows()[0].n, 1);
    assert.deepEqual(cards(), ['L2']);
  });

  test('選定的代碼在篩選後已無品項 → 回到全部，不誤顯示查無', async () => {
    await searchAtc('C09');
    click(container().querySelector('.atc-row[data-atc="C09AA01"]'));
    assert.deepEqual(cards(), ['K1']);
    const inj = [...doc.querySelectorAll('.dosage-btn')].find(b => b.dataset.dosage === '注射劑');
    click(inj);
    assert.deepEqual(cards(), ['L2']);
    assert.doesNotMatch(container().textContent, /查無/);
  });

  test('成分欄：巢狀括號完整移除、複方以 + 連接', () => {
    assert.equal(win.ingredientLabel({ ingredients: 'TAK-491 (AZILSARTAN MEDOXOMIL (AS POTASSIUM SALT))' }), 'TAK-491');
    assert.equal(win.ingredientLabel({ ingredients: 'AMLODIPINE (AS BESYLATE);;valsartan' }), 'AMLODIPINE + VALSARTAN');
  });

  test('成分與代碼經 escape，不產生可執行節點', async () => {
    await searchAtc('C09CA08');
    assert.equal(container().querySelectorAll('.atc-summary img, .atc-summary script').length, 0);
    // 成分欄去掉括號內容後仍以純文字呈現原字串
    assert.match(container().querySelector('.atc-table').textContent, /<IMG SRC=X ONERROR=ALERT>/);
    for (const el of container().querySelectorAll('.atc-summary *')) {
      for (const a of el.attributes) assert.ok(!a.name.startsWith('on'), a.name);
    }
  });
});

describe('ATC 搜尋：建議清單', () => {
  // jsdom window 的物件與 node 的原型不同，轉成純 JSON 再比
  const suggest = q => JSON.parse(JSON.stringify(win.buildSuggestions(q)));

  test('名稱範圍輸入 C09 → 出現「以 ATC 搜尋」並附筆數', () => {
    click(scopeBtn('name'));
    const s = suggest('c09');
    assert.deepEqual(s[0], { type: 'atc', text: 'C09', count: 7 });
  });

  test('1–2 碼、格式不符、查無命中都不提示', () => {
    click(scopeBtn('name'));
    for (const q of ['C', 'A1', 'C0', 'C9X', 'Z99']) {
      assert.ok(!suggest(q).some(x => x.type === 'atc'), q);
    }
  });

  test('ATC 範圍下不給品名／成分建議', () => {
    click(scopeBtn('atc'));
    assert.deepEqual(suggest('LOSARTAN'), []);
  });

  test('點選 ATC 提示 → 範圍鈕同步切到 ATC 並搜尋', async () => {
    click(scopeBtn('name'));
    doc.getElementById('searchInput').value = 'C09CA01';
    doc.getElementById('searchInput').dispatchEvent(new win.Event('input'));
    await new Promise(r => setTimeout(r, 200));
    const item = doc.querySelector('#suggestBox .suggest-item');
    assert.ok(item, '應有建議');
    item.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true }));
    await tick();
    assert.ok(scopeBtn('atc').classList.contains('active'));
    assert.deepEqual(cards().sort(), ['L1', 'L2']);
  });
});
