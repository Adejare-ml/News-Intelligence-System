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
        assert "ownership and control reports" in e["nothing_in"]


def model(payload):
    return lambda prompt: (json.dumps(payload), "gemini")


class TestModelLines:
    def test_good_lines_are_kept_with_their_citation(self):
        oyo = next(c for c in edition()["cards"] if "Makinde" in c["headline"])
        e = edition(llm=model({
            "overview": [{"text": "Governor Makinde approved ₦4.6 billion for Circular road property owners.", "card": oyo["n"]}],
            "insights": [],
        }))
        line = next(o for o in e["overview"] if o["card"] == oyo["n"])
        assert line["text"].startswith("Governor Makinde approved") and line["outlet"] == "BusinessDay"
        assert e["engines"]["digest"] == "gemini"

    def test_a_contested_story_is_told_in_the_outlets_words(self):
        e = edition(llm=model({"overview": [{"text": "OPay withdrew its planned $304 million IPO.", "card": 1}]}))
        assert e["overview"][0]["text"] == "OPay has withdrawn its plans for a $304 million IPO in the United States."
        assert e["health"]["overview_own_words"] == 1

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
        card = card_of(OPAY)
        assert not ed.check_line("OPay listed on the NYSE and raised $304m.", [card])
        assert ed.check_line("Earlier reports said OPay listed on the NYSE; it has now withdrawn its $304m IPO.", [card])

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
        lookalike = row(20006, "Firm Y wins N3bn contract", "The Punch", "2026-10-31T06:00:00Z",
                        url="https://punchng.com/news.google.com-mirror/")
        assert edition([lookalike])["cards"][0]["headline_only"] is False

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


# --- adversarial review findings (Nov 2026) -------------------------------------------------

import pytest  # noqa: E402

T = "2026-10-31T06:00:00Z"


class TestStages:
    @pytest.mark.parametrize("headline, stage", [
        ("Court discharges, acquits ex-Kogi governor Yahaya Bello of ₦80bn money laundering case", "cleared"),
        ("Appeal Court sets aside ex-minister's conviction", "cleared"),
        ("Reps panel clears PINL, Okunbor of corruption allegations", "cleared"),
        ("Court convicts ex-pension boss Maina", "ruled"),
        ("Court jails BDC operators over unlicensed forex activities", "ruled"),
        ("Appeal Court affirms Prof Gombe as national leader of SDP", "decided"),
        ("EFCC arrests ex-Accountant-General over ₦109bn", "under_investigation"),
        ("EFCC detains ex-NNPC GMD", "under_investigation"),
        ("CBN cuts bank charges on electronic transfers", "unclear"),
        ("MTN cuts data charges by 20%", "unclear"),
        ("Dangote names new MD in charge of refinery", "unclear"),
        ("Lagos approves new industrial park in Epe", "approved"),
        ("NUPENG begins industrial action over unpaid wages", "unclear"),
        ("FG, Bi-Courtney end 18-year MMA2 dispute", "unclear"),
        ("Agbebaku resigns", "unclear"),
        ("Senate approves N54.9trn 2027 budget after weeks of delay", "approved"),
        ("CBN new daily cash withdrawal limits take effect", "unclear"),
        ("NAFDAC approves clinical trial for malaria vaccine", "approved"),
        ("FG will not abandon Akwanga-Jos-Gombe road project – APC national chairman", "unclear"),
        ("Police say Zenith Bank cashier has not been charged over missing ₦40m", "unclear"),
    ])
    def test_whole_words_and_court_outcomes(self, headline, stage):
        assert ed.stage_of(headline) == stage

    def test_an_acquittal_never_says_no_court_has_ruled(self):
        r = row(30001, "Court discharges, acquits ex-Kogi governor Yahaya Bello of ₦80bn money laundering case",
                "The Punch", T, level="High", score=80, entities="Yahaya Bello")
        card = edition([r])["cards"][0]
        assert not any("no court has ruled" in a for a in card["analysis"])
        assert not any(f.startswith("Allegation") for f in card["flags"])

    def test_a_delay_in_the_wording_is_not_a_reversal(self):
        rows = [
            row(30002, "Senate approves N54.9trn 2027 budget", "The Punch", T, entities="Senate"),
            row(30003, "Senate approves N54.9trn 2027 budget after weeks of delay", "Vanguard News",
                "2026-10-31T07:00:00Z", entities="Senate"),
        ]
        card = edition(rows)["cards"][0]
        assert "Reports differ" not in card["flags"]


class TestThreadsReview:
    def test_two_defendants_charged_by_one_agency_stay_apart(self):
        efcc = "Economic and Financial Crimes Commission"
        rows = [
            row(30010, "EFCC arraigns ex-NIMASA DG Peterside over N8bn fraud", "Vanguard News", T,
                entities=f"{efcc}|Dakuku Peterside", facts="Peterside is accused of diverting N8bn"),
            row(30011, "EFCC arraigns ex-Kogi governor Yahaya Bello over N80bn fraud", "The Punch",
                "2026-10-31T07:00:00Z", entities=f"{efcc}|Yahaya Bello"),
        ]
        e = edition(rows)
        assert e["stats"]["stories"] == 2
        bello = next(c for c in e["cards"] if "Bello" in c["headline"])
        assert not any("Peterside" in f for f in bello["key_facts"])

    @pytest.mark.parametrize("a, b", [
        ("Tinubu signs tax bill into law", "Tinubu signs insurance bill into law"),
        ("Dangote Refinery cuts petrol price", "Dangote Cement cuts cement price"),
    ])
    def test_short_lookalike_headlines_stay_apart(self, a, b):
        ents = {"Dangote Refinery": "Dangote Petroleum Refinery", "Dangote Cement": "Dangote Cement"}
        rows = [row(30020, a, "The Punch", T, entities=next((v for k, v in ents.items() if a.startswith(k)), "Bola Tinubu")),
                row(30021, b, "Vanguard News", T, entities=next((v for k, v in ents.items() if b.startswith(k)), "Bola Tinubu"))]
        assert edition(rows)["stats"]["stories"] == 2

    def test_a_differently_worded_reversal_joins_its_story(self):
        rows = [
            row(30030, "OPay debuts on New York Stock Exchange", "The Punch", "2026-10-30T18:00:00Z", entities="OPay"),
            row(30031, "OPay withdraws planned IPO", "Premium Times Nigeria", T, entities="OPay"),
        ]
        e = edition(rows)
        assert e["stats"]["stories"] == 1
        assert e["cards"][0]["headline"] == "OPay withdraws planned IPO"
        assert "Reports differ" in e["cards"][0]["flags"]

    def test_a_repost_keeps_the_copy_aura_read(self):
        rows = [
            row(30040, "Zenith Bank posts N1.2trn profit", "The Punch", "2026-10-31T06:32:00Z",
                url="https://punchng.com/zenith", facts="Profit was N1.2trn | Up 40% on last year", why="Largest bank profit."),
            row(30041, "Zenith Bank posts N1.2trn profit", "The Punch", "2026-10-31T06:37:00Z",
                url="https://news.google.com/rss/articles/zz"),
        ]
        rows[0]["Detail"] = "full"
        card = edition(rows)["cards"][0]
        assert card["source"]["url"] == "https://punchng.com/zenith"
        assert card["key_facts"] and card["headline_only"] is False

    def test_a_repost_of_an_emailed_story_is_not_news(self):
        sent = row(30050, "CBN sanctions five banks", "The Punch", "2026-10-31T05:00:00Z", url="https://punchng.com/cbn",
                   level="High", score=80)
        repost = row(30052, "CBN sanctions five banks", "The Punch", "2026-10-31T06:00:00Z",
                     url="https://news.google.com/rss/articles/cbn", level="High", score=80)
        other = row(30053, "MTN raises data tariffs", "The Punch", "2026-10-31T06:30:00Z")
        e = ed.build_edition([sent, repost, other], [], NOW, {"through_id": 30051, "built_at": "2026-10-31 05:30:00"})
        assert [c["headline"] for c in e["cards"]] == ["MTN raises data tariffs"]
        assert not e["subject"].startswith("AURA alert")


def card_of(rows):
    """One card, with the private fields the validator reads."""
    reports = sorted((ed.report_from_row(r) for r in rows), key=lambda r: (r.time, r.id))
    return ed.build_card(1, reports)


def cards_for(rows):
    return lambda payload: ed.build_edition(rows, [], NOW, LAST, model(payload))


class TestModelLinesReview:
    def test_one_cards_charge_is_not_pinned_on_another_cards_person(self):
        rows = [
            row(30060, "EFCC probes alleged ₦3bn fraud at Delta pension board", "The Punch", T,
                level="High", score=80, entities="EFCC|Delta State Pension Board"),
            row(30061, "Access Holdings appoints Bolaji Agbede as group CEO", "BusinessDay", T,
                importance=70, event="Appointment", entities="Access Holdings|Bolaji Agbede"),
        ]
        e = cards_for(rows)({"insights": [{"kind": "pattern", "cards": [1, 2], "text":
            "Bolaji Agbede of Access Holdings faces fraud claims as the EFCC probes ₦3bn, reports said."}]})
        assert all("Agbede" not in i["text"] for i in e["insights"])

    def test_roles_within_one_card_are_not_swapped(self):
        r = row(30062, "Court grants Bello bail as EFCC arraigns five directors of Alpha Ltd", "The Punch", T,
                entities="Yahaya Bello|Alpha Ltd|EFCC")
        swapped = "Yahaya Bello and five Alpha Ltd directors were arraigned by the EFCC."
        assert not ed.check_line(swapped, [card_of([r])])
        assert ed.check_line("EFCC arraigned five directors of Alpha Ltd.", [card_of([r])])
        e = cards_for([r])({"overview": [{"card": 1, "text": swapped}]})
        assert all("arraigned" not in o["text"] for o in e["overview"])

    @pytest.mark.parametrize("headline, line", [
        ("Senator Ibrahim Musa denies receiving ₦500m from NDDC contractor",
         "Senator Ibrahim Musa admitted receiving ₦500m from an NDDC contractor."),
        ("Police say Zenith Bank cashier has not been charged over missing ₦40m",
         "Police charged the Zenith Bank cashier over the missing ₦40m."),
        ("Adebayo Somefun pleads not guilty to ₦2bn misappropriation charges, EFCC says",
         "Adebayo Somefun pleaded guilty to misappropriating ₦2bn, EFCC said."),
        ("FG postpones signing of Lagos-Calabar coastal highway contract",
         "FG scrapped the Lagos-Calabar coastal highway contract."),
    ])
    def test_flipped_meaning_is_dropped(self, headline, line):
        r = row(30063, headline, "The Punch", T)
        assert not ed.check_line(line, [card_of([r])])
        e = cards_for([r])({"overview": [{"card": 1, "text": line}]})
        assert all(o["text"] != line for o in e["overview"])

    @pytest.mark.parametrize("line", [
        "OPay listed on the NYSE earlier this week, raising $304m.",
        "OPay listed on the NYSE and raised $304m, reports said.",
        "OPay raised $304m in its US IPO.",
    ])
    def test_a_reversed_story_is_never_described_as_done(self, line):
        assert not ed.check_line(line, [card_of(OPAY)])
        e = edition(llm=model({"overview": [{"card": 1, "text": line}]}))
        assert all(o["text"] != line for o in e["overview"])

    def test_earlier_reports_facts_are_labelled_on_a_reversed_story(self):
        rows = [dict(r) for r in OPAY]
        rows[0]["Key Facts"] = "OPay raised $304m in its NYSE IPO"
        card = edition(rows + OTHERS)["cards"][0]
        assert card["key_facts"] == ["Earlier report (Premium Times, Fri 30 Oct): OPay raised $304m in its NYSE IPO"]

    def test_the_days_counts_are_no_backing_for_a_figure(self):
        e = edition()
        assert e["stats"]["stories"] == 5
        oyo = next(c for c in e["cards"] if "Makinde" in c["headline"])
        e = edition(llm=model({"overview": [{"card": oyo["n"], "text": "Makinde approved ₦5 billion for Circular road owners."}]}))
        assert e["health"]["overview_dropped"] == 1


DISTINCT = [
    "MTN raises data tariffs", "Dangote Cement lifts output", "NNPC opens new depot in Kano",
    "Lagos rail line opens to passengers", "Airtel expands rural coverage", "Seplat signs gas supply deal",
]
ACCUSING = "Ex-Minister Diverted N2.6bn Humanitarian Funds To Private Accounts, Says Prosecution Witness"


class TestWordingReview:
    def test_a_trailing_attribution_is_not_taken_for_a_masthead(self):
        r = row(30070, "Ex-governor diverted N80bn meant for pensions to private firms – EFCC witness",
                "Premium Times Nigeria", T, level="High", score=80)
        e = edition([r])
        assert e["cards"][0]["headline"].endswith("– EFCC witness")
        assert "diverted" not in e["subject"]

    def test_the_subject_never_cuts_a_headline(self):
        e = edition([row(30071, ACCUSING, "Premium Times Nigeria", T, level="High", score=80)])
        assert e["subject"] == "AURA alert · Sun 1 Nov · 1 story, 1 risk alert"
        assert "…" not in e["preheader"]

    def test_also_today_keeps_the_attribution(self):
        long = ("Former Kogi governor Yahaya Bello diverted N80.2 billion from state coffers into companies and "
                "private accounts linked to his family between 2016 and 2024 to buy properties in Abuja, Lagos and "
                "Dubai, prosecutors from the EFCC told the Federal High Court on Tuesday.")
        filler = [row(30080 + i, h, "The Punch", T, importance=90) for i, h in enumerate(DISTINCT[:5])]
        target = row(30090, "Bello diverted N80.2bn, EFCC tells court", "Vanguard News", T, summary=long, importance=10)
        e = edition(filler + [target])
        line = next(a["text"] for a in e["also"] if "Bello" in a["text"])
        assert line.endswith("told the Federal High Court on Tuesday.") or "tells court" in line

    def test_an_unattributed_summary_falls_back_to_a_safe_line(self):
        r = row(30091, "Pension fund probe widens", "Vanguard News", T,
                summary="The board diverted N2bn into private accounts.")
        e = edition([r])
        assert all("diverted" not in o["text"] or "reports:" in o["text"] for o in e["overview"])

    def test_a_term_spelled_out_differently_is_not_defined(self):
        r = row(30092, "The Police Service Commission (PSC) has appointed two Deputy Inspectors General",
                "The Punch", T)
        assert "PSC" not in {t["term"] for t in edition([r])["terms"]}

    def test_the_conflict_fallback_only_points_at_a_full_card(self):
        filler = [row(30100 + i, h, "The Punch", T, importance=90) for i, h in enumerate(DISTINCT)]
        rows = [dict(r, Importance=5) for r in OPAY]
        e = edition(filler + rows)
        assert all(n <= len(e["cards"]) for i in e["insights"] for n in i["cards"])


PSC = [
    {"Person Name": "Jane Okafor", "Company": "Wema Bank Plc", "Board Role": "Non-Executive Director", "Kind": "role",
     "Percentage": "", "Source URL": "https://punchng.com/wema", "Publisher": "The Punch", "Date": "2026-10-31"},
    {"Person Name": "Femi Otedola", "Company": "Geregu Power Plc", "Percentage": "30%", "Change Type": "lost",
     "Source URL": "https://punchng.com/geregu", "Publisher": "The Punch", "Date": "2026-10-31"},
]


class TestOwnershipReview:
    def test_a_board_seat_is_not_control_and_a_sale_is_not_a_holding(self):
        texts = [p["text"] for p in edition([], psc=PSC)["psc"]]
        assert "Jane Okafor reported as non-executive director of Wema Bank Plc" in texts
        assert any(t.startswith("Femi Otedola reported as having reduced or sold a stake") for t in texts)

    def test_a_claim_is_not_repeated_in_the_next_email(self):
        first = edition([], psc=PSC)
        nxt = ed.build_edition([], PSC, datetime(2026, 11, 2, 7, 0),
                               {"through_id": first["through_id"], "built_at": first["built_at"],
                                "psc_keys": first["psc_keys"]})
        assert nxt["psc"] == [] and nxt["stats"]["ownership"] == 0

    def test_the_count_is_not_capped_at_the_lines_shown(self):
        many = [dict(PSC[0], **{"Person Name": f"P{i}", "Source URL": f"https://x.ng/{i}"}) for i in range(7)]
        e = edition([], psc=many)
        assert e["stats"]["ownership"] == 7 and len(e["psc"]) == ed.MAX_PSC and e["psc_more"] == 4


class TestMarker:
    def test_a_reset_sheet_does_not_leave_the_email_quiet_for_ever(self):
        t = "2026-10-31T12:00:00Z"
        rows = [row(1, "FG awards N90bn rail contract", "The Punch", t), row(2, "CBN sanctions five banks", "The Punch", t)]
        e = ed.build_edition(rows, [], NOW, {"through_id": 5400, "built_at": "2026-10-31 07:00:00"})
        assert e["stats"]["stories"] == 2 and e["health"]["marker_reset"] == 1 and e["through_id"] == 2

    def test_a_preview_never_shares_the_editions_id(self):
        rows = OPAY + OTHERS
        assert ed.build_edition(rows, [], NOW, LAST, preview=True)["edition"].endswith("-preview")
        assert not ed.build_edition(rows, [], NOW, LAST)["edition"].endswith("-preview")


# --- second review round: whole classes, not single wordings ------------------------------

class TestStagesRound2:
    @pytest.mark.parametrize("headline, stage", [
        ("Court refuses to discharge ex-governor in N80bn case", "in_court"),
        ("Ex-minister seeks to quash fraud charges", "in_court"),
        ("Court fixes date for judgment in Maina case", "in_court"),
        ("Court frees ex-NNPC GMD", "cleared"),
        ("Court finds ex-minister not guilty of fraud", "cleared"),
        ("Court finds ex-minister guilty of fraud", "ruled"),
        ("EFCC charges Abuja businessman with $120m fraud", "charged"),
        ("Customers withdraw cash ahead of new limits", "unclear"),
        ("FG approves completion of abandoned Lagos road", "approved"),
        ("Senate passes budget despite delays", "unclear"),
        ("OPay pulls IPO", "withdrawn_or_cancelled"),
        ("OPay IPO delayed by regulator", "postponed"),
        ("Banks court investors with new dollar bonds", "unclear"),
        ("CBN moves to arrest the decline of the naira", "unclear"),
    ])
    def test_outcomes_pending_cases_and_business_words(self, headline, stage):
        assert ed.stage_of(headline) == stage

    def test_the_caveat_is_true_at_any_stage(self):
        pending = card_of([row(30200, "Court refuses to discharge ex-governor in N80bn case", "The Punch", T)])
        ruled = card_of([row(30201, "Court convicts ex-pension boss Maina", "The Punch", T)])
        assert any("not a finding of guilt" in a for a in pending["analysis"])
        assert ruled["analysis"][-1].startswith("Court outcome as reported by Punch")
        assert not any("no court has ruled" in a for c in (pending, ruled) for a in c["analysis"])


class TestOwnWords:
    def test_the_model_writes_nothing_about_a_legal_story(self):
        r = row(30210, "EFCC arraigns Adebayo Somefun over alleged ₦2bn misappropriation", "The Punch", T,
                entities="EFCC|Adebayo Somefun")
        e = cards_for([r])({"overview": [{"card": 1, "text": "EFCC arraigned Adebayo Somefun over alleged ₦2bn misappropriation."}]})
        assert e["overview"][0]["text"] == "EFCC arraigns Adebayo Somefun over alleged ₦2bn misappropriation."
        assert e["health"]["overview_own_words"] == 1

    def test_no_insight_touches_a_legal_story(self):
        rows = [
            row(30211, "EFCC probes alleged ₦3bn fraud at Delta pension board", "The Punch", T, entities="EFCC"),
            row(30212, "Access Holdings appoints Bolaji Agbede as group CEO", "BusinessDay", T,
                importance=70, entities="Access Holdings|Bolaji Agbede"),
        ]
        e = cards_for(rows)({"insights": [
            {"kind": "pattern", "cards": [1, 2], "text": "Access Holdings is under EFCC probe over alleged ₦3bn fraud, according to reports."},
            {"kind": "watch", "cards": [2], "text": "Will the new group CEO face fraud questions?"},
        ]})
        assert e["insights"] == []


class TestThreadsRound2:
    def test_two_people_charged_by_one_agency_stay_apart(self):
        rows = [
            row(30220, "NDLEA arraigns businessman over cocaine export", "The Punch", T, entities="NDLEA|John Okoro"),
            row(30221, "NDLEA arraigns businessman over cocaine export in Lagos", "Vanguard News", T,
                entities="NDLEA|Mary Okoro"),
        ]
        assert edition(rows)["stats"]["stories"] == 2

    def test_a_report_naming_nobody_does_not_chain_two_people(self):
        rows = [
            row(30222, "Court remands ex-minister Ade Bello over N2bn fraud in Abuja", "The Punch", T, entities="Ade Bello"),
            row(30223, "Court remands ex-minister over N2bn fraud in Abuja", "Vanguard News", T),
            row(30224, "Court remands ex-minister Tunde Musa over N2bn fraud in Abuja", "ThisDay", T, entities="Tunde Musa"),
        ]
        e = edition(rows)
        assert e["stats"]["stories"] >= 2
        assert not any("Bello" in c["headline"] and any("Musa" in t for t in c["timeline"]) for c in e["cards"])

    def test_invisible_characters_do_not_hide_a_repost(self):
        sent = row(30230, "CBN sanctions five banks", "The Punch", "2026-10-31T05:00:00Z", url="https://punchng.com/cbn")
        repost = row(30232, "CBN sanctions​ five banks", "The Punch", "2026-10-31T06:00:00Z",
                     url="https://news.google.com/rss/articles/cbn2")
        e = ed.build_edition([sent, repost], [], NOW, {"through_id": 30231, "built_at": "2026-10-31 05:30:00"})
        assert e["cards"] == []


class TestWordingRound2:
    def test_another_outlets_name_in_the_tail_is_kept(self):
        r = row(30240, "Naira hits record low against dollar - Reuters", "The Punch", T)
        assert edition([r])["cards"][0]["headline"].endswith("- Reuters")
        gn = row(30241, "Naira hits record low - Punch Newspapers", "Punch Newspapers", T)
        assert edition([gn])["cards"][0]["headline"] == "Naira hits record low"

    def test_a_title_is_not_a_sentence_end(self):
        assert ed.first_sentence("Dr. Ngozi Okonjo-Iweala said the WTO would act. Later text.") == \
            "Dr. Ngozi Okonjo-Iweala said the WTO would act."

    def test_the_subject_uses_another_top_story_rather_than_cut_one(self):
        rows = [row(30250, "Lee Group set to unveil $1.8bn industrial park in Ogun, targets 29 factories, 2,500 jobs",
                    "Premium Times Nigeria", T, importance=90),
                row(30251, "Nigeria hosts $5bn Africa Energy Bank headquarters", "The Punch", T, importance=80)]
        e = edition(rows)
        assert e["subject"] == "AURA · Sun 1 Nov · Nigeria hosts $5bn Africa Energy Bank headquarters"
        assert "…" not in e["subject"] + e["preheader"]

    def test_a_resignation_is_not_a_sale(self):
        r = {"Person Name": "Jane Okafor", "Company": "Wema Bank Plc", "Board Role": "Non-Executive Director",
             "Kind": "role", "Change Type": "resigned", "Source URL": "https://x.ng/w", "Date": "2026-10-31"}
        assert ed.psc_text(r) == "Jane Okafor reported as no longer non-executive director of Wema Bank Plc"
