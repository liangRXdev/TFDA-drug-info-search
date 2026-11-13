/**
 * 院內清單整合測試（docs/plan-formulary-share.md 驗收 A4–A10、B1–B6、B10–B12、C1–C5、F2、F3）。
 * jsdom 載入 index.html＋formulary.js＋app.js，IndexedDB 為 fake-idb。全部為合成資料。
 * 斷言一律以許可證字號／健保代號指名特定卡片與特定列。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makePage, helpers, tick } from './helpers/page.mjs';
import { makeFakeIdb } from './helpers/fake-idb.mjs';

const LIC = n => `衛署藥製字第${String(n).padStart(6, '0')}號`;
const drug = (n, name, { codes = [], nhi = codes.length > 0, atc = '', ing = 'SOMETHING' } = {}) => ({
  licenseNumber: LIC(n), chName: name, enName: name, ingredients: ing,
  isNhi: nhi, isRawMaterial: false, nhiAtcCode: atc,
  nhiMatches: codes.map(c => ({ code: c, enName: name, atcCode: atc, price: '1.00' })),
});

const DRUGS = [
  drug(1, 'Zeta Alpha Tab', { codes: ['AA00000001'], atc: 'C09CA01' }),
  drug(2, 'Zeta Beta Tab', { codes: ['AA00000002', 'AA00000003', 'AA00000004'], atc: 'C09CA03' }),
  drug(3, 'Zeta Gamma Inj', { codes: ['AA00000005'] }),
  drug(4, 'Zeta Delta Tab'),                                   // 非健保；以許可證對上（K2）
  drug(5, 'Zeta Epsilon Tab', { codes: ['AA00000006'] }),      // 只有名稱相同的候選
  drug(6, 'Zeta Zeta Tab', { codes: ['AA00000007'] }),         // K3 衝突的一端
  drug(7, 'Zeta Eta Tab', { codes: ['AA00000008'], atc: 'C09CA06' }),   // K3 衝突的另一端
  drug(8, 'Zeta Theta Tab', { codes: ['AA00000009'] }),        // 混合 K1、K2、空碼
  drug(9, 'Zeta Iota Tab', { codes: ['AA00000010'] }),         // 近似碼反例
  drug(10, 'Zeta Kappa Tab'),                                  // 全形許可證正例（K2）
  drug(11, 'Omega Cap', { codes: ['AA00000012', 'AA00000013'] }),
];

const HEADER = '院內代碼,藥名,英文品名,成分,健保代號,許可證字號';
const ROWS = [
  `C001,院內甲,,ZETALPHA,AA00000001,`,          // K1 → 1（名稱完全不同但代號對上；成分含 zeta 但不得進未對應區）
  `C002,院內乙,,BETAINE,AA00000003,`,           // K1 → 2 的 AA00000003 那一列
  `C003a,院內丙一,,GAMMA,AA00000005,`,          // K1 → 3
  `C003b,院內丙二,,GAMMA,ａａ 00000005,`,       // K1 → 3（正規化後同碼）
  `C004,院內丁,,DELTA,ZZ99999999,${LIC(4)}`,    // K2 → 4
  `C005,zeta  epsilon tab,,,,`,                  // K4；與 5 名稱相同 → 候選
  `C006,院內戊,,ZETAOL,AA00000007,${LIC(7)}`,   // K3：健保指 6、許可證指 7
  `M1,院內己,,THETA,AA00000009,`,               // K1 → 8
  `M2,院內庚,,THETA,,${LIC(8)}`,                // K2 → 8
  `,院內辛,,THETA,AA00000009,`,                 // K1 → 8，院內碼空
  `C009,院內壬,,IOTA,AA00000011,`,              // K4：末碼不同
  `C010,院內癸,,IOTA,AA0000001,`,               // K4：9 碼無效
  `C011,院內子,,,,衛署藥輸字第000009號`,         // K4：字別不同
  `C012,院內丑,,,,衛署藥製字000009`,             // K4：缺「第」「號」
  `C013,院內寅,,KAPPA,,衛署藥製字第 ０００ ０１０號`,   // K2 → 10
  `C014,院內卯,Zetamycin,ZETACILLIN,,`,          // K4；英文名含 zeta
  `C017,院內巳,,OMEGA,AA00000012,${LIC(11)}`,    // K1 → 11（雙鍵同指一張）
  `C016,,,FOO,AA00000013,`,                      // 無藥名 → 略過
  `c001,院內重複,,,AA00000013,`,                 // 院內碼重複 → 略過，不得讓 11 的 AA00000013 標碼
];
const csv = rows => [HEADER, ...rows].join('\r\n') + '\r\n';
const MAIN_CSV = csv(ROWS);
const buf = text => { const b = Buffer.from(text, 'utf-8'); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };

async function importText(win, name, text) {
  const b = buf(text);
  return win.importFormulary(name, b.byteLength, async () => b);
}

// 已匯入主清單的頁面
async function mainPage(extra = {}) {
  const fake = makeFakeIdb(extra.fake);
  const page = await makePage({ drugs: extra.drugs || DRUGS, idb: fake.idb });
  const h = helpers(page.win);
  const ok = await importText(page.win, 'hospital.csv', extra.csv || MAIN_CSV);
  await tick();
  return { ...page, h, fake, imported: ok };
}

const ALL_ZETA = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(LIC).sort();

// ── B 比對與標示 ───────────────────────────────────────────────
describe('B 卡片標示', () => {
  test('B1 K1：指定卡片院內碼集合恰等於預期，其他卡片皆無徽章', async () => {
    const { h, imported } = await mainPage();
    assert.equal(imported, true);
    await h.search('zeta');
    assert.deepEqual(h.licenses(), ALL_ZETA);
    assert.deepEqual(h.badgeCodes(LIC(1)), ['C001']);
    for (const n of [5, 6, 7, 9]) assert.deepEqual(h.badgeCodes(LIC(n)), [], `卡片 ${n} 不得有徽章`);
    for (const n of [5, 6, 7, 9]) assert.equal(h.cardOf(LIC(n)).querySelector('.badge-formulary'), null);
  });

  test('B1 混合卡片：院內碼＝K1＋K2 的非空碼；健保代號列只出現 K1 的碼', async () => {
    const { h } = await mainPage();
    await h.search('theta');
    assert.deepEqual(h.badgeCodes(LIC(8)), ['M1', 'M2']);
    const m2 = [...h.cardOf(LIC(8)).querySelectorAll('.badge-formulary .formulary-code')].find(e => e.textContent === 'M2');
    assert.equal(m2.dataset.via, 'license');
    assert.match(h.cardOf(LIC(8)).querySelector('.badge-formulary').textContent, /M2（以許可證字號對應）/);
    assert.deepEqual(h.rowCodes(LIC(8), 'AA00000009'), ['M1'], '空碼 K1 不帶代碼、K2 的 M2 不得出現在健保列');
  });

  test('B2 只有名稱相同（無代碼）→ 無徽章、只有「可能為院內品項」，限院內不含它', async () => {
    const { h } = await mainPage();
    await h.search('zeta');
    const c5 = h.cardOf(LIC(5));
    assert.equal(c5.querySelector('.badge-formulary'), null);
    assert.match(c5.querySelector('.badge-formulary-maybe').textContent, /可能為院內品項（名稱比對，未驗證）/);
    assert.equal(h.cardOf(LIC(1)).querySelector('.badge-formulary-maybe'), null, 'K1 卡片不顯示候選');
    h.setOnly(true);
    assert.equal(h.cardOf(LIC(5)), null);
  });

  test('B3 一證三碼、清單只含其一：只有指定那列有院內碼', async () => {
    const { h } = await mainPage();
    await h.search('zeta beta');
    assert.deepEqual(h.rowCodes(LIC(2), 'AA00000003'), ['C002']);
    assert.deepEqual(h.rowCodes(LIC(2), 'AA00000002'), []);
    assert.deepEqual(h.rowCodes(LIC(2), 'AA00000004'), []);
  });

  test('B4 同一健保代號對到 2 個院內碼：指定列的院內碼恰為兩個', async () => {
    const { h } = await mainPage();
    await h.search('zeta gamma');
    assert.deepEqual(h.rowCodes(LIC(3), 'AA00000005'), ['C003a', 'C003b']);
    assert.deepEqual(h.badgeCodes(LIC(3)), ['C003a', 'C003b']);
  });

  test('B5 K2：以許可證字號對應的徽章與院內碼；健保代號表不標任何列', async () => {
    const { h } = await mainPage();
    await h.search('zeta delta');
    assert.deepEqual(h.badgeCodes(LIC(4)), ['C004']);
    assert.match(h.cardOf(LIC(4)).querySelector('.badge-formulary').textContent, /以許可證字號對應/);
    await h.search('zeta kappa');
    assert.deepEqual(h.badgeCodes(LIC(10)), ['C013'], '全形／夾空白的許可證字號須命中');
    await h.search('zeta theta');
    assert.equal(h.rowCodes(LIC(8), 'AA00000009').includes('M2'), false);
  });

  test('B6 K3：衝突的兩張卡片皆無徽章；未對應區標「代碼衝突」；限院內不含兩者', async () => {
    const { h, doc } = await mainPage();
    await h.search('zeta');
    assert.equal(h.cardOf(LIC(6)).querySelector('.badge-formulary'), null);
    assert.equal(h.cardOf(LIC(7)).querySelector('.badge-formulary'), null);
    const row = [...doc.querySelectorAll('.formulary-unmatched tbody tr')].find(r => r.cells[0].textContent === 'C006');
    assert.equal(row.dataset.kind, 'K3');
    assert.match(row.textContent, /代碼衝突/);
    h.setOnly(true);
    assert.equal(h.cardOf(LIC(6)), null);
    assert.equal(h.cardOf(LIC(7)), null);
  });

  test('B8 近似碼與近似許可證字號不命中；被排除的重複列不得標碼', async () => {
    const { h } = await mainPage();
    await h.search('zeta iota');
    assert.equal(h.cardOf(LIC(9)).querySelector('.badge-formulary'), null);
    await h.search('omega');
    assert.deepEqual(h.rowCodes(LIC(11), 'AA00000013'), [], '重複院內碼與無藥名列不得產生標碼');
    assert.deepEqual(h.rowCodes(LIC(11), 'AA00000012'), ['C017']);
  });

  test('B9 匯入摘要六個數字與總列數', async () => {
    const { doc } = await mainPage();
    const detail = doc.getElementById('formularyDetail').textContent;
    assert.match(detail, /共 19 列/);
    assert.match(detail, /健保代號對應 7/);
    assert.match(detail, /許可證對應 3/);
    assert.match(detail, /代碼衝突 1/);
    assert.match(detail, /未對應 6/);
    assert.match(detail, /無藥名 1/);
    assert.match(detail, /院內碼重複 1/);
  });
});

// ── B10 未對應區塊 ─────────────────────────────────────────────
describe('B10 未對應區塊', () => {
  test('集合恰等於符合關鍵字的 K3／K4，K1 不出現；限院內、篩選、劑型都不影響', async () => {
    const { h, doc } = await mainPage();
    await h.search('zeta');
    const expected = ['C005', 'C006', 'C014'];
    assert.deepEqual(h.unmatchedCodes(), expected);
    h.setOnly(true);
    assert.deepEqual(h.unmatchedCodes(), expected);
    h.click(doc.querySelector('.filter-btn[data-filter="raw"]'));
    assert.deepEqual(h.unmatchedCodes(), expected, '篩選範圍 0 筆時仍顯示');
    h.click(doc.querySelector('.filter-btn[data-filter="all"]'));
    const inj = [...doc.querySelectorAll('.dosage-btn')].find(b => b.dataset.dosage === '注射劑');
    h.click(inj);
    assert.deepEqual(h.unmatchedCodes(), expected);
  });

  test('只存在中文名／英文名／成分的關鍵字分別命中；全形可命中；1 字不顯示', async () => {
    const { h, doc } = await mainPage();
    await h.search('院內壬', { scope: 'both' });
    assert.deepEqual(h.unmatchedCodes(), ['C009']);
    assert.equal(h.cards().length, 0, '許可證卡片 0 筆時區塊仍顯示');
    await h.search('zetamycin', { scope: 'both' });
    assert.deepEqual(h.unmatchedCodes(), ['C014']);
    await h.search('ｚｅｔａｃｉｌｌｉｎ', { scope: 'ingredient' });
    assert.deepEqual(h.unmatchedCodes(), ['C014']);
    await h.search('壬', { scope: 'both' });
    assert.equal(doc.querySelector('.formulary-unmatched'), null);
    await h.search('nothing-here', { scope: 'both' });
    assert.equal(doc.querySelector('.formulary-unmatched'), null);
  });

  test('ATC 範圍不顯示', async () => {
    const { h, doc } = await mainPage();
    await h.search('C09', { scope: 'atc' });
    assert.equal(doc.querySelector('.formulary-unmatched'), null);
  });

  test('超過 20 筆只列 20 筆並顯示總數', async () => {
    const rows = Array.from({ length: 23 }, (_, i) => `U${i},未對應品項 ${i},,,,`);
    const { h, doc } = await mainPage({ csv: csv([...rows, `C001,院內甲,,,AA00000001,`]) });
    await h.search('未對應品項', { scope: 'both' });
    assert.equal(doc.querySelectorAll('.formulary-unmatched tbody tr').length, 20);
    assert.match(doc.querySelector('.formulary-unmatched-head').textContent, /23 筆，列出前 20 筆/);
  });
});

// ── B11 XSS ───────────────────────────────────────────────────
describe('B11 清單欄位與檔名不產生可執行內容', () => {
  test('徽章、健保代號表、未對應區塊、摘要、錯誤訊息皆以文字呈現', async () => {
    const evil = '<img src=x onerror=alert(1)>';
    const fake = makeFakeIdb();
    const page = await makePage({ drugs: DRUGS, idb: fake.idb });
    const h = helpers(page.win);
    const list = csv([`${evil},院內<script>x</script>,,,AA00000001,`, `X2,"${evil}""q""",,,,`]);
    assert.equal(await importText(page.win, `${evil}.csv`, list), true);
    await tick();
    await h.search('zeta alpha');
    assert.ok(h.badgeCodes(LIC(1)).includes(evil), '院內碼須以原文字面可見');
    assert.ok(h.rowCodes(LIC(1), 'AA00000001').includes(evil));
    await h.search('onerror', { scope: 'both' });
    assert.ok(page.doc.querySelector('.formulary-unmatched').textContent.includes(`${evil}"q"`));
    assert.ok(page.doc.getElementById('formularySummary').textContent.includes(evil));
    await importText(page.win, `${evil}.xls`, 'x');
    assert.ok(page.doc.getElementById('formularyStatus').textContent.includes('匯入失敗'));
    for (const sel of ['img', 'script:not([src])', '[onerror]']) {
      assert.equal(page.doc.querySelectorAll(`body ${sel}`).length, 0, sel);
    }
  });
});

// ── B12 推導而非保存 ───────────────────────────────────────────
describe('B12 站上資料更換後重新推導', () => {
  test('K1（無許可證鍵）→ K4；雙鍵同指一張 → K2', async () => {
    const fake = makeFakeIdb();
    const first = await makePage({ drugs: DRUGS, idb: fake.idb });
    await importText(first.win, 'hospital.csv', MAIN_CSV);
    await tick();
    const stored = structuredClone(fake.state.data.get('current'));

    const drugs2 = structuredClone(DRUGS);
    drugs2[0].nhiMatches = [];                                           // 1：AA00000001 消失
    drugs2[10].nhiMatches = drugs2[10].nhiMatches.filter(m => m.code !== 'AA00000012');   // 11：AA00000012 消失
    const second = await makePage({ drugs: drugs2, idb: makeFakeIdb({ seed: stored }).idb });
    const h = helpers(second.win);
    await h.search('zeta alpha');
    assert.equal(h.cardOf(LIC(1)).querySelector('.badge-formulary'), null);
    await h.search('zeta');
    assert.ok(h.unmatchedCodes().includes('C001'), 'C001 變成 K4 後進未對應區');
    await h.search('omega');
    assert.deepEqual(h.badgeCodes(LIC(11)), ['C017'], '變 K2：徽章保留');
    assert.match(h.cardOf(LIC(11)).querySelector('.badge-formulary').textContent, /以許可證字號對應/);
    assert.equal(h.hasInHouseColumn(LIC(11)), false, '健保代號列的標碼消失');
    assert.match(second.doc.getElementById('formularyDetail').textContent, /健保代號對應 5/);
  });
});

// ── C 限院內 ───────────────────────────────────────────────────
describe('C 限院內', () => {
  test('C1 結果集合恰等於有 K1／K2 的卡片', async () => {
    const { h } = await mainPage();
    await h.search('zeta');
    h.setOnly(true);
    assert.deepEqual(h.licenses(), [1, 2, 3, 4, 8, 10].map(LIC).sort());
    assert.match(h.doc.getElementById('resultsMeta').textContent, /限院內/);
  });

  test('C1 超過 30 筆院內品項：顯示 30 筆、筆數文字為全集', async () => {
    const drugs = Array.from({ length: 35 }, (_, i) => drug(100 + i, `Many Item ${i}`, { codes: [`MM${String(i).padStart(8, '0')}`] }));
    const list = csv(drugs.map((d, i) => `H${i},院內${i},,,${d.nhiMatches[0].code},`));
    const { h } = await mainPage({ drugs, csv: list });
    await h.search('many item');
    h.setOnly(true);
    assert.equal(h.cards().length, 30);
    assert.match(h.doc.getElementById('resultsMeta').textContent, /符合 35 筆/);
  });

  test('C2 0 筆：警語與取消鈕可見；取消後恢復原集合與其他條件', async () => {
    const { h, doc } = await mainPage();
    await h.search('zeta eta');
    const before = h.licenses();
    h.setOnly(true);
    const empty = doc.querySelector('.formulary-empty');
    assert.ok(empty && !empty.closest('[hidden]'));
    assert.match(empty.textContent, /不代表院內無此藥/);
    h.click(doc.querySelector('.formulary-cancel'));
    assert.deepEqual(h.licenses(), before);
    assert.equal(h.onlyBox().checked, false);
    assert.equal(doc.getElementById('searchInput').value, 'zeta eta');
    assert.equal(doc.querySelector('.filter-btn[data-filter].active').dataset.filter, 'all');
  });

  test('C2 ATC 子群選取中造成 0 筆：取消後子群與摘要表恢復', async () => {
    const { h, doc } = await mainPage();
    await h.search('C09CA', { scope: 'atc' });
    h.click(doc.querySelector('.atc-row[data-atc="C09CA06"]'));
    assert.deepEqual(h.licenses(), [LIC(7)]);
    h.setOnly(true);
    assert.equal(h.cards().length, 0);
    assert.ok(doc.querySelector('.formulary-empty'));
    h.click(doc.querySelector('.formulary-cancel'));
    assert.deepEqual(h.licenses(), [LIC(7)], '子群選取須保留');
    assert.ok(doc.querySelector('.atc-row.active[data-atc="C09CA06"]'));
  });

  test('C4 限院內 × 篩選範圍 × 劑型（預期集合事先列出）', async () => {
    const { h, doc } = await mainPage();
    const expectations = [
      ['nhi', [1, 2, 3, 8]],
      ['non-nhi', [4, 10]],
      ['raw', []],
      ['all', [1, 2, 3, 4, 8, 10]],
    ];
    for (const [filter, nums] of expectations) {
      await h.search('zeta', { filter });
      h.setOnly(true);
      assert.deepEqual(h.licenses(), nums.map(LIC).sort(), filter);
      h.setOnly(false);
    }
    await h.search('zeta', { filter: 'all' });
    h.setOnly(true);
    h.click([...doc.querySelectorAll('.dosage-btn')].find(b => b.dataset.dosage === '口服錠'));
    assert.deepEqual(h.licenses(), [1, 2, 4, 8, 10].map(LIC).sort(), '劑型須排除注射劑的 3');
    h.click([...doc.querySelectorAll('.dosage-btn')].find(b => b.dataset.dosage === '注射劑'));
    assert.deepEqual(h.licenses(), [LIC(3)]);
  });

  test('C4 ATC 範圍下點選子群後限院內仍正確', async () => {
    const { h, doc } = await mainPage();
    await h.search('C09CA', { scope: 'atc' });
    h.setOnly(true);
    assert.deepEqual(h.licenses(), [1, 2].map(LIC).sort());
    h.click(doc.querySelector('.atc-row[data-atc="C09CA01"]'));
    assert.deepEqual(h.licenses(), [LIC(1)]);
  });

  test('C3 三種啟動狀態', async () => {
    const none = await makePage({ drugs: DRUGS, idb: makeFakeIdb().idb });
    assert.equal(helpers(none.win).onlyBox().disabled, true);
    assert.match(none.doc.getElementById('formularySummary').textContent, /尚未匯入/);

    const broken = await makePage({ drugs: DRUGS, idb: makeFakeIdb({ fail: { get: 'error' } }).idb });
    const hb = helpers(broken.win);
    assert.equal(hb.onlyBox().disabled, true);
    assert.match(broken.doc.getElementById('formularySummary').textContent, /讀取院內清單失敗/);
    await hb.search('zeta');
    assert.deepEqual(hb.licenses(), ALL_ZETA, '一般查詢不受影響');

    const { fake } = await mainPage();
    const reopened = await makePage({ drugs: DRUGS, idb: makeFakeIdb({ seed: fake.state.data.get('current') }).idb });
    const hr = helpers(reopened.win);
    assert.equal(hr.onlyBox().disabled, false);
    await hr.search('zeta alpha');
    assert.deepEqual(hr.badgeCodes(LIC(1)), ['C001']);
  });

  test('C5 90 天一般、91 天警示、未來日期為不明；限院內結果相同；無可對應鍵仍停用', async () => {
    const { fake } = await mainPage();
    const rec = fake.state.data.get('current');
    const at = days => { const d = new Date(); d.setDate(d.getDate() - days); return d.getTime(); };
    const results = {};
    for (const [label, importedAt, stale, text] of [
      ['90', at(90), false, /（90 天前）/],
      ['91', at(91), true, /已超過 90 天/],
      ['future', at(-2), true, /匯入日期不明/],
    ]) {
      const p = await makePage({ drugs: DRUGS, idb: makeFakeIdb({ seed: { ...rec, importedAt } }).idb });
      const s = p.doc.getElementById('formularySummary');
      assert.equal(s.classList.contains('formulary-stale'), stale, label);
      assert.match(s.textContent, text, label);
      const hp = helpers(p.win);
      await hp.search('zeta');
      hp.setOnly(true);
      results[label] = hp.licenses();
    }
    assert.deepEqual(results['90'], results['91']);

    const noKeys = await mainPage({ csv: csv(['X1,只有名稱,,,,']) });
    assert.equal(noKeys.h.onlyBox().disabled, true);
    assert.match(noKeys.doc.getElementById('onlyFormularyHint').textContent, /沒有任何可對應/);
  });
});

// ── A 匯入、清除、並行 ─────────────────────────────────────────
describe('A 匯入與儲存', () => {
  const sameAsBefore = async (page, h, stored) => {
    assert.deepEqual(page.fake.state.data.get('current'), stored, '儲存層須與匯入前相同');
    assert.match(page.doc.getElementById('formularySummary').textContent, /hospital\.csv/);
    await h.search('zeta alpha');
    assert.deepEqual(h.badgeCodes(LIC(1)), ['C001'], '舊清單的徽章仍在');
    assert.match(page.doc.getElementById('formularyStatus').textContent, /匯入失敗/);
  };

  test('A4 各種失敗都保留舊清單與畫面', async () => {
    const page = await mainPage();
    const stored = structuredClone(page.fake.state.data.get('current'));
    const cases = [
      ['empty.csv', ''],
      ['nocol.csv', '院內代碼,健保代號\r\nA,AC12345678\r\n'],
      ['noname.csv', '院內代碼,藥名,健保代號\r\nA,,AC12345678\r\n'],
      ['old.xls', 'binary'],
      ['cut.xlsx', 'PK\u0003\u0004truncated'],
    ];
    for (const [name, text] of cases) {
      assert.equal(await importText(page.win, name, text), false, name);
      await sameAsBefore(page, page.h, stored);
    }
    // 5 MB＋1：以 size 擋下，連讀檔都不必
    let read = false;
    assert.equal(await page.win.importFormulary('big.csv', 5 * 1024 * 1024 + 1, async () => { read = true; return buf(MAIN_CSV); }), false);
    assert.equal(read, false);
    await sameAsBefore(page, page.h, stored);
  });

  test('A4／A10 解析成功但寫入失敗（request 失敗、或 request 成功後交易中止）', async () => {
    for (const mode of ['error', 'abort-after-success']) {
      const page = await mainPage();
      const stored = structuredClone(page.fake.state.data.get('current'));
      page.fake.state.fail.put = mode;
      assert.equal(await importText(page.win, 'new.csv', csv(['N1,新清單,,,AA00000002,'])), false, mode);
      await sameAsBefore(page, page.h, stored);
      page.win.rebuildFormulary();   // 之後任何一次重算都不得冒出未提交的新清單
      assert.match(page.doc.getElementById('formularySummary').textContent, /hospital\.csv/);
      await page.h.search('zeta beta');
      assert.deepEqual(page.h.rowCodes(LIC(2), 'AA00000003'), ['C002'], '舊清單的 C002 仍標在 2');
      assert.deepEqual(page.h.rowCodes(LIC(2), 'AA00000002'), [], '新清單的 N1 不得出現');
    }
  });

  test('A5 三種清單的限院內狀態', async () => {
    const a = await mainPage({ csv: '院內代碼,藥名\r\nX1,Zeta Alpha Tab\r\n' });
    assert.equal(a.h.onlyBox().disabled, true);
    assert.match(a.doc.getElementById('formularyStatus').textContent, /無法標示院內品項/);

    const b = await mainPage({ csv: '院內代碼,藥名,健保代號\r\nX1,甲,\r\nX2,乙,AA-0001\r\n' });
    assert.equal(b.h.onlyBox().disabled, true);

    const c = await mainPage({ csv: `院內代碼,藥名,許可證字號\r\nX1,甲,${LIC(4)}\r\n` });
    assert.equal(c.h.onlyBox().disabled, false);
    await c.h.search('zeta delta');
    assert.match(c.h.cardOf(LIC(4)).querySelector('.badge-formulary').textContent, /以許可證字號對應/);
  });

  test('HIS 匯出形狀：許可證欄無表頭、末尾缺「號」、無健保代號欄 → 依內容辨識並以許可證對應', async () => {
    const his = [
      'CODE,(沒有資料行名稱),ATC,ATC備註,英文品名,成分,類別,中文品名',
      `H4,衛署藥製字第000004,,,,DELTA,藥品,院內丁`,
      `H10,衛署藥製字第000010,,,,KAPPA,藥品,院內寅`,
      `M1,衛署醫器輸字第022704,,醫材,,,醫材,`,      // 無品名、許可證對不上（醫材）→ 計入無藥名
      `H99,衛署藥製字第000001,,,,,藥品,`,           // 無品名但許可證對上 1 → 保留、以院內代碼顯示
    ].join('\r\n') + '\r\n';
    const { h, doc } = await mainPage({ csv: his });
    const status = doc.getElementById('formularyStatus').textContent;
    assert.match(status, /依內容判定「\(沒有資料行名稱\)」欄為許可證字號/);
    assert.match(status, /沒有健保代號欄/);
    const detail = doc.getElementById('formularyDetail').textContent;
    assert.match(detail, /共 4 列/);
    assert.match(detail, /許可證對應 3/);
    assert.match(detail, /未對應 0/);
    assert.match(detail, /無藥名 1/);
    await h.search('zeta delta');
    assert.deepEqual(h.badgeCodes(LIC(4)), ['H4']);
    await h.search('zeta alpha');
    assert.deepEqual(h.badgeCodes(LIC(1)), ['H99'], '無品名品項以院內代碼顯示');
    await h.search('zeta');
    assert.equal(doc.querySelector('.formulary-unmatched'), null, '醫材列不得出現在未對應區塊');
    assert.equal(h.onlyBox().disabled, false);
  });

  test('A7 儲存層只有六個欄位', async () => {
    const { fake } = await mainPage({ csv: '院內代碼,藥名,健保代號,健保價,儲位,ATC碼\r\nX1,甲,AA00000001,12.5,P1-03,C09CA01\r\n' });
    const rec = fake.state.data.get('current');
    assert.deepEqual(Object.keys(rec.items[0]).sort(), ['code', 'enName', 'ingredient', 'license', 'name', 'nhiCode']);
    const json = JSON.stringify(rec);
    for (const v of ['12.5', 'P1-03', 'C09CA01']) assert.ok(!json.includes(v), v);
  });

  test('A8 已搜尋且已勾選限院內時清除：所有院內呈現消失、勾選取消', async () => {
    const page = await mainPage();
    const { h, doc } = page;
    await h.search('zeta');
    h.setOnly(true);
    assert.equal(await page.win.clearFormulary(), true);
    assert.equal(page.fake.state.data.has('current'), false);
    assert.equal(h.onlyBox().checked, false);
    assert.equal(h.onlyBox().disabled, true);
    assert.deepEqual(h.licenses(), ALL_ZETA);
    assert.equal(doc.querySelector('.badge-formulary, .badge-formulary-maybe, .formulary-unmatched'), null);
    assert.equal(doc.getElementById('searchInput').value, 'zeta');
  });

  test('A8 改匯入 K1＋K2＝0 的清單：同樣取消勾選並重算', async () => {
    const page = await mainPage();
    await page.h.search('zeta');
    page.h.setOnly(true);
    assert.equal(await importText(page.win, 'names.csv', csv(['X1,只有名稱,,,,'])), true);
    await tick();
    assert.equal(page.h.onlyBox().checked, false);
    assert.deepEqual(page.h.licenses(), ALL_ZETA);
    assert.equal(page.doc.querySelector('.badge-formulary'), null);
  });

  test('A8 刪除失敗：整個可見狀態維持', async () => {
    const page = await mainPage();
    await page.h.search('zeta');
    page.h.setOnly(true);
    page.fake.state.fail.delete = 'abort-after-success';
    assert.equal(await page.win.clearFormulary(), false);
    assert.ok(page.fake.state.data.has('current'));
    assert.equal(page.h.onlyBox().checked, true);
    assert.deepEqual(page.h.licenses(), [1, 2, 3, 4, 8, 10].map(LIC).sort());
    assert.match(page.doc.getElementById('formularyStatus').textContent, /清除失敗/);
  });

  test('A9 操作中控制項停用；繞過 disabled 再觸發仍只寫一次', async () => {
    const page = await mainPage();
    const putsBefore = page.fake.state.calls.put;
    const p1 = importText(page.win, 'a.csv', MAIN_CSV);
    assert.equal(page.doc.getElementById('formularyFile').disabled, true);
    assert.equal(page.doc.getElementById('formularyClear').disabled, true);
    const p2 = importText(page.win, 'b.csv', MAIN_CSV);
    const p3 = page.win.clearFormulary();
    assert.deepEqual([await p1, await p2, await p3], [true, false, false]);
    assert.equal(page.fake.state.calls.put - putsBefore, 1);
    assert.equal(page.fake.state.calls.delete, 0);
    assert.equal(page.doc.getElementById('formularyFile').disabled, false);
  });

  test('A9 啟動讀取未完成前不能匯入；讀取返回後畫面等於儲存層', async () => {
    const { fake: seedFrom } = await mainPage();
    let release;
    const delayed = makeFakeIdb({ seed: seedFrom.state.data.get('current'), getDelay: new Promise(r => { release = r; }) });
    const page = await makePage({ drugs: DRUGS, idb: delayed.idb });
    assert.equal(page.doc.getElementById('formularyFile').disabled, true);
    assert.equal(await importText(page.win, 'new.csv', csv(['N1,新,,,AA00000002,'])), false);
    assert.equal(delayed.state.calls.put, 0);
    release();
    await tick();
    assert.match(page.doc.getElementById('formularySummary').textContent, /hospital\.csv/);
    const h = helpers(page.win);
    await h.search('zeta alpha');
    assert.deepEqual(h.badgeCodes(LIC(1)), ['C001']);
  });
});

// ── A10 儲存層：以交易 complete 為成功 ───────────────────────────
describe('A10 儲存層', () => {
  test('save：request 成功但交易中止 → 回報失敗，資料未寫入', async () => {
    const page = await makePage({ drugs: [], idb: makeFakeIdb().idb });
    const fake = makeFakeIdb({ fail: { put: 'abort-after-success' } });
    const store = page.win.TFDAFormulary.createStore(fake.idb);
    await assert.rejects(store.save({ items: [] }), /寫入院內清單失敗/);
    assert.equal(fake.state.data.has('current'), false);
    fake.state.fail.put = undefined;
    await store.save({ items: [1] });
    assert.deepEqual(fake.state.data.get('current'), { items: [1] });
  });

  test('無 IndexedDB：load 失敗、頁面照常可查詢', async () => {
    const page = await makePage({ drugs: DRUGS });
    const h = helpers(page.win);
    assert.match(page.doc.getElementById('formularySummary').textContent, /無法使用本機儲存/);
    await h.search('zeta');
    assert.deepEqual(h.licenses(), ALL_ZETA);
  });
});

// ── F2／F3 整合 ────────────────────────────────────────────────
describe('F 整合', () => {
  test('F2 formulary.js＋app.js 依序執行無錯誤，院內功能出現', async () => {
    const page = await makePage({ drugs: DRUGS, idb: makeFakeIdb().idb });
    assert.deepEqual(page.errors, []);
    assert.equal(typeof page.win.TFDAFormulary, 'object');
    assert.equal(page.doc.getElementById('formularyPanel').hidden, false);
    assert.equal(page.doc.getElementById('onlyFormularyWrap').hidden, false);
  });

  test('F3 沒有 formulary.js：無錯誤、查詢可用、院內區塊隱藏', async () => {
    const page = await makePage({ drugs: DRUGS, formulary: false });
    assert.deepEqual(page.errors, []);
    assert.equal(page.doc.getElementById('formularyPanel').hidden, true);
    assert.equal(page.doc.getElementById('onlyFormularyWrap').hidden, true);
    const h = helpers(page.win);
    await h.search('zeta');
    assert.deepEqual(h.licenses(), ALL_ZETA);
  });
});
