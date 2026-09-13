/* Tests for the DataTable compute and render halves. */
(function () {
    "use strict";
    var D = window.AuraDataTable;

    T.describe("toNumber", function () {
        T.it("parses percentages, commas and plain numbers", function () {
            T.eq(D.toNumber("28.5%"), 28.5);
            T.eq(D.toNumber("1,200"), 1200);
            T.eq(D.toNumber(42), 42);
            T.eq(D.toNumber(" 6.8 "), 6.8);
        });

        T.it("returns null for non-numbers", function () {
            T.eq(D.toNumber("n/a"), null);
            T.eq(D.toNumber(""), null);
            T.eq(D.toNumber(null), null);
            T.eq(D.toNumber(undefined), null);
        });
    });

    T.describe("sortRows", function () {
        var rows = [
            { name: "B Co", pct: "28.5%", score: 40 },
            { name: "a co", pct: "6.8%", score: 82 },
            { name: "C Co", pct: "", score: 10 }
        ];

        T.it("sorts percentage strings numerically, not lexically", function () {
            var asc = D.sortRows(rows, "pct", "asc");
            // Lexical order would put "28.5%" before "6.8%".
            T.eq(asc[0].pct, "6.8%");
            T.eq(asc[1].pct, "28.5%");
        });

        T.it("groups blank values last in both directions", function () {
            T.eq(D.sortRows(rows, "pct", "asc")[2].pct, "");
            T.eq(D.sortRows(rows, "pct", "desc")[2].pct, "", "desc must not float blanks to the top");
        });

        T.it("sorts text case-insensitively", function () {
            var byName = D.sortRows(rows, "name", "asc");
            T.eq(byName[0].name, "a co");
            T.eq(byName[1].name, "B Co");
        });

        T.it("is stable for equal keys", function () {
            var dup = [
                { k: "same", tag: 1 }, { k: "same", tag: 2 }, { k: "same", tag: 3 }
            ];
            T.eq(D.sortRows(dup, "k", "asc").map(function (r) { return r.tag; }), [1, 2, 3]);
        });

        T.it("does not mutate the input", function () {
            var before = rows.map(function (r) { return r.name; });
            D.sortRows(rows, "name", "desc");
            T.eq(rows.map(function (r) { return r.name; }), before);
        });

        T.it("tolerates junk input", function () {
            T.eq(D.sortRows(null, "x", "asc"), []);
            T.eq(D.sortRows([{ a: 1 }, null], "a", "asc").length, 2);
        });
    });

    T.describe("paginateRows", function () {
        var many = [];
        for (var i = 1; i <= 120; i++) many.push({ n: i });

        T.it("slices 1-based pages and reports the range", function () {
            var p2 = D.paginateRows(many, 2, 50);
            T.eq(p2.rows.length, 50);
            T.eq(p2.rows[0].n, 51);
            T.eq(p2.start, 51);
            T.eq(p2.end, 100);
            T.eq(p2.pages, 3);
            T.eq(p2.total, 120);
        });

        T.it("clamps an out-of-range page onto the last real one", function () {
            var p = D.paginateRows(many, 99, 50);
            T.eq(p.page, 3);
            T.eq(p.rows.length, 20, "last partial page");
        });

        T.it("clamps page zero and garbage up to one", function () {
            T.eq(D.paginateRows(many, 0, 50).page, 1);
            T.eq(D.paginateRows(many, "junk", 50).page, 1);
        });

        T.it("reports an empty set as one empty page, range 0-0", function () {
            var p = D.paginateRows([], 1, 50);
            T.eq(p.pages, 1);
            T.eq(p.rows, []);
            T.eq(p.start, 0);
            T.eq(p.end, 0);
        });
    });

    T.describe("column visibility", function () {
        var cols = [
            { key: "a", label: "A" },
            { key: "b", label: "B", visible: false }
        ];

        T.it("filters to visible columns, default visible", function () {
            T.eq(D.visibleColumns(cols).map(function (c) { return c.key; }), ["a"]);
        });

        T.it("toggles without mutating the originals", function () {
            var toggled = D.toggleColumn(cols, "b");
            T.eq(D.visibleColumns(toggled).length, 2, "b is now shown");
            T.eq(cols[1].visible, false, "input untouched");
            var hiddenA = D.toggleColumn(cols, "a");
            T.eq(D.visibleColumns(hiddenA).map(function (c) { return c.key; }), [],
                "a flips from default-visible to hidden; b already hidden");
        });
    });

    T.describe("renderTableHTML", function () {
        var cols = [
            { key: "name", label: "Name" },
            { key: "pct", label: "Stake", sortable: false },
            { key: "secret", label: "Hidden", visible: false }
        ];
        var rows = [{ name: "<script>alert(1)</script>", pct: "28.5%", secret: "x" }];

        T.it("escapes cell values", function () {
            var html = D.renderTableHTML(rows, cols, {});
            T.excludes(html, "<script>alert", "raw markup must never reach the table");
            T.contains(html, "&lt;script&gt;");
        });

        T.it("omits hidden columns entirely", function () {
            var html = D.renderTableHTML(rows, cols, {});
            T.excludes(html, "Hidden");
            T.excludes(html, ">x<");
        });

        T.it("marks the sorted column with aria-sort and leaves others none", function () {
            var html = D.renderTableHTML(rows, cols, { sortKey: "name", sortDir: "desc" });
            T.contains(html, 'aria-sort="descending"');
            T.excludes(html, 'aria-sort="ascending"');
        });

        T.it("renders sortable headers as buttons, non-sortable as plain text", function () {
            var html = D.renderTableHTML(rows, cols, {});
            T.contains(html, 'data-sort-key="name"');
            T.excludes(html, 'data-sort-key="pct"', "sortable:false column gets no button");
        });

        T.it("runs a column formatter and escapes its output by default", function () {
            var fmtCols = [{ key: "name", label: "N", format: function (v) { return v + " & co"; } }];
            var html = D.renderTableHTML([{ name: "A" }], fmtCols, {});
            T.contains(html, "A &amp; co");
        });
    });

    T.describe("renderPagerHTML", function () {
        T.it("is empty for a single page", function () {
            T.eq(D.renderPagerHTML(D.paginateRows([{ a: 1 }], 1, 50)), "");
        });

        T.it("disables the edge buttons and reports the range", function () {
            var many = [];
            for (var i = 0; i < 120; i++) many.push({ n: i });
            var first = D.renderPagerHTML(D.paginateRows(many, 1, 50));
            T.contains(first, "Showing 1–50 of 120");
            T.contains(first, 'data-page="0" disabled');
            var last = D.renderPagerHTML(D.paginateRows(many, 3, 50));
            T.contains(last, 'data-page="4" disabled');
        });
    });

    T.report();
})();
