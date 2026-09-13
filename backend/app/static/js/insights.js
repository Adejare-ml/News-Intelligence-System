/**
 * AURA dashboard insights: "what changed this cycle" and pipeline health.
 *
 * Split like psc-core.js and datatable.js -- a DOM-free compute half that
 * runs in the headless CI sandbox, and a guarded bind() that renders the
 * two dashboard panels and silently hides them when their data files are
 * absent (old deploys, first run, dev without a pipeline run).
 */
(function (global) {
    "use strict";

    function esc(value) {
        return String(value == null ? "" : value)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }

    function num(value) {
        var s = String(value == null ? "" : value).trim().replace("%", "").replace(",", "");
        if (!s) return null;
        var f = parseFloat(s);
        return isNaN(f) ? null : f;
    }

    /**
     * Reduce changes.json to displayable groups, skipping empty categories.
     * Returns null when there is nothing to show at all -- the caller keeps
     * the panel hidden rather than rendering "0 changes" noise.
     */
    function changesSummary(changes) {
        if (!changes) return null;

        function pscLine(entry) {
            return entry.person + " — " + entry.company;
        }
        var groups = [
            { key: "new_high_risk", label: "New high-risk articles",
              items: (changes.new_high_risk || []).map(function (e) { return e.title; }) },
            { key: "psc_added", label: "PSC records added",
              items: (changes.psc_added || []).map(pscLine) },
            { key: "psc_changed", label: "Ownership percentage moves",
              items: (changes.psc_changed || []).map(function (e) {
                  return pscLine(e) + " (" + e.from + "% → " + e.to + "%)";
              }) },
            { key: "psc_removed", label: "PSC records no longer listed",
              items: (changes.psc_removed || []).map(pscLine) },
            { key: "new_companies", label: "New companies tracked",
              items: (changes.new_companies || []).slice() },
            { key: "new_people", label: "New people tracked",
              items: (changes.new_people || []).slice() }
        ].filter(function (g) { return g.items.length > 0; });

        if (!groups.length) return null;
        return { generated: changes.generated || "", groups: groups };
    }

    /**
     * Aggregate per-run Daily Reports rows into a per-day health series.
     * Date cells are compared on their first 10 chars (a historical branch
     * wrote timestamps into the column); numeric cells arrive as strings,
     * floats or garbage and parse leniently.
     */
    function healthSeries(reports, maxDays) {
        var byDay = {};
        for (var i = 0; i < (reports || []).length; i++) {
            var row = reports[i] || {};
            var day = String(row.Date == null ? "" : row.Date).trim().slice(0, 10);
            if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
            var b = byDay[day] || (byDay[day] = {
                day: day, runs: 0, articles: 0, highRisk: 0,
                cascadeFailures: 0, runSeconds: [], hasHealthColumns: false
            });
            b.runs += 1;
            b.articles += num(row["Total Articles"]) || 0;
            b.highRisk += num(row["High Risk"]) || 0;
            var cf = num(row["Cascade Failures"]);
            if (cf !== null) { b.cascadeFailures += cf; b.hasHealthColumns = true; }
            var rs = num(row["Run Seconds"]);
            if (rs !== null) b.runSeconds.push(rs);
        }

        var days = Object.keys(byDay).sort();
        if (maxDays && days.length > maxDays) days = days.slice(days.length - maxDays);
        var out = { labels: [], articles: [], highRiskRate: [], runs: [],
                    cascadeFailures: [], avgRunSeconds: [] };
        for (var d = 0; d < days.length; d++) {
            var e = byDay[days[d]];
            out.labels.push(e.day);
            out.articles.push(e.articles);
            out.highRiskRate.push(e.articles > 0
                ? Math.round(1000 * e.highRisk / e.articles) / 10 : 0);
            out.runs.push(e.runs);
            out.cascadeFailures.push(e.cascadeFailures);
            out.avgRunSeconds.push(e.runSeconds.length
                ? Math.round(e.runSeconds.reduce(function (a, v) { return a + v; }, 0) / e.runSeconds.length)
                : null);
        }
        return out;
    }

    /** Count published articles per extraction engine, blank -> "unknown". */
    function engineMix(articles) {
        var counts = {};
        for (var i = 0; i < (articles || []).length; i++) {
            var engine = String((articles[i] || {}).Engine || "").trim().toLowerCase() || "unknown";
            counts[engine] = (counts[engine] || 0) + 1;
        }
        var mix = Object.keys(counts).map(function (k) {
            return { engine: k, count: counts[k] };
        });
        mix.sort(function (a, b) {
            return b.count - a.count || (a.engine < b.engine ? -1 : 1);
        });
        return mix;
    }

    /** HTML for the changes panel body. Escaped; caps each list at `cap`. */
    function renderChangesHTML(summary, cap) {
        cap = cap || 5;
        var html = "";
        for (var g = 0; g < summary.groups.length; g++) {
            var group = summary.groups[g];
            var items = group.items.slice(0, cap).map(function (t) {
                return '<li>' + esc(t) + "</li>";
            }).join("");
            var more = group.items.length > cap
                ? '<li class="insight-more">+' + (group.items.length - cap) + " more</li>" : "";
            html += '<div class="insight-group"><h3>' + esc(group.label)
                + ' <span class="insight-count">' + group.items.length + "</span></h3>"
                + "<ul>" + items + more + "</ul></div>";
        }
        return html;
    }

    // =====================================================================
    // DOM shell -- everything below no-ops headless.
    // =====================================================================

    function bind() {
        var doc = global.document;
        if (!doc || typeof doc.querySelector !== "function") return;

        // Static-first, matching app.js / psc-report.js.
        var devHost = global.location.hostname === "localhost"
            || global.location.hostname.indexOf("127.") === 0;
        var DATA = (devHost && global.location.search.indexOf("static=1") === -1)
            ? "/api/v1" : "data";

        var changesPanel = doc.getElementById("cycle-changes-panel");
        if (changesPanel && typeof global.fetch === "function") {
            global.fetch(DATA + "/changes.json")
                .then(function (res) { return res.ok ? res.json() : null; })
                .catch(function () { return null; })
                .then(function (changes) {
                    var summary = changesSummary(changes);
                    if (!summary) return; // stays hidden
                    var body = doc.getElementById("cycle-changes-body");
                    if (!body) return;
                    body.innerHTML = renderChangesHTML(summary, 5);
                    var stamp = doc.getElementById("cycle-changes-generated");
                    if (stamp && summary.generated) stamp.textContent = "as of " + summary.generated;
                    changesPanel.hidden = false;
                });
        }

        var healthPanel = doc.getElementById("health-panel");
        if (healthPanel && typeof global.fetch === "function") {
            Promise.all([
                global.fetch(DATA + "/reports.json")
                    .then(function (res) { return res.ok ? res.json() : []; })
                    .catch(function () { return []; }),
                global.fetch(DATA + "/latest.json")
                    .then(function (res) { return res.ok ? res.json() : []; })
                    .catch(function () { return []; })
            ]).then(function (results) {
                var series = healthSeries(results[0], 30);
                if (!series.labels.length) return; // stays hidden

                healthPanel.hidden = false;
                var summaryEl = doc.getElementById("health-summary");
                if (summaryEl) {
                    var totalRuns = series.runs.reduce(function (a, v) { return a + v; }, 0);
                    var totalCascade = series.cascadeFailures.reduce(function (a, v) { return a + v; }, 0);
                    summaryEl.textContent = totalRuns + " runs over the last "
                        + series.labels.length + " days"
                        + (totalCascade > 0
                            ? ", " + totalCascade + " LLM cascade failure" + (totalCascade === 1 ? "" : "s")
                            : ", no LLM cascade failures recorded");
                }

                var Chart = global.Chart;
                var volumeCanvas = doc.getElementById("health-chart");
                if (Chart && volumeCanvas) {
                    new Chart(volumeCanvas.getContext("2d"), {
                        data: {
                            labels: series.labels,
                            datasets: [
                                { type: "bar", label: "Articles / day", data: series.articles,
                                  backgroundColor: "rgba(103, 232, 249, 0.35)", yAxisID: "y" },
                                { type: "line", label: "High-risk %", data: series.highRiskRate,
                                  borderColor: "rgba(244, 114, 182, 0.9)",
                                  backgroundColor: "rgba(244, 114, 182, 0.9)",
                                  tension: 0.3, pointRadius: 2, yAxisID: "rate" }
                            ]
                        },
                        options: {
                            responsive: true, maintainAspectRatio: false,
                            plugins: { legend: { labels: { boxWidth: 12 } } },
                            scales: {
                                y: { beginAtZero: true, ticks: { precision: 0 } },
                                rate: { beginAtZero: true, position: "right", max: 100,
                                        grid: { drawOnChartArea: false } }
                            }
                        }
                    });
                }

                var mix = engineMix(results[1]);
                var engineCanvas = doc.getElementById("engine-chart");
                if (Chart && engineCanvas && mix.length) {
                    new Chart(engineCanvas.getContext("2d"), {
                        type: "doughnut",
                        data: {
                            labels: mix.map(function (m) { return m.engine; }),
                            datasets: [{
                                data: mix.map(function (m) { return m.count; }),
                                backgroundColor: ["rgba(103, 232, 249, 0.7)", "rgba(244, 114, 182, 0.7)",
                                                  "rgba(167, 139, 250, 0.7)", "rgba(251, 191, 36, 0.7)",
                                                  "rgba(148, 163, 184, 0.7)"]
                            }]
                        },
                        options: {
                            responsive: true, maintainAspectRatio: false,
                            plugins: { legend: { position: "bottom", labels: { boxWidth: 12 } } }
                        }
                    });
                }
            });
        }
    }

    global.AuraInsights = {
        changesSummary: changesSummary,
        healthSeries: healthSeries,
        engineMix: engineMix,
        renderChangesHTML: renderChangesHTML,
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
