"""健保給付規定 PDF 版本日擷取與過期警示（2026-11-11）。

PDF 為人工更新，這裡是唯一會發現它過期的機制：
  - 版本日抽不到 → 一律警示（缺檔、pdftotext 失敗、頁首格式改變都要人看）
  - 超過 NHI_RULES_STALE_DAYS → 警示；只警示不中止建置
"""
import re
from datetime import date
from pathlib import Path

import pytest

import build_data as bd
from build_data import (NHI_RULES_STALE_DAYS, parse_chapters, parse_rules_version,
                        report_rules_staleness, rules_staleness_warning)


# pdftotext -layout 實際輸出：每頁頁首重複一次（115.10.22 版 427 頁全為同一值）
PAGE = "          (115.10.22更新)\n\n2.6.1. 降血脂藥物\n限用於下列情形之一。\n\f"


def test_parses_roc_header():
    assert parse_rules_version(PAGE * 3) == date(2026, 10, 22)


def test_two_digit_roc_year():
    assert parse_rules_version("(99.1.5更新)") == date(2010, 1, 5)


def test_majority_wins_when_versions_mixed(capsys):
    text = "(115.10.22更新)\n" * 5 + "(115.9.22更新)\n"
    assert parse_rules_version(text) == date(2026, 10, 22)
    assert "多種版本日" in capsys.readouterr().out


@pytest.mark.parametrize("text", ["", None, "藥品給付規定通則", "(115.13.40更新)", "115.10.22更新"])
def test_missing_or_invalid_returns_none(text):
    # 括號是頁首樣式的一部分：內文「…115.10.22更新…」不帶括號，不可誤認為版本
    assert parse_rules_version(text) is None


def test_header_is_still_stripped_from_chapter_content():
    # 版本日抽取與章節內文清除依賴同一個頁首樣式，兩者不可分家
    ch = parse_chapters(PAGE)
    assert "更新)" not in ch["2.6.1"]["content"]


def test_within_limit_no_warning():
    v = date(2026, 10, 22)
    assert rules_staleness_warning(v, date(2026, 11, 11)) is None
    assert rules_staleness_warning(v, v) is None
    assert rules_staleness_warning(v, date.fromordinal(v.toordinal() + NHI_RULES_STALE_DAYS)) is None


def test_over_limit_warns_with_roc_date_and_age():
    v = date(2026, 9, 22)
    today = date.fromordinal(v.toordinal() + NHI_RULES_STALE_DAYS + 1)
    w = rules_staleness_warning(v, today)
    assert w and "115.9.22" in w and f"{NHI_RULES_STALE_DAYS + 1} 天" in w


def test_unknown_version_always_warns():
    assert rules_staleness_warning(None, date(2026, 11, 11))


def test_report_writes_actions_annotation_and_summary(tmp_path, monkeypatch, capsys):
    summary = tmp_path / "summary.md"
    monkeypatch.setenv("GITHUB_ACTIONS", "true")
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary))
    assert report_rules_staleness(date(2026, 1, 1), date(2026, 11, 11))
    assert "::warning::" in capsys.readouterr().out
    assert "115.1.1" in summary.read_text(encoding="utf-8")


def test_report_silent_when_fresh(tmp_path, monkeypatch):
    summary = tmp_path / "summary.md"
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary))
    assert report_rules_staleness(date(2026, 11, 1), date(2026, 11, 11)) is None
    assert not summary.exists()


def test_summary_write_failure_does_not_abort(tmp_path, monkeypatch):
    # 寫 job summary 是附帶動作，失敗不可讓建置中止
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(tmp_path / "no-such-dir" / "s.md"))
    assert report_rules_staleness(None, date(2026, 11, 11))


def test_missing_pdf_returns_empty_and_none(tmp_path, monkeypatch):
    monkeypatch.setattr(bd, "LOCAL_PDF_PATH", str(tmp_path / "absent.pdf"))
    assert bd.fetch_nhi_chapters() == ({}, None)


def test_frontend_stale_days_in_sync():
    src = (Path(__file__).resolve().parent.parent / "app.js").read_text(encoding="utf-8")
    m = re.search(r"const NHI_RULES_STALE_DAYS = (\d+);", src)
    assert m and int(m.group(1)) == NHI_RULES_STALE_DAYS
