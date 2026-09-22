/**
 * AuraTheme: light/dark theme switching over the token system.
 *
 * Loaded synchronously in <head>, before the stylesheets are applied to
 * a painted frame, so a returning light-theme reader never sees a dark
 * flash: data-theme lands on <html> before first paint. (An inline
 * script would be the classic way, but the CSP has no 'unsafe-inline'
 * for scripts — deliberately — so this is a tiny external file instead.)
 *
 * Default: the OS preference on first visit, dark when it is unstated;
 * the toggle persists an explicit choice in localStorage. Storage reads
 * and writes are guarded — private windows and blocked site data must
 * degrade to "works, just does not remember".
 */
(function (global) {
    "use strict";

    var KEY = "aura:theme";

    /** Pure: stored choice wins; otherwise the OS preference; else dark. */
    function resolveTheme(stored, prefersLight) {
        if (stored === "light" || stored === "dark") return stored;
        return prefersLight ? "light" : "dark";
    }

    function readStored() {
        try {
            return global.localStorage ? global.localStorage.getItem(KEY) : null;
        } catch (e) { return null; }
    }

    function persist(theme) {
        try {
            if (global.localStorage) global.localStorage.setItem(KEY, theme);
        } catch (e) { /* remembering is best-effort */ }
    }

    function prefersLight() {
        try {
            return !!(global.matchMedia
                && global.matchMedia("(prefers-color-scheme: light)").matches);
        } catch (e) { return false; }
    }

    function current() {
        var doc = global.document;
        var el = doc && doc.documentElement;
        return (el && el.getAttribute("data-theme")) === "light" ? "light" : "dark";
    }

    function apply(theme) {
        var doc = global.document;
        if (!doc || !doc.documentElement) return;
        doc.documentElement.setAttribute("data-theme", theme);
    }

    function updateButton(btn, theme) {
        // The button shows the theme a click switches TO.
        var next = theme === "dark" ? "light" : "dark";
        btn.setAttribute("aria-pressed", theme === "light" ? "true" : "false");
        btn.setAttribute("title", "Switch to " + next + " theme");
        btn.setAttribute("aria-label", "Switch to " + next + " theme");
        while (btn.firstChild) btn.removeChild(btn.firstChild);
        var i = global.document.createElement("i");
        i.setAttribute("data-lucide", theme === "dark" ? "sun" : "moon");
        btn.appendChild(i);
        if (global.lucide) global.lucide.createIcons();
    }

    function bind() {
        var doc = global.document;
        if (!doc || typeof doc.getElementById !== "function") return;
        var btn = doc.getElementById("theme-toggle");
        if (!btn) return;
        updateButton(btn, current());
        btn.addEventListener("click", function () {
            var next = current() === "dark" ? "light" : "dark";
            apply(next);
            persist(next);
            updateButton(btn, next);
        });
    }

    // Pre-paint application (head execution: documentElement exists,
    // body does not).
    apply(resolveTheme(readStored(), prefersLight()));

    var doc = global.document;
    if (doc && typeof doc.addEventListener === "function") {
        if (doc.readyState === "loading") {
            doc.addEventListener("DOMContentLoaded", bind);
        } else {
            bind();
        }
    }

    global.AuraTheme = { resolveTheme: resolveTheme, KEY: KEY };
})(window);
