/**
 * AuraData: one memoised fetch per dataset for the whole dashboard.
 *
 * Before this module, a cold boot fetched reports.json three times
 * (app.js, psc-report.js, insights.js), latest.json twice, and
 * companies.json -- 157KB -- once at load to read a single integer, then
 * again in the palette and again in the dossiers: ~270KB and five round
 * trips of pure duplication, on a host (GitHub Pages) that cannot set
 * aggressive cache headers. Every module now shares one in-flight
 * promise per file.
 *
 * Failure contract: a failed or non-OK fetch resolves to null (callers
 * choose their own empty shape) and is NOT cached, so a retry (e.g. the
 * graph panel's Retry button) re-fetches instead of replaying the error.
 */
(function (global) {
    "use strict";

    // Static-first, matching app.js / psc-report.js / insights.js.
    function dataBase() {
        var loc = global.location || {};
        var devHost = loc.hostname === "localhost"
            || String(loc.hostname || "").indexOf("127.") === 0;
        return (devHost && String(loc.search || "").indexOf("static=1") === -1)
            ? "/api/v1" : "data";
    }

    var inflight = {};

    /**
     * Memoised JSON fetch for one published dataset ("latest.json",
     * "companies.json", ...). Returns a promise of parsed JSON, or null
     * on any failure.
     */
    function get(name) {
        if (inflight[name]) return inflight[name];
        if (typeof global.fetch !== "function") return Promise.resolve(null);
        var promise = global.fetch(dataBase() + "/" + name)
            .then(function (res) { return res.ok ? res.json() : null; })
            .catch(function () { return null; })
            .then(function (payload) {
                if (payload === null) delete inflight[name]; // retryable
                return payload;
            });
        inflight[name] = promise;
        return promise;
    }

    /** Like get(), but a missing/failed file yields [] for list callers. */
    function getList(name) {
        return get(name).then(function (payload) {
            return Array.isArray(payload) ? payload : [];
        });
    }

    global.AuraData = {
        get: get,
        getList: getList,
        dataBase: dataBase
    };
})(window);
