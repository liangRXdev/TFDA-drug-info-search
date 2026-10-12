/**
 * 前端 XSS 迴歸測試（對應審查項目 T8 / C5 / C6 / C8）。
 *
 * 刻意不把 JS 抽成獨立 module——本專案為單檔零建置靜態站，拆檔會連帶要求
 * bundler 並改變部署方式。改以 jsdom 直接載入 index.html、取用其全域函式，
 * 生產程式碼結構完全不動。
 *
 * 執行：node --test tests/xss.spec.mjs
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

let win;

before(() => {
  const html = readFileSync(join(root, 'index.html'), 'utf-8');
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://example.org/',
    beforeParse(w) {
      // 阻斷實際網路請求：initDatabase() 會 fetch 24MB 資料
      w.fetch = () => Promise.reject(new Error('network disabled in tests'));
      // 不可寫 w.navigator.serviceWorker = undefined：那會讓
      // 'serviceWorker' in navigator 成立而進入註冊分支。jsdom 本就未實作
      // serviceWorker，屬性不存在時該分支自然跳過。
    },
  });
  win = dom.window;

  // index.html 已改為 <script src="./app.js">；jsdom 預設不載入外部資源，
  // 故手動在同一個 window 執行，等同瀏覽器的載入結果。
  win.eval(readFileSync(join(root, 'app.js'), 'utf-8'));
});

// ── safeUrl：scheme 與網域白名單（C6）─────────────────────────
describe('safeUrl', () => {
  const dangerous = [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    '  javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'http://mcp.fda.gov.tw/x',          // 明文 http 亦不放行
  ];

  for (const raw of dangerous) {
    test(`拒絕危險 URL：${raw.slice(0, 40)}`, () => {
      assert.equal(win.safeUrl(raw), '');
    });
  }

  const foreignHosts = [
    'https://evil.example.com/x',
    'https://fda.gov.tw.evil.com/x',     // 網域後綴不可被前綴騙過
    'https://notfda.gov.tw/x',
  ];

  for (const raw of foreignHosts) {
    test(`拒絕非官方網域：${raw}`, () => {
      assert.equal(win.safeUrl(raw), '');
    });
  }

  const allowed = [
    'https://mcp.fda.gov.tw/im_detail_1/021571',
    'https://lmspiq.fda.gov.tw/web/detail/x.pdf',
    'https://info.nhi.gov.tw/INAE3000/INAE3000S01',
  ];

  for (const raw of allowed) {
    test(`放行官方 URL：${raw}`, () => {
      assert.equal(win.safeUrl(raw), raw);
    });
  }

  test('空值與非法輸入回傳空字串', () => {
    for (const raw of ['', null, undefined, 'not a url', '/relative/path']) {
      assert.equal(win.safeUrl(raw), '');
    }
  });
});

// ── 健保藥價歷史連結（Phase 3）──────────────────────────────────
describe('priceHistoryUrl', () => {
  const BASE = 'https://liangrxdev.github.io/NHI-drug-price-history/?code=';

  test('10 碼英數代號 → 寫死前綴＋大寫代號', () => {
    assert.equal(win.priceHistoryUrl('AC48092100'), `${BASE}AC48092100`);
    assert.equal(win.priceHistoryUrl(' ac48092100 '), `${BASE}AC48092100`);
  });

  test('非 10 碼英數一律不產生連結', () => {
    for (const bad of ['', null, undefined, 'AC4809210', 'AC480921000', `'); alert(1); //`,
      'AC48092100&x=1', 'AC48092 00', 'javascript:x', 'ＡＣ48092100']) {
      assert.equal(win.priceHistoryUrl(bad), '', String(bad));
    }
  });

  test('健保代號表每列帶藥價歷史連結，另開新分頁且不帶 opener', () => {
    const div = win.document.createElement('div');
    div.innerHTML = win.buildNhiCodesTable([
      { code: 'AC48092100', enName: 'CAREMOD', price: '10.1', chapter: '' },
      { code: 'BAD', enName: 'X', price: '', chapter: '' },
    ]);
    const links = [...div.querySelectorAll('a.price-hist-link')];
    assert.equal(links.length, 1);
    assert.equal(links[0].getAttribute('href'), `${BASE}AC48092100`);
    assert.equal(links[0].getAttribute('target'), '_blank');
    assert.match(links[0].getAttribute('rel'), /noopener/);
    assert.equal(div.querySelectorAll('thead th').length, div.querySelector('tbody tr').children.length);
  });
});

// ── escapeHtml / highlight（C8 / T8）─────────────────────────
describe('escapeHtml', () => {
  test('跳脫所有 HTML 敏感字元', () => {
    assert.equal(
      win.escapeHtml(`<script>alert("x")&'`),
      '&lt;script&gt;alert(&quot;x&quot;)&amp;&#39;'
    );
  });

  test('escapeAttr 已移除（避免被誤用為安全函式）', () => {
    assert.equal(typeof win.escapeAttr, 'undefined');
  });
});

describe('highlight', () => {
  test('惡意輸入不得產生可執行節點', () => {
    const out = win.highlight('<img src=x onerror=alert(1)>', '');
    const div = win.document.createElement('div');
    div.innerHTML = out;
    assert.equal(div.querySelectorAll('img, script').length, 0);
  });

  test('關鍵字含 regex metacharacter 不得拋錯', () => {
    for (const kw of ['(', '[', '*', '\\', '.*', '$^']) {
      assert.doesNotThrow(() => win.highlight('AMLODIPINE', kw));
    }
  });

  test('正常高亮仍運作，且只產生 span.hl', () => {
    const div = win.document.createElement('div');
    div.innerHTML = win.highlight('AMLODIPINE BESYLATE', 'amlo');
    const marks = div.querySelectorAll('span.hl');
    assert.equal(marks.length, 1);
    assert.equal(marks[0].textContent, 'AMLO');
    assert.equal(div.querySelectorAll('*:not(span.hl)').length, 0);
  });
});

// ── buildCard：以惡意資料驗證整張卡片（T8 核心）──────────────
describe('buildCard 對惡意資料的防護', () => {
  const evil = '<img src=x onerror=alert(1)>';

  const maliciousDrug = {
    licenseNumber: evil,
    licenseType: evil,
    chName: evil,
    enName: evil,
    indication: evil,
    ingredients: evil,
    usage: evil,
    fdaPackageUrl: 'javascript:alert(1)',
    packageLinks: ['javascript:alert(2)', 'https://evil.example.com/a.pdf'],
    imageLinks: ['data:text/html,<script>alert(3)</script>'],
    nhiChapter: evil,
    nhiChapterLink: 'javascript:alert(4)',
    nhiAtcCode: evil,
    nhiPrimaryCode: evil,
    chapterDetails: [{ chapter: evil, title: evil, content: evil }],
    nhiMatches: [{
      code: `'); alert(1); //`,
      enName: evil, chName: evil, chapter: evil,
      chapterLink: 'javascript:alert(5)', drugUrl: 'javascript:alert(6)',
      atcCode: evil, price: evil, confidence: 'verified',
    }],
    isRawMaterial: false,
    isNhi: true,
  };

  let card;

  before(() => {
    const div = win.document.createElement('div');
    div.innerHTML = win.buildCard(maliciousDrug, '');
    card = div;
  });

  test('不產生任何 script 或 img 節點', () => {
    assert.equal(card.querySelectorAll('script').length, 0);
    assert.equal(card.querySelectorAll('img').length, 0);
  });

  test('不產生任何 inline event handler 屬性', () => {
    for (const el of card.querySelectorAll('*')) {
      for (const attr of el.attributes) {
        assert.ok(
          !attr.name.toLowerCase().startsWith('on'),
          `發現 inline handler：${el.tagName}[${attr.name}]`
        );
      }
    }
  });

  test('所有 href 均為 https 且屬官方網域（或寫死的健保藥價歷史網址）', () => {
    const links = [...card.querySelectorAll('a[href]')];
    for (const a of links) {
      const href = a.getAttribute('href');
      assert.ok(
        /^https:\/\/[^/]*\.(fda|nhi)\.gov\.tw\//.test(href)
          || /^https:\/\/liangrxdev\.github\.io\/NHI-drug-price-history\/\?code=[A-Z0-9]{10}$/.test(href),
        `不合法的 href：${href}`
      );
    }
  });

  test('惡意健保代號不產生藥價歷史連結', () => {
    assert.equal(card.querySelectorAll('a.price-hist-link').length, 0);
  });

  test('危險 URL 被整個捨棄而非渲染成壞連結', () => {
    const hrefs = [...card.querySelectorAll('a[href]')].map(a => a.getAttribute('href'));
    for (const h of hrefs) {
      assert.ok(!h.startsWith('javascript:'), `殘留 javascript: 連結 ${h}`);
      assert.ok(!h.startsWith('data:'), `殘留 data: 連結 ${h}`);
    }
  });

  test('健保代號以 data attribute 傳遞，不進入可執行語境', () => {
    const btn = card.querySelector('.copy-mini');
    if (btn) {
      assert.equal(btn.dataset.code, maliciousDrug.nhiMatches[0].code);
      assert.equal(btn.getAttribute('onclick'), null);
    }
  });
});

// ── 仿單連結分類（依 URL 路徑，不依陣列位置）──────────────────────
describe('classifyPackageLink / 仿單按鈕', () => {
  const INSERT = 'https://mcp.fda.gov.tw/insert/pdfcasefile/i_00cfcf5c-d586-48c2-85b6-51133a59a9d1?c=2';
  const LABEL  = 'https://mcp.fda.gov.tw/insert/lablefiles/35cefae3-8884-49ee-bb88-75e2088f146b_0?c=2';
  const EXPORT = 'https://mcp.fda.gov.tw/exportpdf/%E5%85%A7%E8%A1%9B%E8%97%A5%E8%A3%BD%E5%AD%97%E7%AC%AC005347%E8%99%9F';
  const OTHER  = 'https://mcp.fda.gov.tw/somewhere/else';

  const labelsOf = (packageLinks) => {
    const div = win.document.createElement('div');
    div.innerHTML = win.buildCard({ licenseNumber: 'X', packageLinks }, '');
    return [...div.querySelectorAll('a.link-btn-outline')].map(a => a.textContent.replace('📃', '').trim());
  };

  test('四種路徑各自分類', () => {
    assert.equal(win.classifyPackageLink(INSERT).kind, 'insert');
    assert.equal(win.classifyPackageLink(LABEL).kind, 'label');
    assert.equal(win.classifyPackageLink(EXPORT).kind, 'export');
    assert.equal(win.classifyPackageLink(OTHER).kind, 'other');
    assert.equal(win.classifyPackageLink('javascript:alert(1)'), null);
    assert.equal(win.classifyPackageLink(''), null);
  });

  test('只有外盒連結時標為「外盒/標籤」（回歸：舊版依位置誤標為仿單）', () => {
    assert.deepEqual(labelsOf([LABEL]), ['外盒/標籤']);
  });

  test('仿單＋外盒', () => {
    assert.deepEqual(labelsOf([INSERT, LABEL]), ['PDF 仿單', '外盒/標籤']);
  });

  test('exportpdf 不產生按鈕', () => {
    assert.deepEqual(labelsOf([EXPORT, LABEL]), ['外盒/標籤']);
    assert.deepEqual(labelsOf([EXPORT]), []);
  });

  const INSERT2 = INSERT.replace('00cfcf5c', '11cfcf5c');
  const labelN = n => LABEL.replace('35cefae3', `35cefa${String(n).padStart(2, '0')}`);

  test('同類多筆依序編號；未知路徑標為其他連結', () => {
    assert.deepEqual(labelsOf([INSERT, INSERT2, OTHER]), ['PDF 仿單 1', 'PDF 仿單 2', '其他連結']);
  });

  test('「;」串接的多個網址拆開、去重，順序不變（回歸：舊版只能開到第一個）', () => {
    assert.deepEqual([...win.splitLinks([`${INSERT};${INSERT2}`, ` ${INSERT} ;`, LABEL])], [INSERT, INSERT2, LABEL]);
    assert.deepEqual(labelsOf([`${EXPORT};${LABEL}`]), ['外盒/標籤']);
    assert.deepEqual([...win.splitLinks(null)], []);
  });

  test('外盒超過 2 張收進 details，連結一張不漏；仿單不收合', () => {
    const div = win.document.createElement('div');
    const labels = Array.from({ length: 5 }, (_, i) => labelN(i));
    div.innerHTML = win.buildCard({ licenseNumber: 'X', packageLinks: [labels.join(';'), INSERT, INSERT2], imageLinks: [] }, '');
    const group = div.querySelector('details.link-group');
    assert.ok(group);
    assert.match(group.querySelector('summary').textContent, /外盒\/標籤（5）/);
    assert.equal(group.querySelectorAll('a').length, 5);
    assert.equal(div.querySelectorAll('details.link-group').length, 1);
    assert.equal([...div.querySelectorAll('a')].filter(a => a.textContent.includes('PDF 仿單')).length, 2);
  });

  test('外盒恰 2 張不收合', () => {
    const div = win.document.createElement('div');
    div.innerHTML = win.buildCard({ licenseNumber: 'X', packageLinks: [`${labelN(1)};${labelN(2)}`] }, '');
    assert.equal(div.querySelectorAll('details').length, 0);
    assert.equal(div.querySelectorAll('a.link-btn-outline').length, 2);
  });

  test('packageLinks 缺值不拋錯', () => {
    assert.deepEqual(labelsOf(undefined), []);
    assert.deepEqual(labelsOf(null), []);
  });
});

// ── 用法用量：轉介文字不顯示，實質內容顯示 ─────────────────────────
describe('isPlaceholderUsage / 用法用量區塊', () => {
  const placeholders = [
    '', '   ', null, undefined, '。',
    '詳見仿單', '請詳見仿單', '詳如仿單。', '如仿單', '請詳閱說明書', '請詳閱說明書後使用',
    '請詳閱說明書後使用本藥須由醫師處方使用', '本藥須由醫師處方使用。詳細用法用量請參見仿單。',
    '本藥須由醫師處方使用。詳閱仿單說明書', '詳細內容請參閱仿單', '(詳細敘述請參見仿單擬稿)',
    '詳見中文仿單擬稿。', '詳如電子仿單核定本', '請參照仿單說明',
    '製劑原料', '製劑原料。', '本品為原料藥粉末，非一般製劑。', '本產品為原料藥結晶性粉末。',
    '詳如仿單所述', '請參考仿單', '依仿單內容刊載。', '詳見藥品仿單。', '詳如核定本',
    '請詳閱說明書後使用。本藥限由醫師使用。', '原料藥', '專供硬膠囊製劑用', '醫師處方藥品', '*',
  ];
  const substantive = [
    '1天3次，每次1錠',
    '成人每天劑量為13-15mg/kg，分2-4次服用',
    '以棉球沾之塗於患部。',
    '需要時使用，每次1至2滴。請詳見仿單',
    '通常成人每天一次，每次口服ㄧ顆膠囊。本藥須由醫師處方使用。',
    '每日口服一錠。(請詳見藥品仿單)',
    '請詳見仿單\n(一天3至4次，每次1至2滴)',
  ];

  for (const s of placeholders) {
    test(`隱藏：${JSON.stringify(s)}`, () => assert.equal(win.isPlaceholderUsage(s), true));
  }
  for (const s of substantive) {
    test(`顯示：${s}`, () => assert.equal(win.isPlaceholderUsage(s), false));
  }

  const usageLabel = (usage) => {
    const div = win.document.createElement('div');
    div.innerHTML = win.buildCard({ licenseNumber: 'X', usage }, '');
    return [...div.querySelectorAll('.info-label')].find(e => e.textContent.includes('用法用量'));
  };

  test('卡片：實質內容出現區塊並標明以仿單為準', () => {
    const label = usageLabel('1天3次，每次1錠');
    assert.ok(label);
    assert.match(label.textContent, /以仿單為準/);
    assert.equal(label.nextElementSibling.textContent, '1天3次，每次1錠');
  });

  test('卡片：轉介文字整個區塊省略', () => {
    assert.equal(usageLabel('請詳見仿單'), undefined);
    assert.equal(usageLabel(undefined), undefined);
  });
});
