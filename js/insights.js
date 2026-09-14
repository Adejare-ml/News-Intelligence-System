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

    /**
     * Displayable model for trends.json. Null when there is nothing worth
     * a panel (no movement and no social posts) so the section stays
     * hidden rather than rendering empty columns.
     */
    function trendsSummary(trends) {
        if (!trends) return null;
        var rising = (trends.rising || []).slice(0, 8);
        var falling = (trends.falling || []).slice(0, 5);
        var social = (trends.social || []).slice(0, 6).filter(function (p) {
            return p && typeof p.url === "string"
                && p.url.indexOf("https://www.reddit.com/r/") === 0;
        });
        if (!rising.length && !falling.length && !social.length) return null;
        return {
            generated: trends.generated || "",
            windowDays: trends.window_days || 7,
            rising: rising,
            falling: falling,
            social: social
        };
    }

    /** One-line-per-city model for weather.json; null hides the strip. */
    function weatherSummary(weather) {
        if (!weather || !weather.cities || !weather.cities.length) return null;
        return {
            generated: weather.generated || "",
            cities: weather.cities.map(function (c) {
                return {
                    name: c.name,
                    line: c.name + " " + c.temp_c + "°C · " + (c.description || "")
                        + (c.humidity != null ? " · " + c.humidity + "% humidity" : "")
                };
            })
        };
    }

    /** HTML for the trends panel body. Escaped throughout. */
    function renderTrendsHTML(summary) {
        function chip(entry, dir) {
            return '<li class="trend-chip trend-' + dir + '">' + esc(entry.term)
                + ' <span class="trend-delta">' + (dir === "up" ? "+" : "") + esc(entry.change)
                + '</span></li>';
        }
        var html = "";
        if (summary.rising.length) {
            html += '<div class="insight-group"><h3>Rising this week</h3><ul class="trend-list">'
                + summary.rising.map(function (e) { return chip(e, "up"); }).join("") + "</ul></div>";
        }
        if (summary.falling.length) {
            html += '<div class="insight-group"><h3>Fading</h3><ul class="trend-list">'
                + summary.falling.map(function (e) { return chip(e, "down"); }).join("") + "</ul></div>";
        }
        if (summary.social.length) {
            html += '<div class="insight-group"><h3>On r/Nigeria</h3><ul>'
                + summary.social.map(function (p) {
                    return '<li><a class="report-link" rel="noopener noreferrer" target="_blank" href="'
                        + esc(p.url) + '">' + esc(p.title) + "</a>"
                        + ' <span class="insight-count">' + (Number(p.score) || 0) + "▲</span></li>";
                }).join("") + "</ul></div>";
        }
        return html;
    }

    /**
     * Displayable model for tech_news.json (Package 14). Re-validates what
     * the pipeline wrote -- items need a title and an http(s) URL to render
     * as links -- and returns null when both sections are empty so the
     * panel stays hidden.
     */
    function techNewsSummary(payload, cap) {
        if (!payload) return null;
        cap = cap || 8;
        function clean(list) {
            return (list || []).filter(function (item) {
                return item && item.title
                    && typeof item.url === "string"
                    && (item.url.indexOf("https://") === 0 || item.url.indexOf("http://") === 0);
            }).slice(0, cap);
        }
        var ai = clean(payload.ai);
        var dev = clean(payload.dev);
        if (!ai.length && !dev.length) return null;
        return { generated: payload.generated || "", ai: ai, dev: dev };
    }

    /** HTML for the tech news panel body. Escaped throughout. */
    function renderTechNewsHTML(summary) {
        function group(label, items) {
            if (!items.length) return "";
            return '<div class="insight-group"><h3>' + esc(label) + "</h3><ul>"
                + items.map(function (item) {
                    return '<li><a class="report-link" rel="noopener noreferrer" target="_blank" href="'
                        + esc(item.url) + '">' + esc(item.title) + "</a>"
                        + (item.source ? ' <span class="insight-count">' + esc(item.source) + "</span>" : "")
                        + "</li>";
                }).join("") + "</ul></div>";
        }
        return group("AI industry", summary.ai) + group("Developer world", summary.dev);
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

        var contextPanel = doc.getElementById("context-panel");
        if (contextPanel && typeof global.fetch === "function") {
            Promise.all([
                global.fetch(DATA + "/trends.json")
                    .then(function (res) { return res.ok ? res.json() : null; })
                    .catch(function () { return null; }),
                global.fetch(DATA + "/weather.json")
                    .then(function (res) { return res.ok ? res.json() : null; })
                    .catch(function () { return null; })
            ]).then(function (results) {
                var trends = trendsSummary(results[0]);
                var weather = weatherSummary(results[1]);
                if (!trends && !weather) return; // stays hidden

                var weatherEl = doc.getElementById("context-weather");
                if (weatherEl && weather) {
                    weatherEl.textContent = weather.cities.map(function (c) { return c.line; }).join("  ·  ");
                }
                var body = doc.getElementById("context-trends");
                if (body && trends) {
                    body.innerHTML = renderTrendsHTML(trends);
                }
                contextPanel.hidden = false;
            });
        }

        var techPanel = doc.getElementById("tech-news-panel");
        if (techPanel && typeof global.fetch === "function") {
            global.fetch(DATA + "/tech_news.json")
                .then(function (res) { return res.ok ? res.json() : null; })
                .catch(function () { return null; })
                .then(function (payload) {
                    var summary = techNewsSummary(payload);
                    if (!summary) return; // stays hidden
                    var body = doc.getElementById("tech-news-body");
                    if (!body) return;
                    body.innerHTML = renderTechNewsHTML(summary);
                    var stamp = doc.getElementById("tech-news-generated");
                    if (stamp && summary.generated) stamp.textContent = "as of " + summary.generated;
                    techPanel.hidden = false;
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
        trendsSummary: trendsSummary,
        weatherSummary: weatherSummary,
        renderTrendsHTML: renderTrendsHTML,
        techNewsSummary: techNewsSummary,
        renderTechNewsHTML: renderTechNewsHTML,
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
