"""
美國處方藥仿單參考（openFDA /drug/label）的比對與呈現規則
================================================================
規格：docs/plan-us-label.md（§6）。本檔只放純函式、不連網：
  - build_data.py      → item_us_label()：每個品項產鍵或給狀態
  - build_us_label.py  → compute_result()：查詢 openFDA 後計算每個鍵的結果
  - tests/             → 釘住以下規則（規格的可執行版本）

刻意與 build_data.py 的 ingredient_core() 分開：那是 TFDA↔健保的寬鬆比對
（查不到比誤配危險），這裡失敗方向相反——把別的藥的警語掛上來比查不到危險。
"""
import re

# §6.1 轉換清單、§6.3 狀態語義、途徑對照表任一變更即須升版（D11）。
# 前端遇到與 drugs_data.json 不一致的版本一律顯示「不可用」。
MATCH_RULES_VERSION = 1

# ── 許可證種類（§6.3 不適用）──────────────────────────────────
# API 37 實測只有這四種（2026-10-20）；值內含全形空白，如「製　劑」
LICENSE_MATCHABLE = {"製劑", "菌疫"}
LICENSE_NOT_APPLICABLE = {"原料藥", "硬空膠囊"}

# ── §6.1 成分轉換 ─────────────────────────────────────────────
# T2a 寫法統一
SPELLING = {"HCL": "HYDROCHLORIDE", "2HCL": "DIHYDROCHLORIDE", "HBR": "HYDROBROMIDE",
            "SULPHATE": "SULFATE", "MICRONISED": "MICRONIZED"}
# T2b 水合物／物理型態
HYDRATE_WORDS = {
    "MONOHYDRATE", "DIHYDRATE", "TRIHYDRATE", "TETRAHYDRATE", "PENTAHYDRATE",
    "HEXAHYDRATE", "HEPTAHYDRATE", "HEMIHYDRATE", "SESQUIHYDRATE", "HYDRATE",
    "ANHYDROUS", "HYDROUS", "MICRONIZED", "H2O",
    "CLATHRATE",   # WARFARIN SODIUM CLATHRATE（Coumadin 的晶型；美方登載為 WARFARIN SODIUM）
}
# T2c 反離子鹽。刻意不含酯類（ACETATE、PHOSPHATE、SUCCINATE、VALERATE、
# PROPIONATE、DECANOATE、PALMITATE…）：CLINDAMYCIN PHOSPHATE、HALOPERIDOL
# DECANOATE 是不同製劑（前驅藥、長效針），不得併入原藥
COUNTER_ION_WORDS = {
    "HYDROCHLORIDE", "DIHYDROCHLORIDE", "HYDROBROMIDE", "SODIUM", "DISODIUM",
    "POTASSIUM", "DIPOTASSIUM", "CALCIUM", "MAGNESIUM", "SULFATE", "BISULFATE",
    "MESYLATE", "DIMESYLATE", "BESYLATE", "MALEATE", "FUMARATE", "HEMIFUMARATE",
    "TARTRATE", "BITARTRATE", "HEMITARTRATE", "CITRATE", "TOSYLATE", "LACTATE", "NITRATE",
    "BROMIDE", "CHLORIDE", "IODIDE", "MALATE", "OXALATE", "XINAFOATE",
    "TROMETHAMINE", "MEGLUMINE", "GLUCONATE",
    # 多字鹽類的前半：RIVASTIGMINE HYDROGEN TARTRATE 剝掉 TARTRATE 後須再剝 HYDROGEN
    "HYDROGEN",
}
STRIP_WORDS = HYDRATE_WORDS | COUNTER_ION_WORDS
# 酯類：不剝除，但 TFDA 常寫在括號內（BETAMETHASONE (AS DIPROPIONATE)），
# 須攤平成尾詞才能與 openFDA 的 BETAMETHASONE DIPROPIONATE 原樣相等
ESTER_WORDS = {
    "ACETATE", "PHOSPHATE", "SUCCINATE", "VALERATE", "PROPIONATE", "DIPROPIONATE",
    "BUTYRATE", "DECANOATE", "PALMITATE", "BENZOATE", "FUROATE", "CYPIONATE",
    "ENANTHATE", "UNDECANOATE", "PIVALATE", "ACETONIDE", "ESTOLATE", "STEARATE",
    "ETHYLSUCCINATE",
}
# 括號內只有這些詞時視為寫法差異，攤平成尾詞：MINOCYCLINE (HCL)、GENTAMICIN (AS SULFATE)
FLATTEN_WORDS = STRIP_WORDS | ESTER_WORDS
# 例外：剝除後若只剩這些（金屬／酸根），代表該詞本身就是有效成分
# （SODIUM CHLORIDE、POTASSIUM CHLORIDE、MAGNESIUM SULFATE），不剝
BARE_REMAINDER = {
    "SODIUM", "POTASSIUM", "CALCIUM", "MAGNESIUM", "ZINC", "IRON", "FERROUS",
    "FERRIC", "LITHIUM", "ALUMINUM", "ALUMINIUM", "COPPER", "CUPRIC", "BARIUM",
    "AMMONIUM", "CHLORIDE", "SULFATE", "BROMIDE", "IODIDE", "CITRATE", "HYDROGEN",
}
_EQ_TO_RE = re.compile(r"\(\s*EQ\.?\s+TO\b[^)]*\)")
_PAREN_RE = re.compile(r"\(\s*([A-Z0-9 ]+?)\s*\)")
_SPACE_RE = re.compile(r"\s+")
# 鍵用 | 與 + 分隔，名稱含這兩個字元會造成鍵碰撞，直接視為無法比對
_KEY_UNSAFE = set("|+")


def norm_ingredient(name):
    """單一成分 → 轉換後名稱；空白或無法處理回 None。雙方（TFDA 與 openFDA）套用同一函式。"""
    s = _SPACE_RE.sub(" ", str(name or "").upper()).strip()
    if not s:
        return None
    # T1：(EQ TO X) 取括號外——FOSPHENYTOIN (EQ TO PHENYTOIN) 仍是 FOSPHENYTOIN
    s = _EQ_TO_RE.sub(" ", s)

    # 括號內只有已知鹽類／水合物／酯類詞（可帶前綴 AS）→ 攤平成尾詞；其他括號原樣保留
    def _flatten(m):
        words = [SPELLING.get(w, w) for w in m.group(1).split()]
        if words[:1] == ["AS"]:
            words = words[1:]
        if words and all(w in FLATTEN_WORDS for w in words):
            return " " + " ".join(words) + " "
        return m.group(0)

    s = _PAREN_RE.sub(_flatten, s)
    words = [SPELLING.get(w, w) for w in _SPACE_RE.sub(" ", s).strip().split(" ")]
    # T2b／T2c 只剝名稱尾端，中段出現的同字不動
    while len(words) > 1 and words[-1] in STRIP_WORDS:
        rest = words[:-1]
        if " ".join(rest) in BARE_REMAINDER:
            break
        words = rest
    out = " ".join(words).strip()
    if not out or _KEY_UNSAFE & set(out):
        return None
    return out


def norm_ingredient_set(names):
    """成分集合（去重、與順序無關）；任一片段無法處理或集合為空 → None。"""
    out = set()
    for n in names:
        v = norm_ingredient(n)
        if v is None:
            return None
        out.add(v)
    return frozenset(out) or None


def split_tfda_ingredients(raw):
    """TFDA 主成分以 ;; 分隔（偶見全形；）。空片段保留，交由 norm_ingredient_set 判為無法比對。"""
    parts = re.split(r"[;；]{1,2}", str(raw or "").strip())
    return parts if any(p.strip() for p in parts) else []


# ── 途徑群組（D5）─────────────────────────────────────────────
ROUTE_GROUPS = {
    "ORAL": {"ORAL"},
    "SUBLINGUAL": {"SUBLINGUAL"},
    # 台灣「注射劑」分不出 IV/IM/SC 等，群組涵蓋全部注射途徑（使用者確認 2026-10-20）
    "INJECTION": {
        "INTRAVENOUS", "INTRAMUSCULAR", "SUBCUTANEOUS", "PARENTERAL", "INTRADERMAL",
        "INTRA-ARTERIAL", "INTRAVASCULAR", "INFILTRATION", "PERINEURAL", "EPIDURAL",
        "INTRACAUDAL", "INTRATHECAL", "INTRA-ARTICULAR", "INTRALESIONAL", "SOFT TISSUE",
        "INTRASYNOVIAL", "SUBARACHNOID", "INTRACAVERNOUS", "INTRACARDIAC",
        "INTRAPERITONEAL", "INTRAPLEURAL", "SUBMUCOSAL", "INTRAOSSEOUS",
    },
    "TOPICAL": {"TOPICAL", "CUTANEOUS"},
    "TRANSDERMAL": {"TRANSDERMAL"},
    "OPHTHALMIC": {"OPHTHALMIC"},
    "NASAL": {"NASAL"},
    "INHALATION": {"RESPIRATORY (INHALATION)"},
    "RECTAL": {"RECTAL"},
    "VAGINAL": {"VAGINAL"},
}

_FORMS_BY_GROUP = {
    "ORAL": [
        "錠劑", "膜衣錠", "膠囊劑", "糖衣錠", "持續性藥效錠", "軟膠囊劑", "腸溶膜衣錠",
        "持續性藥效膠囊劑", "腸溶錠", "咀嚼錠", "口溶錠", "持續性藥效膜衣錠", "腸溶微粒膠囊劑",
        "持續性膜衣錠", "持續性釋放錠", "發泡錠", "腸溶膠囊劑", "腸溶糖衣錠", "持續釋放膜衣錠",
        "內服液劑", "口服液劑", "糖漿劑", "內服顆粒劑", "懸液用顆粒劑", "丸劑", "散劑",
    ],
    "SUBLINGUAL": ["舌下錠"],
    "INJECTION": [
        "注射劑", "凍晶注射劑", "注射液劑", "乾粉注射劑", "凍晶乾燥注射劑", "注射液",
        "滅菌懸液注射劑", "預充填式注射劑", "懸浮注射劑", "凍晶乾粉注射劑",
        "注射用凍晶粉末與注射用液劑", "皮下注射劑", "無菌懸浮注射液", "靜脈點滴注射劑",
        "注射用懸液劑",
    ],
    "TOPICAL": ["乳膏劑", "軟膏劑", "外用液劑", "外用凝膠劑", "藥膠布", "外用噴液劑",
                "洗劑", "洗髮劑", "外用粉劑"],
    "TRANSDERMAL": ["穿皮貼片劑"],
    "OPHTHALMIC": ["點眼液劑", "點眼膏劑", "點眼懸液劑", "眼用液劑", "眼用凝膠劑"],
    "NASAL": ["鼻用噴液劑"],
    "INHALATION": ["口腔吸入劑", "乾粉吸入劑", "吸入用液劑"],
    "RECTAL": ["浣腸劑"],
    "VAGINAL": ["陰道錠"],
}
# 刻意不列（→ ③ 途徑不明）：（粉）、液劑、粉劑、滴劑、顆粒劑、溶液劑、懸液劑、
# 懸液用粉劑、溶液用粉劑、栓劑（直腸／陰道不分）、貼片劑（外用／穿皮不分）、口含錠、
# 口內膏、口腔噴液劑、漱口劑、酊劑、油劑、透析用液劑／粉劑、醫用氣體、硬空膠囊劑
FORM_TO_GROUP = {f: g for g, forms in _FORMS_BY_GROUP.items() for f in forms}


def route_in_group(group, routes):
    """SPL 的 route 是否全數落在群組內。route 缺失／空白／型別錯誤 → None（該鍵不可用）。"""
    if not isinstance(routes, list) or not routes:
        return None
    if not all(isinstance(r, str) and r.strip() for r in routes):
        return None
    allowed = ROUTE_GROUPS[group]
    return all(r.strip() in allowed for r in routes)


# ── 品項 → 鍵或狀態（§6.3）────────────────────────────────────
# 不產鍵的品項只帶這三種狀態值之一；有鍵者不帶狀態
STATUS_NOT_APPLICABLE = "notApplicable"
STATUS_NO_MATCH = "noMatch"
STATUS_UNAVAILABLE = "unavailable"


def make_key(group, ingredients):
    return group + "|" + "+".join(sorted(ingredients))


def parse_key(key):
    group, _, ings = key.partition("|")
    return group, frozenset(ings.split("+"))


def item_us_label(license_type, is_raw, dosage_form, ingredients_raw):
    """回傳 ("key", 鍵) 或 ("status", 狀態值)。"""
    lt = re.sub(r"\s", "", str(license_type or ""))   # 「製　劑」含全形空白
    if is_raw or lt in LICENSE_NOT_APPLICABLE:
        return ("status", STATUS_NOT_APPLICABLE)
    if lt not in LICENSE_MATCHABLE:
        # 缺值或未知種類：不預設當作製劑（規格 A12）
        return ("status", STATUS_UNAVAILABLE)
    group = FORM_TO_GROUP.get(str(dosage_form or "").strip())
    if group is None:
        return ("status", STATUS_NO_MATCH)
    ings = norm_ingredient_set(split_tfda_ingredients(ingredients_raw))
    if ings is None:
        return ("status", STATUS_NO_MATCH)
    return ("key", make_key(group, ings))


def query_term(key):
    """查 openFDA 用的詞：任取集合中一個成分即可（候選必含全部成分，取回後本地再比對）。
    固定取字典序第一個，讓共用此成分的鍵共用同一次查詢。"""
    return sorted(parse_key(key)[1])[0]


# ── openFDA 結果 → 鍵的結果（§6.2–6.4）────────────────────────
RESULT_BW = "bw"            # ① 找到 BW
RESULT_NO_BW = "nobw"       # ② 未找到 BW（不代表沒有，G3）
RESULT_NO_MATCH = "nomatch" # ③ 查無對應
RESULT_UNAVAILABLE = "unavailable"
RESULT_STATES = {RESULT_BW, RESULT_NO_BW, RESULT_NO_MATCH, RESULT_UNAVAILABLE}

RX_PRODUCT_TYPE = "HUMAN PRESCRIPTION DRUG"


def has_content(v):
    """欄位是否有實質內容：須為字串陣列且至少一個元素非空白；缺欄位／錯型別皆視為無。"""
    return (isinstance(v, list)
            and all(isinstance(x, str) for x in v)
            and any(x.strip() for x in v))


def _first(o, field):
    v = o.get(field)
    return v[0] if isinstance(v, list) and v and isinstance(v[0], str) else ""


def _effective(r):
    e = r.get("effective_time")
    return e if isinstance(e, str) and re.fullmatch(r"\d{8}", e) else ""


def _is_innovator(r):
    apps = (r.get("openfda") or {}).get("application_number") or []
    return any(isinstance(a, str) and a.upper().startswith(("NDA", "BLA")) for a in apps)


def select_representative(cands):
    """§6.4 代表仿單：NDA/BLA 優先 → effective_time 最新 → set_id 字典序最小（可重現）。"""
    def rank(r):
        eff = _effective(r)
        return (0 if _is_innovator(r) else 1, -int(eff) if eff else 0, r.get("set_id") or "")
    return min(cands, key=rank)


def source_info(r):
    o = r.get("openfda") or {}
    return {
        "id": r.get("set_id") or "",
        "v": str(r.get("version") or ""),
        "name": _first(o, "brand_name") or _first(o, "generic_name"),
        "mfr": _first(o, "manufacturer_name"),
        "app": _first(o, "application_number"),
        "eff": _effective(r),
    }


# 自 Section 8（use_in_specific_populations）嚴格擷取子章節：起點為「8.n 標題」，
# 終點為之後第一個「8.x 英文標題字」（x≠n）。括號內交叉引用「( 8.3 )」後面不接標題字，
# 自然不會被當成終點。openFDA 對新格式（PLLR）仿單不一定拆出 pregnancy 欄位，
# 也從不拆出 lactation 欄位（2026-10-20 實測 0 筆）。
_SECTION_HEAD_RE = re.compile(r"(?<![(\d.])\b8\.(\d{1,2})\s+[A-Z][A-Za-z]")
_SUBSECTION_START = {
    "1": re.compile(r"\b8\.1\s+Pregnancy\b", re.IGNORECASE),
    "2": re.compile(r"\b8\.2\s+Lactation\b", re.IGNORECASE),
}


def extract_subsection(usp, num):
    """擷取 8.<num> 原文；無明確起訖 → None（不回傳截斷片段）。"""
    if not has_content(usp):
        return None
    text = "\n".join(usp)
    start = _SUBSECTION_START[num].search(text)
    if not start:
        return None
    for m in _SECTION_HEAD_RE.finditer(text, start.end()):
        if m.group(1) != num:
            body = text[start.start():m.start()].strip()
            return body or None
    return None


def extract_lactation(usp):
    return extract_subsection(usp, "2")


def section_pregnancy(r):
    if has_content(r.get("pregnancy")):
        return {"st": "ok", "sec": "pregnancy", "t": r["pregnancy"]}
    body = extract_subsection(r.get("use_in_specific_populations"), "1")
    if body is not None:
        return {"st": "ok", "sec": "8.1 Pregnancy", "t": [body]}
    if has_content(r.get("teratogenic_effects")):
        return {"st": "ok", "sec": "teratogenic_effects", "t": r["teratogenic_effects"]}
    return {"st": "none"}


def section_lactation(r):
    usp = r.get("use_in_specific_populations")
    body = extract_lactation(usp)
    if body is not None:
        return {"st": "ok", "sec": "8.2 Lactation", "t": [body]}
    if has_content(r.get("nursing_mothers")):
        return {"st": "ok", "sec": "nursing_mothers", "t": r["nursing_mothers"]}
    if has_content(usp):
        # 有 Section 8 但切不出明確的 8.2 → 不顯示片段，改指向 DailyMed
        return {"st": "unextractable"}
    return {"st": "none"}


def candidates_for_key(key, results):
    """C：Rx、成分集合完全相等、route 全落在群組內。成分相符者中有 route 缺失 → None（不可用）。"""
    group, target = parse_key(key)
    out = []
    for r in results:
        o = r.get("openfda") or {}
        if RX_PRODUCT_TYPE not in (o.get("product_type") or []):
            continue
        if norm_ingredient_set(o.get("substance_name") or []) != target:
            continue
        ok = route_in_group(group, o.get("route"))
        if ok is None:
            return None
        if ok:
            out.append(r)
    return out


def index_by_ingredients(labels):
    """結構化 Rx label → {成分集合: [label…]}。成分無法處理者不入索引（不可能與任何鍵相等）。"""
    idx = {}
    for r in labels:
        o = r.get("openfda") or {}
        if RX_PRODUCT_TYPE not in (o.get("product_type") or []):
            continue
        ings = norm_ingredient_set(o.get("substance_name") or [])
        if ings is not None:
            idx.setdefault(ings, []).append(r)
    return idx


def ids_unique(results):
    """set_id 須存在且不重複；重複代表資料異常，無法確定 N 與代表仿單（規格 §6.2）。"""
    ids = [r.get("set_id") for r in results]
    return all(isinstance(i, str) and i for i in ids) and len(set(ids)) == len(ids)


def compute_result(key, pool):
    """單一鍵的結果。pool 須涵蓋與此鍵成分相符的全部 label（bulk 全量，完整性由呼叫端以清單筆數核對）。"""
    cands = candidates_for_key(key, pool)
    if cands is not None and not ids_unique(cands):
        return {"s": RESULT_UNAVAILABLE}
    if cands is None:
        return {"s": RESULT_UNAVAILABLE}
    if not cands:
        return {"s": RESULT_NO_MATCH}

    rep = select_representative(cands)
    with_bw = [c for c in cands if has_content(c.get("boxed_warning"))]
    out = {
        "s": RESULT_BW if with_bw else RESULT_NO_BW,
        "n": len(cands),
        "m": len(with_bw),
        "r": source_info(rep),
        "preg": section_pregnancy(rep),
        "lact": section_lactation(rep),
    }
    if with_bw:
        bw_src = rep if has_content(rep.get("boxed_warning")) else select_representative(with_bw)
        out["bw"] = bw_src["boxed_warning"]
        if bw_src is not rep:
            out["b"] = source_info(bw_src)
    return out


def validate_result(res):
    """資料契約不變條件（§6.3）。供 build_us_label.py 寫檔前自檢，與前端／SW 驗證對應。"""
    s = res.get("s") if isinstance(res, dict) else None
    if s not in RESULT_STATES:
        return False
    if s in (RESULT_NO_MATCH, RESULT_UNAVAILABLE):
        return set(res) == {"s"}
    if not (isinstance(res.get("n"), int) and isinstance(res.get("m"), int)
            and isinstance(res.get("r"), dict) and res["r"].get("id")):
        return False
    if s == RESULT_BW:
        return 0 < res["m"] <= res["n"] and has_content(res.get("bw"))
    return res["m"] == 0 and "bw" not in res and "b" not in res
