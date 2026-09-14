/* Tests for Package 25: dossier timelines + markdown export, the compare
   view, the investigations state layer, and archive search. Pure halves
   only. */
(function () {
    "use strict";
    var D = window.AuraDossier;
    var C = window.AuraCompare;
    var I = window.AuraInvestigations;
    var RM = window.AuraReportMarkdown;
    var R = window.AuraRouter;

    var DATA = {
        companies: [{ Company: "Dangote Cement Plc", Industry: "Cement", "Risk Level": "High",
                      "Mention Count": 12, "Last Seen": "2026-09-01" }],
        people: [{ Name: "Ada Obi", Position: "CEO", Organization: "Dangote Cement Plc",
                   Event: "appointment", Date: "2026-08-01" }],
        psc: [{ "Person Name": "Ada Obi", Company: "Dangote Cement Plc", Percentage: "30%",
                "Intermediate Entities": "Mauritius HoldCo", "Verification Status": "Filed" }],
        procurement: [{ Agency: "BPP", Contractor: "Dangote Cement Plc", Amount: "N2bn",
                        Project: "Roads", Date: "2026-08-15" },
                      { Agency: "BPP", Contractor: "Zenith Bank", Amount: "N500m",
                        Project: "IT", Date: "2026-08-20" }],
        agencies: [{ Agency: "BPP", Event: "Procurement", Article: "x", Date: "2026-08-15" }],
        articles: [{ Title: "Dangote Cement Plc expands", URL: "https://p.test/a",
                     Source: "Punch", Summary: "s", Time: "2026-09-01T10:00:00" }]
    };

    T.describe("dossier timeline", function () {
        T.it("buckets dated facts weekly and fills gaps as gaps", function () {
            var model = D.companyDossier("dangote-cement-plc", DATA);
            var tl = D.dossierTimeline(model);
            T.ok(tl.weeks.length >= 3, "aug 15 to sep 1 spans 3+ weeks");
            var total = 0;
            var zeros = 0;
            tl.weeks.forEach(function (w) { total += w.count; if (!w.count) zeros += 1; });
            T.eq(total, 2, "the contract and the article; nothing invented");
            T.ok(zeros >= 1, "quiet weeks render as gaps, not interpolation");
        });

        T.it("one dated fact is a date, not a timeline", function () {
            var tl = { weeks: [{ week: "2026-09-01", count: 1 }] };
            T.eq(D.timelineHTML(tl), "");
        });

        T.it("SVG escapes and labels its range", function () {
            var model = D.companyDossier("dangote-cement-plc", DATA);
            var html = D.timelineHTML(D.dossierTimeline(model));
            T.contains(html, "aria-label=");
            T.contains(html, "tl-on");
        });
    });

    T.describe("dossier markdown export", function () {
        T.it("mirrors the rendered panels and nothing else", function () {
            var model = D.personDossier("ada-obi", DATA);
            var md = D.dossierMarkdown(model, "2026-09-14");
            T.contains(md, "# Ada Obi");
            T.contains(md, "Significant control");
            T.contains(md, "Dangote Cement Plc — 30%");
            T.contains(md, "Evidence of reporting, not a finding");
            T.eq(D.dossierMarkdown(null), "");
        });
    });

    T.describe("compare view", function () {
        T.it("#/compare resolves against the router with a query", function () {
            var m = R.matchRoute("#/compare?a=company%2Fdangote-cement-plc&b=person%2Fada-obi");
            T.eq(m.view, "compare");
            T.eq(m.query.a, "company/dangote-cement-plc");
        });

        T.it("parseRef accepts only known kinds", function () {
            T.eq(C.parseRef("company/dangote").type, "company");
            T.eq(C.parseRef("martian/x"), null);
            T.eq(C.parseRef("company/"), null);
            T.eq(C.parseRef(""), null);
        });

        T.it("shared counterparties join through slugs, excluding the subjects", function () {
            var model = C.compareModel(
                { a: "company/dangote-cement-plc", b: "company/zenith-bank" }, DATA);
            T.ok(model.a && model.b, "both dossiers build");
            T.eq(model.shared.join("|"), "BPP",
                "both contract with BPP; the subjects themselves never list as shared");
            var direct = C.compareModel(
                { a: "company/dangote-cement-plc", b: "person/ada-obi" }, DATA);
            T.eq(direct.shared.length, 0,
                "a subject touching the other subject is a direct link, not a shared third party");
        });

        T.it("renders honest empties and escapes", function () {
            var model = C.compareModel({ a: "company/nowhere", b: "" }, DATA);
            var html = C.renderCompareHTML(model);
            T.contains(html, "No records match");
            T.contains(html, "Pick the second entity");
            var dirty = C.compareModel({ a: "company/dangote-cement-plc",
                                         b: "person/ada-obi" },
                { companies: [{ Company: "Dangote Cement Plc" }],
                  people: [{ Name: "Ada Obi", Position: "<img src=x>", Organization: "",
                             Event: "", Date: "" }],
                  psc: [], procurement: [], agencies: [], articles: [] });
            T.excludes(C.renderCompareHTML(dirty), "<img src=x>");
        });

        T.it("picker options lead with the watchlist and dedupe", function () {
            var options = C.pickerOptions(DATA, [
                { type: "company", slug: "dangote-cement-plc", label: "Dangote Cement Plc" }
            ]);
            T.eq(options[0].label.indexOf("★"), 0);
            var values = options.map(function (o) { return o.value; });
            T.eq(values.filter(function (v) { return v === "company/dangote-cement-plc"; }).length, 1);
        });
    });

    T.describe("investigations state layer", function () {
        T.it("create / add / note / export round-trip", function () {
            var s = I.createCase(I.emptyState(), "Cement network", "case-1", "2026-09-14");
            s = I.addEntity(s, "case-1", { type: "company", slug: "dangote-cement-plc",
                                           label: "Dangote Cement Plc" });
            s = I.addEntity(s, "case-1", { type: "company", slug: "dangote-cement-plc",
                                           label: "dup" });
            s = I.setNote(s, "case-1", "company/dangote-cement-plc", "Watch the HoldCo chain.");
            var c = I.findCase(s, "case-1");
            T.eq(c.entities.length, 1, "duplicate entities never double-enter");
            var md = I.caseMarkdown(c, "2026-09-14");
            T.contains(md, "# Investigation: Cement network");
            T.contains(md, "Watch the HoldCo chain.");
            T.contains(md, "saved only in the analyst");
        });

        T.it("normalizeState survives hostile localStorage content", function () {
            T.eq(I.normalizeState(null).cases.length, 0);
            T.eq(I.normalizeState({ version: 9, cases: "x" }).cases.length, 0);
            var s = I.normalizeState({ version: 1, cases: [
                { id: "a", name: "ok", entities: [{ type: "company", slug: "x" }, { bad: 1 }],
                  notes: { "company/x": "note", "ghost/y": "orphan" } },
                { id: "", name: "dropped" }
            ] });
            T.eq(s.cases.length, 1);
            T.eq(s.cases[0].entities.length, 1);
            T.eq(s.cases[0].notes["ghost/y"], undefined, "orphan notes prune");
        });

        T.it("removing an entity removes its note; rendering escapes", function () {
            var s = I.createCase(I.emptyState(), "<b>x</b>", "case-2", "2026-09-14");
            s = I.addEntity(s, "case-2", { type: "person", slug: "p", label: "<i>P</i>" });
            s = I.setNote(s, "case-2", "person/p", "n");
            s = I.removeEntity(s, "case-2", "person/p");
            var c = I.findCase(s, "case-2");
            T.eq(c.entities.length, 0);
            T.eq(c.notes["person/p"], undefined);
            var html = I.renderPageHTML(s);
            T.excludes(html, "<b>x</b>");
            T.contains(html, "&lt;b&gt;");
        });
    });

    T.describe("archive search", function () {
        var EDITIONS = [
            { label: "2026-09-01", value: "file:a.md", text: "Dangote Cement announced. Dangote again." },
            { label: "2026-09-02", value: "file:b.md", text: "Quiet day for cement." },
            { label: "2026-09-03", value: "file:c.md", text: "Nothing relevant." }
        ];
        T.it("ranks by hit count with a snippet", function () {
            var hits = RM.searchEditions(EDITIONS, "dangote");
            T.eq(hits.length, 1);
            T.eq(hits[0].count, 2);
            T.contains(hits[0].snippet, "Dangote");
        });
        T.it("case-insensitive; short queries match nothing", function () {
            T.eq(RM.searchEditions(EDITIONS, "CEMENT").length, 2);
            T.eq(RM.searchEditions(EDITIONS, "da").length, 0);
        });
    });

    T.report();
})();
