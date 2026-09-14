/**
 * AURA entity dossier pages (#/company/:slug, #/person/:slug, #/agency/:slug).
 *
 * Pure compute half (build a dossier model from the static datasets) plus a
 * guarded DOM shell that registers the three page views with AuraRouter and
 * renders into the [data-route-outlet] the shell shipped in Slice B.
 *
 * Honesty rules from the Tier 1 plan: only panels backed by real data are
 * rendered; there is no fabricated timeline, org chart or confidence score.
 * Verification Status is shown verbatim.
 */
(function (global) {
    "use strict";

    var EK = global.AuraEntityKey;
    var PSC = global.AuraPSC;

    function esc(value) {
        return String(value == null ? "" : value)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }

    function matches(name, slug) {
        return EK && EK.matchesSlug(name, slug);
    }

    /** Articles whose title or summary mentions the entity name. */
    function articleMentions(articles, name, cap) {
        var needle = String(name || "").toLowerCase();
        if (needle.length < 3) return [];
        var hits = [];
        for (var i = 0; i < (articles || []).length; i++) {
            var a = articles[i];
            var hay = (String(a.Title || "") + " " + String(a.Summary || "")).toLowerCase();
            if (hay.indexOf(needle) !== -1) {
                hits.push({
                    title: a.Title || "",
                    url: /^https?:\/\//.test(String(a.URL || "")) ? a.URL : "",
                    source: a.Source || "",
                    time: String(a.Time || "").slice(0, 10),
                    risk: a["Risk Score"]
                });
                if (hits.length >= (cap || 8)) break;
            }
        }
        return hits;
    }

    /** Model for a company dossier, or null when the slug matches nothing. */
    function companyDossier(slug, data) {
        data = data || {};
        var row = null;
        (data.companies || []).forEach(function (c) {
            if (!row && matches(c.Company, slug)) row = c;
        });
        var owners = (data.psc || []).filter(function (r) {
            return matches(r.Company, slug);
        });
        var contracts = (data.procurement || []).filter(function (r) {
            return matches(r.Contractor, slug) || matches(r.Agency, slug);
        });
        if (!row && !owners.length && !contracts.length) return null;
        var name = row ? row.Company
            : (owners.length ? owners[0].Company
                : (matches(contracts[0].Contractor, slug) ? contracts[0].Contractor : contracts[0].Agency));
        return {
            kind: "company",
            name: name,
            header: row ? {
                industry: row.Industry || "",
                risk: row["Risk Level"] || "",
                mentions: row["Mention Count"],
                lastSeen: row["Last Seen"] || ""
            } : null,
            owners: owners.map(function (r) {
                return {
                    person: r["Person Name"] || "",
                    percentage: r.Percentage || "",
                    nature: r["Nature of Control"] || "",
                    vehicle: r["Intermediate Entities"] || "",
                    verification: r["Verification Status"] || "",
                    flags: PSC ? PSC.redFlagsFor(r, PSC.buildContext(data.psc || [])) : []
                };
            }),
            procurement: contracts.map(function (r) {
                return { agency: r.Agency || "", contractor: r.Contractor || "",
                         amount: r.Amount || "", project: r.Project || "",
                         date: String(r.Date || "").slice(0, 10) };
            }),
            articles: articleMentions(data.articles, name)
        };
    }

    /** Model for a person dossier. */
    function personDossier(slug, data) {
        data = data || {};
        var appearances = (data.people || []).filter(function (p) {
            return matches(p.Name, slug);
        });
        var pscRows = (data.psc || []).filter(function (r) {
            return matches(r["Person Name"], slug);
        });
        if (!appearances.length && !pscRows.length) return null;
        var name = appearances.length ? appearances[0].Name : pscRows[0]["Person Name"];
        var latest = appearances.slice().sort(function (a, b) {
            return String(b.Date || "").localeCompare(String(a.Date || ""));
        })[0] || null;
        return {
            kind: "person",
            name: name,
            header: latest ? {
                position: latest.Position || "",
                organization: latest.Organization || "",
                event: latest.Event || "",
                date: latest.Date || ""
            } : null,
            control: pscRows.map(function (r) {
                return {
                    company: r.Company || "",
                    percentage: r.Percentage || "",
                    // controlChain returns {kind,title,subtitle} steps; the
                    // dossier renders the titles as a breadcrumb.
                    chain: PSC ? PSC.controlChain(r).map(function (step) { return step.title; }) : [],
                    verification: r["Verification Status"] || "",
                    flags: PSC ? PSC.redFlagsFor(r, PSC.buildContext(data.psc || [])) : []
                };
            }),
            appearances: appearances.map(function (p) {
                return { position: p.Position || "", organization: p.Organization || "",
                         event: p.Event || "", date: p.Date || "" };
            }),
            articles: articleMentions(data.articles, name)
        };
    }

    /** Model for an agency dossier: procurement, recorded events, mentions.
        Falls back to the agencies dataset when there are no contracts --
        most agencies appear in news events, not in contract awards, and
        returning null for all of them made #/agency/ routes unreachable. */
    function agencyDossier(slug, data) {
        data = data || {};
        var contracts = (data.procurement || []).filter(function (r) {
            return matches(r.Agency, slug);
        });
        var mentions = (data.agencies || []).filter(function (r) {
            return matches(r.Agency, slug);
        });
        if (!contracts.length && !mentions.length) return null;
        var name = contracts.length ? contracts[0].Agency : mentions[0].Agency;
        return {
            kind: "agency",
            name: name,
            header: null,
            procurement: contracts.map(function (r) {
                return { agency: r.Agency || "", contractor: r.Contractor || "",
                         amount: r.Amount || "", project: r.Project || "",
                         date: String(r.Date || "").slice(0, 10) };
            }),
            appearances: mentions.slice(0, 10).map(function (r) {
                return { event: r.Event || "", position: "",
                         organization: r.Article || "", date: r.Date || "" };
            }),
            articles: articleMentions(data.articles, name)
        };
    }

    /**
     * Every dated fact in a dossier model -> continuous weekly buckets for
     * the timeline strip: recorded events, article mentions, contracts.
     * Honesty rule: only real dates bucket; nothing is interpolated, and a
     * week with no records renders as a gap. PSC control rows carry no
     * date in the model and contribute nothing.
     */
    function dossierTimeline(model, weekCap) {
        weekCap = weekCap || 26;
        if (!model) return { weeks: [] };
        var dates = [];
        (model.appearances || []).forEach(function (p) { if (p.date) dates.push(String(p.date).slice(0, 10)); });
        (model.articles || []).forEach(function (a) { if (a.time) dates.push(String(a.time).slice(0, 10)); });
        (model.procurement || []).forEach(function (p) { if (p.date) dates.push(String(p.date).slice(0, 10)); });

        var buckets = {};
        dates.forEach(function (d) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
            var dt = new Date(d + "T00:00:00Z");
            if (isNaN(dt.getTime())) return;
            var monday = new Date(dt.getTime());
            monday.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));
            var key = monday.toISOString().slice(0, 10);
            buckets[key] = (buckets[key] || 0) + 1;
        });
        var keys = Object.keys(buckets).sort();
        if (!keys.length) return { weeks: [] };

        var weeks = [];
        var cursor = new Date(keys[0] + "T00:00:00Z");
        var last = new Date(keys[keys.length - 1] + "T00:00:00Z");
        while (cursor <= last && weeks.length < 520) {
            var k = cursor.toISOString().slice(0, 10);
            weeks.push({ week: k, count: buckets[k] || 0 });
            cursor.setUTCDate(cursor.getUTCDate() + 7);
        }
        return { weeks: weeks.slice(-weekCap) };
    }

    /** Inline-SVG density strip -- no chart library, CSP-safe. */
    function timelineHTML(timeline) {
        var weeks = (timeline || {}).weeks || [];
        if (weeks.length < 2) return ""; // one week is a date, not a timeline
        var max = 0;
        weeks.forEach(function (w) { if (w.count > max) max = w.count; });
        var W = 8, GAP = 2, H = 34;
        var width = weeks.length * (W + GAP);
        var bars = weeks.map(function (w, i) {
            var h = w.count && max ? Math.max(3, Math.round((H - 4) * w.count / max)) : 2;
            return '<rect x="' + (i * (W + GAP)) + '" y="' + (H - h) + '" width="' + W
                + '" height="' + h + '" rx="1" class="' + (w.count ? "tl-on" : "tl-off") + '">'
                + "<title>" + esc(w.week) + ": " + w.count + " record" + (w.count === 1 ? "" : "s")
                + "</title></rect>";
        }).join("");
        return '<section class="dossier-panel dossier-timeline"><h2>Activity timeline</h2>'
            + '<svg viewBox="0 0 ' + width + " " + H + '" height="' + H
            + '" role="img" aria-label="Weekly recorded activity from ' + esc(weeks[0].week)
            + " to " + esc(weeks[weeks.length - 1].week) + '" preserveAspectRatio="xMinYMax meet">'
            + bars + "</svg>"
            + '<p class="dossier-sub">' + esc(weeks[0].week) + " → " + esc(weeks[weeks.length - 1].week)
            + " · weekly density of recorded events, mentions and contracts</p></section>";
    }

    /**
     * The dossier model as a Markdown document -- the unit analysts
     * actually circulate. Mirrors the rendered panels; nothing appears
     * here that the page would not show.
     */
    function dossierMarkdown(model, generatedOn) {
        if (!model) return "";
        var lines = ["# " + model.name, "",
                     "_" + model.kind.toUpperCase() + " dossier · AURA · "
                     + (generatedOn || new Date().toISOString().slice(0, 10)) + "_", ""];
        function section(title, items, fmt) {
            if (!items || !items.length) return;
            lines.push("## " + title, "");
            items.forEach(function (item) { lines.push("- " + fmt(item)); });
            lines.push("");
        }
        if (model.header) {
            var bits = [];
            Object.keys(model.header).forEach(function (k) {
                var v = model.header[k];
                if (v !== null && v !== undefined && String(v).trim() !== "") bits.push(k + ": " + v);
            });
            if (bits.length) lines.push(bits.join(" · "), "");
        }
        section("Beneficial owners (PSC)", model.owners, function (o) {
            return o.person + (o.percentage ? " — " + o.percentage : "")
                + (o.vehicle && o.vehicle !== "Direct Holding" ? " (via " + o.vehicle + ")" : "")
                + (o.verification ? " — " + o.verification : "");
        });
        section("Significant control", model.control, function (c) {
            return c.company + (c.percentage ? " — " + c.percentage : "")
                + (c.verification ? " — " + c.verification : "");
        });
        section("Recorded events", model.appearances, function (p) {
            return [p.event, p.position, p.organization, p.date].filter(Boolean).join(" · ");
        });
        section("Procurement", model.procurement, function (p) {
            return [p.project || "Contract", p.contractor, p.agency, p.amount, p.date]
                .filter(Boolean).join(" · ");
        });
        section("Article mentions", model.articles, function (a) {
            return (a.url ? "[" + a.title + "](" + a.url + ")" : a.title)
                + (a.source ? " — " + a.source : "") + (a.time ? " · " + a.time : "");
        });
        lines.push("---", "_Evidence of reporting, not a finding. Generated from AURA's published data._");
        return lines.join("\n");
    }

    function articleListHTML(articles) {
        if (!articles.length) return "";
        return '<section class="dossier-panel"><h2>Article mentions</h2><ul>'
            + articles.map(function (a) {
                var label = esc(a.title) + (a.source ? ' <span class="dossier-sub">' + esc(a.source)
                    + (a.time ? " · " + esc(a.time) : "") + "</span>" : "");
                return "<li>" + (a.url
                    ? '<a class="report-link" rel="noopener noreferrer" target="_blank" href="'
                        + esc(a.url) + '">' + label + "</a>"
                    : label) + "</li>";
            }).join("") + "</ul></section>";
    }

    function flagsHTML(flags) {
        if (!flags || !flags.length) return "";
        return '<ul class="dossier-flags">' + flags.map(function (f) {
            return '<li class="flag-' + esc(f.severity || "info") + '">' + esc(f.title) + "</li>";
        }).join("") + "</ul>";
    }

    /** Escaped HTML for any dossier model. */
    function renderDossierHTML(model) {
        if (!model) {
            return '<div class="dossier"><p class="empty-note">No records match this entity. '
                + 'It may have been renamed, or the data has not been exported yet.</p>'
                + '<p><a href="#/">Back to the dashboard</a></p></div>';
        }
        var html = '<div class="dossier"><header class="dossier-header">'
            + "<h1>" + esc(model.name) + "</h1>"
            + '<p class="dossier-kind">' + esc(model.kind.toUpperCase()) + " DOSSIER</p>";
        if (model.header) {
            var bits = [];
            if (model.kind === "company") {
                if (model.header.industry) bits.push(esc(model.header.industry));
                if (model.header.risk) bits.push("Risk: " + esc(model.header.risk));
                if (model.header.mentions != null && model.header.mentions !== "") {
                    bits.push(esc(model.header.mentions) + " mentions");
                }
                if (model.header.lastSeen) bits.push("Last seen " + esc(model.header.lastSeen));
            } else {
                if (model.header.position) bits.push(esc(model.header.position));
                if (model.header.organization) bits.push(esc(model.header.organization));
                if (model.header.event) bits.push(esc(model.header.event));
                if (model.header.date) bits.push(esc(model.header.date));
            }
            if (bits.length) html += '<p class="dossier-meta">' + bits.join(" · ") + "</p>";
        }
        html += "</header>";

        html += timelineHTML(dossierTimeline(model));

        if (model.owners && model.owners.length) {
            html += '<section class="dossier-panel"><h2>Beneficial owners (PSC)</h2><ul>'
                + model.owners.map(function (o) {
                    return "<li><strong>" + esc(o.person) + "</strong>"
                        + (o.percentage ? " — " + esc(o.percentage) : "")
                        + (o.vehicle && o.vehicle !== "Direct Holding" && o.vehicle !== "Direct Shareholder"
                            ? ' <span class="dossier-sub">via ' + esc(o.vehicle) + "</span>" : "")
                        + (o.verification ? ' <span class="dossier-sub">' + esc(o.verification) + "</span>" : "")
                        + flagsHTML(o.flags) + "</li>";
                }).join("") + "</ul></section>";
        }
        if (model.control && model.control.length) {
            html += '<section class="dossier-panel"><h2>Significant control</h2><ul>'
                + model.control.map(function (c) {
                    return "<li><strong>" + esc(c.company) + "</strong>"
                        + (c.percentage ? " — " + esc(c.percentage) : "")
                        + (c.chain && c.chain.length > 2
                            ? ' <span class="dossier-sub">' + esc(c.chain.join(" → ")) + "</span>" : "")
                        + (c.verification ? ' <span class="dossier-sub">' + esc(c.verification) + "</span>" : "")
                        + flagsHTML(c.flags) + "</li>";
                }).join("") + "</ul></section>";
        }
        if (model.appearances && model.appearances.length) {
            html += '<section class="dossier-panel"><h2>Recorded events</h2><ul>'
                + model.appearances.map(function (p) {
                    return "<li>" + esc([p.event, p.position, p.organization, p.date]
                        .filter(Boolean).join(" · ")) + "</li>";
                }).join("") + "</ul></section>";
        }
        if (model.procurement && model.procurement.length) {
            html += '<section class="dossier-panel"><h2>Procurement</h2><ul>'
                + model.procurement.map(function (p) {
                    return "<li>" + esc([p.project || "Contract", p.contractor, p.agency, p.amount]
                        .filter(Boolean).join(" · ")) + "</li>";
                }).join("") + "</ul></section>";
        }
        html += articleListHTML(model.articles || []);
        html += '<p class="dossier-back"><a href="#/">← Back to the dashboard</a></p></div>';
        return html;
    }

    // =====================================================================
    // DOM shell -- registers the router views; no-ops headless.
    // =====================================================================

    function bind() {
        var doc = global.document;
        var Router = global.AuraRouter;
        if (!doc || typeof doc.querySelector !== "function" || !Router) return;

        var outlet = doc.querySelector("[data-route-outlet]");
        if (!outlet) return;

        var dataPromise = null;
        function loadData() {
            if (dataPromise) return dataPromise;
            // Through AuraData: shares in-flight promises with the search
            // palette and the dashboard instead of re-downloading ~300KB.
            var D = global.AuraData;
            dataPromise = Promise.all([
                D.getList("companies.json"), D.getList("people.json"),
                D.getList("significant_control.json"), D.getList("procurement.json"),
                D.getList("latest.json"), D.getList("agencies.json")
            ]).then(function (r) {
                return { companies: r[0], people: r[1], psc: r[2],
                         procurement: r[3], articles: r[4], agencies: r[5] };
            });
            return dataPromise;
        }

        var main = doc.getElementById("main");

        function show(html) {
            outlet.innerHTML = html;
            outlet.hidden = false;
            // Page mode: hide the dashboard sections underneath. Without
            // this the dossier rendered ON TOP of the still-mounted hero,
            // brief, register and graph -- with two <h1>s in the document.
            // CSS: main[data-route-page] > :not([data-route-outlet]).
            if (main) main.setAttribute("data-route-page", "true");
            try { global.scrollTo(0, 0); } catch (e) { /* headless */ }
        }

        function leavePageMode() {
            outlet.hidden = true;
            if (main) main.removeAttribute("data-route-page");
        }

        /**
         * Watch toggle in the dossier header (Slice H). State lives in
         * AuraLocalStore -- per-browser only, and the note under the
         * button says so; skipped entirely when the store module is
         * absent so dossiers keep no hard dependency on it.
         */
        function wireWatch(model, slug) {
            var LS = global.AuraLocalStore;
            if (!model || !LS) return;
            var header = outlet.querySelector(".dossier-header");
            if (!header) return;

            var btn = doc.createElement("button");
            btn.type = "button";
            btn.className = "btn btn-secondary dossier-watch-btn";
            function paint() {
                var watched = LS.isWatched(LS.loadState(), model.kind, slug);
                btn.textContent = watched ? "★ Watching" : "☆ Watch";
                btn.setAttribute("aria-pressed", String(watched));
            }
            btn.addEventListener("click", function () {
                LS.saveState(LS.toggleWatch(LS.loadState(),
                    { type: model.kind, slug: slug, label: model.name }));
                paint();
                // The dashboard's watchlist panel re-reads on this signal.
                try {
                    doc.dispatchEvent(new global.CustomEvent("aura:watchlist"));
                } catch (e) { /* ancient browser: panel refreshes on reload */ }
            });
            paint();
            header.appendChild(btn);

            var note = doc.createElement("p");
            note.className = "dossier-sub dossier-watch-note";
            note.textContent = "Watchlist entries are saved only in this browser.";
            header.appendChild(note);
        }

        /**
         * Export (Markdown download) and Compare buttons next to Watch --
         * the entity level is the unit analysts actually circulate, and
         * export used to exist only dashboard-wide.
         */
        function wireDossierActions(model, slug) {
            if (!model) return;
            var header = outlet.querySelector(".dossier-header");
            if (!header) return;

            var exportBtn = doc.createElement("button");
            exportBtn.type = "button";
            exportBtn.className = "btn btn-secondary dossier-watch-btn";
            exportBtn.textContent = "⬇ Export dossier";
            exportBtn.addEventListener("click", function () {
                try {
                    var blob = new global.Blob([dossierMarkdown(model)],
                        { type: "text/markdown;charset=utf-8" });
                    var url = global.URL.createObjectURL(blob);
                    var link = doc.createElement("a");
                    link.href = url;
                    link.download = "aura-dossier-" + slug + ".md";
                    doc.body.appendChild(link);
                    link.click();
                    link.remove();
                    global.setTimeout(function () { global.URL.revokeObjectURL(url); }, 5000);
                } catch (e) { /* Blob/URL unavailable: nothing to break */ }
            });
            header.appendChild(exportBtn);

            var compareLink = doc.createElement("a");
            compareLink.className = "btn btn-secondary dossier-watch-btn";
            compareLink.href = "#/compare?a=" + encodeURIComponent(model.kind + "/" + slug);
            compareLink.textContent = "⇄ Compare";
            header.appendChild(compareLink);
        }

        // Generation counter: the first dossier visit fetches ~300KB of
        // datasets, and navigating away mid-load used to re-open the
        // dossier over the destination when the promise finally settled.
        var navGeneration = 0;

        function pageHandler(build) {
            return function (params) {
                var generation = ++navGeneration;
                show('<div class="dossier"><p class="empty-note">Loading…</p></div>');
                loadData().then(function (data) {
                    if (generation !== navGeneration) return; // user moved on
                    var model = build(params.slug, data);
                    show(renderDossierHTML(model));
                    wireWatch(model, params.slug);
                    wireDossierActions(model, params.slug);
                }).catch(function () {
                    if (generation !== navGeneration) return;
                    show('<div class="dossier"><p class="empty-note">'
                        + 'The dossier data could not be loaded. '
                        + '<a href="#/">Back to the dashboard</a></p></div>');
                });
            };
        }

        Object.keys(PAGE_VIEWS).forEach(function (view) {
            Router.register(view, pageHandler(PAGE_VIEWS[view]));
        });

        // Leaving a dossier for any section-scroll view (or a legacy #anchor)
        // restores the dashboard and invalidates any in-flight dossier load.
        // Navigating to ANOTHER module's page view (compare, investigations)
        // must also invalidate: a dossier fetch that settled after the user
        // moved to #/compare used to overwrite the compare page.
        global.addEventListener("hashchange", function () {
            var hash = (global.location && global.location.hash) || "";
            var m = Router.matchRoute(hash);
            if (!Router.isRouteHash(hash) || (m && Router.SECTION_VIEWS[m.view] !== undefined)) {
                navGeneration++;
                leavePageMode();
            } else if (m && !PAGE_VIEWS[m.view]) {
                navGeneration++; // another module owns the outlet now
            }
        });

        // Deep link: a dossier hash pasted into a fresh tab dispatched before
        // these handlers existed; re-dispatch now that they do.
        var hash = (global.location && global.location.hash) || "";
        var current = Router.matchRoute(hash);
        if (current && PAGE_VIEWS[current.view]) {
            Router.dispatch(hash);
        }
    }

    /**
     * Router view name -> dossier builder. Keys MUST be the view names the
     * router's ROUTES table produces: bind() registers exactly these, and
     * the first shipped version registered "company" while the route
     * matched as "company-dossier" -- every dossier link fell back to home.
     * The test suite asserts each :slug route has a builder here.
     */
    var PAGE_VIEWS = {
        "company-dossier": companyDossier,
        "person-dossier": personDossier,
        "agency-dossier": agencyDossier
    };

    global.AuraDossier = {
        companyDossier: companyDossier,
        personDossier: personDossier,
        agencyDossier: agencyDossier,
        articleMentions: articleMentions,
        renderDossierHTML: renderDossierHTML,
        dossierTimeline: dossierTimeline,
        timelineHTML: timelineHTML,
        dossierMarkdown: dossierMarkdown,
        PAGE_VIEWS: PAGE_VIEWS
    };

    if (global.document && typeof global.document.addEventListener === "function") {
        if (global.document.readyState === "loading") {
            global.document.addEventListener("DOMContentLoaded", bind);
        } else {
            bind();
        }
    }
})(window);
