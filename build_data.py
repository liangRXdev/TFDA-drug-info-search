#!/usr/bin/env python3
"""
藥品資料預處理腳本 build_data.py
=================================
從食藥署、健保署 API 下載資料，並從健保署完整給付規定 PDF 解析章節對照表，
合併輸出為精簡 JSON 供前端使用。

格式（經實測）：
  - FDA 37/39/42：ZIP 檔，內含 JSON
  - NHI CSV：UTF-8 BOM 開頭的 CSV
  - NHI PDF：完整給付規定（pdftotext 提取章節對照，作為連結失效時的備援）

判定邏輯：
  - 健保品項 = NHI 有對應代號（不論有無特殊給付規定）
  - 給付規定章節連結 = 直接使用 NHI「藥品代碼超連結」欄位（最權威）
  - 章節對照備援 = 從 PDF 解析「2.6.1.」對應的完整規定文字（連結失效時）
  - 仿單連結 = 優先用食藥署新版 mcp.fda.gov.tw/im_detail_1/{許可證字號}

依賴：pip install requests
系統工具：pdftotext（poppler-utils；GitHub Actions Ubuntu 預裝）
"""

import json, sys, os, re, time, io, csv, zipfile, subprocess, tempfile
from datetime import datetime, date

try:
    import requests
except ImportError:
    print("✗  缺少 requests 套件", file=sys.stderr)
    sys.exit(1)

# ─── 設定 ───────────────────────────────────────────────────────
API_37  = "https://data.fda.gov.tw/data/opendata/export/37/json"
API_39  = "https://data.fda.gov.tw/data/opendata/export/39/json"
API_42  = "https://data.fda.gov.tw/data/opendata/export/42/json"
API_NHI = "https://info.nhi.gov.tw/api/iode0000s01/Dataset?rId=A21030000I-E41001-001"

# 健保署完整給付規定 PDF 來源網頁
NHI_PDF_PAGE = "https://www.nhi.gov.tw/ch/cp-13108-67ddf-2508-1.html"

# 食藥署電子仿單新版查詢 URL（直接帶許可證字號，最穩定）
FDA_PACKAGE_INSERT_URL = "https://mcp.fda.gov.tw/im_detail_1/{license}"

OUTPUT_FILE = "drugs_data.json"
TIMEOUT_SEC = 180

INGREDIENT_NOISE = {
    'BESYLATE','MALEATE','HYDROCHLORIDE','HCL','SULFATE','SULPHATE',
    'SODIUM','CALCIUM','POTASSIUM','MAGNESIUM','PHOSPHATE','CITRATE',
    'TARTRATE','SUCCINATE','FUMARATE','MESYLATE','ACETATE','LACTATE',
    'CHLORIDE','BROMIDE','IODIDE','OXIDE','MONOHYDRATE','DIHYDRATE',
    'TRIHYDRATE','ANHYDROUS','HYDRATE','HYDRATED',
    'TABLET','TABLETS','CAPSULE','CAPSULES','INJECTION','SOLUTION',
    'GRAM','GRAMS','UNIT','UNITS',
}
# ────────────────────────────────────────────────────────────────


def download(url, label, max_retries=3):
    """下載並回傳 bytes。一律驗證 TLS 憑證——本資料供臨床查詢，
    傳輸遭竄改等同污染藥品資料，寧可建置失敗也不得降級。"""
    print(f"  ⬇  下載中：{label}")
    headers = {
        "User-Agent": "Mozilla/5.0 TFDA-DrugSearch/1.0",
        "Accept": "*/*",
    }
    for attempt in range(1, max_retries + 1):
        try:
            start = time.time()
            resp = requests.get(url, timeout=TIMEOUT_SEC,
                                headers=headers, stream=True)
            resp.raise_for_status()
            data = b''.join(resp.iter_content(chunk_size=1024 * 1024))  # 1 MB chunks
            print(f"     ✓  下載完成（{len(data)/1e6:.2f} MB，{time.time()-start:.1f} 秒）")
            return data
        except Exception as e:
            if attempt < max_retries:
                print(f"     ⚠  第 {attempt} 次失敗，5 秒後重試：{e}")
                time.sleep(5)
            else:
                raise


def smart_decode(raw):
    if raw[:2] == b'\xff\xfe':
        return raw.decode('utf-16', errors='replace').lstrip('\ufeff')
    if raw[:2] == b'\xfe\xff':
        return raw.decode('utf-16', errors='replace').lstrip('\ufeff')
    if raw[:3] == b'\xef\xbb\xbf':
        return raw[3:].decode('utf-8', errors='replace')
    for enc in ('utf-8', 'big5', 'cp950'):
        try:
            return raw.decode(enc).lstrip('\ufeff')
        except (UnicodeDecodeError, LookupError):
            continue
    return raw.decode('utf-8', errors='replace').lstrip('\ufeff')


def fetch_fda_json(url, label):
    try:
        raw = download(url, label)
        if raw[:4] != b'PK\x03\x04':
            return json.loads(smart_decode(raw))
        with zipfile.ZipFile(io.BytesIO(raw)) as zf:
            json_names = [n for n in zf.namelist() if n.lower().endswith('.json')] or zf.namelist()
            inner = zf.open(json_names[0]).read()
        print(f"     ℹ  解壓出：{json_names[0]}（{len(inner)/1e6:.1f} MB）")
        result = json.loads(smart_decode(inner))
        print(f"     ✓  解析成功，筆數：{len(result):,}")
        return result
    except Exception as e:
        print(f"     ✗  失敗：{e}", file=sys.stderr)
        return []


def fetch_nhi_csv(url, label):
    try:
        raw = download(url, label)
        text = smart_decode(raw)
        records = list(csv.DictReader(io.StringIO(text)))
        print(f"     ✓  CSV 解析成功，筆數：{len(records):,}")
        return records
    except Exception as e:
        print(f"     ✗  失敗：{e}", file=sys.stderr)
        return []


# ── 解析健保署完整給付規定 PDF（章節對照備援）───────────────────
# 本地 PDF 路徑（放在 repo 根目錄，由維護者定期手動更新）
LOCAL_PDF_PATH = "nhi_payment_rules.pdf"

def fetch_nhi_chapters():
    """
    從本地 PDF 解析健保給付規定章節對照。
    健保署官網會擋爬蟲（403），改由維護者定期手動下載 PDF 放入 repo。
    下載來源：https://www.nhi.gov.tw/ch/cp-13108-67ddf-2508-1.html
    """
    print("\n  📖 解析健保署完整給付規定 PDF...")

    if not os.path.exists(LOCAL_PDF_PATH):
        print(f"     ⚠  找不到本地 PDF（{LOCAL_PDF_PATH}），跳過章節對照")
        print(f"     ℹ  請從健保署下載最新 PDF 並命名為 {LOCAL_PDF_PATH} 放入 repo 根目錄")
        return {}

    print(f"     ℹ  讀取本地 PDF：{LOCAL_PDF_PATH}（{os.path.getsize(LOCAL_PDF_PATH)/1e6:.1f} MB）")

    try:
        txt_path = LOCAL_PDF_PATH.replace(".pdf", "_extracted.txt")
        result = subprocess.run(
            ["pdftotext", "-layout", LOCAL_PDF_PATH, txt_path],
            capture_output=True, timeout=120
        )
        if result.returncode != 0:
            print(f"     ✗  pdftotext 失敗：{result.stderr.decode('utf-8', 'replace')}")
            return {}

        with open(txt_path, "r", encoding="utf-8") as f:
            text = f.read()

        os.unlink(txt_path)
        print(f"     ℹ  提取文字 {len(text):,} 字元")

        chapters = parse_chapters(text)
        print(f"     ✓  解析得 {len(chapters):,} 個章節")
        return chapters

    except Exception as e:
        print(f"     ⚠  PDF 解析失敗：{e}（將使用無對照模式）")
        return {}


def parse_chapters(text: str) -> dict:
    text = re.sub(r'\n\s*\f\s*', '\n', text)
    text = re.sub(r'\n\s*\d{1,4}\s*\n', '\n', text)

    chapter_re = re.compile(r'^(\d{1,2}(?:\.\d{1,3}){1,4}\.?)\s*(.+?)$', re.MULTILINE)
    matches = []
    for m in chapter_re.finditer(text):
        num = m.group(1).rstrip('.')
        parts = num.split('.')
        if not all(p.isdigit() for p in parts):
            continue
        if int(parts[0]) > 20:
            continue
        matches.append((m.start(), num, m.group(2).strip()))

    chapters = {}
    for i, (start, num, title) in enumerate(matches):
        end = matches[i+1][0] if i+1 < len(matches) else len(text)
        content = text[start:end].strip()
        content = re.sub(r'\s*\(\d+\.\d+\.\d+更新\)\s*\n', '\n', content)
        content = re.sub(r'\n{3,}', '\n\n', content)
        chapters[num] = {
            'title': title[:150],
            'content': content[:3000],
        }
    return chapters


def lookup_chapter(chapter_str: str, chapters: dict) -> list:
    if not chapter_str or not chapters:
        return []
    result = []
    seen = set()
    for raw in re.split(r'[,;，；]', chapter_str):
        num = raw.strip().rstrip('.').strip()
        if not num or num in seen:
            continue
        seen.add(num)
        if num in chapters:
            result.append({'chapter': num, **chapters[num]})
            continue
        # 父層退回
        parts = num.split('.')
        for i in range(len(parts), 0, -1):
            parent = '.'.join(parts[:i])
            if parent in chapters:
                result.append({'chapter': num, 'matched': parent, **chapters[parent]})
                break
    return result


# ── 許可證匹配核心 ──────────────────────────────────────────────
def fda_lic_to_keys(license_str):
    m = re.search(r'第(\d+)號', license_str)
    if not m:
        return set()
    n = m.group(1)
    return {n, n.lstrip('0')} - {''}


def nhi_code_to_keys(code):
    if not code:
        return set()
    digits = re.sub(r'^[A-Za-z]+', '', code.strip())
    if not digits.isdigit():
        return set()
    keys = set()
    for n in (5, 6, 7):
        if len(digits) >= n + 2:
            sub = digits[:n]
            keys.add(sub)
            keys.add(sub.lstrip('0'))
    return keys - {''}


def is_raw_material(drug):
    licType = (drug.get('許可證種類') or '').strip()
    usage   = (drug.get('用法用量')   or '').strip()
    return '原料' in licType or '製劑原料' in usage


def ingredient_core(s):
    if not s:
        return set()
    return set(re.findall(r'[A-Z]{5,}', s.upper())) - INGREDIENT_NOISE


def ingredients_match(fda_ingr, nhi_ingr):
    f = ingredient_core(fda_ingr)
    n = ingredient_core(nhi_ingr)
    if not f or not n:
        return True
    return bool(f & n)


def detect_field(rows, *patterns):
    if not rows:
        return None
    keys = [str(k).strip() for k in rows[0].keys()]
    for p in patterns:
        if p in keys:
            return p
    for p in patterns:
        for k in keys:
            if p in k:
                return k
    return None


def parse_roc_date(s):
    """民國日期 YYMMDD(6碼)/YYYMMDD(7碼) 連寫格式 → date；失敗回 None。
    例：860901→1997-09-01、1040201→2015-02-01、9991231→永久(哨兵)"""
    s = (s or "").strip()
    if not s.isdigit():
        return None
    if len(s) == 7:
        y, m, d = int(s[:3]), int(s[3:5]), int(s[5:7])
    elif len(s) == 6:
        y, m, d = int(s[:2]), int(s[2:4]), int(s[4:6])
    else:
        return None
    try:
        return date(y + 1911, m, d)
    except ValueError:
        return None


def price_value(s):
    """支付價字串 → float；無法解析回 0.0"""
    try:
        return float((s or "0").strip() or 0)
    except ValueError:
        return 0.0


# ── 主流程 ──────────────────────────────────────────────────────
def main():
    print("=" * 60)
    print(f"  藥品資料預處理｜{datetime.now():%Y-%m-%d %H:%M:%S}")
    print("=" * 60)

    print("\n【Step 1】下載原始資料...")
    raw37   = fetch_fda_json(API_37,  "未註銷藥品許可證資料集（API 37）")
    raw39   = fetch_fda_json(API_39,  "藥品仿單資料集（API 39）")
    raw42   = fetch_fda_json(API_42,  "藥品外觀圖檔資料集（API 42）")
    raw_nhi = fetch_nhi_csv (API_NHI, "健保用藥品項查詢（NHI CSV）")
    nhi_chapters = fetch_nhi_chapters()

    print(f"\n  筆數 → 37:{len(raw37):,}  39:{len(raw39):,}  42:{len(raw42):,}  NHI:{len(raw_nhi):,}")
    print(f"  健保章節對照：{len(nhi_chapters):,}")
    if not raw37:
        sys.exit("\n⚠  API 37 無資料")
    if not raw_nhi:
        sys.exit("\n⚠  NHI 健保 CSV 無資料（API 可能失效或格式已變更），中止以防止覆蓋正常資料")

    # ── 欄位映射 ────────────────────────────────────────────────
    print("\n  === 自動欄位映射 ===")
    K37_indication = detect_field(raw37, "適應症")
    K37_ingredient = detect_field(raw37, "主成分", "成分")
    K37_usage      = detect_field(raw37, "用法用量", "用法")
    K37_lictype    = detect_field(raw37, "許可證種類")

    K39_lic     = detect_field(raw39, "許可證字號")
    K39_package = detect_field(raw39, "仿單圖檔連結", "仿單檔案連結")
    K39_outer   = detect_field(raw39, "外盒圖檔連結")

    K42_lic   = detect_field(raw42, "許可證字號")
    K42_image = detect_field(raw42, "外觀圖檔連結", "圖檔連結")

    KN_drugcode  = detect_field(raw_nhi, "藥品代號", "藥品代碼", "健保藥品代號", "健保代號")
    KN_chapter   = detect_field(raw_nhi, "給付規定章節", "特殊給付規定章節")
    KN_link      = detect_field(raw_nhi, "給付規定章節連結", "章節連結")
    KN_drugurl   = detect_field(raw_nhi, "藥品代碼超連結", "代碼超連結")
    KN_chname    = detect_field(raw_nhi, "藥品中文名稱", "中文品名", "中文名稱")
    KN_enname    = detect_field(raw_nhi, "藥品英文名稱", "英文品名", "英文名稱")
    KN_ingredient= detect_field(raw_nhi, "成分", "主成分", "藥品成分")
    KN_validto   = detect_field(raw_nhi, "有效迄日", "有效日期", "迄日")
    KN_validfrom = detect_field(raw_nhi, "有效起日", "生效日期", "起日")
    KN_atccode   = detect_field(raw_nhi, "ATC代碼", "ATC")
    KN_price     = detect_field(raw_nhi, "支付價", "健保價")
    print(f"  API 37: 適應症={K37_indication} 成分={K37_ingredient} 用法={K37_usage} 類別={K37_lictype}")
    print(f"  API 39: lic={K39_lic} 仿單={K39_package} 外盒={K39_outer}")
    print(f"  API 42: lic={K42_lic} 圖檔={K42_image}")
    print(f"  NHI: 代號={KN_drugcode} 章節={KN_chapter} 章節連結={KN_link}")
    print(f"       超連結={KN_drugurl} 成分={KN_ingredient} 有效迄日={KN_validto}")
    print(f"       有效起日={KN_validfrom} ATC代碼={KN_atccode} 支付價={KN_price}")

    if not KN_drugcode:
        all_cols = list(raw_nhi[0].keys()) if raw_nhi else []
        print(f"  ⚠  NHI CSV 所有欄位：{all_cols}", file=sys.stderr)
        sys.exit("⚠  找不到 NHI 藥品代號欄位，CSV 格式可能已變更，中止以防止覆蓋正常資料")

    # ── Step 2：建立索引 ────────────────────────────────────────
    print("\n【Step 2】建立索引字典...")

    pkg_dict = {}
    if K39_lic:
        for row in raw39:
            lic = (row.get(K39_lic) or "").strip()
            if not lic:
                continue
            for key in (K39_package, K39_outer):
                if key:
                    link = (row.get(key) or "").strip()
                    if link:
                        pkg_dict.setdefault(lic, []).append(link)

    img_dict = {}
    if K42_lic and K42_image:
        for row in raw42:
            lic = (row.get(K42_lic) or "").strip()
            img = (row.get(K42_image) or "").strip()
            if lic and img:
                img_dict.setdefault(lic, []).append(img)

    # ── 收斂 NHI 多筆歷史：每個藥品代號只保留「現行有效」那筆 ──
    # NHI CSV 對每次支付價調整都留一筆歷史記錄（各有有效起日/迄日），
    # 須挑出涵蓋今日的現行記錄，並排除現行支付價為 0（已停止單獨計價／被新代碼取代）。
    today_date = date.today()

    def nhi_is_current(row):
        e = parse_roc_date(row.get(KN_validto))   if KN_validto   else None
        s = parse_roc_date(row.get(KN_validfrom)) if KN_validfrom else None
        if e and e < today_date:   # 已逾有效迄日
            return False
        if s and s > today_date:   # 尚未生效
            return False
        return True

    by_code = {}
    for row in raw_nhi:
        code = (row.get(KN_drugcode) or "").strip()
        if code:
            by_code.setdefault(code, []).append(row)

    collapsed = []
    drop_expired = drop_zero = 0
    for code, recs in by_code.items():
        current = [r for r in recs if nhi_is_current(r)]
        if not current:
            drop_expired += 1
            continue
        # 多筆現行記錄取有效起日最新者
        current.sort(key=lambda r: parse_roc_date(r.get(KN_validfrom)) or date.min,
                     reverse=True)
        chosen = current[0]
        if price_value(chosen.get(KN_price)) <= 0:   # 現行支付價 0 = 已停用／被取代
            drop_zero += 1
            continue
        collapsed.append(chosen)
    print(f"  NHI 收斂：原始 {len(raw_nhi):,} 筆 → 代號 {len(by_code):,} 種 → "
          f"現行有效 {len(collapsed):,}（剔除已過期 {drop_expired:,}、現行價0 {drop_zero:,}）")

    nhi_index = {}
    nhi_with_chapter = nhi_with_link = 0
    for row in collapsed:
        code = (row.get(KN_drugcode) or "").strip()
        keys = nhi_code_to_keys(code)
        if not keys:
            continue

        chapter = (row.get(KN_chapter)    or "").strip() if KN_chapter    else ""
        link    = (row.get(KN_link)       or "").strip() if KN_link       else ""
        drugurl = (row.get(KN_drugurl)    or "").strip() if KN_drugurl    else ""
        enname  = (row.get(KN_enname)     or "").strip() if KN_enname     else ""
        chname  = (row.get(KN_chname)     or "").strip() if KN_chname     else ""
        ingr    = (row.get(KN_ingredient) or "").strip() if KN_ingredient else ""
        atccode = (row.get(KN_atccode)    or "").strip() if KN_atccode    else ""
        price   = (row.get(KN_price)      or "").strip() if KN_price      else ""

        payload = {
            "nhiChapter":      chapter,
            "nhiChapterLink":  link,        # 給付規定章節連結（PDF）
            "nhiDrugCode":     code,
            "nhiDrugUrl":      drugurl,     # 藥品代碼超連結（健保署該藥詳細頁）
            "nhiEnName":       enname,
            "nhiChName":       chname,
            "nhiIngredient":   ingr,
            "nhiAtcCode":      atccode,
            "nhiPrice":        price,
        }
        if chapter:
            nhi_with_chapter += 1
        if link:
            nhi_with_link += 1
        for k in keys:
            nhi_index.setdefault(k, []).append(payload)

    print(f"  仿單索引：{len(pkg_dict):,}")
    print(f"  圖檔索引：{len(img_dict):,}")
    print(f"  健保索引鍵值：{len(nhi_index):,}（含章節 {nhi_with_chapter:,} | 含章節連結 {nhi_with_link:,}）")

    if len(nhi_index) < 1000:
        sys.exit(f"⚠  健保索引鍵值僅 {len(nhi_index):,}（預期 >1000），NHI 資料異常，中止以防止覆蓋正常資料")

    # ── Step 3：合併 ────────────────────────────────────────────
    print("\n【Step 3】合併資料...")
    output = []
    seen_licenses = set()   # 去重：同一許可證字號只保留第一筆（API 37 有重複資料）
    raw_count = matched_nhi = with_chapter = with_chapter_link = 0
    for drug in raw37:
        lic = (drug.get("許可證字號") or "").strip()
        if not lic or lic in seen_licenses:
            continue
        seen_licenses.add(lic)

        is_raw = is_raw_material(drug)
        if is_raw:
            raw_count += 1

        # 收集所有匹配的 NHI 紀錄（同一許可證可能有多個包裝規格）
        nhi_matches = []
        nhi_primary = {}   # 主要紀錄（用於健保區塊顯示章節）
        if not is_raw:
            fda_ingr = drug.get(K37_ingredient) if K37_ingredient else ""
            seen_codes = set()
            for k in fda_lic_to_keys(lic):
                for c in nhi_index.get(k, []):
                    code = c.get("nhiDrugCode", "")
                    if not code or code in seen_codes:
                        continue
                    if not ingredients_match(fda_ingr, c.get("nhiIngredient", "")):
                        continue
                    seen_codes.add(code)
                    nhi_matches.append({
                        "code":    code,
                        "enName":  c.get("nhiEnName", ""),
                        "chName":  c.get("nhiChName", ""),
                        "chapter": c.get("nhiChapter", ""),
                        "chapterLink": c.get("nhiChapterLink", ""),
                        "drugUrl": c.get("nhiDrugUrl", ""),
                        "atcCode": c.get("nhiAtcCode", ""),
                        "price":   c.get("nhiPrice", ""),
                    })
                    # 主要紀錄：優先取有給付規定的
                    if not nhi_primary or (c.get("nhiChapter") and not nhi_primary.get("nhiChapter")):
                        nhi_primary = c

        is_nhi = len(nhi_matches) > 0
        if is_nhi:
            matched_nhi += 1
        if nhi_primary.get("nhiChapter"):
            with_chapter += 1
        if nhi_primary.get("nhiChapterLink"):
            with_chapter_link += 1

        chapter_details = lookup_chapter(nhi_primary.get("nhiChapter", ""), nhi_chapters)

        # 食藥署新版電子仿單連結（穩定）— 每張許可證都有
        fda_package_url = FDA_PACKAGE_INSERT_URL.format(license=lic)

        output.append({
            "licenseNumber":    lic,
            "licenseType":      (drug.get(K37_lictype)    or "").strip() if K37_lictype    else "",
            "chName":           (drug.get("中文品名")     or "").strip(),
            "enName":           (drug.get("英文品名")     or "").strip(),
            "indication":       (drug.get(K37_indication) or "").strip() if K37_indication else "",
            "ingredients":      (drug.get(K37_ingredient) or "").strip() if K37_ingredient else "",
            "usage":            (drug.get(K37_usage)      or "").strip() if K37_usage      else "",
            "packageLinks":     pkg_dict.get(lic, []),
            "fdaPackageUrl":    fda_package_url,
            "imageLinks":       img_dict.get(lic, []),
            "nhiChapter":       nhi_primary.get("nhiChapter", ""),
            "nhiChapterLink":   nhi_primary.get("nhiChapterLink", ""),
            "nhiAtcCode":       nhi_primary.get("nhiAtcCode", ""),
            "nhiMatches":       nhi_matches,     # 所有匹配的 NHI 品項（含代號、品名、規格、支付價、ATC）
            "chapterDetails":   chapter_details,
            "isRawMaterial":    is_raw,
            "isNhi":            is_nhi,
        })

    print(f"  總筆數：{len(output):,}")
    print(f"  原料藥：{raw_count:,}")
    print(f"  健保品項：{matched_nhi:,}（含特殊規定 {with_chapter:,}，含章節連結 {with_chapter_link:,}）")

    # ── Step 4：輸出 ────────────────────────────────────────────
    print(f"\n【Step 4】寫入 {OUTPUT_FILE}...")
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump({
            "_meta": {
                "generatedAt":    datetime.now().isoformat(),
                "totalRecords":   len(output),
                "nhiRecords":     matched_nhi,
                "withChapter":    with_chapter,
                "rawMaterials":   raw_count,
                "chaptersTotal":  len(nhi_chapters),
            },
            "data": output,
        }, f, ensure_ascii=False, separators=(",", ":"))
    print(f"  ✓  完成（{os.path.getsize(OUTPUT_FILE)/1e6:.2f} MB）")

    # ── Step 5：驗證 ────────────────────────────────────────────
    print("\n【Step 5】驗證範例...")
    for kw in ['NORVASC', 'AMLODIPINE', 'ATORVASTATIN', 'METFORMIN']:
        matches = [d for d in output if kw in (d['enName'] or '').upper()]
        nhi_in  = [d for d in matches if d['isNhi']]
        print(f"\n  🔬 {kw}: 共 {len(matches)} | 健保 {len(nhi_in)}")
        for d in matches[:3]:
            tag      = "💚NHI" if d['isNhi'] else ("⚗原料" if d['isRawMaterial'] else " 一般")
            ch_name  = (d['chName'] or '')[:18]
            lic      = d['licenseNumber']
            print(f"     {tag} {lic} | {ch_name:18}")
            nhi_list = d.get('nhiMatches', [])
            if nhi_list:
                for nm in nhi_list[:5]:
                    chap = (nm.get('chapter') or '-')[:12]
                    en   = (nm.get('enName') or nm.get('chName') or '')[:40]
                    code = nm.get('code', '')
                    print(f"       代號:{code:14} | {en} | ch:{chap}")
            else:
                print("       NHI: 無匹配")

    print("\n" + "=" * 60)
    print("  完成！drugs_data.json 已就緒。")
    print("=" * 60)


if __name__ == "__main__":
    main()