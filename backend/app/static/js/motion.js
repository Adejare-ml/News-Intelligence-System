/**
 * AURA motion utilities: scroll reveals, staggering, count-ups, scroll rail.
 *
 * Uses IntersectionObserver rather than CSS `animation-timeline: view()`.
 * Scroll-driven CSS animations are the tidier mechanism, but they are still
 * unevenly supported across Safari and Firefox, and a reveal that silently
 * never fires leaves content invisible — a hard failure, not a soft one. The
 * observer degrades safely: if it is missing, everything is revealed at once.
 *
 * Reduced motion is treated as "show me the content, skip the choreography",
 * never as "hide the content".
 */
(function (global) {
    "use strict";

    var doc = global.document;
    var motionQuery = global.matchMedia("(prefers-reduced-motion: reduce)");

    function prefersReduced() {
        return motionQuery.matches;
    }

    /** Reveal everything immediately, used as the safe fallback path. */
    function revealAll(root) {
        var nodes = (root || doc).querySelectorAll("[data-reveal]");
        for (var i = 0; i < nodes.length; i++) {
            nodes[i].classList.add("is-revealed");
        }
    }

    /**
     * Observe every [data-reveal] element and add .is-revealed when it enters
     * the viewport. `data-reveal-stagger` on a container staggers its direct
     * children by setting a --reveal-delay custom property.
     */
    function initReveals(root) {
        var scope = root || doc;

        if (prefersReduced() || typeof global.IntersectionObserver !== "function") {
            revealAll(scope);
            return null;
        }

        var pending = [];

        function reveal(el) {
            el.classList.add("is-revealed");
            var i = pending.indexOf(el);
            if (i !== -1) pending.splice(i, 1);
            observer.unobserve(el);
        }

        var observer = new global.IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                if (!entry.isIntersecting) return;
                // One-shot: re-animating on every scroll-by is the single most
                // common way this pattern becomes annoying.
                reveal(entry.target);
            });
        }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });

        var nodes = scope.querySelectorAll("[data-reveal]");
        for (var i = 0; i < nodes.length; i++) {
            pending.push(nodes[i]);
            observer.observe(nodes[i]);
        }

        /**
         * Safety sweep: reveal anything already at or above the fold.
         *
         * IntersectionObserver only delivers an entry when the intersection
         * *changes*. A jump-scroll — a deep link, find-in-page, a restored
         * scroll position, or a programmatic scrollTo — can move an element
         * from "below the viewport" to "above the viewport" without it ever
         * being intersecting on a sampled frame. No entry fires, and the
         * element stays at opacity 0 permanently. That is a content-hiding
         * failure, not a missed animation, so it needs its own guard.
         */
        var sweepQueued = false;
        function sweep() {
            sweepQueued = false;
            var limit = global.innerHeight * 0.92;
            for (var i = pending.length - 1; i >= 0; i--) {
                if (pending[i].getBoundingClientRect().top <= limit) reveal(pending[i]);
            }
            if (!pending.length) {
                global.removeEventListener("scroll", queueSweep);
                global.removeEventListener("resize", queueSweep);
            }
        }
        function queueSweep() {
            if (sweepQueued) return;
            sweepQueued = true;
            global.requestAnimationFrame(sweep);
        }

        global.addEventListener("scroll", queueSweep, { passive: true });
        global.addEventListener("resize", queueSweep);
        queueSweep();

        var groups = scope.querySelectorAll("[data-reveal-stagger]");
        for (var g = 0; g < groups.length; g++) {
            var children = groups[g].children;
            for (var c = 0; c < children.length; c++) {
                // Capped so a long list does not end with a child waiting a
                // full second before it appears.
                children[c].style.setProperty("--reveal-delay", Math.min(c, 8) * 55 + "ms");
            }
        }

        return observer;
    }

    /**
     * Animate an integer from 0 to `target`.
     *
     * Driven by requestAnimationFrame against elapsed time rather than a
     * setInterval with a computed step. The interval version divides by the
     * target, so a target of 0 produces a division by zero and a target under
     * ~30 produces a visibly wrong duration.
     */
    function countUp(el, target, duration) {
        if (!el) return;
        var value = Number(target) || 0;

        if (prefersReduced()) {
            el.textContent = value.toLocaleString();
            return;
        }

        var total = duration || 900;
        var start = null;

        function step(now) {
            if (start === null) start = now;
            var t = Math.min((now - start) / total, 1);
            // easeOutCubic: fast start, settles gently on the final number.
            var eased = 1 - Math.pow(1 - t, 3);
            el.textContent = Math.round(value * eased).toLocaleString();
            if (t < 1) global.requestAnimationFrame(step);
            else el.textContent = value.toLocaleString();
        }

        global.requestAnimationFrame(step);
    }

    /** Count up only once the element has actually been scrolled into view. */
    function countUpOnReveal(el, target, duration) {
        if (!el) return;
        if (prefersReduced() || typeof global.IntersectionObserver !== "function") {
            countUp(el, target, duration);
            return;
        }
        var observer = new global.IntersectionObserver(function (entries) {
            if (!entries[0].isIntersecting) return;
            observer.disconnect();
            countUp(el, target, duration);
        }, { threshold: 0.4 });
        observer.observe(el);
    }

    /**
     * Drive a 0..1 scroll progress value onto a CSS custom property.
     * Reads are throttled to one per animation frame so scrolling never
     * triggers a layout read/write storm.
     */
    function initScrollRail(el) {
        if (!el) return;
        var queued = false;

        function update() {
            queued = false;
            var scrollable = doc.documentElement.scrollHeight - global.innerHeight;
            var progress = scrollable > 0 ? global.scrollY / scrollable : 0;
            el.style.setProperty("--scroll-progress", Math.min(1, Math.max(0, progress)).toFixed(4));
        }

        global.addEventListener("scroll", function () {
            if (queued) return;
            queued = true;
            global.requestAnimationFrame(update);
        }, { passive: true });

        update();
    }

    /** Smooth-scroll to an element, honouring reduced motion. */
    function scrollToEl(el, offset) {
        if (!el) return;
        var top = el.getBoundingClientRect().top + global.scrollY - (offset || 16);
        try {
            global.scrollTo({ top: top, behavior: prefersReduced() ? "auto" : "smooth" });
        } catch (err) {
            global.scrollTo(0, top);
        }
    }

    global.AuraMotion = {
        prefersReduced: prefersReduced,
        initReveals: initReveals,
        revealAll: revealAll,
        countUp: countUp,
        countUpOnReveal: countUpOnReveal,
        initScrollRail: initScrollRail,
        scrollToEl: scrollToEl
    };
})(window);
