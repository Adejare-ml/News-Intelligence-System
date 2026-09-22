/* Tests for the theme resolver (js/theme.js). The DOM shell is guarded
   out headless; resolveTheme is the decision that matters: a stored
   choice always wins, the OS preference fills in, dark is the floor. */
(function () {
    "use strict";
    var TH = window.AuraTheme;

    T.describe("theme resolution", function () {
        T.it("a stored choice beats the OS preference", function () {
            T.eq(TH.resolveTheme("dark", true), "dark");
            T.eq(TH.resolveTheme("light", false), "light");
        });

        T.it("no stored choice follows the OS", function () {
            T.eq(TH.resolveTheme(null, true), "light");
            T.eq(TH.resolveTheme(null, false), "dark");
        });

        T.it("garbage storage falls back cleanly", function () {
            T.eq(TH.resolveTheme("neon", false), "dark");
            T.eq(TH.resolveTheme("", true), "light");
            T.eq(TH.resolveTheme(undefined, false), "dark");
        });
    });

    T.report();
})();
