/**
 * Feed filter state <-> URL, plus the pure predicates behind the new
 * date-range and source controls (round 5, Package 23).
 *
 * The intelligence feed's filters (category, risk, search, sort) lived
 * only in closure variables: a filtered view could not be shared, and
 * reload lost it. The router already parses "#/feed?..." queries; this
 * module owns the (de)serialisation and the two new predicates so the
 * logic runs in the headless suite -- app.js just wires DOM events.
 *
 * Same IIFE contract as every module here: DOM-free, no fetches.
 */
(function (global) {
    "use strict";

    var DAY_CHOICES = [0, 7, 30];   // 0 = all time

    var DEFAULTS = {
        days: 0,
        source: "",
        risk: "",
        category: "",
        q: "",
        sort: "newest"
    };

    /** Query object (from AuraRouter.parseHash) -> complete filter state. */
    function parseQuery(query) {
        query = query || {};
        var days = parseInt(query.days, 10);
        if (DAY_CHOICES.indexOf(days) === -1) days = DEFAULTS.days;
        return {
            days: days,
            source: String(query.src || "").trim(),
            risk: String(query.risk || "").trim(),
            category: String(query.cat || "").trim(),
            q: String(query.q || "").trim(),
            sort: query.sort === "risk" ? "risk" : DEFAULTS.sort
        };
    }

    /**
     * Filter state -> "#/feed?days=7&src=Punch" hash, or "" when every
     * field sits at its default (a bare "#/feed" would just scroll).
     */
    function serialize(state) {
        state = state || {};
        var parts = [];
        function push(key, value) {
            parts.push(key + "=" + encodeURIComponent(value));
        }
        if (DAY_CHOICES.indexOf(state.days) !== -1 && state.days !== 0) push("days", state.days);
        if (state.source) push("src", state.source);
        if (state.risk) push("risk", state.risk);
        if (state.category) push("cat", state.category);
        if (state.q) push("q", state.q);
        if (state.sort === "risk") push("sort", "risk");
        return parts.length ? "#/feed?" + parts.join("&") : "";
    }

    /**
     * True when the article's timestamp falls inside the last `days` days.
     * days 0 accepts everything, and so does an unparseable stamp -- a
     * date filter must narrow, never silently hide records whose Time
     * cell is in a format Date.parse cannot read.
     */
    function withinDays(timeValue, days, now) {
        if (!days) return true;
        var t = Date.parse(String(timeValue || ""));
        if (isNaN(t)) return true;
        var ref = (now instanceof Date) ? now.getTime() : Date.now();
        return ref - t <= days * 86400000;
    }

    /** Sorted unique source names for the dropdown; blanks dropped. */
    function sourceOptions(articles) {
        var seen = {};
        var out = [];
        for (var i = 0; i < (articles || []).length; i++) {
            var name = String((articles[i] || {}).source || "").trim();
            var key = name.toLowerCase();
            if (!name || key === "unknown" || seen[key]) continue;
            seen[key] = true;
            out.push(name);
        }
        out.sort(function (a, b) {
            return a.toLowerCase() < b.toLowerCase() ? -1 : 1;
        });
        return out;
    }

    global.AuraFeedFilters = {
        DEFAULTS: DEFAULTS,
        parseQuery: parseQuery,
        serialize: serialize,
        withinDays: withinDays,
        sourceOptions: sourceOptions
    };
})(window);
