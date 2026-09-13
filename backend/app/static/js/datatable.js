/**
 * DataTable: sort, paginate, column visibility for the app's list views.
 *
 * Built standalone in Slice D of docs/TIER1_REDESIGN_PLAN.md; Slice F
 * migrates the PSC register onto it (through getFilteredPSCData() as the
 * seam, so filter chips / search / empty states are untouched), and the
 * feed reuses the compute half for pagination without adopting <table>
 * markup.
 *
 * Split like psc-core.js and router.js: the compute half (sortRows,
 * paginateRows, toggleColumn) and the render half (HTML-string builders)
 * are DOM-free and run in the headless CI sandbox; only bind() touches
 * the document, and it is guarded so loading this file without a browser
 * is a no-op.
 *
 * Pagination, not virtualization, deliberately: the largest dataset this
 * app ships is companies.json (~975 rows). Column-visibility state is
 * in-memory only for Tier 1 -- persisting it is a later, separate
 * decision so it never gets tangled with the Slice H localStorage
 * feature.
 */
(function (global) {
    "use strict";

    var DEFAULT_PAGE_SIZE = 50;

    function esc(value) {
        return String(value == null ? "" : value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    /**
     * "28.5%" -> 28.5, "1,200" -> 1200, 42 -> 42, "n/a" -> null.
     * Delegates to AuraPSC.toPercent (the engine's tested parser) when it
     * is loaded -- one numeric-parsing behavior across the app -- with a
     * comma-tolerant fallback so this file has no hard dependency on it.
     */
    function toNumber(value) {
        var psc = global.AuraPSC;
        if (psc && typeof psc.toPercent === "function") {
            var viaEngine = psc.toPercent(value);
            if (viaEngine !== null) return viaEngine;
        }
        if (value === null || value === undefined) return null;
        var text = String(value).replace(/%/g, "").replace(/,/g, "").trim();
        if (!text) return null;
        var num = Number(text);
        return isFinite(num) ? num : null;
    }

    /**
     * Stable sort, non-mutating. Numeric compare when both values parse
     * as numbers (so "6.8%" sorts before "28.5%"), localeCompare
     * otherwise, and blank values always group at the end in either
     * direction -- an empty Risk Score must not float above real ones
     * just because "" sorts first lexically.
     */
    function sortRows(rows, key, dir) {
        if (!Array.isArray(rows)) return [];
        var desc = dir === "desc";
        var decorated = rows.map(function (row, i) { return { row: row, i: i }; });
        decorated.sort(function (a, b) {
            var av = a.row == null ? "" : a.row[key];
            var bv = b.row == null ? "" : b.row[key];
            var aBlank = av === null || av === undefined || String(av).trim() === "";
            var bBlank = bv === null || bv === undefined || String(bv).trim() === "";
            if (aBlank || bBlank) {
                if (aBlank && bBlank) return a.i - b.i;
                return aBlank ? 1 : -1; // blanks last, regardless of direction
            }
            var an = toNumber(av);
            var bn = toNumber(bv);
            var cmp;
            if (an !== null && bn !== null) {
                cmp = an - bn;
            } else {
                cmp = String(av).localeCompare(String(bv), undefined, { sensitivity: "base" });
            }
            if (cmp === 0) return a.i - b.i; // explicit stability
            return desc ? -cmp : cmp;
        });
        return decorated.map(function (d) { return d.row; });
    }

    /**
     * Slice one page out of rows. Page numbers are 1-based and clamped
     * into range, so a stale ?page=9 URL after a filter narrows the data
     * lands on the last real page instead of an empty one.
     */
    function paginateRows(rows, page, pageSize) {
        var list = Array.isArray(rows) ? rows : [];
        var size = pageSize > 0 ? Math.floor(pageSize) : DEFAULT_PAGE_SIZE;
        var total = list.length;
        var pages = Math.max(1, Math.ceil(total / size));
        var current = Math.min(Math.max(1, Math.floor(page) || 1), pages);
        var start = (current - 1) * size;
        var slice = list.slice(start, start + size);
        return {
            rows: slice,
            page: current,
            pages: pages,
            total: total,
            // 1-based inclusive range for "Showing 51-100 of 975"; 0-0 when empty.
            start: total === 0 ? 0 : start + 1,
            end: total === 0 ? 0 : start + slice.length
        };
    }

    /** Non-mutating visibility flip; unknown keys return the input as-is. */
    function toggleColumn(columns, key) {
        return (columns || []).map(function (col) {
            if (col.key !== key) return col;
            var copy = {};
            for (var k in col) {
                if (Object.prototype.hasOwnProperty.call(col, k)) copy[k] = col[k];
            }
            copy.visible = col.visible === false; // was hidden -> show, was shown -> hide
            return copy;
        });
    }

    function visibleColumns(columns) {
        return (columns || []).filter(function (c) { return c.visible !== false; });
    }

    /**
     * Table markup as a string. state: { sortKey, sortDir }. Columns:
     * { key, label, visible?, sortable?, format? } -- format(value, row)
     * returns display text, escaped here unless the column sets
     * html: true (for trusted, pre-escaped fragments like badge spans).
     */
    function renderTableHTML(rows, columns, state) {
        var cols = visibleColumns(columns);
        var s = state || {};
        var head = cols.map(function (col) {
            var sortable = col.sortable !== false;
            var isSorted = sortable && s.sortKey === col.key;
            var aria = isSorted ? (s.sortDir === "desc" ? "descending" : "ascending") : "none";
            var label = esc(col.label != null ? col.label : col.key);
            if (!sortable) {
                return '<th scope="col">' + label + "</th>";
            }
            return '<th scope="col" aria-sort="' + aria + '">'
                + '<button type="button" class="aura-table-sort" data-sort-key="' + esc(col.key) + '">'
                + label
                + '<span class="aura-table-sort-mark" aria-hidden="true">'
                + (isSorted ? (s.sortDir === "desc" ? "▼" : "▲") : "") + "</span>"
                + "</button></th>";
        }).join("");

        var body = (rows || []).map(function (row) {
            var cells = cols.map(function (col) {
                var raw = typeof col.format === "function"
                    ? col.format(row == null ? undefined : row[col.key], row)
                    : (row == null ? "" : row[col.key]);
                var content = col.html === true ? String(raw == null ? "" : raw) : esc(raw);
                return "<td>" + content + "</td>";
            }).join("");
            return "<tr>" + cells + "</tr>";
        }).join("");

        return '<div class="aura-table-wrap"><table class="aura-table">'
            + "<thead><tr>" + head + "</tr></thead>"
            + "<tbody>" + body + "</tbody>"
            + "</table></div>";
    }

    /** Pager markup for a paginateRows() result. Hidden when one page. */
    function renderPagerHTML(info) {
        if (!info || info.pages <= 1) return "";
        var prevDisabled = info.page <= 1 ? " disabled" : "";
        var nextDisabled = info.page >= info.pages ? " disabled" : "";
        return '<nav class="aura-pager" aria-label="Table pages">'
            + '<button type="button" class="btn btn-secondary aura-pager-btn" data-page="'
            + (info.page - 1) + '"' + prevDisabled + ">Previous</button>"
            + '<span class="aura-pager-status" aria-live="polite">'
            + "Showing " + info.start + "–" + info.end + " of " + info.total + "</span>"
            + '<button type="button" class="btn btn-secondary aura-pager-btn" data-page="'
            + (info.page + 1) + '"' + nextDisabled + ">Next</button>"
            + "</nav>";
    }

    /**
     * DOM binder: renders into container and wires sort/pager clicks.
     * config: { rows, columns, pageSize?, sortKey?, sortDir?, onRender? }.
     * Returns a controller { render, setRows, state } or null without a DOM.
     */
    function bind(container, config) {
        var doc = global.document;
        if (!container || !doc || typeof doc.createElement !== "function") return null;

        var state = {
            rows: (config && config.rows) || [],
            columns: (config && config.columns) || [],
            pageSize: (config && config.pageSize) || DEFAULT_PAGE_SIZE,
            sortKey: config && config.sortKey,
            sortDir: (config && config.sortDir) || "asc",
            page: 1
        };

        function render() {
            var ordered = state.sortKey
                ? sortRows(state.rows, state.sortKey, state.sortDir)
                : state.rows;
            var pageInfo = paginateRows(ordered, state.page, state.pageSize);
            state.page = pageInfo.page;
            container.innerHTML =
                renderTableHTML(pageInfo.rows, state.columns, state)
                + renderPagerHTML(pageInfo);
            if (config && typeof config.onRender === "function") {
                config.onRender(pageInfo);
            }
        }

        container.addEventListener("click", function (ev) {
            var target = ev.target;
            while (target && target !== container) {
                if (target.hasAttribute && target.hasAttribute("data-sort-key")) {
                    var key = target.getAttribute("data-sort-key");
                    if (state.sortKey === key) {
                        state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
                    } else {
                        state.sortKey = key;
                        state.sortDir = "asc";
                    }
                    state.page = 1;
                    render();
                    return;
                }
                if (target.hasAttribute && target.hasAttribute("data-page") && !target.disabled) {
                    state.page = parseInt(target.getAttribute("data-page"), 10) || 1;
                    render();
                    return;
                }
                target = target.parentNode;
            }
        });

        render();

        return {
            render: render,
            state: state,
            setRows: function (rows) {
                state.rows = rows || [];
                state.page = 1;
                render();
            }
        };
    }

    global.AuraDataTable = {
        esc: esc,
        toNumber: toNumber,
        sortRows: sortRows,
        paginateRows: paginateRows,
        toggleColumn: toggleColumn,
        visibleColumns: visibleColumns,
        renderTableHTML: renderTableHTML,
        renderPagerHTML: renderPagerHTML,
        bind: bind,
        DEFAULT_PAGE_SIZE: DEFAULT_PAGE_SIZE
    };
})(window);
