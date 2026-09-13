/* Tests for the per-device local store core (Slice H). The storage
   accessors are exercised too: headless there is no localStorage, which
   is exactly the degraded environment they must survive. */
(function () {
    "use strict";
    var L = window.AuraLocalStore;

    T.describe("watchlist state", function () {
        T.it("toggle adds then removes, without mutating the input", function () {
            var s0 = L.emptyState();
            var s1 = L.toggleWatch(s0, { type: "company", slug: "dangote-cement-plc", label: "Dangote Cement Plc" });
            T.eq(s1.watchlist.length, 1);
            T.eq(s0.watchlist.length, 0, "input state untouched");
            T.ok(L.isWatched(s1, "company", "dangote-cement-plc"));
            var s2 = L.toggleWatch(s1, { type: "company", slug: "dangote-cement-plc" });
            T.eq(s2.watchlist.length, 0);
        });

        T.it("the same slug under two types is two entries", function () {
            var s = L.toggleWatch(L.toggleWatch(L.emptyState(),
                { type: "company", slug: "acme" }), { type: "person", slug: "acme" });
            T.eq(s.watchlist.length, 2);
            T.ok(!L.isWatched(s, "agency", "acme"));
        });

        T.it("normalize discards junk and unknown versions", function () {
            T.eq(L.normalizeState({ version: 99, watchlist: [{ type: "x", slug: "y" }] }).watchlist.length, 0);
            T.eq(L.normalizeState("garbage").watchlist.length, 0);
            var s = L.normalizeState({ version: 1, watchlist: [
                { type: "company", slug: "ok" }, { type: "", slug: "no" }, null, "junk"
            ] });
            T.eq(s.watchlist.length, 1);
            T.eq(s.watchlist[0].label, "ok", "label falls back to the slug");
        });

        T.it("toggling a malformed entry is a no-op", function () {
            var s = L.toggleWatch(L.emptyState(), { type: "", slug: "" });
            T.eq(s.watchlist.length, 0);
        });
    });

    T.describe("alert dismissal", function () {
        var ALERTS = [
            { severity: "critical", title: "Critical Alert: CBN sanction",
              article: { url: "https://p.test/cbn" } },
            { severity: "elevated", title: "Elevated: procurement spike" }
        ];

        T.it("ids are stable and severity-scoped", function () {
            T.eq(L.alertId(ALERTS[0]), L.alertId({ severity: "critical", article: { url: "https://p.test/cbn" } }),
                "same story, same id, regardless of title drift when a URL exists");
            T.ok(L.alertId(ALERTS[0]) !== L.alertId(Object.assign({}, ALERTS[0], { severity: "elevated" })),
                "an escalated alert gets a new id and resurfaces");
        });

        T.it("split partitions by dismissed ids", function () {
            var parts = L.splitAlerts(ALERTS, [L.alertId(ALERTS[0])]);
            T.eq(parts.visible.length, 1);
            T.eq(parts.dismissed.length, 1);
            T.eq(parts.dismissed[0].severity, "critical");
        });

        T.it("prune drops ids for alerts no longer in the window", function () {
            var stale = ["zzz", L.alertId(ALERTS[1])];
            T.eq(L.pruneDismissed(stale, ALERTS).join(","), L.alertId(ALERTS[1]));
        });
    });

    T.describe("storage accessors without localStorage", function () {
        T.it("degrade to empty values instead of throwing", function () {
            T.eq(L.loadState().watchlist.length, 0);
            T.eq(L.loadDismissed().length, 0);
            T.eq(L.saveState(L.emptyState()), false);
            T.eq(L.saveDismissed(["a"]), false);
        });
    });

    // Last file on the page: re-render the totals including this suite.
    T.report();
})();
