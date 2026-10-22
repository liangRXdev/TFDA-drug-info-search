/**
 * sw.js 離線行為測試：以 node vm 執行 sw.js，攔下其 fetch handler，
 * 用假的 caches／fetch 驗證「離線開啟頁面」與既有快取策略。
 *
 * 回歸背景：預快取鍵是 ./index.html，但開啟頁面的網址是目錄（…/）。SW 改版清掉舊快取後，
 * 離線 F5 一律打不開（2026-10-20 正式站 v8→v9 重現）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const SCOPE = 'https://example.org/TFDA-drug-info-search/';
const src = readFileSync(join(here, '..', 'sw.js'), 'utf-8');

// 建立一個 SW 執行環境：store 為 { 快取名: Map(url → Response) }，online=false 時 fetch 一律失敗
function makeSw({ store = {}, online = false } = {}) {
  const listeners = {};
  const cacheApi = name => ({
    async match(req) { return (store[name] || new Map()).get(typeof req === 'string' ? req : req.url); },
    async put(req, resp) { (store[name] ||= new Map()).set(typeof req === 'string' ? req : req.url, resp); },
    async addAll() {},
    async keys() { return []; },
  });
  const ctx = {
    URL, Response, console,
    self: {
      addEventListener: (type, fn) => { listeners[type] = fn; },
      location: new URL(SCOPE),
      registration: { scope: SCOPE },
      clients: { matchAll: async () => [], claim: async () => {} },
      skipWaiting: () => {},
    },
    caches: {
      async match(req) {
        const key = typeof req === 'string' ? req : req.url;
        for (const m of Object.values(store)) if (m.has(key)) return m.get(key);
        return undefined;
      },
      async open(name) { return cacheApi(name); },
      async keys() { return Object.keys(store); },
      async delete(name) { delete store[name]; return true; },
    },
    fetch: async (req) => {
      if (!online) throw new TypeError('Failed to fetch');
      return new Response(`network:${typeof req === 'string' ? req : req.url}`, { status: 200 });
    },
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return { ctx, store, fetchHandler: listeners.fetch };
}

// 模擬一次 fetch 事件，回傳 respondWith 收到的 Response（未呼叫 respondWith 則為 'not-handled'）
async function dispatch(sw, url, mode = 'no-cors') {
  let responded = 'not-handled';
  const waits = [];
  const event = {
    request: { url, mode, method: 'GET', headers: new Headers() },
    respondWith(p) { responded = p; },
    waitUntil(p) { waits.push(p); },
  };
  sw.fetchHandler(event);
  const resp = await responded;
  await Promise.all(waits);
  return resp;
}

const indexHtml = () => new Response('<!doctype html>INDEX', { status: 200 });

describe('離線開啟頁面', () => {
  test('目錄網址不在快取（SW 剛改版）→ 改回預快取的 index.html', async () => {
    const sw = makeSw({ store: { 'tfda-static-v10': new Map([[SCOPE + 'index.html', indexHtml()]]) } });
    const resp = await dispatch(sw, SCOPE, 'navigate');
    assert.ok(resp, '不得回傳 undefined（那會讓瀏覽器顯示離線錯誤頁）');
    assert.match(await resp.text(), /INDEX/);
  });

  test('帶查詢字串的頁面網址也能離線開啟', async () => {
    const sw = makeSw({ store: { 'tfda-static-v10': new Map([[SCOPE + 'index.html', indexHtml()]]) } });
    const resp = await dispatch(sw, SCOPE + '?q=amlodipine', 'navigate');
    assert.match(await resp.text(), /INDEX/);
  });

  test('原網址已在快取 → 用原網址的版本（不被 index.html 蓋掉）', async () => {
    const own = new Response('DIR-COPY', { status: 200 });
    const sw = makeSw({ store: { 'tfda-static-v10': new Map([[SCOPE, own], [SCOPE + 'index.html', indexHtml()]]) } });
    assert.equal(await (await dispatch(sw, SCOPE, 'navigate')).text(), 'DIR-COPY');
  });

  test('非開啟頁面的資源找不到快取 → 不改回 index.html（避免把 HTML 當成 JS 或圖片）', async () => {
    const sw = makeSw({ store: { 'tfda-static-v10': new Map([[SCOPE + 'index.html', indexHtml()]]) } });
    assert.equal(await dispatch(sw, SCOPE + 'icons/icon-192.png', 'no-cors'), undefined);
    assert.equal(await dispatch(sw, SCOPE + 'app.js', 'no-cors'), undefined);
  });

  test('已快取的靜態資源離線照常回傳', async () => {
    const app = new Response('APPJS', { status: 200 });
    const sw = makeSw({ store: { 'tfda-static-v10': new Map([[SCOPE + 'app.js', app]]) } });
    assert.equal(await (await dispatch(sw, SCOPE + 'app.js')).text(), 'APPJS');
  });
});

describe('線上行為不變', () => {
  test('開啟頁面仍為 network-first，並把該網址寫入靜態快取', async () => {
    const sw = makeSw({ online: true, store: { 'tfda-static-v10': new Map([[SCOPE + 'index.html', indexHtml()]]) } });
    const resp = await dispatch(sw, SCOPE, 'navigate');
    assert.equal(await resp.text(), `network:${SCOPE}`);
    assert.ok(sw.store['tfda-static-v10'].has(SCOPE), '線上瀏覽時應順手快取目錄網址');
  });

  test('預快取鍵與 install 清單一致（./index.html 解析後等於離線退回的網址）', () => {
    assert.match(src, /addAll\(\['\.\/index\.html'/);
    assert.match(src, /new URL\('\.\/index\.html', self\.registration\.scope\)/);
  });
});
