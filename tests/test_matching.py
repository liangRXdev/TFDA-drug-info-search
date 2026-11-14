"""許可證↔健保代號匹配與成分比對的單元測試。

對應審查項目：
  T2      — fda_lic_to_keys() / nhi_code_to_keys() 是核心匹配邏輯卻無測試
  C3/C18  — 成分比對在任一側抽不出 token 時仍算匹配（刻意的寬鬆設計），
            改以 match_confidence() 標記而非收緊，測試須釘住此行為
  C17     — select_primary_match() 必須是確定性規則
"""
import pytest

from build_data import (
    fda_lic_to_keys,
    nhi_code_to_keys,
    ingredient_core,
    ingredients_match,
    match_confidence,
    select_primary_match,
    price_value,
    detect_field,
)


# ── fda_lic_to_keys ────────────────────────────────────────────
@pytest.mark.parametrize("lic, expected", [
    ("衛署藥輸字第021571號", {"021571", "21571"}),
    ("衛部藥製字第059678號", {"059678", "59678"}),
    ("衛署藥製字第040047號", {"040047", "40047"}),
    ("衛部藥輸字第026976號", {"026976", "26976"}),
])
def test_fda_lic_to_keys_extracts_both_padded_and_stripped(lic, expected):
    assert fda_lic_to_keys(lic) == expected


def test_fda_lic_to_keys_without_leading_zero_returns_single_key():
    assert fda_lic_to_keys("衛署藥輸字第123456號") == {"123456"}


@pytest.mark.parametrize("lic", [
    "",
    "衛署藥輸字第號",       # 無數字
    "沒有號字的字串",
    "021571",              # 缺「第…號」格式
])
def test_fda_lic_to_keys_invalid_returns_empty(lic):
    assert fda_lic_to_keys(lic) == set()


# ── nhi_code_to_keys ───────────────────────────────────────────
def test_nhi_code_to_keys_strips_alpha_prefix():
    """健保代號前導英文字母須剝除後再取數字前綴"""
    keys = nhi_code_to_keys("BC21571100")
    assert "21571" in keys


def test_nhi_code_to_keys_includes_leading_zero_variants():
    keys = nhi_code_to_keys("AC04004710")
    assert "04004" in keys and "4004" in keys


def test_nhi_code_to_keys_accepts_alphanumeric_package_suffix():
    keys = nhi_code_to_keys("KC010892B5")
    assert "01089" in keys and "1089" in keys
    assert fda_lic_to_keys("衛部菌疫輸字第001089號") & keys == {"1089"}


@pytest.mark.parametrize("code", [
    None,
    "",
    "   ",
    "ABCDEF",          # 剝除字母後無數字
    "AC",
])
def test_nhi_code_to_keys_invalid_returns_empty(code):
    assert nhi_code_to_keys(code) == set()


def test_nhi_code_to_keys_rejects_punctuation_in_suffix():
    assert nhi_code_to_keys("KC01089-B5") == set()


def test_nhi_code_to_keys_requires_minimum_length():
    """長度不足 n+2 的前綴不產生 key，避免過短前綴造成大量誤配"""
    assert nhi_code_to_keys("A123") == set()


def test_nhi_code_to_keys_is_bounded():
    """單一代號只產一組鍵（補零／去零），依代號格式決定位數"""
    assert len(nhi_code_to_keys("BC21571100")) <= 2


# ── 跨許可證撞號迴歸（2026-10-22 review，實際錯配案例）──────────
@pytest.mark.parametrize("lic, code", [
    ("衛部罕藥輸字第000104號", "A001046100"),   # EVRYSDI ↔ Magnesium Oxide（5 碼前綴 00104）
    ("衛署藥製字第048992號",   "NC04899238"),   # Kirtolac ↔ Lactated Ringer's（6 碼前綴 048992）
    ("衛署藥製字第001535號",   "N015352212"),   # S.S ANTICOLD ↔ CONTAMIN（5 碼前綴 01535）
    ("衛部藥輸字第028122號",   "NC02812212"),   # PeriOlimel ↔ MELERMIN-H（6 碼前綴 028122）
    ("衛部菌疫輸字第001280號", "A012804100"),   # mRESVIA ↔ SUPITON（5 碼前綴 01280）
])
def test_cross_license_collisions_do_not_match(lic, code):
    assert not (fda_lic_to_keys(lic) & nhi_code_to_keys(code))


@pytest.mark.parametrize("lic, code", [
    ("衛部罕藥輸字第000104號",   "VC00104100"),  # EVRYSDI 正確代號（新制 5 碼）
    ("衛部罕藥製字第000022號",   "X000224138"),  # 罕藥舊制 X 開頭為 5 碼
    ("衛部罕菌疫輸字第000037號", "X000376255"),  # NEXVIAZYME
    ("衛署藥製字第001046號",     "A001046100"),  # 舊制 1 字母＋6 碼
    ("衛部菌疫輸字第001089號",   "KC010892B5"),
])
def test_format_based_keys_keep_true_matches(lic, code):
    assert fda_lic_to_keys(lic) & nhi_code_to_keys(code)


# ── 放射性藥品 R 序列（PR#22 待決 #9）────────────────────────────
# 許可證號碼帶 R（衛部藥輸字第R00091號），原 regex 抽不出數字 → 58 張永遠不會匹配，
# 有健保給付的 Xofigo（BR00091223）被顯示為非健保品項。
XOFIGO_LIC, XOFIGO_CODE = "衛部藥輸字第R00091號", "BR00091223"


def test_radiopharma_license_keys_keep_r_prefix():
    assert fda_lic_to_keys(XOFIGO_LIC) == {"R00091", "R91"}
    assert nhi_code_to_keys(XOFIGO_CODE) == {"R00091", "R91"}


def test_radiopharma_license_matches_its_nhi_code():
    assert fda_lic_to_keys(XOFIGO_LIC) & nhi_code_to_keys(XOFIGO_CODE)
    assert nhi_code_kind_compatible(XOFIGO_CODE, XOFIGO_LIC)


@pytest.mark.parametrize("lic, code", [
    ("衛部藥輸字第000091號", XOFIGO_CODE),    # 同類別的一般號碼 91：類別檢查擋不下，須靠鍵分開
    ("衛部藥輸字第R00091號", "BC00091100"),   # R 序列許可證不配一般序列的代號
    ("衛部藥製字第R00091號", "B000091100"),   # 舊制 6 碼亦同
])
def test_radiopharma_series_does_not_collide_with_plain_numbers(lic, code):
    assert not (fda_lic_to_keys(lic) & nhi_code_to_keys(code))


def test_radiopharma_license_all_zero_number_keeps_padded_key():
    assert fda_lic_to_keys("衛部藥輸字第R00000號") == {"R00000"}


# ── ingredient_core ────────────────────────────────────────────
def test_ingredient_core_extracts_long_tokens():
    assert "AMLODIPINE" in ingredient_core("AMLODIPINE BESYLATE")


def test_ingredient_core_removes_salt_noise():
    """鹽類與劑型字詞屬雜訊，不可用於判定成分相同"""
    assert ingredient_core("AMLODIPINE BESYLATE") == {"AMLODIPINE"}
    assert "BESYLATE" not in ingredient_core("AMLODIPINE BESYLATE")
    assert ingredient_core("METFORMIN HYDROCHLORIDE TABLETS") == {"METFORMIN"}


def test_ingredient_core_is_case_insensitive():
    assert ingredient_core("amlodipine") == ingredient_core("AMLODIPINE")


@pytest.mark.parametrize("raw", ["", None, "維生素", "IRON", "ZINC", "UREA"])
def test_ingredient_core_returns_empty_for_unextractable(raw):
    """C18：中文成分與短於 5 字母的成分名一律抽不出 token。
    這是已知限制，此處釘住現況——修正門檻前須先有此測試作為對照。"""
    assert ingredient_core(raw) == set()


# ── match_confidence（C3 / C18 核心）───────────────────────────
def test_confidence_verified_when_ingredients_intersect():
    assert match_confidence("AMLODIPINE BESYLATE", "AMLODIPINE") == 'verified'


def test_confidence_none_when_both_present_but_disjoint():
    assert match_confidence("AMLODIPINE", "METFORMIN") == 'none'


@pytest.mark.parametrize("fda, nhi", [
    ("",            "AMLODIPINE"),   # TFDA 成分欄位空白
    ("AMLODIPINE",  ""),             # NHI 成分欄位空白
    ("",            ""),             # 雙方皆空
    ("維生素",       "AMLODIPINE"),   # 中文成分抽不出 token
    ("IRON",        "IRON"),         # C18：短成分名雙方都抽不出
])
def test_confidence_code_only_when_either_side_unextractable(fda, nhi):
    assert match_confidence(fda, nhi) == 'code-only'


@pytest.mark.parametrize("fda, nhi", [
    ("", "AMLODIPINE"),
    ("AMLODIPINE", ""),
    ("IRON", "IRON"),
])
def test_code_only_still_counts_as_match(fda, nhi):
    """C3 迴歸：抽不出成分時仍須視為匹配成立。
    收緊成 False 會讓大量品項失去健保歸屬——查不到比誤配更危險。"""
    assert ingredients_match(fda, nhi) is True


def test_disjoint_ingredients_are_not_a_match():
    assert ingredients_match("AMLODIPINE", "METFORMIN") is False


def test_compound_drug_matches_on_any_shared_ingredient():
    """複方藥：任一主成分交集即算匹配（現行刻意行為）"""
    assert match_confidence(
        "AMOXICILLIN;;CLAVULANATE POTASSIUM", "AMOXICILLIN"
    ) == 'verified'


# ── select_primary_match（C17）─────────────────────────────────
def m(code, chapter="", atc=""):
    return {"code": code, "chapter": chapter, "atcCode": atc, "chapterLink": ""}


def test_primary_returns_empty_dict_when_no_matches():
    assert select_primary_match([]) == {}


def test_primary_prefers_record_with_chapter():
    matches = [m("AC001"), m("BC999", chapter="5.1.")]
    assert select_primary_match(matches)["code"] == "BC999"


def test_primary_picks_lowest_code_among_those_with_chapter():
    matches = [m("BC999", chapter="5.1."), m("AC001", chapter="2.6.")]
    assert select_primary_match(matches)["code"] == "AC001"


def test_primary_falls_back_to_lowest_code_when_none_have_chapter():
    matches = [m("BC999"), m("AC001")]
    assert select_primary_match(matches)["code"] == "AC001"


def test_primary_prefers_verified_over_code_only_with_chapter():
    """code-only 可能是撞號錯配，不得以其章節／ATC 頂替 verified 主紀錄"""
    wrong = {**m("A001046100", chapter="7.1.", atc="A02AA02"), "confidence": "code-only"}
    right = {**m("VC00104100", atc="M09AX10"), "confidence": "verified"}
    assert select_primary_match([wrong, right])["code"] == "VC00104100"


def test_primary_among_verified_still_prefers_chapter():
    a = {**m("AC001"), "confidence": "verified"}
    b = {**m("BC002", chapter="1.6.4."), "confidence": "verified"}
    c = {**m("AA000", chapter="9.9."), "confidence": "code-only"}
    assert select_primary_match([a, b, c])["code"] == "BC002"


def test_primary_is_order_independent():
    """C17 迴歸：輸入順序不得影響選擇結果。
    原實作依賴 set 迭代順序，Python 字串 hash 每個 process 隨機化，
    導致同一份輸入在不同次建置產生不同的頂層 nhiChapter/nhiAtcCode。"""
    a, b, c = m("CC003"), m("AC001", chapter="5.1."), m("BC002", chapter="2.6.")
    import itertools
    results = {select_primary_match(list(p))["code"] for p in itertools.permutations([a, b, c])}
    assert results == {"AC001"}, f"選擇結果隨輸入順序改變：{results}"


# ── price_value（T6）───────────────────────────────────────────
@pytest.mark.parametrize("raw, expected", [
    ("12.5",  12.5),
    ("100",   100.0),
    ("0",     0.0),
    ("",      0.0),
    (None,    0.0),
    ("  8.4 ", 8.4),
    ("abc",   0.0),
    ("1,234", 0.0),   # 千分位逗號目前無法解析，釘住現況
])
def test_price_value(raw, expected):
    assert price_value(raw) == expected


# ── detect_field（T6）──────────────────────────────────────────
def test_detect_field_exact_match_wins():
    rows = [{"藥品代號": "X", "藥品代碼": "Y"}]
    assert detect_field(rows, "藥品代號", "藥品代碼") == "藥品代號"


def test_detect_field_falls_back_to_substring():
    rows = [{"健保藥品代號(新)": "X"}]
    assert detect_field(rows, "藥品代號") == "健保藥品代號(新)"


def test_detect_field_respects_pattern_priority():
    """依 patterns 順序決定優先級，非依欄位在 row 中的順序"""
    rows = [{"藥品代碼": "Y", "藥品代號": "X"}]
    assert detect_field(rows, "藥品代號", "藥品代碼") == "藥品代號"


@pytest.mark.parametrize("rows", [[], [{}]])
def test_detect_field_returns_none_when_absent(rows):
    assert detect_field(rows, "藥品代號") is None


def test_detect_field_no_match_returns_none():
    assert detect_field([{"完全無關": 1}], "藥品代號") is None


# ── 健保代號首碼 ↔ 許可證類別（2026-11-05 review）────────────────
# 位數規則只比對「號碼」，不比對類別：藥製／藥輸／內衛藥製／菌疫／罕藥各自從 1 起編號，
# 號碼相同即撞號。以 2026-11-03 drugs_data.json 實測仍有 46 筆類別不符的匹配
# （16 筆被選為頂層主紀錄），且多為 code-only——寬鬆成分比對擋不下。
from build_data import license_kind, nhi_code_kind_compatible  # noqa: E402


@pytest.mark.parametrize("lic, code", [
    ("衛署藥製字第027289號",   "BC27289100"),  # WINSOLVE UREA CREAM ↔ Olumiant（B=藥輸）
    ("衛署藥製字第024437號",   "BC24437100"),  # SODIUM CHLORIDE INJ ↔ Vesicare
    ("衛部菌疫輸字第001085號", "AA01085209"),  # Bavencio ↔ SODIUM CHLORIDE INJ（A=藥製）
    ("衛署藥製字第001085號",   "KC01085229"),  # SODIUM CHLORIDE INJ ↔ Bavencio（K=菌疫輸）
    ("內衛藥製字第011931號",   "AC11931100"),  # BIOMYCIN NASAL SPRAY ↔ PREDNISOLONE TAB（verified）
    ("衛署藥製字第011931號",   "NC11931435"),  # PREDNISOLONE TAB ↔ BIOMYCIN（N=內衛藥製，verified）
    ("衛部藥輸字第028017號",   "AC28017100"),  # 外用 AMMELTZ ↔ DICLOREN E.C. 錠（verified）
    ("衛署成製字第009417號",   "N009417277"),  # 中藥成藥 ↔ LACTATED RINGER'S
    ("衛署罕藥製字第000007號", "VC00007100"),  # ZINCA ↔ AGRYLIN（V=罕藥輸）
    ("衛署菌疫製字第000009號", "W000009100"),  # 抗蛇毒血清 ↔ WILIZIN（W=罕藥製）
])
def test_cross_kind_collisions_are_rejected(lic, code):
    assert fda_lic_to_keys(lic) & nhi_code_to_keys(code), "前提：號碼鍵確實相撞"
    assert not nhi_code_kind_compatible(code, lic)


@pytest.mark.parametrize("lic, code", [
    ("衛署藥製字第001046號",     "A001046100"),
    ("衛部藥製字第059678號",     "AC59678100"),
    ("衛署藥輸字第021571號",     "BC21571100"),
    ("內衛藥製字第004899號",     "NC04899238"),
    ("衛署菌疫製字第000113號",   "JC00113100"),
    ("衛部菌疫輸字第001089號",   "KC010892B5"),
    ("衛部罕藥輸字第000104號",   "VC00104100"),
    ("衛部罕藥製字第000022號",   "WC00022100"),
    ("衛部罕藥製字第000022號",   "X000224138"),   # X：罕藥舊制，涵蓋四種罕藥類別
    ("衛部罕菌疫輸字第000037號", "X000376255"),
    ("衛部罕菌疫輸字第000037號", "YC00037221"),
    ("衛署罕菌疫製字第000001號", "ZC00001100"),
])
def test_same_kind_matches_are_kept(lic, code):
    assert nhi_code_kind_compatible(code, lic)


@pytest.mark.parametrize("lic, code", [
    ("衛署藥製字第001046號", "C001046100"),   # 未知首碼：不據以排除（查不到比誤配更危險）
    ("某種新格式第001046號", "A001046100"),   # 許可證類別抽不出：不據以排除
])
def test_unknown_kind_fails_open(lic, code):
    assert nhi_code_kind_compatible(code, lic)


@pytest.mark.parametrize("lic, kind", [
    ("衛署藥製字第001046號", "藥製"),
    ("衛部藥製字第059678號", "藥製"),
    ("內衛藥製字第004899號", "內衛藥製"),   # 內衛與衛署藥製號碼區間重疊，不可合併
    ("衛部罕菌疫輸字第000037號", "罕菌疫輸"),
    ("衛部藥陸輸字第000123號", "藥陸輸"),
    ("沒有類別", None),
])
def test_license_kind(lic, kind):
    assert license_kind(lic) == kind
