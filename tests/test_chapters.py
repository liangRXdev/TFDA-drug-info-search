"""健保給付規定章節解析與查找的單元測試。

對應審查項目：
  T4 — parse_chapters() / lookup_chapter() regex 密集且輸入格式（pdftotext 輸出）
       會隨 PDF 改版而變，最需要回歸測試
  D5 — poppler-utils 未固定版本。釘死 apt 版本並不可靠（舊版會從 repo 移除
       導致 CI 直接壞掉），正解是用本檔的 fixture 測試偵測 pdftotext 輸出格式變動。
"""
import pytest

from build_data import parse_chapters, lookup_chapter


SAMPLE = """2.6.1. 降血脂藥物
限用於下列情形之一：
(一) 血中總膽固醇值超過 240 mg/dL。
(二) 曾發生心肌梗塞者。

2.6.2. 抗血小板藥物
限用於缺血性腦中風病人。

3.1.1. 抗生素類
需經感染科醫師會診。
"""


def test_parses_all_chapter_numbers():
    ch = parse_chapters(SAMPLE)
    assert set(ch) == {"2.6.1", "2.6.2", "3.1.1"}


def test_trailing_dot_is_stripped_from_key():
    """PDF 中章節寫作「2.6.1.」，key 須正規化為「2.6.1」"""
    assert "2.6.1" in parse_chapters(SAMPLE)
    assert "2.6.1." not in parse_chapters(SAMPLE)


def test_title_is_extracted():
    assert parse_chapters(SAMPLE)["2.6.1"]["title"] == "降血脂藥物"


def test_content_includes_body_until_next_chapter():
    content = parse_chapters(SAMPLE)["2.6.1"]["content"]
    assert "血中總膽固醇值超過 240 mg/dL" in content
    assert "抗血小板藥物" not in content, "內容不得溢出到下一章節"


def test_last_chapter_content_runs_to_end():
    assert "需經感染科醫師會診" in parse_chapters(SAMPLE)["3.1.1"]["content"]


def test_page_numbers_are_removed():
    """pdftotext 會把頁碼留成獨立一行，須清除以免被誤判為章節或混入內容"""
    text = "2.6.1. 標題\n內容前段\n123\n內容後段\n"
    content = parse_chapters(text)["2.6.1"]["content"]
    assert "內容前段" in content and "內容後段" in content
    assert "\n123\n" not in content


def test_form_feed_is_normalised():
    text = "2.6.1. 標題\n內容甲\n\f\n內容乙\n"
    assert "\f" not in parse_chapters(text)["2.6.1"]["content"]


def test_update_marker_is_stripped_from_content():
    text = "2.6.1. 標題\n (1.2.3更新)\n實際內容\n"
    assert "更新)" not in parse_chapters(text)["2.6.1"]["content"]


def test_chapter_number_above_20_is_ignored():
    """章節首碼超過 20 視為誤判（多為條列數字或年份），不得收錄"""
    assert parse_chapters("21.1. 不是章節\n內容\n") == {}


def test_single_level_number_is_not_a_chapter():
    """至少需兩層（如 2.6），單層數字不構成章節"""
    assert parse_chapters("5. 只是條列\n內容\n") == {}


def test_title_is_truncated_to_150_chars():
    text = "2.6.1. " + "標" * 300 + "\n內容\n"
    assert len(parse_chapters(text)["2.6.1"]["title"]) == 150


def test_content_is_truncated_to_3000_chars():
    text = "2.6.1. 標題\n" + "內" * 5000 + "\n"
    assert len(parse_chapters(text)["2.6.1"]["content"]) == 3000


def test_empty_input_returns_empty_dict():
    assert parse_chapters("") == {}


# ── lookup_chapter ─────────────────────────────────────────────
CHAPTERS = {
    "2.6.1": {"title": "降血脂", "content": "內容A"},
    "2.6.2": {"title": "抗血小板", "content": "內容B"},
    "3.1":   {"title": "抗生素", "content": "內容C"},
}


def test_lookup_exact_match():
    result = lookup_chapter("2.6.1", CHAPTERS)
    assert len(result) == 1
    assert result[0]["chapter"] == "2.6.1"
    assert result[0]["title"] == "降血脂"
    assert "matched" not in result[0], "精確命中不應標記 matched"


def test_lookup_strips_trailing_dot():
    assert lookup_chapter("2.6.1.", CHAPTERS)[0]["chapter"] == "2.6.1"


@pytest.mark.parametrize("sep", [",", ";", "，", "；"])
def test_lookup_handles_all_separators(sep):
    result = lookup_chapter(f"2.6.1{sep}2.6.2", CHAPTERS)
    assert [r["chapter"] for r in result] == ["2.6.1", "2.6.2"]


def test_lookup_deduplicates_repeated_chapters():
    assert len(lookup_chapter("2.6.1,2.6.1,2.6.1", CHAPTERS)) == 1


def test_lookup_falls_back_to_parent_chapter():
    """子章節不存在時退回最近的父層，並標記實際命中的層級"""
    result = lookup_chapter("3.1.5.2", CHAPTERS)
    assert len(result) == 1
    assert result[0]["chapter"] == "3.1.5.2", "須保留原始查詢字串"
    assert result[0]["matched"] == "3.1", "須標明實際命中的是父層"
    assert result[0]["title"] == "抗生素"


def test_lookup_unknown_chapter_returns_nothing():
    assert lookup_chapter("9.9.9", CHAPTERS) == []


@pytest.mark.parametrize("raw", ["", None, "   ", ",,,"])
def test_lookup_empty_input_returns_empty(raw):
    assert lookup_chapter(raw, CHAPTERS) == []


def test_lookup_with_empty_chapter_dict_returns_empty():
    """PDF 解析失敗時 chapters 為空，查找須安全退化而非拋錯"""
    assert lookup_chapter("2.6.1", {}) == []


# ── 縮排的子章節標題（pdftotext -layout 保留縮排；115.9.22 版漏抓 44 章）──
INDENTED = """9.1.Aromatase Inhibitors
 9.1.1.Exemestane(如 Aromasin)：（88/11/1）
限用於停經後乳癌。
 9.1.2.Anastrozole(如 Arimidex)：
限用於停經後婦女。
8.2.免疫調節劑 Immunomodulators
   8.2.9.Thalidomide（如 Thado）(100/2/1)
限用於多發性骨髓瘤。
   0.5 mg/kg 每日一次
   2.3 次/日
"""


def test_indented_subchapter_headings_are_parsed():
    ch = parse_chapters(INDENTED)
    assert {"9.1", "9.1.1", "9.1.2", "8.2", "8.2.9"} <= set(ch)
    assert ch["8.2.9"]["title"].startswith("Thalidomide")


def test_indented_subchapter_splits_parent_content():
    """修正前子章節內容會整段溢入父章節"""
    ch = parse_chapters(INDENTED)
    assert "Exemestane" not in ch["9.1"]["content"]
    assert "停經後乳癌" in ch["9.1.1"]["content"]
    assert "停經後婦女" not in ch["9.1.1"]["content"]


def test_indented_dose_numbers_are_not_chapters():
    """縮排行須「編號.」後緊接文字才算標題，劑量數字不得成為章節"""
    ch = parse_chapters(INDENTED)
    assert "0.5" not in ch and "2.3" not in ch
    assert "0.5 mg/kg" in ch["8.2.9"]["content"]


# ── 縮排＋點後空格的標題（2026-10-22 review：漏抓 2.6.4、8.2.4.1 等 9 章）──
INDENTED_SPACED = """2.6.降血脂藥物
 2.6.3. Ezetimibe 複方
限用於 statin 治療後 LDL-C 仍未達標者。
 2.6.4. PCSK9 血脂調節劑（如 Repatha）
限用於家族性高膽固醇血症。
   2.6.4.1. Evolocumab
需經事前審查。
8.2.4.生物製劑
 8.2.4.1. Etanercept（如 Enbrel）
限類風濕性關節炎。
   1.5 mg/kg 每週一次
   2.5. mg 不應成為章節
"""


def test_indented_heading_with_space_after_dot_is_parsed():
    ch = parse_chapters(INDENTED_SPACED)
    assert {"2.6.3", "2.6.4", "2.6.4.1", "8.2.4.1"} <= set(ch)
    assert ch["2.6.4"]["title"].startswith("PCSK9")
    assert ch["8.2.4.1"]["title"].startswith("Etanercept")


def test_spaced_heading_does_not_bleed_into_previous_chapter():
    """修正前 PCSK9 規定整段併入 2.6.3"""
    ch = parse_chapters(INDENTED_SPACED)
    assert "PCSK9" not in ch["2.6.3"]["content"]
    assert "家族性高膽固醇血症" in ch["2.6.4"]["content"]
    assert "事前審查" not in ch["2.6.4"]["content"]


def test_spaced_heading_lookup_no_longer_falls_back_to_parent():
    ch = parse_chapters(INDENTED_SPACED)
    [hit] = lookup_chapter("2.6.4.", ch)
    assert hit["chapter"] == "2.6.4" and "matched" not in hit


def test_dose_numbers_still_not_chapters_with_spaced_rule():
    ch = parse_chapters(INDENTED_SPACED)
    assert "1.5" not in ch
    assert "1.5 mg/kg" in ch["8.2.4.1"]["content"]
