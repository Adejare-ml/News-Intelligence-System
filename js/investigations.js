/**
 * Investigations workspace: #/investigations (round 5, Package 25).
 *
 * Fills the one registered route that dead-ended since the router
 * shipped. A case file is a named set of watched entities plus
 * per-entity notes, exportable as Markdown -- the passive watchlist
 * turned into a working surface.
 *
 * State lives under its OWN localStorage key (aura:investigations:v1),
 * not inside aura:local:v1: AuraLocalStore.normalizeState() strips any
 * top-level key it does not know on every load/save round trip, and
 * that guarantee should stay intact. Every surface here repeats the
 * "saved only in this browser" honesty rule.
 */
(function (global) {
    "use strict";

    var STORE_KEY = "aura:investigations:v1";

    function esc(value) {
        return String(value == null ? "" : value)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }

    // ------------------------------------------------------------------
    // Pure state layer (versioned doc, same discipline as local-store.js)
    // ------------------------------------------------------------------

    function emptyState() {
        return { version: 1, cases: [] };
    }

    /** Unknown shapes and hostile values normalise away, never throw. */
    function normalizeState(raw) {
        if (!raw || typeof raw !== "object" || raw.version !== 1) return emptyState();
        var cases = Array.isArray(raw.cases) ? raw.cases : [];
        return {
            version: 1,
            cases: cases.filter(function (c) {
                return c && typeof c.id === "string" && c.id
                    && typeof c.name === "string" && c.name;
            }).map(function (c) {
                var entities = Array.isArray(c.entities) ? c.entities : [];
                var notes = (c.notes && typeof c.notes === "object") ? c.notes : {};
                var cleanNotes = {};
                entities = entities.filter(function (e) {
                    return e && typeof e.type === "string" && e.type
                        && typeof e.slug === "string" && e.slug;
                }).map(function (e) {
                    return { type: e.type, slug: e.slug, label: String(e.label || e.slug) };
                });
                entities.forEach(function (e) {
                    var key = e.type + "/" + e.slug;
                    if (typeof notes[key] === "string" && notes[key]) cleanNotes[key] = notes[key];
                });
                return {
                    id: c.id,
                    name: String(c.name).slice(0, 120),
                    created: String(c.created || ""),
                    entities: entities,
                    notes: cleanNotes
                };
            })
        };
    }

    function newCaseId() {
        return "case-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
    }

    /** All mutations are non-mutating state -> state, like local-store. */
    function createCase(state, name, id, created) {
        var s = normalizeState(state);
        var label = String(name || "").trim();
        if (!label) return s;
        s.cases = s.cases.concat([{
            id: id || newCaseId(),
            name: label.slice(0, 120),
            created: created || new Date().toISOString().slice(0, 10),
            entities: [],
            notes: {}
        }]);
        return s;
    }

    function deleteCase(state, caseId) {
        var s = normalizeState(state);
        s.cases = s.cases.filter(function (c) { return c.id !== caseId; });
        return s;
    }

    function findCase(state, caseId) {
        for (var i = 0; i < state.cases.length; i++) {
            if (state.cases[i].id === caseId) return state.cases[i];
        }
        return null;
    }

    function updateCase(state, caseId, fn) {
        var s = normalizeState(state);
        s.cases = s.cases.map(function (c) {
            return c.id === caseId ? fn(c) : c;
        });
        return normalizeState(s);
    }

    function addEntity(state, caseId, entry) {
        if (!entry || !entry.type || !entry.slug) return normalizeState(state);
        return updateCase(state, caseId, function (c) {
            var key = entry.type + "/" + entry.slug;
            var exists = c.entities.some(function (e) { return e.type + "/" + e.slug === key; });
            if (exists) return c;
            var copy = JSON.parse(JSON.stringify(c));
            copy.entities.push({ type: entry.type, slug: entry.slug,
                                 label: String(entry.label || entry.slug) });
            return copy;
        });
    }

    function removeEntity(state, caseId, key) {
        return updateCase(state, caseId, function (c) {
            var copy = JSON.parse(JSON.stringify(c));
            copy.entities = copy.entities.filter(function (e) {
                return e.type + "/" + e.slug !== key;
            });
            delete copy.notes[key];
            return copy;
        });
    }

    function setNote(state, caseId, key, text) {
        return updateCase(state, caseId, function (c) {
            var copy = JSON.parse(JSON.stringify(c));
            var value = String(text || "").slice(0, 4000);
            if (value) copy.notes[key] = value;
            else delete copy.notes[key];
            return copy;
        });
    }

    /** One case file as Markdown, notes verbatim under each entity. */
    function caseMarkdown(caseObj, generatedOn) {
        if (!caseObj) return "";
        var lines = ["# Investigation: " + caseObj.name, "",
                     "_AURA case file · " + (generatedOn || new Date().toISOString().slice(0, 10))
                     + (caseObj.created ? " · opened " + caseObj.created : "") + "_", ""];
        if (!caseObj.entities.length) {
            lines.push("_No entities attached yet._");
        }
        caseObj.entities.forEach(function (e) {
            lines.push("## " + e.label + " (" + e.type + ")", "");
            var note = caseObj.notes[e.type + "/" + e.slug];
            lines.push(note ? note : "_No notes._", "");
        });
        lines.push("---", "_Notes are analyst commentary, saved only in the analyst's browser; "
            + "entity records come from AURA's published data._");
        return lines.join("\n");
    }

    // ------------------------------------------------------------------
    // Storage (guarded: private windows, blocked storage)
    // ------------------------------------------------------------------

    function loadState() {
        try {
            return normalizeState(JSON.parse(global.localStorage.getItem(STORE_KEY)));
        } catch (e) {
            return emptyState();
        }
    }

    function saveState(state) {
        try {
            global.localStorage.setItem(STORE_KEY, JSON.stringify(normalizeState(state)));
            return true;
        } catch (e) {
            return false;
        }
    }

    // ------------------------------------------------------------------
    // Rendering
    // ------------------------------------------------------------------

    function renderCaseHTML(caseObj) {
        var rows = caseObj.entities.map(function (e) {
            var key = e.type + "/" + e.slug;
            return '<li class="case-entity">'
                + '<div class="case-entity-head"><a href="#/' + esc(e.type) + "/" + esc(e.slug) + '">'
                + esc(e.label) + "</a>"
                + ' <span class="watchlist-kind">' + esc(e.type) + "</span>"
                + '<button type="button" class="watchlist-remove-btn" data-remove-entity="'
                + esc(key) + '" aria-label="Remove ' + esc(e.label) + ' from this case">✕</button></div>'
                + '<textarea class="case-note" data-note-key="' + esc(key)
                + '" rows="3" placeholder="Notes on ' + esc(e.label)
                + '…" aria-label="Notes on ' + esc(e.label) + '">'
                + esc(caseObj.notes[key] || "") + "</textarea>"
                + "</li>";
        }).join("");
        return '<section class="dossier-panel case-panel" data-case-id="' + esc(caseObj.id) + '">'
            + '<div class="case-head"><h2>' + esc(caseObj.name) + "</h2>"
            + '<span class="dossier-sub">opened ' + esc(caseObj.created || "—") + "</span>"
            + '<button type="button" class="btn btn-secondary btn-sm" data-add-watchlist="'
            + esc(caseObj.id) + '">+ Add my watchlist</button>'
            + '<button type="button" class="btn btn-secondary btn-sm" data-export-case="'
            + esc(caseObj.id) + '">⬇ Export</button>'
            + '<button type="button" class="btn btn-secondary btn-sm" data-delete-case="'
            + esc(caseObj.id) + '">Delete</button></div>'
            + (rows ? '<ul class="case-entities">' + rows + "</ul>"
                    : '<p class="empty-note">No entities yet. Star entities on their dossier pages, '
                      + 'then use "+ Add my watchlist" -- or open a dossier and watch it first.</p>')
            + "</section>";
    }

    function renderPageHTML(state) {
        var html = '<div class="dossier investigations-page"><header class="dossier-header">'
            + "<h1>Investigations</h1>"
            + '<p class="dossier-kind">CASE FILES</p>'
            + '<p class="dossier-sub">Cases and notes are saved only in this browser.</p>'
            + "</header>"
            + '<div class="case-create"><input type="text" id="case-name-input" maxlength="120" '
            + 'placeholder="New case name…" aria-label="New case name">'
            + '<button type="button" class="btn btn-secondary" id="case-create-btn">Open case</button></div>';
        if (!state.cases.length) {
            html += '<p class="empty-note">No case files yet. Open one above to start collecting '
                + "entities and notes.</p>";
        } else {
            html += state.cases.map(renderCaseHTML).join("");
        }
        html += '<p class="dossier-back"><a href="#/">← Back to the dashboard</a></p></div>';
        return html;
    }

    // ------------------------------------------------------------------
    // DOM shell
    // ------------------------------------------------------------------

    function bind() {
        var doc = global.document;
        var Router = global.AuraRouter;
        if (!doc || typeof doc.querySelector !== "function" || !Router) return;
        var outlet = doc.querySelector("[data-route-outlet]");
        if (!outlet) return;
        var main = doc.getElementById("main");

        function rerender() {
            outlet.innerHTML = renderPageHTML(loadState());
            wire();
        }

        function download(name, text) {
            try {
                var blob = new global.Blob([text], { type: "text/markdown;charset=utf-8" });
                var url = global.URL.createObjectURL(blob);
                var link = doc.createElement("a");
                link.href = url;
                link.download = name;
                doc.body.appendChild(link);
                link.click();
                link.remove();
                global.setTimeout(function () { global.URL.revokeObjectURL(url); }, 5000);
            } catch (e) { /* Blob unavailable */ }
        }

        function wire() {
            var createBtn = doc.getElementById("case-create-btn");
            var nameInput = doc.getElementById("case-name-input");
            if (createBtn && nameInput) {
                createBtn.addEventListener("click", function () {
                    if (!nameInput.value.trim()) return;
                    saveState(createCase(loadState(), nameInput.value));
                    rerender();
                });
                nameInput.addEventListener("keydown", function (ev) {
                    if (ev.key === "Enter") createBtn.click();
                });
            }
            outlet.querySelectorAll("[data-delete-case]").forEach(function (btn) {
                btn.addEventListener("click", function () {
                    var name = "this case";
                    var c = findCase(loadState(), btn.getAttribute("data-delete-case"));
                    if (c) name = '"' + c.name + '"';
                    if (!global.confirm || global.confirm("Delete " + name
                        + " and its notes? This cannot be undone.")) {
                        saveState(deleteCase(loadState(), btn.getAttribute("data-delete-case")));
                        rerender();
                    }
                });
            });
            outlet.querySelectorAll("[data-export-case]").forEach(function (btn) {
                btn.addEventListener("click", function () {
                    var c = findCase(loadState(), btn.getAttribute("data-export-case"));
                    if (c) download("aura-case-" + c.id + ".md", caseMarkdown(c));
                });
            });
            outlet.querySelectorAll("[data-add-watchlist]").forEach(function (btn) {
                btn.addEventListener("click", function () {
                    var LS = global.AuraLocalStore;
                    if (!LS) return;
                    var caseId = btn.getAttribute("data-add-watchlist");
                    var state = loadState();
                    LS.loadState().watchlist.forEach(function (entry) {
                        state = addEntity(state, caseId, entry);
                    });
                    saveState(state);
                    rerender();
                });
            });
            outlet.querySelectorAll("[data-remove-entity]").forEach(function (btn) {
                btn.addEventListener("click", function () {
                    var panel = btn.closest("[data-case-id]");
                    if (!panel) return;
                    saveState(removeEntity(loadState(), panel.getAttribute("data-case-id"),
                                           btn.getAttribute("data-remove-entity")));
                    rerender();
                });
            });
            outlet.querySelectorAll(".case-note").forEach(function (area) {
                area.addEventListener("change", function () {
                    var panel = area.closest("[data-case-id]");
                    if (!panel) return;
                    saveState(setNote(loadState(), panel.getAttribute("data-case-id"),
                                      area.getAttribute("data-note-key"), area.value));
                });
            });
        }

        Router.register("investigations", function () {
            outlet.hidden = false;
            if (main) main.setAttribute("data-route-page", "true");
            try { global.scrollTo(0, 0); } catch (e) { /* headless */ }
            rerender();
        });

        var hash = (global.location && global.location.hash) || "";
        var current = Router.matchRoute(hash);
        if (current && current.view === "investigations") Router.dispatch(hash);
    }

    global.AuraInvestigations = {
        STORE_KEY: STORE_KEY,
        emptyState: emptyState,
        normalizeState: normalizeState,
        createCase: createCase,
        deleteCase: deleteCase,
        findCase: findCase,
        addEntity: addEntity,
        removeEntity: removeEntity,
        setNote: setNote,
        caseMarkdown: caseMarkdown,
        renderCaseHTML: renderCaseHTML,
        renderPageHTML: renderPageHTML,
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
