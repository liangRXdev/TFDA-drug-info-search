# TFDA 藥品資訊查詢系統 (TFDA Drug Info Search)

[![Live Demo](https://img.shields.io/badge/Live%20Demo-Click%20Here-2563eb?style=flat-square)](https://liangrxdev.github.io/TFDA-drug-info-search/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)
[![HTML5](https://img.shields.io/badge/HTML5-E34F26.svg?style=flat-square&logo=html5&logoColor=white)]()
[![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E.svg?style=flat-square&logo=javascript&logoColor=black)]()
[![Python](https://img.shields.io/badge/Python-3.10+-3776ab.svg?style=flat-square&logo=python&logoColor=white)]()
[![GitHub Actions](https://img.shields.io/badge/GitHub%20Actions-2088FF.svg?style=flat-square&logo=github-actions&logoColor=white)]()

## 系統架構結論

本專案為無伺服器 (Serverless) 之純靜態網頁應用程式 (SPA)。核心機制為透過 GitHub Actions 定期觸發 Python 資料處理腳本，自食藥署 (TFDA) 介接原始開放資料，進行預先清洗 (Pre-fetch & Cleansing) 並生成輕量化靜態 JSON 快取檔。此架構徹底解決了直接於前端請求政府 API 所面臨的 CORS 限制、高網路延遲及瀏覽器記憶體溢出 (OOM) 等物理限制，實現毫秒級的客戶端檢索效能。

## 前端介面特色 (Frontend Features)

針對臨床醫療人員與一般民眾的查詢痛點，本專案前端具備以下工程與體驗優勢：

* 🚀 **毫秒級檢索效能 (In-Memory Search)：** 放棄傳統 API 往返查詢。當使用者載入網頁時，輕量化 JSON 已快取至本地，所有中英文模糊搜尋皆在記憶體內瞬間完成，達成「所打即所得」的零延遲體驗。
* 🔎 **品名／成分雙軌搜尋 (Search Scope)：** 除中英文品名外，可切換以**成分**檢索，直接比對原始 `ingredients` 欄位，故 `AMLODIPINE` 亦可命中 `AMLODIPINE (AS BESYLATE)`。此舉可涵蓋品名不含成分字串的商品名（如「脈優」），成分檢索之結果集顯著大於品名檢索。預設維持「品名」範圍，避免如 ACETAMINOPHEN 等常見成分之複方製劑稀釋品名查詢結果。
* 💡 **搜尋建議 (Autosuggest)：** 輸入 2 字以上即時提示，分「成分／品名」兩區並標示成分對應之品項筆數，支援鍵盤上下鍵選取。索引於資料載入後建立一次（成分 3,485 項、品名 42,219 項）。成分建議於「品名」範圍下亦會出現，作為切換範圍之捷徑，點選後範圍鈕同步變更，不靜默改動結果集。
* ⚡ **極輕量化 (Zero Dependencies)：** 捨棄沈重的現代化框架 (如 React/Vue)，採用純 Vanilla JS 與原生 DOM 操作實作。核心渲染引擎極小化，顯著降低首次可互動時間 (Time to Interactive, TTI)。
* 📱 **響應式卡片設計 (Responsive UI)：** 採用 Mobile-first 策略開發，將龐雜的仿單資料轉化為結構化的「藥品資訊卡 (Drug Cards)」。無論於行動裝置或護理站桌機，皆能提供清晰的適應症、成分與用法用量閱讀體驗。
* 🔗 **跨資料集深度整合：** 介面層自動將「藥品許可證」、「原廠仿單連結 (PDF)」與「健保給付規定」等跨部會孤島資料進行視覺化綁定，大幅降低臨床藥師或醫師的資訊檢索成本。

## 客觀數據：系統技術棧與模組

| 模組屬性 | 技術實作 | 功能描述 |
| :--- | :--- | :--- |
| **前端展示層 (Frontend)** | HTML5, Vanilla JavaScript, CSS3 | 採事件驅動，依賴本地/CDN 快取之 `drugs_data.json` 進行記憶體內 (In-memory) 模糊搜尋與 DOM 渲染。 |
| **資料擷取層 (ETL)** | Python 3.x (`build_data.py`) | 負責串接 TFDA 開放資料 API (許可證、仿單等)，執行欄位過濾、合併與結構正規化。 |
| **自動化排程 (CI/CD)** | GitHub Actions | 透過 `.github/workflows` 內的 YAML 定義 Cron Job，定期執行 ETL 腳本並將變更自動 Commit 至儲存庫。 |
| **主機與網路 (Hosting)** | GitHub Pages | 負責靜態檔案派發 (CDN)，提供具備高可用性之 HTTPS 存取端點。 |

## 資料處理流程步驟 (Data Pipeline)

系統資料更新遵循以下自動化流程：
1. **排程觸發 (Trigger)：** GitHub Actions 依設定之 Cron 頻率（例如每月）啟動虛擬環境。
2. **依賴安裝 (Setup)：** 讀取 `requirements.txt` 安裝必要之 Python 模組。
3. **資料拉取 (Fetch)：** `build_data.py` 向 TFDA 伺服器發出 HTTP GET 請求，下載原始大型 JSON 資料集。
4. **資料清洗 (Cleanse)：** 移除前端展示無需之冗餘欄位，將資料體積極小化，並建立以「許可證字號」為關聯鍵之整合結構。
5. **靜態生成 (Build)：** 輸出精簡版之 `drugs_data.json` 覆寫原檔案。
6. **版控推播 (Deploy)：** GitHub Actions 自動將更新後的 JSON 檔 Commit 並 Push 至 Main 分支，觸發 GitHub Pages 更新。

## 本地開發與環境建置步驟

若需於本地環境進行除錯或開發，請依循以下步驟：

### 1. 取得專案原始碼

```bash
git clone https://github.com/liangRXdev/TFDA-drug-info-search.git
cd TFDA-drug-info-search
```

### 2. 資料處理層開發 (Python)

建議使用虛擬環境隔離依賴套件：

```bash
# 建立並啟動虛擬環境 (Windows)
python -m venv venv
venv\Scripts\activate

# 建立並啟動虛擬環境 (macOS/Linux)
python3 -m venv venv
source venv/bin/activate

# 安裝依賴套件
pip install -r requirements.txt

# 執行資料更新腳本，生成最新 drugs_data.json
python build_data.py
```

### 3. 前端展示層開發 (UI)

因現代瀏覽器對於本地 `file://` 協定存在安全性限制（無法執行 `fetch()` 讀取本地 JSON），必須透過本地伺服器啟動：

```bash
# 使用 Python 內建 HTTP 伺服器
python -m http.server 8000
```

完成後，於瀏覽器造訪 `http://localhost:8000` 即可預覽介面與測試搜尋功能。

## 邏輯漏洞與維護注意事項

* **檔案體積監控：** 監控對象應為 **gzip 壓縮後之傳輸量**，而非磁碟上的原始檔案大小——GitHub Pages 預設啟用 gzip，兩者差距約 4.5 倍。截至 2026-07，原始檔 37.7MB、實際傳輸 **8.3MB**。建議以傳輸量 10MB 為警戒線。

  以下為本機實測（8 核 / 16GB，Chrome）之各階段成本，可見**運算並非瓶頸，網路傳輸才是**：

  | 階段 | 耗時 |
  | :--- | ---: |
  | `JSON.parse`（37.7MB） | 102 ms |
  | 建立搜尋索引 | 163 ms |
  | 單次成分搜尋（953 筆命中） | 9 ms |
  | autosuggest 掃描（42K 品名） | 2 ms |

  JS heap 峰值約 138MB（桌機上限 4192MB，無虞）。**低階行動裝置之 heap 上限遠低於此，尚未實測**，若日後回報行動端崩潰，應優先從此處查起。
* **API 端點穩定性：** `build_data.py` 依賴 TFDA 開放資料平台的 URL 結構與 JSON Key 命名。若政府端無預警更動 Schema，將導致 GitHub Actions 構建失敗，需隨時檢視 Action 執行日誌。
* **成分欄僅有英文：** TFDA 原始資料之 `ingredients` 欄位為英文成分名（鹽類寫於括號內，多成分以 `;;` 分隔），**不含中文**。故成分範圍無法以「阿莫西林」等中文檢索（實測回傳 0 筆）。若需支援，須另建中英成分對照表，非前端可自行解決。資料覆蓋率：22,347 筆中 19,852 筆有成分；健保品項 9,962 筆中 9,960 筆有成分。
* **資料快取策略 (SWR)：** `sw.js` 對 `drugs_data.json` 採 stale-while-revalidate——先回快取使畫面立即可用，再於背景以 `If-None-Match` 條件請求確認新版。資料每週更新一次，故未變動時僅回 304（0 bytes），毋須重抓 8.3MB。**若改動此策略，切勿退回 network-first**：那會使每次開啟 App 都重新下載整包資料。取得新版時以綠色橫幅提示使用者重新整理，不自動重載以免中斷查詢中的操作。

  註：Service Worker 於**首次**造訪時是在 `drugs_data.json` 請求發出後才完成註冊，故攔截不到該次請求、亦無從快取。**第 2 次**造訪才由 SW 接手並寫入快取，**第 3 次**起才進入 304 穩態。測試快取行為時若只重載一次會誤判為失效。
* **Service Worker 快取版本：** 修改 `index.html` 後**建議**同步提升 `sw.js` 之 `STATIC_CACHE` 版本號，但理由與直覺相反，以下為實測結果：

  | 情境 | 不升版號 | 升版號 |
  | :--- | :--- | :--- |
  | 線上使用者看到的頁面 | ✅ 新版 | ✅ 新版 |
  | 離線快取中的頁面 | ❌ 仍為舊版 | ✅ 新版 |

  `index.html` 走 **network-first**（見 `sw.js` 末段），故**線上使用者一律取得最新頁面，與版本號無關**——升版號並非新功能生效的前提。真正的作用是刷新**離線副本**：network-first 分支中的 `cache.put` 為 fire-and-forget（未受 `waitUntil` 保護），SW 事件結束即遭丟棄，實測不會更新快取；唯有提升版本號觸發 `install` 的 `addAll` 重新預快取，並由 `activate` 清除舊 cache，離線副本才會更新。因此**不升版號的後果是離線使用者停留在舊介面，而非全體使用者**。

