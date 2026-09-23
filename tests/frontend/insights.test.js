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

    T.describe("techNewsSummary + renderTechNewsHTML", function () {
        var PAYLOAD = {
            generated: "2026-09-14 07:00:00",
            ai: [
                { title: "Anthropic ships a model", url: "https://p.test/a", source: "TechDesk" },
                { title: "No url — dropped" },
                { title: "Bad scheme", url: "javascript:alert(1)" }
            ],
            dev: [{ title: "HN thread", url: "https://p.test/hn", source: "Hacker News" }]
        };

        T.it("re-validates items: only titled http(s) links survive", function () {
            var s = I.techNewsSummary(PAYLOAD);
            T.eq(s.ai.length, 1);
            T.eq(s.dev.length, 1);
            T.eq(s.generated, "2026-09-14 07:00:00");
        });

        T.it("null when both sections are empty, so the panel stays hidden", function () {
            T.eq(I.techNewsSummary({ ai: [], dev: [] }), null);
            T.eq(I.techNewsSummary(null), null);
            T.eq(I.techNewsSummary({ ai: [{ title: "x", url: "ftp://nope" }] }), null);
        });

        T.it("caps each section", function () {
            var many = [];
            for (var i = 0; i < 20; i++) many.push({ title: "T" + i, url: "https://p.test/" + i });
            T.eq(I.techNewsSummary({ ai: many, dev: [] }).ai.length, 8);
        });

        T.it("rendered HTML is escaped and links open safely", function () {
            var html = I.renderTechNewsHTML(I.techNewsSummary({
                ai: [{ title: "<script>x</script>", url: "https://p.test/x\" onclick=\"y",
                       source: "<b>Src</b>" }],
                dev: []
            }));
            T.excludes(html, "<script>x");
            T.excludes(html, "<b>Src");
            T.excludes(html, 'onclick="y');
            T.contains(html, 'rel="noopener noreferrer"');
            T.contains(html, "AI industry");
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

    T.describe("signals: risk movers", function () {
        var PAYLOAD = { window_days: 7, movers: [
            { key: "customs", label: "Nigeria Customs Service", recent_avg: 41.4,
              previous_avg: 10.0, delta: 31.4, recent_mentions: 7, previous_mentions: 1 },
            { key: "fresh", label: "Fresh Co", recent_avg: 95.0,
              previous_avg: null, delta: null, recent_mentions: 2 }
        ] };
        T.it("rows keep labels, deltas and the export window", function () {
            var m = I.moversSummary(PAYLOAD, 6);
            T.eq(m.rows.length, 2);
            T.eq(m.rows[0].label, "Nigeria Customs Service");
            T.eq(m.rows[0].delta, 31.4);
            T.eq(m.rows[1].delta, null, "new entrants carry null, never invented 0");
            T.eq(m.windowDays, 7);
        });
        T.it("renders direction badges and a new-entrant badge", function () {
            var html = I.renderMoversHTML(I.moversSummary(PAYLOAD, 6));
            T.contains(html, "mover-up");
            T.contains(html, "mover-new");
            T.contains(html, "7 mentions");
        });
        T.it("empty or missing file hides the column", function () {
            T.eq(I.moversSummary(null), null);
            T.eq(I.moversSummary({ movers: [] }), null);
        });
    });

    T.describe("signals: sectors", function () {
        var PAYLOAD = { sectors: [
            { industry: "General", companies: 975, mentions: 1677,
              risk: { Low: 858, Critical: 59 } },
            { industry: "Oil & Gas", companies: 7, mentions: 68,
              risk: { Medium: 2, Low: 4, High: 1 } },
            { industry: "Banking", companies: 5, mentions: 8, risk: { Low: 5 } }
        ] };
        T.it("General becomes an honest footnote, not the biggest bar", function () {
            var s = I.sectorsSummary(PAYLOAD, 6);
            T.eq(s.rows.length, 2);
            T.eq(s.rows[0].industry, "Oil & Gas");
            T.eq(s.rows[0].elevated, 1);
            T.eq(s.uncategorized, 975);
            var html = I.renderSectorsHTML(s);
            T.contains(html, "975 further companies have no sector assigned yet");
            T.excludes(html, ">General<");
        });
        T.it("only General present means nothing named to chart", function () {
            T.eq(I.sectorsSummary({ sectors: [PAYLOAD.sectors[0]] }), null);
        });
    });

    T.describe("signals: source scorecard", function () {
        T.it("rows carry totals, accept rate and average risk", function () {
            var s = I.sourcesSummary({ sources: [
                { source: "Punch", total: 639, published: 320, filtered: 319,
                  accept_rate: 50, avg_risk: 31.4, last_seen: "2026-09-22" },
                { source: "", total: 5 }, { source: "Ghost", total: 0 }
            ] }, 6);
            T.eq(s.rows.length, 1, "blank names and zero-article rows drop");
            var html = I.renderSourcesHTML(s);
            T.contains(html, "Punch");
            T.contains(html, "50% accepted");
            T.contains(html, "avg risk 31");
        });
        T.it("hides without data", function () {
            T.eq(I.sourcesSummary(null), null);
            T.eq(I.sourcesSummary({ sources: [] }), null);
        });
    });

    T.describe("signals: naira fx", function () {
        var FX = { latest: { USD: 1540.5, EUR: 1661.7, GBP: 1941.3 },
                   history: [
                     { date: "2026-09-25", USD: 1500.0, EUR: 1650.0, GBP: 1930.0 },
                     { date: "2026-09-26", USD: 1530.0, EUR: 1655.0, GBP: 1935.0 },
                     { date: "2026-09-27", USD: 1540.5, EUR: 1661.7, GBP: 1941.3 }
                   ] };
        T.it("rows carry values and day-over-day deltas", function () {
            var m = I.fxSummary(FX);
            T.eq(m.rows.length, 3);
            T.eq(m.rows[0].currency, "USD");
            T.eq(m.rows[0].delta, 0.7);
            T.eq(m.date, "2026-09-27");
            T.eq(m.usdSeries.length, 3);
        });
        T.it("renders deltas and an accessible sparkline", function () {
            var html = I.renderFxHTML(I.fxSummary(FX));
            T.contains(html, "mover-up");
            T.contains(html, "aria-label=");
            T.contains(html, "polyline");
            T.contains(html, "as of 2026-09-27");
        });
        T.it("one recorded day renders values, no delta, no sparkline", function () {
            var m = I.fxSummary({ latest: { USD: 1540.5 },
                                  history: [{ date: "2026-09-27", USD: 1540.5 }] });
            T.eq(m.rows[0].delta, null);
            T.excludes(I.renderFxHTML(m), "polyline");
        });
        T.it("absent file hides the column", function () {
            T.eq(I.fxSummary(null), null);
        });
    });

    T.describe("signals: looking back", function () {
        var NOW = new Date("2026-09-22T12:00:00Z");
        var REPORTS = [
            { Date: "2026-08-23", "Total Articles": 7, "High Risk": 1,
              "Archive File": "report_a.md" },
            { Date: "2026-08-23 18:00:00", "Total Articles": 5, "High Risk": 0,
              "Archive File": "report_b.md" }
        ];
        T.it("finds the nearest run day within three days of the offset", function () {
            var m = I.retrospective(REPORTS, NOW);
            T.eq(m.rows.length, 1, "young corpus: 30d hits, 90d honestly absent");
            T.eq(m.rows[0].date, "2026-08-23");
            T.eq(m.rows[0].articles, 12, "same-day runs sum");
            var html = I.renderRetroHTML(m);
            T.contains(html, "30 days ago");
            T.contains(html, "12 articles logged, 1 high-risk");
        });
        T.it("no archive coverage means null, not an empty panel", function () {
            T.eq(I.retrospective([], NOW), null);
            T.eq(I.retrospective([{ Date: "garbage" }], NOW), null);
        });
    });

    T.describe("news center: markets", function () {
        var M = { latest: { spx: 6481.5, brent: 67.25, btc: 112405.33 },
                  history: [
                    { date: "2026-09-22", spx: 6450.0, brent: 66.5, btc: 111000 },
                    { date: "2026-09-23", spx: 6481.5, brent: 67.25, btc: 112405.33 }
                  ] };
        T.it("rows carry labels, prefixes and deltas; unknown keys drop", function () {
            var m = I.marketsSummary(M);
            T.eq(m.rows.length, 3);
            T.eq(m.rows[0].label, "S&P 500");
            T.eq(m.rows[0].delta, 0.5);
            T.eq(m.rows[1].prefix, "$");
            T.eq(m.spxSeries.length, 2);
        });
        T.it("renders quotes with an S&P sparkline", function () {
            var html = I.renderMarketsHTML(I.marketsSummary(M));
            T.contains(html, "S&amp;P 500 6,481.5");
            T.contains(html, "Bitcoin $112,405.33");
            T.contains(html, "polyline");
            T.contains(html, "mover-up");
        });
        T.it("absent file hides the column", function () {
            T.eq(I.marketsSummary(null), null);
            T.eq(I.marketsSummary({ latest: {} }), null);
        });
    });

    T.describe("news center: world now", function () {
        var W = { generated: "2026-09-23 08:00:00",
                  world: [{ title: "Ceasefire talks resume", url: "https://x.test/w",
                            source: "Reuters" },
                          { title: "", url: "https://x.test/blank" }],
                  culture: [{ title: "Lagos fashion week lineup", url: "https://x.test/c",
                              source: "Vogue" }] };
        T.it("sections clean blanks and render as linked groups", function () {
            var s = I.worldSummary(W);
            T.eq(s.world.length, 1);
            T.eq(s.culture.length, 1);
            var html = I.renderWorldHTML(s);
            T.contains(html, "Ceasefire talks resume");
            T.contains(html, "Culture &amp; fashion");
            T.contains(html, 'href="https://x.test/c"');
        });
        T.it("escapes hostile titles", function () {
            var s = I.worldSummary({ world: [{ title: "<img src=x>", url: "https://x.test/e" }] });
            T.excludes(I.renderWorldHTML(s), "<img src=x>");
        });
        T.it("empty payload hides the panel", function () {
            T.eq(I.worldSummary(null), null);
            T.eq(I.worldSummary({ world: [], culture: [] }), null);
        });
    });

    T.describe("news center: ai pulse", function () {
        var P = { generated: "2026-09-23 08:00:00",
                  models: [{ id: "Qwen/Qwen3.8-27B", url: "https://huggingface.co/Qwen/Qwen3.8-27B",
                             task: "image-text-to-text", likes: 16103, downloads: 6912469 }],
                  papers: [{ title: "Ternary Scaling Laws",
                             url: "https://huggingface.co/papers/2609.01234", upvotes: 87 }] };
        T.it("models show compact download/like counts", function () {
            var html = I.renderAiPulseHTML(I.aiPulseSummary(P));
            T.contains(html, "Qwen/Qwen3.8-27B");
            T.contains(html, "6.9M downloads");
            T.contains(html, "16.1k likes");
            T.contains(html, "Ternary Scaling Laws");
            T.contains(html, "▲ 87");
        });
        T.it("either section alone justifies the panel; neither hides it", function () {
            T.ok(I.aiPulseSummary({ models: P.models, papers: [] }), "models alone");
            T.eq(I.aiPulseSummary({ models: [], papers: [] }), null);
        });
    });

    T.report();
})();
