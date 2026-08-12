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
    """單一代號產生的 key 數量須有上限（5/6/7 碼 × 補零/去零）"""
    assert len(nhi_code_to_keys("BC21571100")) <= 6


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
