"""美國處方藥仿單參考（us_label.py）的單元測試。

對應規格 docs/plan-us-label.md §9 A 組（A1–A14）與 B 組中 ETL 純函式可驗的部分。
fixture 皆為手工組出的 openFDA label 子集，不打真實 API。
"""
import random

import pytest

from us_label import (
    MATCH_RULES_VERSION,
    STATUS_NO_MATCH,
    STATUS_NOT_APPLICABLE,
    STATUS_UNAVAILABLE,
    compute_result,
    extract_lactation,
    index_by_ingredients,
    item_us_label,
    make_key,
    norm_ingredient,
    norm_ingredient_set,
    query_term,
    route_in_group,
    select_representative,
    split_tfda_ingredients,
    validate_result,
)

_seq = iter(range(10 ** 6))


def label(subs, route=("ORAL",), bw=None, app="ANDA000001", eff="20250101",
          set_id=None, product_type="HUMAN PRESCRIPTION DRUG", **sections):
    """組一份 openFDA label。subs／route 給 None 代表該欄位缺失。"""
    o = {"product_type": [product_type], "application_number": [app],
         "brand_name": ["BRAND"], "manufacturer_name": ["MFR"]}
    if subs is not None:
        o["substance_name"] = list(subs)
    if route is not None:
        o["route"] = list(route)
    r = {"set_id": set_id or f"00000000-0000-0000-0000-{next(_seq):012d}",
         "version": "1", "effective_time": eff, "openfda": o}
    if bw is not None:
        r["boxed_warning"] = [bw] if isinstance(bw, str) else bw
    r.update(sections)
    return r


def run(key, results):
    res = compute_result(key, results)
    assert validate_result(res), res
    return res


ORAL = lambda *ings: make_key("ORAL", ings)


# ── 成分轉換（A8）─────────────────────────────────────────────
@pytest.mark.parametrize("raw, expected", [
    # T2c 反離子鹽：每一項都有正例
    ("AMLODIPINE BESYLATE", "AMLODIPINE"),
    ("METOPROLOL TARTRATE", "METOPROLOL"),
    ("ENALAPRIL MALEATE", "ENALAPRIL"),
    ("DICLOFENAC SODIUM", "DICLOFENAC"),
    ("DICLOFENAC POTASSIUM", "DICLOFENAC"),
    ("ESOMEPRAZOLE MAGNESIUM", "ESOMEPRAZOLE"),
    ("ATORVASTATIN CALCIUM", "ATORVASTATIN"),
    ("IMATINIB MESYLATE", "IMATINIB"),
    ("QUETIAPINE FUMARATE", "QUETIAPINE"),
    ("CLOPIDOGREL BISULFATE", "CLOPIDOGREL"),
    ("SERTRALINE HYDROCHLORIDE", "SERTRALINE"),
    ("CETIRIZINE DIHYDROCHLORIDE", "CETIRIZINE"),
    ("DEXTROMETHORPHAN HYDROBROMIDE", "DEXTROMETHORPHAN"),
    ("PEMETREXED DISODIUM", "PEMETREXED"),
    ("DIPOTASSIUM CLORAZEPATE", "DIPOTASSIUM CLORAZEPATE"),   # 字尾詞在前：不動
    ("SALBUTAMOL SULFATE", "SALBUTAMOL"),
    ("LAPATINIB DITOSYLATE", "LAPATINIB DITOSYLATE"),         # 不在清單 → 原樣
    ("SORAFENIB TOSYLATE", "SORAFENIB"),
    ("HALOPERIDOL LACTATE", "HALOPERIDOL"),
    ("ISOSORBIDE DINITRATE", "ISOSORBIDE DINITRATE"),         # DINITRATE 不在清單
    ("MICONAZOLE NITRATE", "MICONAZOLE"),
    ("IPRATROPIUM BROMIDE", "IPRATROPIUM"),
    ("TROSPIUM CHLORIDE", "TROSPIUM"),
    ("POTASSIUM IODIDE", "POTASSIUM IODIDE"),                 # 例外：只剩金屬
    ("SUNITINIB MALATE", "SUNITINIB"),
    ("ESCITALOPRAM OXALATE", "ESCITALOPRAM"),
    ("SALMETEROL XINAFOATE", "SALMETEROL"),
    ("KETOROLAC TROMETHAMINE", "KETOROLAC"),
    ("DIATRIZOATE MEGLUMINE", "DIATRIZOATE"),
    ("CHLORHEXIDINE GLUCONATE", "CHLORHEXIDINE"),
    ("FESOTERODINE FUMARATE", "FESOTERODINE"),
    ("TOLTERODINE TARTRATE", "TOLTERODINE"),
    ("HYDROCODONE BITARTRATE", "HYDROCODONE"),
    ("SILDENAFIL CITRATE", "SILDENAFIL"),
    ("QUETIAPINE HEMIFUMARATE", "QUETIAPINE"),
    ("DOXAZOSIN MESYLATE", "DOXAZOSIN"),
    ("DIHYDROERGOTAMINE DIMESYLATE", "DIHYDROERGOTAMINE"),
    # T2a 寫法統一 + T2b 水合物
    ("LIDOCAINE HCL", "LIDOCAINE"),
    ("LIDOCAINE HCL MONOHYDRATE", "LIDOCAINE"),
    ("MINOCYCLINE (HCL)", "MINOCYCLINE"),
    ("NAPROXEN (SODIUM)", "NAPROXEN"),
    ("SALBUTAMOL SULPHATE", "SALBUTAMOL"),
    ("GALANTAMINE HBR", "GALANTAMINE"),
    ("FENOFIBRATE MICRONISED", "FENOFIBRATE"),
    ("FENOFIBRATE MICRONIZED", "FENOFIBRATE"),
    ("AMPICILLIN TRIHYDRATE", "AMPICILLIN"),
    ("AMOXICILLIN (TRIHYDRATE)", "AMOXICILLIN"),
    ("CEFADROXIL MONOHYDRATE", "CEFADROXIL"),
    ("CEPHRADINE (MONOHYDRATE)", "CEPHRADINE"),
    ("CALCIUM CHLORIDE DIHYDRATE", "CALCIUM CHLORIDE"),
    ("TETRACYCLINE TETRAHYDRATE", "TETRACYCLINE"),
    ("SODIUM THIOSULFATE PENTAHYDRATE", "SODIUM THIOSULFATE"),
    ("MAGNESIUM CHLORIDE HEXAHYDRATE", "MAGNESIUM CHLORIDE"),
    ("MAGNESIUM SULFATE HEPTAHYDRATE", "MAGNESIUM SULFATE"),
    ("ESTRADIOL HEMIHYDRATE", "ESTRADIOL"),
    ("PAROXETINE HCL HEMIHYDRATE", "PAROXETINE"),
    ("RISEDRONATE SODIUM SESQUIHYDRATE", "RISEDRONATE"),
    ("MEROPENEM HYDRATE", "MEROPENEM"),
    ("THEOPHYLLINE ANHYDROUS", "THEOPHYLLINE"),
    ("DEXTROSE HYDROUS", "DEXTROSE"),
    ("LYSINE L- HCL H2O", "LYSINE L-"),
    ("ESOMEPRAZOLE MAGNESIUM TRIHYDRATE", "ESOMEPRAZOLE"),
    # T2a 括號攤平（含 TFDA 的「(AS 鹽類)」寫法；酯類攤平後仍保留）
    ("GENTAMICIN (AS SULFATE)", "GENTAMICIN"),
    ("DICLOFENAC (AS SODIUM)", "DICLOFENAC"),
    ("BETAMETHASONE (AS DIPROPIONATE)", "BETAMETHASONE DIPROPIONATE"),
    ("BETAMETHASONE (AS VALERATE)", "BETAMETHASONE VALERATE"),
    ("DEXAMETHASONE (AS SODIUM PHOSPHATE)", "DEXAMETHASONE SODIUM PHOSPHATE"),
    ("VITAMIN A (PALMITATE)", "VITAMIN A PALMITATE"),
    ("TENOFOVIR DISOPROXIL (AS FUMARATE)", "TENOFOVIR DISOPROXIL"),
    # Phase 1 端到端實測補上的寫法（2026-10-20）
    ("WARFARIN SODIUM CLATHRATE", "WARFARIN"),
    ("ZOLPIDEM HEMITARTRATE", "ZOLPIDEM"),
    ("PIRENZEPINE 2HCL", "PIRENZEPINE"),
    ("METOCLOPRAMIDE (2HCL MONOHYDRATE)", "METOCLOPRAMIDE"),
    ("RIVASTIGMINE HYDROGEN TARTRATE", "RIVASTIGMINE"),
    ("ERYTHROMYCIN (ESTOLATE)", "ERYTHROMYCIN ESTOLATE"),
    ("SODIUM HYDROGEN CARBONATE", "SODIUM HYDROGEN CARBONATE"),
    # T1 (EQ TO …)：取括號外
    ("ACETAMINOPHEN (EQ TO PARACETAMOL)", "ACETAMINOPHEN"),
    ("SODIUM BICARBONATE ( EQ TO SODIUM HYDROGEN CARBONATE)", "SODIUM BICARBONATE"),
    ("FOSPHENYTOIN SODIUM (EQ TO PHENYTOIN SODIUM)", "FOSPHENYTOIN"),
])
def test_norm_ingredient_allowed_transforms(raw, expected):
    assert norm_ingredient(raw) == expected


@pytest.mark.parametrize("raw", [
    # 例外：鹽類詞本身就是有效成分
    "SODIUM BICARBONATE", "MAGNESIUM OXIDE", "POTASSIUM CHLORIDE", "SODIUM CHLORIDE",
    "CALCIUM GLUCONATE", "ZINC SULFATE", "LITHIUM CARBONATE",
    # 酯類保留差異
    "CLINDAMYCIN PHOSPHATE", "HALOPERIDOL DECANOATE", "ESTRADIOL VALERATE",
    "METOPROLOL SUCCINATE", "PALIPERIDONE PALMITATE", "BETAMETHASONE DIPROPIONATE",
    "DEXAMETHASONE SODIUM PHOSPHATE", "MEDROXYPROGESTERONE ACETATE",
    # 清單外修飾詞、T1 以外的括號（含拼錯的鹽類詞、多重說明）
    "METHIONINE DL-", "ALUMINUM HYDROXIDE (DRIED GEL)", "AMOXICILLIN (AS TRIHYDATE)",
    "CEPHRADINE (AS MIXTURE OF CEPHRADINE AND ARGININE)", "ASCORBIC ACID (VIT C)",
])
def test_norm_ingredient_preserves(raw):
    assert norm_ingredient(raw) == raw


@pytest.mark.parametrize("a, b", [
    ("ESOMEPRAZOLE MAGNESIUM", "OMEPRAZOLE MAGNESIUM"),
    ("LEVOFLOXACIN HEMIHYDRATE", "OFLOXACIN"),
    ("METHYLPREDNISOLONE", "PREDNISOLONE"),
    ("ENALAPRIL MALEATE", "ENALAPRILAT"),
    ("FOSPHENYTOIN SODIUM (EQ TO PHENYTOIN SODIUM)", "PHENYTOIN SODIUM"),
    ("SODIUM BICARBONATE", "BICARBONATE"),
    ("CLINDAMYCIN PHOSPHATE", "CLINDAMYCIN HYDROCHLORIDE"),
    ("HALOPERIDOL DECANOATE", "HALOPERIDOL LACTATE"),
])
def test_norm_ingredient_distinct_drugs_never_collide(a, b):
    assert norm_ingredient(a) != norm_ingredient(b)


def test_suffix_word_mid_name_is_not_stripped():
    # 清單詞出現在中段不剝；只剝尾端
    assert norm_ingredient("SODIUM PICOSULFATE") == "SODIUM PICOSULFATE"
    assert norm_ingredient("CALCIUM POLYCARBOPHIL") == "CALCIUM POLYCARBOPHIL"


@pytest.mark.parametrize("raw", ["", "   ", None, "A|B", "A+B"])
def test_norm_ingredient_unusable(raw):
    assert norm_ingredient(raw) is None


# ── 成分集合（A6）─────────────────────────────────────────────
def test_ingredient_set_is_order_and_duplicate_insensitive():
    a = norm_ingredient_set(split_tfda_ingredients("LISINOPRIL;;HYDROCHLOROTHIAZIDE"))
    b = norm_ingredient_set(split_tfda_ingredients("HYDROCHLOROTHIAZIDE ;; LISINOPRIL"))
    c = norm_ingredient_set(split_tfda_ingredients("LISINOPRIL DIHYDRATE;;LISINOPRIL;;HYDROCHLOROTHIAZIDE"))
    assert a == b == c == frozenset({"LISINOPRIL", "HYDROCHLOROTHIAZIDE"})


@pytest.mark.parametrize("raw", ["", ";;", "A;;;;B", "A;;  ;;B"])
def test_ingredient_set_empty_fragment_is_unusable(raw):
    assert norm_ingredient_set(split_tfda_ingredients(raw)) is None


# ── 品項 → 鍵或狀態（A7、A12）─────────────────────────────────
def test_item_key_for_matchable_drug():
    kind, key = item_us_label("製　劑", False, "膜衣錠", "AMLODIPINE BESYLATE")
    assert (kind, key) == ("key", "ORAL|AMLODIPINE")


def test_vaccine_license_is_matched():
    assert item_us_label("菌　疫", False, "注射劑", "X VACCINE")[0] == "key"


@pytest.mark.parametrize("lic, is_raw", [("原料藥", False), ("硬空膠囊", False), ("製　劑", True)])
def test_not_applicable_never_gets_key(lic, is_raw):
    assert item_us_label(lic, is_raw, "錠劑", "AMLODIPINE") == ("status", STATUS_NOT_APPLICABLE)


@pytest.mark.parametrize("lic", ["", None, "中藥", "其他"])
def test_unknown_license_type_is_unavailable_not_assumed_drug(lic):
    assert item_us_label(lic, False, "錠劑", "AMLODIPINE") == ("status", STATUS_UNAVAILABLE)


@pytest.mark.parametrize("form", ["（粉）", "液劑", "粉劑", "滴劑", "顆粒劑", "栓劑", "貼片劑",
                                  "口含錠", "", None, "從未見過的劑型"])
def test_ambiguous_or_unknown_form_is_no_match(form):
    assert item_us_label("製劑", False, form, "AMLODIPINE") == ("status", STATUS_NO_MATCH)
    # 控制組：同品項只把劑型改成錠劑 → 產鍵
    assert item_us_label("製劑", False, "錠劑", "AMLODIPINE")[0] == "key"


def test_injection_forms_share_group():
    k1 = item_us_label("製劑", False, "注射劑", "KETOROLAC TROMETHAMINE")[1]
    k2 = item_us_label("製劑", False, "凍晶注射劑", "KETOROLAC")[1]
    assert k1 == k2 == "INJECTION|KETOROLAC"


def test_query_term_is_deterministic():
    assert query_term(make_key("ORAL", ["LISINOPRIL", "HYDROCHLOROTHIAZIDE"])) == "HYDROCHLOROTHIAZIDE"


# ── 途徑（A11）────────────────────────────────────────────────
def test_route_in_group():
    assert route_in_group("INJECTION", ["INTRAVENOUS", "INTRAMUSCULAR"]) is True
    assert route_in_group("INJECTION", ["INTRAVENOUS", "ORAL"]) is False
    assert route_in_group("ORAL", ["TOPICAL"]) is False
    for missing in (None, [], [""], ["  "], "ORAL", [None]):
        assert route_in_group("ORAL", missing) is None


def test_injection_includes_iv_and_im_excludes_others():
    key = make_key("INJECTION", ["KETOROLAC"])
    iv = label(["KETOROLAC TROMETHAMINE"], route=["INTRAVENOUS"], bw="IV BW")
    im = label(["KETOROLAC TROMETHAMINE"], route=["INTRAMUSCULAR"], bw="IM BW")
    others = [label(["KETOROLAC TROMETHAMINE"], route=[r], bw="X")
              for r in ("ORAL", "TOPICAL", "OPHTHALMIC", "NASAL")]
    mixed = label(["KETOROLAC TROMETHAMINE"], route=["INTRAVENOUS", "ORAL"], bw="MIXED")
    res = run(key, [iv, im, mixed] + others)
    assert res["n"] == 2 and res["m"] == 2


def test_matched_candidate_with_missing_route_makes_key_unavailable():
    key = ORAL("AMLODIPINE")
    for bad in (None, [], ["  "]):
        res = run(key, [label(["AMLODIPINE BESYLATE"]), label(["AMLODIPINE BESYLATE"], route=bad)])
        assert res == {"s": "unavailable"}


def test_unmatched_candidate_with_missing_route_is_ignored():
    # route 缺失但成分不符 → 本來就不納入，不影響結果
    res = run(ORAL("AMLODIPINE"), [label(["AMLODIPINE BESYLATE"]), label(["WARFARIN"], route=None)])
    assert res["s"] == "nobw"


# ── 狀態判定（A1、A2、A3、A5、A13、A14）────────────────────────
WARFARIN_BW = "WARNING: BLEEDING RISK Warfarin sodium can cause major or fatal bleeding."


def test_a1_warfarin_bw_verbatim():
    key = ORAL("WARFARIN")
    src = label(["WARFARIN SODIUM"], bw=WARFARIN_BW)
    res = run(key, [src])
    assert res["s"] == "bw" and res["bw"] == [WARFARIN_BW]
    assert res["r"]["id"] == src["set_id"] and (res["n"], res["m"]) == (1, 1)


def test_a1_removing_only_bw_turns_nobw():
    res = run(ORAL("WARFARIN"), [label(["WARFARIN SODIUM"])])
    assert res["s"] == "nobw" and res["m"] == 0 and "bw" not in res


def test_a1_unrelated_bw_label_does_not_affect():
    res = run(ORAL("WARFARIN"), [label(["WARFARIN SODIUM"]), label(["HEPARIN SODIUM"], bw="X")])
    assert res["s"] == "nobw"


def test_a2_amlodipine_variants():
    key = ORAL("AMLODIPINE")
    base = [label(["AMLODIPINE BESYLATE"]), label(["AMLODIPINE MALEATE"])]
    assert run(key, base)["s"] == "nobw"
    other_route = label(["AMLODIPINE BESYLATE"], route=["INTRAVENOUS"], bw="IV")
    assert run(key, base + [other_route])["s"] == "nobw"
    same_route = label(["AMLODIPINE BESYLATE"], bw="ORAL BW")
    assert run(key, base + [same_route])["s"] == "bw"
    # 以另一種鹽登錄的 BW 仍要納入（雙方都轉換）
    assert run(key, base + [label(["AMLODIPINE BENZOATE"], bw="Y")])["s"] == "nobw"   # 酯類不併
    assert run(key, base + [label(["AMLODIPINE MESYLATE"], bw="Y")])["s"] == "bw"


def test_a2_duplicate_set_ids_is_unavailable():
    # 取回不完整（bulk 檔筆數不符）由 build_us_label 整批中止，見 test_build_us_label.py
    key = ORAL("AMLODIPINE")
    a = label(["AMLODIPINE BESYLATE"])
    assert compute_result(key, [a, dict(a)]) == {"s": "unavailable"}
    # 重複的是不相符的 label → 不影響
    w = label(["WARFARIN SODIUM"])
    assert compute_result(key, [a, w, dict(w)])["s"] == "nobw"


def test_index_by_ingredients_groups_salts_and_skips_non_rx():
    a = label(["AMLODIPINE BESYLATE"])
    b = label(["AMLODIPINE MALEATE"])
    otc = label(["AMLODIPINE BESYLATE"], product_type="HUMAN OTC DRUG")
    bad = label(["", "X"])
    idx = index_by_ingredients([a, b, otc, bad, {"set_id": "no-openfda"}])
    assert idx == {frozenset({"AMLODIPINE"}): [a, b]}


def test_a3_topical_excludes_oral_sources():
    oral_bw = label(["DICLOFENAC SODIUM"], route=["ORAL"], bw="NSAID CV/GI ORAL BW")
    gel = label(["DICLOFENAC SODIUM"], route=["TOPICAL"], bw="TOPICAL GEL BW")
    res = run(make_key("TOPICAL", ["DICLOFENAC"]), [oral_bw, gel])
    assert res["s"] == "bw" and res["bw"] == ["TOPICAL GEL BW"] and res["n"] == 1
    assert res["r"]["id"] == gel["set_id"]
    res_oral = run(ORAL("DICLOFENAC"), [oral_bw, gel])
    assert res_oral["bw"] == ["NSAID CV/GI ORAL BW"] and res_oral["r"]["id"] == oral_bw["set_id"]


def test_a5_ten_ingredient_combo():
    ings = [f"ING{i}" for i in range(10)]
    key = ORAL(*ings)
    assert run(key, [label(["ING0"], bw="X")])["s"] == "nomatch"
    assert run(key, [label(ings, bw="COMBO BW")])["s"] == "bw"
    assert run(key, [label(list(reversed(ings)))])["s"] == "nobw"


def test_a6_subset_and_superset_never_match():
    key_ab = ORAL("A", "B")
    assert run(key_ab, [label(["A"], bw="X")])["s"] == "nomatch"
    assert run(ORAL("A"), [label(["A", "B"], bw="X")])["s"] == "nomatch"
    assert run(key_ab, [label(["B", "A"], bw="X")])["s"] == "bw"


def test_a6_unresolvable_openfda_substance_is_not_partially_matched():
    # openFDA 側含無法處理的片段 → 該 label 的集合為 None，不可能等於 {A}
    assert run(ORAL("A"), [label(["A", ""], bw="X")])["s"] == "nomatch"


def test_a13_otc_excluded():
    rx = label(["NAPROXEN SODIUM"])
    otc = label(["NAPROXEN SODIUM"], bw="OTC", product_type="HUMAN OTC DRUG")
    assert run(ORAL("NAPROXEN"), [rx, otc])["s"] == "nobw"


def test_a14_warnings_and_cautions_never_used():
    src = label(["AMLODIPINE BESYLATE"], warnings_and_cautions=["Hypotension can occur."])
    res = run(ORAL("AMLODIPINE"), [src])
    assert res["s"] == "nobw"
    assert "Hypotension" not in repr(res)


def test_empty_results_is_nomatch():
    assert run(ORAL("AMLODIPINE"), []) == {"s": "nomatch"}


@pytest.mark.parametrize("bw", [[], [""], ["   "], "not-a-list", [None]])
def test_blank_or_malformed_bw_counts_as_no_bw(bw):
    src = label(["WARFARIN SODIUM"])
    src["boxed_warning"] = bw
    assert run(ORAL("WARFARIN"), [src])["s"] == "nobw"


# ── 代表仿單（A4、A9）────────────────────────────────────────
def test_representative_prefers_nda_over_newer_anda():
    nda = label(["X"], app="NDA012345", eff="20200101")
    anda = label(["X"], app="ANDA099999", eff="20260101")
    assert select_representative([anda, nda]) is nda


def test_representative_bla_counts_as_innovator():
    bla = label(["X"], app="BLA125000", eff="20190101")
    anda = label(["X"], app="ANDA1", eff="20260101")
    assert select_representative([anda, bla]) is bla


def test_representative_newest_among_ndas():
    old = label(["X"], app="NDA1", eff="20200101")
    new = label(["X"], app="NDA2", eff="20240101")
    assert select_representative([old, new]) is new


def test_representative_newest_anda_when_no_nda():
    a = label(["X"], eff="20210101")
    b = label(["X"], eff="20250101")
    assert select_representative([a, b]) is b


def test_representative_tie_broken_by_set_id_and_order_independent():
    a = label(["X"], eff="20250101", set_id="aaaaaaaa-0000-0000-0000-000000000000")
    b = label(["X"], eff="20250101", set_id="bbbbbbbb-0000-0000-0000-000000000000")
    c = label(["X"], eff="20230101")
    for _ in range(10):
        pool = [a, b, c]
        random.shuffle(pool)
        assert select_representative(pool) is a


def test_a9_counts_and_rep_bw():
    key = ORAL("X")
    nda = label(["X"], app="NDA1", eff="20200101", bw="NDA BW")
    a1 = label(["X"], bw="ANDA BW v1", eff="20250101")
    a2 = label(["X"], eff="20260101")
    res = run(key, [a1, a2, nda])
    assert (res["s"], res["n"], res["m"]) == ("bw", 3, 2)
    assert res["bw"] == ["NDA BW"] and "b" not in res


def test_a9_rep_without_bw_uses_bw_source_and_labels_it():
    key = ORAL("X")
    nda = label(["X"], app="NDA1", eff="20200101")
    a_old = label(["X"], bw="OLD BW", eff="20210101")
    a_new = label(["X"], bw="NEW BW", eff="20250101")
    for _ in range(5):
        pool = [nda, a_old, a_new]
        random.shuffle(pool)
        res = run(key, pool)
        assert res["r"]["id"] == nda["set_id"]
        assert res["bw"] == ["NEW BW"] and res["b"]["id"] == a_new["set_id"]
        assert (res["n"], res["m"]) == (3, 2)


def test_a4_pregnancy_from_rep_verbatim_multi_element():
    nda = label(["ISOTRETINOIN"], app="NDA1", bw="iPLEDGE",
                pregnancy=["8.1 Pregnancy Risk Summary", "Contraindicated."])
    res = run(ORAL("ISOTRETINOIN"), [nda])
    assert res["preg"] == {"st": "ok", "sec": "pregnancy",
                           "t": ["8.1 Pregnancy Risk Summary", "Contraindicated."]}


def test_a4_pregnancy_old_format_fallback():
    src = label(["X"], pregnancy=["  "], teratogenic_effects=["Pregnancy Category X."])
    assert run(ORAL("X"), [src])["preg"] == {"st": "ok", "sec": "teratogenic_effects",
                                              "t": ["Pregnancy Category X."]}


def test_a4_pregnancy_extracted_from_section_8_when_field_missing():
    src = label(["WARFARIN SODIUM"], bw="BLEEDING", use_in_specific_populations=[USP])
    assert run(ORAL("WARFARIN"), [src])["preg"] == {
        "st": "ok", "sec": "8.1 Pregnancy", "t": ["8.1 Pregnancy Risk Summary Data are limited."]}
    # pregnancy 欄位優先於擷取；擷取失敗才用舊格式 teratogenic_effects
    both = label(["X"], pregnancy=["Field."], use_in_specific_populations=[USP])
    assert run(ORAL("X"), [both])["preg"]["t"] == ["Field."]
    no_end = label(["X"], use_in_specific_populations=["8.1 Pregnancy no end"],
                   teratogenic_effects=["Category X."])
    assert run(ORAL("X"), [no_end])["preg"]["sec"] == "teratogenic_effects"


def test_a10_sections_only_from_rep():
    nda = label(["X"], app="NDA1")
    anda = label(["X"], pregnancy=["ANDA pregnancy text"], nursing_mothers=["ANDA nursing"])
    res = run(ORAL("X"), [nda, anda])
    assert res["preg"] == {"st": "none"} and res["lact"] == {"st": "none"}
    assert "ANDA" not in repr(res)


# ── 哺乳 8.2 擷取（A4）────────────────────────────────────────
USP = ("8 USE IN SPECIFIC POPULATIONS Infertility: see ( 8.3 ). "
       "8.1 Pregnancy Risk Summary Data are limited. "
       "8.2 Lactation Risk Summary Metformin is present in human milk [see Data ( 8.3 )]. "
       "Clinical Considerations none. "
       "8.3 Females and Males of Reproductive Potential Discuss. "
       "8.4 Pediatric Use Safety established.")


def test_extract_lactation_between_headings():
    assert extract_lactation([USP]) == (
        "8.2 Lactation Risk Summary Metformin is present in human milk [see Data ( 8.3 )]. "
        "Clinical Considerations none.")


def test_extract_lactation_ends_at_84_when_no_83():
    t = "8.1 Pregnancy x. 8.2 Lactation Risk Summary y. 8.4 Pediatric Use z."
    assert extract_lactation([t]) == "8.2 Lactation Risk Summary y."


def test_extract_lactation_spans_array_elements():
    assert extract_lactation(["8.2 Lactation", "Risk Summary y.", "8.3 Females z"]) == \
        "8.2 Lactation\nRisk Summary y."


@pytest.mark.parametrize("usp", [
    ["8.1 Pregnancy x. 8.2 Lactation Risk Summary y. no end heading"],   # 沒有終點
    ["8.1 Pregnancy x. Lactation: see ( 8.2 ). 8.4 Pediatric Use z."],  # 沒有起點
    [], None, ["   "],
])
def test_extract_lactation_fails_without_clear_bounds(usp):
    assert extract_lactation(usp) is None


def test_lactation_section_fallbacks():
    key = ORAL("X")
    assert run(key, [label(["X"], use_in_specific_populations=[USP])])["lact"]["sec"] == "8.2 Lactation"
    assert run(key, [label(["X"], nursing_mothers=["Caution."])])["lact"] == \
        {"st": "ok", "sec": "nursing_mothers", "t": ["Caution."]}
    no_end = ["8.2 Lactation Risk Summary y. no end"]
    assert run(key, [label(["X"], use_in_specific_populations=no_end)])["lact"] == {"st": "unextractable"}
    # 切不出 8.2 但有舊格式 nursing_mothers → 採用舊格式
    assert run(key, [label(["X"], use_in_specific_populations=no_end,
                           nursing_mothers=["Old."])])["lact"]["sec"] == "nursing_mothers"
    assert run(key, [label(["X"])])["lact"] == {"st": "none"}


# ── 資料契約（§6.3）──────────────────────────────────────────
@pytest.mark.parametrize("bad", [
    None, {}, {"s": "maybe"},
    {"s": "nomatch", "n": 1},
    {"s": "bw", "n": 1, "m": 1, "r": {"id": "x"}},                  # bw 缺原文
    {"s": "bw", "n": 1, "m": 2, "r": {"id": "x"}, "bw": ["t"]},     # m > n
    {"s": "nobw", "n": 1, "m": 0, "r": {"id": "x"}, "bw": ["t"]},   # ② 卻帶 BW
    {"s": "nobw", "n": 1, "m": 0, "r": {}},                         # 缺來源
])
def test_validate_result_rejects_contract_violations(bad):
    assert validate_result(bad) is False


def test_rules_version_is_positive_int():
    assert isinstance(MATCH_RULES_VERSION, int) and MATCH_RULES_VERSION >= 1


def test_frontend_rules_version_in_sync():
    # 前端常數與 Python 規則版本不同步 → 所有卡片永遠顯示「不可用」（或更糟：跨代誤讀）
    import re
    from pathlib import Path
    src = (Path(__file__).resolve().parent.parent / "app.js").read_text(encoding="utf-8")
    m = re.search(r"const US_LABEL_RULES_VERSION = (\d+);", src)
    assert m and int(m.group(1)) == MATCH_RULES_VERSION
