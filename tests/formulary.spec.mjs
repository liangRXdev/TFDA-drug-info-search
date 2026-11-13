/**
 * 院內清單純函式測試（docs/plan-formulary-share.md 驗收 A、B7–B9、C5）。
 * formulary.js 以 vm 執行，取用其掛在全域的 TFDAFormulary。全部為合成資料。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { buildXlsx, buildZip, encodeBig5, toArrayBuffer } from './helpers/files.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ctx = { TextDecoder, Blob, Response, DecompressionStream, Uint8Array, ArrayBuffer, DataView, console };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(readFileSync(join(here, '..', 'formulary.js'), 'utf-8'), ctx);
const F = ctx.TFDAFormulary;

// vm 內建立的物件原型不同，deepStrictEqual 前先轉成本 realm 的普通物件
const plain = v => JSON.parse(JSON.stringify(v));
const parse = (name, buf) => F.parseFormularyFile(name, toArrayBuffer(Buffer.isBuffer(buf) ? buf : Buffer.from(buf, 'utf-8')));
const rejectsWith = (p, re) => assert.rejects(p, err => err instanceof F.FormularyError && re.test(err.message));

// ── A1：三種格式解析結果相同且等於預期 ─────────────────────────
const HEADER = ['院內代碼', '藥名', '英文品名', '成分', '健保代號', '許可證字號', '健保價', '儲位'];
const ROWS = [
  ['0012', '脈優錠', 'Norvasc 5mg, tab', 'AMLODIPINE', 'AC12345678', '衛署藥輸字第012345號', '5.1', 'A1'],
  ['0034', '立普妥"膜衣"錠', 'Lipitor', 'ATORVASTATIN', '', '衛署藥輸字第023456號', '20', 'B2'],
  ['0056', '欄內\n換行', 'Multi Line', '', 'BC00000001', '', '', ''],
];
const EXPECTED = [
  { code: '0012', name: '脈優錠', enName: 'Norvasc 5mg, tab', ingredient: 'AMLODIPINE', nhiCode: 'AC12345678', license: '衛署藥輸字第012345號' },
  { code: '0034', name: '立普妥"膜衣"錠', enName: 'Lipitor', ingredient: 'ATORVASTATIN', nhiCode: '', license: '衛署藥輸字第023456號' },
  // 欄內換行：cleanCell 把連續空白（含換行）併成一個空白
  { code: '0056', name: '欄內 換行', enName: 'Multi Line', ingredient: '', nhiCode: 'BC00000001', license: '' },
];
const csvCell = v => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const toCsv = rows => rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

describe('A1 解析：UTF-8 CSV、Big5 CSV、XLSX', () => {
  const csv = toCsv([HEADER, ...ROWS]);

  test('UTF-8 CSV（含 BOM）等於預期', async () => {
    const r = await parse('list.csv', '﻿' + csv);
    assert.deepEqual(plain(r.items), EXPECTED);
    assert.equal(r.rawRows, 3);
  });

  test('Big5 CSV 等於預期', async () => {
    const r = await parse('list.csv', encodeBig5(csv));
    assert.deepEqual(plain(r.items), EXPECTED);
  });

  test('XLSX：讀工作簿宣告的第一張（非 sheet1.xml）、公式取已存結果、稀疏儲存格為空', async () => {
    const rows = [HEADER, ...ROWS.map(r => [...r])];
    rows[1][3] = { f: 'UPPER("amlodipine")', v: 'AMLODIPINE' };   // 公式儲存格
    const xlsx = buildXlsx([
      { file: 'sheet2.xml', rows },
      { file: 'sheet1.xml', rows: [HEADER, ['9999', '干擾資料', '', '', 'ZZ99999999', '', '', '']] },
    ]);
    const r = await parse('list.xlsx', xlsx);
    assert.deepEqual(plain(r.items), EXPECTED);
  });

  test('只保存六個欄位，健保價與儲位不保存（A7）', async () => {
    const r = await parse('list.csv', csv);
    for (const it of r.items) assert.deepEqual(Object.keys(it).sort(), [...F.STORED_FIELDS].sort());
    assert.ok(!JSON.stringify(plain(r.items)).includes('5.1'), '健保價不得被保存');
    assert.ok(!JSON.stringify(plain(r.items)).includes('"A1"'), '儲位不得被保存');
  });
});

// ── A2：表頭位置 ───────────────────────────────────────────────
describe('A2 表頭須在前 20 個非空白列', () => {
  const build = before => toCsv([['匯出說明：本檔為合成資料'], ...Array.from({ length: before - 1 }, (_, i) => [`說明 ${i}`]), HEADER, ROWS[0]]);

  test('第 20 個非空白列可解析（前面含說明列與空白列）', async () => {
    const text = build(19).replace('\r\n', '\r\n\r\n');   // 插入一列空白，不計入
    const r = await parse('a.csv', text);
    assert.deepEqual(plain(r.items), [EXPECTED[0]]);
  });

  test('第 21 個非空白列必須失敗', async () => {
    await rejectsWith(parse('a.csv', build(20)), /找不到「藥名」/);
  });
});

// ── A3：健保代號正規化 ─────────────────────────────────────────
describe('A3 健保代號正規化', () => {
  test('全形、小寫、夾空白 → 正規化', () => {
    assert.equal(F.normalizeNhiCode('ａｃ12345678'), 'AC12345678');
    assert.equal(F.normalizeNhiCode(' ac 12345678 '), 'AC12345678');
  });
  test('9 碼、11 碼、含符號、空值 → 空', () => {
    for (const bad of ['AC1234567', 'AC123456789', 'AC-1234567', 'AC1234567-', '', '   ', null]) {
      assert.equal(F.normalizeNhiCode(bad), '', String(bad));
    }
  });
  test('無效代碼不得命中站上代號（反例）', () => {
    const drugs = [{ licenseNumber: 'L1', nhiMatches: [{ code: 'AC12345678' }] }];
    for (const bad of ['AC1234567', 'AC12345678X']) {
      const items = [{ code: 'X', name: 'n', enName: '', ingredient: '', nhiCode: F.normalizeNhiCode(bad), license: '' }];
      const m = F.classify(items, drugs);
      assert.equal(m.byLicense.size, 0, bad);
      assert.equal(m.classified[0].kind, 'K4');
    }
  });
});

// ── A4：失敗類別（純函式層）──────────────────────────────────────
describe('A4 不支援／損壞檔案整份失敗', () => {
  test('空檔', () => rejectsWith(parse('a.csv', ''), /空的/));
  test('無藥名欄', () => rejectsWith(parse('a.csv', '院內代碼,健保代號\r\nA,AC12345678\r\n'), /找不到「藥名」/));
  test('表頭正確但所有列皆無藥名', () => rejectsWith(parse('a.csv', '院內代碼,藥名,健保代號\r\nA,,AC12345678\r\n'), /沒有任何有藥名/));
  test('5 MB＋1 byte 拒絕；恰好 5 MB 可匯入', async () => {
    const head = toCsv([HEADER, ROWS[0]]);
    const pad = n => head + ' '.repeat(n - Buffer.byteLength(head));
    await rejectsWith(parse('a.csv', pad(F.MAX_FILE_BYTES + 1)), /5 MB/);
    const ok = await parse('a.csv', pad(F.MAX_FILE_BYTES));
    assert.equal(ok.items.length, 1);
  });
  test('20,001 列拒絕；恰好 20,000 列可匯入', async () => {
    const make = n => [['藥名'], ...Array.from({ length: n }, (_, i) => [`藥${i}`])];
    assert.throws(() => F.rowsToFormulary(make(20001)), /超過上限/);
    assert.equal(F.rowsToFormulary(make(20000)).items.length, 20000);
  });
  test('.xls 副檔名', () => rejectsWith(parse('old.xls', 'whatever'), /\.xls/));
  test('加密的 Office 檔（OLE 容器），即使副檔名是 .xlsx', () =>
    rejectsWith(parse('enc.xlsx', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0])), /加密/));
  test('ZIP 內加密項目', async () => {
    const zip = buildZip([
      { name: 'xl/workbook.xml', data: '<workbook/>', flags: 1 },
      { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships/>' },
    ]);
    await rejectsWith(parse('enc.xlsx', zip), /加密/);
  });
  test('前段有效、後段截斷的 XLSX 不接受部分結果', async () => {
    const full = buildXlsx([{ file: 'sheet1.xml', rows: [HEADER, ...ROWS] }]);
    for (const cut of [full.length - 10, Math.floor(full.length * 0.8), Math.floor(full.length / 2)]) {
      await rejectsWith(parse('cut.xlsx', full.subarray(0, cut)), /損毀|不完整/);
    }
  });
  // stored（不壓縮）項目最危險：截短的資料仍是可讀文字，不檢查就會接受部分內容
  for (const method of [8, 0]) test(`目錄宣告的大小超過檔案（method ${method}）也拒絕`, async () => {
    const full = buildXlsx([{ file: 'sheet1.xml', rows: [HEADER, ...ROWS] }], { method });
    const eocd = full.subarray(full.length - 22);
    const cdSize = eocd.readUInt32LE(12);
    const cdStart = eocd.readUInt32LE(16);
    const cd = full.subarray(cdStart, cdStart + cdSize);
    const corrupt = Buffer.from(cd);
    // 每個項目的壓縮大小都改成超過檔案長度
    for (let o = 0; o < corrupt.length; o += 46 + corrupt.readUInt16LE(o + 28) + corrupt.readUInt16LE(o + 30) + corrupt.readUInt16LE(o + 32)) {
      corrupt.writeUInt32LE(0x7fffff, o + 20);
    }
    const bad = Buffer.concat([full.subarray(0, cdStart), corrupt, eocd]);
    await rejectsWith(parse('bad.xlsx', bad), /損毀|不完整/);
  });
  test('不支援的副檔名', () => rejectsWith(parse('list.txt', 'a,b'), /僅支援/));
  test('副檔名 .xlsx 但內容不是 ZIP', () => rejectsWith(parse('fake.xlsx', '藥名\r\nA\r\n'), /損毀|不完整/));
});

// ── A6：院內碼去重 ─────────────────────────────────────────────
describe('A6 院內碼重複', () => {
  test('原字串不同、正規化後相同：保留先出現那列的全部欄位，重複數 1', () => {
    const r = F.rowsToFormulary([
      ['院內代碼', '藥名', '健保代號'],
      ['ab01', '先出現', 'AC00000001'],
      ['ＡＢ ０１', '後出現', 'AC00000002'],
    ]);
    assert.deepEqual(plain(r.items), [{ code: 'ab01', name: '先出現', enName: '', ingredient: '', nhiCode: 'AC00000001', license: '' }]);
    assert.equal(r.excluded.dupCode, 1);
    // 後列的健保代號不得讓任何卡片得到徽章
    const m = F.classify(r.items, [{ licenseNumber: 'L2', nhiMatches: [{ code: 'AC00000002' }] }]);
    assert.equal(m.byLicense.has('L2'), false);
  });
  test('院內碼皆空：兩列都保留，不算重複', () => {
    const r = F.rowsToFormulary([['院內代碼', '藥名'], ['', '甲'], ['', '乙']]);
    assert.equal(r.items.length, 2);
    assert.equal(r.excluded.dupCode, 0);
  });
});

// ── B7–B9：分類 ───────────────────────────────────────────────
const item = (o = {}) => ({ code: '', name: '品項', enName: '', ingredient: '', nhiCode: '', license: '', ...o });

describe('B7 鍵對到多張許可證一律 K3', () => {
  // 合成站上資料：AA00000001 同時出現在 L1、L2（現實資料不會，但必須釘住）；許可證 LX 重複兩筆
  const drugs = [
    { licenseNumber: 'L1', nhiMatches: [{ code: 'AA00000001' }] },
    { licenseNumber: 'L2', nhiMatches: [{ code: 'AA00000001' }, { code: 'AA00000002' }] },
    { licenseNumber: 'L3', nhiMatches: [{ code: 'AA00000003' }] },
    { licenseNumber: 'LX', nhiMatches: [] },
    { licenseNumber: 'L X', nhiMatches: [] },    // 正規化後與 LX 相同 → 許可證鍵多張
  ];
  const cases = [
    ['① 健保多張、許可證 0 張', item({ nhiCode: 'AA00000001' })],
    ['② 健保多張、許可證唯一指向其中一張', item({ nhiCode: 'AA00000001', license: 'L1' })],
    ['③ 許可證多張、健保 0 張', item({ license: 'LX' })],
    ['④ 許可證多張、健保唯一', item({ nhiCode: 'AA00000003', license: 'LX' })],
  ];
  for (const [label, it] of cases) {
    test(label, () => {
      const m = F.classify([it], drugs);
      assert.equal(m.classified[0].kind, 'K3');
      assert.equal(m.byLicense.size, 0, '任何相關許可證都不得因此品項得到徽章');
    });
  }
  test('兩鍵各自唯一但不同張 → K3', () => {
    const m = F.classify([item({ nhiCode: 'AA00000003', license: 'L1' })], drugs);
    assert.equal(m.classified[0].kind, 'K3');
  });
  test('兩鍵各自唯一且同一張 → K1', () => {
    const m = F.classify([item({ nhiCode: 'AA00000003', license: 'L3' })], drugs);
    assert.equal(m.classified[0].kind, 'K1');
    assert.equal(m.classified[0].license, 'L3');
  });
});

describe('B8 完整相等（反例）', () => {
  const drugs = [
    { licenseNumber: '衛署藥製字第000009號', nhiMatches: [{ code: 'AA00000010' }] },
    { licenseNumber: '衛署藥製字第000010號', nhiMatches: [] },
  ];
  test('健保代號：末碼不同、中間一碼不同、前 9 碼、多一碼皆不命中', () => {
    for (const c of ['AA00000011', 'AA00100010', 'AA0000001', 'AA000000100']) {
      const m = F.classify([item({ nhiCode: F.normalizeNhiCode(c) })], drugs);
      assert.equal(m.classified[0].kind, 'K4', c);
    }
  });
  test('許可證：字別不同、缺「第」、前導零不同、號碼多一碼、末尾多字皆不命中', () => {
    for (const lic of ['衛署藥輸字第000009號', '衛署藥製字000009', '衛署藥製字000009號', '衛署藥製字第9號', '衛署藥製字第0000090號', '衛署藥製字第0000９號X', '衛署藥製字第']) {
      const m = F.classify([item({ license: lic })], drugs);
      assert.equal(m.classified[0].kind, 'K4', lic);
    }
  });
  test('許可證：末尾缺「號」命中（HIS 匯出常省略；只去末尾一個「號」）', () => {
    for (const lic of ['衛署藥製字第000010', '衛署藥製字第 000010 ']) {
      const m = F.classify([item({ license: lic })], drugs);
      assert.equal(m.classified[0].kind, 'K2', lic);
      assert.equal(m.classified[0].license, '衛署藥製字第000010號');
    }
    assert.equal(F.normalizeLicense('衛署藥製字第000010號'), F.normalizeLicense('衛署藥製字第000010'));
    assert.notEqual(F.normalizeLicense('衛署藥製字第000010號號'), F.normalizeLicense('衛署藥製字第000010'), '只去一個');
  });
  test('許可證：只差全形半形或夾空白者命中（正例）', () => {
    const m = F.classify([item({ license: '衛署藥製字第 ０００ ０１０號' })], drugs);
    assert.equal(m.classified[0].kind, 'K2');
    assert.equal(m.classified[0].license, '衛署藥製字第000010號');
  });
});

describe('許可證欄依內容辨識（表頭沒有「許可證字號」時）', () => {
  const H = ['CODE', '(沒有資料行名稱)', 'ATC', '英文品名', '中文品名'];
  test('過半數形如「…字第數字」的欄被當成許可證欄，並回報表頭與比例', () => {
    const r = F.rowsToFormulary([
      H,
      ['1001', '衛署藥輸字第023226', 'D01AE16', 'LOCERYL', '樂指利'],
      ['1002', '衛部醫器輸字第', '', '', ''],          // 無號碼：不符格式，但不影響過半；無品名但有許可證欄值 → 保留
      ['1003', '衛署藥製字第012345號', 'C09CA01', 'COZAAR', '可悅您'],
    ]);
    assert.deepEqual(plain(r.items.map(i => [i.code, i.license])), [['1001', '衛署藥輸字第023226'], ['1002', '衛部醫器輸字第'], ['1003', '衛署藥製字第012345號']]);
    assert.equal(r.hasLicenseColumn, true);
    assert.equal(r.licenseDetected.header, '(沒有資料行名稱)');
    assert.ok(Math.abs(r.licenseDetected.ratio - 2 / 3) < 1e-9);
  });
  test('未過半不採用（反例）', () => {
    const r = F.rowsToFormulary([
      H,
      ['1', '衛署藥輸字第1', '', 'A', '甲'],
      ['2', '備註文字', '', 'B', '乙'],
      ['3', '另一段備註', '', 'C', '丙'],
      ['4', '衛署藥輸字第2', '', 'D', '丁'],
    ]);
    assert.equal(r.licenseDetected, null);
    assert.equal(r.hasLicenseColumn, false);
    assert.ok(r.items.every(i => i.license === ''));
  });
  test('表頭已有許可證欄時不做內容辨識；已對應的欄（如藥名）不列入候選', () => {
    const named = F.rowsToFormulary([['藥名', '許可證字號', '備用'], ['甲', 'X', '衛署藥輸字第1']]);
    assert.equal(named.licenseDetected, null);
    assert.equal(named.items[0].license, 'X');
    const nameLooksLikeLicense = F.rowsToFormulary([['藥名'], ['衛署藥輸字第1']]);
    assert.equal(nameLooksLikeLicense.licenseDetected, null);
  });
});

describe('B9 摘要逐品項正確', () => {
  test('每列的分類與目標許可證、六個數字加總等於原始列數', () => {
    const drugs = [
      { licenseNumber: 'L1', nhiMatches: [{ code: 'AA00000001' }] },
      { licenseNumber: 'L2', nhiMatches: [{ code: 'AA00000002' }] },
      { licenseNumber: 'L3', nhiMatches: [] },
    ];
    const parsed = F.rowsToFormulary([
      ['院內代碼', '藥名', '健保代號', '許可證字號'],
      ['K1a', '甲', 'AA00000001', ''],
      ['K1b', '乙', 'AA00000002', 'L2'],     // 雙鍵同指一張 → K1
      ['K2a', '丙', 'ZZ00000000', 'L3'],     // 健保找不到、許可證唯一 → K2
      ['K3a', '丁', 'AA00000001', 'L2'],     // 雙鍵指向不同張 → K3
      ['K4a', '戊', 'AA0000000', ''],         // 無效代碼 → K4
      ['NL2', '', '', 'L3'],                  // 無品名但許可證對上 → 保留，K2
      ['NL0', '', '', 'LZ'],                  // 無品名、許可證對不上 → 保留但計入 N0
      ['NN', '', '', ''],                     // 無品名也無許可證 → 略過
      ['k1a', '重複', 'AA00000002', ''],      // 院內碼重複
    ]);
    const m = F.classify(parsed.items, drugs);
    assert.deepEqual(plain(m.classified.map(c => [c.item.code, c.kind, c.license ?? null])), [
      ['K1a', 'K1', 'L1'], ['K1b', 'K1', 'L2'], ['K2a', 'K2', 'L3'], ['K3a', 'K3', null], ['K4a', 'K4', null],
      ['NL2', 'K2', 'L3'], ['NL0', 'K4', null],
    ]);
    assert.deepEqual(plain(m.counts), { K1: 2, K2: 2, K3: 1, K4: 1, N0: 1 });
    assert.ok(!m.unmatched.some(u => u.item.code === 'NL0'), '無品名且對不上者不進未對應區塊');
    assert.deepEqual(plain(m.byLicense.get('L3').items.map(e => e.item.code)), ['K2a', 'NL2']);
    assert.deepEqual(plain(parsed.excluded), { noName: 1, dupCode: 1 });
    const sum = Object.values(m.counts).reduce((a, b) => a + b, 0) + parsed.excluded.noName + parsed.excluded.dupCode;
    assert.equal(sum, parsed.rawRows);
    assert.equal(parsed.rawRows, 9);
  });
});

describe('名稱候選與未對應比對（B2、B10 的純函式層）', () => {
  const drugs = [{ licenseNumber: 'L1', chName: '脈優錠', enName: 'Norvasc  Tablets', nhiMatches: [{ code: 'AA00000001' }] }];
  test('完整相等（NFKC、大小寫、連續空白）才是候選；前綴或包含不是', () => {
    const cands = items => plain(F.nameCandidates(F.classify(items, drugs), drugs[0]).map(i => i.code));
    assert.deepEqual(cands([item({ code: 'a', name: 'ＮＯＲＶＡＳＣ tablets' })]), ['a']);
    assert.deepEqual(cands([item({ code: 'b', name: '院內名', enName: 'norvasc tablets' })]), ['b']);
    assert.deepEqual(cands([item({ code: 'c', name: '脈優' })]), [], '前綴不是候選');
    assert.deepEqual(cands([item({ code: 'd', name: '脈優錠5mg' })]), [], '包含不是候選');
    assert.deepEqual(cands([item({ code: 'e', name: '脈優錠', nhiCode: 'AA00000001' })]), [], 'K1 不進候選');
  });
  test('未對應：只含 K3／K4、三欄皆可命中、全形關鍵字、2 字門檻、上限 20', () => {
    const items = [
      item({ code: 'k1', name: 'Zeta K1', nhiCode: 'AA00000001' }),
      item({ code: 'n', name: '院內甲 zeta' }),
      item({ code: 'e', name: '院內乙', enName: 'Zetamycin' }),
      item({ code: 'i', name: '院內丙', ingredient: 'ZETACILLIN' }),
      ...Array.from({ length: 25 }, (_, i) => item({ code: `x${i}`, name: `另一個 zeta ${i}` })),
    ];
    const m = F.classify(items, drugs);
    const hits = F.unmatchedHits(m, 'ｚｅｔａ');
    assert.equal(hits.total, 28);
    assert.equal(hits.list.length, F.UNMATCHED_LIMIT);
    assert.ok(!hits.list.some(h => h.item.code === 'k1'), 'K1 不得出現');
    assert.deepEqual(plain(hits.list.slice(0, 3).map(h => h.item.code)), ['n', 'e', 'i']);
    assert.equal(F.unmatchedHits(m, 'z').total, 0, '1 個字不顯示');
    assert.equal(F.unmatchedHits(m, 'ze').total, 28, '2 個字顯示');
  });
});

// ── C5：匯入經過天數（固定時鐘）─────────────────────────────────
describe('C5 匯入經過天數', () => {
  const now = new Date(2026, 10, 13, 9, 0, 0);
  const daysAgo = n => new Date(2026, 10, 13 - n, 23, 59, 0).getTime();
  test('90 天與 91 天以當地日曆日計算', () => {
    assert.equal(F.importAgeDays(daysAgo(90), now), 90);
    assert.equal(F.importAgeDays(daysAgo(91), now), 91);
    assert.equal(F.importAgeDays(daysAgo(0), now), 0);
  });
  test('無效或未來日期 → null', () => {
    for (const bad of [undefined, null, 'abc', NaN, -1, 0]) assert.equal(F.importAgeDays(bad, now), null, String(bad));
    assert.equal(F.importAgeDays(new Date(2026, 10, 14).getTime(), now), null);
  });
  test('STALE_DAYS 為 90', () => assert.equal(F.STALE_DAYS, 90));
});

describe('isValidRecord：讀回的紀錄形狀不對即視為未匯入', () => {
  const ok = { items: [item({ code: 'a' })], fileName: 'x', importedAt: 1 };
  test('正確', () => assert.equal(F.isValidRecord(ok), true));
  test('多欄位、缺欄位、非字串、空清單皆拒絕', () => {
    assert.equal(F.isValidRecord({ items: [{ ...item(), price: '1' }] }), false);
    const { license, ...missing } = item();
    assert.equal(F.isValidRecord({ items: [missing] }), false);
    assert.equal(F.isValidRecord({ items: [{ ...item(), code: 1 }] }), false);
    assert.equal(F.isValidRecord({ items: [] }), false);
    assert.equal(F.isValidRecord(null), false);
  });
});
