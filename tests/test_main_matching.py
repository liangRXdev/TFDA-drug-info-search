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


def test_radiopharma_license_gets_its_nhi_code(monkeypatch, tmp_path):
    """PR#22 待決 #9：R 序列許可證（Xofigo）要配到 BR 代號，且不與同類別的號碼 91 互配。"""
    monkeypatch.chdir(tmp_path)
    r_lic, plain_lic = "衛部藥輸字第R00091號", "衛部藥輸字第000091號"
    filler = [_nhi(f"AC{n:05d}100", "AMLODIPINE", "F") for n in range(1000, 1600)]
    nhi = filler + [
        _nhi("BR00091223", "Radium-223 chloride 1100 kBq/mL", "Xofigo solution for injection"),
        _nhi("BC00091100", "", "PLAIN 91"),   # 成分空白 → code-only，只能靠鍵分開
    ]

    def drug(lic, en, ingr):
        return {"許可證字號": lic, "中文品名": "", "英文品名": en, "適應症": "",
                "主成分": ingr, "用法用量": "", "許可證種類": "", "劑型": "注射液劑"}

    raw37 = [drug(r_lic, "Xofigo solution for injection", "Radium-223 chloride"),
             drug(plain_lic, "PLAIN 91", "")]
    raw39 = [{"許可證字號": r_lic, "仿單圖檔連結": "https://www.fda.gov.tw/a.pdf", "外盒圖檔連結": ""}]
    raw42 = [{"許可證字號": r_lic, "外觀圖檔連結": "https://www.fda.gov.tw/a.jpg"}]
    fda = {bd.API_37: raw37, bd.API_39: raw39, bd.API_42: raw42}
    monkeypatch.setattr(bd, "fetch_fda_json", lambda url, label: fda[url])
    monkeypatch.setattr(bd, "fetch_nhi_csv", lambda url, label: nhi)
    monkeypatch.setattr(bd, "fetch_nhi_chapters", lambda: ({}, None))

    bd.main()

    items = json.loads((tmp_path / bd.OUTPUT_FILE).read_text(encoding="utf-8"))["data"]
    codes = {i["licenseNumber"]: [m["code"] for m in i["nhiMatches"]] for i in items}
    assert codes == {r_lic: ["BR00091223"], plain_lic: ["BC00091100"]}
