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
        // The denominator the chips were missing: "ncaa +7" is meaningless
        // without knowing total volume fell 24%. Both fields have been in
        // trends.json since the file existed; nothing rendered them.
        var recent = num(trends.recent_articles);
        var previous = num(trends.previous_articles);
        var volume = null;
        if (recent !== null && previous !== null && (recent || previous)) {
            volume = {
                recent: recent,
                previous: previous,
                pct: previous > 0 ? Math.round(100 * (recent - previous) / previous) : null
            };
        }
        var categories = (trends.categories || []).map(function (c) {
            c = c || {};
            return { category: String(c.category || "").trim(),
                     recent: num(c.recent) || 0, previous: num(c.previous) || 0 };
        }).filter(function (c) { return c.category && (c.recent || c.previous); });

        if (!rising.length && !falling.length && !social.length
            && !volume && !categories.length) return null;
        return {
            generated: trends.generated || "",
            windowDays: trends.window_days || 7,
            volume: volume,
            categories: categories,
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
        if (summary.volume) {
            var v = summary.volume;
            var delta = v.pct === null ? ""
                : " (" + (v.pct > 0 ? "+" : "") + v.pct + "%)";
            html += '<p class="trend-volume">' + esc(v.recent) + " articles this window vs "
                + esc(v.previous) + " last" + esc(delta) + "</p>";
        }
        if (summary.categories && summary.categories.length) {
            html += '<div class="insight-group"><h3>By category</h3><ul class="trend-cats">'
                + summary.categories.map(function (c) {
                    var dir = c.recent > c.previous ? "up" : (c.recent < c.previous ? "down" : "flat");
                    return '<li class="trend-cat trend-cat-' + dir + '">' + esc(c.category)
                        + ' <span class="trend-delta">' + esc(c.previous) + " → " + esc(c.recent)
                        + "</span></li>";
                }).join("") + "</ul></div>";
        }
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

    var RISK_RANK = { critical: 4, high: 3, elevated: 2, medium: 2, low: 1 };

    /**
     * Displayable model for the company risk leaderboard. 1009 companies
     * are downloaded on every cold boot and used for a single integer;
     * 59 are flagged Critical and nothing on the dashboard says which.
     * Elevated (non-Low) entities lead, ranked by severity then mentions;
     * when nothing is elevated the most-mentioned companies stand in.
     * Null when there are no companies at all (panel stays hidden).
     */
    function companyLeaderboard(companies, cap) {
        cap = cap || 12;
        var rows = (companies || []).map(function (c) {
            c = c || {};
            return {
                name: String(c.Company || "").trim(),
                mentions: num(c["Mention Count"]) || 0,
                risk: String(c["Risk Level"] || "").trim() || "Low",
                lastSeen: String(c["Last Seen"] || "").trim().slice(0, 10)
            };
        }).filter(function (r) { return r.name; });
        if (!rows.length) return null;

        function rank(r) { return RISK_RANK[r.risk.toLowerCase()] || 1; }
        var elevated = rows.filter(function (r) { return rank(r) > 1; });
        var pool = elevated.length ? elevated : rows;
        pool = pool.slice().sort(function (a, b) {
            return (rank(b) - rank(a)) || (b.mentions - a.mentions)
                || (a.name < b.name ? -1 : 1);
        });
        return {
            total: rows.length,
            elevatedCount: elevated.length,
            mode: elevated.length ? "elevated" : "top",
            rows: pool.slice(0, cap)
        };
    }

    /** HTML for the leaderboard body; rows link to company dossiers. */
    function renderLeaderboardHTML(model) {
        var EK = global.AuraEntityKey;
        return "<ol class=\"risk-board\">" + model.rows.map(function (r) {
            var riskClass = r.risk.toLowerCase().replace(/[^a-z-]/g, "");
            var label = EK && EK.slugify
                ? '<a class="report-link" href="#/company/' + esc(EK.slugify(r.name)) + '">'
                    + esc(r.name) + "</a>"
                : esc(r.name);
            return '<li><span class="risk-dot ' + esc(riskClass) + '"></span>' + label
                + ' <span class="insight-count">' + esc(r.risk) + " · "
                + esc(r.mentions) + " mention" + (r.mentions === 1 ? "" : "s")
                + (r.lastSeen ? " · seen " + esc(r.lastSeen) : "") + "</span></li>";
        }).join("") + "</ol>";
    }

    /**
     * Cross-reference the localStorage watchlist against changes.json:
     * which watched entities moved this cycle, and how. Matching is
     * slugify-equality, which is the correct join: changes.json carries
     * the exporter's deduped labels -- the same labels dossier slugs (and
     * therefore watch entries) derive from. Returns { total, updates: {
     * "type/slug": ["PSC record added", ...] } }; total 0 = quiet cycle.
     */
    function watchlistDigest(watchlist, changes) {
        var EK = global.AuraEntityKey;
        var updates = {};
        var total = 0;
        if (!changes || !EK || !EK.slugify || !(watchlist || []).length) {
            return { total: 0, updates: updates };
        }
        function hit(entry, label) {
            var key = entry.type + "/" + entry.slug;
            var list = updates[key] || (updates[key] = []);
            if (list.indexOf(label) === -1) { list.push(label); total += 1; }
        }
        function nameMatches(entry, name) {
            return EK.slugify(String(name || "")) === entry.slug;
        }
        (watchlist || []).forEach(function (entry) {
            if (!entry || !entry.slug || !entry.type) return;
            (changes.new_companies || []).forEach(function (name) {
                if (entry.type === "company" && nameMatches(entry, name)) hit(entry, "newly tracked");
            });
            (changes.new_people || []).forEach(function (name) {
                if (entry.type === "person" && nameMatches(entry, name)) hit(entry, "newly tracked");
            });
            (changes.psc_added || []).forEach(function (e) {
                if (nameMatches(entry, e.person) || nameMatches(entry, e.company)) hit(entry, "PSC record added");
            });
            (changes.psc_changed || []).forEach(function (e) {
                if (nameMatches(entry, e.person) || nameMatches(entry, e.company)) {
                    hit(entry, "ownership moved " + e.from + "% → " + e.to + "%");
                }
            });
            (changes.psc_removed || []).forEach(function (e) {
                if (nameMatches(entry, e.person) || nameMatches(entry, e.company)) hit(entry, "PSC record delisted");
            });
        });
        return { total: total, updates: updates };
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
    // Signals: the round-5 analytics exports that never had panels.
    // Pure summaries + renderers, wired in bind() like every other panel.
    // =====================================================================

    /** num() yields null for garbage; counts want a hard 0 instead. */
    function count(value) {
        var n = num(value);
        return n === null ? 0 : Math.round(n);
    }

    /** risk_movers.json -> rows for the movers column, or null to hide. */
    function moversSummary(payload, cap) {
        if (!payload || !Array.isArray(payload.movers) || !payload.movers.length) return null;
        var rows = payload.movers.slice(0, cap || 6).map(function (m) {
            return {
                label: String(m.label || m.key || "").trim(),
                delta: typeof m.delta === "number" ? m.delta : null,
                recent: typeof m.recent_avg === "number" ? m.recent_avg : null,
                mentions: count(m.recent_mentions)
            };
        }).filter(function (r) { return r.label; });
        if (!rows.length) return null;
        return { rows: rows, windowDays: count(payload.window_days) || 7 };
    }

    function renderMoversHTML(model) {
        return "<ol class=\"signal-list\">" + model.rows.map(function (r) {
            var badge = r.delta === null
                ? '<span class="mover-delta mover-new">new</span>'
                : '<span class="mover-delta ' + (r.delta >= 0 ? "mover-up" : "mover-down") + '">'
                    + (r.delta >= 0 ? "▲" : "▼") + " " + Math.abs(Math.round(r.delta)) + "</span>";
            return "<li><span class=\"signal-label\">" + esc(r.label) + "</span>"
                + badge
                + '<span class="signal-meta">risk ' + (r.recent === null ? "—" : Math.round(r.recent))
                + " · " + r.mentions + " mention" + (r.mentions === 1 ? "" : "s") + "</span></li>";
        }).join("") + "</ol>";
    }

    /** sectors.json -> named sectors + an uncategorized footnote, or null. */
    function sectorsSummary(payload, cap) {
        if (!payload || !Array.isArray(payload.sectors)) return null;
        var named = [];
        var uncategorized = 0;
        payload.sectors.forEach(function (s) {
            var industry = String(s.industry || "").trim();
            if (!industry) return;
            if (industry === "General") {
                uncategorized = count(s.companies);
                return;
            }
            var risk = s.risk || {};
            named.push({
                industry: industry,
                companies: count(s.companies),
                mentions: count(s.mentions),
                elevated: count(risk.High) + count(risk.Critical)
            });
        });
        named.sort(function (a, b) { return b.mentions - a.mentions; });
        named = named.slice(0, cap || 6);
        if (!named.length) return null;
        return { rows: named, uncategorized: uncategorized };
    }

    function renderSectorsHTML(model) {
        var max = model.rows.reduce(function (m, r) { return Math.max(m, r.mentions); }, 1);
        var html = "<ul class=\"signal-list sector-list\">" + model.rows.map(function (r) {
            return "<li><span class=\"signal-label\">" + esc(r.industry) + "</span>"
                + '<span class="sector-bar"><span style="width:'
                + Math.max(4, Math.round(100 * r.mentions / max)) + '%"></span></span>'
                + '<span class="signal-meta">' + r.mentions + " mentions · "
                + r.companies + (r.companies === 1 ? " company" : " companies")
                + (r.elevated ? " · <strong>" + r.elevated + " elevated</strong>" : "")
                + "</span></li>";
        }).join("") + "</ul>";
        if (model.uncategorized) {
            html += '<p class="signal-footnote">' + model.uncategorized
                + " further companies have no sector assigned yet.</p>";
        }
        return html;
    }

    /** sources.json -> outlet scorecard rows, or null. */
    function sourcesSummary(payload, cap) {
        if (!payload || !Array.isArray(payload.sources) || !payload.sources.length) return null;
        var rows = payload.sources.slice(0, cap || 6).map(function (s) {
            return {
                source: String(s.source || "").trim(),
                total: count(s.total),
                acceptRate: count(s.accept_rate),
                avgRisk: typeof s.avg_risk === "number" ? s.avg_risk : null,
                lastSeen: String(s.last_seen || "")
            };
        }).filter(function (r) { return r.source && r.total; });
        if (!rows.length) return null;
        return { rows: rows };
    }

    function renderSourcesHTML(model) {
        return "<ul class=\"signal-list\">" + model.rows.map(function (r) {
            return "<li><span class=\"signal-label\">" + esc(r.source) + "</span>"
                + '<span class="signal-meta">' + r.total + " articles · "
                + r.acceptRate + "% accepted · avg risk "
                + (r.avgRisk === null ? "—" : Math.round(r.avgRisk))
                + (r.lastSeen ? " · seen " + esc(r.lastSeen) : "")
                + "</span></li>";
        }).join("") + "</ul>";
    }

    /** fx.json -> latest naira rates + day deltas + a USD sparkline. */
    function fxSummary(fx, sparkDays) {
        if (!fx || !fx.latest) return null;
        var history = Array.isArray(fx.history) ? fx.history : [];
        var rows = [];
        ["USD", "EUR", "GBP"].forEach(function (currency) {
            var value = fx.latest[currency];
            if (typeof value !== "number") return;
            var series = history.map(function (p) { return p[currency]; })
                .filter(function (v) { return typeof v === "number"; });
            var delta = null;
            if (series.length >= 2 && series[series.length - 2]) {
                delta = Math.round(1000 * (series[series.length - 1] - series[series.length - 2])
                    / series[series.length - 2]) / 10;
            }
            rows.push({ currency: currency, value: value, delta: delta });
        });
        if (!rows.length) return null;
        var usd = history.map(function (p) { return p.USD; })
            .filter(function (v) { return typeof v === "number"; })
            .slice(-(sparkDays || 30));
        var date = history.length
            ? String(history[history.length - 1].date || "").slice(0, 10) : "";
        return { rows: rows, usdSeries: usd, date: date };
    }

    function sparklineSVG(series, width, height) {
        if (!series || series.length < 2) return "";
        var min = Math.min.apply(null, series);
        var max = Math.max.apply(null, series);
        var span = (max - min) || 1;
        var w = width || 120;
        var hgt = height || 28;
        var points = series.map(function (v, i) {
            var x = Math.round(100 * i * w / (series.length - 1)) / 100;
            var y = Math.round(100 * (hgt - 3 - (hgt - 6) * (v - min) / span)) / 100;
            return x + "," + y;
        }).join(" ");
        return '<svg class="fx-spark" viewBox="0 0 ' + w + " " + hgt + '" width="' + w
            + '" height="' + hgt + '" aria-label="Naira per US dollar, last '
            + series.length + ' recorded days" role="img">'
            + '<polyline fill="none" stroke="currentColor" stroke-width="1.5" points="'
            + points + '" /></svg>';
    }

    function renderFxHTML(model) {
        var html = "<ul class=\"signal-list\">" + model.rows.map(function (r) {
            var delta = "";
            if (r.delta !== null) {
                var cls = r.delta > 0 ? "mover-up" : (r.delta < 0 ? "mover-down" : "mover-new");
                var sign = r.delta > 0 ? "▲" : (r.delta < 0 ? "▼" : "");
                delta = '<span class="mover-delta ' + cls + '">' + sign + " "
                    + Math.abs(r.delta) + "%</span>";
            }
            return "<li><span class=\"signal-label\">" + esc(r.currency)
                + " ₦" + r.value.toLocaleString("en-NG", { minimumFractionDigits: 2 })
                + "</span>" + delta + "</li>";
        }).join("") + "</ul>";
        html += sparklineSVG(model.usdSeries);
        if (model.date) {
            html += '<p class="signal-footnote">₦ per unit · as of ' + esc(model.date) + "</p>";
        }
        return html;
    }

    /**
     * reports.json -> "what AURA logged 30/90 days ago", nearest run day
     * within ±3 days of each offset. Rows only for offsets the archive
     * actually covers -- a young corpus shows one line, honestly.
     */
    function retrospective(reports, now, offsets) {
        var byDay = {};
        (reports || []).forEach(function (row) {
            var day = String((row || {}).Date == null ? "" : row.Date).trim().slice(0, 10);
            if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
            var b = byDay[day] || (byDay[day] = { articles: 0, highRisk: 0, archive: "" });
            b.articles += num(row["Total Articles"]) || 0;
            b.highRisk += num(row["High Risk"]) || 0;
            if (row["Archive File"]) b.archive = String(row["Archive File"]);
        });
        var DAY_MS = 86400000;
        var rows = [];
        (offsets || [30, 90]).forEach(function (offset) {
            var best = null;
            for (var jitter = 0; jitter <= 3 && !best; jitter++) {
                [offset + jitter, offset - jitter].forEach(function (o) {
                    if (best) return;
                    var d = new Date(now.getTime() - o * DAY_MS);
                    var key = d.toISOString().slice(0, 10);
                    if (byDay[key]) best = { date: key, data: byDay[key] };
                });
            }
            if (best) {
                rows.push({ label: offset + " days ago", date: best.date,
                            articles: best.data.articles, highRisk: best.data.highRisk,
                            archive: best.data.archive });
            }
        });
        return rows.length ? { rows: rows } : null;
    }

    function renderRetroHTML(model) {
        return "<ul class=\"signal-list\">" + model.rows.map(function (r) {
            return "<li><span class=\"signal-label\">" + esc(r.label)
                + " · " + esc(r.date) + "</span>"
                + '<span class="signal-meta">' + r.articles + " articles logged, "
                + r.highRisk + " high-risk"
                + "</span></li>";
        }).join("") + "</ul>";
    }

    // =====================================================================
    // DOM shell -- everything below no-ops headless.
    // =====================================================================

    function bind() {
        var doc = global.document;
        if (!doc || typeof doc.querySelector !== "function" || !global.AuraData) return;

        // All dataset reads go through AuraData's shared memo -- this
        // module alone used to add a third reports.json and a second
        // latest.json download to every cold boot.
        var D = global.AuraData;

        var changesPanel = doc.getElementById("cycle-changes-panel");
        if (changesPanel && typeof global.fetch === "function") {
            D.get("changes.json")
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
                D.get("trends.json"),
                D.get("weather.json")
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
            D.get("tech_news.json")
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

        var boardPanel = doc.getElementById("risk-leaderboard-panel");
        if (boardPanel && typeof global.fetch === "function") {
            D.getList("companies.json").then(function (companies) {
                var model = companyLeaderboard(companies, 12);
                if (!model) return; // stays hidden
                var body = doc.getElementById("risk-leaderboard-body");
                if (!body) return;
                body.innerHTML = renderLeaderboardHTML(model);
                var stamp = doc.getElementById("risk-leaderboard-note");
                if (stamp) {
                    stamp.textContent = model.mode === "elevated"
                        ? model.elevatedCount + " of " + model.total + " tracked companies sit above Low risk"
                        : "No elevated-risk companies; showing the most mentioned of " + model.total;
                }
                boardPanel.hidden = false;
            });
        }

        var signalsPanel = doc.getElementById("signals-panel");
        if (signalsPanel && typeof global.fetch === "function") {
            Promise.all([
                D.get("risk_movers.json"),
                D.get("sectors.json"),
                D.get("sources.json"),
                D.get("fx.json"),
                D.getList("reports.json")
            ]).then(function (results) {
                var movers = moversSummary(results[0], 6);
                var sectors = sectorsSummary(results[1], 6);
                var sources = sourcesSummary(results[2], 6);
                var fx = fxSummary(results[3]);
                var retro = retrospective(results[4], new Date());
                if (!movers && !sectors && !sources && !fx && !retro) return; // stays hidden

                function fill(colId, bodyId, html) {
                    var col = doc.getElementById(colId);
                    var body = doc.getElementById(bodyId);
                    if (!col || !body || !html) return;
                    body.innerHTML = html;
                    col.hidden = false;
                }
                fill("signals-movers", "signals-movers-body",
                    movers && renderMoversHTML(movers));
                fill("signals-sectors", "signals-sectors-body",
                    sectors && renderSectorsHTML(sectors));
                fill("signals-sources", "signals-sources-body",
                    sources && renderSourcesHTML(sources));
                fill("signals-fx", "signals-fx-body",
                    fx && renderFxHTML(fx));
                fill("signals-retro", "signals-retro-body",
                    retro && renderRetroHTML(retro));
                var note = doc.getElementById("signals-note");
                if (note && movers) {
                    note.textContent = "movers: last " + movers.windowDays
                        + " days vs the " + movers.windowDays + " before";
                }
                signalsPanel.hidden = false;
            });
        }

        var healthPanel = doc.getElementById("health-panel");
        if (healthPanel && typeof global.fetch === "function") {
            Promise.all([
                D.getList("reports.json"),
                D.getList("latest.json")
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
                // A canvas with a dead renderer is an empty rectangle that
                // explains nothing; swap in a note instead.
                function chartUnavailable(canvas) {
                    if (!canvas || !canvas.parentNode) return;
                    var note = doc.createElement("p");
                    note.className = "muted-note";
                    note.textContent = "The chart renderer failed to load — reload the page to retry.";
                    canvas.parentNode.replaceChild(note, canvas);
                }
                var volumeCanvas = doc.getElementById("health-chart");
                if (!Chart) chartUnavailable(volumeCanvas);
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
                if (!Chart) chartUnavailable(engineCanvas);
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
        companyLeaderboard: companyLeaderboard,
        renderLeaderboardHTML: renderLeaderboardHTML,
        watchlistDigest: watchlistDigest,
        moversSummary: moversSummary,
        renderMoversHTML: renderMoversHTML,
        sectorsSummary: sectorsSummary,
        renderSectorsHTML: renderSectorsHTML,
        sourcesSummary: sourcesSummary,
        renderSourcesHTML: renderSourcesHTML,
        fxSummary: fxSummary,
        renderFxHTML: renderFxHTML,
        retrospective: retrospective,
        renderRetroHTML: renderRetroHTML,
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
