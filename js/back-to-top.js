/**
 * AuraBackToTop: a return-to-top control for a very long dashboard.
 *
 * The dashboard is a ~16,000px scroll on a 1440x900 viewport -- the
 * appointments board alone runs several screens -- and the only way back to
 * the nav was a flick of the wheel or Home, which does nothing while focus
 * sits inside a panel. The control appears once the reader is well past the
 * first screen and is otherwise invisible.
 *
 * Accessibility is the reason this is a <button> created here rather than
 * markup in index.html: it must not sit in the tab order while it is
 * hidden. Scrolling alone would also leave focus where it was, so a reader
 * on the keyboard would be returned visually and then tab back into the
 * middle of the page; focus moves to the main landmark as well.
 *
 * Honours prefers-reduced-motion: an instant jump rather than a smooth
 * scroll, matching motion.js and the stylesheet's reduce blocks.
 */
(function (global) {
    "use strict";

    // A screen and a half: far enough that the nav is long gone, close
    // enough that the control is there when the reader wants it.
    var SHOW_AFTER_FACTOR = 1.5;

    function prefersReducedMotion(doc) {
        try {
            return !!(global.matchMedia
                && global.matchMedia("(prefers-reduced-motion: reduce)").matches);
        } catch (e) {
            return false;
        }
    }

    /** Pure: is the control warranted at this scroll offset? */
    function shouldShow(scrollY, viewportHeight) {
        var y = Number(scrollY) || 0;
        var h = Number(viewportHeight) || 0;
        if (h <= 0) return false;
        return y > h * SHOW_AFTER_FACTOR;
    }

    function build(doc) {
        var btn = doc.createElement("button");
        btn.type = "button";
        btn.id = "back-to-top";
        btn.className = "back-to-top";
        btn.setAttribute("aria-label", "Back to top");
        btn.setAttribute("title", "Back to top");
        btn.hidden = true;
        var icon = doc.createElement("i");
        icon.setAttribute("data-lucide", "arrow-up");
        icon.setAttribute("aria-hidden", "true");
        btn.appendChild(icon);
        return btn;
    }

    function mount() {
        var doc = global.document;
        if (!doc || !doc.body || doc.getElementById("back-to-top")) return null;

        var btn = build(doc);
        doc.body.appendChild(btn);
        if (global.lucide && typeof global.lucide.createIcons === "function") {
            global.lucide.createIcons();
        }

        var shown = false;
        function sync() {
            var next = shouldShow(global.scrollY || global.pageYOffset || 0,
                                  global.innerHeight || 0);
            if (next === shown) return;        // never touch the DOM for nothing
            shown = next;
            btn.hidden = !next;
            btn.classList.toggle("is-visible", next);
        }

        // rAF-coalesced: scroll fires far more often than the page paints,
        // and this listener runs on a document several screens tall.
        var queued = false;
        function onScroll() {
            if (queued) return;
            queued = true;
            var raf = global.requestAnimationFrame
                || function (fn) { return global.setTimeout(fn, 16); };
            raf(function () { queued = false; sync(); });
        }

        btn.addEventListener("click", function () {
            var smooth = !prefersReducedMotion(doc);
            try {
                global.scrollTo({ top: 0, behavior: smooth ? "smooth" : "auto" });
            } catch (e) {
                global.scrollTo(0, 0);          // older Safari: no options object
            }
            // Return the keyboard too, not just the viewport.
            var main = doc.getElementById("main") || doc.body;
            if (main && typeof main.focus === "function") {
                if (!main.hasAttribute("tabindex")) main.setAttribute("tabindex", "-1");
                main.focus({ preventScroll: true });
            }
        });

        global.addEventListener("scroll", onScroll, { passive: true });
        global.addEventListener("resize", onScroll, { passive: true });
        sync();
        return btn;
    }

    var doc = global.document;
    if (doc && typeof doc.addEventListener === "function") {
        if (doc.readyState === "loading") {
            doc.addEventListener("DOMContentLoaded", mount);
        } else {
            mount();
        }
    }

    global.AuraBackToTop = { shouldShow: shouldShow, mount: mount };
})(window);
