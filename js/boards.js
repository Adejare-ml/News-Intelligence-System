/**
 * Analytical boards (round 5, Package 24): the three surfaces the audit
 * found data for and no UI on.
 *
 * - Agency activity board: agencies.json is the largest export in the
 *   system (874 rows) and was reachable only as palette entries and a
 *   10-item dossier list. Per-agency volume with an event-type
 *   breakdown answers "who is generating the audit/corruption signal".
 * - Appointments & departures: the pipeline classifies executive churn
 *   (appointment / reappointment / resignation) and the only way to see
 *   a resignation was to already know the person's name.
 * - Procurement ledger: all contracts on a sortable AuraDataTable, with
 *   the pipeline-parsed numeric amounts for real value sorting and an
 *   honest "Not disclosed" for the rest.
 *
 * Same split as every module: pure compute + HTML-string halves that run
 * headless, one guarded bind() for the DOM.
 */
(function (global) {
    "use strict";

    function esc(value) {
        return String(value == null ? "" : value)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }

    function slugOf(name) {
        var EK = global.AuraEntityKey;
        return EK && EK.slugify ? EK.slugify(name) : "";
    }

    function entityLink(route, name) {
        var slug = slugOf(name);
        return slug
            ? '<a class="report-link" href="#/' + route + "/" + esc(slug) + '">' + esc(name) + "</a>"
            : esc(name);
    }

    // ------------------------------------------------------------------
    // Agency activity board
    // ------------------------------------------------------------------

    /**
     * Rows -> ranked per-agency activity. Every agencies.json row is one
     * article mention carrying an Event classification, so counting rows
     * per (agency, event) is the whole aggregation. Null when empty.
     */
    function agencyBoard(rows, cap) {
        cap = cap || 10;
        var byName = {};
        var order = [];
        for (var i = 0; i < (rows || []).length; i++) {
            var row = rows[i] || {};
            var name = String(row.Agency || "").trim();
            if (!name) continue;
            var key = name.toLowerCase();
            var a = byName[key];
            if (!a) {
                a = byName[key] = { name: name, total: 0, events: {}, lastDate: "" };
                order.push(key);
            }
            a.total += 1;
            var event = String(row.Event || "").trim() || "Other";
            a.events[event] = (a.events[event] || 0) + 1;
            var date = String(row.Date || "").trim().slice(0, 10);
            if (date > a.lastDate) a.lastDate = date;
        }
        if (!order.length) return null;
        var all = order.map(function (k) { return byName[k]; });
        all.sort(function (x, y) {
            return (y.total - x.total) || (x.name < y.name ? -1 : 1);
        });
        return { totalAgencies: all.length, rows: all.slice(0, cap) };
    }

    /** Top event types of one agency as "Audit 12 · Corruption 5". */
    function topEvents(events, cap) {
        cap = cap || 3;
        return Object.keys(events || {}).map(function (k) {
            return { event: k, count: events[k] };
        }).sort(function (a, b) {
            return (b.count - a.count) || (a.event < b.event ? -1 : 1);
        }).slice(0, cap);
    }

    function renderAgencyBoardHTML(model) {
        return '<ol class="agency-board">' + model.rows.map(function (a) {
            var chips = topEvents(a.events).map(function (e) {
                return '<span class="event-chip event-' + esc(e.event.toLowerCase().replace(/[^a-z-]/g, ""))
                    + '">' + esc(e.event) + " " + esc(e.count) + "</span>";
            }).join("");
            return "<li>" + entityLink("agency", a.name)
                + ' <span class="insight-count">' + esc(a.total) + " mention" + (a.total === 1 ? "" : "s")
                + (a.lastDate ? " · " + esc(a.lastDate) : "") + "</span>"
                + '<span class="event-chips">' + chips + "</span></li>";
        }).join("") + "</ol>";
    }

    // ------------------------------------------------------------------
    // Appointments & departures
    // ------------------------------------------------------------------

    var MOVE_EVENTS = { appointment: 1, reappointment: 1, resignation: 1 };

    /**
     * people.json -> executive churn grouped by month, newest first.
     * Rows whose Event is anything else ("other": 399 of 468) are not
     * churn and are skipped. Null when no churn was ever recorded.
     */
    function appointmentsTimeline(rows, monthCap) {
        monthCap = monthCap || 6;
        var byMonth = {};
        var total = 0;
        for (var i = 0; i < (rows || []).length; i++) {
            var row = rows[i] || {};
            var event = String(row.Event || "").trim().toLowerCase();
            if (!MOVE_EVENTS[event]) continue;
            var name = String(row.Name || "").trim();
            if (!name) continue;
            var date = String(row.Date || "").trim().slice(0, 10);
            var month = date.slice(0, 7);
            if (!/^\d{4}-\d{2}$/.test(month)) month = "undated";
            var list = byMonth[month] || (byMonth[month] = []);
            list.push({
                name: name,
                position: String(row.Position || "").trim(),
                organization: String(row.Organization || "").trim(),
                event: event,
                date: date
            });
            total += 1;
        }
        if (!total) return null;
        var months = Object.keys(byMonth).sort().reverse().map(function (m) {
            byMonth[m].sort(function (a, b) { return a.date < b.date ? 1 : -1; });
            return { month: m, items: byMonth[m] };
        });
        // "undated" sorts after "2026-.." reversed -> first; push it last.
        months.sort(function (a, b) {
            if (a.month === "undated") return 1;
            if (b.month === "undated") return -1;
            return a.month < b.month ? 1 : -1;
        });
        return { total: total, months: months.slice(0, monthCap) };
    }

    function renderAppointmentsHTML(model) {
        return model.months.map(function (m) {
            var items = m.items.map(function (p) {
                var what = p.event === "resignation" ? "left" : "→";
                var role = [p.position, p.organization].filter(Boolean).join(" @ ");
                return '<li class="move move-' + esc(p.event) + '">'
                    + entityLink("person", p.name)
                    + (role ? ' <span class="move-role">' + esc(what) + " " + esc(role) + "</span>" : "")
                    + '<span class="insight-count">' + esc(p.event) + (p.date ? " · " + esc(p.date) : "") + "</span>"
                    + "</li>";
            }).join("");
            var label = m.month === "undated" ? "Undated" : m.month;
            return '<div class="insight-group"><h3>' + esc(label) + "</h3><ul class=\"move-list\">"
                + items + "</ul></div>";
        }).join("");
    }

    // ------------------------------------------------------------------
    // Procurement ledger
    // ------------------------------------------------------------------

    var CURRENCY_SIGNS = { NGN: "₦", USD: "$", GBP: "£", EUR: "€" };

    function compactAmount(value, currency) {
        var sign = CURRENCY_SIGNS[currency] || (currency ? currency + " " : "");
        var units = [[1e12, "tn"], [1e9, "bn"], [1e6, "m"], [1e3, "k"]];
        for (var i = 0; i < units.length; i++) {
            if (value >= units[i][0]) {
                var scaled = value / units[i][0];
                return sign + (Math.round(scaled * 10) / 10) + units[i][1];
            }
        }
        return sign + value;
    }

    /**
     * procurement.json rows -> ledger rows for AuraDataTable. The export
     * carries pipeline-parsed "Amount Value"/"Amount Currency" (null =
     * undisclosed -- never zero); older deploys without those fields
     * simply sort amounts as text.
     */
    function ledgerRows(rows) {
        return (rows || []).map(function (row) {
            row = row || {};
            var out = {};
            for (var k in row) {
                if (Object.prototype.hasOwnProperty.call(row, k)) out[k] = row[k];
            }
            var value = typeof row["Amount Value"] === "number" ? row["Amount Value"] : null;
            out["Amount Value"] = value;
            out._amountLabel = value !== null
                ? compactAmount(value, String(row["Amount Currency"] || "NGN"))
                : "Not disclosed";
            out._amountRaw = String(row.Amount || "").trim();
            return out;
        });
    }

    function ledgerColumns() {
        return [
            { key: "Agency", label: "Agency", html: true,
              format: function (v) { return entityLink("agency", String(v || "").trim()); } },
            { key: "Contractor", label: "Contractor", html: true,
              format: function (v) {
                  var name = String(v || "").trim();
                  if (!name || /^tbd$/i.test(name)) return '<span class="empty-note">TBD</span>';
                  return entityLink("company", name);
              } },
            { key: "Amount Value", label: "Amount", html: true,
              format: function (v, row) {
                  if (v === null || v === undefined || v === "") {
                      return '<span class="empty-note">Not disclosed</span>';
                  }
                  var title = row && row._amountRaw ? ' title="' + esc(row._amountRaw) + '"' : "";
                  return "<span" + title + ">" + esc(row._amountLabel) + "</span>";
              } },
            { key: "Project", label: "Project" },
            { key: "Source", label: "Source" },
            { key: "Date", label: "Date" }
        ];
    }

    /** Headline: contract count + disclosed totals per currency. */
    function ledgerSummary(rows) {
        var total = 0, disclosed = 0;
        var sums = {};
        (rows || []).forEach(function (row) {
            row = row || {};
            total += 1;
            var v = typeof row["Amount Value"] === "number" ? row["Amount Value"] : null;
            if (v !== null) {
                disclosed += 1;
                var cur = String(row["Amount Currency"] || "NGN");
                sums[cur] = (sums[cur] || 0) + v;
            }
        });
        if (!total) return null;
        var parts = Object.keys(sums).sort().map(function (cur) {
            return compactAmount(sums[cur], cur);
        });
        return {
            total: total,
            disclosed: disclosed,
            line: total + " contracts · " + disclosed + " with disclosed values"
                + (parts.length ? " totalling " + parts.join(" + ") : "")
        };
    }

    // ------------------------------------------------------------------
    // DOM shell
    // ------------------------------------------------------------------

    function bind() {
        var doc = global.document;
        if (!doc || typeof doc.querySelector !== "function" || !global.AuraData) return;
        var D = global.AuraData;

        var agencyPanel = doc.getElementById("agency-board-panel");
        if (agencyPanel && typeof global.fetch === "function") {
            D.getList("agencies.json").then(function (rows) {
                var model = agencyBoard(rows, 10);
                if (!model) return; // stays hidden
                var body = doc.getElementById("agency-board-body");
                if (!body) return;
                body.innerHTML = renderAgencyBoardHTML(model);
                var note = doc.getElementById("agency-board-note");
                if (note) note.textContent = model.totalAgencies + " agencies tracked";
                agencyPanel.hidden = false;
            });
        }

        var movesPanel = doc.getElementById("appointments-panel");
        if (movesPanel && typeof global.fetch === "function") {
            D.getList("people.json").then(function (rows) {
                var model = appointmentsTimeline(rows, 6);
                if (!model) return; // stays hidden
                var body = doc.getElementById("appointments-body");
                if (!body) return;
                body.innerHTML = renderAppointmentsHTML(model);
                var note = doc.getElementById("appointments-note");
                if (note) note.textContent = model.total + " recorded moves";
                movesPanel.hidden = false;
            });
        }

        var ledgerSection = doc.getElementById("procurement");
        var ledgerContainer = doc.getElementById("procurement-table");
        if (ledgerSection && ledgerContainer && global.AuraDataTable
            && typeof global.fetch === "function") {
            D.getList("procurement.json").then(function (rows) {
                var summary = ledgerSummary(rows);
                if (!summary) return; // stays hidden
                global.AuraDataTable.bind(ledgerContainer, {
                    rows: ledgerRows(rows),
                    columns: ledgerColumns(),
                    pageSize: 25,
                    sortKey: "Amount Value",
                    sortDir: "desc"
                });
                var note = doc.getElementById("procurement-note");
                if (note) note.textContent = summary.line;
                ledgerSection.hidden = false;
            });
        }
    }

    global.AuraBoards = {
        agencyBoard: agencyBoard,
        topEvents: topEvents,
        renderAgencyBoardHTML: renderAgencyBoardHTML,
        appointmentsTimeline: appointmentsTimeline,
        renderAppointmentsHTML: renderAppointmentsHTML,
        ledgerRows: ledgerRows,
        ledgerColumns: ledgerColumns,
        ledgerSummary: ledgerSummary,
        compactAmount: compactAmount,
        esc: esc
    };

    if (global.document && typeof global.document.addEventListener === "function") {
        if (global.document.readyState === "loading") {
            global.document.addEventListener("DOMContentLoaded", bind);
        } else {
            bind();
        }
    }
})(window);
