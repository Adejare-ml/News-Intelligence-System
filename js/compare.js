/**
 * Entity comparison view: #/compare?a=company/slug&b=person/slug
 * (round 5, Package 25).
 *
 * "Are these two the same network?" is the core beneficial-ownership
 * question. The dossier models already exist -- this page renders two of
 * them side by side and names the counterparties they share. Pure halves
 * (parseRef, compareModel, sharedCounterparties, renderCompareHTML) run
 * headless; bind() registers the router view and owns the outlet while
 * the route is active.
 */
(function (global) {
    "use strict";

    function esc(value) {
        return String(value == null ? "" : value)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }

    var KINDS = { company: 1, person: 1, agency: 1 };

    /** "company/dangote-cement-plc" -> { type, slug } or null. */
    function parseRef(raw) {
        var text = String(raw || "").trim();
        var slash = text.indexOf("/");
        if (slash <= 0) return null;
        var type = text.slice(0, slash);
        var slug = text.slice(slash + 1);
        if (!KINDS[type] || !slug) return null;
        return { type: type, slug: slug };
    }

    function buildFor(ref, data) {
        var D = global.AuraDossier;
        if (!D || !ref) return null;
        var builder = { company: D.companyDossier, person: D.personDossier,
                        agency: D.agencyDossier }[ref.type];
        return builder ? builder(ref.slug, data) : null;
    }

    /** Names one dossier model touches, for the shared-counterparty join. */
    function counterparties(model) {
        var out = [];
        if (!model) return out;
        function push(name) {
            var text = String(name || "").trim();
            if (text) out.push(text);
        }
        (model.owners || []).forEach(function (o) { push(o.person); });
        (model.control || []).forEach(function (c) { push(c.company); });
        (model.appearances || []).forEach(function (p) { push(p.organization); });
        (model.procurement || []).forEach(function (p) { push(p.contractor); push(p.agency); });
        return out;
    }

    /** Counterparty names both models touch (excluding the subjects). */
    function sharedCounterparties(a, b) {
        var EK = global.AuraEntityKey;
        if (!EK || !a || !b) return [];
        var own = {};
        [a, b].forEach(function (m) { own[EK.slugify(m.name)] = true; });
        var seenA = {};
        counterparties(a).forEach(function (n) { seenA[EK.slugify(n)] = n; });
        var shared = [];
        var done = {};
        counterparties(b).forEach(function (n) {
            var key = EK.slugify(n);
            if (seenA[key] && !own[key] && !done[key]) {
                done[key] = true;
                shared.push(seenA[key]);
            }
        });
        shared.sort();
        return shared;
    }

    /** query {a, b} + data -> full compare model. */
    function compareModel(query, data) {
        var refA = parseRef((query || {}).a);
        var refB = parseRef((query || {}).b);
        var a = buildFor(refA, data);
        var b = buildFor(refB, data);
        return {
            refA: refA, refB: refB,
            a: a, b: b,
            shared: sharedCounterparties(a, b)
        };
    }

    function columnHTML(ref, model, which) {
        if (!ref) {
            return '<div class="compare-column compare-empty"><p class="empty-note">'
                + "Pick the " + (which === "a" ? "first" : "second")
                + " entity above.</p></div>";
        }
        if (!model) {
            return '<div class="compare-column compare-empty"><p class="empty-note">No records match '
                + esc(ref.type + "/" + ref.slug) + ".</p></div>";
        }
        var D = global.AuraDossier;
        function list(title, items, fmt) {
            if (!items || !items.length) return "";
            return "<h3>" + esc(title) + "</h3><ul>" + items.slice(0, 6).map(function (item) {
                return "<li>" + fmt(item) + "</li>";
            }).join("") + (items.length > 6
                ? '<li class="dossier-sub">…and ' + (items.length - 6) + " more</li>" : "") + "</ul>";
        }
        var html = '<div class="compare-column"><h2><a class="report-link" href="#/'
            + esc(ref.type) + "/" + esc(ref.slug) + '">' + esc(model.name) + "</a></h2>"
            + '<p class="dossier-kind">' + esc(model.kind.toUpperCase()) + "</p>";
        if (D && D.timelineHTML && D.dossierTimeline) {
            html += D.timelineHTML(D.dossierTimeline(model, 16));
        }
        html += list("Beneficial owners", model.owners, function (o) {
            return esc(o.person) + (o.percentage ? " — " + esc(o.percentage) : "");
        });
        html += list("Controls", model.control, function (c) {
            return esc(c.company) + (c.percentage ? " — " + esc(c.percentage) : "");
        });
        html += list("Recorded events", model.appearances, function (p) {
            return esc([p.event, p.position, p.organization, p.date].filter(Boolean).join(" · "));
        });
        html += list("Procurement", model.procurement, function (p) {
            return esc([p.project || "Contract", p.contractor, p.agency, p.amount]
                .filter(Boolean).join(" · "));
        });
        html += list("Article mentions", model.articles, function (a) {
            return a.url
                ? '<a class="report-link" rel="noopener noreferrer" target="_blank" href="'
                    + esc(a.url) + '">' + esc(a.title) + "</a>"
                : esc(a.title);
        });
        return html + "</div>";
    }

    /** Escaped HTML for the whole compare page (selects wired by bind). */
    function renderCompareHTML(model) {
        var html = '<div class="dossier compare-page"><header class="dossier-header">'
            + "<h1>Compare entities</h1>"
            + '<p class="dossier-kind">SIDE-BY-SIDE DOSSIERS</p></header>'
            + '<div class="compare-pickers">'
            + '<label>First <select id="compare-select-a" class="graph-path-select"></select></label>'
            + '<label>Second <select id="compare-select-b" class="graph-path-select"></select></label>'
            + "</div>";
        if (model.a && model.b) {
            html += '<section class="dossier-panel compare-shared"><h2>Shared counterparties</h2>'
                + (model.shared.length
                    ? "<ul>" + model.shared.map(function (n) {
                        return "<li>" + esc(n) + "</li>";
                    }).join("") + "</ul>"
                    : '<p class="empty-note">No shared counterparties in the published records — '
                      + "these two do not visibly touch.</p>")
                + "</section>";
        }
        html += '<div class="compare-grid">'
            + columnHTML(model.refA, model.a, "a")
            + columnHTML(model.refB, model.b, "b")
            + "</div>"
            + '<p class="dossier-back"><a href="#/">← Back to the dashboard</a></p></div>';
        return html;
    }

    /**
     * Options for the pickers: watchlist entries first, then companies by
     * mentions, agencies and people -- capped so two selects stay light.
     */
    function pickerOptions(data, watchlist) {
        var EK = global.AuraEntityKey;
        if (!EK) return [];
        var out = [];
        var seen = {};
        function add(type, name, label) {
            var slug = EK.slugify(name);
            if (!slug) return;
            var value = type + "/" + slug;
            if (seen[value]) return;
            seen[value] = true;
            out.push({ value: value, label: label || name });
        }
        (watchlist || []).forEach(function (e) {
            if (e && e.type && e.slug) {
                out.push({ value: e.type + "/" + e.slug, label: "★ " + (e.label || e.slug) });
                seen[e.type + "/" + e.slug] = true;
            }
        });
        var companies = (data.companies || []).slice().sort(function (x, y) {
            return (parseFloat(y["Mention Count"]) || 0) - (parseFloat(x["Mention Count"]) || 0);
        }).slice(0, 200);
        companies.forEach(function (c) { add("company", c.Company); });
        (data.agencies || []).slice(0, 100).forEach(function (a) { add("agency", a.Agency); });
        (data.people || []).slice(0, 150).forEach(function (p) { add("person", p.Name); });
        return out;
    }

    // ------------------------------------------------------------------
    // DOM shell
    // ------------------------------------------------------------------

    function bind() {
        var doc = global.document;
        var Router = global.AuraRouter;
        if (!doc || typeof doc.querySelector !== "function" || !Router || !global.AuraData) return;
        var outlet = doc.querySelector("[data-route-outlet]");
        if (!outlet) return;
        var main = doc.getElementById("main");

        var dataPromise = null;
        function loadData() {
            if (dataPromise) return dataPromise;
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

        var generation = 0;

        function wirePicker(id, key, query) {
            var select = doc.getElementById(id);
            if (!select) return;
            select.addEventListener("change", function () {
                var next = { a: query.a || "", b: query.b || "" };
                next[key] = select.value;
                var parts = [];
                if (next.a) parts.push("a=" + encodeURIComponent(next.a));
                if (next.b) parts.push("b=" + encodeURIComponent(next.b));
                Router.navigate("#/compare" + (parts.length ? "?" + parts.join("&") : ""));
            });
        }

        function fillPicker(id, options, current) {
            var select = doc.getElementById(id);
            if (!select) return;
            select.innerHTML = '<option value="">Choose…</option>' + options.map(function (o) {
                return '<option value="' + esc(o.value) + '">' + esc(o.label) + "</option>";
            }).join("");
            select.value = current || "";
        }

        Router.register("compare", function (params, query) {
            var mine = ++generation;
            outlet.innerHTML = '<div class="dossier"><p class="empty-note">Loading…</p></div>';
            outlet.hidden = false;
            if (main) main.setAttribute("data-route-page", "true");
            try { global.scrollTo(0, 0); } catch (e) { /* headless */ }
            loadData().then(function (data) {
                if (mine !== generation) return;
                var hash = (global.location && global.location.hash) || "";
                var m = Router.matchRoute(hash);
                if (!m || m.view !== "compare") return; // user moved on mid-load
                var model = compareModel(query, data);
                outlet.innerHTML = renderCompareHTML(model);
                var LS = global.AuraLocalStore;
                var watchlist = LS ? LS.loadState().watchlist : [];
                var options = pickerOptions(data, watchlist);
                fillPicker("compare-select-a", options, query.a);
                fillPicker("compare-select-b", options, query.b);
                wirePicker("compare-select-a", "a", query);
                wirePicker("compare-select-b", "b", query);
            }).catch(function () {
                if (mine !== generation) return;
                outlet.innerHTML = '<div class="dossier"><p class="empty-note">'
                    + 'The comparison data could not be loaded. <a href="#/">Back</a></p></div>';
            });
        });

        // Deep link into #/compare on a fresh tab: dispatched before this
        // handler existed.
        var hash = (global.location && global.location.hash) || "";
        var current = Router.matchRoute(hash);
        if (current && current.view === "compare") Router.dispatch(hash);
    }

    global.AuraCompare = {
        parseRef: parseRef,
        counterparties: counterparties,
        sharedCounterparties: sharedCounterparties,
        compareModel: compareModel,
        renderCompareHTML: renderCompareHTML,
        pickerOptions: pickerOptions,
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
