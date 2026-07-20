const DATA_URL = './drugs_data.json';
// 建置時間戳獨立成小檔：若寫在 drugs_data.json 內，該檔每次建置必然改變，
// CI 的「資料無變動則跳過 commit」會永遠失效
const VERSION_URL = './data_version.json';

const searchInput      = document.getElementById('searchInput');
const searchBtn        = document.getElementById('searchBtn');
const loading          = document.getElementById('loading');
const resultsSection   = document.getElementById('resultsSection');
const resultsContainer = document.getElementById('resultsContainer');
const resultsMeta      = document.getElementById('resultsMeta');
const errorMsg         = document.getElementById('errorMsg');
const initBanner       = document.getElementById('initBanner');
const dataBadge        = document.getElementById('dataBadge');
const filterBtns       = document.querySelectorAll('.filter-btn[data-filter]');
const scopeBtns        = document.querySelectorAll('.scope-btn');
const suggestBox       = document.getElementById('suggestBox');

let drugDatabase = [];
let currentFilter = 'nhi';      // 預設健保品項
let currentScope  = 'name';      // 搜尋範圍：name / ingredient / both
let currentDosage = 'all';       // 劑型篩選
let lastResults   = null;        // 快取上次搜尋結果以便切換篩選即時生效
let lastKeyword   = '';          // 快取關鍵字供高亮使用

// 建立於資料載入後，供搜尋與 autosuggest 共用
let ingredientIndex = [];        // [{ name, count }]，依 count 遞減
let nameIndex       = [];        // [{ name, lower }]，相異品名（中英）

const showError = msg => { errorMsg.textContent = msg; errorMsg.classList.add('active'); };
const hideError = ()  => errorMsg.classList.remove('active');

// ── Init ──────────────────────────────────────────────────────
async function initDatabase() {
    try {
        // 版本資訊取不到不應阻斷主資料載入，故獨立 catch
        const [resp, version] = await Promise.all([
            fetch(DATA_URL),
            fetch(VERSION_URL).then(r => r.ok ? r.json() : null).catch(() => null),
        ]);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const json = await resp.json();
        drugDatabase = Array.isArray(json) ? json : (json.data || []);

        const meta = json._meta || {};
        const total = (meta.totalRecords || drugDatabase.length).toLocaleString();
        const nhi   = (meta.nhiRecords || 0).toLocaleString();
        const date  = version && version.generatedAt
            ? new Date(version.generatedAt).toLocaleDateString('zh-TW')
            : '未知';

        buildIndexes();

        searchInput.disabled = false;
        searchBtn.disabled = false;
        initBanner.style.display = 'none';
        dataBadge.textContent = `共 ${total} 筆 · 健保 ${nhi} · 更新 ${date}`;
        searchInput.focus();

    } catch (err) {
        console.error('資料庫載入失敗:', err);
        initBanner.innerHTML = '⚠️ 資料庫載入失敗，請確認 <code>drugs_data.json</code> 已上傳。';
        initBanner.style.background = '#fee2e2';
        initBanner.style.color = '#991b1b';
        dataBadge.textContent = '載入失敗';
    }
}

// ── Indexes（載入後建一次，供搜尋與 autosuggest 共用）──────────
function splitIngredients(raw) {
    // 資料格式：以 ;; 分隔，鹽類寫在括號內，例如
    // "CLAVULANATE (POTASSIUM);;AMOXICILLIN (AS TRIHYDATE)"
    return (raw || '').split(/[;；]+/).map(s => s.trim()).filter(Boolean);
}

function buildIndexes() {
    const ingCounts = new Map();
    const nameSet   = new Set();

    drugDatabase.forEach(d => {
        // 預先小寫化，避免每次搜尋重複轉換
        d._chLower  = (d.chName || '').toLowerCase();
        d._enLower  = (d.enName || '').toLowerCase();
        d._ingLower = (d.ingredients || '').toLowerCase();

        splitIngredients(d.ingredients).forEach(part => {
            // 去掉括號內的鹽類／型態，讓 suggest 收斂到主成分
            const base = part.replace(/\(.*?\)/g, '').trim().toUpperCase();
            if (base) ingCounts.set(base, (ingCounts.get(base) || 0) + 1);
        });

        if (d.chName) nameSet.add(d.chName);
        if (d.enName) nameSet.add(d.enName);
    });

    ingredientIndex = [...ingCounts.entries()]
        .map(([name, count]) => ({ name, lower: name.toLowerCase(), count }))
        .sort((a, b) => b.count - a.count);

    nameIndex = [...nameSet].map(name => ({ name, lower: name.toLowerCase() }));
}

// ── Scope buttons ─────────────────────────────────────────────
scopeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        scopeBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentScope = btn.dataset.scope;
        searchInput.placeholder = {
            'name':       '請輸入藥品中文品名或英文品名（例如：Norvasc、脈優）',
            'ingredient': '請輸入成分英文名（例如：AMLODIPINE、METFORMIN）',
            'both':       '請輸入品名或成分（例如：脈優、AMLODIPINE）',
        }[currentScope];
        // 範圍改變會改變結果集本身，需重跑搜尋
        if (searchInput.value.trim()) searchDrugs();
    });
});

// ── Filter buttons ────────────────────────────────────────────
filterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        filterBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentFilter = btn.dataset.filter;
        // 若已有搜尋結果，立即重渲染
        if (lastResults) {
            renderResults();
        }
    });
});

// ── Dosage filter（動態產生按鈕）────────────────────────────
const dosageRow = document.getElementById('dosageRow');

function buildDosageBtns(results) {
    // 收集結果中出現的所有劑型
    const counts = {};
    results.forEach(d => {
        // licenseType 有時是製劑種類而非劑型，故改從中文／英文品名的關鍵字萃取
        const dosages = extractDosage(d);
        dosages.forEach(ds => { counts[ds] = (counts[ds] || 0) + 1; });
    });

    // 清空並重建
    dosageRow.innerHTML = '<span class="dosage-label">💊 劑型：</span>';
    const allBtn = document.createElement('button');
    allBtn.className = 'dosage-btn active';
    allBtn.dataset.dosage = 'all';
    allBtn.textContent = `全部（${results.length}）`;
    dosageRow.appendChild(allBtn);

    Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .forEach(([ds, cnt]) => {
            const btn = document.createElement('button');
            btn.className = 'dosage-btn';
            btn.dataset.dosage = ds;
            btn.textContent = `${ds}（${cnt}）`;
            dosageRow.appendChild(btn);
        });

    // 劑型按鈕事件
    dosageRow.querySelectorAll('.dosage-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            dosageRow.querySelectorAll('.dosage-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentDosage = btn.dataset.dosage;
            if (lastResults) renderResults();
        });
    });

    currentDosage = 'all';
    dosageRow.style.display = Object.keys(counts).length > 0 ? 'flex' : 'none';
}

function extractDosage(drug) {
    // 從中英文品名 + 許可證種類中偵測劑型關鍵字
    const text = ((drug.chName || '') + ' ' + (drug.enName || '') + ' ' + (drug.licenseType || '')).toUpperCase();
    const map = [
        ['注射劑', ['INJECTION', 'INJ', 'INFUSION', '注射']],
        ['口服錠', ['TABLET', 'TABLETS', ' TAB', 'FILM-COATED', 'F.C.', 'F.C.TAB', '錠']],
        ['膠囊',   ['CAPSULE', 'CAPSULES', 'CAP', '膠囊']],
        ['口服液', ['SOLUTION', 'SUSPENSION', 'SYRUP', 'ORAL', '液', '糖漿', '懸液']],
        ['外用製劑',['CREAM', 'OINTMENT', 'GEL', 'PATCH', 'LOTION', 'SPRAY', '乳膏', '軟膏', '貼片', '外用']],
        ['吸入劑', ['INHALER', 'INHALATION', '吸入']],
        ['粉劑',   ['POWDER', '粉劑', '凍晶']],
    ];
    const found = [];
    for (const [label, keywords] of map) {
        if (keywords.some(kw => text.includes(kw))) {
            found.push(label);
            break; // 一筆藥只歸一類
        }
    }
    return found.length ? found : ['其他'];
}

function applyDosage(arr) {
    if (currentDosage === 'all') return arr;
    return arr.filter(d => extractDosage(d).includes(currentDosage));
}

// ── Search ────────────────────────────────────────────────────
function searchDrugs() {
    hideError();
    const keyword = searchInput.value.trim();
    if (!keyword) { showError('請輸入藥品名稱'); return; }
    if (drugDatabase.length === 0) { showError('資料庫尚未載入'); return; }

    loading.classList.add('active');
    resultsSection.classList.remove('active');
    searchBtn.disabled = true;

    setTimeout(() => {
        const lower = keyword.toLowerCase();
        lastKeyword = keyword;   // 供高亮使用

        const matchName = d => d._chLower.includes(lower) || d._enLower.includes(lower);
        // 直接比對原始成分字串：AMOXICILLIN 亦可命中 "AMOXICILLIN (AS TRIHYDATE)"
        const matchIng  = d => d._ingLower.includes(lower);
        const predicate = {
            'name':       matchName,
            'ingredient': matchIng,
            'both':       d => matchName(d) || matchIng(d),
        }[currentScope];

        lastResults = drugDatabase.filter(predicate);
        buildDosageBtns(lastResults);  // 動態產生劑型按鈕
        loading.classList.remove('active');
        searchBtn.disabled = false;
        renderResults();
    }, 50);
}

// ── Apply filter ──────────────────────────────────────────────
function applyFilter(arr) {
    switch (currentFilter) {
        case 'nhi':     return arr.filter(d => d.isNhi);
        case 'non-nhi': return arr.filter(d => !d.isNhi && !d.isRawMaterial);
        case 'raw':     return arr.filter(d => d.isRawMaterial);
        case 'all':     return arr;
        default:        return arr;
    }
}

// ── Render ────────────────────────────────────────────────────
function renderResults() {
    if (!lastResults) return;

    const filtered = applyDosage(applyFilter(lastResults));

    // 排序：健保品項在前，原料藥在後
    filtered.sort((a, b) => {
        if (a.isNhi !== b.isNhi) return b.isNhi - a.isNhi;
        if (a.isRawMaterial !== b.isRawMaterial) return a.isRawMaterial - b.isRawMaterial;
        return 0;
    });

    const limited = filtered.slice(0, 30);

    if (limited.length === 0) {
        resultsContainer.innerHTML = `
            <div class="no-results">
                <div style="font-size:2.5rem;margin-bottom:.75rem">🔍</div>
                <h3 style="margin-bottom:.5rem">符合條件的藥品為 0 筆</h3>
                <p style="color:var(--text-secondary)">試試切換上方篩選條件，或調整關鍵字</p>
            </div>`;
        resultsMeta.textContent = '';
    } else {
        const filterLabel = {
            'nhi':'健保品項', 'all':'全部藥品', 'non-nhi':'未納健保', 'raw':'原料藥'
        }[currentFilter];
        const dosageLabel = currentDosage !== 'all' ? ` · 劑型：<strong>${currentDosage}</strong>` : '';
        const scopeLabel = { 'name':'品名', 'ingredient':'成分', 'both':'品名＋成分' }[currentScope];
        resultsMeta.innerHTML = `
            搜尋範圍：<strong>${scopeLabel}</strong> ·
            篩選範圍：<strong>${filterLabel}</strong>${dosageLabel} ·
            符合 ${filtered.length.toLocaleString()} 筆
            ${filtered.length > 30 ? `（顯示前 30 筆，請使用更精確的關鍵字）` : ''}
        `;
        resultsContainer.innerHTML = limited.map(d => buildCard(d, lastKeyword)).join('');
    }
    resultsSection.classList.add('active');
}

// ── Card Builder ──────────────────────────────────────────────
function buildNhiCodesTable(matches, isGreen = false) {
    if (!matches || !matches.length) return '';
    const borderColor = isGreen ? 'var(--green-border)' : 'var(--amber-border)';
    const textColor   = isGreen ? 'var(--green-text)' : 'var(--amber-text)';
    const hasPrice = matches.some(m => m.price);
    const hasAtc   = matches.some(m => m.atcCode);
    const rows = matches.map(m => `
        <tr>
            <td style="font-weight:600;font-family:monospace;white-space:nowrap;">
                ${escapeHtml(m.code)}
                <button type="button" class="copy-mini" data-code="${escapeHtml(m.code)}" title="複製代號">📋</button>
            </td>
            <td style="font-size:.8rem;">${escapeHtml(m.enName || m.chName || '')}</td>
            ${hasPrice ? `<td class="price-cell" style="color:${textColor};">${m.price ? escapeHtml(m.price) + ' 元' : '—'}</td>` : ''}
            ${hasAtc   ? `<td>${m.atcCode ? `<span class="atc-badge">${escapeHtml(m.atcCode)}</span>` : '—'}</td>` : ''}
            <td style="font-size:.78rem;color:${textColor};">${m.chapter ? escapeHtml(m.chapter) : '—'}</td>
        </tr>
    `).join('');
    return `
        <div class="nhi-table-wrap">
        <table class="nhi-codes-table" style="border-color:${borderColor};">
            <thead><tr>
                <th>健保代號</th><th>品名</th>
                ${hasPrice ? '<th>支付價</th>' : ''}
                ${hasAtc   ? '<th>ATC</th>' : ''}
                <th>章節</th>
            </tr></thead>
            <tbody>${rows}</tbody>
        </table>
        </div>`;
}

function highlight(text, keyword) {
    if (!keyword || !text) return escapeHtml(text || '');
    // 先 escape，再高亮（不二次 escape）
    const escaped = escapeHtml(text);
    const escapedKw = escapeHtml(keyword);
    const re = new RegExp(escapedKw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    return escaped.replace(re, m => `<span class="hl">${m}</span>`);
}

function buildCard(drug, keyword = '') {
    const cardClass = drug.isNhi ? 'is-nhi' : (drug.isRawMaterial ? 'is-raw' : '');

    // Badges
    let badges = '';
    if (drug.isNhi) badges += '<span class="badge badge-nhi">💊 健保品項</span>';
    if (drug.isRawMaterial) badges += '<span class="badge badge-raw">⚗ 原料藥</span>';

    // Ingredients
    const pills = (drug.ingredients || '')
        .split(/[;；]/).map(s => s.trim()).filter(Boolean)
        .map(s => `<span class="ingredient-pill">${highlight(s, keyword)}</span>`)
        .join('') || '<span style="color:var(--text-secondary)">無資料</span>';

    // 仿單按鈕：優先用食藥署新版電子仿單平台（穩定）
    const fdaPkgUrl = safeUrl(drug.fdaPackageUrl);
    const fdaPkgBtn = fdaPkgUrl ? `
        <a href="${escapeHtml(fdaPkgUrl)}" target="_blank" rel="noopener noreferrer" class="link-btn link-btn-primary">
            📄 電子仿單（新版）
        </a>` : '';

    // 舊版仿單連結（API 39 的圖檔：index 0=仿單, index 1=外盒/標籤，部分 404）
    const oldPkgBtns = (drug.packageLinks || []).map((url, i) => {
        const href = safeUrl(url);
        if (!href) return '';   // 未通過白名單即不渲染，不留下可點擊的壞連結
        const label = i === 1 ? '外盒/標籤' : '舊版仿單';
        return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" class="link-btn link-btn-outline">📃 ${label}</a>`;
    }).join('');

    const pkgBtns = fdaPkgBtn + oldPkgBtns;

    // 外觀按鈕
    const imgBtns = (drug.imageLinks || []).map((url, i) => {
        const href = safeUrl(url);
        if (!href) return '';
        return `
        <a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" class="link-btn link-btn-outline">
            🖼️ 外觀圖${drug.imageLinks.length > 1 ? ' '+(i+1) : ''}
        </a>`;
    }).join('');

    // 健保查詢按鈕（如果有匹配紀錄）
    const nhiQueryUrl = 'https://info.nhi.gov.tw/INAE3000/INAE3000S01';
    // 健保區塊
    let nhiSection = '';
    const matches = drug.nhiMatches || [];

    // 圖檔區塊已整合至下方按鈕列，此處不重複顯示
    const imageSection = '';

    const nhiBtn = matches.length ? `
        <a href="${nhiQueryUrl}" target="_blank" rel="noopener" class="link-btn link-btn-amber">
            🔗 開啟健保查詢頁
        </a>` : '';

    const atcBadge = drug.nhiAtcCode
        ? `<span class="atc-badge" style="margin-left:.5rem;">${escapeHtml(drug.nhiAtcCode)}</span>`
        : '';

    if (drug.nhiChapter || drug.nhiChapterLink || (drug.chapterDetails && drug.chapterDetails.length)) {
        // 有特殊給付規定
        const detailsHtml = (drug.chapterDetails || []).map(d => `
            <details class="chapter-details" open>
                <summary><strong>${escapeHtml(d.chapter)}</strong> ${escapeHtml(d.title || '')}</summary>
                <pre class="chapter-content">${escapeHtml(d.content || '')}</pre>
            </details>
        `).join('');

        const chapterLinks = (drug.nhiChapterLink || '')
            .split(',').map(s => safeUrl(s.trim())).filter(Boolean);
        const chapterLinkBtns = chapterLinks.map((url, i) =>
            `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="inline-link">📑 章節 PDF${chapterLinks.length > 1 ? ' '+(i+1) : ''}</a>`
        ).join(' ');
        const chapterLine = drug.nhiChapter
            ? `<div class="info-content">
                 給付規定章節：<strong>${escapeHtml(drug.nhiChapter)}</strong>
                 ${chapterLinkBtns}
               </div>`
            : '';

        nhiSection = `
            <div class="nhi-section">
                <div class="info-label">💰 健保給付規定${atcBadge}</div>
                ${chapterLine}
                ${detailsHtml}
                ${buildNhiCodesTable(matches)}
            </div>`;
    } else if (drug.isNhi && matches.length) {
        // 健保品項但無特殊規定
        nhiSection = `
            <div class="nhi-section" style="background:var(--green-bg);border-color:var(--green-border);">
                <div class="info-label" style="color:var(--green-text);">💚 健保品項（無特殊給付限制）${atcBadge}</div>
                <div class="info-content" style="color:var(--green-text);">本藥品為健保給付品項，依一般慢性病用藥規範給付。</div>
                ${buildNhiCodesTable(matches, true)}
            </div>`;
    }

    return `
<div class="drug-card ${cardClass}">
    <div class="drug-header">
        <div class="drug-name-row">
            <div style="flex:1;min-width:200px;">
                <div class="drug-name-ch">${highlight(drug.chName || '無中文品名', keyword)}</div>
                <div class="drug-name-en">${highlight(drug.enName || '無英文品名', keyword)}</div>
            </div>
            <div style="display:flex;gap:.4rem;flex-wrap:wrap;align-items:center;">
                ${badges}
                <span class="drug-chevron">▼</span>
            </div>
        </div>
    </div>

    <div class="drug-body">
        <span class="badge-license" style="display:inline-block;margin-bottom:1rem;">📋 ${escapeHtml(drug.licenseNumber)}${drug.licenseType ? ' · '+escapeHtml(drug.licenseType) : ''}</span>

        <div class="info-section">
            <div class="info-label">💊 適應症</div>
            <div class="info-content">${escapeHtml(drug.indication || '無資料')}</div>
        </div>

        <div class="info-section">
            <div class="info-label">🧪 主要成分</div>
            <div class="ingredients-wrap">${pills}</div>
        </div>

        ${nhiSection}
        ${imageSection}

        <div class="links-row">
            ${pkgBtns}
            ${imgBtns}
            ${nhiBtn}
            <div class="link-helper-tip">💡 建議優先使用「電子仿單（新版）」；健保查詢請先複製代號再貼到查詢頁</div>
        </div>
    </div>
</div>`;
}

// ── 卡片互動：事件委派 ────────────────────────────────────────
// 原本用 inline onclick 並把資料值插進 JavaScript source（onclick="fn('CODE')"）。
// escapeAttr() 不跳脫單引號與反斜線，遭污染的值可跳出字串形成 DOM XSS。
// 改為 data attribute + 委派：資料值永遠只當作資料，不進入可執行語境，
// 同時移除 inline handler 以便啟用 CSP。
resultsContainer.addEventListener('click', e => {
    const copyBtn = e.target.closest('.copy-mini');
    if (copyBtn) {
        copyNhiCode(copyBtn.dataset.code || '', copyBtn);
        return;
    }
    const header = e.target.closest('.drug-header');
    if (header) toggleCard(header);
});

function toggleCard(headerEl) {
    headerEl.closest('.drug-card').classList.toggle('expanded');
}

// ── 複製健保代號 ──────────────────────────────────────────────
function copyNhiCode(code, btn) {
    // 一律用 textContent：code 來自資料，寫進 innerHTML 會是另一個注入點
    const orig = btn.textContent;
    const done = msg => {
        btn.textContent = msg;
        setTimeout(() => { btn.textContent = orig; }, 2000);
    };

    navigator.clipboard.writeText(code).then(() => {
        btn.style.background = 'var(--green-border)';
        btn.style.color = 'white';
        btn.style.borderColor = 'var(--green-border)';
        btn.textContent = '✓ 已複製 ' + code;
        setTimeout(() => {
            btn.textContent = orig;
            btn.style.background = '';
            btn.style.color = '';
            btn.style.borderColor = '';
        }, 2000);
    }).catch(() => {
        // fallback：選取文字讓使用者手動複製
        const tmp = document.createElement('input');
        tmp.value = code;
        document.body.appendChild(tmp);
        tmp.select();
        try { document.execCommand('copy'); } catch(e) {}
        document.body.removeChild(tmp);
        done('已複製: ' + code);
    });
}

// ── HTML escape ───────────────────────────────────────────────
function escapeHtml(s) {
    if (!s) return '';
    return String(s).replace(/[&<>"']/g, c => ({
        '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
}
// ── URL 白名單 ────────────────────────────────────────────────
// 原本以 escapeAttr()（只跳脫雙引號）處理 href，無法阻擋 javascript:／data:
// 等可執行 scheme。資料雖來自政府 API，仍須驗證：上游一旦被污染，
// 使用者點擊即執行任意內容，或被導向偽造的藥品資訊頁。
//
// 實測現行資料的 83,491 個 URL 全為 https，且僅來自 fda.gov.tw 與
// nhi.gov.tw 兩個網域，故可同時限制 scheme 與網域而不影響既有連結。
// 用網域後綴而非完整 hostname 比對，官方新增子網域時才不會靜默失連。
const ALLOWED_URL_DOMAINS = ['fda.gov.tw', 'nhi.gov.tw'];

function safeUrl(raw) {
    if (!raw) return '';
    let u;
    try {
        u = new URL(String(raw));   // 不給 base：相對路徑一律視為不合法
    } catch {
        return '';
    }
    if (u.protocol !== 'https:') return '';
    const h = u.hostname;
    const ok = ALLOWED_URL_DOMAINS.some(d => h === d || h.endsWith('.' + d));
    return ok ? u.href : '';
}

// ── Autosuggest ───────────────────────────────────────────────
const SUGGEST_MIN_CHARS = 2;
const SUGGEST_PER_GROUP = 5;
let suggestions   = [];   // [{ type:'ingredient'|'name', text, count }]
let suggestActive = -1;   // 鍵盤選取中的索引
let suggestTimer  = null;

// 前綴命中優先於中段命中，較符合使用者輸入直覺
function rankMatches(list, lower, limit) {
    const prefix = [], substr = [];
    for (const item of list) {
        const pos = item.lower.indexOf(lower);
        if (pos === 0)      prefix.push(item);
        else if (pos > 0)   substr.push(item);
        if (prefix.length >= limit) break;
    }
    return prefix.concat(substr).slice(0, limit);
}

function buildSuggestions(keyword) {
    const lower = keyword.toLowerCase();
    const out = [];

    // 成分建議在「品名」範圍下也顯示：預設範圍是品名，若不給這條捷徑，
    // 使用者打成分名只會拿到品名恰好含該字串的少數幾筆而不自知。
    // 點選後 applySuggestion 會明確切換範圍鈕，不會靜默改變結果集。
    rankMatches(ingredientIndex, lower, SUGGEST_PER_GROUP)
        .forEach(i => out.push({ type:'ingredient', text:i.name, count:i.count }));

    if (currentScope !== 'ingredient') {
        rankMatches(nameIndex, lower, SUGGEST_PER_GROUP)
            .forEach(n => out.push({ type:'name', text:n.name, count:0 }));
    }
    return out;
}

function renderSuggestions(keyword) {
    if (!suggestions.length) { closeSuggest(); return; }

    let html = '', lastType = null;
    suggestions.forEach((s, idx) => {
        if (s.type !== lastType) {
            html += `<div class="suggest-group">${s.type === 'ingredient' ? '💊 成分' : '📦 品名'}</div>`;
            lastType = s.type;
        }
        const count = s.count ? `<span class="s-count">${s.count} 筆</span>` : '';
        html += `
            <div class="suggest-item${idx === suggestActive ? ' active' : ''}"
                 role="option" aria-selected="${idx === suggestActive}" data-idx="${idx}">
                <span class="s-text">${highlight(s.text, keyword)}</span>${count}
            </div>`;
    });

    suggestBox.innerHTML = html;
    suggestBox.classList.add('active');
    searchInput.setAttribute('aria-expanded', 'true');
}

function closeSuggest() {
    suggestBox.classList.remove('active');
    suggestBox.innerHTML = '';
    searchInput.setAttribute('aria-expanded', 'false');
    suggestions = [];
    suggestActive = -1;
}

function applySuggestion(idx) {
    const s = suggestions[idx];
    if (!s) return;
    searchInput.value = s.text;
    // 點選成分時自動切到成分範圍，避免成分名以品名去搜而 0 筆
    if (s.type === 'ingredient' && currentScope === 'name') {
        scopeBtns.forEach(b => b.classList.toggle('active', b.dataset.scope === 'ingredient'));
        currentScope = 'ingredient';
    }
    closeSuggest();
    searchDrugs();
}

function moveSuggest(delta) {
    if (!suggestions.length) return;
    suggestActive = (suggestActive + delta + suggestions.length) % suggestions.length;
    renderSuggestions(searchInput.value.trim());
    suggestBox.querySelector('.suggest-item.active')?.scrollIntoView({ block:'nearest' });
}

searchInput.addEventListener('input', () => {
    clearTimeout(suggestTimer);
    const keyword = searchInput.value.trim();
    if (keyword.length < SUGGEST_MIN_CHARS) { closeSuggest(); return; }
    // debounce：品名索引達 4 萬筆，逐字掃描會有感延遲
    suggestTimer = setTimeout(() => {
        suggestActive = -1;
        suggestions = buildSuggestions(keyword);
        renderSuggestions(keyword);
    }, 150);
});

suggestBox.addEventListener('mousedown', e => {
    // mousedown 而非 click：搶在 input blur 關閉選單之前處理
    const item = e.target.closest('.suggest-item');
    if (!item) return;
    e.preventDefault();
    applySuggestion(Number(item.dataset.idx));
});

searchInput.addEventListener('blur', () => setTimeout(closeSuggest, 100));
searchInput.addEventListener('focus', () => {
    const keyword = searchInput.value.trim();
    if (keyword.length >= SUGGEST_MIN_CHARS) {
        suggestions = buildSuggestions(keyword);
        renderSuggestions(keyword);
    }
});

// ── Events ────────────────────────────────────────────────────
searchBtn.addEventListener('click', () => { closeSuggest(); searchDrugs(); });
searchInput.addEventListener('keydown', e => {
    const open = suggestBox.classList.contains('active');
    switch (e.key) {
        case 'ArrowDown': if (open) { e.preventDefault(); moveSuggest(1); }  break;
        case 'ArrowUp':   if (open) { e.preventDefault(); moveSuggest(-1); } break;
        case 'Escape':    closeSuggest(); break;
        case 'Enter':
            e.preventDefault();
            if (open && suggestActive >= 0) applySuggestion(suggestActive);
            else { closeSuggest(); searchDrugs(); }
            break;
    }
});

initDatabase();

// ── PWA：Service Worker ────────────────────────────────────────
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js')
        .catch(err => console.warn('SW 註冊失敗:', err));

    navigator.serviceWorker.addEventListener('message', e => {
        if (e.data?.type === 'OFFLINE_MODE') {
            document.getElementById('offlineBanner').style.display = 'flex';
        }
        // 本次載入用的是快取資料，背景已取得新版；不自動重載以免中斷查詢中的操作
        if (e.data?.type === 'DATA_UPDATED') {
            document.getElementById('updateBanner').style.display = 'flex';
        }
        // 背景更新的回應未通過驗證（多為主機回傳 200 的錯誤頁）。舊快取已保留，
        // 功能不受影響，故不打擾使用者，僅留下線索供排查。
        if (e.data?.type === 'DATA_UPDATE_FAILED') {
            console.warn('背景資料更新失敗：回應未通過格式驗證，繼續使用既有快取');
        }
    });
}

// ── PWA：離線 / 上線狀態偵測 ──────────────────────────────────
// ── PWA：資料更新提示 ─────────────────────────────────────────
const updateBanner = document.getElementById('updateBanner');
document.getElementById('reloadBtn').addEventListener('click', () => location.reload());
document.getElementById('dismissUpdateBtn').addEventListener('click', () => {
    updateBanner.style.display = 'none';
});

const offlineBanner = document.getElementById('offlineBanner');
window.addEventListener('offline', () => { offlineBanner.style.display = 'flex'; });
window.addEventListener('online',  () => { offlineBanner.style.display = 'none'; });

// ── PWA：安裝提示 ──────────────────────────────────────────────
let deferredInstallPrompt = null;
const installBanner  = document.getElementById('installBanner');
const installBtn     = document.getElementById('installBtn');
const dismissInstallBtn = document.getElementById('dismissInstallBtn');

window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredInstallPrompt = e;
    installBanner.style.display = 'flex';
});

installBtn.addEventListener('click', () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    deferredInstallPrompt.userChoice.then(() => {
        deferredInstallPrompt = null;
        installBanner.style.display = 'none';
    });
});

dismissInstallBtn.addEventListener('click', () => {
    installBanner.style.display = 'none';
});

window.addEventListener('appinstalled', () => {
    installBanner.style.display = 'none';
    deferredInstallPrompt = null;
});
