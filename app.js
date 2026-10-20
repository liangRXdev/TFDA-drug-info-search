const DATA_URL = './drugs_data.json';
// 建置時間戳獨立成小檔：若寫在 drugs_data.json 內，該檔每次建置必然改變，
// CI 的「資料無變動則跳過 commit」會永遠失效
const VERSION_URL = './data_version.json';
// 美國處方藥仿單參考（docs/plan-us-label.md）：卡片區塊首次展開時才載入
const US_LABEL_URL = './us_label_data.json';
// 須與 us_label.py 的 MATCH_RULES_VERSION 相同；三方（主資料、仿單資料、前端）不一致即不可用
const US_LABEL_RULES_VERSION = 1;

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
let drugsMeta    = {};          // drugs_data.json 的 _meta（含 usLabelRulesVersion）
let versionInfo  = null;        // data_version.json（含 usLabelGeneratedAt）
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
        drugsMeta = meta;
        versionInfo = version;
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
    const rows = matches.map(m => {
        const histUrl = priceHistoryUrl(m.code);
        return `
        <tr>
            <td style="font-weight:600;font-family:monospace;white-space:nowrap;">
                ${escapeHtml(m.code)}
                <button type="button" class="copy-mini" data-code="${escapeHtml(m.code)}" title="複製代號">📋</button>
            </td>
            <td style="font-size:.8rem;">${escapeHtml(m.enName || m.chName || '')}</td>
            ${hasPrice ? `<td class="price-cell" style="color:${textColor};">${m.price ? escapeHtml(m.price) + ' 元' : '—'}</td>` : ''}
            ${hasAtc   ? `<td>${m.atcCode ? `<span class="atc-badge">${escapeHtml(m.atcCode)}</span>` : '—'}</td>` : ''}
            <td style="font-size:.78rem;color:${textColor};">${m.chapter ? escapeHtml(m.chapter) : '—'}</td>
            <td style="white-space:nowrap;">${histUrl
                ? `<a href="${escapeHtml(histUrl)}" target="_blank" rel="noopener noreferrer" class="inline-link price-hist-link"
                     aria-label="查看 ${escapeHtml(m.code)} 的健保藥價歷史">查看 ↗</a>`
                : '—'}</td>
        </tr>`;
    }).join('');
    return `
        <div class="nhi-table-wrap">
        <table class="nhi-codes-table" style="border-color:${borderColor};">
            <thead><tr>
                <th>健保代號</th><th>品名</th>
                ${hasPrice ? '<th>支付價</th>' : ''}
                ${hasAtc   ? '<th>ATC</th>' : ''}
                <th>章節</th>
                <th title="健保支付價的完整歷史（另一個網站：NHI-drug-price-history）">健保藥價歷史</th>
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

    // API 39 連結：拆「;」串接 → 依 URL 路徑分類（見 classifyPackageLink），部分 404
    // 未通過白名單（null）或 exportpdf 即不渲染，不留下可點擊的壞連結
    const pkgLinks = splitLinks(drug.packageLinks)
        .map(classifyPackageLink)
        .filter(l => l && l.kind !== 'export');
    const hrefsOf = kind => pkgLinks.filter(l => l.kind === kind).map(l => l.href);
    const oldPkgBtns =
        linkButtons(hrefsOf('insert'), '📃', 'PDF 仿單', Infinity) +   // 仿單最多 6 份，逐一列出
        linkButtons(hrefsOf('label'),  '📃', '外盒/標籤') +
        linkButtons(hrefsOf('other'),  '📃', '其他連結');

    // 用法用量（許可證登載）：只顯示有實質內容者
    const usageSection = isPlaceholderUsage(drug.usage) ? '' : `
        <div class="info-section">
            <div class="info-label">📝 用法用量（許可證登載，以仿單為準）</div>
            <div class="info-content">${escapeHtml(drug.usage.trim())}</div>
        </div>`;

    const pkgBtns = fdaPkgBtn + oldPkgBtns;

    // 外觀按鈕
    const imgBtns = linkButtons(splitLinks(drug.imageLinks).map(safeUrl).filter(Boolean), '🖼️', '外觀圖');

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
        ${usageSection}

        <div class="info-section">
            <div class="info-label">🧪 主要成分</div>
            <div class="ingredients-wrap">${pills}</div>
        </div>

        ${nhiSection}
        ${buildUsLabelSection(drug)}
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
    const usSummary = e.target.closest('.us-label-summary');
    if (usSummary) {
        // <details> 的展開由瀏覽器預設行為處理；這裡只負責首次載入內容
        loadUsLabelInto(usSummary.closest('.us-label'));
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
// dailymed.nlm.nih.gov：美國仿單參考區塊的導覽連結（docs/plan-us-label.md D10）。
// 只放行此完整子網域，不放寬到 nih.gov——其餘 NIH 網站與本工具無關。
const ALLOWED_URL_DOMAINS = ['fda.gov.tw', 'nhi.gov.tw', 'dailymed.nlm.nih.gov'];

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

// ── 健保藥價歷史連結（NHI-drug-price-history，Phase 3）─────────────
// 目標為自家網站、網址前綴寫死，不是上游資料提供的 URL，故不放寬 safeUrl() 的官方網域白名單。
// 代號須為 10 碼英數（健保藥品代號格式）才產生連結：資料若被污染，最多是不出現連結，
// 不會把任意字串帶進 href。
const PRICE_HISTORY_BASE = 'https://liangrxdev.github.io/NHI-drug-price-history/';
const NHI_CODE_RE = /^[A-Za-z0-9]{10}$/;

function priceHistoryUrl(code) {
    const c = String(code || '').trim();
    if (!NHI_CODE_RE.test(c)) return '';
    return `${PRICE_HISTORY_BASE}?code=${encodeURIComponent(c.toUpperCase())}`;
}

// ── 美國處方藥仿單參考（openFDA；docs/plan-us-label.md）────────────────
// 狀態語義的唯一權威定義在規格 §6.3，這裡只負責呈現。依 G3 只做正面陳述：
// 「未找到 BW」絕不可寫成「沒有 BW」——openFDA 約三成仿單缺結構化資料，無法比對。
const US_LABEL_DISCLAIMER =
    '以下為 openFDA 收錄之美國處方藥仿單內容，依成分與給藥途徑比對，並非本品項的台灣核准資訊；' +
    '適應症、劑量與警語可能不同。不可取代醫師或藥師的專業判斷。';
const DAILYMED_SETID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const US_SECTION_NAMES = {
    'pregnancy': '8.1 Pregnancy',
    'teratogenic_effects': 'Pregnancy（舊格式）',
    '8.1 Pregnancy': '8.1 Pregnancy',
    '8.2 Lactation': '8.2 Lactation',
    'nursing_mothers': 'Nursing Mothers（舊格式）',
};
// ── 資料契約：與 sw.js 同名函式、us_label.py 的 validate_result／validate_output 為同一份，
// 三處須同步；tests/fixtures/us_label_contract.json 的反例三方都跑（Codex 審查 CR1／CR2）
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
    // ①② 都建立在 C 非空之上（§6.3）：N≥1
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

// 整份檔案：_meta 宣稱的鍵數與各狀態計數須與實際內容一致——殘缺但每筆合法的檔案也要拒收
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

// set_id 須為 UUID 才產生連結：資料若被污染，最多是不出現連結
function dailyMedSetUrl(setId) {
    const s = String(setId || '');
    if (!DAILYMED_SETID_RE.test(s)) return '';
    return safeUrl(`https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=${s.toLowerCase()}`);
}

function dailyMedSearchUrl(key) {
    const ings = String(key || '').split('|')[1];
    if (!ings) return '';
    const q = encodeURIComponent(ings.split('+').join(' '));
    return safeUrl(`https://dailymed.nlm.nih.gov/dailymed/search.cfm?labeltype=all&query=${q}`);
}

function externalLink(href, text) {
    return href
        ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" class="inline-link us-label-link">${text}</a>`
        : '';
}

function fmtDate8(s) {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(s || ''));
    return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

function usSourceLine(src) {
    if (!src || typeof src !== 'object') return '';
    const bits = [
        `<strong>${escapeHtml(src.name || '（未具名）')}</strong>`,
        src.mfr ? escapeHtml(src.mfr) : '',
        src.app ? escapeHtml(src.app) : '',
        fmtDate8(src.eff) ? `生效日 ${fmtDate8(src.eff)}` : '',
    ].filter(Boolean).join(' · ');
    return `${bits} ${externalLink(dailyMedSetUrl(src.id), 'DailyMed 目前版本（可能比本站資料新）↗')}`;
}

function usTextBlock(arr) {
    const parts = (Array.isArray(arr) ? arr : []).filter(t => typeof t === 'string' && t.trim());
    return `<div class="us-label-text">${parts.map(escapeHtml).join('\n\n')}</div>`;
}

function usSectionHtml(title, sec, rep) {
    let inner;
    if (sec && sec.st === 'ok' && Array.isArray(sec.t)) {
        const name = US_SECTION_NAMES[sec.sec] || '';
        inner = `${name ? `<div class="us-label-secname">${escapeHtml(name)}</div>` : ''}${usTextBlock(sec.t)}`;
    } else if (sec && sec.st === 'unextractable') {
        inner = `<p class="us-label-msg">無法自動擷取此段落，請見 DailyMed。 ${externalLink(dailyMedSetUrl(rep && rep.id), 'DailyMed ↗')}</p>`;
    } else {
        inner = '<p class="us-label-msg">代表仿單中未找到此段落。</p>';
    }
    return `<div class="us-label-section"><div class="us-label-heading">${title}</div>${inner}</div>`;
}

function usLabelShell(inner) {
    return `<p class="us-label-disclaimer">${US_LABEL_DISCLAIMER}</p>${inner}`;
}

const US_UNAVAILABLE_HTML = '<p class="us-label-msg">美國仿單資料暫時無法提供。</p>';

function usNoMatchHtml(key) {
    return `<p class="us-label-msg">查無可對應的美國處方藥仿單。 ${externalLink(dailyMedSearchUrl(key), '在 DailyMed 搜尋 ↗')}</p>`;
}

function renderUsLabel(entry, key, meta) {
    if (!isValidUsLabelEntry(entry) || entry.s === 'unavailable') return usLabelShell(US_UNAVAILABLE_HTML);
    if (entry.s === 'nomatch') return usLabelShell(usNoMatchHtml(key));

    const n = entry.n, m = entry.m;
    const parts = [];
    if (entry.s === 'bw') {
        const note = entry.b
            ? `<p class="us-label-note">代表仿單中未找到 Boxed Warning，以下取自另一份仿單：${usSourceLine(entry.b)}</p>`
            : '';
        parts.push(`<div class="us-label-bw">
            <div class="us-label-heading">⚠️ Boxed Warning</div>${note}${usTextBlock(entry.bw)}
        </div>
        <p class="us-label-stat">openFDA 可比對的 ${n} 份參考仿單中，${m} 份列有 Boxed Warning。</p>`);
    } else {
        parts.push(`<p class="us-label-msg us-label-nobw">在 openFDA 可比對的 ${n} 份美國處方藥仿單中<strong>未找到</strong> Boxed Warning。` +
            `openFDA 約三成仿單缺結構化資料、無法比對，<strong>不代表本成分沒有 Boxed Warning</strong>，請至 DailyMed 確認。 ` +
            `${externalLink(dailyMedSearchUrl(key), '在 DailyMed 搜尋 ↗')}</p>`);
    }
    parts.push(usSectionHtml('🤰 懷孕', entry.preg, entry.r));
    parts.push(usSectionHtml('🍼 哺乳', entry.lact, entry.r));

    const others = n > 1
        ? `同成分同途徑另有 ${n - 1} 份仿單，內容可能因改版時間而略有差異，請見 DailyMed。` : '';
    const exportDate = meta && typeof meta.openfdaExportDate === 'string' ? escapeHtml(meta.openfdaExportDate) : '未知';
    const built = versionInfo && versionInfo.usLabelGeneratedAt
        ? new Date(versionInfo.usLabelGeneratedAt).toLocaleDateString('zh-TW') : '未知';
    parts.push(`<div class="us-label-source">
        <div>代表仿單：${usSourceLine(entry.r)}</div>
        <div>${others}openFDA 資料日期 ${exportDate}；本站建置 ${escapeHtml(built)}。</div>
    </div>`);
    return usLabelShell(parts.join(''));
}

function buildUsLabelSection(drug) {
    // 主資料尚未含此功能（舊版快取）時整塊不顯示；有此功能後，缺欄位一律視為不可用
    if (drugsMeta.usLabelRulesVersion === undefined && !drug.usLabelKey && !drug.usLabelStatus) return '';
    const key = typeof drug.usLabelKey === 'string' ? drug.usLabelKey : '';
    if (!key && drug.usLabelStatus === 'notApplicable') return '';
    const body = key
        ? '<p class="us-label-msg">載入中…</p>'
        : usLabelShell(drug.usLabelStatus === 'noMatch' ? usNoMatchHtml('') : US_UNAVAILABLE_HTML);
    const attr = key ? `data-us-key="${escapeHtml(key)}"` : 'data-us-ready="1"';
    return `
        <details class="us-label" ${attr}>
            <summary class="us-label-summary">🌐 美國處方藥仿單參考（openFDA）</summary>
            <div class="us-label-body" aria-live="polite">${body}</div>
        </details>`;
}

// single-flight：多張卡片同時展開只抓一次；失敗不快取，下次展開可重試
let usLabelPromise = null;

function fetchUsLabelData() {
    if (!usLabelPromise) {
        usLabelPromise = fetch(US_LABEL_URL)
            .then(r => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                return r.json();
            })
            .then(json => {
                // 整份檔案層級的問題（版本不符、殘缺、違約）丟出錯誤：不快取，下次展開可重試。
                // 單一鍵缺失則是資料狀態，由 loadUsLabelInto 顯示不可用（Codex 審查 CR4）
                if (drugsMeta.usLabelRulesVersion !== US_LABEL_RULES_VERSION || !isValidUsLabelData(json)) {
                    throw new Error('美國仿單資料版本或格式不符');
                }
                return json;
            })
            .catch(err => { usLabelPromise = null; throw err; });
    }
    return usLabelPromise;
}

async function loadUsLabelInto(details) {
    if (!details || details.dataset.usReady === '1' || details.dataset.usLoading === '1') return;
    const key = details.dataset.usKey || '';
    const body = details.querySelector('.us-label-body');
    details.dataset.usLoading = '1';
    try {
        const json = await fetchUsLabelData();
        // 只渲染本卡片自己的鍵；hasOwnProperty 避免 "__proto__" 之類的鍵讀到原型
        const entry = Object.prototype.hasOwnProperty.call(json.data, key) ? json.data[key] : null;
        body.innerHTML = renderUsLabel(entry, key, json._meta);
        details.dataset.usReady = '1';
    } catch (err) {
        console.error('美國仿單資料載入失敗:', err);
        body.innerHTML = usLabelShell(US_UNAVAILABLE_HTML);   // 不標 ready：再次展開可重試
    } finally {
        delete details.dataset.usLoading;
    }
}

// ── 仿單連結分類（API 39）──────────────────────────────────────
// build_data.py 依序放入「仿單」「外盒」兩欄並略過空值，陣列位置因此不代表類型：
// 只有外盒的品項（實測 1,914 筆）會被位置判斷標成「舊版仿單」。改依 URL 路徑判斷。
// /exportpdf/{許可證} 實測不是 PDF，會轉址到電子仿單頁並自動彈出驗證碼匯出視窗，
// 與「電子仿單（新版）」重複，故不渲染（2026-10-12）。
const PACKAGE_LINK_KINDS = [
    { re: /^\/insert\/pdfcasefile\//, kind: 'insert', label: 'PDF 仿單' },
    { re: /^\/insert\/lablefiles\//,  kind: 'label',  label: '外盒/標籤' },
    { re: /^\/exportpdf\//,           kind: 'export', label: '' },
];

// API 39／42 的單一欄位可能以「;」串接多個網址（實測仿單 8,927 張證、外觀圖 419 張證），
// 原樣當成一個 URL 會讓第二個以後的檔案變成查詢字串而點不到。拆開並去重（保持原順序）。
function splitLinks(list) {
    const seen = new Set(), out = [];
    for (const raw of list || []) {
        for (const part of String(raw).split(';')) {
            const t = part.trim();
            if (t && !seen.has(t)) { seen.add(t); out.push(t); }
        }
    }
    return out;
}

// 同類連結超過此數即收進 <details>，避免單張卡片出現數十顆按鈕（外盒圖最多 36 張）
const LINK_GROUP_THRESHOLD = 2;

function linkButtons(hrefs, icon, label, groupAbove = LINK_GROUP_THRESHOLD) {
    if (!hrefs.length) return '';
    const btns = hrefs.map((href, i) =>
        `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" class="link-btn link-btn-outline">${icon} ${label}${hrefs.length > 1 ? ' ' + (i + 1) : ''}</a>`
    ).join('');
    if (hrefs.length <= groupAbove) return btns;
    return `<details class="link-group">
            <summary class="link-btn link-btn-outline">${icon} ${label}（${hrefs.length}）</summary>
            <div class="link-group-list">${btns}</div>
        </details>`;
}

function classifyPackageLink(raw) {
    const href = safeUrl(raw);
    if (!href) return null;
    const path = new URL(href).pathname;
    const hit = PACKAGE_LINK_KINDS.find(k => k.re.test(path));
    return hit ? { href, kind: hit.kind, label: hit.label }
               : { href, kind: 'other', label: '其他連結' };
}

// ── 用法用量：濾除「只是轉介仿單」的登載文字 ──────────────────────
// API 37 的用法用量欄約八成是「詳見仿單」「製劑原料」這類無內容文字（寫法變體上百種）。
// 誤藏 = 藥師漏看實質內容；誤顯 = 多一行雜訊。故寧可顯示：整段去標點後須「完全」
// 符合轉介句型才隱藏，混合型（「每次1至2滴。請詳見仿單」）照常顯示。
const USAGE_PUNCT_RE = /[\s。．.，,、；;:：!！?？()（）「」『』【】\[\]]/g;
const USAGE_RX_ONLY = '(本藥須由醫師處方使用|本藥限由醫師使用|醫師處方藥品)';
const USAGE_REFERRAL_RE = new RegExp(
    `^${USAGE_RX_ONLY}?` +
    '(內容|詳細內容|詳細用法用量|詳細敘述|用法用量)?(請)?' +
    '(詳見|詳如|詳閱|詳參|參閱|參照|參見|參考|依|如|見)' +
    '(中文|藥品|核定)?(仿單|說明書|電子仿單核定本|仿單核定本|核定本)' +
    '(說明書|說明|擬稿|所載|所述|內容)?(刊載)?(後)?(使用)?' +
    `${USAGE_RX_ONLY}?$`
);
const USAGE_NON_CONTENT_RE = new RegExp(
    '^(製劑原料藥?|原料藥|原料製劑|專供.{0,6}製劑(之)?用|(本品|本產品)為原料藥\\D{0,12}|' +
    `${USAGE_RX_ONLY})$`
);

function isPlaceholderUsage(text) {
    const s = String(text || '').replace(USAGE_PUNCT_RE, '');
    // 去標點後無任何文字或數字（如「*」）亦視為無內容
    return !/[\p{L}\p{N}]/u.test(s) || USAGE_REFERRAL_RE.test(s) || USAGE_NON_CONTENT_RE.test(s);
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
