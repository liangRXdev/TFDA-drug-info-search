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

   **資料檔例外**：`drugs_data.json`、`us_label_data.json` 不進 install 預快取，走 `sw.js` 的 `DATA_FILES`（stale-while-revalidate、每檔各自的驗證函式與 single-flight 鎖）。新增資料檔要加進 `DATA_FILES`，不是 install 清單。

2. **改 `index.html` 或 `app.js` → 升 `sw.js` 的 `STATIC_CACHE` 版本**（目前 `tfda-static-v9`）。三個 cache 各自獨立編號（static / data / fonts），只升動到的那個。
   **清舊快取只刪自家三個家族前綴**（`OWN_PREFIXES`）：`liangrxdev.github.io` 由所有專案頁共用 origin，Cache Storage 不依 SW scope 隔離，`!ALL_CACHES.includes(k)` 會刪光同網域其他工具的快取（2026-09-12 修正）。不要縮成 `'tfda-'`——TFDA-drug-id-quiz 的快取也以它開頭。

3. **CSP 是 `<meta>` 標籤不是 `_headers`**。`script-src 'self'` 意味著**不能寫 inline `<script>` 或 inline event handler**（`onclick=` 等）——JS 一律進 `app.js`。這裡不需要算 hash（那是 pharmacy-portal 的做法）。

## 前端連結白名單

所有外部連結一律經 `safeUrl()`：限 `https` + `fda.gov.tw` / `nhi.gov.tw` 網域後綴，以及 `dailymed.nlm.nih.gov`（美國仿單參考區塊的導覽連結；只放行此完整子網域，不放寬到 `nih.gov`）。**未通過即不渲染**，不留下可點擊的壞連結。新增資料來源網域要同時改 `safeUrl()` 白名單與 CSP。

唯一例外：健保代號表的「健保藥價歷史 → 查看 ↗」（`priceHistoryUrl()`，2026-09-12 Phase 3）。目標是自家站 `https://liangrxdev.github.io/NHI-drug-price-history/?code=`，**前綴寫死**、代號須為 10 碼英數才產生連結——不是上游資料提供的 URL，所以**不要**為它放寬 `safeUrl()` 白名單。

## build_data.py 的刻意設計（勿收緊）

- **成分比對採寬鬆匹配**（空成分視為匹配成立）。收緊會使大量品項失去健保歸屬——**藥師查不到，比偶發誤配更危險**。現況 verified 98% / code-only 2%
- **重複許可證只留首筆**：已實測 3,685 列重複中 **0 列**與首筆有欄位差異，是純重複，無資料損失。不必再驗
- **支付價 `-` 不是髒資料**：975 筆「異常值」全部只有 `-` 一種，是健保署「無支付價」的既定慣例，已列入 `NO_PRICE_MARKERS`（`build_data.py:434`）
- 建置時間戳存 **`data_version.json`**，不在 `drugs_data.json` 的 `_meta` 裡

改匹配或日期邏輯前**先看 `tests/` 釘住的行為**——那些測試就是規格。

## 美國處方藥仿單參考（openFDA）

規格：`docs/plan-us-label.md`（§6 對應規則與狀態、§9 驗收）。`us_label.py` 為純規則，`build_us_label.py` 下載 openFDA **bulk**（不是 API 逐詞查詢——實測會超出時限），workflow 以 `continue-on-error` 執行，失敗時上一版位元不變、主資料照常發布。

- **只做正面陳述（G3）**：openFDA 約三成現行 Rx 仿單缺 `openfda.*` 結構化欄位而比對不到，「未找到 BW」**絕不可**改寫成「無 BW／未列 BW」
- **成分比對是嚴格的**，與健保那套刻意寬鬆的 `ingredient_core()` 方向相反——不要互相沿用。酯類（PHOSPHATE、DECANOATE…）刻意不在剝除清單
- **改轉換清單、狀態語義或途徑對照表 → 升 `MATCH_RULES_VERSION`**，並同步 `app.js` 的 `US_LABEL_RULES_VERSION`（有 pytest 擋）
- **資料契約三處同步**：`us_label.py` `validate_result`／`validate_output`、`app.js` 與 `sw.js` 的 `isValidUsLabelEntry`／`isValidUsLabelData`（SW 不能 import，刻意各寫一份）。改契約先改 `tests/fixtures/us_label_contract.json`，三方都跑同一批反例；`US_LABEL_RULES_VERSION` 在 `app.js`、`sw.js` 各有一份，有 pytest 擋
- **「失敗＝上一版位元不變」有兩層**：`build_us_label.py` 先寫暫存檔、全部成功才替換；workflow 在仿單步驟非 success 時還原檔案（`tests/test_workflow.py` 釘住順序）。不要拿掉任一層
- Section 8 子段擷取：起點只看緊鄰前文（仿單原文常漏打右括號），終點從起點算括號深度。改規則後用真實 bulk 重跑，比對前後差異
- `us_label_data.json` 不含時間戳（否則每次建置都變、「無變動不 commit」失效）；建置時間記在 `data_version.json` 的 `usLabelGeneratedAt`

## 測試與 CI

```bash
python -m pytest tests/ -q      # ETL 邏輯（chapters / dates / decode / matching / retry_and_price / us_label / build_us_label）
npm test                        # node --test：xss.spec.mjs（XSS 迴歸）＋ us_label.spec.mjs（仿單區塊、SW 驗證）
```

- 兩個 workflow：`Tests`（PR/push 觸發，唯讀）、`Build Drug Database`（排程建資料）
- Actions 一律 pin commit SHA，升級由 Dependabot 開 PR
- 本機可直接跑 `build_data.py`（已加 stdout UTF-8 reconfigure，**不必再設 `PYTHONUTF8`**）

## 搜尋行為的既定決策

- **預設搜尋範圍為「品名」**，非成分。成分檢索結果集顯著較大，預設成分會讓 ACETAMINOPHEN 這類常見成分的複方製劑稀釋掉品名查詢結果
- 成分建議在「品名」範圍下**仍會出現**，作為切換範圍的捷徑；點選後範圍鈕同步變更——**不靜默改動結果集**
- 搜尋索引在資料載入後建立一次，不要改成每次查詢重建
- **ATC 範圍**（`docs/plan-atc-search.md`）：開頭相符；ATC 只來自健保資料，非健保品項永遠搜不到（結果上方固定說明，不可拿掉）；健保只登載到上層的代碼**不列入**、只提示（列入即可能誤配同類別別的藥）；「全部」範圍刻意不併入 ATC。結果用分組摘要表呈現，因卡片上限 30 筆

## 樣式

字型 `Noto Sans TC`（僅此一種，無等寬字型）。CSP 的 `style-src` 已允許 `fonts.googleapis.com`、`font-src` 允許 `fonts.gstatic.com`，新增字型來源要同步改 CSP。
