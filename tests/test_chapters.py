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


def test_indented_heading_does_not_span_lines():
    """點後只允許同一行的空白（[ \\t]*），不可用 \\s* 跨到下一行把內文當標題
    （2026-11-05 突變測試：改成 \\s* 原本全綠）"""
    text = "2.6.3. 甲\n內容甲\n   2.6.4.\n   限用於下列情形\n"
    ch = parse_chapters(text)
    assert "2.6.4" not in ch
    assert "限用於下列情形" in ch["2.6.3"]["content"]


# ── 重複章節編號（2026-11-09，PR #22 #5）：只回報、不改變後者覆蓋的行為 ──
DUP_SAMPLE = """2.6.3. 降血脂藥物
內文一。
   2.6.4. 之規定辦理
2.6.4. PCSK9 抑制劑
真正的規定。
"""


def test_duplicate_numbers_are_reported(capsys):
    parse_chapters(DUP_SAMPLE)
    out = capsys.readouterr().out
    assert "章節編號重複：1 個" in out
    assert "2.6.4 ×2" in out and "✗之規定辦理" in out and "✓PCSK9" in out


def test_adjacent_fragment_then_real_keeps_real():
    """片段緊接在真章節前（10.7.4 型）：兩者順序分數相同，保留後者。"""
    assert parse_chapters(DUP_SAMPLE)["2.6.4"]["title"].startswith("PCSK9")


def test_no_duplicates_reports_zero(capsys):
    parse_chapters(SAMPLE)
    assert "章節編號重複：0" in capsys.readouterr().out


def test_duplicate_chapter_numbers_counts():
    from build_data import duplicate_chapter_numbers
    m = [(0, "1.1", "a"), (1, "1.2", "b"), (2, "1.1", "c"), (3, "1.1", "d")]
    assert duplicate_chapter_numbers(m) == {"1.1": 3}


# 2026-11-09 真實 PDF 的重複型態與出現順序（nhi_payment_rules.pdf，7 個重複）。
# 順序須照實：3.x／7.2.1／9.32.2 的片段在真章節「之後」，2.18／10.7.4 在「之前」。
# 原「後出現者覆蓋」選錯 5 個：3.1／3.2／3.3（PCSK9 申請表）、7.2.1（引用句）、9.32.2（附件表）
REAL_PATTERN = """2.1.1. 抗凝血劑總則
   2.18. 歲以上非瓣膜性心房纖維顫動病患
2.1.2. Dabigatran
內文。
2.6.3. Statin 類
內文。
2.6.4. PCSK9 血脂調節劑
內文。
2.17. 其他心血管藥
2.18. Captopril 內服液劑
真正的 Captopril 規定。
3. 營養劑
3.1. 靜脈營養輸液 Parenteral nutritions
內文。
3.2. 維生素 Vitamins
內文。
3.3. 其他 Miscellaneous
內文。
7.2. 止吐劑
7.2.1. Serotonin antagonists（如 ondansetron）
真正的止吐規定。
7.2.2. NK1 antagonists
   7.2.1. 規範給予 serotonin antagonist。
9.32.1. Imatinib
9.32.2. Nilotinib 150mg(如 Tasigna 150mg)
真正的 Nilotinib 規定。
9.32.3. Dasatinib
10.7.3. Lamivudine
   10.7.4. 之 1至4項。
10.7.4. Adefovir dipivoxil (如 Hepsera Tablets 10mg)
真正的 Adefovir 規定。
10.7.5. Entecavir
11.1. 附件 PCSK9 申請表
3.1 重大心血管疾病（必要條件）
3.2 符合 PCSK9血脂調節劑原因
3.3 申請前一年內所有 LDL-C 之報告
3.4 首次使用 PCSK9調節劑治療前之 LDL-C 報告
   9.32.2.Nilotinib150mg(如 Tasigna150mg)：附件表格
2.0 mg/dL ）， 且無法以其他
11.3. 附件三
"""


@pytest.mark.parametrize("num,title", [
    ("3.1", "靜脈營養輸液"),
    ("3.2", "維生素"),
    ("3.3", "其他"),
    ("7.2.1", "Serotonin antagonists"),
    ("9.32.2", "Nilotinib 150mg(如 Tasigna 150mg)"),
    ("2.18", "Captopril"),
    ("10.7.4", "Adefovir"),
])
def test_real_duplicate_patterns_pick_in_order_chapter(num, title):
    assert parse_chapters(REAL_PATTERN)[num]["title"].startswith(title)


def test_real_pattern_actually_has_duplicates():
    """fixture 自身的前提：五個編號確實被 regex 抓到兩次（否則上面的測試是空轉）。"""
    import build_data as bd
    from build_data import duplicate_chapter_numbers
    seen = []
    orig = bd.dedupe_chapter_matches
    bd.dedupe_chapter_matches = lambda m: (seen.append(m), orig(m))[1]
    try:
        parse_chapters(REAL_PATTERN)
    finally:
        bd.dedupe_chapter_matches = orig
    assert set(duplicate_chapter_numbers(seen[0])) == {"2.18", "3.1", "3.2", "3.3", "7.2.1", "9.32.2", "10.7.4"}


def test_rejected_fragment_is_not_a_split_point():
    """被排除的片段文字併回所在章節，不截斷該章（PCSK9 申請表留在附件 11.1）。"""
    ch = parse_chapters(REAL_PATTERN)
    assert "LDL-C 之報告" in ch["11.1"]["content"]
    assert "規範給予" in ch["7.2.2"]["content"]
    # 附件區夾雜唯一的雜訊編號（3.4、2.0 mg/dL），片段的前鄰 3.4 < 9.32.2：只比前鄰會選錯
    assert "附件表格" in ch["3.4"]["content"]
    assert "非瓣膜性" in ch["2.1.1"]["content"]


def test_dedupe_without_duplicates_is_identity():
    from build_data import dedupe_chapter_matches
    m = [(0, "1.1", "a"), (5, "1.2", "b")]
    assert dedupe_chapter_matches(m) is m
