/* Tests for the Package 24 analytical boards: agency activity,
   appointments & departures, and the procurement ledger. Pure halves
   only -- the binds are DOM-guarded no-ops here. */
(function () {
    "use strict";
    var B = window.AuraBoards;
    var DT = window.AuraDataTable;

    T.describe("agency activity board", function () {
        var ROWS = [
            { Agency: "EFCC", Event: "Investigation", Date: "2026-09-01" },
            { Agency: "efcc", Event: "Corruption", Date: "2026-09-03" },
            { Agency: "EFCC", Event: "Corruption", Date: "2026-08-20" },
            { Agency: "NDIC", Event: "Advisory", Date: "2026-09-02" },
            { Agency: "", Event: "Policy" }
        ];

        T.it("case-variant rows merge; volume ranks; last date survives", function () {
            var m = B.agencyBoard(ROWS);
            T.eq(m.totalAgencies, 2);
            T.eq(m.rows[0].name, "EFCC");
            T.eq(m.rows[0].total, 3);
            T.eq(m.rows[0].events.Corruption, 2);
            T.eq(m.rows[0].lastDate, "2026-09-03");
        });

        T.it("event chips rank by count and render links + escapes", function () {
            var top = B.topEvents({ Audit: 12, Corruption: 5, Policy: 2, Other: 1 });
            T.eq(top.length, 3);
            T.eq(top[0].event, "Audit");
            var html = B.renderAgencyBoardHTML(B.agencyBoard([
                { Agency: "<img src=x> Agency", Event: "Audit", Date: "2026-09-01" }
            ]));
            T.excludes(html, "<img src=x>");
            T.contains(html, "#/agency/");
        });

        T.it("empty input hides the panel", function () {
            T.eq(B.agencyBoard([]), null);
        });
    });

    T.describe("appointments & departures", function () {
        var PEOPLE = [
            { Name: "Ada Obi", Position: "CEO", Organization: "Dangote", Event: "appointment", Date: "2026-09-01" },
            { Name: "Ben Ade", Position: "CFO", Organization: "Zenith", Event: "resignation", Date: "2026-09-10" },
            { Name: "Old Move", Position: "Chair", Organization: "NNPC", Event: "reappointment", Date: "2026-07-15" },
            { Name: "Not Churn", Event: "other", Date: "2026-09-01" },
            { Name: "No Date", Position: "MD", Organization: "X", Event: "appointment", Date: "" }
        ];

        T.it("filters to churn events and groups by month, newest first", function () {
            var m = B.appointmentsTimeline(PEOPLE);
            T.eq(m.total, 4, "the 'other' row is not churn");
            T.eq(m.months[0].month, "2026-09");
            T.eq(m.months[0].items[0].name, "Ben Ade", "newest first inside a month");
            var last = m.months[m.months.length - 1];
            T.eq(last.month, "undated", "undated rows group last, never invented into a month");
        });

        T.it("renders resignations distinctly and links people", function () {
            var html = B.renderAppointmentsHTML(B.appointmentsTimeline(PEOPLE));
            T.contains(html, "move-resignation");
            T.contains(html, "#/person/ben-ade");
            T.contains(html, "left CFO @ Zenith");
        });

        T.it("no churn at all hides the panel", function () {
            T.eq(B.appointmentsTimeline([{ Name: "X", Event: "other" }]), null);
        });
    });

    T.describe("procurement ledger", function () {
        var ROWS = [
            { Agency: "BPP", Contractor: "Acme", Amount: "N1.5 billion", Project: "Roads",
              Source: "Punch", Date: "2026-09-01", "Amount Value": 1.5e9, "Amount Currency": "NGN" },
            { Agency: "NNPC", Contractor: "TBD", Amount: "None", Project: "Pipeline",
              Source: "Vanguard", "Amount Value": null, "Amount Currency": null },
            { Agency: "FMoW", Contractor: "BuildCo", Amount: "$2m", Project: "Bridge",
              Source: "Guardian", "Amount Value": 2e6, "Amount Currency": "USD" }
        ];

        T.it("compact amounts keep their currency", function () {
            T.eq(B.compactAmount(1.5e9, "NGN"), "₦1.5bn");
            T.eq(B.compactAmount(2e6, "USD"), "$2m");
            T.eq(B.compactAmount(746e6, "GBP"), "£746m");
        });

        T.it("ledger rows sort by real value with undisclosed last", function () {
            var rows = B.ledgerRows(ROWS);
            var sorted = DT.sortRows(rows, "Amount Value", "desc");
            T.eq(sorted[0].Agency, "BPP");
            T.eq(sorted[1].Agency, "FMoW");
            T.eq(sorted[2].Agency, "NNPC", "null amount groups last in either direction");
        });

        T.it("table renders honest markers and dossier links", function () {
            var html = DT.renderTableHTML(B.ledgerRows(ROWS), B.ledgerColumns(), {});
            T.contains(html, "Not disclosed");
            T.contains(html, ">TBD<");
            T.contains(html, "#/agency/bpp");
            T.contains(html, "#/company/acme");
            T.contains(html, "₦1.5bn");
        });

        T.it("summary counts disclosed values per currency", function () {
            var s = B.ledgerSummary(ROWS);
            T.eq(s.total, 3);
            T.eq(s.disclosed, 2);
            T.contains(s.line, "₦1.5bn");
            T.contains(s.line, "$2m");
            T.eq(B.ledgerSummary([]), null);
        });

        T.it("older exports without parsed fields degrade to text, not crashes", function () {
            var rows = B.ledgerRows([{ Agency: "BPP", Contractor: "X", Amount: "N400 Million" }]);
            T.eq(rows[0]["Amount Value"], null);
            var html = DT.renderTableHTML(rows, B.ledgerColumns(), {});
            T.contains(html, "Not disclosed");
        });
    });

    T.report();
})();
