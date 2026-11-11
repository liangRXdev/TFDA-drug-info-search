"""與上一版相比的相對降幅守門（2026-11-09，PR #22 #6）。

上游回 200 但資料被截斷（例如 API 37 只回一半）時，既有守門只有「空」與「< 1000」
這類絕對下限擋不住。main() 須在寫檔前比對上一版 data_version.json，降幅 >10% 即中止。
"""
import json

import pytest

import build_data as bd

LIC = "衛署藥製字第027289號"


def _nhi(code):
    return {"藥品代號": code, "給付規定章節": "1.1", "給付規定章節連結": "", "藥品代碼超連結": "",
            "藥品中文名稱": "U", "藥品英文名稱": "U", "成分": "UREA",
            "有效起日": "1100101", "有效迄日": "9991231", "ATC代碼": "", "支付價": "10"}


# ── check_record_drop 單元 ──────────────────────────────────────
def test_exactly_at_limit_passes():
    assert bd.check_record_drop({"totalRecords": 100, "nhiRecords": 100}, 90, 90) == []


def test_just_over_limit_fails_and_names_both_fields():
    probs = bd.check_record_drop({"totalRecords": 1000, "nhiRecords": 1000}, 899, 899)
    assert len(probs) == 2
    assert "總筆數" in probs[0] and "健保品項" in probs[1]


def test_only_nhi_drop_is_caught():
    """API 37 正常、NHI CSV 截斷：總筆數不變，只有健保品項降。"""
    [p] = bd.check_record_drop({"totalRecords": 22264, "nhiRecords": 10065}, 22264, 5000)
    assert "健保品項" in p and "10,065" in p


def test_growth_passes():
    assert bd.check_record_drop({"totalRecords": 100, "nhiRecords": 100}, 500, 500) == []


@pytest.mark.parametrize("prev", [
    None, [], {}, {"totalRecords": 0, "nhiRecords": 0}, {"totalRecords": "100"},
    {"totalRecords": None}, {"totalRecords": True}, {"totalRecords": -5},
])
def test_missing_or_bad_previous_does_not_block(prev):
    """首次建置、舊格式或壞值：不阻擋（寧可略過守門，也不能讓建置永遠卡住）。"""
    assert bd.check_record_drop(prev, 1, 1) == []


def test_default_ratio_is_ten_percent():
    assert bd.MAX_RECORD_DROP_RATIO == 0.10


# ── load_previous_version ──────────────────────────────────────
def test_load_previous_missing_file(tmp_path):
    assert bd.load_previous_version(tmp_path / "nope.json") is None


@pytest.mark.parametrize("content", ["{broken", "[1, 2]", '"x"'])
def test_load_previous_bad_content(tmp_path, content):
    p = tmp_path / "v.json"
    p.write_text(content, encoding="utf-8")
    assert bd.load_previous_version(p) is None


# ── main() 端到端 ──────────────────────────────────────────────
@pytest.fixture
def build(monkeypatch, tmp_path):
    """以 1 筆許可證、1 筆健保匹配的合成來源跑 main()。"""
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("ALLOW_RECORD_DROP", raising=False)
    nhi = [_nhi(f"AC{n:05d}100") for n in range(1000, 1600)] + [_nhi("AC27289100")]
    raw37 = [{"許可證字號": LIC, "中文品名": "", "英文品名": "U", "適應症": "", "主成分": "UREA",
              "用法用量": "", "許可證種類": "", "劑型": "乳膏劑"}]
    raw39 = [{"許可證字號": LIC, "仿單圖檔連結": "https://www.fda.gov.tw/a.pdf", "外盒圖檔連結": ""}]
    raw42 = [{"許可證字號": LIC, "外觀圖檔連結": "https://www.fda.gov.tw/a.jpg"}]
    fda = {bd.API_37: raw37, bd.API_39: raw39, bd.API_42: raw42}
    monkeypatch.setattr(bd, "fetch_fda_json", lambda url, label: fda[url])
    monkeypatch.setattr(bd, "fetch_nhi_csv", lambda url, label: nhi)
    monkeypatch.setattr(bd, "fetch_nhi_chapters", lambda: ({}, None))
    return tmp_path


def _write_prev(path, total, nhi):
    prev = {"generatedAt": "2026-11-04T09:02:04", "totalRecords": total, "nhiRecords": nhi}
    text = json.dumps(prev)
    (path / bd.VERSION_FILE).write_text(text, encoding="utf-8")
    return text


def test_main_aborts_on_large_drop_without_writing(build):
    prev_text = _write_prev(build, 100, 100)
    with pytest.raises(SystemExit) as exc:
        bd.main()
    assert "降幅過大" in str(exc.value.code)
    # 上一版位元不變、未寫出新資料
    assert (build / bd.VERSION_FILE).read_text(encoding="utf-8") == prev_text
    assert not (build / bd.OUTPUT_FILE).exists()


def test_main_allows_drop_with_env(build, monkeypatch, capsys):
    _write_prev(build, 100, 100)
    monkeypatch.setenv("ALLOW_RECORD_DROP", "1")
    bd.main()
    assert (build / bd.OUTPUT_FILE).exists()
    assert json.loads((build / bd.VERSION_FILE).read_text(encoding="utf-8"))["totalRecords"] == 1
    assert "已以 ALLOW_RECORD_DROP=1 放行" in capsys.readouterr().out


@pytest.mark.parametrize("val", ["0", "true", "yes", ""])
def test_main_env_must_be_exactly_one(build, monkeypatch, val):
    _write_prev(build, 100, 100)
    monkeypatch.setenv("ALLOW_RECORD_DROP", val)
    with pytest.raises(SystemExit):
        bd.main()


def test_main_proceeds_without_previous_version(build):
    bd.main()
    assert (build / bd.OUTPUT_FILE).exists()


def test_main_proceeds_within_limit(build):
    _write_prev(build, 1, 1)
    bd.main()
    assert (build / bd.OUTPUT_FILE).exists()
