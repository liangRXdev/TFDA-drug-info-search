"""main() 的 fail-closed 路徑（2026-10-22 review M2／M4）。

上游任一來源壞掉時，main() 必須在寫 drugs_data.json 之前中止——寫了就會覆蓋上一版
正常資料，而 workflow 仍是綠燈。這裡不連網：四個抓取函式全部 monkeypatch。
"""
import pytest

import build_data as bd

NHI_ROW = {
    "藥品代號": "AC00001100", "給付規定章節": "1.1", "給付規定章節連結": "",
    "藥品代碼超連結": "", "藥品中文名稱": "甲", "藥品英文名稱": "A", "成分": "X",
    "有效起日": "1100101", "有效迄日": "9991231", "ATC代碼": "A01", "支付價": "1.0",
}
API37_ROW = {"許可證字號": "衛署藥製字第000011號", "適應症": "", "主成分": "X",
             "用法用量": "", "許可證種類": "", "劑型": "錠劑"}
API39_ROW = {"許可證字號": "衛署藥製字第000011號", "仿單圖檔連結": "https://www.fda.gov.tw/a.pdf",
             "外盒圖檔連結": ""}
API42_ROW = {"許可證字號": "衛署藥製字第000011號", "外觀圖檔連結": "https://www.fda.gov.tw/a.jpg"}


@pytest.fixture
def run_main(monkeypatch, tmp_path):
    """以給定的四份來源執行 main()，回傳 SystemExit；cwd 為空的暫存目錄。"""
    monkeypatch.chdir(tmp_path)

    def run(raw37, raw39, raw42, raw_nhi):
        fda = {bd.API_37: raw37, bd.API_39: raw39, bd.API_42: raw42}
        monkeypatch.setattr(bd, "fetch_fda_json", lambda url, label: fda[url])
        monkeypatch.setattr(bd, "fetch_nhi_csv", lambda url, label: raw_nhi)
        monkeypatch.setattr(bd, "fetch_nhi_chapters", lambda: ({}, None))
        with pytest.raises(SystemExit) as exc:
            bd.main()
        # 中止前不得寫出任何檔案（上一版位元不變）
        assert list(tmp_path.iterdir()) == []
        return str(exc.value.code)
    return run


def _nhi_without(col):
    return [{k: v for k, v in NHI_ROW.items() if k != col}]


@pytest.mark.parametrize("label,raw39,raw42", [
    ("API 39", [], [API42_ROW]),
    ("API 42", [API39_ROW], []),
])
def test_empty_fda_source_aborts(run_main, label, raw39, raw42):
    msg = run_main([API37_ROW], raw39, raw42, [NHI_ROW])
    # 須是「無資料」這道守門擋下：只斷言 label 時，拿掉它也會被下游「找不到欄位：
    # API 39 許可證字號」順帶擋住而維持綠燈（2026-11-05 突變測試）
    assert label in msg and "無資料" in msg


# 清單寫死，不引用 bd.REQUIRED_NHI_FIELDS：引用常數時把常數縮減成只剩「藥品代號」，
# 參數化也跟著縮減，測試仍全綠（2026-11-05 突變測試）
@pytest.mark.parametrize("col", ["藥品代號", "有效起日", "有效迄日", "給付規定章節", "支付價"])
def test_missing_nhi_column_aborts(run_main, col):
    """五個欄位各缺一次：缺任何一個都會讓某種錯誤資料靜默上線（見 REQUIRED_NHI_FIELDS）。"""
    msg = run_main([API37_ROW], [API39_ROW], [API42_ROW], _nhi_without(col))
    # 藥品代號／給付規定章節缺席時，模糊比對會改抓「…超連結」「…連結」：由重疊檢查擋下。
    # 須斷言是哪道守門：只斷言欄位名時，拿掉這兩道仍會被下游「整欄空白」順帶擋住而全綠
    if col in ("藥品代號", "給付規定章節"):
        assert "重疊" in msg
    else:
        assert "找不到 NHI 欄位" in msg and col in msg


@pytest.mark.parametrize("raw39,raw42,expected", [
    ([{"許可證字號": "x", "外盒圖檔連結": ""}], [API42_ROW], "API 39 仿單連結"),
    ([API39_ROW], [{"許可證字號": "x"}], "API 42 圖檔連結"),
])
def test_missing_fda_column_aborts(run_main, raw39, raw42, expected):
    msg = run_main([API37_ROW], raw39, raw42, [NHI_ROW])
    assert expected in msg


def test_all_links_blank_aborts(run_main):
    """欄位在、列也在，但每列連結都是空的 → 索引為空，也要中止。"""
    blank39 = [dict(API39_ROW, 仿單圖檔連結="")]
    msg = run_main([API37_ROW], blank39, [API42_ROW], [NHI_ROW])
    assert "仿單索引" in msg


def test_missing_names():
    assert bd.missing_names({"a": "x", "b": None, "c": [], "d": [1]}) == ["b", "c"]


@pytest.mark.parametrize("col", ["藥品代號", "有效起日", "有效迄日", "給付規定章節", "支付價"])
def test_blank_nhi_column_aborts(run_main, col):
    """欄位名在、整欄卻全空（2026-11-05 review）：欄位偵測會通過。有效起訖日全空最危險——
    空白視為「無期限」，所有歷史紀錄都判為現行有效（舊支付價復活），日期失敗率卻是 0%。"""
    msg = run_main([API37_ROW], [API39_ROW], [API42_ROW], [dict(NHI_ROW, **{col: ""})])
    assert col in msg and "空白" in msg
