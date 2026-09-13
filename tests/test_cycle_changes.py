"""
The "what changed this cycle" diff must be pure, deterministic, and honest
about identity: entities key on names, PSC rows on (person, company),
articles on URL. It powers changes.json, which the dashboard renders as a
panel -- a wrong diff here publishes a wrong claim about what is new.
"""
from run_pipeline import compute_cycle_changes


def _psc(person, company, pct=""):
    return {"Person Name": person, "Company": company, "Percentage": pct}


class TestEntityDiff:
    def test_new_companies_and_people(self):
        out = compute_cycle_changes(
            {"companies": [{"Company": "Dangote Cement Plc"}], "people": []},
            {"companies": [{"Company": "Dangote Cement Plc"}, {"Company": "BUA Foods Plc"}],
             "people": [{"Name": "Aliko Dangote"}]},
        )
        assert out["new_companies"] == ["BUA Foods Plc"]
        assert out["new_people"] == ["Aliko Dangote"]
        assert out["counts"]["new_companies"] == 1

    def test_first_run_diffs_against_empty(self):
        out = compute_cycle_changes(None, {"companies": [{"Company": "A"}]})
        assert out["new_companies"] == ["A"]

    def test_blank_names_are_ignored(self):
        out = compute_cycle_changes({}, {"companies": [{"Company": "  "}, {"Company": ""}]})
        assert out["new_companies"] == []


class TestPscDiff:
    def test_added_removed_and_percentage_change(self):
        prev = {"psc": [_psc("A", "X", "10"), _psc("B", "Y", "20")]}
        curr = {"psc": [_psc("A", "X", "12.5%"), _psc("C", "Z", "5")]}
        out = compute_cycle_changes(prev, curr)
        assert out["psc_added"] == [{"person": "C", "company": "Z"}]
        assert out["psc_removed"] == [{"person": "B", "company": "Y"}]
        assert out["psc_changed"] == [{"person": "A", "company": "X", "from": 10.0, "to": 12.5}]

    def test_identity_is_person_and_company_case_insensitive(self):
        out = compute_cycle_changes(
            {"psc": [_psc("Ada Obi", "Acme Ltd", "10")]},
            {"psc": [_psc("ADA OBI", "acme ltd", "10")]},
        )
        assert out["psc_added"] == []
        assert out["psc_removed"] == []

    def test_unparseable_percentages_do_not_report_a_change(self):
        out = compute_cycle_changes(
            {"psc": [_psc("A", "X", "n/a")]},
            {"psc": [_psc("A", "X", "15")]},
        )
        assert out["psc_changed"] == []

    def test_same_percentage_different_formatting_is_no_change(self):
        out = compute_cycle_changes(
            {"psc": [_psc("A", "X", "12.5")]},
            {"psc": [_psc("A", "X", "12.5%")]},
        )
        assert out["psc_changed"] == []


class TestHighRiskArticles:
    def test_only_new_urls_at_or_above_the_threshold(self):
        prev = {"articles": [{"URL": "u1", "Title": "old", "Risk Score": 90}]}
        curr = {"articles": [
            {"URL": "u1", "Title": "old", "Risk Score": 90},       # already published
            {"URL": "u2", "Title": "hot", "Risk Score": "82"},     # new, high
            {"URL": "u3", "Title": "mild", "Risk Score": 40},      # new, low
            {"URL": "u4", "Title": "edge", "Risk Score": 70},      # threshold inclusive
        ]}
        out = compute_cycle_changes(prev, curr)
        assert [e["url"] for e in out["new_high_risk"]] == ["u2", "u4"]
        assert out["new_high_risk"][0]["risk"] == 82.0

    def test_sorted_worst_first(self):
        curr = {"articles": [{"URL": "a", "Title": "t", "Risk Score": 71},
                             {"URL": "b", "Title": "t", "Risk Score": 95}]}
        out = compute_cycle_changes({}, curr)
        assert [e["risk"] for e in out["new_high_risk"]] == [95.0, 71.0]


def test_payload_is_deterministic():
    prev = {"companies": [{"Company": "B"}, {"Company": "A"}]}
    curr = {"companies": [{"Company": "D"}, {"Company": "C"},
                          {"Company": "B"}, {"Company": "A"}]}
    assert compute_cycle_changes(prev, curr) == compute_cycle_changes(prev, curr)
    assert compute_cycle_changes(prev, curr)["new_companies"] == ["C", "D"]
