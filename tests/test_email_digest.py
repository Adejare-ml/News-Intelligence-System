"""
The Morning Brief email edition. Fixtures are the 29-31 Oct 2026 rows that
exposed the old email's faults: a stale IPO lead, a reposted story counted
twice, and "welcomed" rewritten as "endorsed".
"""
import json
from datetime import datetime

from backend.app.services import email_digest as ed

NOW = datetime(2026, 11, 1, 7, 0)


def row(id, title, source, time, summary="", level="Low", score=20, importance=40, event="Other",
        url=None, entities="", facts="", why=""):
    return {
        "ID": id, "Time": time, "Title": title, "Source": source,
        "URL": url or f"https://example.ng/{id}", "Category": "Company", "Risk Score": score,
        "Summary": summary or title + ".", "Status": "Unread", "Engine": "gemini", "Event Type": event,
        "Risk Level": level, "Importance": importance, "Entities": entities,
        "Key Facts": facts, "Why It Matters": why,
    }


OPAY = [
    row(10631, "OPay lists on NYSE, raises $304m in IPO at $4 billion valuation", "Premium Times Nigeria",
        "Fri, 30 Oct 2026 17:42:00 GMT", importance=85, event="Earnings", entities="OPay"),
    row(10569, "OPay raises $304m in NYSE debut, targets Nigerian investors", "The Punch",
        "2026-10-30T23:35:00Z", importance=80, event="Earnings", entities="OPay"),
    row(10583, "OPay postpones planned NYSE listing, says Nigerian operations unaffected", "The Guardian Nigeria News",
        "Sat, 31 Oct 2026 04:00:00 GMT", importance=80, event="Restructuring", entities="OPay"),
    row(10613, "OPay withdraws planned $304m US IPO over foreign regulatory inquiry", "Premium Times Nigeria",
        "Sat, 31 Oct 2026 13:54:00 GMT", summary="OPay has withdrawn its plans for a $304 million IPO in the United States.",
        level="Medium", score=65, importance=85, event="Restructuring", entities="OPay"),
]
OTHERS = [
    row(10643, "Makinde approves ₦4.6bn compensation for Circular road-affected property owners", "businessday",
        "2026-10-31 08:18:48", summary="Governor Makinde has approved ₦4.6 billion in compensation for owners affected by the Circular road project.",
        importance=50, event="Procurement", entities="Oyo State Government",
        facts="Makinde approved ₦4.6 billion | It covers Circular road property owners"),
    row(10592, "Tinubu welcomes Airtel's open network launch", "Premium Times Nigeria", "Sat, 31 Oct 2026 09:00:00 GMT",
        summary="President Tinubu has welcomed the launch of Airtel's open network.", entities="Airtel"),
    row(10600, "Nigeria becomes 34th AU member to ratify African Medicine Treaty", "thisdaylive", "2026-10-31T01:16:00Z",
        summary="Nigeria has ratified the African Medicine Treaty, becoming the 34th African Union member state to do so.",
        entities="NAFDAC"),
    row(10501, "EFCC recovers N1.05bn for disengaged Adamawa teachers", "The Punch", "2026-10-31T06:32:00Z",
        url="https://punchng.com/efcc-a/", event="Corruption", entities="EFCC"),
    row(10502, "EFCC recovers N1.05bn for\xa0 disengaged Adamawa teachers", "The Punch", "2026-10-31T06:37:00Z",
        url="https://punchng.com/efcc-b/", event="Corruption", entities="EFCC"),
]


LAST = {"through_id": 10000, "built_at": "2026-10-30 07:00:00"}


def edition(rows=None, previous=LAST, llm=None, psc=()):
    return ed.build_edition(rows if rows is not None else OPAY + OTHERS, list(psc), NOW, previous, llm)


class TestThreads:
    def test_ipo_reports_are_one_story_led_by_the_newest(self):
        e = edition()
        opay = next(c for c in e["cards"] if "OPay" in c["headline"])
        assert opay["headline"].startswith("OPay withdraws")
        assert "Reports differ" in opay["flags"]
        assert len(opay["timeline"]) == 4 and opay["timeline"][-1].endswith("(lead report)")
        assert {a["outlet"] for a in opay["also_reported"]} == {"The Guardian", "Punch"}
        moves = next(a for a in opay["analysis"] if a.startswith("Reports differ"))
        assert moves.index("completed") < moves.index("postponed") < moves.index("withdrawn")

    def test_a_reposted_story_is_counted_once(self):
        e = edition()
        efcc = [c for c in e["cards"] + e["also"] if "EFCC" in (c.get("headline") or c.get("text"))]
        assert len(efcc) == 1
        card = next((c for c in e["cards"] if "EFCC" in c["headline"]), None)
        assert card is None or (card["timeline"] == [] and "Developing" not in card["flags"])

    def test_a_recovery_is_not_labelled_an_allegation(self):
        e = edition()
        card = next(c for c in e["cards"] if "EFCC" in c["headline"])
        assert not any(f.startswith("Allegation") for f in card["flags"])

    def test_two_stories_about_one_agency_stay_apart(self):
        ent = "Economic and Financial Crimes Commission"
        rows = [
            row(20003, "EFCC returns N114m recovered from cyber fraud to microfinance bank", "The Punch",
                "2026-10-31T06:00:00Z", entities=ent),
            row(20004, "EFCC recovers N1.05bn for disengaged Adamawa teachers", "The Punch",
                "2026-10-31T07:00:00Z", entities=ent),
        ]
        assert edition(rows)["stats"]["stories"] == 2

    def test_generic_entities_do_not_merge_stories(self):
        rows = [
            row(20001, "Tinubu signs tax bill", "The Punch", "2026-10-31T06:00:00Z", entities="Bola Tinubu"),
            row(20002, "Tinubu meets governors on security", "The Punch", "2026-10-31T06:10:00Z", entities="Bola Tinubu"),
        ]
        assert edition(rows)["stats"]["stories"] == 2


class TestWindow:
    def test_consecutive_editions_neither_miss_nor_repeat(self):
        # Row IDs follow insertion order, not publication time (10569 was
        # published after 10631), so the cut is by ID.
        rows = OPAY + OTHERS
        first = edition([r for r in rows if r["ID"] <= 10600])
        second = ed.build_edition(rows, [], NOW, {"through_id": first["through_id"], "built_at": first["built_at"]})
        assert first["through_id"] == 10600
        assert first["stats"]["reports"] + second["stats"]["reports"] == len(rows)
        # The IPO story is shown again because new reports joined it, led by the newest.
        assert second["cards"][0]["headline"].startswith("OPay withdraws")

    def test_first_edition_looks_back_one_day(self):
        old = row(20001, "Old story about cement prices", "The Punch", "2026-10-29T06:00:00Z")
        assert edition([old], previous=None)["stats"]["stories"] == 0
        recent = row(20002, "New story about cement prices", "The Punch", "2026-10-31T12:00:00Z")
        assert edition([old, recent], previous=None)["stats"]["stories"] == 1


class TestRanking:
    def test_high_risk_leads_and_sets_the_subject(self):
        alert = row(20009, "Senate probes $123bn oil fund shortfall", "The Punch", "2026-10-31T10:00:00Z",
                    level="High", score=75, importance=60, event="Audit")
        e = edition(OPAY + OTHERS + [alert])
        assert e["cards"][0]["headline"].startswith("Senate probes")
        assert e["subject"].startswith("AURA alert · Sun 1 Nov · Senate probes")
        assert e["stats"]["risk_alerts"] == 1

    def test_counts_match_the_cards(self):
        e = edition()
        assert e["stats"]["public_money"] == sum(1 for c in e["cards"] if c["theme"] == "Public money") + \
            sum(1 for a in e["also"] if a["theme"] == "Public money")
        assert "ownership (PSC) disclosures" in e["nothing_in"]


def model(payload):
    return lambda prompt: (json.dumps(payload), "gemini")


class TestModelLines:
    def test_good_lines_are_kept_with_their_citation(self):
        e = edition(llm=model({
            "overview": [{"text": "OPay withdrew its planned $304 million IPO in the United States.", "card": 1}],
            "insights": [],
        }))
        assert e["overview"][0]["text"].startswith("OPay withdrew")
        assert e["overview"][0]["outlet"] == "Premium Times"
        assert e["engines"]["digest"] == "gemini"

    def test_endorsed_is_not_welcomed(self):
        airtel = next(c for c in edition()["cards"] + [] if "Airtel" in c["headline"])
        e = edition(llm=model({"overview": [{"text": "President Tinubu endorsed Airtel's open network launch.",
                                             "card": airtel["n"]}]}))
        assert all("endorsed" not in o["text"] for o in e["overview"])
        assert e["health"]["overview_dropped"] == 1

    def test_invented_figure_and_name_are_dropped(self):
        e = edition(llm=model({"overview": [
            {"text": "Oyo Governor Seyi Makinde approved ₦5.2 billion for Circular road owners.", "card": 2},
        ]}))
        assert all("5.2" not in o["text"] and "Seyi" not in o["text"] for o in e["overview"])

    def test_stale_lead_needs_an_earlier_cue(self):
        stale = {"text": "OPay listed on the NYSE and raised $304m.", "card": 1}
        e = edition(llm=model({"overview": [stale]}))
        assert all(not o["text"].startswith("OPay listed") for o in e["overview"])
        framed = {"text": "OPay withdrew its $304m IPO; earlier reports said it had listed on the NYSE.", "card": 1}
        e = edition(llm=model({"overview": [framed]}))
        assert e["overview"][0]["text"].startswith("OPay withdrew")

    def test_unattributed_accusation_is_dropped(self):
        e = edition(llm=model({"insights": [
            {"kind": "pattern", "text": "OPay and Oyo show fraud in public money.", "cards": [1, 2]},
        ]}))
        assert all("fraud" not in i["text"] for i in e["insights"])

    def test_pattern_needs_two_cards(self):
        e = edition(llm=model({"insights": [{"kind": "pattern", "text": "OPay withdrew its IPO.", "cards": [1]}]}))
        assert all(i["label"] != "Across stories" for i in e["insights"])

    def test_broken_model_output_never_blocks_the_email(self):
        for bad in ("not json", "{\"overview\": 5}", ""):
            e = ed.build_edition(OPAY + OTHERS, [], NOW, LAST, lambda p, bad=bad: (bad, "ollama"))
            assert 3 <= len(e["overview"]) <= 5

        def boom(prompt):
            raise TimeoutError
        e = ed.build_edition(OPAY + OTHERS, [], NOW, LAST, boom)
        assert len(e["overview"]) >= 3 and e["health"]["error"] == "TimeoutError"

    def test_conflict_falls_back_to_a_plain_reports_differ_line(self):
        e = edition()
        assert e["insights"][0]["label"] == "Reports differ"
        assert e["insights"][0]["cards"] == [1]


class TestCardContent:
    def test_key_facts_and_why_come_from_the_stored_row(self):
        e = edition()
        oyo = next(c for c in e["cards"] if "Makinde" in c["headline"])
        assert oyo["key_facts"] == ["Makinde approved ₦4.6 billion", "It covers Circular road property owners"]
        assert oyo["theme"] == "Public money"

    def test_google_news_rows_say_only_the_headline_was_read(self):
        r = row(20005, "Firm X wins N2bn contract", "Premium Times Nigeria", "2026-10-31T06:00:00Z",
                url="https://news.google.com/rss/articles/abc")
        assert edition([r])["cards"][0]["headline_only"] is True

    def test_terms_are_defined_when_used(self):
        terms = {t["term"] for t in edition()["terms"]}
        assert {"NYSE", "IPO", "EFCC"} & terms

    def test_ownership_lines_need_a_source_and_this_edition(self):
        psc = [
            {"Person Name": "A B", "Company": "C Plc", "Percentage": "12%", "Source URL": "https://punchng.com/x",
             "Publisher": "The Punch", "Date": "2026-10-31", "Quarantined": False},
            {"Person Name": "D E", "Company": "F Ltd", "Percentage": "", "Source URL": "",
             "Publisher": "", "Date": "2026-10-31"},
            {"Person Name": "G H", "Company": "I Ltd", "Percentage": "6%", "Source URL": "https://x.ng/old",
             "Publisher": "Vanguard", "Date": "2026-09-01"},
        ]
        e = edition(psc=psc)
        assert [p["text"] for p in e["psc"]] == ["A B reported as holding 12% of C Plc"]
        assert e["stats"]["ownership"] == 1 and "PSC" in {t["term"] for t in e["terms"]}

    def test_quiet_edition(self):
        e = edition([])
        assert e["cards"] == [] and e["subject"].endswith("A quiet morning")
