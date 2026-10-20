# 規劃：美國處方藥仿單參考區塊（openFDA `/drug/label`）

- 修訂：**v9**（2026-10-20，基準 commit `80e170e`；兩輪 `/codex-checkplan` 審查紀錄在本機 `.ai-review/`（不入版控）；v3→v9 依 Phase 0／Phase 1 實測＋使用者決策＋`/codex-review` 判定 `.ai-review/verdict.md`）
- 狀態：**Phase 0 通過**（§10）；Phase 1 實作完成、`/codex-review` 修正完成、真實資料端到端通過、**人工抽驗通過**（§9 D，2026-10-20）；待合併後的上線驗證（C5、§8.3、首次 runner 建置）

---

## 1. 背景

台灣電子仿單沒有結構化 API；TFDA 電子仿單站（mcp.fda.gov.tw）robots 全禁，並聲明著作權禁止轉載。TFDA API 37 的「用法用量」資訊很少。openFDA `/drug/label` 收錄 FDA 的 SPL 仿單，屬美國聯邦政府公開資料，可以重製與快取。每個 set_id 只收錄現行版本。

## 2. 目標與非目標

### 目標
- G1. 藥師查詢台灣品項時，卡片內附一個「美國處方藥仿單參考」區塊。區塊的定位是：**與本品項同成分、同途徑群組的 openFDA 美國處方藥仿單參考集合**，不宣稱任何一份就是本品項的對應仿單。區塊從這個集合中選出**一份代表仿單**（§6.4），並呈現以下內容：
  - Boxed Warning（BW）原文
  - 懷孕段落原文：新格式欄位 `pregnancy`，舊格式欄位 `teratogenic_effects`
  - 哺乳段落原文：新格式從 `use_in_specific_populations` **嚴格切出 8.2 Lactation**；舊格式取 `nursing_mothers`
  - 代表仿單的 DailyMed 連結，以及「同成分同途徑共 N 份仿單，其中 M 份列有 BW」的統計。劑量等其餘章節請至 DailyMed 查看
- G2. 對應不到、無法確定或資料不完整時，要明確顯示狀態、不顯示內容，並且不能讓使用者誤讀成「沒有警語」。
- G3. **只做正面陳述**（「找到 BW」），**不做否定陳述**（「沒有 BW」）。依據是 Phase 0 實測：約 30–40% 的現行 Rx 仿單在 openFDA 缺少 `openfda.*` 結構化欄位，無法比對（§10）。

### 非目標（本次不做）
- N1. 不顯示劑量（`dosage_and_administration`）。
- N2. 不抽取懷孕字母分級（A/B/C/D/X）。
- N3. 不提供哺乳分級。FDA 沒有這種分級；Hale's 的分級是商業著作。
- N4. 不翻譯、不摘要、不改寫，也不跨來源或跨章節拼接仿單原文。唯一的例外是 8.2 Lactation 的**原文擷取**：只擷取，不改寫。
- N5. 不在前端即時呼叫 openFDA。
- N6. 不處理 OTC 仿單（`HUMAN OTC DRUG`）。
- N7. 不顯示其他章節。
- N8. 原料藥、硬空膠囊不顯示本區塊（API 37 不含中藥許可證，Phase 0 已確認）。
- N9. 不做使用者回報錯配的機制。
- N10. 不做品項級對應（劑型細分、釋放形式、複方比例），也不做 FDA 核准資格篩選。
- N11. 不建立通用的藥名分類器（例如辨識同義名、化學關係）。

## 3. 使用者與情境

- 主要使用者：院內藥師，低頻、單次查詢。
- 最壞假設：本站公開、沒有登入，民眾也可能看到懷孕段落。因此區塊頂端固定顯示以下中文警示（不放在 tooltip 裡）：
  「以下為 openFDA 收錄之**美國處方藥仿單**內容，依成分與給藥途徑比對，**並非本品項的台灣核准資訊**；適應症、劑量與警語可能不同。不可取代醫師或藥師的專業判斷。」

## 4. 專案既有限制（必須相容）

- 零建置靜態站（GitHub Pages），vanilla JS，**零外部依賴**。
- CSP 寫在 `<meta>`：`script-src 'self'`、`connect-src 'self'`，不可有 inline script 或 inline handler。DailyMed 只是導覽連結，**不需改 CSP**。
- 外部連結一律經過 `safeUrl()`；上游文字一律經過 `escapeHtml()`。
- ETL 為 `build_data.py`。workflow `Build Drug Database` 的觸發條件：每週日、`workflow_dispatch`、push main（限 `build_data.py`／PDF）。設定 `timeout-minutes: 40`，沒有 concurrency。commit 判定只看 `drugs_data.json`（`build-data.yml:86`）。
- SW：`drugs_data.json` 走 DATA_CACHE stale-while-revalidate，只有單一全域鎖 `inflightRevalidate`（`sw.js:83`），驗證函式只認主資料形狀（`sw.js:40`）。install 只預快取三個靜態檔。
- 改 `index.html`／`app.js` 必須升 `STATIC_CACHE`；清舊快取只刪 `OWN_PREFIXES`。
- 不沿用既有的寬鬆比對（含 `ingredient_core()`）。
- 測試：pytest ＋ node `--test` jsdom（**沒有 SW 測試環境**）。單人維護，原則是**維持輕量**。

## 5. 架構決策

| # | 決策 | 理由／為何不選另一案 |
|---|---|---|
| D1 | **ETL 預抓**，結果存成同源靜態 JSON。資料來源為 openFDA **bulk 全量下載**（`download.json` 清單，14 個檔、約 1.8 GB），不是 API 逐詞查詢（v7） | 對應邏輯必須能離線驗證、用 `tests/` 釘住。API 逐詞查詢實測約需 2,500 次、單詞最大 8 MB，又受 240 次／分限流，會超過 20 分鐘時限；bulk 版本附逐檔筆數，完整性可核對，也沒有召回問題 |
| D2 | 獨立單一資料檔 `us_label_data.json`，首次展開區塊時 lazy 載入；超過 §8.3 預算才改成靜態分檔 | 避免主資料再膨脹 |
| D3 | 比對單位為「正規化成分集合＋途徑群組」；bulk 中的 Rx 結構化 label 依成分集合建索引，每個鍵直接查索引 | 實測唯一鍵 4,539 個 |
| D4 | （v7）**不需要 API key**：bulk 下載不受 API 配額限制 | 原 D4 隨 D1 改為 bulk 而作廢 |
| D5 | 途徑判定：API 37「劑型」→ 寫死的對照表 → 途徑群組 → 比對 `openfda.route`。`route` 必須**非空且有效**；有多個值時，**每個值都要落在群組內**才納入。成分相符的 SPL 中，只要有一份 route 缺失或無效 → 該鍵**不可用** | 劑型共 224 種、0 空值，前 90 種涵蓋 97.6%。注射劑歸 PARENTERAL 群組。route 缺失不直接排除，因為排除可能漏掉 BW、造成假的 ② |
| D6 | 以下劑型 → ③：對照表外的劑型、劑型缺值，以及語意模糊的劑型（完整清單見 §10 Phase 0 結果；例如 `（粉）`／`液劑`／`粉劑`／`滴劑`／`顆粒劑`／`栓劑`／`貼片劑`） | 寧缺勿錯 |
| D7 | **成分等同性＝原樣完全相等＋封閉轉換清單**（§6.1）。`generic_name` 只用來找候選，不放寬納入標準 | 覆蓋率會降低，但正確性不受影響，也符合輕量原則 |
| D8 | 只納入 `HUMAN PRESCRIPTION DRUG` | |
| D9 | SW 讓 `us_label_data.json` 走 DATA_CACHE stale-while-revalidate，**每個資料檔各有獨立的更新鎖與驗證函式**；不放進 install 預快取 | 現行的單一鎖會讓兩個檔案互相擋住更新 |
| D10 | DailyMed 連結格式 `drugInfo.cfm?setid=<set_id>`；`safeUrl()` 白名單加入 `dailymed.nlm.nih.gov`。只用該來源自己的 set_id，且必須是 UUID 格式。連結標示「DailyMed 目前版本（可能比本站資料新）」 | |
| D11 | 兩個資料檔都帶 `matchRulesVersion`；版本不相容時 → 不可用。§6.1 轉換清單、§6.3 狀態語義、途徑對照表三者任一變更，就要升版；不維護多版本相容矩陣 | |
| D12 | workflow：兩個資料檔**任一內容有變**就 commit，只有時間戳變動不算。`concurrency` 設為排隊、不取消。仿單步驟程式內**硬性時限 17 分鐘**，step timeout 20 分鐘作為兜底；不論以何種原因失敗，**都不阻斷主資料發布**，且 commit 步驟會**還原** us_label_data.json 與 usLabelGeneratedAt（v8） | 「失敗＝上一版位元不變」不能只靠程式自律：step timeout 可能在兩次寫檔之間強制終止（Codex CR3、CR7） |
| D13 | （v6）只呈現**代表仿單**（§6.4），不列出每一份來源，也不合併多份來源的文字；只提供 N、M 統計與 DailyMed 連結 | 實測同一個鍵的 BW 有上百種版本，逐份列出既無法閱讀，資料檔也會遠超出預算 |

## 6. 對應規則

### 6.1 成分等同性

以**原樣完全相等**為基礎（先轉大寫、正規化空白）。在此之上，只允許下列**封閉清單**中的轉換，而且 TFDA 成分與 openFDA `substance_name` **兩邊都套用同一組轉換**：

- **T1**：遇到 `(EQ TO X)` 括號時，**保留括號外的名稱**，整段括號捨棄；保留下來的名稱接著套用 T2。
  - `ACETAMINOPHEN (EQ TO PARACETAMOL)` → `ACETAMINOPHEN`
  - `FOSPHENYTOIN (EQ TO PHENYTOIN)` → `FOSPHENYTOIN`：前驅藥不會被合併成活性物。
- **T2**：去掉**名稱結尾**的鹽類或水合物字尾。
  - 字尾清單為封閉清單（Phase 0 定案，使用者選定「寫法＋水合物＋反離子鹽」三層）：
    - **T2a 寫法統一**：
      - 縮寫與拼法：`HCL`→`HYDROCHLORIDE`、`2HCL`→`DIHYDROCHLORIDE`、`HBR`→`HYDROBROMIDE`、`SULPHATE`→`SULFATE`、`MICRONISED`→`MICRONIZED`。
      - 括號攤平：括號內（可帶前綴 `AS`）只有 T2 清單詞或酯類詞時，攤平成尾詞。例如 `MINOCYCLINE (HCL)`、`GENTAMICIN (AS SULFATE)`、`BETAMETHASONE (AS DIPROPIONATE)`→`BETAMETHASONE DIPROPIONATE`。酯類攤平後仍保留，不會被剝除（v7）。
    - **T2b 水合物與物理型態**：`MONOHYDRATE` `DIHYDRATE` `TRIHYDRATE` `TETRAHYDRATE` `PENTAHYDRATE` `HEXAHYDRATE` `HEPTAHYDRATE` `HEMIHYDRATE` `SESQUIHYDRATE` `HYDRATE` `ANHYDROUS` `HYDROUS` `MICRONIZED` `H2O` `CLATHRATE`（v7）。
    - **T2c 反離子鹽**：`HYDROCHLORIDE` `DIHYDROCHLORIDE` `HYDROBROMIDE` `SODIUM` `DISODIUM` `POTASSIUM` `DIPOTASSIUM` `CALCIUM` `MAGNESIUM` `SULFATE` `BISULFATE` `MESYLATE` `DIMESYLATE` `BESYLATE` `MALEATE` `FUMARATE` `HEMIFUMARATE` `TARTRATE` `BITARTRATE` `HEMITARTRATE`（v7） `CITRATE` `TOSYLATE` `LACTATE` `NITRATE` `BROMIDE` `CHLORIDE` `IODIDE` `MALATE` `OXALATE` `XINAFOATE` `TROMETHAMINE` `MEGLUMINE` `GLUCONATE` `HYDROGEN`（v7；用於多字鹽類，如 `HYDROGEN TARTRATE`）。
    - **刻意不列的酯類字尾**（保留差異）：`ACETATE` `PHOSPHATE` `SUCCINATE` `VALERATE` `PROPIONATE` `DIPROPIONATE` `DECANOATE` `PALMITATE` `BENZOATE` `FUROATE` `CYPIONATE` `ENANTHATE` 等。因此 `CLINDAMYCIN PHOSPHATE`、`HALOPERIDOL DECANOATE`、`METOPROLOL SUCCINATE` 都保留原名。
    - **例外清單**（去除字尾後只剩這些詞時，不去除）：`SODIUM` `POTASSIUM` `CALCIUM` `MAGNESIUM` `ZINC` `IRON` `FERROUS` `FERRIC` `LITHIUM` `ALUMINUM` `ALUMINIUM` `COPPER` `CUPRIC` `BARIUM` `AMMONIUM` `CHLORIDE` `SULFATE` `BROMIDE` `IODIDE` `CITRATE` `HYDROGEN`。
  - 例外：如果去掉字尾後是空字串，或只剩另一個金屬或酸根，就不去除。所以 `SODIUM BICARBONATE`、`MAGNESIUM OXIDE`、`POTASSIUM CHLORIDE` 都保留原名。
- **其他情況一律不轉換**。T1 以外的括號、清單外的修飾詞，都按原樣比對；比對不到就歸 ③。

轉換只會刪掉清單裡的字尾，不可能讓兩個不同的活性物名稱變得相同。例如 ESOMEPRAZOLE／OMEPRAZOLE、ENALAPRIL／ENALAPRILAT 本來就不會互相匹配，這幾組留作反例測試。

其他規則：
- 出現空片段，或成分集合為空 → ③。
- 成分集合用轉換後的名稱去重；比對結果不受排序與分隔符（`;;`）影響。
- 兩邊的成分集合必須**完全相等**。
- Phase 0 驗證後無法召回的轉換，要從清單中移除。

### 6.2 候選集合 C 與完整性

C 是同時符合以下三個條件的 SPL：
1. 屬於 HUMAN PRESCRIPTION DRUG
2. 成分集合完全相等
3. route 全部落在途徑群組內

**完整性是使用 C 的必要前提**（v7：配合 bulk 全量下載改寫）：
1. **整批完整**：`download.json` 的逐檔筆數加總必須等於 `total_records`，而且每個檔解析後的筆數都要等於清單上的筆數；任何一檔不符 → **整批中止**（見 §7 失敗契約）。全量取得之後，原本的「召回涵蓋」問題就不存在了。
2. **鍵層級**：C 中的 `set_id` 必須存在且不重複；有重複 → 該鍵不可用。

### 6.3 五種狀態（狀態語義的**唯一權威定義**；ETL、前端、SW 驗證與各驗收條件都引用本表）

| 狀態 | 條件 | 顯示 |
|---|---|---|
| 不適用 | API 37「許可證種類」為「原料藥」或「硬空膠囊」，或品項為原料藥（`isRawMaterial`）。「製劑」「菌疫」照常比對；許可證種類缺值或為其他值 → 歸「不可用」，不預設當作製劑 | 不顯示區塊 |
| ① 有 BW | C 完整且非空，至少一份 SPL 的 `boxed_warning` 有內容 | 顯示一份 BW 原文，來源依 §6.4 選定，並註明「openFDA 可比對的 N 份參考仿單中，M 份列有 BW」。**N＝C 的唯一來源數，M＝其中有 BW 的份數** |
| ② 未找到 BW | C 完整且非空，**每一份** SPL 的 `boxed_warning` 都缺少或為空 | 「在 openFDA 可比對的 N 份美國處方藥仿單中**未找到** Boxed Warning。openFDA 約三成仿單缺結構化資料、無法比對，**不代表本成分沒有 Boxed Warning**，請至 DailyMed 確認」＋ DailyMed 搜尋連結。**不得**使用「無 BW」「未列 BW」等否定措辭 |
| ③ 查無對應 | C 完整但為空；或劑型不在對照表內；或成分無法比對 | 「查無可對應的美國處方藥仿單」，並附 DailyMed 搜尋連結 |
| 不可用 | 查詢失敗、資料不完整、route 缺失、許可證種類未知、資料檔載入失敗、驗證失敗、`matchRulesVersion` 不相容、主資料裡沒有這個鍵 | 「美國仿單資料暫時無法提供」；**不得**出現任何 BW 結論或章節全文 |

`drugs_data.json` 的每個品項都帶 `usLabelKey` 或明確的狀態值，**不用 null 同時代表多種意思**。

**資料契約（v8，Codex CR1／CR2）**：
- ①② 的 `n ≥ 1`、`0 ≤ m ≤ n`；① 的 `m ≥ 1`。
- 來源物件只允許 `id`／`v`／`name`／`mfr`／`app`／`eff` 這幾個欄位，且值都必須是字串，`id` 不可為空。
- `preg`／`lact` 必須存在且狀態合法，不得有多餘欄位。BW 陣列的每個元素都必須是字串，且至少一個非空白。
- 整份檔案：`_meta.keys` 必須等於實際鍵數，`_meta.counts` 必須等於各狀態的實際計數。
- 三處實作（`us_label.py`、`app.js`、`sw.js`）共用 `tests/fixtures/us_label_contract.json` 的反例。

### 6.4 代表仿單與章節（v6）

**背景**：Phase 1 開工前實測，同一個鍵常有數百份仿單，BW 文字的版本也很多。例如 metformin 有 253 份帶 BW，空白正規化後仍有 106 種文字；懷孕段落有 72 種。依 21 CFR 314.94(a)(8)，ANDA 仿單必須與參考藥一致，所以這些差異多半只是改版的時間差。因此改為「選一份代表仿單」，不再逐份列出，也不再做跨來源一致性比對。

- **代表仿單 R**：從 C 中選出。
  - 優先：`openfda.application_number` 以 `NDA` 或 `BLA` 開頭者，取 `effective_time` 最新的一份。
  - 沒有 NDA/BLA 時：取 `effective_time` 最新的一份。
  - 同日並列時，以 `set_id` 字典序較小者為準，確保結果可重現。
- **BW 來源 B**（僅適用於 ①）：
  - R 有 BW → B＝R。
  - R 沒有 BW、但 C 中有其他仿單有 BW → B 為有 BW 的仿單中，依 R 的同一組規則選出的那一份。畫面標示「代表仿單中未找到 Boxed Warning，以下取自另一份仿單」（v7：措辭與 G3 一致，用「未找到」），並同時列出 B 的來源。
- **懷孕、哺乳只取自 R**，不跨來源比對：
  - **懷孕**（v7）：`pregnancy` 有內容就採用；否則從 `use_in_specific_populations` **嚴格擷取 8.1 Pregnancy**（規則與 8.2 相同）；兩者都沒有時，才採用 `teratogenic_effects`。依據：openFDA 對新格式仿單不一定拆出 `pregnancy` 欄位，實測 warfarin 的代表仿單就是這種情況。
  - **哺乳**：先嘗試從 `use_in_specific_populations` 擷取 8.2，擷取成功就採用；否則若 `nursing_mothers` 有內容，就採用它；兩者都沒有 → 狀態為「未找到」。
  - **8.2 擷取規則**：起點是第一個 `8.2 Lactation`（大小寫不拘），終點是之後第一個「`8.` 加數字、再加空白、再接英文標題字」的位置，例如 `8.3 Females`、`8.4 Pediatric`。**括號內的交叉引用**（例如 `( 8.3 )`、`(see 8.3 Females and Males …)`）不算終點：從起點起算，落在尚未閉合的 `(`／`[` 內的候選一律跳過；本段自身括號不平衡而找不到終點 → 擷取失敗。起點只看緊鄰前文——緊接在 `(`／`[` 之後的不算起點；不累計前文全部的括號深度，因為仿單原文常有漏打的右括號（v8，Codex CR5；實測 pantoprazole 等 4 份）。8.1 Pregnancy 用同一套規則。找不到起點或終點，就是擷取失敗。
  - 擷取失敗、但 R 確實有 `use_in_specific_populations` → 顯示「無法自動擷取，請見 DailyMed」，**不顯示截斷的內容**。
- **BW 的 Highlights 摘要**（v9）：openFDA 把 PLR 仿單的兩個 BW 框接在同一個欄位，前段是完整處方資訊中的全文，後段是 Highlights 摘要，以「WARNING: X See full prescribing information for complete boxed warning」開頭。以下條件**全部成立**時，只顯示前段：摘要句只出現一次、往前 300 字內找得到 WARNING 標題、該標題也出現在前段、前段至少 80 字。任一條件不成立就保留原文。實測 bulk 中 12,085 份帶 BW 的仿單，6,517 份符合；本站 ① 的 443 個鍵中，273 個切除（都已驗證是舊文字的開頭片段，且切掉的都是摘要），29 個保留原文。
- **原文**指欄位的完整陣列，多個元素依原順序全部保留；擷取 8.2 時只截取區間，不做任何改寫。
- 無內容的認定：缺欄位、空陣列、只有空白、型別錯誤，都視為無內容。
- 每個章節的狀態有三種：「有內容」、「未找到」、「無法擷取」（只有哺乳會出現）。其中「未找到」的文案是「代表仿單中未找到此段落」，依 G3，不做否定陳述。
- 畫面要標示 R 的品名、`application_number`、生效日，以及「同成分同途徑另有 N−1 份仿單，內容可能因改版時間而略有差異，請見 DailyMed」。

## 7. 資料流與失敗行為

```
API 37 → build_data.py 既有流程 → drugs_data.json（每個品項加上 usLabelKey 或狀態）
仿單步驟 build_us_label.py（程式內硬性時限 17 分鐘）：
  1. 讀 drugs_data.json 的 usLabelKey，去重（規則版本不符、0 個鍵 → 中止）
  2. 取 openFDA download.json 清單並核對筆數
  3. 逐檔下載 bulk zip（失敗會重試並退避、核對 Content-Length）→ 解析 → 核對筆數 → 只保留 Rx 結構化 label 與所需欄位 → 刪除暫存檔
  4. 依成分集合建索引，依 §6 計算每個鍵的結果，並以 validate_result、validate_output 自我檢查
  5. 寫入前再檢查一次時限；us_label_data.json（不含時間戳，可重現）與 data_version.json（加上 usLabelGeneratedAt）**先全部寫成暫存檔，都成功後才依序替換**，仿單檔先換
  6. 在 job summary 寫入鍵統計與**品項統計**（不可用超過 5% 時加註停止上線）；整批中止時也要寫入中止原因（v8，Codex CR6）
```

- `_meta`：`matchRulesVersion`、`openfdaExportDate`、`labelsTotal`、`rxStructured`、鍵數、各狀態計數。**不放建置時間**，否則每次建置都會產生 diff；建置時間記在 data_version.json 的 `usLabelGeneratedAt`。
- 每個鍵的結果包含：
  - 狀態、N、M
  - R 的來源資訊（`set_id`、`version`、品名、`application_number`、`effective_time`）
  - B 的來源資訊，只在 B≠R 時才有
  - BW 原文
  - 兩個章節的狀態與原文
  - DailyMed 連結
- 三種日期分開標示：SPL 生效日、openFDA 資料更新日、本站建置日。
- 統計分兩種：**鍵統計**只計算有產鍵的；**品項統計**涵蓋全部品項。本批的執行統計（含失敗率）寫進 workflow log 與 job summary；回退時不改動舊檔。

### 失敗契約（v7：全有或全無）
- 以下任一情況 → 步驟以非零碼結束，**不寫入任何檔案**，上一版 us_label_data.json 與 data_version.json 都位元不變：
  - 清單格式不符、筆數加總不符、出現非預期網址
  - 任一檔下載失敗（暫時性錯誤重試 3 次後仍失敗；4xx 除 429 外不重試）、長度不符、zip 損毀、筆數不符
  - 超過 17 分鐘時限（下載逾時與重試也受剩餘時間限制）
  - 寫檔失敗
  - 規則版本不符
  - 鍵數為 0
  - 結果違反資料契約（程式錯誤）
- 首次建置就失敗 → 不產生仿單檔，前端一律顯示「不可用」。
- workflow 對本步驟設 `continue-on-error`，**主資料照常發布**。本步驟只要不是 success（包含被 step timeout 強制終止），commit 步驟會**在加入 commit 之前**還原 us_label_data.json（首次建置則刪除），並把 data_version.json 的 usLabelGeneratedAt 改回 HEAD 的值，同時輸出 `::warning::`（v8）。
- job summary 寫入失敗只記警告，不影響已完成的發布。
- 原本以「每個鍵的查詢失敗率 5%」作為門檻的規則，改為 bulk 後已不適用，予以刪除。

## 8. 前端

### 8.1 呈現
- 卡片內放一個摺疊區塊，首次展開時才 fetch 資料。頂端固定顯示 §3 的警示。
- 英文原文經 `escapeHtml()` 後保留換行顯示，每一段都標明 SPL 章節名與來源。
- 改 `index.html`／`app.js` → 升 `STATIC_CACHE`。

### 8.2 併發與重入
- 資料檔同一時間只抓一次（single-flight），每張卡片只渲染自己那個鍵的結果。
- 載入失敗可以重試，失敗的結果不會被快取成成功。
- 沒有 SW 時也能正常運作。

### 8.3 大小預算（使用者已確認 2026-10-20；原則：維持輕量）
- **關卡**：gzip 傳輸 ≤ 3 MB；首次展開到渲染完成 ≤ 3 秒。量測條件固定為 Chrome DevTools「Fast 4G」、CPU 降速 4×、冷快取。
- **只記錄、不設關卡**：未壓縮大小、最大單鍵大小、峰值記憶體。
- 超過預算時，改成同源靜態分檔；**不可**用刪減候選或截斷原文來達標。

## 9. 驗收條件

證據層：〔E〕ETL pytest（原始 fixture → 輸出 JSON）；〔F〕前端 jsdom（JSON → DOM）；〔S〕SW 驗證函式在 node 中隔離測試；〔W〕workflow 靜態檢查；〔M〕人工。

### A. 對應正確性〔E〕
- **A1** Warfarin 錠 → ①，BW 與 fixture 逐字相同，來源正確。
  - 移除唯一的 BW → 變成 ②。
  - 加入一份成分不符、但有 BW 的 SPL → 結果不變。
- **A2** Amlodipine besylate 錠：
  - 匹配到的候選都沒有 BW → ②。DOM 文案必須含「未找到」與「不代表本成分沒有」，**不得**含「無 Boxed Warning」「未列 Boxed Warning」。
  - 加入一份不同途徑、有 BW 的 SPL → 仍是 ②。
  - 加入一份同途徑、有 BW 的 SPL → 變成 ①。
  - 有 BW 的 SPL 只出現在第 2 頁 → ①。
  - 第 2 頁抓取失敗 → 不可用，不得是 ②。
  - 有 BW 的 SPL 以鹽類名稱登錄，只有另一種查詢寫法查得到 → 仍要納入，結果為 ①。
  - 有重複的 set_id 把筆數湊滿 total，實際上漏了另一份 → 不可用。
- **A3** Diclofenac：
  - 口服錠 → ①。
  - 外用凝膠 → 依 fixture 中的外用 SPL，結果必須等於明列的預期狀態，而且來源集合不含任何口服 SPL。
- **A4** Isotretinoin 膠囊 → ①，懷孕段落與 fixture 逐字相同，並帶章節名與來源。
  - 新格式、舊格式各一例。
  - 章節為多元素陣列時，要依原順序顯示全部元素；只顯示第一個元素不合格。
  - 新格式為空、舊格式有內容 → 顯示舊格式。
  - **代表仿單選擇**（§6.4）：
    - 同時有 NDA 與較新的 ANDA → R 為 NDA。
    - 有兩份 NDA → R 為生效日較新者。
    - 沒有 NDA → R 為生效日最新的 ANDA。
    - 生效日相同 → 依 `set_id` 決定。
    - 候選順序打亂後，結果不變。
  - **哺乳 8.2 擷取**：
    - 正常的 `8.2 Lactation … 8.3 Females …` → 擷取結果與 fixture 逐字相同。
    - 文中含 `( 8.3 )` 交叉引用 → 不得在該處截斷。
    - 只有 `8.2`、沒有終點 → 無法擷取，不顯示任何片段。
    - 沒有 `use_in_specific_populations`、但有 `nursing_mothers` → 採用 `nursing_mothers`。
    - 兩者都沒有 → 未找到。
- **A5** 10 成分台灣複方：
  - 找不到完全相符的候選 → ③。
  - fixture 提供完全相符的候選 → 依該候選判為 ① 或 ②。
- **A6** 成分集合比對：
  - 台灣 {A,B}，fixture 只有 A 單方 → ③。
  - 台灣 A，fixture 只有 {A,B} 複方 → ③。
  - {A,B} 對 {B,A} → 匹配。
  - {A, 比對不到的 X} → ③。
  - `A;;A`、`A ;; B` 這類寫法，等同去重並排序後的集合。
- **A7** 劑型為 `（粉）`／`液劑`／`粉劑`／`滴劑`／`顆粒劑` 或未知劑型 → ③。控制組：同一個品項只把劑型改成「錠劑」→ 結果必須跟著改變。
- **A8** 成分等同性（§6.1）：
  - T2 清單**每一項**都有正例（例如 `AMLODIPINE BESYLATE`↔`AMLODIPINE`），而且 openFDA 那一側寫成鹽類形式時也要能匹配。
  - T1 正例：`ACETAMINOPHEN (EQ TO PARACETAMOL)`↔`ACETAMINOPHEN`。
  - T1 反例：`FOSPHENYTOIN (EQ TO PHENYTOIN)` 不得匹配 `PHENYTOIN`。
  - T2 例外反例：`SODIUM BICARBONATE`、`MAGNESIUM OXIDE`、`POTASSIUM CHLORIDE` 保留原名。
  - 不可匹配的反例組：`ESOMEPRAZOLE`/`OMEPRAZOLE`、`LEVOFLOXACIN`/`OFLOXACIN`、`METHYLPREDNISOLONE`/`PREDNISOLONE`、`ENALAPRIL`/`ENALAPRILAT`。
  - 字尾詞出現在名稱中段時不得刪除；清單外的修飾詞、T1 以外的括號也不得刪除。
- **A9** 兩份內容不同的 BW，加一份沒有 BW 的 SPL → ①，**N＝3、M＝2**。
  - R 有 BW → 顯示 R 的 BW。
  - R（NDA）沒有 BW、兩份 ANDA 有 → 顯示 B 的 BW，B 依 §6.4 規則選出，並帶「代表仿單中未找到 Boxed Warning，以下取自另一份仿單」的標示與 B 的來源資訊。
  - 結果不受候選順序影響。
- **A10** 懷孕、哺乳都只取自 R：其他候選的段落即使不同，也不影響輸出。R 缺少某段落、其他候選有 → 該段落為「未找到」，**不得**改取其他候選的內容。
- **A11** 台灣「注射劑」：
  - IV 與 IM 的候選都要納入。
  - ORAL、TOPICAL、OPHTHALMIC、未知途徑一律不納入。
  - route 同時含 INTRAVENOUS 與 ORAL 的 SPL → 不納入。
  - 成分相符的 SPL 中有一份 route 缺欄位、為空陣列或空白 → 該鍵不可用。
- **A12** 原料藥、硬空膠囊：依原始 API 37 欄位判定為「不適用」，即使成分可匹配也不產鍵；「菌疫」照常比對。
  - 控制組：成分相同的一般西藥要顯示區塊。
  - 「許可證種類」缺值或未知 → 不可用。
- **A13** 同成分、同途徑的 OTC SPL 有 BW，處方藥 SPL 沒有 → ②。
- **A14** `warnings_and_cautions` 有內容、但 `boxed_warning` 為空 → ②；輸出中不得出現 `warnings_and_cautions` 的文字。

### B. 失敗路徑
- **B1**〔E〕（v7）以下任一情況 → 整批中止，舊檔位元不變：清單筆數加總不符、某檔筆數不符、zip 損毀、清單出現非預期網址、清單格式錯誤。
- **B2**〔E〕下載：
  - 5xx 重試至上限後中止。
  - 4xx 不重試。
  - 長度不符（中途斷線）要重試。
- **B3**〔E〕以下任一情況 → 中止且舊檔位元不變，data_version.json 也不變：超過時限、規則版本不符、鍵數為 0。首次建置失敗時不產生檔案。成功時輸出可重現，連續兩次建置的結果位元相同，且不含時間戳。（v8）另外驗證：寫入前超時、暫存檔寫入失敗、兩次替換之間失敗，都要中止且不留暫存檔；summary 寫入失敗不影響發布；summary 要含品項統計與中止原因。
- **B4**〔F〕前端遇到以下情況，都要顯示「暫時無法提供」：資料檔 404、非 JSON、型別錯誤、狀態值不合法、缺少該鍵、`matchRulesVersion` 不相容。
  - DOM 中不得出現 BW 原文、「未找到 Boxed Warning」或章節全文。
  - 控制組：合法資料要正確顯示。
  - 失敗後重試成功 → 正確顯示。
  - 兩張不同鍵的卡片同時展開，或回應期間切換搜尋 → 每張卡片只顯示自己的鍵。
- **B5**〔S〕仿單檔驗證函式：
  - 拒絕：HTML 的 200 回應；狀態與內容矛盾（例如標 ② 卻帶有 BW）；缺少來源。
  - 接受：合法資料。
  - 主資料驗證函式的行為不變。
- **B6**〔W〕workflow 靜態檢查：
  - commit 判定包含 `us_label_data.json`。
  - 只有時間戳變動時不 commit。
  - `concurrency` 設為排隊、不取消。
  - 仿單步驟失敗不影響後續的發布步驟。
  - 〔M〕實際跑一次「只有仿單內容變動」的建置，確認有發布。

### C. 安全與既有關卡
- **C1**〔F〕在 BW、懷孕、哺乳、品名、來源標籤中分別注入 `<script>`、`<img onerror>`、`javascript:` → 以純文字保留，不是被刪掉；DOM 中沒有可執行的節點、事件屬性或危險 URL。
- **C2**〔F〕合法 UUID → 產生正確的 DailyMed 連結，且使用該來源自己的 set_id；非 UUID → 不產生連結。
- **C3**〔F〕`safeUrl()`：
  - 真實的 DailyMed HTTPS 網址 → 通過。
  - 以下全部拒絕：`dailymed.nlm.nih.gov.evil.com`、`evildailymed.nlm.nih.gov`、`https://dailymed.nlm.nih.gov@evil.com`、http 開頭的網址。
  - 原有的 TFDA／NHI 正例仍然通過。
- **C4**〔W〕`STATIC_CACHE` 已升版；`OWN_PREFIXES` 未改；install 清單沒有加入資料檔；CSP 未改；沒有 inline handler。
- **C5**〔M〕人工瀏覽器快取清單：
  1. 首次造訪、沒有快取時可以載入。
  2. 部署有效的新檔 → 快取被替換。
  3. 部署無效的新檔（HTML 錯誤頁）→ 保留舊快取。
  4. 主資料與仿單檔分別更新時，互不抑制。
  5. 離線重新整理 → 已載入過的仿單資料仍可用。
  6. 同網域其他工具的快取仍在。

### D. 人工抽驗〔M〕
- **D1** 準備一張 15 筆的核對表：
  - 事先固定 15 筆品項，每筆的鍵不得重複；預期結果要涵蓋 ① 與 ②。
  - 外用／口服同成分、注射劑、鹽類差異、名稱相近，這四類各至少 1 筆。
  - 逐筆記錄成分、途徑、BW、兩個章節、日期與判定依據。
  - ① 與 ② 必須 **0 筆錯配**；出現非預期的 ③ 也要逐筆裁決，不可從分母剔除。
- **D2** 用 DailyMed 當獨立來源做比對：
  - 判為 ② 的品項：在 DailyMed 以「成分＋途徑＋ Boxed Warning」條件檢索處方藥，記錄是否查得到 BW。**預期有可能查得到**，這正是 ② 不做否定陳述的原因。這一項只用來確認 ② 的警示文案有必要，不作為錯配判定。
  - 判為 ① 的品項：DailyMed 上有 BW 的處方仿單中，至少一份出現在本站的來源清單裡。
- **D3** 鍵統計與品項統計各自記錄，總數要對得上。出現以下任一情況就停止上線、交由人工裁決（以 job summary 的本批統計為準）：
  - 全部都是 ③。
  - ① 加 ② 為 0。
  - 不可用超過 5%。
- **統計限制**：這 15 筆是刻意挑選的，不是隨機樣本，不能拿來推論全庫的錯配率。D 組用來抓系統性錯誤，低頻錯配靠 A 組。

## 10. 動工順序

### Phase 0 結果（2026-10-20，進行中）
- **F1**：openFDA 共有 262,897 份 label，其中 68% 缺少 `openfda.*` 欄位。
  - 以 DailyMed（doctype=34391-3）為基準，6 個參考成分（warfarin、amlodipine、diclofenac、olanzapine、metformin、isotretinoin）的現行 Rx 仿單中，約 30–40% 在 openFDA 沒有結構化欄位。
  - 抽樣 25 份，全部是 DailyMed 上的現行版本。
  - 推論：依成分／途徑比對，召回率先天只有約六成，**否定結論不成立**。
- **F2**：同一份 SPL、同一版本，DailyMed 的 `boxed_warning` 篩選和 openFDA 的 `boxed_warning` 欄位結果不一致時，全部都是「DailyMed 判定無、openFDA 判定有」。
  - 件數：metformin 41、diclofenac 5、isotretinoin 3、warfarin 1；反方向為 0。
  - 推論：openFDA 欄位對 BW 較敏感，① 的正面判定以 openFDA 為準可以接受。
- **使用者決策**：拿掉 ② 的否定結論（G3），架構不變，仍只用 openFDA。
  - 不採用「DailyMed 混合補召回」：違反輕量原則。
  - 不採用「全文防護並保留 ②」：屬啟發式判斷，而且 ② 幾乎不可能成立。
- **召回關卡的通過條件改為**：在 openFDA 有結構化欄位的範圍內，查詢能涵蓋每一種允許的轉換。
- **召回關卡：通過**（使用者確認 2026-10-20）
  - **查詢方式**：`openfda.product_type:"HUMAN PRESCRIPTION DRUG" AND openfda.substance_name:"<轉換後成分>"`（片語查詢），取回後再於本地依 §6.1 轉換，比對集合是否相等。`generic_name` 不用於查詢。
  - **參考集**：15 個，包含 AMLODIPINE、WARFARIN、DICLOFENAC、METFORMIN、ISOTRETINOIN、OLANZAPINE、MINOCYCLINE、NAPROXEN、ESOMEPRAZOLE、CLINDAMYCIN、CLINDAMYCIN PHOSPHATE、HALOPERIDOL DECANOATE、LEVOTHYROXINE、LISINOPRIL+HYDROCHLOROTHIAZIDE、ACETAMINOPHEN+OXYCODONE。
  - **驗證結果**：
    - 全部 PASS：分頁全數取完，0 份重複。
    - 與 `generic_name` 查詢交叉比對，遺漏 0 份。
    - 每頁 50 筆的多頁取回測試（metformin，8 頁）：361/361。
  - **候選規模**：結構化 Rx 中，單一成分最多 562 份（OXYGEN），沒有超過 1,000 份的成分。
  - **TFDA 覆蓋**：
    - 可產鍵 18,056 筆（81.2%）。
    - 原料藥 12.8%。
    - ③（劑型不在對照表）6.0%。
    - 唯一鍵 4,610 個，其中單方 2,306 個。
  - **API 37「許可證種類」實際值**：製劑 20,947、原料藥 3,065、菌疫 1,906、硬空膠囊 29，**不含中藥**，因此修訂 N8 與 §6.3「不適用」的判定。
- **劑型 → 途徑群組對照表**（使用者確認）：
  - **ORAL**：錠劑、膜衣錠、膠囊劑、糖衣錠、持續性藥效錠、軟膠囊劑、腸溶膜衣錠、持續性藥效膠囊劑、腸溶錠、咀嚼錠、口溶錠、持續性藥效膜衣錠、腸溶微粒膠囊劑、持續性膜衣錠、持續性釋放錠、發泡錠、腸溶膠囊劑、腸溶糖衣錠、持續釋放膜衣錠、內服液劑、口服液劑、糖漿劑、內服顆粒劑、懸液用顆粒劑、丸劑、散劑
  - **SUBLINGUAL**：舌下錠
  - **INJECTION**：注射劑、凍晶注射劑、注射液劑、乾粉注射劑、凍晶乾燥注射劑、注射液、滅菌懸液注射劑、預充填式注射劑、懸浮注射劑、凍晶乾粉注射劑、注射用凍晶粉末與注射用液劑、皮下注射劑、無菌懸浮注射液、靜脈點滴注射劑、注射用懸液劑
    - 對應 openFDA route：INTRAVENOUS、INTRAMUSCULAR、SUBCUTANEOUS、PARENTERAL、INTRADERMAL、INTRA-ARTERIAL、INTRAVASCULAR、INFILTRATION、PERINEURAL、EPIDURAL、INTRACAUDAL、INTRATHECAL、INTRA-ARTICULAR、INTRALESIONAL、SOFT TISSUE、INTRASYNOVIAL、SUBARACHNOID、INTRACAVERNOUS、INTRACARDIAC、INTRAPERITONEAL、INTRAPLEURAL、SUBMUCOSAL、INTRAOSSEOUS
  - **TOPICAL**（含 TOPICAL、CUTANEOUS）：乳膏劑、軟膏劑、外用液劑、外用凝膠劑、藥膠布、外用噴液劑、洗劑、洗髮劑、外用粉劑
  - **TRANSDERMAL**：穿皮貼片劑
  - **OPHTHALMIC**：點眼液劑、點眼膏劑、點眼懸液劑、眼用液劑、眼用凝膠劑
  - **NASAL**：鼻用噴液劑
  - **INHALATION**（對應 RESPIRATORY (INHALATION)）：口腔吸入劑、乾粉吸入劑、吸入用液劑
  - **RECTAL**：浣腸劑
  - **VAGINAL**：陰道錠
  - **→ ③（途徑不明）**：（粉）、液劑、粉劑、滴劑、顆粒劑、溶液劑、懸液劑、懸液用粉劑、溶液用粉劑、栓劑（直腸或陰道不分）、貼片劑（外用或穿皮不分）、口含錠、口內膏、口腔噴液劑、漱口劑、酊劑、油劑、透析用液劑、透析用粉劑、醫用氣體、硬空膠囊劑，以及其他未列劑型

### Phase 0 — 召回關卡（**通過之前，不寫比對邏輯與前端程式**）
1. 定案劑型對照表，以及 §6.1 T2 字尾清單的完整列舉。
2. 準備參考集，涵蓋：單方、複方、鹽類形式、`EQ TO` 形式、候選超過 1,000 份的成分。同一份參考集分別用 openFDA 與 DailyMed 取得候選，再互相比對。
3. **通過條件**：§6.1 每一種允許的轉換，都能完整召回參考集裡的 SPL。
4. **未通過時**：移除該轉換（相關品項落入 ③），或改用涵蓋得到的查詢寫法；**不可以帶著已知的召回缺口繼續**。
5. 結果回報使用者確認後，才進入 Phase 1。

### Phase 1 — 實作
ETL → 資料檔 → 前端 → SW → workflow，依 §9 驗收。

### 人工驗收結果（2026-10-20）
- **D1**：使用者逐筆比對 15 筆（鹽類差異、注射劑、外用／口服同成分、名稱相近四類各至少 1 筆），對照 DailyMed 網頁上的代表仿單。**15 筆全部通過，① 與 ② 皆 0 筆錯配。**
- **D2**（程式以 DailyMed v2 API 獨立核對）：
  - 判為 ① 的 10 筆：DailyMed 上都查得到同成分、帶 BW 的處方仿單。
  - 判為 ② 的 5 筆：DailyMed 標為帶 BW 的仿單，全部是複方、不同劑型，或是空白的 BW 章節（omeprazole 有 2 份 2009–10 年的分裝商仿單屬此情形）。沒有漏抓。
  - 15 份代表仿單的版本號，都與 DailyMed 目前版本一致。
- **驗收過程中發現並修正**：openFDA 把 BW 的 Highlights 摘要接在完整 BW 之後，畫面上同一段警語出現兩次（v9）。
- **D3**：停止上線條件均未觸發。
- **上線後驗證**（2026-10-20，正式站）：
  - **第一次 runner 建置**：成功。仿單步驟含下載 1.8 GB **共 57 秒**；job summary 為 ① 443、② 696、③ 3,384 鍵，與本機一致。失敗還原（jq）尚未實際觸發過。
  - **§8.3 首次展開**：**判定通過**（使用者同意）。在正式站實測後換算：傳輸 1,013,533 bytes（gzip）；CPU 部分為解析 37 ms、驗證 20 ms、渲染 144 ms。換算到 Fast 4G（9 Mbps、往返延遲保守計 150 ms）加 CPU 4× 後，**一般情況約 2.4 秒**。剛部署後第一個請求（CDN 冷啟動、TTFB 1.27 秒）約 3.3 秒，略超。擴充工具無法設定節流，所以是實測後換算，不是直接在節流下量測。
  - **C5 快取**：
    - SW v9 啟用後，舊 `tfda-static-v8` 已清除，**同網域其他 12 個工具的快取全部保留**；展開後仿單資料有寫入快取。
    - **離線 F5 失敗**：使用者實測發現。原因是頁面網址（目錄）與預快取鍵（`index.html`）不同，SW 改版後目錄網址的快取就消失。此為既有缺陷，由 `fix(sw)`（PR #17）修正；修正後關閉本機伺服器模擬離線，重新整理可以開啟頁面並載入資料。

### Phase 1 結果（2026-10-20）
- **自動測試**：pytest 412 個、node 109 個，全數通過。
- **真實資料端到端**（openFDA export 2026-10-16，label 262,897 筆，Rx 結構化 35,645 筆）：
  - 唯一鍵 4,539 個：① 443、② 696、③ 3,384、不可用 0。
  - 品項分布：① 3,668、② 4,412、③（產鍵後查無對應）9,956、劑型或成分無法比對 1,321、不適用 2,886、不可用 4（許可證種類未知）。
  - 大小：**gzip 1.01 MB**（預算 3 MB），未壓縮 4.67 MB，最大單鍵 19 KB。
  - 建置耗時：本機約 40–75 秒（不含下載）。
- **③ 偏高的原因**：多數是預期中的排除——美國屬 OTC（acetaminophen、dextromethorphan、外用 terbinafine 等，依 N6 排除），或美國未核准（benzbromarone、domperidone、gliclazide 等）。
- **實測找出並已修正的系統性漏配**：
  - TFDA「(AS 鹽類／酯類)」括號寫法（493 個品項），例如 gentamicin 注射劑
  - CLATHRATE（warfarin）、HEMITARTRATE（zolpidem）、2HCL（metoclopramide）、HYDROGEN TARTRATE
  - 懷孕 8.1 未拆成獨立欄位（warfarin）
  - 前三類藥物美國仿單都有 BW，修正前全數漏掉。
- **抽查**：warfarin（出血）、zolpidem（複雜睡眠行為）、metoclopramide（遲發性運動障礙）、gentamicin（耳／腎毒性）、metformin、olanzapine、isotretinoin、口服與外用 diclofenac、ketorolac 注射劑，BW 都已正確出現；amlodipine、rivastigmine 為 ②。
- **畫面驗證**：桌面與 390px 寬度都已檢視，沒有水平捲動。
  - 🇺🇸 在 Windows 上顯示成「us」，已改用 🌐。
  - 手機版已縮小區塊內距。

## 11. 後續版本（不在本次範圍）

- 使用者回報錯配
- 劑量段落
- 品項級對應
- BW 全文相同時去重

## 修訂紀錄

| 版本 | 變更 | 依據 |
|---|---|---|
| v2 | 定位改為參考集合、逐份來源呈現；新增 N10 | verdict #2、#21 |
| v2 | ② 改為「未列 BW」；完整性列為必要前提 | #1、#8 |
| v2 | 警示文案改為「openFDA 收錄之美國處方藥仿單」 | #7 |
| v2 | 成分等同性規則、懷孕／哺乳的狀態、五種狀態契約 | #3、#4、#5、#19、#22 |
| v2 | 失敗契約、`matchRulesVersion`、workflow 發布、SW 每檔一把鎖、來源版本、大小預算 | #6、#9–#13、#23 |
| v2 | 驗收條件全面改寫；刪除 rule of three 推論 | #14–#18 |
| v3 | §6.1 改為原樣比對＋封閉轉換（T1 保留括號外名稱、T2 結尾字尾＋例外），兩邊都套用；新增 N11 | R1、R12 |
| v3 | §6.2 完整性分兩層：召回涵蓋、取回完整（以唯一 set_id 計數） | R4、R5 |
| v3 | D5 route 必須非空；只要有一份缺失 → 不可用 | R3 |
| v3 | D12 仿單步驟 20 分鐘時限，任何失敗都不阻斷主資料發布；concurrency 改為排隊 | R6 |
| v3 | D13 去重改為選配；N、M 依來源份數計算 | R14 |
| v3 | §6.3 列為唯一權威定義；許可證種類未知 → 不可用 | R15、R8 |
| v3 | §6.4 原文為完整陣列；新格式有內容才採用；判定結果收斂為三種；刪除與前文矛盾的句子 | R2、R13 |
| v3 | §7 鍵統計與品項統計分開；本批統計寫進 job summary；明訂 `matchRulesVersion` 的觸發範圍 | R7、R11、R16 |
| v3 | §8.3 固定量測條件，只保留兩個關卡指標 | R16 |
| v3 | §9 補上各條反例；新增 C5；D1＋D2 合併並改以 DailyMed 作獨立來源 | R8–R11、R15 |
| v3 | §10 新增 Phase 0 召回關卡 | R4 |
| v4 | 新增 G3（只做正面陳述）；② 改為「未找到 BW（不代表沒有）」；章節的「全部未提供」同步修改措辭；A2、B4、D2 跟著調整；§10 記錄 Phase 0 結果 F1、F2 | Phase 0 實測＋使用者決策 |
| v5 | T2 封閉清單定案（寫法＋水合物＋反離子鹽，酯類保留）；劑型→途徑對照表定案；召回關卡通過；修訂 N8、§6.3「不適用」、A12（API 37 不含中藥） | Phase 0 實測＋使用者確認 |
| v6 | §6.4 改為「代表仿單」：NDA/BLA 優先、生效日最新；BW 來源規則；懷孕／哺乳只取自 R，取消跨來源一致性比對；哺乳改為嚴格擷取 8.2（openFDA 沒有 `lactation` 欄位），失敗時改放連結；D13 由逐份清單改為代表仿單；A4、A9、A10 跟進 | Phase 1 開工前實測（metformin 106 種 BW 版本、無 `lactation` 欄位）＋使用者決策 |
| v7 | 資料來源改為 openFDA bulk 全量（D1、D3、D4、§6.2、§7、B1–B3）；失敗契約改為全有或全無；懷孕段落新增 8.1 擷取；BW 來源提示改用「未找到」措辭；T2 清單依真實資料補上（AS 括號、酯類攤平、CLATHRATE、HEMITARTRATE、2HCL、HYDROGEN）；記錄 Phase 1 結果 | Phase 1 實測＋使用者決策（bulk） |
| v8 | `/codex-review` 修正：資料契約補強並以三方共用反例驗證（§6.3）；8.1／8.2 擷取的括號規則（§6.4）；寫檔順序、workflow 失敗還原、17 分鐘時限、summary 品項統計（D12、§7、B3）。真實資料重跑後，與修正前輸出 0 鍵差異 | `.ai-review/verdict.md` |
| v9 | §6.4 BW 去除後段 Highlights 摘要（結構明確才切，否則保留原文）；起因是人工驗收時發現 BW 重複出現 | 使用者決策（a） |
