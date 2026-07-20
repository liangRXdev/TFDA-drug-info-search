const STATIC_CACHE = 'tfda-static-v5';   // index.html／app.js 有異動時須同步提升（見 README）
const DATA_CACHE   = 'tfda-data-v2';
const FONT_CACHE   = 'tfda-fonts-v2';
const ALL_CACHES   = [STATIC_CACHE, DATA_CACHE, FONT_CACHE];

// ── Install：只快取輕量靜態資源，不預取 drugs_data.json ─────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => cache.addAll(['./index.html', './app.js', './manifest.json']))
      .then(() => self.skipWaiting())
  );
});

// ── Activate：清除舊版 cache ────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => !ALL_CACHES.includes(k)).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

async function notifyClients(type) {
  // 回傳 Promise，呼叫端才能用 waitUntil 確保訊息送出後 SW 才被終止
  const clients = await self.clients.matchAll();
  clients.forEach(c => c.postMessage({ type }));
}

// 寫入快取前驗證回應確實是完整的藥品資料。
// 只看 HTTP status 不夠：主機或 CDN 回傳 200 的 HTML 錯誤頁時會覆蓋有效快取，
// 使用者端往後每次載入都失敗且自己無法清除——屬於永久性的快取毒化。
async function isValidDataResponse(resp) {
  const ctype = resp.headers.get('Content-Type') || '';
  if (!ctype.includes('json')) return false;
  try {
    const data = await resp.clone().json();
    return Number(data?._meta?.totalRecords) > 0 && Array.isArray(data?.data);
  } catch {
    return false;
  }
}

// ── drugs_data.json：stale-while-revalidate ─────────────────────────
async function revalidateData(request, cachedETag) {
  // 帶 If-None-Match 走條件請求；no-store 是為了繞過 HTTP cache，
  // 讓伺服器（而非瀏覽器快取）來判斷 304，否則 max-age=600 內拿不到真實狀態
  const headers = cachedETag ? { 'If-None-Match': cachedETag } : {};
  const resp = await fetch(request.url, { headers, cache: 'no-store' });

  if (resp.status === 304) return;            // 資料未變，不動快取
  if (!resp.ok) return;

  // 主機未實作或忽略 If-None-Match 時會一律回 200。此時若直接採信，
  // 會在內容其實沒變的情況下每次都重寫快取並跳出「有新版」提示。
  // ETag 相同即代表內容未變——這個比對必須在驗證之前，因為驗證要解析
  // 20MB+ 的 JSON，而絕大多數次的更新檢查其實無事可做。
  const newETag = resp.headers.get('ETag');
  if (newETag && cachedETag && newETag === cachedETag) return;

  if (!await isValidDataResponse(resp)) {
    // 驗證失敗時保留舊快取：寧可用舊資料，也不要讓使用者陷入永久壞掉的狀態
    await notifyClients('DATA_UPDATE_FAILED');
    return;
  }

  const cache = await caches.open(DATA_CACHE);
  await cache.put(request, resp.clone());
  // 頁面已用舊資料渲染完畢，僅提示可重新整理，不強制中斷使用者操作
  await notifyClients('DATA_UPDATED');
}

// single-flight：多個分頁或連續請求會各自觸發背景更新，若不合併，
// 同一份 20MB+ 的資料會被同時下載多次，且較早開始、較晚完成的回應
// 可能覆蓋較新的快取。
let inflightRevalidate = null;

function revalidateOnce(request, cachedETag) {
  if (!inflightRevalidate) {
    inflightRevalidate = revalidateData(request, cachedETag)
      .finally(() => { inflightRevalidate = null; });
  }
  return inflightRevalidate;
}

async function handleDataRequest(event) {
  const request = event.request;
  const cached = await caches.match(request);

  if (cached) {
    // 背景更新不可用 await 擋住回應，但需 waitUntil 保住 SW 生命週期
    event.waitUntil(
      revalidateOnce(request, cached.headers.get('ETag')).catch(() =>
        notifyClients('OFFLINE_MODE')   // 背景更新失敗多半是離線
      )
    );
    return cached;
  }

  // 無快取（首次造訪）：只能等網路，此時付全額傳輸成本
  try {
    const resp = await fetch(request);
    // 首次造訪同樣須驗證後才入快取，否則一個 200 的錯誤頁就會被當成資料存起來
    if (resp.ok && await isValidDataResponse(resp)) {
      const cache = await caches.open(DATA_CACHE);
      await cache.put(request, resp.clone());
    }
    return resp;
  } catch {
    return new Response(
      JSON.stringify({ error: '無快取資料，請連線後重試' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

// ── Fetch ───────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Google Fonts：cache-first（字型不常變動，離線可用）
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          if (response.ok) {
            // 背景寫入須交給 waitUntil，否則 SW 可能在寫完前被終止
            event.waitUntil(
              caches.open(FONT_CACHE).then(c => c.put(event.request, response.clone()))
            );
          }
          return response;
        }).catch(() => new Response('', { status: 503 }));
      })
    );
    return;
  }

  // drugs_data.json：stale-while-revalidate
  // 資料由 GitHub Actions 每週更新一次，但壓縮後仍有 ~8.3MB。改為先回快取
  // 讓畫面立即可用，再於背景以條件請求（If-None-Match）確認是否有新版：
  // 未更新時只花一個 304（約數百 bytes），毋須重抓整包。
  // 須限定同源與 GET：原本只比對 pathname，任何跨來源的同名資源都會套用
  // 這套資料快取策略
  if (url.origin === self.location.origin &&
      event.request.method === 'GET' &&
      url.pathname.endsWith('drugs_data.json')) {
    event.respondWith(handleDataRequest(event));
    return;
  }

  // 同源靜態資源：network-first，失敗回傳快取
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response.ok) {
            event.waitUntil(
              caches.open(STATIC_CACHE).then(c => c.put(event.request, response.clone()))
            );
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
  }
});
