"""main() 端到端：健保代號↔許可證匹配的接線（2026-11-05 review）。

nhi_code_kind_compatible() 有單元測試，但只有接進 main() 的匹配迴圈才會影響輸出；
這裡以最小的合成來源跑完整 main()，釘住「類別不符的撞號代號不進 nhiMatches」。
不連網：抓取函式全部 monkeypatch。
"""
import json

import build_data as bd

LIC = "衛署藥製字第027289號"   # WINSOLVE UREA CREAM（真實案例）


def _nhi(code, ingr, en):
    return {"藥品代號": code, "給付規定章節": "1.1", "給付規定章節連結": "", "藥品代碼超連結": "",
            "藥品中文名稱": en, "藥品英文名稱": en, "成分": ingr,
            "有效起日": "1100101", "有效迄日": "9991231", "ATC代碼": "", "支付價": "10"}


def test_cross_kind_code_is_not_matched(monkeypatch, tmp_path, capsys):
    monkeypatch.chdir(tmp_path)
    # 填充列：健保索引須 >1000 鍵 main() 才會繼續（每個代號產補零／去零兩鍵）
    filler = [_nhi(f"AC{n:05d}100", "AMLODIPINE", "F") for n in range(1000, 1600)]
    nhi = filler + [
        _nhi("AC27289100", "UREA", "WINSOLVE UREA CREAM"),                # 正確代號（A=藥製）
        _nhi("BC27289100", "BARICITINIB", "Olumiant film-coated tablets"),  # 撞號（B=藥輸）
    ]
    raw37 = [{"許可證字號": LIC, "中文品名": "", "英文品名": "WINSOLVE UREA CREAM",
              "適應症": "", "主成分": "UREA", "用法用量": "", "許可證種類": "", "劑型": "乳膏劑"}]
    raw39 = [{"許可證字號": LIC, "仿單圖檔連結": "https://www.fda.gov.tw/a.pdf", "外盒圖檔連結": ""}]
    raw42 = [{"許可證字號": LIC, "外觀圖檔連結": "https://www.fda.gov.tw/a.jpg"}]
    fda = {bd.API_37: raw37, bd.API_39: raw39, bd.API_42: raw42}
    monkeypatch.setattr(bd, "fetch_fda_json", lambda url, label: fda[url])
    monkeypatch.setattr(bd, "fetch_nhi_csv", lambda url, label: nhi)
    monkeypatch.setattr(bd, "fetch_nhi_chapters", lambda: ({}, None))

    bd.main()

    [item] = json.loads((tmp_path / bd.OUTPUT_FILE).read_text(encoding="utf-8"))["data"]
    assert [m["code"] for m in item["nhiMatches"]] == ["AC27289100"]
    assert item["nhiPrimaryCode"] == "AC27289100"
    # 被擋下的數量須出現在建置輸出（錯配規模可觀測）
    assert "類別不符" in capsys.readouterr().out
