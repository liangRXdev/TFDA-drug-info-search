# TFDA-drug-info-search — 專案規則

食藥署藥品資訊查詢系統。零建置靜態站（GitHub Pages）+ Python ETL + GitHub Actions。前端 vanilla JS，無 bundler、無框架。

> ⚠️ 與 `TFDA-drug-recall-dashboard` 的設定**相反**，別把規則搬錯邊：
> | | 本 repo | recall-dashboard |
> |---|---|---|
> | CSP | **有**（`index.html` meta，`script-src 'self'`） | 無 |
> | JS 位置 | 抽出為 `app.js` | inline |
> | 外部套件 | **零依賴** | jQuery + DataTables（需 SRI） |

---

## 風險排序：資料正確性 > XSS

本站供藥師臨床查詢，**無登入、無 session、無使用者資料**——XSS 竊取不到任何憑證。但錯誤的健保代號或支付價會直接誤導用藥。

所以修補優先序是「**污染資料的入口**」（如 `verify=False`、匹配邏輯）高於「渲染層」。安全掃描報告若把 XSS 排在資料正確性前面，照上述順序處理。

（渲染層仍已加固：`escapeHtml()` + `safeUrl()`，見下。）

## 三個會咬人的地方

1. **新增靜態檔 → 必須同步加入 `sw.js` 的 install 預快取清單**，否則離線時整站壞掉。
   CI 有關卡擋（`test.yml:63` 逐一 grep `index.html` / `app.js` / `manifest.json`）——**新增第四個檔案時，記得把它一併加進那個 for 迴圈**，否則關卡形同虛設。

2. **改 `index.html` 或 `app.js` → 升 `sw.js` 的 `STATIC_CACHE` 版本**（目前 `tfda-static-v5`）。三個 cache 各自獨立編號（static / data / fonts），只升動到的那個。

3. **CSP 是 `<meta>` 標籤不是 `_headers`**。`script-src 'self'` 意味著**不能寫 inline `<script>` 或 inline event handler**（`onclick=` 等）——JS 一律進 `app.js`。這裡不需要算 hash（那是 pharmacy-portal 的做法）。

## 前端連結白名單

所有外部連結一律經 `safeUrl()`：限 `https` + `fda.gov.tw` / `nhi.gov.tw` 網域後綴。**未通過即不渲染**，不留下可點擊的壞連結。新增資料來源網域要同時改 `safeUrl()` 白名單與 CSP。

## build_data.py 的刻意設計（勿收緊）

- **成分比對採寬鬆匹配**（空成分視為匹配成立）。收緊會使大量品項失去健保歸屬——**藥師查不到，比偶發誤配更危險**。現況 verified 98% / code-only 2%
- **重複許可證只留首筆**：已實測 3,685 列重複中 **0 列**與首筆有欄位差異，是純重複，無資料損失。不必再驗
- **支付價 `-` 不是髒資料**：975 筆「異常值」全部只有 `-` 一種，是健保署「無支付價」的既定慣例，已列入 `NO_PRICE_MARKERS`（`build_data.py:434`）
- 建置時間戳存 **`data_version.json`**，不在 `drugs_data.json` 的 `_meta` 裡

改匹配或日期邏輯前**先看 `tests/` 釘住的行為**——那些測試就是規格。

## 測試與 CI

```bash
python -m pytest tests/ -q      # ETL 邏輯（chapters / dates / decode / matching / retry_and_price）
npm test                        # node --test tests/xss.spec.mjs（jsdom 前端 XSS 迴歸）
```

- 兩個 workflow：`Tests`（PR/push 觸發，唯讀）、`Build Drug Database`（排程建資料）
- Actions 一律 pin commit SHA，升級由 Dependabot 開 PR
- 本機可直接跑 `build_data.py`（已加 stdout UTF-8 reconfigure，**不必再設 `PYTHONUTF8`**）

## 搜尋行為的既定決策

- **預設搜尋範圍為「品名」**，非成分。成分檢索結果集顯著較大，預設成分會讓 ACETAMINOPHEN 這類常見成分的複方製劑稀釋掉品名查詢結果
- 成分建議在「品名」範圍下**仍會出現**，作為切換範圍的捷徑；點選後範圍鈕同步變更——**不靜默改動結果集**
- 搜尋索引在資料載入後建立一次，不要改成每次查詢重建

## 樣式

字型 `Noto Sans TC`（僅此一種，無等寬字型）。CSP 的 `style-src` 已允許 `fonts.googleapis.com`、`font-src` 允許 `fonts.gstatic.com`，新增字型來源要同步改 CSP。
