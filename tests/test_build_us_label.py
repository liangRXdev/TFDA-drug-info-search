"""build_us_label.py 的失敗契約測試（規格 §7、§9 B 組）。

全有或全無：任何一處不完整就中止，且上一版 us_label_data.json 位元不變。
網路以注入的 fetch_manifest／fetch_part 取代，不打真實 openFDA。
"""
import json
import zipfile

import pytest

import build_us_label as b
from us_label import MATCH_RULES_VERSION

URL = "https://download.open.fda.gov/drug/label/drug-label-{:04d}-of-0002.json.zip"


def rx(set_id, subs, bw=None, route=("ORAL",)):
    r = {"set_id": set_id, "version": "3", "effective_time": "20250101",
         "openfda": {"product_type": ["HUMAN PRESCRIPTION DRUG"], "substance_name": list(subs),
                     "route": list(route), "application_number": ["ANDA1"], "brand_name": ["B"]},
         "adverse_reactions": ["not kept"]}
    if bw:
        r["boxed_warning"] = [bw]
    return r


PART1 = [rx("11111111-1111-1111-1111-111111111111", ["WARFARIN SODIUM"], bw="BLEEDING"),
         {"set_id": "otc", "openfda": {"product_type": ["HUMAN OTC DRUG"]}}]
PART2 = [rx("22222222-2222-2222-2222-222222222222", ["AMLODIPINE BESYLATE"]),
         {"set_id": "no-openfda", "boxed_warning": ["x"]}]


def manifest(parts=(PART1, PART2), records=None, total=None):
    recs = records or [len(p) for p in parts]
    return {"results": {"drug": {"label": {
        "export_date": "2026-10-16",
        "total_records": total if total is not None else sum(recs),
        "partitions": [{"file": URL.format(i + 1), "records": n} for i, n in enumerate(recs)],
    }}}}


@pytest.fixture
def env(tmp_path):
    drugs = tmp_path / "drugs_data.json"
    drugs.write_text(json.dumps({
        "_meta": {"usLabelRulesVersion": MATCH_RULES_VERSION},
        "data": [{"usLabelKey": "ORAL|WARFARIN"}, {"usLabelKey": "ORAL|AMLODIPINE"},
                 {"usLabelKey": "ORAL|WARFARIN"}, {"usLabelStatus": "noMatch"},
                 {"usLabelKey": "TOPICAL|NOTHING"}],
    }), encoding="utf-8")
    out = tmp_path / "us_label_data.json"
    out.write_bytes(b'{"old": true}')
    ver = tmp_path / "data_version.json"
    ver.write_text('{"generatedAt": "x"}', encoding="utf-8")

    def make_zip(name, results):
        p = tmp_path / name
        with zipfile.ZipFile(p, "w") as zf:
            zf.writestr(name.replace(".zip", ""), json.dumps({"meta": {}, "results": results}))
        return str(p)

    class Env:
        pass
    e = Env()
    e.drugs, e.out, e.ver, e.tmp = drugs, out, ver, tmp_path
    e.parts = {URL.format(1): make_zip("p1.json.zip", PART1), URL.format(2): make_zip("p2.json.zip", PART2)}
    e.make_zip = make_zip
    return e


def go(env, man=None, parts=None, deadline=None):
    return b.run(str(env.drugs), str(env.out), str(env.ver),
                 fetch_manifest=lambda: man or manifest(),
                 fetch_part=lambda url: (parts or env.parts)[url],
                 deadline=deadline or b.Deadline(60))


def test_success_writes_expected_results(env):
    out = go(env)
    data = json.loads(env.out.read_text(encoding="utf-8"))
    assert data == out
    assert data["data"]["ORAL|WARFARIN"]["s"] == "bw"
    assert data["data"]["ORAL|WARFARIN"]["bw"] == ["BLEEDING"]
    assert data["data"]["ORAL|AMLODIPINE"]["s"] == "nobw"
    assert data["data"]["TOPICAL|NOTHING"] == {"s": "nomatch"}
    assert set(data["data"]) == {"ORAL|WARFARIN", "ORAL|AMLODIPINE", "TOPICAL|NOTHING"}
    assert data["_meta"]["matchRulesVersion"] == MATCH_RULES_VERSION
    assert data["_meta"]["rxStructured"] == 2 and data["_meta"]["labelsTotal"] == 4
    assert "not kept" not in env.out.read_text(encoding="utf-8")
    assert "usLabelGeneratedAt" in json.loads(env.ver.read_text(encoding="utf-8"))


def test_output_is_deterministic_and_has_no_timestamp(env):
    go(env)
    first = env.out.read_bytes()
    go(env)
    assert env.out.read_bytes() == first
    assert b"generatedAt" not in first


def assert_aborts_and_keeps_old(env, **kw):
    ver_before = env.ver.read_bytes()
    with pytest.raises(b.Abort):
        go(env, **kw)
    assert env.out.read_bytes() == b'{"old": true}'
    assert env.ver.read_bytes() == ver_before
    assert not list(env.tmp.glob(".us_label_*"))


def test_part_record_count_mismatch_aborts(env):
    assert_aborts_and_keeps_old(env, man=manifest(records=[2, 3]))


def test_manifest_total_mismatch_aborts(env):
    assert_aborts_and_keeps_old(env, man=manifest(total=99))


def test_corrupt_zip_aborts(env):
    bad = env.tmp / "bad.zip"
    bad.write_bytes(b"PK\x03\x04 truncated")
    assert_aborts_and_keeps_old(env, parts={URL.format(1): str(bad), URL.format(2): env.parts[URL.format(2)]})


def test_unexpected_manifest_url_aborts(env):
    m = manifest()
    m["results"]["drug"]["label"]["partitions"][0]["file"] = "https://evil.example.com/x.zip"
    assert_aborts_and_keeps_old(env, man=m)


def test_malformed_manifest_aborts(env):
    assert_aborts_and_keeps_old(env, man={"results": {}})


def test_deadline_aborts(env):
    ticks = iter([0, 0, 10 ** 6, 10 ** 6, 10 ** 6])
    assert_aborts_and_keeps_old(env, deadline=b.Deadline(60, clock=lambda: next(ticks)))


def test_rules_version_mismatch_aborts(env):
    env.drugs.write_text(json.dumps({"_meta": {"usLabelRulesVersion": MATCH_RULES_VERSION + 1},
                                     "data": [{"usLabelKey": "ORAL|X"}]}), encoding="utf-8")
    assert_aborts_and_keeps_old(env)


def test_zero_keys_aborts(env):
    env.drugs.write_text(json.dumps({"_meta": {"usLabelRulesVersion": MATCH_RULES_VERSION},
                                     "data": [{"usLabelStatus": "noMatch"}]}), encoding="utf-8")
    assert_aborts_and_keeps_old(env)


def test_first_build_failure_writes_nothing(env):
    env.out.unlink()
    with pytest.raises(b.Abort):
        go(env, man=manifest(records=[1, 1]))
    assert not env.out.exists()


def test_main_returns_nonzero_on_abort(env, monkeypatch):
    monkeypatch.chdir(env.tmp)
    monkeypatch.setattr(b, "http_get", lambda url, dest=None, deadline=None: {"results": {}})
    assert b.main([]) == 1
    assert env.out.read_bytes() == b'{"old": true}'


def test_http_get_does_not_retry_client_errors(monkeypatch):
    calls = []

    class R:
        status_code = 404
        headers = {}

    monkeypatch.setattr(b.requests, "get", lambda *a, **k: calls.append(1) or R())
    with pytest.raises(b.Abort):
        b.http_get("https://download.open.fda.gov/drug/label/x.zip")
    assert len(calls) == 1


def test_http_get_retries_server_errors_then_aborts(monkeypatch):
    calls = []

    class R:
        status_code = 503
        headers = {}

    monkeypatch.setattr(b.requests, "get", lambda *a, **k: calls.append(1) or R())
    monkeypatch.setattr(b.time, "sleep", lambda s: None)
    with pytest.raises(b.Abort):
        b.http_get("https://download.open.fda.gov/drug/label/x.zip")
    assert len(calls) == b.MAX_RETRIES


def test_http_get_retries_truncated_download(monkeypatch, tmp_path):
    calls = []

    class R:
        status_code = 200
        headers = {"Content-Length": "10"}

        def iter_content(self, chunk_size):
            yield b"12345"

    monkeypatch.setattr(b.requests, "get", lambda *a, **k: calls.append(1) or R())
    monkeypatch.setattr(b.time, "sleep", lambda s: None)
    with pytest.raises(b.Abort):
        b.http_get("https://download.open.fda.gov/drug/label/x.zip", str(tmp_path / "x.zip"))
    assert len(calls) == b.MAX_RETRIES


# ── Codex 審查補測（CR3、CR6、CR7、T2、T6、T7）──────────────────────
def test_publish_failure_before_any_replace_keeps_both_files(env, monkeypatch):
    # 暫存檔寫入失敗 → 兩檔都不動、不留暫存
    real = b.tempfile.mkstemp
    calls = []

    def flaky(*a, **k):
        calls.append(1)
        if len(calls) == 2:
            raise OSError("disk full")
        return real(*a, **k)

    monkeypatch.setattr(b.tempfile, "mkstemp", flaky)
    assert_aborts_and_keeps_old(env)


def test_publish_failure_between_replaces_raises_abort_and_cleans(env, monkeypatch):
    # 第二次 replace 失敗：仿單檔已換（由 workflow 還原兜底，見 test_workflow_*），
    # 但程式必須以 Abort 結束（非零碼）、版本檔不動、不留暫存
    real = b.os.replace
    calls = []

    def flaky(src, dst):
        calls.append(dst)
        if len(calls) == 2:
            raise OSError("io error")
        return real(src, dst)

    monkeypatch.setattr(b.os, "replace", flaky)
    ver_before = env.ver.read_bytes()
    with pytest.raises(b.Abort):
        go(env)
    assert calls[0].endswith("us_label_data.json")   # 仿單檔排在前面
    assert env.ver.read_bytes() == ver_before
    assert not list(env.tmp.glob(".us_label_*"))


def test_summary_failure_does_not_fail_published_build(env, monkeypatch, tmp_path):
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(tmp_path / "no-such-dir" / "summary.md"))
    go(env)   # 不得拋錯
    assert json.loads(env.out.read_text(encoding="utf-8"))["_meta"]["keys"] == 3


def test_deadline_checked_right_before_write(env):
    # 時鐘只在最後一次檢查（寫入前）越界：計算完成也不得寫檔
    ticks = iter([0, 0, 0, 0, 10 ** 6])
    assert_aborts_and_keeps_old(env, deadline=b.Deadline(60, clock=lambda: next(ticks)))


def test_http_get_respects_deadline(monkeypatch):
    calls = []
    monkeypatch.setattr(b.requests, "get", lambda *a, **k: calls.append(k["timeout"]))
    expired = b.Deadline(0, clock=iter([0, 5, 5]).__next__)
    with pytest.raises(b.Abort):
        b.http_get("https://download.open.fda.gov/drug/label/x.zip", deadline=expired)
    assert calls == []


def test_bw_only_in_second_part_is_found(env):
    # 同成分：第一檔無 BW、第二檔有 BW → 索引在全部檔案讀完後才建立，須為 ①、N=2、M=1
    p1 = [rx("33333333-3333-3333-3333-333333333333", ["AMLODIPINE MALEATE"])]
    p2 = [rx("44444444-4444-4444-4444-444444444444", ["AMLODIPINE BESYLATE"], bw="ONLY IN PART 2")]
    parts = {URL.format(1): env.make_zip("q1.json.zip", p1), URL.format(2): env.make_zip("q2.json.zip", p2)}
    out = go(env, man=manifest(parts=(p1, p2)), parts=parts)
    r = out["data"]["ORAL|AMLODIPINE"]
    assert (r["s"], r["n"], r["m"], r["bw"]) == ("bw", 2, 1, ["ONLY IN PART 2"])


def test_summary_has_item_level_distribution(env, monkeypatch, tmp_path):
    summary = tmp_path / "summary.md"
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary))
    go(env)
    text = summary.read_text(encoding="utf-8")
    # 5 個品項：WARFARIN×2（bw）、AMLODIPINE（nobw）、noMatch、TOPICAL|NOTHING（nomatch）
    assert "品項統計（5 筆）" in text
    assert "bw 2" in text and "nobw 1" in text and "noMatch 1" in text and "nomatch 1" in text


def test_abort_writes_reason_to_summary(env, monkeypatch, tmp_path):
    summary = tmp_path / "summary.md"
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary))
    monkeypatch.chdir(env.tmp)
    monkeypatch.setattr(b, "http_get", lambda url, dest=None, deadline=None: {"results": {}})
    assert b.main([]) == 1
    assert "本批中止" in summary.read_text(encoding="utf-8")


def test_internal_deadline_shorter_than_step_timeout():
    import re
    from pathlib import Path
    yml = (Path(__file__).resolve().parent.parent / ".github/workflows/build-data.yml").read_text(encoding="utf-8")
    m = re.search(r"name: Build US label reference.*?timeout-minutes: (\d+)", yml, re.S)
    assert m and b.DEADLINE_SEC < int(m.group(1)) * 60
