"""
People in the register are told apart by name AND company. Two different
men called Abubakar Musa at two different companies must never share a
record, a timeline or a page; "Alhaji Abubakar Musa" and "ABUBAKAR MUSA"
at the same company are one person.
"""
from backend.app.services import analytics
from backend.app.services import register_quality as q


def psc(name, company, pct, date):
    return {"Person Name": name, "Company": company, "Percentage": pct, "Date": date}


class TestHolderIdentity:
    def test_same_name_at_different_companies_stays_separate(self):
        a = q.holder_key(psc("Abubakar Musa", "Kano Flour Mills Plc", "12%", ""))
        b = q.holder_key(psc("Abubakar Musa", "Sokoto Cement Ltd", "8%", ""))
        assert a != b

    def test_honorific_case_and_company_suffix_variants_merge(self):
        keys = {q.holder_key(psc(n, c, "", "")) for n, c in (
            ("Abubakar Musa", "Kano Flour Mills Plc"),
            ("Alhaji Abubakar Musa", "Kano Flour Mills"),
            ("ABUBAKAR MUSA", "KANO FLOUR MILLS LIMITED"),
            ("Abubakar  Musa", "Kano Flour Mills Nigeria Plc"),
        )}
        assert len(keys) == 1

    def test_annotate_exports_the_holder_key(self):
        r = q.annotate([psc("Alhaji Abubakar Musa", "Kano Flour Mills Plc", "", "")])[0]
        assert r["Holder Key"] == "abubakar musa|kano flour mills"


class TestTimeline:
    def test_two_abubakar_musas_get_two_timelines(self):
        rows = [psc("Abubakar Musa", "Kano Flour Mills Plc", "12%", "2026-09-01"),
                psc("Abubakar Musa", "Sokoto Cement Ltd", "8%", "2026-09-02")]
        assert len(analytics.psc_timeline(rows)) == 2

    def test_variants_of_one_person_at_one_company_share_a_timeline(self):
        rows = [psc("Alhaji Abubakar Musa", "Kano Flour Mills Plc", "12%", "2026-09-01"),
                psc("Abubakar Musa", "Kano Flour Mills", "15%", "2026-10-01")]
        timeline = analytics.psc_timeline(rows)
        assert len(timeline) == 1 and timeline[0]["change"] == 3.0
