/**
 * AURA global search (Ctrl+K palette).
 *
 * Pure compute half (index building, scoring, grouping) + a guarded DOM
 * shell for the palette overlay. Hand-rolled fuzzy match per the Tier 1
 * plan: exact-prefix > whole-word > substring > subsequence, the same
 * complexity class as the feed's existing conceptScore -- no dependency.
 *
 * Index sources are the datasets the dashboard already ships; nothing new
 * is fetched beyond the five static JSON files, loaded lazily on first
 * open (~2,000 candidate records today).
 */
(function (global) {
    "use strict";

    var EK = global.AuraEntityKey;

    function esc(value) {
        return String(value == null ? "" : value)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }

    var GROUP_ORDER = ["company", "person", "psc", "article", "procurement"];
    var GROUP_LABELS = {
        company: "Companies",
        person: "People",
        psc: "PSC Disclosures",
        article: "Articles",
        procurement: "Procurement"
    };

    function slugOf(name) {
        return EK && typeof EK.slugify === "function" ? EK.slugify(name) : "";
    }

    /**
     * Flatten the five datasets into searchable entries.
     * Each entry: { type, label, sub, text (lowercased haystack), nav }.
     * nav is { hash } for router destinations, { href } for external URLs.
     */
    function buildIndex(datasets) {
        datasets = datasets || {};
        var entries = [];

        (datasets.companies || []).forEach(function (row) {
            var name = String(row.Company || "").trim();
            if (!name) return;
            entries.push({
                type: "company",
                label: name,
                sub: [row.Industry, row["Risk Level"] ? "Risk: " + row["Risk Level"] : ""]
                    .filter(Boolean).join(" · "),
                text: name.toLowerCase(),
                nav: { hash: "#/company/" + slugOf(name) }
            });
        });

        (datasets.people || []).forEach(function (row) {
            var name = String(row.Name || "").trim();
            if (!name) return;
            entries.push({
                type: "person",
                label: name,
                sub: [row.Position, row.Organization].filter(Boolean).join(" · "),
                text: (name + " " + (row.Organization || "")).toLowerCase(),
                nav: { hash: "#/person/" + slugOf(name) }
            });
        });

        (datasets.psc || []).forEach(function (row) {
            var person = String(row["Person Name"] || "").trim();
            var company = String(row.Company || "").trim();
            if (!person && !company) return;
            entries.push({
                type: "psc",
                label: person || company,
                sub: (person && company ? "PSC of " + company : "PSC record")
                    + (row.Percentage ? " · " + row.Percentage : ""),
                text: (person + " " + company + " " + (row["Intermediate Entities"] || "")).toLowerCase(),
                nav: { hash: person ? "#/person/" + slugOf(person) : "#/company/" + slugOf(company) }
            });
        });

        (datasets.articles || []).forEach(function (row) {
            var title = String(row.Title || row.title || "").trim();
            if (!title) return;
            var url = String(row.URL || row.url || "");
            entries.push({
                type: "article",
                label: title,
                sub: [row.Source || row.source, row.Category].filter(Boolean).join(" · "),
                text: (title + " " + (row.Summary || "")).toLowerCase(),
                // Articles have no dossier; the entry opens the source.
                nav: /^https?:\/\//.test(url) ? { href: url } : { hash: "#/feed" }
            });
        });

        (datasets.procurement || []).forEach(function (row) {
            var contractor = String(row.Contractor || "").trim();
            var agency = String(row.Agency || "").trim();
            if (!contractor && !agency) return;
            entries.push({
                type: "procurement",
                label: (contractor || "Contract") + (agency ? " ← " + agency : ""),
                sub: [row.Project, row.Amount].filter(Boolean).join(" · "),
                text: (contractor + " " + agency + " " + (row.Project || "")).toLowerCase(),
                nav: contractor ? { hash: "#/company/" + slugOf(contractor) }
                               : { hash: "#/agency/" + slugOf(agency) }
            });
        });

        return entries;
    }

    /** Score one haystack against one lowercased query token. 0 = no match. */
    function scoreToken(text, token) {
        if (!token) return 0;
        var idx = text.indexOf(token);
        if (idx === 0) return 100;                       // exact prefix
        if (idx > 0) {
            var before = text.charAt(idx - 1);
            if (!/[a-z0-9]/.test(before)) return 60;     // whole-word start
            return 40;                                    // plain substring
        }
        // Subsequence: every char of the token appears in order.
        var pos = -1;
        for (var i = 0; i < token.length; i++) {
            pos = text.indexOf(token.charAt(i), pos + 1);
            if (pos === -1) return 0;
        }
        return 20;
    }

    /**
     * Rank entries against a query. Multi-word queries AND their tokens;
     * the entry's score is the sum, so every token must match somewhere.
     */
    function searchIndex(entries, query) {
        var tokens = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
        if (!tokens.length) return [];
        var out = [];
        for (var i = 0; i < (entries || []).length; i++) {
            var entry = entries[i];
            var total = 0;
            var ok = true;
            for (var t = 0; t < tokens.length; t++) {
                var s = scoreToken(entry.text, tokens[t]);
                if (!s) { ok = false; break; }
                total += s;
            }
            if (ok) out.push({ entry: entry, score: total });
        }
        out.sort(function (a, b) {
            return b.score - a.score || (a.entry.label < b.entry.label ? -1 : 1);
        });
        return out;
    }

    /** Group ranked results by type, capped per group, in a fixed order. */
    function groupResults(ranked, perGroup) {
        perGroup = perGroup || 5;
        var byType = {};
        (ranked || []).forEach(function (r) {
            (byType[r.entry.type] = byType[r.entry.type] || []).push(r);
        });
        var groups = [];
        GROUP_ORDER.forEach(function (type) {
            var items = byType[type] || [];
            if (!items.length) return;
            groups.push({
                type: type,
                label: GROUP_LABELS[type] || type,
                total: items.length,
                items: items.slice(0, perGroup).map(function (r) { return r.entry; })
            });
        });
        return groups;
    }

    /** Palette results HTML; escaped, each row carries a data-nav payload. */
    function renderResultsHTML(groups) {
        if (!groups || !groups.length) {
            return '<p class="palette-empty">No matches.</p>';
        }
        var flatIndex = 0;
        return groups.map(function (group) {
            var rows = group.items.map(function (entry) {
                var nav = entry.nav || {};
                var attrs = nav.href
                    ? 'data-href="' + esc(nav.href) + '"'
                    : 'data-hash="' + esc(nav.hash || "") + '"';
                var row = '<li class="palette-item" role="option" data-index="' + flatIndex + '" ' + attrs + '>'
                    + '<span class="palette-label">' + esc(entry.label) + "</span>"
                    + (entry.sub ? '<span class="palette-sub">' + esc(entry.sub) + "</span>" : "")
                    + "</li>";
                flatIndex++;
                return row;
            }).join("");
            var overflow = group.total > group.items.length
                ? '<li class="palette-more">+' + (group.total - group.items.length) + " more</li>" : "";
            return '<li class="palette-group"><h3>' + esc(group.label) + "</h3><ul>"
                + rows + overflow + "</ul></li>";
        }).join("");
    }

    // =====================================================================
    // DOM shell -- no-ops headless.
    // =====================================================================

    function bind() {
        var doc = global.document;
        if (!doc || typeof doc.querySelector !== "function") return;

        var palette = doc.getElementById("search-palette");
        var input = doc.getElementById("search-palette-input");
        var results = doc.getElementById("search-palette-results");
        var openBtn = doc.getElementById("search-open-btn");
        if (!palette || !input || !results) return;

        var devHost = global.location.hostname === "localhost"
            || global.location.hostname.indexOf("127.") === 0;
        var DATA = (devHost && global.location.search.indexOf("static=1") === -1)
            ? "/api/v1" : "data";

        var index = null;
        var indexPromise = null;
        var selected = 0;
        var lastFocus = null;

        function loadIndex() {
            if (indexPromise) return indexPromise;
            function grab(name) {
                return global.fetch(DATA + "/" + name)
                    .then(function (res) { return res.ok ? res.json() : []; })
                    .catch(function () { return []; });
            }
            indexPromise = Promise.all([
                grab("latest.json"), grab("companies.json"), grab("people.json"),
                grab("significant_control.json"), grab("procurement.json")
            ]).then(function (r) {
                index = buildIndex({
                    articles: r[0], companies: r[1], people: r[2],
                    psc: r[3], procurement: r[4]
                });
                return index;
            });
            return indexPromise;
        }

        function items() {
            return results.querySelectorAll(".palette-item");
        }

        function highlight(next) {
            var list = items();
            if (!list.length) return;
            selected = Math.max(0, Math.min(next, list.length - 1));
            for (var i = 0; i < list.length; i++) {
                list[i].classList.toggle("is-selected", i === selected);
            }
            if (typeof list[selected].scrollIntoView === "function") {
                list[selected].scrollIntoView({ block: "nearest" });
            }
        }

        function activate(el) {
            if (!el) return;
            var href = el.getAttribute("data-href");
            var hash = el.getAttribute("data-hash");
            close();
            if (href) {
                global.open(href, "_blank", "noopener");
            } else if (hash) {
                global.location.hash = hash;
            }
        }

        function renderQuery() {
            var q = input.value.trim();
            if (!q) {
                results.innerHTML = '<p class="palette-empty">Type to search companies, people, PSC records, articles…</p>';
                return;
            }
            var groups = groupResults(searchIndex(index || [], q), 5);
            results.innerHTML = renderResultsHTML(groups);
            selected = 0;
            highlight(0);
        }

        function open() {
            lastFocus = doc.activeElement;
            palette.hidden = false;
            input.value = "";
            renderQuery();
            input.focus();
            loadIndex().then(function () { if (!palette.hidden) renderQuery(); });
        }

        function close() {
            palette.hidden = true;
            if (lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
        }

        doc.addEventListener("keydown", function (e) {
            if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) {
                e.preventDefault();
                if (palette.hidden) open(); else close();
                return;
            }
            if (palette.hidden) return;
            if (e.key === "Escape") { e.preventDefault(); close(); }
            else if (e.key === "ArrowDown") { e.preventDefault(); highlight(selected + 1); }
            else if (e.key === "ArrowUp") { e.preventDefault(); highlight(selected - 1); }
            else if (e.key === "Enter") { e.preventDefault(); activate(items()[selected]); }
        });

        input.addEventListener("input", renderQuery);
        results.addEventListener("click", function (e) {
            var el = e.target;
            while (el && el !== results && !el.classList.contains("palette-item")) {
                el = el.parentElement;
            }
            if (el && el !== results) activate(el);
        });
        palette.addEventListener("click", function (e) {
            if (e.target === palette) close(); // backdrop click
        });
        if (openBtn) openBtn.addEventListener("click", open);
    }

    global.AuraSearch = {
        buildIndex: buildIndex,
        scoreToken: scoreToken,
        searchIndex: searchIndex,
        groupResults: groupResults,
        renderResultsHTML: renderResultsHTML
    };

    if (global.document && typeof global.document.addEventListener === "function") {
        if (global.document.readyState === "loading") {
            global.document.addEventListener("DOMContentLoaded", bind);
        } else {
            bind();
        }
    }
})(window);
