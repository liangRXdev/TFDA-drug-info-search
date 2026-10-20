#!/usr/bin/env python3
"""
美國處方藥仿單參考資料建置 build_us_label.py
==============================================
讀 drugs_data.json 內每個品項的 usLabelKey，對 openFDA /drug/label 的 bulk 全量
計算每個鍵的結果（規則見 us_label.py／docs/plan-us-label.md），輸出 us_label_data.json。

為何用 bulk 而非 API 逐詞查詢（2026-10-20 實測）：
  - 約 2,500 個查詢詞、單詞最大 8 MB（gzip）；受 240 次／分限流，估計超過 20 分鐘時限
  - bulk 14 個檔共約 1.8 GB，每檔附筆數清單，完整性可逐檔核對；不需 API key，
    也沒有「查詢語法召回不到」的問題

失敗契約（全有或全無）：任一檔下載／解析失敗、筆數與清單不符、超過時限、
規則版本不符 → 以非零碼結束，不寫任何檔案，上一版 us_label_data.json 位元不變。
workflow 對本步驟設 continue-on-error，主資料照常發布。
"""
import argparse
import io
import json
import os
import sys
import tempfile
import time
import zipfile
from collections import Counter
from datetime import datetime

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

import requests

from us_label import (
    MATCH_RULES_VERSION,
    RESULT_STATES,
    compute_result,
    index_by_ingredients,
    parse_key,
    validate_result,
)

MANIFEST_URL = "https://api.fda.gov/download.json"
DRUGS_FILE = "drugs_data.json"
OUTPUT_FILE = "us_label_data.json"
VERSION_FILE = "data_version.json"
DEADLINE_SEC = 20 * 60          # 規格 D12：硬性時限；workflow 另設 step timeout 兜底
TIMEOUT_SEC = 300
MAX_RETRIES = 3
RETRY_BASE_SEC = 10
# 只保留計算與呈現需要的欄位，其餘丟棄以壓低記憶體（每檔解析峰值約 1.6 GB）
KEEP_FIELDS = ("set_id", "version", "effective_time", "openfda", "boxed_warning",
               "pregnancy", "teratogenic_effects", "use_in_specific_populations",
               "nursing_mothers")


class Abort(Exception):
    """中止建置：不寫檔、保留上一版。"""


class Deadline:
    def __init__(self, seconds, clock=time.monotonic):
        self.clock = clock
        self.end = clock() + seconds

    def check(self, where):
        if self.clock() > self.end:
            raise Abort(f"超過時限（{where}）")


def load_keys(drugs):
    """drugs_data.json → 去重後的鍵（排序以確保可重現）。"""
    meta = drugs.get("_meta") or {}
    if meta.get("usLabelRulesVersion") != MATCH_RULES_VERSION:
        raise Abort(f"drugs_data.json 的 usLabelRulesVersion={meta.get('usLabelRulesVersion')!r} "
                    f"與 us_label.py 的 {MATCH_RULES_VERSION} 不符")
    keys = sorted({d["usLabelKey"] for d in drugs.get("data") or [] if d.get("usLabelKey")})
    if not keys:
        raise Abort("沒有任何可比對的鍵（分母為 0）")
    return keys


def parse_manifest(manifest):
    try:
        lab = manifest["results"]["drug"]["label"]
        parts = [(p["file"], int(p["records"])) for p in lab["partitions"]]
        total = int(lab["total_records"])
        export_date = str(lab["export_date"])
    except (KeyError, TypeError, ValueError) as e:
        raise Abort(f"download.json 格式不符：{e!r}")
    if not parts or sum(n for _, n in parts) != total:
        raise Abort(f"清單筆數加總 {sum(n for _, n in parts)} ≠ total_records {total}")
    for url, _ in parts:
        if not url.startswith("https://download.open.fda.gov/drug/label/"):
            raise Abort(f"清單含非預期網址：{url}")
    return parts, total, export_date


def slim_rx(results):
    """只留 Rx 且有 openfda 結構化欄位者，並只留需要的欄位。"""
    out = []
    for r in results:
        o = r.get("openfda") or {}
        if "HUMAN PRESCRIPTION DRUG" in (o.get("product_type") or []):
            out.append({k: r[k] for k in KEEP_FIELDS if k in r})
    return out


def read_part(path, expected):
    """解壓並解析一個 bulk 檔；筆數須與清單一致。"""
    try:
        with zipfile.ZipFile(path) as zf:
            names = [n for n in zf.namelist() if n.endswith(".json")]
            if len(names) != 1:
                raise Abort(f"zip 內 JSON 檔數 {len(names)} ≠ 1")
            with zf.open(names[0]) as f:
                data = json.load(io.TextIOWrapper(f, encoding="utf-8"))
    except (zipfile.BadZipFile, json.JSONDecodeError, UnicodeDecodeError, OSError) as e:
        raise Abort(f"無法解析：{type(e).__name__}: {e}")
    results = data.get("results") if isinstance(data, dict) else None
    if not isinstance(results, list) or len(results) != expected:
        got = len(results) if isinstance(results, list) else type(results).__name__
        raise Abort(f"筆數 {got} ≠ 清單 {expected}")
    return slim_rx(results)


def http_get(url, dest=None):
    """GET 並重試暫時性錯誤；4xx（429 除外）不重試。dest 給檔案路徑時串流寫入。"""
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            resp = requests.get(url, timeout=TIMEOUT_SEC, stream=dest is not None,
                                headers={"User-Agent": "TFDA-DrugSearch/1.0"})
            if resp.status_code != 200:
                retryable = resp.status_code == 429 or resp.status_code >= 500
                if not retryable or attempt == MAX_RETRIES:
                    raise Abort(f"HTTP {resp.status_code}：{url}")
                raise requests.HTTPError(f"HTTP {resp.status_code}")
            if dest is None:
                return resp.json()
            written = 0
            with open(dest, "wb") as f:
                for chunk in resp.iter_content(chunk_size=8 * 1024 * 1024):
                    f.write(chunk)
                    written += len(chunk)
            # 中途斷線可能只拿到部分內容卻沒有例外（TFDA API 37 曾實際發生），比對長度後重試
            clen = resp.headers.get("Content-Length")
            if clen and clen.isdigit() and not resp.headers.get("Content-Encoding") \
                    and int(clen) != written:
                raise requests.ConnectionError(f"長度不符：收到 {written:,}／{clen} bytes")
            return dest
        except (requests.RequestException, ValueError) as e:
            if attempt == MAX_RETRIES:
                raise Abort(f"下載失敗（{MAX_RETRIES} 次）：{url}：{type(e).__name__}: {e}")
            wait = RETRY_BASE_SEC * (2 ** (attempt - 1))
            print(f"     ⚠  第 {attempt} 次失敗，{wait} 秒後重試：{type(e).__name__}: {e}")
            time.sleep(wait)


def collect_labels(parts, deadline, fetch_part):
    """依序取得並解析每個 bulk 檔。fetch_part(url) 回傳本機 zip 路徑（可注入以利測試）。"""
    labels = []
    for i, (url, expected) in enumerate(parts, 1):
        deadline.check(f"第 {i}/{len(parts)} 檔開始前")
        t = time.time()
        path = fetch_part(url)
        try:
            rx = read_part(path, expected)
        except Abort as e:
            raise Abort(f"第 {i} 檔 {url.rsplit('/', 1)[-1]}：{e}")
        labels.extend(rx)
        print(f"  ✓  {i}/{len(parts)} {url.rsplit('/', 1)[-1]}：{expected:,} 筆，"
              f"Rx 結構化 {len(rx):,}（{time.time() - t:.1f} 秒）")
    return labels


def build_output(keys, labels, export_date, total):
    idx = index_by_ingredients(labels)
    data = {}
    for k in keys:
        pool = idx.get(parse_key(k)[1], [])
        res = compute_result(k, pool)
        if not validate_result(res):
            raise Abort(f"結果違反資料契約（程式錯誤）：{k} → {res!r}")
        data[k] = res
    counts = Counter(r["s"] for r in data.values())
    meta = {
        "matchRulesVersion": MATCH_RULES_VERSION,
        "openfdaExportDate": export_date,
        "labelsTotal": total,
        "rxStructured": len(labels),
        "keys": len(keys),
        "counts": {s: counts.get(s, 0) for s in sorted(RESULT_STATES)},
    }
    return {"_meta": meta, "data": data}


def write_atomic(path, obj):
    d = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".us_label_", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise


def stamp_version(path):
    """在 data_version.json 記錄仿單資料建置時間（us_label_data.json 本身不含時間戳，
    否則每次建置必然變動，workflow 的「無變動不 commit」會失效）。"""
    try:
        with open(path, encoding="utf-8") as f:
            v = json.load(f)
    except (OSError, json.JSONDecodeError):
        v = {}
    v["usLabelGeneratedAt"] = datetime.now().isoformat()
    with open(path, "w", encoding="utf-8") as f:
        json.dump(v, f, ensure_ascii=False, indent=2)


def summarize(out):
    m = out["_meta"]
    lines = [
        "### 美國處方藥仿單參考",
        f"- openFDA export：{m['openfdaExportDate']}（label 共 {m['labelsTotal']:,}，Rx 結構化 {m['rxStructured']:,}）",
        f"- 鍵：{m['keys']:,}",
    ] + [f"  - {s}：{n:,}" for s, n in m["counts"].items()]
    text = "\n".join(lines)
    print(text)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write(text + "\n")


def run(drugs_path, output_path, version_path, fetch_manifest, fetch_part, deadline):
    with open(drugs_path, encoding="utf-8") as f:
        keys = load_keys(json.load(f))
    print(f"  鍵：{len(keys):,}")
    parts, total, export_date = parse_manifest(fetch_manifest())
    print(f"  openFDA export {export_date}：{len(parts)} 檔，共 {total:,} 筆")
    labels = collect_labels(parts, deadline, fetch_part)
    deadline.check("計算前")
    out = build_output(keys, labels, export_date, total)
    write_atomic(output_path, out)
    stamp_version(version_path)
    summarize(out)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--parts-dir", help="改用本機已下載的 bulk zip（檔名須與清單相同），供本機除錯")
    args = ap.parse_args(argv)

    print("=" * 60)
    print(f"  美國處方藥仿單參考｜{datetime.now():%Y-%m-%d %H:%M:%S}")
    print("=" * 60)
    tmpdir = tempfile.mkdtemp(prefix="us_label_")

    def fetch_part(url):
        name = url.rsplit("/", 1)[-1]
        if args.parts_dir:
            return os.path.join(args.parts_dir, name)
        dest = os.path.join(tmpdir, name)
        http_get(url, dest)
        return dest

    def fetch_part_and_clean(url):
        # 解析完即刪，runner 不需同時存放 1.8 GB
        for old in os.listdir(tmpdir):
            os.remove(os.path.join(tmpdir, old))
        return fetch_part(url)

    try:
        run(DRUGS_FILE, OUTPUT_FILE, VERSION_FILE,
            fetch_manifest=lambda: http_get(MANIFEST_URL),
            fetch_part=fetch_part_and_clean,
            deadline=Deadline(DEADLINE_SEC))
    except Abort as e:
        print(f"\n✗  中止，保留上一版 {OUTPUT_FILE}：{e}", file=sys.stderr)
        return 1
    finally:
        for old in os.listdir(tmpdir):
            os.remove(os.path.join(tmpdir, old))
        os.rmdir(tmpdir)
    print(f"\n✓  已寫入 {OUTPUT_FILE}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
