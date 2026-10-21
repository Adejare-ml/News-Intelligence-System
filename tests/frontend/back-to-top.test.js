/* Tests for the back-to-top control. Only the pure half runs headless:
   mount() needs a real document, so the suite covers the decision rule and
   leaves the DOM wiring to the browser page, the same split the other
   DOM-bound modules use. */
(function () {
    "use strict";
    var B = window.AuraBackToTop;

    T.describe("back to top", function () {
        T.it("stays hidden through the first screen and a half", function () {
            T.eq(B.shouldShow(0, 900), false, "at the top");
            T.eq(B.shouldShow(900, 900), false, "one screen down");
            T.eq(B.shouldShow(1350, 900), false, "exactly the threshold");
        });

        T.it("appears past 1.5 viewports", function () {
            T.eq(B.shouldShow(1351, 900), true);
            T.eq(B.shouldShow(16000, 900), true, "deep in a 16,000px page");
        });

        T.it("a viewport we cannot measure never shows it", function () {
            [0, -1, null, undefined, NaN].forEach(function (h) {
                T.eq(B.shouldShow(5000, h), false, "height " + JSON.stringify(h));
            });
        });

        T.it("junk scroll offsets are treated as the top", function () {
            T.eq(B.shouldShow(null, 900), false);
            T.eq(B.shouldShow(undefined, 900), false);
            T.eq(B.shouldShow("not a number", 900), false);
        });
    });
})();
