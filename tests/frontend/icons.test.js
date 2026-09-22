/* Tests for the inline icon module that replaced the lucide CDN script.
   The registry contract matters most: every icon name the markup uses must
   resolve, because an unknown name renders as nothing (the pre-existing
   CDN-failure symptom this module exists to remove). */
(function () {
    "use strict";
    var I = window.AuraIcons;

    // Every data-lucide name in index.html and the JS templates. Adding an
    // icon to the markup means adding it here AND to icons.js -- that is
    // the point: this list is what keeps the two in step.
    var USED = ["x", "pause", "play", "download", "check", "search",
        "flask-conical", "copy", "shield-alert", "printer", "maximize-2",
        "globe", "file-text", "eye", "calendar", "zoom-out", "zoom-in",
        "share-2", "refresh-cw", "plus-circle", "library", "file-search",
        "file-check", "external-link", "database", "corner-down-right",
        "clock", "braces", "user", "briefcase", "landmark", "sun", "moon"];

    T.describe("icon registry", function () {
        T.it("every icon the markup uses resolves to real path data", function () {
            USED.forEach(function (name) {
                T.ok(I.svg(name).length > 0, name + " has path data");
            });
        });

        T.it("unknown names yield empty strings, never a broken tag", function () {
            T.eq(I.svg("definitely-not-an-icon"), "");
            T.eq(I.svgTag("definitely-not-an-icon"), "");
        });

        T.it("svgTag emits a lucide-compatible inline svg", function () {
            var tag = I.svgTag("search", "btn-glyph");
            T.contains(tag, "<svg");
            T.contains(tag, 'stroke="currentColor"');
            T.contains(tag, 'class="lucide lucide-search btn-glyph"');
            T.contains(tag, 'aria-hidden="true"');
            T.contains(tag, 'viewBox="0 0 24 24"');
        });
    });

    T.describe("lucide shim", function () {
        T.it("window.lucide.createIcons exists and no-ops headless", function () {
            T.ok(typeof window.lucide === "object" && window.lucide, "shim installed");
            T.eq(typeof window.lucide.createIcons, "function");
            window.lucide.createIcons(); // stub document: must not throw
            T.ok(true, "headless createIcons is a no-op");
        });
    });

    T.report();
})();
