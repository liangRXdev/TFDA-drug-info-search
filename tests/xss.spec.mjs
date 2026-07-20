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

  test('所有 href 均為 https 且屬官方網域', () => {
    const links = [...card.querySelectorAll('a[href]')];
    for (const a of links) {
      const href = a.getAttribute('href');
      assert.ok(
        /^https:\/\/[^/]*\.(fda|nhi)\.gov\.tw\//.test(href),
        `不合法的 href：${href}`
      );
    }
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
