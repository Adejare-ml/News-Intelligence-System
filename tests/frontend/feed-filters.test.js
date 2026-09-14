/* Tests for the feed filter <-> URL layer (Package 23), plus the
   Package 23 additions to AuraInsights (trend denominators, company
   leaderboard, watchlist digest). All pure, all DOM-free. */
(function () {
    "use strict";
    var FF = window.AuraFeedFilters;
    var I = window.AuraInsights;
    var R = window.AuraRouter;

    T.describe("feed filter query round-trip", function () {
        T.it("serialize omits defaults entirely", function () {
            T.eq(FF.serialize({ days: 0, source: "", risk: "", category: "", q: "", sort: "newest" }), "");
        });

        T.it("state survives a serialize -> router-parse -> parseQuery trip", function () {
            var state = { days: 7, source: "Punch", risk: "Critical",
                          category: "Company", q: "dangote cement", sort: "risk" };
            var hash = FF.serialize(state);
            var match = R.matchRoute(hash);
            T.eq(match.view, "feed", "the router owns the hash shape");
            var back = FF.parseQuery(match.query);
            T.eq(back.days, 7);
            T.eq(back.source, "Punch");
            T.eq(back.risk, "Critical");
            T.eq(back.category, "Company");
            T.eq(back.q, "dangote cement");
            T.eq(back.sort, "risk");
        });

        T.it("garbage query values fall back to defaults", function () {
            var s = FF.parseQuery({ days: "9999", sort: "sideways" });
            T.eq(s.days, 0);
            T.eq(s.sort, "newest");
        });
    });

    T.describe("date window predicate", function () {
        var now = new Date("2026-09-14T12:00:00Z");
        T.it("keeps articles inside the window, drops older", function () {
            T.ok(FF.withinDays("2026-09-10T00:00:00Z", 7, now));
            T.ok(!FF.withinDays("2026-08-01T00:00:00Z", 7, now));
        });
        T.it("reads the RFC-822 stamps the sheet also contains", function () {
            T.ok(FF.withinDays("Thu, 10 Sep 2026 23:57:38 GMT", 7, now));
        });
        T.it("days 0 and unparseable stamps always pass — a filter narrows, never hides", function () {
            T.ok(FF.withinDays("2020-01-01", 0, now));
            T.ok(FF.withinDays("not a date", 7, now));
        });
    });

    T.describe("source options", function () {
        T.it("unique, sorted, blanks and Unknown dropped", function () {
            var names = FF.sourceOptions([
                { source: "Punch" }, { source: "punch" }, { source: "BusinessDay" },
                { source: "" }, { source: "Unknown" }, {}
            ]);
            T.eq(names.join("|"), "BusinessDay|Punch");
        });
    });

    T.describe("trend denominators (Package 23)", function () {
        T.it("volume and categories surface from fields that were never rendered", function () {
            var s = I.trendsSummary({
                recent_articles: 117, previous_articles: 154,
                categories: [{ category: "Company", recent: 28, previous: 40 },
                             { category: "", recent: 3, previous: 1 }],
                rising: [], falling: [], social: []
            });
            T.ok(s, "volume alone justifies the panel");
            T.eq(s.volume.recent, 117);
            T.eq(s.volume.pct, -24);
            T.eq(s.categories.length, 1, "nameless category rows drop");
            var html = I.renderTrendsHTML(s);
            T.contains(html, "117 articles this window vs 154 last (-24%)");
            T.contains(html, "40 → 28");
        });

        T.it("zero previous volume yields no percentage, not Infinity", function () {
            var s = I.trendsSummary({ recent_articles: 5, previous_articles: 0,
                                      rising: [], falling: [], social: [] });
            T.eq(s.volume.pct, null);
            T.excludes(I.renderTrendsHTML(s), "Infinity");
        });
    });

    T.describe("company risk leaderboard", function () {
        var COMPANIES = [
            { Company: "SafeCo", "Mention Count": 50, "Risk Level": "Low" },
            { Company: "DangerCo", "Mention Count": 3, "Risk Level": "Critical",
              "Last Seen": "2026-09-01 10:00" },
            { Company: "WarmCo", "Mention Count": 9, "Risk Level": "Medium" },
            { Company: "" }
        ];
        T.it("elevated entities lead, ranked by severity then mentions", function () {
            var m = I.companyLeaderboard(COMPANIES);
            T.eq(m.total, 3);
            T.eq(m.elevatedCount, 2);
            T.eq(m.mode, "elevated");
            T.eq(m.rows[0].name, "DangerCo");
            T.eq(m.rows[1].name, "WarmCo");
        });
        T.it("renders dossier links and escapes names", function () {
            var m = I.companyLeaderboard([{ Company: "<b>Evil</b> Ltd", "Mention Count": 2,
                                            "Risk Level": "High" }]);
            var html = I.renderLeaderboardHTML(m);
            T.contains(html, '#/company/b-evil-b-ltd');
            T.excludes(html, "<b>Evil");
        });
        T.it("empty input hides the panel", function () {
            T.eq(I.companyLeaderboard([]), null);
        });
    });

    T.describe("watchlist digest", function () {
        var WATCH = [{ type: "company", slug: "nnpc", label: "NNPC" },
                     { type: "person", slug: "ada-obi", label: "Ada Obi" }];
        T.it("matches changes.json entries through the shared slug rule", function () {
            // changes.json carries the exporter's deduped labels -- the same
            // labels dossier slugs (and therefore watch entries) derive from,
            // so exact slugify equality is the correct join.
            var d = I.watchlistDigest(WATCH, {
                new_companies: ["NNPC"],
                psc_changed: [{ person: "Ada Obi", company: "HoldCo", from: 28.5, to: 63.2 }]
            });
            T.eq(d.total, 2);
            T.eq(d.updates["company/nnpc"].join(""), "newly tracked");
            T.contains(d.updates["person/ada-obi"].join(""), "28.5% → 63.2%");
        });
        T.it("a quiet cycle or missing file digests to zero", function () {
            T.eq(I.watchlistDigest(WATCH, null).total, 0);
            T.eq(I.watchlistDigest([], { new_companies: ["NNPC"] }).total, 0);
        });
    });

    T.report();
})();
