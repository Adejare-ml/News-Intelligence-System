/**
 * AuraIcons: the dashboard's icon set as inline SVG, replacing the lucide
 * CDN script. Only the icons the app actually uses ship (31 of lucide's
 * ~2000), extracted verbatim from lucide-static@1.28.0 -- the same release
 * the CDN tag pinned -- so every glyph renders identically.
 *
 * Why not the CDN: when it is unreachable (captive portals, proxies,
 * outages) every icon button rendered as an empty square with no fallback.
 * A local 4KB file cannot fail separately from the page, and dropping the
 * dependency lets the CSP tighten script-src to 'self'.
 *
 * window.lucide compatibility: app.js calls window.lucide.createIcons()
 * after every DOM injection. This module provides that exact surface, so
 * no call site changes.
 */
(function (global) {
    "use strict";

    var PATHS = {
        "braces": "<path d=\"M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1\" /> <path d=\"M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1\" />",
        "briefcase": "<path d=\"M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16\" /> <rect width=\"20\" height=\"14\" x=\"2\" y=\"6\" rx=\"2\" />",
        "calendar": "<path d=\"M8 2v3\" /> <path d=\"M16 2v3\" /> <rect x=\"3\" y=\"3\" width=\"18\" height=\"18\" rx=\"2\" /> <path d=\"M3 9h18\" />",
        "check": "<path d=\"M20 6 9 17l-5-5\" />",
        "clock": "<circle cx=\"12\" cy=\"12\" r=\"10\" /> <path d=\"M12 6v6l4 2\" />",
        "copy": "<rect width=\"14\" height=\"14\" x=\"8\" y=\"8\" rx=\"2\" ry=\"2\" /> <path d=\"M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2\" />",
        "corner-down-right": "<path d=\"m15 10 5 5-5 5\" /> <path d=\"M4 4v7a4 4 0 0 0 4 4h12\" />",
        "database": "<ellipse cx=\"12\" cy=\"5\" rx=\"9\" ry=\"3\" /> <path d=\"M3 5V19A9 3 0 0 0 21 19V5\" /> <path d=\"M3 12A9 3 0 0 0 21 12\" />",
        "download": "<path d=\"M12 15V3\" /> <path d=\"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4\" /> <path d=\"m7 10 5 5 5-5\" />",
        "external-link": "<path d=\"M15 3h6v6\" /> <path d=\"M10 14 21 3\" /> <path d=\"M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6\" />",
        "eye": "<path d=\"M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0\" /> <circle cx=\"12\" cy=\"12\" r=\"3\" />",
        "file-check": "<path d=\"M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z\" /> <path d=\"M14 2v5a1 1 0 0 0 1 1h5\" /> <path d=\"m9 15 2 2 4-4\" />",
        "file-search": "<path d=\"M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z\" /> <path d=\"M14 2v5a1 1 0 0 0 1 1h5\" /> <circle cx=\"11.5\" cy=\"14.5\" r=\"2.5\" /> <path d=\"M13.3 16.3 15 18\" />",
        "file-text": "<path d=\"M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z\" /> <path d=\"M14 2v5a1 1 0 0 0 1 1h5\" /> <path d=\"M10 9H8\" /> <path d=\"M16 13H8\" /> <path d=\"M16 17H8\" />",
        "flask-conical": "<path d=\"M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2\" /> <path d=\"M6.453 15h11.094\" /> <path d=\"M8.5 2h7\" />",
        "globe": "<circle cx=\"12\" cy=\"12\" r=\"10\" /> <path d=\"M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20\" /> <path d=\"M2 12h20\" />",
        "landmark": "<path d=\"M10 18v-7\" /> <path d=\"M11.119 2.205a2 2 0 0 1 1.762 0l7.84 3.846A.5.5 0 0 1 20.5 7h-17a.5.5 0 0 1-.22-.949z\" /> <path d=\"M14 18v-7\" /> <path d=\"M18 18v-7\" /> <path d=\"M3 22h18\" /> <path d=\"M6 18v-7\" />",
        "library": "<path d=\"m16 6 4 14\" /> <path d=\"M12 6v14\" /> <path d=\"M8 8v12\" /> <path d=\"M4 4v16\" />",
        "maximize-2": "<path d=\"M15 3h6v6\" /> <path d=\"m21 3-7 7\" /> <path d=\"m3 21 7-7\" /> <path d=\"M9 21H3v-6\" />",
        "pause": "<rect x=\"14\" y=\"3\" width=\"5\" height=\"18\" rx=\"1\" /> <rect x=\"5\" y=\"3\" width=\"5\" height=\"18\" rx=\"1\" />",
        "play": "<path d=\"M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z\" />",
        "plus-circle": "<circle cx=\"12\" cy=\"12\" r=\"10\" /> <path d=\"M8 12h8\" /> <path d=\"M12 8v8\" />",
        "printer": "<path d=\"M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2\" /> <path d=\"M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6\" /> <rect x=\"6\" y=\"14\" width=\"12\" height=\"8\" rx=\"1\" />",
        "refresh-cw": "<path d=\"M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8\" /> <path d=\"M21 3v5h-5\" /> <path d=\"M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16\" /> <path d=\"M8 16H3v5\" />",
        "search": "<path d=\"m21 21-4.34-4.34\" /> <circle cx=\"11\" cy=\"11\" r=\"8\" />",
        "share-2": "<circle cx=\"18\" cy=\"5\" r=\"3\" /> <circle cx=\"6\" cy=\"12\" r=\"3\" /> <circle cx=\"18\" cy=\"19\" r=\"3\" /> <line x1=\"8.59\" x2=\"15.42\" y1=\"13.51\" y2=\"17.49\" /> <line x1=\"15.41\" x2=\"8.59\" y1=\"6.51\" y2=\"10.49\" />",
        "shield-alert": "<path d=\"M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z\" /> <path d=\"M12 8v4\" /> <path d=\"M12 16h.01\" />",
        "user": "<path d=\"M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2\" /> <circle cx=\"12\" cy=\"7\" r=\"4\" />",
        "x": "<path d=\"M18 6 6 18\" /> <path d=\"m6 6 12 12\" />",
        "zoom-in": "<circle cx=\"11\" cy=\"11\" r=\"8\" /> <line x1=\"21\" x2=\"16.65\" y1=\"21\" y2=\"16.65\" /> <line x1=\"11\" x2=\"11\" y1=\"8\" y2=\"14\" /> <line x1=\"8\" x2=\"14\" y1=\"11\" y2=\"11\" />",
        "zoom-out": "<circle cx=\"11\" cy=\"11\" r=\"8\" /> <line x1=\"21\" x2=\"16.65\" y1=\"21\" y2=\"16.65\" /> <line x1=\"8\" x2=\"14\" y1=\"11\" y2=\"11\" />"
    };

    /** Inner SVG markup for a name, or "" for an unknown icon. */
    function svg(name) {
        return PATHS[name] || "";
    }

    function escAttr(value) {
        return String(value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    /** Full standalone <svg> element markup for a name ("" if unknown). */
    function svgTag(name, extraClass) {
        var inner = svg(name);
        if (!inner) return "";
        var cls = "lucide lucide-" + name + (extraClass ? " " + extraClass : "");
        return '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"' +
            ' viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"' +
            ' stroke-linecap="round" stroke-linejoin="round" class="' + escAttr(cls) + '"' +
            ' aria-hidden="true">' + inner + "</svg>";
    }

    /**
     * lucide.createIcons()-compatible: replace every <i data-lucide="name">
     * with the equivalent inline <svg>, keeping the element's own classes.
     * Unknown names are left in place (invisible, exactly as before).
     *
     * Built with createElementNS/setAttribute rather than an HTML string:
     * the name and class come off DOM attributes, and attribute-sourced
     * text must never reach an innerHTML sink (CodeQL js/xss-through-dom
     * -- setAttribute assigns data, nothing gets reparsed as markup). The
     * one innerHTML write receives only PATHS[...] registry constants.
     */
    function createIcons() {
        var doc = global.document;
        if (!doc || typeof doc.querySelectorAll !== "function"
                || typeof doc.createElementNS !== "function") return;
        var SVG_NS = "http://www.w3.org/2000/svg";
        var nodes = doc.querySelectorAll("[data-lucide]");
        for (var i = 0; i < nodes.length; i++) {
            var el = nodes[i];
            var name = el.getAttribute("data-lucide");
            var inner = Object.prototype.hasOwnProperty.call(PATHS, name)
                ? PATHS[name] : "";
            if (!inner) continue;
            var svgEl = doc.createElementNS(SVG_NS, "svg");
            svgEl.setAttribute("width", "24");
            svgEl.setAttribute("height", "24");
            svgEl.setAttribute("viewBox", "0 0 24 24");
            svgEl.setAttribute("fill", "none");
            svgEl.setAttribute("stroke", "currentColor");
            svgEl.setAttribute("stroke-width", "2");
            svgEl.setAttribute("stroke-linecap", "round");
            svgEl.setAttribute("stroke-linejoin", "round");
            svgEl.setAttribute("aria-hidden", "true");
            var cls = "lucide lucide-" + name;
            var own = el.getAttribute("class");
            if (own) cls += " " + own;
            svgEl.setAttribute("class", cls);
            svgEl.innerHTML = inner;
            if (el.parentNode) el.parentNode.replaceChild(svgEl, el);
        }
    }

    global.AuraIcons = { svg: svg, svgTag: svgTag, createIcons: createIcons };

    // The compatibility shim. Never clobbers a real lucide if one somehow
    // loaded first.
    if (!global.lucide) global.lucide = { createIcons: createIcons };
})(window);
