/* Tests for the PSC domain engine and the report markdown parser. */
(function () {
    "use strict";
    var P = window.AuraPSC;

    T.describe("Nigerian disclosure bands (CAMA 2020 s.868)", function () {
        T.it("classifies the four disclosable bands", function () {
            T.eq(P.classifyBand("81.4%").id, "BAND_75_100");
            T.eq(P.classifyBand("63.2%").id, "BAND_50_75");
            T.eq(P.classifyBand("28.5%").id, "BAND_25_50");
            T.eq(P.classifyBand("6.8%").id, "BAND_5_25");
        });

        T.it("uses 5% as the threshold, not the UK/FATF 25%", function () {
            T.eq(P.classifyBand("5%").id, "BAND_5_25", "5% is a statutory PSC in Nigeria");
            T.eq(P.classifyBand("4.99%").id, "BELOW_THRESHOLD");
            T.eq(P.classifyBand("24%").id, "BAND_5_25", "24% must not be below threshold");
        });

        T.it("returns null when nothing was disclosed", function () {
            T.eq(P.classifyBand(null), null);
            T.eq(P.classifyBand(""), null);
            T.eq(P.classifyBand("N/A"), null);
            T.eq(P.classifyBand(undefined), null);
        });

        T.it("accepts bare numbers as well as percent strings", function () {
            T.eq(P.classifyBand(28.5).id, "BAND_25_50");
            T.eq(P.classifyBand(0).id, "BELOW_THRESHOLD");
        });
    });

    T.describe("Red-flag rules", function () {
        T.it("flags voting rights materially above equity", function () {
            var rec = { "Person Name": "A", Company: "C", "Direct %": "11.0%", "Indirect %": "52.2%", "Voting Rights %": "88.0%" };
            var flags = P.redFlagsFor(rec, P.buildContext([rec]));
            T.ok(flags.some(function (f) { return f.id === "R3_VOTING_MISMATCH"; }), "expected a voting mismatch flag");
        });

        T.it("does not flag when voting tracks equity", function () {
            var rec = { "Person Name": "A", Company: "C", "Direct %": "40%", "Indirect %": "38%", "Voting Rights %": "78%" };
            var flags = P.redFlagsFor(rec, P.buildContext([rec]));
            T.notOk(flags.some(function (f) { return f.id === "R3_VOTING_MISMATCH"; }));
        });

        T.it("flags a secrecy-jurisdiction vehicle", function () {
            var rec = { "Person Name": "A", Company: "C", "Intermediate Entities": "Meridian Trust (Mauritius) Limited" };
            var flags = P.redFlagsFor(rec, P.buildContext([rec]));
            T.ok(flags.some(function (f) { return f.id === "R7_SECRECY_VEHICLE"; }));
        });

        T.it("does not flag an ordinary domestic vehicle", function () {
            var rec = { "Person Name": "A", Company: "C", "Intermediate Entities": "Harmattan Industries Limited" };
            var flags = P.redFlagsFor(rec, P.buildContext([rec]));
            T.notOk(flags.some(function (f) { return f.id === "R7_SECRECY_VEHICLE"; }));
        });

        T.it("flags sub-threshold structuring only when several holders are parked under 5%", function () {
            var a = { "Person Name": "A", Company: "Sahel", Percentage: "4.7%" };
            var b = { "Person Name": "B", Company: "Sahel", Percentage: "4.9%" };
            var ctx = P.buildContext([a, b]);
            T.ok(P.redFlagsFor(a, ctx).some(function (f) { return f.id === "R1_SUB_THRESHOLD"; }));

            var lone = { "Person Name": "C", Company: "Solo", Percentage: "4.7%" };
            var soloCtx = P.buildContext([lone]);
            T.notOk(P.redFlagsFor(lone, soloCtx).some(function (f) { return f.id === "R1_SUB_THRESHOLD"; }),
                "a single sub-5% holding is not a pattern");
        });

        T.it("flags a politically exposed holder", function () {
            var rec = { "Person Name": "A", Company: "C", "PEP Status": "Yes - Politically exposed person" };
            T.ok(P.redFlagsFor(rec, P.buildContext([rec])).some(function (f) { return f.id === "R9_PEP"; }));
            var no = { "Person Name": "A", Company: "C", "PEP Status": "No" };
            T.notOk(P.redFlagsFor(no, P.buildContext([no])).some(function (f) { return f.id === "R9_PEP"; }));
        });

        T.it("flags cross-entity portfolios only across distinct companies", function () {
            var one = { "Person Name": "Ada", Company: "X" };
            var two = { "Person Name": "Ada", Company: "Y" };
            var ctx = P.buildContext([one, two]);
            T.ok(P.redFlagsFor(one, ctx).some(function (f) { return f.id === "R12_CROSS_ENTITY"; }));
        });

        T.it("ranks high severity ahead of medium", function () {
            var rec = {
                "Person Name": "Ada", Company: "C",
                "Intermediate Entities": "Meridian Trust (Mauritius) Limited",
                "Change Type": "Increased Control", "Previous Holder": "Someone"
            };
            var flags = P.redFlagsFor(rec, P.buildContext([rec, { "Person Name": "Ada", Company: "D" }]));
            T.ok(flags.length >= 2, "expected multiple flags");
            T.eq(flags[0].severity, "high");
        });

        T.it("never throws on an empty or malformed record", function () {
            T.eq(P.redFlagsFor(null), []);
            P.redFlagsFor({}, P.buildContext([{}]));
            P.redFlagsFor({ Percentage: "banana" }, P.buildContext([{}]));
        });
    });

    T.describe("Control chain", function () {
        T.it("is two steps for a direct holding", function () {
            var chain = P.controlChain({ "Person Name": "Ada", Company: "X", "Intermediate Entities": "Direct Holding" });
            T.eq(chain.length, 2);
            T.eq(chain[0].kind, "person");
            T.eq(chain[1].kind, "company");
        });

        T.it("inserts the vehicle when one exists", function () {
            var chain = P.controlChain({ "Person Name": "Ada", Company: "X", "Intermediate Entities": "Meridian Trust (Mauritius) Limited" });
            T.eq(chain.length, 3);
            T.eq(chain[1].kind, "vehicle");
        });
    });

    T.describe("Portfolio summary", function () {
        T.it("detects seeded records so the demo banner can fire", function () {
            var seeded = P.summarise([{ "Person Name": "A", Company: "C", Source: "seed" }]);
            T.eq(seeded.isDemo, true);
            var real = P.summarise([{ "Person Name": "A", Company: "C", Source: "extracted" }]);
            T.eq(real.isDemo, false);
        });

        T.it("reports a null mean rather than 0 when nothing is disclosed", function () {
            var s = P.summarise([{ "Person Name": "A", Company: "C" }]);
            T.eq(s.meanStake, null, "an undisclosed stake must not read as 0%");
        });

        T.it("computes the disclosure rate from filing references", function () {
            var s = P.summarise([
                { "Person Name": "A", Company: "C", "Regulatory Filing Ref": "CAC/PSC/1" },
                { "Person Name": "B", Company: "D", "Regulatory Filing Ref": "" }
            ]);
            T.eq(s.disclosureRate, 0.5);
        });

        T.it("handles an empty register", function () {
            var s = P.summarise([]);
            T.eq(s.total, 0);
            T.eq(s.disclosureRate, null);
            T.eq(s.isDemo, false);
        });
    });

    T.describe("Report markdown", function () {
        var md = window.AuraReportMarkdown && window.AuraReportMarkdown.parseMarkdown;

        T.it("is exposed for testing", function () {
            T.ok(typeof md === "function", "parseMarkdown should be reachable");
        });

        T.it("does not swallow headings between the first and last list item", function () {
            var out = md("### Key Developments\n\n* one\n* two\n\n### High Risk Alerts\n\n* three\n");
            // The old /(<li>.*<\/li>)/sg wrapped everything from the first <li>
            // to the last in a single <ul>, nesting every heading inside it.
            var firstUlEnd = out.indexOf("</ul>");
            var alertsHeading = out.indexOf("High Risk Alerts");
            T.ok(firstUlEnd !== -1 && firstUlEnd < alertsHeading,
                "the first list must close before the next heading");
            T.contains(out, "<h3", "headings should survive");
        });

        T.it("renders indented sub-bullets as list items, not literal asterisks", function () {
            var out = md("* Parent\n  * Child\n");
            T.eq((out.match(/<li/g) || []).length, 2);
            T.excludes(out, "* Child", "the nested marker must not render literally");
        });

        T.it("emits headings with ids for deep links", function () {
            T.contains(md("## Beneficial Ownership\n"), 'id="sec-beneficial-ownership"');
        });

        T.it("escapes HTML in report content", function () {
            var out = md("Normal <script>alert(1)</script> text\n");
            T.excludes(out, "<script>");
            T.contains(out, "&lt;script&gt;");
        });

        T.it("rejects javascript: links but keeps http ones", function () {
            T.excludes(md("[x](javascript:alert(1))\n"), "javascript:");
            T.contains(md("[x](https://example.com/a?b=1&c=2)\n"), "https://example.com/a?b=1");
        });

        T.it("does not double-encode ampersands in link URLs", function () {
            T.excludes(md("[x](https://example.com/?a=1&b=2)\n"), "&amp;amp;");
        });

        T.it("renders bold and italics without eating list markers", function () {
            var out = md("* **Bold item**: detail\n* Another *emphasis* here\n");
            T.contains(out, "<strong>Bold item</strong>");
            T.contains(out, "<em>emphasis</em>");
        });

        T.it("no longer injects fabricated report copy", function () {
            var out = md("*No significant alerts triggered in this run window (Gemini generation failed).*\n");
            T.excludes(out, "Tinubu", "the client must not invent report content");
            T.excludes(out, "darkest tunnel");
        });

        T.it("renders horizontal rules and blockquotes", function () {
            T.contains(md("---\n"), "<hr");
            T.contains(md("> note\n"), "<blockquote>");
        });

        T.it("returns an empty string for empty input", function () {
            T.eq(md(""), "");
            T.eq(md(null), "");
        });

        T.it("demotes headings by headingOffset so the page keeps one h1", function () {
            var out = md("# Report title\n\n## Section\n", { headingOffset: 1 });
            T.contains(out, "<h2");
            T.contains(out, "<h3");
            T.excludes(out, "<h1", "the embedded report must not emit a second h1");
        });

        T.it("clamps demotion at h6", function () {
            T.contains(md("#### Deep\n", { headingOffset: 4 }), "<h6");
        });
    });

    T.describe("Red-flag rules the dashboard used to answer differently", function () {
        // app.js carried a second implementation of these rules that had
        // drifted from the engine. Each case below is one way the two
        // disagreed about the same record.

        T.it("measures the voting gap against direct AND indirect equity", function () {
            // 4% held directly, 24.5% through a vehicle, 28.5% of the votes:
            // the holder votes exactly what they own, so there is no anomaly.
            // The old dashboard rule compared votes against the direct stake
            // only (28.5 - 4 = 24.5 > 15) and reported a discrepancy.
            var rec = {
                "Person Name": "A", Company: "C",
                "Direct %": "4.0%", "Indirect %": "24.5%", "Voting Rights %": "28.5%"
            };
            var flags = P.redFlagsFor(rec, P.buildContext([rec]));
            T.notOk(flags.some(function (f) { return f.id === "R3_VOTING_MISMATCH"; }),
                "control that tracks ownership is not a red flag");
        });

        T.it("does not flag a gap between 15 and 20 points", function () {
            var rec = {
                "Person Name": "A", Company: "C",
                "Direct %": "10%", "Indirect %": "0%", "Voting Rights %": "28%"
            };
            var flags = P.redFlagsFor(rec, P.buildContext([rec]));
            T.notOk(flags.some(function (f) { return f.id === "R3_VOTING_MISMATCH"; }),
                "the threshold is 20 points, not the dashboard's old 15");
        });

        T.it("recognises secrecy jurisdictions beyond the three it used to match", function () {
            ["Tengen Holdings (Cayman) Limited", "Lekki BVI Partners", "Sahel Seychelles Ltd"]
                .forEach(function (vehicle) {
                    var rec = { "Person Name": "A", Company: "C", "Intermediate Entities": vehicle };
                    var flags = P.redFlagsFor(rec, P.buildContext([rec]));
                    T.ok(flags.some(function (f) { return f.id === "R7_SECRECY_VEHICLE"; }),
                        vehicle + " must raise a secrecy-vehicle flag");
                });
        });

        T.it("still carries the rules the dashboard had no equivalent of", function () {
            var nominee = { "Person Name": "A", Company: "C", "Intermediate Entities": "Sahel Nominees Limited" };
            T.ok(P.redFlagsFor(nominee, P.buildContext([nominee])).some(function (f) { return f.id === "R4_NOMINEE"; }));

            var unquantified = { "Person Name": "B", Company: "D" };
            T.ok(P.redFlagsFor(unquantified, P.buildContext([unquantified])).some(function (f) { return f.id === "R6_UNKNOWN_OWNER"; }));
        });

        T.it("returns ranked objects, not bare strings", function () {
            var rec = {
                "Person Name": "A", Company: "C",
                "PEP Status": "Yes - Politically exposed person",
                "Intermediate Entities": "Meridian Trust (Mauritius) Limited"
            };
            var flags = P.redFlagsFor(rec, P.buildContext([rec]));
            T.ok(flags.length >= 2);
            T.eq(flags[0].severity, "high", "high severity must sort first");
            flags.forEach(function (f) {
                T.ok(f.id && f.title && f.detail, "every flag carries id, title and detail");
            });
        });
    });

    T.describe("Cross-entity portfolio counts companies, not rows", function () {
        // The register appends a row per extraction, so the same disclosure
        // lands twice whenever two articles report it. Anything reasoning
        // about a portfolio has to collapse that.

        // The real shape of the live register on 2026-08-10: four rows for one
        // holder, two of them byte-identical, across two companies.
        var LIVE_SHAPE = [
            { "Person Name": "Femi Otedola", Company: "Geregu Power Plc" },
            { "Person Name": "Femi Otedola", Company: "First HoldCo" },
            { "Person Name": "Femi Otedola", Company: "First HoldCo" },
            { "Person Name": "Femi Otedola", Company: "First HoldCo" }
        ];

        T.it("reports the number of companies, not the number of rows", function () {
            var ctx = P.buildContext(LIVE_SHAPE);
            T.eq(P.companiesFor(LIVE_SHAPE[0], ctx).length, 2, "four rows, two companies");
            var flag = P.redFlagsFor(LIVE_SHAPE[0], ctx)
                .filter(function (f) { return f.id === "R12_CROSS_ENTITY"; })[0];
            T.ok(flag, "two companies is still a cross-entity portfolio");
            T.contains(flag.detail, "in 2 tracked companies");
            T.excludes(flag.detail, "in 4 tracked companies", "row count must not reach the badge");
        });

        T.it("does not flag duplicate rows against a single company", function () {
            var dupes = [
                { "Person Name": "A", Company: "Solo Plc" },
                { "Person Name": "A", Company: "Solo Plc" }
            ];
            var ctx = P.buildContext(dupes);
            T.eq(P.companiesFor(dupes[0], ctx).length, 1);
            T.notOk(P.redFlagsFor(dupes[0], ctx).some(function (f) { return f.id === "R12_CROSS_ENTITY"; }),
                "the same company twice is paperwork, not a cross-holding");
        });

        T.it("matches company names regardless of case and surrounding space", function () {
            var recs = [
                { "Person Name": "A", Company: "Zenith Bank Plc" },
                { "Person Name": "A", Company: "  zenith bank plc  " }
            ];
            T.eq(P.companiesFor(recs[0], P.buildContext(recs)).length, 1);
        });

        T.it("ignores rows with no company rather than counting them", function () {
            var recs = [
                { "Person Name": "A", Company: "Real Plc" },
                { "Person Name": "A", Company: "" },
                { "Person Name": "A" }
            ];
            T.eq(P.companiesFor(recs[0], P.buildContext(recs)).length, 1);
        });

        T.it("still flags a genuine multi-company holder", function () {
            var recs = [
                { "Person Name": "A", Company: "One Plc" },
                { "Person Name": "A", Company: "Two Plc" },
                { "Person Name": "A", Company: "Three Plc" }
            ];
            var flag = P.redFlagsFor(recs[0], P.buildContext(recs))
                .filter(function (f) { return f.id === "R12_CROSS_ENTITY"; })[0];
            T.ok(flag);
            T.contains(flag.detail, "in 3 tracked companies");
        });
    });

    T.describe("Empty-state attribution", function () {
        T.it("reports a failed load as a failed load, never as a filter result", function () {
            var s = P.emptyStateFor({ loadState: "error", error: "404 Not Found", totalRecords: 0 });
            T.eq(s.kind, "load-error", "a broken fetch must not read as 'no one is in control'");
            T.eq(s.action, "retry");
            T.eq(s.reason, "404 Not Found");
        });

        T.it("prefers the load error even when a filter is also active", function () {
            var s = P.emptyStateFor({
                loadState: "error", error: "boom", totalRecords: 0,
                filterId: "cross", filterLabel: "Cross-Holdings", query: "otedola"
            });
            T.eq(s.kind, "load-error", "the filter cannot be blamed for data that never arrived");
        });

        T.it("distinguishes a register that loaded and is genuinely empty", function () {
            var s = P.emptyStateFor({ loadState: "ready", totalRecords: 0 });
            T.eq(s.kind, "register-empty");
            T.eq(s.action, null, "there is nothing for the analyst to retry or clear");
        });

        T.it("attributes an emptied view to the filter that emptied it", function () {
            var s = P.emptyStateFor({
                loadState: "ready", totalRecords: 10,
                filterId: "pep", filterLabel: "PEP Proximity"
            });
            T.eq(s.kind, "filtered-out");
            T.eq(s.action, "clear");
            T.eq(s.total, 10, "the count of loaded records proves the data is there");
            T.eq(s.filterLabel, "PEP Proximity");
        });

        T.it("blames the search alone when no chip is narrowing the view", function () {
            var s = P.emptyStateFor({
                loadState: "ready", totalRecords: 10,
                filterId: "all", filterLabel: "All Disclosures", query: "zzzz"
            });
            T.eq(s.filterLabel, "", "'All Disclosures' excludes nothing and must not be named");
            T.eq(s.query, "zzzz");
        });

        T.it("names both when a chip and a search are each narrowing", function () {
            var s = P.emptyStateFor({
                loadState: "ready", totalRecords: 10,
                filterId: "cross", filterLabel: "Cross-Holdings", query: "zzzz"
            });
            T.eq(s.filterLabel, "Cross-Holdings");
            T.eq(s.query, "zzzz");
        });

        T.it("treats a missing input object as an empty register, not an error", function () {
            T.eq(P.emptyStateFor().kind, "register-empty");
            T.eq(P.emptyStateFor({}).kind, "register-empty");
        });
    });

    T.report();
})();
