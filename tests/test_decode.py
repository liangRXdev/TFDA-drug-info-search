"""位元組解碼與資料判定的單元測試。

對應審查項目：
  T5 — smart_decode() 無編碼測試。Big5/CP950 與 UTF-16 BOM 是台灣政府開放資料
       的常見地雷，且此函式最終的 fallback 帶 errors='replace'——解碼錯誤
       不會拋例外，只會靜默產生亂碼，正是最需要測試釘住的形狀。
"""
import pytest

from build_data import smart_decode, is_raw_material


TEXT = "藥品代號,中文品名\nBC21571100,脈優錠５毫克\n"


def test_decodes_plain_utf8():
    assert smart_decode(TEXT.encode("utf-8")) == TEXT


def test_strips_utf8_bom():
    """NHI CSV 實測為 UTF-8 BOM 開頭，BOM 必須剝除否則第一個欄位名會多出 \\ufeff"""
    decoded = smart_decode(b"\xef\xbb\xbf" + TEXT.encode("utf-8"))
    assert decoded == TEXT
    assert not decoded.startswith("﻿")


def test_decodes_utf16_le_with_bom():
    raw = b"\xff\xfe" + TEXT.encode("utf-16-le")
    decoded = smart_decode(raw)
    assert "脈優錠" in decoded
    assert not decoded.startswith("﻿")


def test_decodes_utf16_be_with_bom():
    raw = b"\xfe\xff" + TEXT.encode("utf-16-be")
    decoded = smart_decode(raw)
    assert "脈優錠" in decoded
    assert not decoded.startswith("﻿")


def test_decodes_big5():
    """Big5 無 BOM，須靠 utf-8 解碼失敗後的 fallback 鏈接手"""
    raw = "健保用藥品項".encode("big5")
    assert smart_decode(raw) == "健保用藥品項"


def test_empty_input():
    assert smart_decode(b"") == ""


def test_invalid_bytes_do_not_raise():
    """最終 fallback 帶 errors='replace'，不得拋例外（釘住此刻意行為）"""
    result = smart_decode(b"\xff\xfe\x00\x01\x02invalid")
    assert isinstance(result, str)


def test_utf8_is_preferred_over_big5():
    """同一串位元組可能同時是合法 Big5，須優先採 utf-8 避免誤判成亂碼"""
    assert smart_decode("脈優錠".encode("utf-8")) == "脈優錠"


# ── is_raw_material ────────────────────────────────────────────
def test_detects_raw_material_by_license_type():
    assert is_raw_material({"許可證種類": "原料藥"}) is True


def test_detects_raw_material_by_usage_text():
    assert is_raw_material({"許可證種類": "製劑", "用法用量": "本品為製劑原料"}) is True


def test_normal_drug_is_not_raw_material():
    assert is_raw_material({"許可證種類": "製劑", "用法用量": "每日一次，每次一錠"}) is False


@pytest.mark.parametrize("drug", [
    {},
    {"許可證種類": None, "用法用量": None},
    {"許可證種類": "", "用法用量": ""},
])
def test_missing_fields_do_not_raise(drug):
    assert is_raw_material(drug) is False
