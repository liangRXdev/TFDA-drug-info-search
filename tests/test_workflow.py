"""build-data.yml 的靜態檢查（規格 §9 B6〔W〕、D12）。

workflow 無法在 pytest 內實跑，但這些條件一旦被改掉，失效方式都是靜默的：
仿單檔永遠不發布、失敗時發布半成品、重疊執行互相覆蓋。以文字比對釘住，
刻意不引入 YAML 解析依賴（本 repo 依賴僅 requests）。
"""
import re
from pathlib import Path

import pytest

YML = (Path(__file__).resolve().parent.parent / ".github/workflows/build-data.yml").read_text(encoding="utf-8")


def step(name):
    """取出某個 step 的完整文字（到下一個 step 或檔尾）。"""
    m = re.search(rf"^      - name: {re.escape(name)}\n(.*?)(?=^      - name: |\Z)", YML, re.S | re.M)
    assert m, f"找不到 step：{name}"
    return m.group(1)


def test_concurrency_queues_instead_of_cancelling():
    m = re.search(r"^concurrency:\n(.*?)(?=^\S)", YML, re.S | re.M)
    assert m and re.search(r"cancel-in-progress:\s*false", m.group(1))


def test_us_label_step_is_isolated_and_time_boxed():
    s = step("Build US label reference")
    assert re.search(r"continue-on-error:\s*true", s)
    assert re.search(r"timeout-minutes:\s*\d+", s)
    assert re.search(r"id:\s*us_label", s)
    assert "python build_us_label.py" in s


def test_us_label_step_runs_after_main_build_and_before_commit():
    order = [m.group(1) for m in re.finditer(r"^      - name: (.+)$", YML, re.M)]
    assert order.index("Build drug database") < order.index("Build US label reference") \
        < order.index("Commit and push if changed")


def test_commit_considers_us_label_file():
    s = step("Commit and push if changed")
    assert re.search(r'files="\$files us_label_data\.json"', s)
    assert re.search(r"git diff --staged --quiet -- \$files", s)


def test_commit_restores_us_label_when_step_not_successful():
    s = step("Commit and push if changed")
    guard = s.index('if [ "${{ steps.us_label.outcome }}" != "success" ]')
    restore = s.index("git checkout -- us_label_data.json")
    stage = s.index("git add $files")
    # 還原必須發生在 stage 之前，否則半成品照樣進 commit
    assert guard < restore < stage
    assert "rm -f us_label_data.json" in s          # 首次建置（尚未進版控）失敗
    assert "usLabelGeneratedAt" in s                # 建置時間一併還原


def test_timestamp_only_changes_do_not_commit():
    s = step("Commit and push if changed")
    # data_version.json 只在資料檔確實有變時才加入
    assert s.index("git diff --staged --quiet -- $files") < s.index("git add data_version.json")
    assert not re.search(r"files=.*data_version", s)


@pytest.mark.parametrize("path", ["build_us_label.py", "us_label.py"])
def test_rule_changes_trigger_rebuild(path):
    m = re.search(r"^  push:\n(.*?)(?=^\S|^permissions)", YML, re.S | re.M)
    assert m and f"- '{path}'" in m.group(1)
