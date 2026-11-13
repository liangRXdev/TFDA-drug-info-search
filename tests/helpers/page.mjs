/**
 * jsdom 頁面組裝：載入 index.html，依序執行 formulary.js（可省略）與 app.js。
 * fetch 以合成藥品資料取代；IndexedDB 以 fake-idb 取代（在平台邊界注入，不改產品程式）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
export const root = join(here, '..', '..');
const html = readFileSync(join(root, 'index.html'), 'utf-8');
const appSrc = readFileSync(join(root, 'app.js'), 'utf-8');
const formularySrc = readFileSync(join(root, 'formulary.js'), 'utf-8');

export const BASE = 'https://example.org/TFDA-drug-info-search/';
export const tick = (ms = 80) => new Promise(r => setTimeout(r, ms));

/**
 * opts：
 *  drugs       合成藥品
 *  idb         fake-idb 的 idb 物件（省略則無 IndexedDB）
 *  formulary   是否載入 formulary.js（預設 true）
 *  url         頁面網址（可帶 #q=）
 *  data        'ok'（預設）｜'fail'｜'defer'（回傳 release() 手動放行）
 *  beforeInit  app.js 執行後、資料載入前呼叫（裝 spy 用）
 */
export async function makePage({ drugs = [], idb = null, formulary = true, url = BASE, data = 'ok', beforeInit } = {}) {
  const errors = [];
  const consoleLines = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', e => errors.push(e));
  for (const level of ['log', 'warn', 'error', 'info', 'debug']) {
    virtualConsole.on(level, (...args) => consoleLines.push(args.map(String).join(' ')));
  }

  let release;
  const gate = data === 'defer' ? new Promise(r => { release = r; }) : Promise.resolve();
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    url,
    virtualConsole,
    beforeParse(w) {
      w.TextDecoder = TextDecoder;
      if (idb) w.indexedDB = idb;
      w.fetch = async (u) => {
        const s = String(u);
        if (s.endsWith('drugs_data.json')) {
          await gate;
          if (data === 'fail') throw new TypeError('Failed to fetch');
          return { ok: true, status: 200, json: async () => ({ _meta: { totalRecords: drugs.length }, data: structuredClone(drugs) }) };
        }
        if (s.endsWith('data_version.json')) return { ok: true, json: async () => ({}) };
        throw new Error('unexpected fetch ' + s);
      };
    },
  });
  const win = dom.window;
  win.addEventListener('error', e => errors.push(e.error || e.message));
  if (formulary) win.eval(formularySrc);
  win.eval(appSrc);
  if (beforeInit) beforeInit(win);
  if (data !== 'defer') await tick();
  return { win, doc: win.document, errors, consoleLines, release, dom };
}

// ── DOM 讀取工具 ───────────────────────────────────────────────
export function helpers(win) {
  const doc = win.document;
  const click = el => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  const cards = () => [...doc.querySelectorAll('#resultsContainer .drug-card')];
  const licenseOf = card => card.querySelector('.badge-license').textContent.replace('📋', '').split('·')[0].trim();
  const licenses = () => cards().map(licenseOf).sort();
  const cardOf = lic => cards().find(c => licenseOf(c) === lic) || null;
  const badgeCodes = lic => {
    const c = cardOf(lic);
    return c ? [...c.querySelectorAll('.badge-formulary .formulary-code')].map(e => e.textContent).sort() : null;
  };
  const rowCodes = (lic, nhi) => {
    const row = cardOf(lic)?.querySelector(`tr[data-nhi-code="${nhi}"]`);
    if (!row) return null;
    return [...row.querySelectorAll('.formulary-cell .formulary-code')].map(e => e.textContent).sort();
  };
  const hasInHouseColumn = lic => !!cardOf(lic)?.querySelector('.nhi-codes-table .formulary-cell');
  const unmatchedCodes = () => [...doc.querySelectorAll('.formulary-unmatched tbody tr td:first-child')].map(e => e.textContent).sort();
  const onlyBox = () => doc.getElementById('onlyFormulary');
  const setOnly = on => {
    const b = onlyBox();
    b.checked = on;
    b.dispatchEvent(new win.Event('change', { bubbles: true }));
  };
  async function search(q, { scope = 'name', filter = 'all' } = {}) {
    doc.getElementById('searchInput').value = '';
    click(doc.querySelector(`.scope-btn[data-scope="${scope}"]`));
    click(doc.querySelector(`.filter-btn[data-filter="${filter}"]`));
    doc.getElementById('searchInput').value = q;
    win.searchDrugs();
    await tick();
  }
  const errorText = () => {
    const e = doc.getElementById('errorMsg');
    return e.classList.contains('active') ? e.textContent : '';
  };
  return { doc, click, cards, licenses, cardOf, badgeCodes, rowCodes, hasInHouseColumn, unmatchedCodes, onlyBox, setOnly, search, errorText };
}
