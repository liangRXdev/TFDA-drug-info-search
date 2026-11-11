/**
 * 給付規定全文版本標示（2026-11-11）：藥師須看得出章節全文是哪一版、是否過期。
 * 執行：node --test tests/rules_version.spec.mjs
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let win;
let STALE;   // 須宣告在 before() 之前：before 註冊時即同步執行

before(() => {
  const dom = new JSDOM(readFileSync(join(root, 'index.html'), 'utf-8'), {
    runScripts: 'dangerously',
    url: 'https://example.org/',
    beforeParse(w) { w.fetch = () => Promise.reject(new Error('network disabled in tests')); },
  });
  win = dom.window;
  // app.js 的頂層 let 在 eval 內自成範圍，外部賦值碰不到；附加 setter 供測試注入 _meta
  // const 同理不會掛上 window，故一併匯出上限天數
  win.eval(readFileSync(join(root, 'app.js'), 'utf-8') +
    '\n;window.__setMeta = m => { drugsMeta = m; }; window.__STALE_DAYS = NHI_RULES_STALE_DAYS;');
  STALE = win.__STALE_DAYS;
});

// 相對今天的 ISO 日期：整合測試走真實時鐘，寫死日期 45 天後就會自己變成「過期」
const daysAgo = n => {
  const d = new Date(); d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const NOW = () => new win.Date(2026, 10, 11, 23, 30);   // 當地 2026-11-11 深夜：時區不可讓天數多算

const chapterDrug = {
  licenseNumber: '衛署藥輸字第000001號', chName: '測試', enName: 'TEST',
  isNhi: true, nhiChapter: '2.6.1',
  chapterDetails: [{ chapter: '2.6.1', title: '降血脂藥物', content: '限用於…' }],
  nhiMatches: [{ code: 'BC00000100', chapter: '2.6.1' }],
};

describe('rulesVersionInfo', () => {
  test('ISO → 民國日期與天數', () => {
    const r = win.rulesVersionInfo('2026-10-22', NOW());
    assert.equal(r.roc, '115.10.22');
    assert.equal(r.age, 20);
  });

  for (const bad of [null, undefined, '', '2026-02-30', '2026-13-01', '115.10.22', '2026-10-22T00:00', 20261022]) {
    test(`不合法版本 → null：${String(bad)}`, () => {
      assert.equal(win.rulesVersionInfo(bad, NOW()), null);
    });
  }
});

describe('rulesVersionNote', () => {
  test('期限內：一般標示，不加警示', () => {
    const html = win.rulesVersionNote('2026-10-22', NOW());
    assert.match(html, /115\.10\.22 版/);
    assert.doesNotMatch(html, /rules-version-stale|⚠/);
  });

  test('剛好到上限仍算期限內', () => {
    const now = new win.Date(2026, 9, 22 + STALE);
    assert.doesNotMatch(win.rulesVersionNote('2026-10-22', now), /⚠/);
  });

  test('超過上限：警示並顯示天數', () => {
    const html = win.rulesVersionNote('2026-09-22', NOW());
    assert.match(html, /rules-version-stale/);
    assert.match(html, /115\.9\.22 版/);
    assert.match(html, /50 天未更新/);
  });

  test('版本缺失：警示版本不明（不可靜默當成最新）', () => {
    assert.match(win.rulesVersionNote(null, NOW()), /rules-version-stale[\s\S]*版本不明/);
  });
});

describe('buildCard 整合', () => {
  test('有章節全文時顯示版本標示', () => {
    win.__setMeta({ nhiRulesVersion: daysAgo(10) });
    const html = win.buildCard(chapterDrug);
    assert.match(html, /rules-version-note/);
    assert.match(html, /\d+\.\d+\.\d+ 版；/);
    assert.doesNotMatch(html, /⚠ 以上/);
  });

  test('沒有章節全文（只有章節號／連結）時不顯示', () => {
    win.__setMeta({ nhiRulesVersion: daysAgo(10) });
    const html = win.buildCard({ ...chapterDrug, chapterDetails: [] });
    assert.doesNotMatch(html, /rules-version-note/);
  });

  test('過期版本 → 卡片上出現警示', () => {
    win.__setMeta({ nhiRulesVersion: daysAgo(STALE + 1) });
    assert.match(win.buildCard(chapterDrug), /rules-version-stale[\s\S]*天未更新/);
  });

  test('_meta 缺 nhiRulesVersion（舊資料檔）→ 版本不明警示', () => {
    win.__setMeta({});
    assert.match(win.buildCard(chapterDrug), /版本不明/);
  });
});
