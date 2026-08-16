/* Tests for the hash router's DOM-free core. */
(function () {
    "use strict";
    var R = window.AuraRouter;

    T.describe("route-hash detection", function () {
        T.it("claims only #/-prefixed hashes", function () {
            T.ok(R.isRouteHash("#/feed"));
            T.ok(R.isRouteHash("#/"));
        });

        T.it("leaves legacy anchors alone", function () {
            T.notOk(R.isRouteHash("#brief"), "legacy anchor must fall through to native scroll");
            T.notOk(R.isRouteHash("#register"));
            T.notOk(R.isRouteHash("#"));
            T.notOk(R.isRouteHash(""));
            T.notOk(R.isRouteHash(null));
        });
    });

    T.describe("parseHash", function () {
        T.it("splits path from query", function () {
            var p = R.parseHash("#/network?focus=first-holdco&depth=2");
            T.eq(p.path, "#/network");
            T.eq(p.query.focus, "first-holdco");
            T.eq(p.query.depth, "2");
        });

        T.it("tolerates a trailing slash", function () {
            T.eq(R.parseHash("#/feed/").path, "#/feed");
            T.eq(R.parseHash("#/").path, "#/", "bare root keeps its slash");
        });

        T.it("survives malformed percent-encoding in the query", function () {
            var p = R.parseHash("#/feed?bad=%zz");
            T.eq(p.path, "#/feed");
            T.eq(p.query.bad, "", "undecodable value degrades to empty, not a throw");
        });

        T.it("returns null for non-route hashes", function () {
            T.eq(R.parseHash("#brief"), null);
            T.eq(R.parseHash(""), null);
        });
    });

    T.describe("matchRoute", function () {
        T.it("matches every static route in the table", function () {
            T.eq(R.matchRoute("#/").view, "home");
            T.eq(R.matchRoute("#/brief").view, "brief");
            T.eq(R.matchRoute("#/feed").view, "feed");
            T.eq(R.matchRoute("#/psc").view, "psc-register");
            T.eq(R.matchRoute("#/network").view, "graph");
            T.eq(R.matchRoute("#/alerts").view, "alerts");
            T.eq(R.matchRoute("#/investigations").view, "investigations");
        });

        T.it("captures and decodes dossier slugs", function () {
            var m = R.matchRoute("#/company/first-holdco-plc");
            T.eq(m.view, "company-dossier");
            T.eq(m.params.slug, "first-holdco-plc");

            var enc = R.matchRoute("#/person/femi%20otedola");
            T.eq(enc.params.slug, "femi otedola", "URI encoding is decoded");
        });

        T.it("carries the query through to the match", function () {
            var m = R.matchRoute("#/network?focus=abc");
            T.eq(m.view, "graph");
            T.eq(m.query.focus, "abc");
        });

        T.it("rejects unknown paths, wrong arity and empty params", function () {
            T.eq(R.matchRoute("#/nope"), null);
            T.eq(R.matchRoute("#/company"), null, "missing slug segment");
            T.eq(R.matchRoute("#/company/a/b"), null, "extra segment");
            T.eq(R.matchRoute("#/company/%zz"), null, "undecodable slug cannot match");
            T.eq(R.matchRoute("#brief"), null, "legacy anchor is not a route");
        });
    });

    T.describe("registry and dispatch", function () {
        T.it("pre-registers every section-scroll view", function () {
            // Handled (returns the view name) even headless: the scroll
            // itself no-ops without a DOM, but the view must be known.
            T.eq(R.dispatch("#/brief"), "brief");
            T.eq(R.dispatch("#/feed"), "feed");
            T.eq(R.dispatch("#/psc"), "psc-register");
            T.eq(R.dispatch("#/"), "home");
        });

        T.it("reports unbuilt views as unhandled so the shell can fall back", function () {
            T.eq(R.dispatch("#/investigations"), null, "no slice has built this view yet");
        });

        T.it("routes params and query into a registered handler", function () {
            var seen = null;
            R.register("company-dossier", function (params, query) {
                seen = { slug: params.slug, tab: query.tab };
            });
            T.eq(R.dispatch("#/company/geregu-power-plc?tab=owners"), "company-dossier");
            T.eq(seen.slug, "geregu-power-plc");
            T.eq(seen.tab, "owners");
        });

        T.it("contains a throwing handler instead of crashing dispatch", function () {
            R.register("agency-dossier", function () {
                throw new Error("boom");
            });
            // dispatch logs the contained error via console.error, which is
            // correct in production but noise in CI output -- mute it for
            // exactly this call.
            var realError = console.error;
            console.error = function () {};
            try {
                T.eq(R.dispatch("#/agency/nerc"), "agency-dossier",
                    "a handler that throws is still that view's handler");
            } finally {
                console.error = realError;
            }
        });

        T.it("returns null for non-route hashes", function () {
            T.eq(R.dispatch("#register"), null);
            T.eq(R.dispatch(""), null);
        });
    });

    T.report();
})();
