/* Tests for the shortest-path core (Slice G). Pure, DOM-free. */
(function () {
    "use strict";
    var G = window.AuraGraphPath;

    // a - b - c - d, with a shortcut a - e - d and a stranded island x.
    var NODES = [
        { id: "a" }, { id: "b" }, { id: "c" }, { id: "d" },
        { id: "e" }, { id: "x" }
    ];
    var EDGES = [
        { id: "e1", from: "a", to: "b" },
        { id: "e2", from: "b", to: "c" },
        { id: "e3", from: "c", to: "d" },
        { id: "e4", from: "a", to: "e" },
        { id: "e5", from: "e", to: "d" }
    ];

    T.describe("graph shortest path", function () {
        T.it("returns the minimum-hop path, not the first one found", function () {
            T.eq(G.shortestPath(NODES, EDGES, "a", "d").join(">"), "a>e>d");
        });

        T.it("traverses edges against their arrow direction", function () {
            // Every edge above points away from "a"; walking d -> a must
            // still work because relationships are questions, not flows.
            T.eq(G.shortestPath(NODES, EDGES, "d", "a").join(">"), "d>e>a");
        });

        T.it("returns null for unreachable and unknown endpoints", function () {
            T.eq(G.shortestPath(NODES, EDGES, "a", "x"), null);
            T.eq(G.shortestPath(NODES, EDGES, "a", "nope"), null);
            T.eq(G.shortestPath(NODES, EDGES, "nope", "a"), null);
        });

        T.it("a node reaches itself with a single-entry path", function () {
            T.eq(G.shortestPath(NODES, EDGES, "b", "b").join(">"), "b");
        });

        T.it("edges with endpoints outside the node list are ignored", function () {
            var edges = EDGES.concat([{ id: "ghost", from: "a", to: "phantom" }]);
            T.eq(G.shortestPath(NODES, edges, "a", "d").join(">"), "a>e>d");
        });

        T.it("empty inputs do not throw", function () {
            T.eq(G.shortestPath([], [], "a", "b"), null);
            T.eq(G.shortestPath(null, null, "a", "b"), null);
        });
    });

    T.describe("path edge ids", function () {
        T.it("collects the edges along the path, either direction", function () {
            var path = G.shortestPath(NODES, EDGES, "d", "a");
            var ids = G.pathEdgeIds(path, EDGES);
            T.eq(ids.sort().join(","), "e4,e5");
        });

        T.it("includes parallel duplicate edges of one hop", function () {
            var edges = EDGES.concat([{ id: "e4b", from: "e", to: "a" }]);
            var ids = G.pathEdgeIds(["a", "e", "d"], edges);
            T.eq(ids.sort().join(","), "e4,e4b,e5");
        });

        T.it("a trivial or empty path selects nothing", function () {
            T.eq(G.pathEdgeIds(["a"], EDGES).length, 0);
            T.eq(G.pathEdgeIds(null, EDGES).length, 0);
        });
    });

    // Last file on the page: re-render the totals including this suite.
    T.report();
})();
