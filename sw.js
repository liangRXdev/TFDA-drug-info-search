const STATIC_CACHE = 'tfda-static-v10';   // index.html／app.js 有異動時須同步提升（見 README）
const DATA_CACHE   = 'tfda-data-v2';
const FONT_CACHE   = 'tfda-fonts-v2';
const ALL_CACHES   = [STATIC_CACHE, DATA_CACHE, FONT_CACHE];
// GitHub Pages 專案頁共用 origin（liangrxdev.github.io），Cache Storage 不依 SW scope 隔離：
// 清舊版只能刪本站三個快取家族，否則會清掉同網域其他工具（如 NHI 藥價歷史）的離線快取。
// 用完整家族前綴而非 'tfda-'：TFDA-drug-id-quiz 的快取也以 'tfda-' 開頭。
const OWN_PREFIXES = ['tfda-static-', 'tfda-data-', 'tfda-fonts-'];

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
        keys.filter(k => OWN_PREFIXES.some(p => k.startsWith(p)) && !ALL_CACHES.includes(k))
            .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

async function notifyClients(type) {
  // 回傳 Promise，呼叫端才能用 waitUntil 確保訊息送出後 SW 才被終止
  const clients = await self.clients.matchAll();
  clients.forEach(c => c.postMessage({ type }));
}

// 寫入快取前驗證回應確實是完整的資料檔。
// 只看 HTTP status 不夠：主機或 CDN 回傳 200 的 HTML 錯誤頁時會覆蓋有效快取，
// 使用者端往後每次載入都失敗且自己無法清除——屬於永久性的快取毒化。
async function isValidDataResponse(resp, validate) {
  const ctype = resp.headers.get('Content-Type') || '';
  if (!ctype.includes('json')) return false;
  try {
    return validate(await resp.clone().json());
  } catch {
    return false;
  }
}

function isValidDrugsData(data) {
  return Number(data?._meta?.totalRecords) > 0 && Array.isArray(data?.data);
}

// 美國仿單參考：與 app.js 同名函式、us_label.py 的 validate_result／validate_output
// 為同一份資料契約（docs/plan-us-label.md §6.3）。SW 與頁面無法共用程式碼，三處須同步修改；
// tests/fixtures/us_label_contract.json 的反例三方都跑（Codex 審查 CR1／CR2）
const US_LABEL_RULES_VERSION = 1;   // 須與 us_label.py MATCH_RULES_VERSION、app.js 同值（pytest 擋）
const US_LABEL_STATES = new Set(['bw', 'nobw', 'nomatch', 'unavailable']);
const US_PREG_SECTIONS = new Set(['pregnancy', '8.1 Pregnancy', 'teratogenic_effects']);
const US_LACT_SECTIONS = new Set(['8.2 Lactation', 'nursing_mothers']);
const US_SOURCE_FIELDS = new Set(['id', 'v', 'name', 'mfr', 'app', 'eff']);
const US_ENTRY_FIELDS = ['s', 'n', 'm', 'r', 'preg', 'lact'];

const isPlainObject = o => !!o && typeof o === 'object' && !Array.isArray(o);
const hasExactKeys = (o, keys) => Object.keys(o).length === keys.length && keys.every(k => k in o);
const hasText = a => Array.isArray(a) && a.every(t => typeof t === 'string') && a.some(t => t.trim());

function isValidUsSource(s) {
  return isPlainObject(s) && Object.keys(s).every(k => US_SOURCE_FIELDS.has(k))
    && Object.values(s).every(v => typeof v === 'string') && !!s.id;
}

function isValidUsSection(sec, names, extraStates) {
  if (!isPlainObject(sec)) return false;
  if (sec.st === 'ok') return hasExactKeys(sec, ['st', 'sec', 't']) && names.has(sec.sec) && hasText(sec.t);
  return (sec.st === 'none' || extraStates.includes(sec.st)) && hasExactKeys(sec, ['st']);
}

function isValidUsLabelEntry(e) {
  if (!isPlainObject(e) || !US_LABEL_STATES.has(e.s)) return false;
  if (e.s === 'nomatch' || e.s === 'unavailable') return hasExactKeys(e, ['s']);
  if (!Number.isInteger(e.n) || !Number.isInteger(e.m) || e.n < 1 || e.m < 0 || e.m > e.n) return false;
  if (!isValidUsSource(e.r) || !isValidUsSection(e.preg, US_PREG_SECTIONS, [])
      || !isValidUsSection(e.lact, US_LACT_SECTIONS, ['unextractable'])) return false;
  if (e.s === 'bw') {
    if ('b' in e && !isValidUsSource(e.b)) return false;
    return e.m >= 1 && hasText(e.bw)
      && Object.keys(e).every(k => US_ENTRY_FIELDS.includes(k) || k === 'bw' || k === 'b');
  }
  return e.m === 0 && hasExactKeys(e, US_ENTRY_FIELDS);
}

// 殘缺但每筆合法的檔案（_meta 宣稱 N 鍵、實際較少）也要拒收，否則會覆蓋完整的舊快取
function isValidUsLabelData(data) {
  const meta = data && data._meta, d = data && data.data;
  if (!isPlainObject(meta) || !isPlainObject(d)) return false;
  const vals = Object.values(d);
  if (!vals.length || meta.matchRulesVersion !== US_LABEL_RULES_VERSION || meta.keys !== vals.length) return false;
  if (!vals.every(isValidUsLabelEntry) || !isPlainObject(meta.counts)) return false;
  const actual = { bw: 0, nobw: 0, nomatch: 0, unavailable: 0 };
  vals.forEach(v => { actual[v.s]++; });
  return hasExactKeys(meta.counts, Object.keys(actual))
    && Object.keys(actual).every(s => meta.counts[s] === actual[s]);
}

// 每個資料檔各自的驗證與通知訊息。各檔獨立 single-flight：
// 共用一把鎖時，一個檔的背景更新會讓另一個檔的更新被吞掉（規格 D9）
const DATA_FILES = {
  'drugs_data.json':    { validate: isValidDrugsData,
                          updated: 'DATA_UPDATED', failed: 'DATA_UPDATE_FAILED' },
  'us_label_data.json': { validate: isValidUsLabelData,
                          updated: 'US_LABEL_UPDATED', failed: 'US_LABEL_UPDATE_FAILED' },
};

function dataFileOf(url) {
  return Object.keys(DATA_FILES).find(name => url.pathname.endsWith('/' + name)) || null;
}

// ── 資料檔：stale-while-revalidate ──────────────────────────────────
async function revalidateData(request, cachedETag, spec) {
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

  if (!await isValidDataResponse(resp, spec.validate)) {
    // 驗證失敗時保留舊快取：寧可用舊資料，也不要讓使用者陷入永久壞掉的狀態
    await notifyClients(spec.failed);
    return;
  }

  const cache = await caches.open(DATA_CACHE);
  await cache.put(request, resp.clone());
  // 頁面已用舊資料渲染完畢，僅提示可重新整理，不強制中斷使用者操作
  await notifyClients(spec.updated);
}

// single-flight（每檔一把）：多個分頁或連續請求會各自觸發背景更新，若不合併，
// 同一份大型資料會被同時下載多次，且較早開始、較晚完成的回應可能覆蓋較新的快取。
const inflightRevalidate = new Map();

function revalidateOnce(name, request, cachedETag) {
  if (!inflightRevalidate.has(name)) {
    inflightRevalidate.set(name, revalidateData(request, cachedETag, DATA_FILES[name])
      .finally(() => { inflightRevalidate.delete(name); }));
  }
  return inflightRevalidate.get(name);
}

async function handleDataRequest(event, name) {
  const request = event.request;
  const cached = await caches.match(request);

  if (cached) {
    // 背景更新不可用 await 擋住回應，但需 waitUntil 保住 SW 生命週期
    event.waitUntil(
      revalidateOnce(name, request, cached.headers.get('ETag')).catch(() =>
        notifyClients('OFFLINE_MODE')   // 背景更新失敗多半是離線
      )
    );
    return cached;
  }

  // 無快取（首次造訪）：只能等網路，此時付全額傳輸成本
  try {
    const resp = await fetch(request);
    // 首次造訪同樣須驗證後才入快取，否則一個 200 的錯誤頁就會被當成資料存起來
    if (resp.ok && await isValidDataResponse(resp, DATA_FILES[name].validate)) {
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

  // 資料檔（drugs_data.json、us_label_data.json）：stale-while-revalidate
  // 資料由 GitHub Actions 每週更新一次，但壓縮後仍有 ~8.3MB。改為先回快取
  // 讓畫面立即可用，再於背景以條件請求（If-None-Match）確認是否有新版：
  // 未更新時只花一個 304（約數百 bytes），毋須重抓整包。
  // 須限定同源與 GET：原本只比對 pathname，任何跨來源的同名資源都會套用
  // 這套資料快取策略
  const dataFile = url.origin === self.location.origin && event.request.method === 'GET'
    ? dataFileOf(url) : null;
  if (dataFile) {
    event.respondWith(handleDataRequest(event, dataFile));
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
        .catch(() => offlineFallback(event.request))
    );
  }
});

// 離線時的靜態資源回應。開啟頁面（navigate）的網址通常是目錄（…/TFDA-drug-info-search/）
// 或帶查詢字串，但 install 預快取的是 ./index.html——快取鍵不同，原本 caches.match 必然落空。
// 目錄網址只在線上瀏覽時順手存入，而每次 SW 改版舊快取整個清除，於是「每次更新後、
// 線上再開一次之前，離線 F5 一律打不開」（2026-10-20 正式站 v8→v9 實際重現）。
// 找不到原網址時，開啟頁面改以預快取的 index.html 回應；其他資源維持原行為。
async function offlineFallback(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  if (request.mode === 'navigate') {
    return caches.match(new URL('./index.html', self.registration.scope).href);
  }
  return undefined;
}
