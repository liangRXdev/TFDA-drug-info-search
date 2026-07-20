"""民國日期解析與 NHI 有效期間判定的單元測試。

對應審查項目：
  C2 — nhi_is_current() 曾把「日期解析失敗」與「欄位空白」同等視為無期限有效，
       導致 NHI 一旦變更日期格式，全部歷史記錄都會被判定為現行有效。
  T1 — 此二函式為核心純函式，歷史上已出過一次解析 bug，優先補測試。
"""
import pytest
from datetime import date

from build_data import parse_roc_date, classify_roc_date, nhi_is_current


def to_roc7(d: date) -> str:
    """date → 7 碼民國日期字串（供邊界測試產生相對於今天的日期）"""
    return f"{d.year - 1911:03d}{d.month:02d}{d.day:02d}"


# ── parse_roc_date ─────────────────────────────────────────────
@pytest.mark.parametrize("raw, expected", [
    # 6 碼（民國 2 位年）
    ("860901",  date(1997, 9, 1)),
    ("991231",  date(2010, 12, 31)),
    ("000101",  date(1911, 1, 1)),
    # 7 碼（民國 3 位年）
    ("1040201", date(2015, 2, 1)),
    ("1150720", date(2026, 7, 20)),
    ("0860901", date(1997, 9, 1)),
    # 哨兵值「永久」
    ("9991231", date(2910, 12, 31)),
    # 閏年
    ("1050229", date(2016, 2, 29)),
])
def test_parse_roc_date_valid(raw, expected):
    assert parse_roc_date(raw) == expected


@pytest.mark.parametrize("raw", [
    None,           # None
    "",             # 空字串
    "   ",          # 純空白
    "12345",        # 5 碼：長度不合
    "12345678",     # 8 碼：長度不合
    "86090",        # 5 碼
    "abcdefg",      # 非數字
    "86-09-01",     # 含分隔符
    "1040229",      # 民國 104 = 2015，非閏年，2/29 不存在
    "1041301",      # 月份 13
    "1040132",      # 日 32
    "1040001",      # 月份 0
    "1040100",      # 日 0
])
def test_parse_roc_date_invalid(raw):
    assert parse_roc_date(raw) is None


def test_parse_roc_date_strips_whitespace():
    assert parse_roc_date("  1040201  ") == date(2015, 2, 1)


# ── classify_roc_date：區分 blank / ok / invalid ────────────────
@pytest.mark.parametrize("raw, status", [
    (None,      'blank'),
    ("",        'blank'),
    ("    ",    'blank'),
    ("1040201", 'ok'),
    ("860901",  'ok'),
    ("abc",     'invalid'),     # 非空但無法解析
    ("12345",   'invalid'),
    ("1040229", 'invalid'),     # 非閏年 2/29
])
def test_classify_roc_date_status(raw, status):
    _, actual = classify_roc_date(raw)
    assert actual == status


def test_classify_roc_date_returns_parsed_value_when_ok():
    d, status = classify_roc_date("1040201")
    assert status == 'ok'
    assert d == date(2015, 2, 1)


@pytest.mark.parametrize("raw", [None, "", "abc", "1040229"])
def test_classify_roc_date_returns_none_when_not_ok(raw):
    d, _ = classify_roc_date(raw)
    assert d is None


# ── nhi_is_current ─────────────────────────────────────────────
TODAY = date(2026, 7, 20)


def test_both_blank_is_current():
    """兩欄皆空 = 資料未填期限，視為現行有效（既有的刻意行為）"""
    assert nhi_is_current("", "", TODAY) == (True, False)


def test_within_period_is_current():
    assert nhi_is_current("1100101", "9991231", TODAY) == (True, False)


def test_expired_is_not_current():
    assert nhi_is_current("1000101", "1141231", TODAY) == (False, False)


def test_not_yet_effective_is_not_current():
    assert nhi_is_current("1160101", "9991231", TODAY) == (False, False)


def test_only_valid_to_in_future_is_current():
    assert nhi_is_current("", "9991231", TODAY) == (True, False)


def test_only_valid_from_in_past_is_current():
    assert nhi_is_current("1000101", "", TODAY) == (True, False)


# ── 邊界：今天正好等於起日／迄日 ───────────────────────────────
def test_today_equals_valid_to_is_still_current():
    """迄日當天仍有效（判定用 e < today 而非 e <= today）"""
    assert nhi_is_current("1000101", to_roc7(TODAY), TODAY) == (True, False)


def test_today_equals_valid_from_is_current():
    """起日當天即生效"""
    assert nhi_is_current(to_roc7(TODAY), "9991231", TODAY) == (True, False)


def test_day_after_valid_to_is_not_current():
    yesterday = date(2026, 7, 19)
    assert nhi_is_current("1000101", to_roc7(yesterday), TODAY) == (False, False)


def test_day_before_valid_from_is_not_current():
    tomorrow = date(2026, 7, 21)
    assert nhi_is_current(to_roc7(tomorrow), "9991231", TODAY) == (False, False)


# ── C2 迴歸：解析失敗絕不可比照空白視為無期限有效 ──────────────
@pytest.mark.parametrize("valid_from, valid_to", [
    ("BAD",     "9991231"),     # 起日格式錯誤
    ("1000101", "BAD"),         # 迄日格式錯誤
    ("BAD",     "BAD"),         # 兩者皆錯
    ("20150201", "9991231"),    # 西元 8 碼：來源改格式的典型徵兆
    ("1000101", "2026-07-20"),  # 帶分隔符
    ("1040229", "9991231"),     # 看似合法實則不存在的日期
])
def test_unparseable_date_is_excluded_and_flagged(valid_from, valid_to):
    is_current, has_invalid = nhi_is_current(valid_from, valid_to, TODAY)
    assert has_invalid is True, "解析失敗必須回報，否則格式變更無法被偵測"
    assert is_current is False, "解析失敗不得被當成現行有效"


def test_blank_is_not_flagged_as_invalid():
    """空白是「本來就沒填」，不該計入格式錯誤統計，避免門檻誤觸發"""
    _, has_invalid = nhi_is_current("", "", TODAY)
    assert has_invalid is False


def test_invalid_date_beats_expiry_check():
    """即使迄日已過期，只要有欄位解析失敗就應以 invalid 回報（優先揭露格式問題）"""
    assert nhi_is_current("BAD", "1141231", TODAY) == (False, True)
