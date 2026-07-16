const STATIC_CACHE = 'tfda-static-v3';
const DATA_CACHE   = 'tfda-data-v2';
const FONT_CACHE   = 'tfda-fonts-v2';
const ALL_CACHES   = [STATIC_CACHE, DATA_CACHE, FONT_CACHE];

// ── Install：只快取輕量靜態資源，不預取 drugs_data.json ─────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => cache.addAll(['./index.html', './manifest.json']))
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

function notifyClients(type) {
  self.clients.matchAll().then(clients =>
    clients.forEach(c => c.postMessage({ type }))
  );
}

// ── drugs_data.json：stale-while-revalidate ─────────────────────────
async function revalidateData(request, cachedETag) {
  // 帶 If-None-Match 走條件請求；no-store 是為了繞過 HTTP cache，
  // 讓伺服器（而非瀏覽器快取）來判斷 304，否則 max-age=600 內拿不到真實狀態
  const headers = cachedETag ? { 'If-None-Match': cachedETag } : {};
  const resp = await fetch(request.url, { headers, cache: 'no-store' });

  if (resp.status === 304) return;            // 資料未變，不動快取
  if (!resp.ok) return;

  const cache = await caches.open(DATA_CACHE);
  await cache.put(request, resp.clone());
  // 頁面已用舊資料渲染完畢，僅提示可重新整理，不強制中斷使用者操作
  notifyClients('DATA_UPDATED');
}

async function handleDataRequest(event) {
  const request = event.request;
  const cached = await caches.match(request);

  if (cached) {
    // 背景更新不可用 await 擋住回應，但需 waitUntil 保住 SW 生命週期
    event.waitUntil(
      revalidateData(request, cached.headers.get('ETag')).catch(() => {
        notifyClients('OFFLINE_MODE');   // 背景更新失敗多半是離線
      })
    );
    return cached;
  }

  // 無快取（首次造訪）：只能等網路，此時付全額傳輸成本
  try {
    const resp = await fetch(request);
    if (resp.ok) {
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
            caches.open(FONT_CACHE).then(c => c.put(event.request, response.clone()));
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
  if (url.pathname.endsWith('drugs_data.json')) {
    event.respondWith(handleDataRequest(event));
    return;
  }

  // 同源靜態資源：network-first，失敗回傳快取
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response.ok) {
            caches.open(STATIC_CACHE).then(c => c.put(event.request, response.clone()));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
  }
});
