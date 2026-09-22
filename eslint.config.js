// Deliberately one rule: no-undef.
//
// This exists because a rename left `isGitHubPages` referenced but never
// declared in app.js, which took down every panel on the live site --
// app.js is DOM-bound and cannot run in the headless test harness, so the
// frontend suite stayed green while the page threw on boot. An
// undefined-identifier check is the cheapest guard against that whole
// class. Style rules are intentionally absent; adding them means
// relitigating every file in the repo.
"use strict";

const browserGlobals = {
    window: "readonly",
    document: "readonly",
    console: "readonly",
    fetch: "readonly",
    alert: "readonly",
    navigator: "readonly",
    location: "readonly",
    localStorage: "readonly",
    sessionStorage: "readonly",
    setTimeout: "readonly",
    clearTimeout: "readonly",
    setInterval: "readonly",
    clearInterval: "readonly",
    requestAnimationFrame: "readonly",
    cancelAnimationFrame: "readonly",
    IntersectionObserver: "readonly",
    MutationObserver: "readonly",
    URL: "readonly",
    URLSearchParams: "readonly",
    Blob: "readonly",
    CustomEvent: "readonly",
    Event: "readonly",
    Node: "readonly",
    performance: "readonly",
    getComputedStyle: "readonly",
    history: "readonly",
    Promise: "readonly",
    Map: "readonly",
    Set: "readonly",
    // CDN libraries (pinned in index.html) and the page's own modules.
    Chart: "readonly",
    vis: "readonly",
    lucide: "readonly",
};

module.exports = [
    {
        // Vendored third-party bundles (chart.js, vis-network) are minified
        // upstream artifacts, not code this repo authors or lints.
        ignores: ["backend/app/static/js/vendor/**"],
    },
    {
        files: ["backend/app/static/js/**/*.js"],
        languageOptions: {
            ecmaVersion: 2021,
            sourceType: "script",
            globals: browserGlobals,
        },
        rules: {
            "no-undef": "error",
        },
    },
    {
        files: ["tests/frontend/**/*.js"],
        languageOptions: {
            ecmaVersion: 2021,
            sourceType: "script",
            globals: {
                ...browserGlobals,
                // Node harness (run.js) and the vm-sandbox test surface.
                require: "readonly",
                module: "readonly",
                process: "readonly",
                __dirname: "readonly",
                T: "readonly",
            },
        },
        rules: {
            "no-undef": "error",
        },
    },
];
