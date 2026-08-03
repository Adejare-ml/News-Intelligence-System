/**
 * The report surface: hero, executive brief and the inline PSC register.
 *
 * These three sections are the product. They used to live behind buttons in
 * modal dialogs, which made the site's primary output un-linkable,
 * un-printable and invisible to search engines. Everything here renders into
 * the page itself; the modals survive only as an "expand" affordance.
 *
 * Also the boot point for the visual layer (backdrop, globe, scroll reveals),
 * because all of it shares one motion controller and one pause control.
 */
(function (global) {
    "use strict";

    var doc = global.document;
    var PSC = global.AuraPSC;
    var MD = global.AuraReportMarkdown;
    var Motion = global.AuraMotion;

    var isStatic = global.location.hostname.indexOf("github.io") !== -1
        || global.location.protocol === "file:"
        || global.location.search.indexOf("static=1") !== -1;
    var DATA = isStatic ? "data" : "/api/v1";

    var state = { records: [], summary: null, reports: [], filter: "all", query: "" };

    function el(id) { return doc.getElementById(id); }

    function esc(str) {
        return String(str == null ? "" : str)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }

    // =====================================================================
    // VISUAL LAYER
    // =====================================================================

    /**
     * One controller for every animated surface.
     *
     * WCAG 2.2.2 requires a visible mechanism to pause motion that runs for
     * more than five seconds, and it applies regardless of the OS-level
     * prefers-reduced-motion setting — a user may want this page still while
     * leaving animation on everywhere else. The button drives all animated
     * surfaces at once and persists the choice.
     */
    function bootVisuals() {
        var handles = [];

        var backdropCanvas = el("backdrop-canvas");
        if (backdropCanvas && global.AuraBackdrop) {
            var bd = global.AuraBackdrop.mount(backdropCanvas);
            if (bd) handles.push({ pause: function (p) { bd.setPaused(p); } });
        }

        var globeCanvas = el("globe-canvas");
        var globe = null;
        if (globeCanvas && global.AuraGlobe) {
            globe = global.AuraGlobe.mount(globeCanvas, { speed: 0.085, tilt: 18 });
            if (globe) {
                handles.push({
                    pause: function (p) { if (globe.isPaused() !== p) globe.toggle(); }
                });
                var detail = el("globe-caption-detail");
                if (detail) {
                    detail.textContent = globe.routes.length
                        + " secrecy jurisdictions that recur in Nigerian ownership chains — including "
                        + globe.routes.slice(0, 3).map(function (r) { return r.label; }).join(", ")
                        + ".";
                }
            }
        }

        var toggle = el("motion-toggle");
        var paused = false;
        try {
            paused = global.localStorage.getItem("aura-motion-paused") === "1";
        } catch (err) { /* private mode */ }

        function apply() {
            handles.forEach(function (h) {
                try { h.pause(paused); } catch (e) { /* keep the others running */ }
            });
            if (toggle) {
                toggle.setAttribute("aria-pressed", paused ? "true" : "false");
                var label = paused ? "Resume background motion" : "Pause background motion";
                toggle.setAttribute("aria-label", label);
                toggle.setAttribute("title", label);
                toggle.innerHTML = '<i data-lucide="' + (paused ? "play" : "pause") + '"></i>';
                if (global.lucide) global.lucide.createIcons();
            }
            doc.documentElement.classList.toggle("motion-paused", paused);
            // The knowledge graph lives in app.js and owns its own rAF loop,
            // so it listens for this rather than being reached into.
            doc.dispatchEvent(new CustomEvent("aura:motion", { detail: { paused: paused } }));
        }

        if (toggle) {
            toggle.addEventListener("click", function () {
                paused = !paused;
                try { global.localStorage.setItem("aura-motion-paused", paused ? "1" : "0"); } catch (e) {}
                apply();
            });
        }
        apply();

        if (Motion) {
            Motion.initReveals(doc);
            Motion.initScrollRail(doc.documentElement);
        }
    }

    // =====================================================================
    // HERO
    // =====================================================================

    function renderHero(report) {
        var summary = state.summary;
        var kpis = el("hero-kpis");

        // The headline is the report's own H1 when it has one, so the page
        // leads with what the brief actually says.
        var headingMatch = report && report.match(/^#\s+(.+)$/m);
        var generated = report && report.match(/\*\*Generated on:\*\*\s*(.+)$/m);

        var meta = el("hero-meta");
        if (meta) {
            var bits = [];
            if (generated) bits.push('<span><i data-lucide="clock"></i> As of ' + esc(generated[1].trim()) + "</span>");
            bits.push('<span><i data-lucide="database"></i> ' + (summary ? summary.total : 0) + " tracked control records</span>");
            if (summary && summary.isDemo) {
                bits.push('<span class="meta-warn"><i data-lucide="flask-conical"></i> Illustrative data</span>');
            }
            meta.innerHTML = bits.join("");
        }

        if (kpis && summary) {
            var cards = [
                {
                    value: summary.total,
                    label: "Control records",
                    note: "People with significant control tracked"
                },
                {
                    value: summary.highSeverityCount,
                    label: "High-severity flags",
                    note: "Holders matching a concealment pattern",
                    tone: summary.highSeverityCount > 0 ? "danger" : "ok"
                },
                {
                    value: summary.nigeriaBandCount,
                    label: "In the 5–25% band",
                    note: "Disclosable in Nigeria, invisible under a 25% rule",
                    tone: "nigeria"
                },
                {
                    value: summary.disclosureRate === null ? "—"
                        : Math.round(summary.disclosureRate * 100) + "%",
                    label: "Carry a filing reference",
                    note: "Share of records citing a CAC/SEC filing"
                }
            ];
            kpis.innerHTML = cards.map(function (c) {
                return '<div class="kpi ' + (c.tone ? "kpi-" + c.tone : "") + '">'
                    + '<span class="kpi-value" data-count="' + esc(c.value) + '">' + esc(c.value) + "</span>"
                    + '<span class="kpi-label">' + esc(c.label) + "</span>"
                    + '<span class="kpi-note">' + esc(c.note) + "</span>"
                    + "</div>";
            }).join("");

            // Roll the numeric ones up when they scroll into view.
            kpis.querySelectorAll(".kpi-value").forEach(function (node) {
                var raw = node.getAttribute("data-count");
                if (/^\d+$/.test(raw) && Motion) Motion.countUpOnReveal(node, Number(raw));
            });
        }

        if (headingMatch) {
            var headline = el("hero-headline");
            // Keep the standing headline unless the report has a more specific
            // one; the generic pipeline title is not worth promoting.
            var text = headingMatch[1].replace(/PSC & Company Daily Intelligence Report/i, "").trim();
            if (text && headline) headline.textContent = text;
        }
    }

    // =====================================================================
    // EXECUTIVE BRIEF
    // =====================================================================

    function renderBrief(markdown) {
        var body = el("brief-body");
        if (!body) return;

        if (!markdown || !markdown.trim()) {
            body.innerHTML = '<p class="empty-note">No brief has been published yet. '
                + "The pipeline writes one on each scheduled run.</p>";
            return;
        }

        // Demoted one level: the page already has an <h1> (the hero) and an
        // <h2> (the section title) above this content.
        body.innerHTML = MD.parseMarkdown(markdown, { headingOffset: 1 });
        buildToc(body);
        if (global.lucide) global.lucide.createIcons();
    }

    /** Table of contents from the rendered headings, with deep links. */
    function buildToc(body) {
        var list = el("brief-toc-list");
        if (!list) return;
        var headings = body.querySelectorAll("h3[id], h4[id]");
        if (!headings.length) {
            list.innerHTML = '<li class="toc-empty">No sections</li>';
            return;
        }
        var html = "";
        for (var i = 0; i < headings.length; i++) {
            var h = headings[i];
            html += '<li class="toc-' + h.tagName.toLowerCase() + '">'
                + '<a href="#' + esc(h.id) + '">' + esc(h.textContent) + "</a></li>";
        }
        list.innerHTML = html;

        list.querySelectorAll("a").forEach(function (link) {
            link.addEventListener("click", function (e) {
                var target = doc.getElementById(link.getAttribute("href").slice(1));
                if (!target) return;
                e.preventDefault();
                if (Motion) Motion.scrollToEl(target, 90);
                // Update the address bar so the section is shareable.
                if (global.history && global.history.replaceState) {
                    global.history.replaceState(null, "", link.getAttribute("href"));
                }
                target.classList.add("section-flash");
                setTimeout(function () { target.classList.remove("section-flash"); }, 1200);
            });
        });

        // Scrollspy: mark the section currently in view.
        if (typeof global.IntersectionObserver === "function") {
            var observer = new global.IntersectionObserver(function (entries) {
                entries.forEach(function (entry) {
                    if (!entry.isIntersecting) return;
                    list.querySelectorAll("a").forEach(function (a) {
                        a.classList.toggle("is-current", a.getAttribute("href") === "#" + entry.target.id);
                    });
                });
            }, { rootMargin: "-15% 0px -70% 0px" });
            for (var j = 0; j < headings.length; j++) observer.observe(headings[j]);
        }
    }

    // =====================================================================
    // PSC REGISTER
    // =====================================================================

    function renderBandScale() {
        var host = el("band-scale");
        if (!host || !state.summary) return;

        var counts = {};
        state.summary.annotated.forEach(function (item) {
            var id = item.band ? item.band.id : "UNDISCLOSED";
            counts[id] = (counts[id] || 0) + 1;
        });

        var html = '<div class="band-scale-head">'
            + "<h3>Disclosure bands</h3>"
            + '<p>Nigeria discloses significant control from <strong>5%</strong> under CAMA 2020 s.868. '
            + "The UK PSC register and the FATF standard start at 25%, so the 5&ndash;25% band is "
            + "reportable here and invisible to tools built for those regimes.</p></div>"
            + '<ul class="band-list">';

        PSC.BANDS.forEach(function (band) {
            var n = counts[band.id] || 0;
            html += '<li class="band band-' + band.tone + (n ? "" : " band-empty") + '">'
                + '<span class="band-bar" aria-hidden="true"></span>'
                + '<span class="band-label">' + esc(band.label) + "</span>"
                + '<span class="band-count">' + n + "</span>"
                + (band.id === "BAND_5_25" ? '<span class="band-tag">Nigeria only</span>' : "")
                + "</li>";
        });
        html += "</ul>";
        host.innerHTML = html;
    }

    function renderRegisterKpis() {
        var host = el("register-kpis");
        var s = state.summary;
        if (!host || !s) return;

        var mean = s.meanStake === null ? "Not disclosed" : s.meanStake.toFixed(1) + "%";
        var items = [
            { v: s.total, l: "Control records" },
            { v: mean, l: "Mean disclosed stake" },
            { v: s.indirectCount, l: "Held via a vehicle" },
            { v: s.flaggedCount, l: "With a red flag", tone: s.flaggedCount ? "danger" : "ok" }
        ];
        host.innerHTML = items.map(function (i) {
            return '<div class="kpi ' + (i.tone ? "kpi-" + i.tone : "") + '">'
                + '<span class="kpi-value">' + esc(i.v) + "</span>"
                + '<span class="kpi-label">' + esc(i.l) + "</span></div>";
        }).join("");
    }

    var FILTERS = [
        { id: "all", label: "All records" },
        { id: "flagged", label: "Red flags" },
        { id: "nigeria", label: "5–25% band" },
        { id: "indirect", label: "Via a vehicle" },
        { id: "pep", label: "Politically exposed" }
    ];

    function renderFilters() {
        var host = el("register-filters");
        if (!host) return;
        host.innerHTML = FILTERS.map(function (f) {
            return '<button type="button" class="psc-chip' + (state.filter === f.id ? " active" : "")
                + '" data-filter="' + f.id + '" aria-pressed="' + (state.filter === f.id) + '">'
                + esc(f.label) + "</button>";
        }).join("");
        host.querySelectorAll("[data-filter]").forEach(function (btn) {
            btn.addEventListener("click", function () {
                state.filter = btn.getAttribute("data-filter");
                renderFilters();
                renderRegisterList();
            });
        });
    }

    function matchesFilter(item) {
        switch (state.filter) {
            case "flagged": return item.flags.length > 0;
            case "nigeria": return item.band && item.band.id === "BAND_5_25";
            case "indirect": return !PSC.isDirectHolding(item.record["Intermediate Entities"]);
            case "pep": return String(item.record["PEP Status"] || "").toLowerCase().indexOf("yes") === 0;
            default: return true;
        }
    }

    function matchesQuery(item) {
        if (!state.query) return true;
        var r = item.record;
        var hay = [r["Person Name"], r.Company, r["Intermediate Entities"], r["Nature of Control"],
            r["Board Role"], r["Regulatory Filing Ref"]].join(" ").toLowerCase();
        return hay.indexOf(state.query) !== -1;
    }

    function renderRegisterList() {
        var host = el("register-list");
        if (!host || !state.summary) return;

        var items = state.summary.annotated.filter(function (i) {
            return matchesFilter(i) && matchesQuery(i);
        });

        if (!items.length) {
            host.innerHTML = '<p class="empty-note">No control records match this filter.</p>';
            return;
        }

        // Worst first: a compliance reader wants the exceptions, not an
        // alphabetical list.
        items = items.slice().sort(function (a, b) {
            var ha = a.flags.filter(function (f) { return f.severity === "high"; }).length;
            var hb = b.flags.filter(function (f) { return f.severity === "high"; }).length;
            if (ha !== hb) return hb - ha;
            return b.flags.length - a.flags.length;
        });

        host.innerHTML = items.map(function (item, idx) {
            return renderRegisterCard(item, idx);
        }).join("");

        host.querySelectorAll("[data-dossier]").forEach(function (btn) {
            btn.addEventListener("click", function () {
                var name = btn.getAttribute("data-dossier");
                if (global.openPSCDossier) {
                    var pscModal = el("psc-modal");
                    if (pscModal) pscModal.classList.add("active");
                    global.openPSCDossier(name);
                }
            });
        });

        if (global.lucide) global.lucide.createIcons();
    }

    function renderRegisterCard(item, idx) {
        var r = item.record;
        var band = item.band;
        var chain = PSC.controlChain(r);
        var seeded = String(r.Source || "").toLowerCase() === "seed";

        var chainHtml = chain.map(function (step, i) {
            return (i ? '<span class="chain-arrow" aria-hidden="true"></span>' : "")
                + '<span class="chain-node chain-' + step.kind + '">'
                + '<span class="chain-title">' + esc(step.title) + "</span>"
                + '<span class="chain-sub">' + esc(step.subtitle) + "</span></span>";
        }).join("");

        var flagsHtml = item.flags.length
            ? '<ul class="flag-list">' + item.flags.map(function (f) {
                return '<li class="flag flag-' + f.severity + '">'
                    + '<span class="flag-title">' + esc(f.title) + "</span>"
                    + '<span class="flag-detail">' + esc(f.detail) + "</span></li>";
            }).join("") + "</ul>"
            : '<p class="flag-clean"><i data-lucide="check"></i> No concealment pattern matched</p>';

        var pct = PSC.toPercent(r.Percentage);
        var stake = pct === null ? "Not disclosed" : pct.toFixed(1) + "%";
        var filing = String(r["Regulatory Filing Ref"] || "").trim();

        return '<article class="register-card' + (item.flags.length ? " has-flags" : "") + '"'
            + ' style="--stagger:' + Math.min(idx, 10) + '" data-reveal>'
            + '<header class="rc-head">'
            + "<div>"
            + '<h3 class="rc-name">' + esc(r["Person Name"] || "Undisclosed holder") + "</h3>"
            + '<p class="rc-role">' + esc(r["Board Role"] || "Significant shareholder") + " · "
            + esc(r.Company || "Undisclosed company") + "</p>"
            + "</div>"
            + '<div class="rc-stake">'
            + '<span class="rc-pct">' + esc(stake) + "</span>"
            + (band ? '<span class="rc-band band-' + band.tone + '">' + esc(band.label) + "</span>" : "")
            + "</div></header>"
            + (seeded ? '<p class="rc-seed">Illustrative record</p>' : "")
            + '<div class="rc-chain">' + chainHtml + "</div>"
            + '<p class="rc-nature">' + esc(r["Nature of Control"] || "Nature of control not disclosed") + "</p>"
            + flagsHtml
            + '<footer class="rc-foot">'
            + '<span class="rc-filing">' + (filing
                ? '<i data-lucide="file-check"></i> ' + esc(filing)
                : '<span class="muted">No filing reference disclosed</span>') + "</span>"
            + '<button type="button" class="btn btn-secondary btn-sm" data-dossier="'
            + esc(r["Person Name"] || "") + '"><i data-lucide="eye"></i> Dossier</button>'
            + "</footer></article>";
    }

    // =====================================================================
    // LOAD
    // =====================================================================

    function loadRegister() {
        return fetch(DATA + "/significant_control.json")
            .then(function (res) { return res.ok ? res.json() : []; })
            .catch(function () { return []; })
            .then(function (records) {
                state.records = Array.isArray(records) ? records : [];
                state.summary = PSC.summarise(state.records);

                var banner = el("register-demo-banner");
                if (banner) banner.hidden = !state.summary.isDemo;

                renderRegisterKpis();
                renderBandScale();
                renderFilters();
                renderRegisterList();
            });
    }

    function loadBrief() {
        return fetch(DATA + "/report_latest.md")
            .then(function (res) { return res.ok ? res.text() : ""; })
            .catch(function () { return ""; })
            .then(function (markdown) {
                renderBrief(markdown);
                renderHero(markdown);
                return markdown;
            });
    }

    function loadArchive() {
        var select = el("brief-archive-select");
        if (!select) return Promise.resolve();
        return fetch(DATA + "/reports.json")
            .then(function (res) { return res.ok ? res.json() : []; })
            .catch(function () { return []; })
            .then(function (rows) {
                state.reports = Array.isArray(rows) ? rows : [];
                var options = ['<option value="latest">Latest</option>'];
                state.reports
                    .slice()
                    .sort(function (a, b) { return String(b.Generated || "").localeCompare(String(a.Generated || "")); })
                    .forEach(function (r) {
                        // Only offer editions whose text we actually hold.
                        // Offering the rest and then silently rendering today's
                        // brief instead is worse than not offering them.
                        if (!String(r.Content || "").trim()) return;
                        var label = r.Generated || r.Date || "Edition";
                        options.push('<option value="' + esc(label) + '">' + esc(label) + "</option>");
                    });
                select.innerHTML = options.join("");

                select.addEventListener("change", function () {
                    if (select.value === "latest") { loadBrief(); return; }
                    var match = state.reports.filter(function (r) {
                        return String(r.Generated) === select.value;
                    })[0];
                    renderBrief(match ? match.Content : "");
                });
            });
    }

    function wireControls() {
        var copy = el("brief-copy-btn");
        if (copy) {
            copy.addEventListener("click", function () {
                var body = el("brief-body");
                if (!body) return;
                global.navigator.clipboard.writeText(body.innerText).then(function () {
                    var original = copy.innerHTML;
                    copy.innerHTML = '<i data-lucide="check"></i> Copied';
                    if (global.lucide) global.lucide.createIcons();
                    setTimeout(function () {
                        copy.innerHTML = original;
                        if (global.lucide) global.lucide.createIcons();
                    }, 1800);
                });
            });
        }

        var print = el("brief-print-btn");
        if (print) print.addEventListener("click", function () { global.print(); });

        var search = el("register-search");
        if (search) {
            var debounce = null;
            search.addEventListener("input", function () {
                clearTimeout(debounce);
                debounce = setTimeout(function () {
                    state.query = search.value.trim().toLowerCase();
                    renderRegisterList();
                }, 180);
            });
        }

        var csv = el("register-csv-btn");
        if (csv) csv.addEventListener("click", exportRegisterCsv);
    }

    /**
     * CSV export.
     *
     * Uses a Blob, not a data: URI. encodeURI leaves "#" intact, so any record
     * containing one truncated the download at that point. Fields starting
     * with =, +, - or @ are prefixed so a spreadsheet does not execute them.
     */
    function exportRegisterCsv() {
        if (!state.records.length) return;

        var headers = ["Person Name", "Company", "Nature of Control", "Percentage", "Share Band",
            "Direct %", "Indirect %", "Voting Rights %", "Intermediate Entities", "Board Role",
            "PEP Status", "Regulatory Filing Ref", "Date", "Source", "Red Flags"];

        function field(value) {
            var s = String(value == null ? "" : value);
            if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
            return '"' + s.replace(/"/g, '""') + '"';
        }

        var ctx = PSC.buildContext(state.records);
        var rows = state.records.map(function (r) {
            var flags = PSC.redFlagsFor(r, ctx).map(function (f) { return f.title; }).join("; ");
            return headers.map(function (h) {
                return field(h === "Red Flags" ? flags : r[h]);
            }).join(",");
        });

        var note = state.summary && state.summary.isDemo
            ? '"NOT FOR COMPLIANCE USE - contains illustrative seed records"\r\n'
            : "";
        var csv = "﻿" + note + headers.map(field).join(",") + "\r\n" + rows.join("\r\n");

        var blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
        var url = URL.createObjectURL(blob);
        var link = doc.createElement("a");
        link.href = url;
        link.download = (state.summary && state.summary.isDemo ? "DEMO_" : "")
            + "aura_psc_register_" + new Date().toISOString().slice(0, 10) + ".csv";
        doc.body.appendChild(link);
        link.click();
        doc.body.removeChild(link);
        URL.revokeObjectURL(url);
    }

    function init() {
        if (!PSC || !MD) {
            console.error("psc-report.js: required modules missing");
            return;
        }
        bootVisuals();
        wireControls();
        loadRegister()
            .then(loadBrief)
            .then(loadArchive)
            .then(function () {
                // Newly injected cards need observing too.
                if (Motion) Motion.initReveals(el("register-list"));
            })
            .catch(function (err) { console.error("psc-report.js init failed:", err); });
    }

    if (doc.readyState === "loading") {
        doc.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }

    global.AuraReport = { state: state, reload: loadRegister };
})(window);
