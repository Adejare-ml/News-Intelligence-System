/* Tests for the global search core (index, scoring, grouping) and the
   dossier models. All pure, all DOM-free. */
(function () {
    "use strict";
    var S = window.AuraSearch;
    var D = window.AuraDossier;
    var R = window.AuraRouter;

    var DATA = {
        companies: [
            { Company: "Dangote Cement Plc", Industry: "Cement", "Risk Level": "High",
              "Mention Count": 12, "Last Seen": "2026-09-01" },
            { Company: "Access Holdings Plc", Industry: "Banking", "Risk Level": "Low" }
        ],
        people: [
            { Name: "Ada Obi", Position: "CEO", Organization: "Dangote Cement Plc",
              Event: "appointment", Date: "2026-08-01" },
            { Name: "Ada Obi", Position: "Director", Organization: "Acme Ltd",
              Event: "resignation", Date: "2026-09-01" }
        ],
        psc: [
            { "Person Name": "Ada Obi", Company: "Dangote Cement Plc", Percentage: "30%",
              "Intermediate Entities": "Mauritius HoldCo", "Verification Status": "Filed with CAC" }
        ],
        procurement: [
            { Agency: "Bureau of Public Procurement", Contractor: "Access Holdings Plc",
              Amount: "N2bn", Project: "IT overhaul" }
        ],
        articles: [
            { Title: "Dangote Cement Plc announces expansion", URL: "https://p.test/a",
              Source: "Punch", Summary: "expansion in Kano", Time: "2026-09-01T10:00:00" },
            { Title: "Unrelated market roundup", URL: "https://p.test/b", Summary: "x" }
        ]
    };

    T.describe("search scoring", function () {
        T.it("prefix beats whole-word beats substring beats subsequence", function () {
            T.eq(S.scoreToken("dangote cement", "dang"), 100);
            T.eq(S.scoreToken("access dangote", "dang"), 60);
            T.eq(S.scoreToken("xdangote", "dang"), 40);
            T.eq(S.scoreToken("d-a-n-g", "dang"), 20);
            T.eq(S.scoreToken("nothing here", "zzz"), 0);
        });

        T.it("multi-word queries AND their tokens", function () {
            var entries = S.buildIndex(DATA);
            var hits = S.searchIndex(entries, "dangote cement");
            T.ok(hits.length > 0, "matches exist");
            T.eq(S.searchIndex(entries, "dangote zebra").length, 0);
        });

        T.it("empty query returns nothing", function () {
            T.eq(S.searchIndex(S.buildIndex(DATA), "  ").length, 0);
        });
    });

    T.describe("search index + grouping", function () {
        T.it("routes entities through slugified router hashes", function () {
            var entries = S.buildIndex(DATA);
            var company = entries.filter(function (e) { return e.type === "company"; })[0];
            T.eq(company.nav.hash, "#/company/dangote-cement-plc");
            T.ok(R.matchRoute(company.nav.hash), "hash resolves against the router");
            var person = entries.filter(function (e) { return e.type === "person"; })[0];
            T.eq(person.nav.hash, "#/person/ada-obi");
        });

        T.it("articles open their source URL, never a fabricated route", function () {
            var entries = S.buildIndex(DATA);
            var article = entries.filter(function (e) { return e.type === "article"; })[0];
            T.eq(article.nav.href, "https://p.test/a");
        });

        T.it("groups cap per type and report the overflow", function () {
            var many = { companies: [] };
            for (var i = 0; i < 9; i++) many.companies.push({ Company: "Testco " + i });
            var groups = S.groupResults(S.searchIndex(S.buildIndex(many), "testco"), 5);
            T.eq(groups.length, 1);
            T.eq(groups[0].items.length, 5);
            T.eq(groups[0].total, 9);
        });

        T.it("escapes labels in rendered results", function () {
            var entries = S.buildIndex({ companies: [{ Company: "<b>Evil</b> Ltd" }] });
            var html = S.renderResultsHTML(S.groupResults(S.searchIndex(entries, "evil")));
            T.excludes(html, "<b>Evil");
            T.contains(html, "&lt;b&gt;");
        });
    });

    T.describe("company dossier", function () {
        T.it("assembles header, owners, procurement and mentions", function () {
            var m = D.companyDossier("dangote-cement-plc", DATA);
            T.eq(m.name, "Dangote Cement Plc");
            T.eq(m.header.risk, "High");
            T.eq(m.owners.length, 1);
            T.eq(m.owners[0].person, "Ada Obi");
            T.eq(m.articles.length, 1);
            T.contains(m.articles[0].title, "expansion");
        });

        T.it("unknown slug returns null and renders an honest empty state", function () {
            T.eq(D.companyDossier("no-such-co", DATA), null);
            var html = D.renderDossierHTML(null);
            T.contains(html, "No records match");
        });

        T.it("procurement-only entities still get a dossier", function () {
            var m = D.companyDossier("access-holdings-plc", DATA);
            T.eq(m.procurement.length, 1);
        });
    });

    T.describe("person dossier", function () {
        T.it("latest appearance leads the header and PSC rows attach", function () {
            var m = D.personDossier("ada-obi", DATA);
            T.eq(m.header.event, "resignation");
            T.eq(m.control.length, 1);
            T.contains(m.control[0].chain.join(" → "), "Mauritius HoldCo");
            T.eq(m.appearances.length, 2);
        });
    });

    T.describe("agency dossier + rendering", function () {
        T.it("agency dossier is procurement-scoped", function () {
            var m = D.agencyDossier("bureau-of-public-procurement", DATA);
            T.eq(m.procurement.length, 1);
            T.eq(D.agencyDossier("nowhere", DATA), null);
        });

        T.it("rendered dossiers escape data and link mentions safely", function () {
            var dirty = {
                companies: [{ Company: "<img src=x> Ltd" }],
                psc: [], procurement: [], people: [],
                articles: [{ Title: "<script>x</script> mentions <img src=x> Ltd",
                             URL: "javascript:alert(1)", Summary: "" }]
            };
            var html = D.renderDossierHTML(D.companyDossier("img-src-x-ltd", dirty));
            T.excludes(html, "<img src=x>");
            T.excludes(html, 'href="javascript:');
            T.contains(html, "&lt;img");
        });

        T.it("short names do not match every article", function () {
            T.eq(D.articleMentions(DATA.articles, "ab").length, 0);
        });
    });

    T.report();
})();
