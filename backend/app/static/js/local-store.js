/**
 * Per-device local state (Tier 1 Slice H): the watchlist and dismissed
 * alerts. Everything here is deliberately browser-local -- there is no
 * account system and the site is static, so the honest contract, stated
 * in the UI wherever this state surfaces, is "saved only in this
 * browser".
 *
 * Layout: one versioned document under "aura:local:v1" for state worth
 * migrating later (the watchlist), and a plain id array under
 * "aura:alerts:dismissed" for dismissals, which are cheap to lose.
 *
 * Split like every other module: pure state transforms first (tested
 * headless), then storage accessors where every localStorage touch is
 * wrapped -- private windows and blocked site data make the accessor
 * itself throw, and a broken store must degrade to "nothing saved",
 * never to a broken page.
 */
(function (global) {
    "use strict";

    var STORE_KEY = "aura:local:v1";
    var DISMISS_KEY = "aura:alerts:dismissed";
    var DISMISS_CAP = 200;

    // ------------------------------------------------------------------
    // Pure core.
    // ------------------------------------------------------------------

    function emptyState() {
        return { version: 1, watchlist: [] };
    }

    /** Coerce whatever was stored into a valid state document. */
    function normalizeState(raw) {
        if (!raw || typeof raw !== "object" || raw.version !== 1) return emptyState();
        var list = Array.isArray(raw.watchlist) ? raw.watchlist : [];
        return {
            version: 1,
            watchlist: list.filter(function (e) {
                return e && typeof e.type === "string" && typeof e.slug === "string"
                    && e.type && e.slug;
            }).map(function (e) {
                return { type: e.type, slug: e.slug, label: String(e.label || e.slug) };
            })
        };
    }

    function watchKey(type, slug) {
        return type + "/" + slug;
    }

    function isWatched(state, type, slug) {
        var s = normalizeState(state);
        for (var i = 0; i < s.watchlist.length; i++) {
            if (watchKey(s.watchlist[i].type, s.watchlist[i].slug) === watchKey(type, slug)) {
                return true;
            }
        }
        return false;
    }

    /** Non-mutating add/remove of one entry {type, slug, label}. */
    function toggleWatch(state, entry) {
        var s = normalizeState(state);
        if (!entry || !entry.type || !entry.slug) return s;
        var key = watchKey(entry.type, entry.slug);
        var without = s.watchlist.filter(function (e) {
            return watchKey(e.type, e.slug) !== key;
        });
        if (without.length === s.watchlist.length) {
            without.push({ type: entry.type, slug: entry.slug, label: String(entry.label || entry.slug) });
        }
        return { version: 1, watchlist: without };
    }

    /**
     * Stable id for one alert, so a dismissal survives re-renders and
     * reloads. Keyed on the article URL when there is one (the alert's
     * identity is the story), else the title; severity is folded in so an
     * alert that escalates from elevated to critical resurfaces.
     */
    function alertId(alert) {
        var a = alert || {};
        var basis = String(a.severity || "").toLowerCase() + "|"
            + ((a.article && a.article.url) || a.title || "");
        var hash = 5381;
        for (var i = 0; i < basis.length; i++) {
            hash = ((hash << 5) + hash + basis.charCodeAt(i)) | 0;
        }
        return "a" + (hash >>> 0).toString(36);
    }

    /** Partition alerts into { visible, dismissed } given dismissed ids. */
    function splitAlerts(alerts, dismissedIds) {
        var set = {};
        (dismissedIds || []).forEach(function (id) { set[id] = true; });
        var visible = [];
        var dismissed = [];
        (alerts || []).forEach(function (alert) {
            (set[alertId(alert)] ? dismissed : visible).push(alert);
        });
        return { visible: visible, dismissed: dismissed };
    }

    /**
     * Keep the dismissed set from growing forever: ids no longer present
     * in the current alert window have nothing left to hide. A hard cap
     * guards the pathological case either way.
     */
    function pruneDismissed(dismissedIds, currentAlerts) {
        var current = {};
        (currentAlerts || []).forEach(function (a) { current[alertId(a)] = true; });
        return (dismissedIds || [])
            .filter(function (id) { return current[id]; })
            .slice(0, DISMISS_CAP);
    }

    // ------------------------------------------------------------------
    // Storage accessors -- every touch guarded.
    // ------------------------------------------------------------------

    function loadState() {
        try {
            return normalizeState(JSON.parse(global.localStorage.getItem(STORE_KEY)));
        } catch (e) {
            return emptyState();
        }
    }

    function saveState(state) {
        try {
            global.localStorage.setItem(STORE_KEY, JSON.stringify(normalizeState(state)));
            return true;
        } catch (e) {
            return false;
        }
    }

    function loadDismissed() {
        try {
            var raw = JSON.parse(global.localStorage.getItem(DISMISS_KEY));
            return Array.isArray(raw) ? raw.filter(function (x) { return typeof x === "string"; }) : [];
        } catch (e) {
            return [];
        }
    }

    function saveDismissed(ids) {
        try {
            global.localStorage.setItem(DISMISS_KEY, JSON.stringify((ids || []).slice(0, DISMISS_CAP)));
            return true;
        } catch (e) {
            return false;
        }
    }

    global.AuraLocalStore = {
        STORE_KEY: STORE_KEY,
        DISMISS_KEY: DISMISS_KEY,
        emptyState: emptyState,
        normalizeState: normalizeState,
        isWatched: isWatched,
        toggleWatch: toggleWatch,
        alertId: alertId,
        splitAlerts: splitAlerts,
        pruneDismissed: pruneDismissed,
        loadState: loadState,
        saveState: saveState,
        loadDismissed: loadDismissed,
        saveDismissed: saveDismissed
    };
})(window);
