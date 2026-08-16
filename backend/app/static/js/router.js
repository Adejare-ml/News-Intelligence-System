/**
 * Hash router: #/-prefixed routes on top of the existing anchor-scroll nav.
 *
 * Chosen over path routing deliberately. The live site is GitHub Pages,
 * which has no server-side rewrites: /company/x would 404 on a fresh load,
 * while a hash route always resolves client-side because the server only
 * ever serves index.html. Legacy anchors (#brief, #register, #workspace,
 * #network -- no leading slash) are never intercepted, so every existing
 * bookmark and nav link keeps working unchanged.
 *
 * Split the same way as psc-core.js: a DOM-free core (parseHash,
 * matchRoute, the registry) that runs in the headless test sandbox
 * (tests/frontend/run.js), and a thin shell whose DOM wiring is guarded so
 * loading this file without a browser is a no-op rather than a crash.
 *
 * Views land in two kinds:
 *  - section-scroll views (home, brief, feed, psc-register, graph, alerts)
 *    scroll to the existing page section, exactly like the anchor nav.
 *    psc-register scrolls to #register until Slice F turns it into a page.
 *  - page views (dossiers, investigations) are registered by later slices
 *    via AuraRouter.register(view, handler). Until a handler exists, a
 *    matched-but-unbuilt route falls back to home instead of a dead page.
 */
(function (global) {
    "use strict";

    var ROUTES = [
        { pattern: "#/",               view: "home" },
        { pattern: "#/brief",          view: "brief" },
        { pattern: "#/feed",           view: "feed" },
        { pattern: "#/psc",            view: "psc-register" },
        { pattern: "#/network",        view: "graph" },
        { pattern: "#/alerts",         view: "alerts" },
        { pattern: "#/investigations", view: "investigations" },
        { pattern: "#/company/:slug",  view: "company-dossier" },
        { pattern: "#/person/:slug",   view: "person-dossier" },
        { pattern: "#/agency/:slug",   view: "agency-dossier" }
    ];

    // view -> element id of the existing section it scrolls to.
    var SECTION_VIEWS = {
        "home": "top",
        "brief": "brief",
        "feed": "workspace",
        "psc-register": "register",
        "graph": "network",
        "alerts": "alerts"
    };

    function isRouteHash(hash) {
        return typeof hash === "string" && hash.indexOf("#/") === 0;
    }

    function safeDecode(part) {
        try {
            return decodeURIComponent(part);
        } catch (e) {
            // Malformed percent-encoding ("%zz") must not throw out of the
            // hashchange handler; the segment simply fails to match.
            return null;
        }
    }

    /**
     * "#/network?focus=abc" -> { path: "#/network", query: { focus: "abc" } }.
     * Returns null for anything that is not a #/ route hash.
     */
    function parseHash(hash) {
        if (!isRouteHash(hash)) return null;
        var raw = hash;
        var query = {};
        var qi = raw.indexOf("?");
        if (qi !== -1) {
            var pairs = raw.slice(qi + 1).split("&");
            raw = raw.slice(0, qi);
            for (var i = 0; i < pairs.length; i++) {
                if (!pairs[i]) continue;
                var kv = pairs[i].split("=");
                var key = safeDecode(kv[0] || "");
                if (!key) continue;
                var val = safeDecode(kv.slice(1).join("=") || "");
                query[key] = val === null ? "" : val;
            }
        }
        // Tolerate a trailing slash ("#/feed/" is "#/feed"), except the bare "#/".
        if (raw.length > 2 && raw.charAt(raw.length - 1) === "/") {
            raw = raw.slice(0, -1);
        }
        return { path: raw, query: query };
    }

    /**
     * Pure route matcher: hash in, { view, params, query } or null out.
     * ":name" pattern segments capture one non-empty, URI-decoded segment.
     */
    function matchRoute(hash, table) {
        var parsed = parseHash(hash);
        if (!parsed) return null;
        var routes = table || ROUTES;
        var segs = parsed.path === "#/" ? [] : parsed.path.slice(2).split("/");
        for (var i = 0; i < routes.length; i++) {
            var pattern = routes[i].pattern;
            var psegs = pattern === "#/" ? [] : pattern.slice(2).split("/");
            if (psegs.length !== segs.length) continue;
            var params = {};
            var matched = true;
            for (var j = 0; j < psegs.length; j++) {
                if (psegs[j].charAt(0) === ":") {
                    var value = safeDecode(segs[j] || "");
                    if (!value) { matched = false; break; }
                    params[psegs[j].slice(1)] = value;
                } else if (psegs[j] !== segs[j]) {
                    matched = false;
                    break;
                }
            }
            if (matched) {
                return { view: routes[i].view, params: params, query: parsed.query };
            }
        }
        return null;
    }

    // ------------------------------------------------------------------
    // View registry. Later slices attach page renderers here; this file
    // only registers the section-scroll views itself.
    // ------------------------------------------------------------------

    var handlers = {};

    function register(view, handler) {
        handlers[view] = handler;
    }

    /**
     * Resolve and run the handler for a hash. Returns the handled view
     * name, or null when the hash is not a route, matches nothing, or
     * matches a view no slice has built yet -- the caller decides what a
     * null means (the shell falls back to home; tests just assert on it).
     */
    function dispatch(hash) {
        var m = matchRoute(hash);
        if (!m) return null;
        var handler = handlers[m.view];
        if (typeof handler !== "function") return null;
        try {
            handler(m.params, m.query);
        } catch (err) {
            if (global.console && global.console.error) {
                global.console.error("AuraRouter: '" + m.view + "' handler failed:", err);
            }
        }
        return m.view;
    }

    // ------------------------------------------------------------------
    // DOM shell. Every browser API access is guarded so the headless test
    // sandbox (no location, no addEventListener, stub document) can load
    // this file and exercise the core above.
    // ------------------------------------------------------------------

    function scrollToSection(id) {
        var doc = global.document;
        if (!doc || typeof doc.getElementById !== "function") return false;
        var el = doc.getElementById(id);
        if (!el || typeof el.scrollIntoView !== "function") return false;
        var reduce = false;
        try {
            reduce = !!(global.matchMedia
                && global.matchMedia("(prefers-reduced-motion: reduce)").matches);
        } catch (e) { /* no matchMedia: scroll without smooth behavior */ }
        el.scrollIntoView(reduce ? {} : { behavior: "smooth" });
        return true;
    }

    Object.keys(SECTION_VIEWS).forEach(function (view) {
        register(view, function () {
            scrollToSection(SECTION_VIEWS[view]);
        });
    });

    function navigate(hash) {
        if (global.location) {
            global.location.hash = hash;
        }
    }

    function onHashChange() {
        var hash = (global.location && global.location.hash) || "";
        if (!isRouteHash(hash)) return; // legacy anchors: not ours, never touched
        if (dispatch(hash) === null) {
            if (global.console && global.console.warn) {
                global.console.warn("AuraRouter: no view for '" + hash + "', falling back to home");
            }
            scrollToSection(SECTION_VIEWS.home);
        }
    }

    if (typeof global.addEventListener === "function") {
        global.addEventListener("hashchange", onHashChange);
        var doc = global.document;
        if (doc && typeof doc.addEventListener === "function" && doc.readyState === "loading") {
            // Handle a deep link (#/company/x pasted into a fresh tab) once
            // the sections it may scroll to actually exist.
            doc.addEventListener("DOMContentLoaded", onHashChange);
        } else {
            onHashChange();
        }
    }

    global.AuraRouter = {
        ROUTES: ROUTES,
        SECTION_VIEWS: SECTION_VIEWS,
        isRouteHash: isRouteHash,
        parseHash: parseHash,
        matchRoute: matchRoute,
        register: register,
        dispatch: dispatch,
        navigate: navigate
    };
})(window);
