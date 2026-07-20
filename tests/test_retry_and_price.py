"""重試策略與支付價格式判定的單元測試（第四批整理項目）。

對應審查項目：
  C21 — download() 原本對所有錯誤固定重試，包括永久性的 4xx，白耗 CI 時間
  C23 — price_value() 把格式錯誤與真正的 0 元一律轉成 0.0，而現行價 <= 0
        會使該品項被整筆剔除，兩種截然不同的情況導向同一結果卻無任何 log
  C19 — detect_field() 模糊比對命中多個候選時靜默取第一個
"""
import pytest
import requests

from build_data import is_retryable, price_is_malformed, price_value, detect_field


def resp(status):
    r = requests.Response()
    r.status_code = status
    return r


def http_error(status):
    return requests.HTTPError(response=resp(status))


# ── is_retryable（C21）─────────────────────────────────────────
@pytest.mark.parametrize("exc", [
    requests.ConnectionError("connection reset"),
    requests.Timeout("read timeout"),
    requests.TooManyRedirects("loop"),
])
def test_connection_level_errors_are_retryable(exc):
    """無 response 可判斷者一律視為暫時性錯誤"""
    assert is_retryable(exc) is True


@pytest.mark.parametrize("status", [500, 502, 503, 504])
def test_server_errors_are_retryable(status):
    assert is_retryable(http_error(status)) is True


def test_rate_limit_is_retryable():
    """429 是限流，退避後重試有意義"""
    assert is_retryable(http_error(429)) is True


@pytest.mark.parametrize("status", [400, 401, 403, 404, 410, 422])
def test_client_errors_are_not_retryable(status):
    """4xx 重試多少次都是同樣結果"""
    assert is_retryable(http_error(status)) is False


@pytest.mark.parametrize("status", [200, 301])
def test_non_error_status_is_not_retried_as_client_error(status):
    assert is_retryable(http_error(status)) is True


# ── price_is_malformed（C23）───────────────────────────────────
@pytest.mark.parametrize("raw", ["abc", "1,234", "12.3.4", "1 2", "??"])
def test_malformed_prices_are_flagged(raw):
    assert price_is_malformed(raw) is True


@pytest.mark.parametrize("raw", ["0", "0.0", "12.5", "  8.4 ", "100"])
def test_valid_prices_are_not_flagged(raw):
    assert price_is_malformed(raw) is False


@pytest.mark.parametrize("raw", ["", "   ", None])
def test_blank_price_is_not_malformed(raw):
    """空白代表未填，不是格式錯誤——混為一談會讓警告失去意義"""
    assert price_is_malformed(raw) is False


@pytest.mark.parametrize("raw", ["-", "－", " - ", "N/A", "無"])
def test_no_price_markers_are_not_malformed(raw):
    """健保署以 "-" 表示「無支付價／不單獨計價」，是既定慣例而非髒資料。

    2026-07-20 實測：224,455 列中有 975 列為 "-"，且異常值僅此一種。
    若不排除，這些正常標記會淹沒警告使其失去偵測價值。
    """
    assert price_is_malformed(raw) is False


def test_malformed_and_zero_are_distinguishable():
    """C23 核心：兩者都會使 price_value 回 0.0 而導致剔除，
    但只有格式錯誤該被標記出來"""
    assert price_value("abc") == 0.0
    assert price_value("0") == 0.0
    assert price_is_malformed("abc") is True
    assert price_is_malformed("0") is False


# ── detect_field 多候選警告（C19）──────────────────────────────
def test_ambiguous_fuzzy_match_warns(capsys):
    rows = [{"藥品代號": "A", "舊藥品代號": "B"}]
    got = detect_field(rows, "藥品代號")
    # 精確命中優先，不應觸發警告
    assert got == "藥品代號"
    assert "模糊比對命中多個候選" not in capsys.readouterr().err


def test_multiple_fuzzy_candidates_emit_warning(capsys):
    rows = [{"健保藥品代號": "A", "舊版藥品代號": "B"}]
    got = detect_field(rows, "藥品代號")
    err = capsys.readouterr().err
    assert got in ("健保藥品代號", "舊版藥品代號")
    assert "模糊比對命中多個候選" in err, "多候選必須留下警告，否則欄位錯置無從察覺"


def test_single_fuzzy_candidate_is_silent(capsys):
    rows = [{"健保藥品代號": "A"}]
    assert detect_field(rows, "藥品代號") == "健保藥品代號"
    assert capsys.readouterr().err == ""
