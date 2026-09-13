/* Tests for the insight computations (what-changed panel, pipeline health)
   and the data-driven globe arc derivation. All pure, all DOM-free. */
(function () {
    "use strict";
    var I = window.AuraInsights;
    var G = window.AuraGlobe;

    T.describe("changesSummary", function () {
        T.it("returns null for missing or empty diffs", function () {
            T.eq(I.changesSummary(null), null);
            T.eq(I.changesSummary({ new_companies: [], psc_added: [] }), null);
        });

        T.it("keeps only non-empty groups, high-risk first", function () {
            var s = I.changesSummary({
                new_companies: ["BUA Foods Plc"],
                new_people: [],
                psc_added: [{ person: "Ada Obi", company: "Acme Ltd" }],
                new_high_risk: [{ title: "Hot story", url: "u", risk: 82 }]
            });
            T.eq(s.groups.length, 3);
            T.eq(s.groups[0].label, "New high-risk articles");
            T.eq(s.groups[0].items[0], "Hot story");
            T.contains(s.groups[1].items[0], "Ada Obi — Acme Ltd");
        });

        T.it("formats percentage moves with both values", function () {
            var s = I.changesSummary({
                psc_changed: [{ person: "A", company: "X", from: 10, to: 12.5 }]
            });
            T.contains(s.groups[0].items[0], "(10% → 12.5%)");
        });
    });

    T.describe("renderChangesHTML", function () {
        T.it("escapes markup in names", function () {
            var s = I.changesSummary({ new_companies: ["<b>Evil</b> Ltd"] });
            var html = I.renderChangesHTML(s, 5);
            T.excludes(html, "<b>Evil");
            T.contains(html, "&lt;b&gt;");
        });

        T.it("caps lists and reports the overflow", function () {
            var s = I.changesSummary({ new_companies: ["A", "B", "C", "D"] });
            var html = I.renderChangesHTML(s, 2);
            T.contains(html, "+2 more");
        });
    });

    T.describe("healthSeries", function () {
        var rows = [
            { "Date": "2026-09-01", "Total Articles": 5, "High Risk": 1,
              "Cascade Failures": "2", "Run Seconds": 100 },
            { "Date": "2026-09-01 14:00:00", "Total Articles": "3", "High Risk": 0,
              "Cascade Failures": 0, "Run Seconds": "200" },
            { "Date": "2026-09-02", "Total Articles": 0, "High Risk": 0 },
            { "Date": "junk", "Total Articles": 99, "High Risk": 99 }
        ];

        T.it("aggregates per day across per-run rows", function () {
            var s = I.healthSeries(rows);
            T.eq(s.labels.join(","), "2026-09-01,2026-09-02");
            T.eq(s.articles[0], 8);
            T.eq(s.runs[0], 2);
            T.eq(s.cascadeFailures[0], 2);
            T.eq(s.avgRunSeconds[0], 150);
        });

        T.it("computes the high-risk rate and survives zero-article days", function () {
            var s = I.healthSeries(rows);
            T.eq(s.highRiskRate[0], 12.5);
            T.eq(s.highRiskRate[1], 0);
        });

        T.it("drops unparseable dates and clamps to maxDays", function () {
            var many = [];
            for (var i = 1; i <= 12; i++) {
                many.push({ "Date": "2026-09-" + (i < 10 ? "0" + i : i), "Total Articles": i });
            }
            var s = I.healthSeries(many, 5);
            T.eq(s.labels.length, 5);
            T.eq(s.labels[0], "2026-09-08");
        });

        T.it("rows without the health columns average to null seconds", function () {
            var s = I.healthSeries([{ "Date": "2026-09-03", "Total Articles": 1, "High Risk": 0 }]);
            T.eq(s.avgRunSeconds[0], null);
        });
    });

    T.describe("engineMix", function () {
        T.it("counts engines case-insensitively, blank as unknown", function () {
            var mix = I.engineMix([
                { Engine: "Gemini" }, { Engine: "gemini" }, { Engine: "" }, {}
            ]);
            T.eq(mix[0].engine, "gemini");
            T.eq(mix[0].count, 2);
            T.eq(mix[1].engine, "unknown");
            T.eq(mix[1].count, 2);
        });
    });

    T.describe("trendsSummary + weatherSummary", function () {
        T.it("returns null when nothing is worth a panel", function () {
            T.eq(I.trendsSummary(null), null);
            T.eq(I.trendsSummary({ rising: [], falling: [], social: [] }), null);
            T.eq(I.weatherSummary(null), null);
            T.eq(I.weatherSummary({ cities: [] }), null);
        });

        T.it("drops social posts that are not canonical reddit permalinks", function () {
            var s = I.trendsSummary({
                rising: [{ term: "dangote", recent: 3, change: 2 }],
                social: [
                    { title: "ok", score: 5, url: "https://www.reddit.com/r/Nigeria/comments/a/x/" },
                    { title: "evil", score: 9, url: "https://evil.test/phish" }
                ]
            });
            T.eq(s.social.length, 1);
            T.contains(s.social[0].url, "reddit.com/r/Nigeria");
        });

        T.it("weather lines carry city, temperature and description", function () {
            var w = I.weatherSummary({ cities: [
                { name: "Lagos", temp_c: 29.4, description: "Rain showers", humidity: 84 }
            ]});
            T.contains(w.cities[0].line, "Lagos 29.4°C");
            T.contains(w.cities[0].line, "Rain showers");
            T.contains(w.cities[0].line, "84% humidity");
        });
    });

    T.describe("renderTrendsHTML", function () {
        T.it("escapes terms and post titles", function () {
            var html = I.renderTrendsHTML(I.trendsSummary({
                rising: [{ term: "<b>evil</b>", recent: 2, change: 2 }],
                social: [{ title: "<script>x</script>", score: 1,
                           url: "https://www.reddit.com/r/Nigeria/comments/a/x/" }]
            }));
            T.excludes(html, "<b>evil");
            T.excludes(html, "<script>x");
            T.contains(html, "&lt;b&gt;");
        });

        T.it("marks direction on the chips", function () {
            var html = I.renderTrendsHTML(I.trendsSummary({
                rising: [{ term: "up", recent: 2, change: 3 }],
                falling: [{ term: "down", recent: 0, previous: 4, change: -4 }]
            }));
            T.contains(html, "trend-up");
            T.contains(html, "trend-down");
            T.contains(html, "+3");
            T.contains(html, "-4");
        });
    });

    T.describe("globe routesFromRecords", function () {
        T.it("derives weighted routes from Intermediate Entities", function () {
            var routes = G.routesFromRecords([
                { "Intermediate Entities": "Tengen Holdings (Mauritius) Limited" },
                { "Intermediate Entities": "Something in Mauritius; BVI shell" },
                { "Intermediate Entities": "Cayman vehicle" }
            ]);
            T.eq(routes[0].label, "Mauritius");
            T.eq(routes[0].weight, 2);
            T.ok(typeof routes[0].lat === "number" && typeof routes[0].lon === "number",
                "route carries coordinates");
            var labels = routes.map(function (r) { return r.label; });
            T.ok(labels.indexOf("British Virgin Islands") !== -1, "BVI matched");
            T.ok(labels.indexOf("Cayman Islands") !== -1, "Cayman matched");
        });

        T.it("counts one hit per record per jurisdiction", function () {
            var routes = G.routesFromRecords([
                { "Intermediate Entities": "Mauritius and more Mauritius, mauritius again" }
            ]);
            T.eq(routes[0].weight, 1);
        });

        T.it("returns null when nothing matches, so the static set stays", function () {
            T.eq(G.routesFromRecords([{ "Intermediate Entities": "Lagos, Nigeria" }]), null);
            T.eq(G.routesFromRecords([]), null);
            T.eq(G.routesFromRecords(null), null);
        });

        T.it("keeps the static fallback list exported", function () {
            T.ok(G.routes.length >= 9, "static routes still published");
        });
    });

    T.report();
})();
