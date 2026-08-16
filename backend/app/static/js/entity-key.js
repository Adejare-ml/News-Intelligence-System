/**
 * Shared entity-name normalization: one slug scheme for the whole app.
 *
 * Router URLs (#/company/:slug), search results, dossier lookups and the
 * browser-local watchlist all need to turn an entity name into a stable
 * identifier and back. The pipeline's own graph IDs are md5(name)[:12]
 * computed in Python (run_pipeline.py), which the frontend cannot cheaply
 * reproduce and which only exist for the ~95 capped graph nodes anyway --
 * so the client-side identity is the normalized name itself, matched
 * case- and whitespace-insensitively against the full JSON exports.
 *
 * DOM-free on purpose: this file must load in the headless test sandbox
 * (tests/frontend/run.js), which provides no browser APIs at all.
 */
(function (global) {
    "use strict";

    /** Lower-cased, trimmed, single-spaced form used for name comparison. */
    function nameKey(value) {
        return String(value == null ? "" : value)
            .replace(/\u00a0/g, " ")
            .trim()
            .replace(/\s+/g, " ")
            .toLowerCase();
    }

    /**
     * URL-safe slug for hash routes: "First HoldCo Plc." -> "first-holdco-plc".
     *
     * Diacritics fold to ASCII where Unicode NFD decomposition allows, "&"
     * becomes "and" so "A & B" and "A and B" collide deliberately, and
     * anything else outside [a-z0-9] becomes a hyphen. Idempotent:
     * slugify(slugify(x)) === slugify(x).
     */
    function slugify(value) {
        var s = nameKey(value);
        if (!s) return "";
        if (typeof s.normalize === "function") {
            s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        }
        return s
            .replace(/&/g, " and ")
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "");
    }

    /**
     * True when a record's name resolves to the given slug. The comparison
     * runs through slugify on both sides, so "  First HoldCo  " in the data
     * still matches the URL "#/company/first-holdco".
     */
    function matchesSlug(name, slug) {
        return slugify(name) !== "" && slugify(name) === String(slug || "");
    }

    global.AuraEntityKey = {
        nameKey: nameKey,
        slugify: slugify,
        matchesSlug: matchesSlug
    };
})(window);
