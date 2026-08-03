/**
 * AURA animated backdrop.
 *
 * A sparse field of pixels that drifts slowly behind the dashboard, with
 * occasional brighter "signal" pixels that flare and decay — a quiet visual
 * echo of the ingestion pipeline picking stories out of the noise.
 *
 * Deliberately *not* another gradient. The page already carries a static
 * radial wash; layering animated gradients on top is what makes dashboards
 * look cheap. This renders at a low internal resolution and is upscaled with
 * image-rendering: pixelated, so the motion is cheap and the grain reads as
 * intentional pixel art rather than blur.
 *
 * Cost control: the internal buffer is ~200x112 regardless of viewport, and
 * the loop is capped at 30fps. A full-viewport per-frame repaint at device
 * resolution would be the single most expensive thing on the page; this is
 * roughly two orders of magnitude cheaper.
 */
(function (global) {
    "use strict";

    var BUFFER_W = 200;
    var TARGET_FPS = 30;
    var FRAME_MS = 1000 / TARGET_FPS;

    function Backdrop(canvas, options) {
        this.canvas = canvas;
        this.ctx = canvas.getContext("2d", { alpha: true });
        this.options = options || {};
        this.running = false;
        this.frame = null;
        this.lastPaint = 0;
        this.elapsed = 0;
        this.w = BUFFER_W;
        this.h = Math.round(BUFFER_W * 9 / 16);
        this.stars = [];
        this.signals = [];
        // Deterministic field: a fixed seed means the layout is identical on
        // every load, so the backdrop never "jumps" between page transitions.
        this.seed = 20260803;
        this.build();
        this.resize();
    }

    /** Small deterministic PRNG (mulberry32) so the field is reproducible. */
    Backdrop.prototype.rand = function () {
        this.seed |= 0;
        this.seed = (this.seed + 0x6D2B79F5) | 0;
        var t = Math.imul(this.seed ^ (this.seed >>> 15), 1 | this.seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    Backdrop.prototype.build = function () {
        var count = Math.round(this.w * this.h * 0.018);
        this.stars = [];
        for (var i = 0; i < count; i++) {
            this.stars.push({
                x: this.rand() * this.w,
                y: this.rand() * this.h,
                // Three depth layers drifting at different rates: parallax is
                // what stops a scattered field from looking like static.
                depth: 0.35 + this.rand() * 0.9,
                base: 0.05 + this.rand() * 0.10
            });
        }
    };

    Backdrop.prototype.resize = function () {
        var ratio = (global.innerHeight || 900) / (global.innerWidth || 1600);
        this.h = Math.max(80, Math.round(this.w * ratio));
        this.canvas.width = this.w;
        this.canvas.height = this.h;
        this.build();
        this.paint(0);
    };

    Backdrop.prototype.paint = function (dt) {
        var ctx = this.ctx;
        if (!ctx) return;
        this.elapsed += dt;
        ctx.clearRect(0, 0, this.w, this.h);

        // Drifting field. One fillStyle per alpha bucket rather than per pixel:
        // eight state changes instead of ~450.
        var buckets = [[], [], [], [], [], [], [], []];
        for (var i = 0; i < this.stars.length; i++) {
            var s = this.stars[i];
            var x = s.x + this.elapsed * s.depth * 1.6;
            var y = s.y + this.elapsed * s.depth * 0.55;
            x = ((x % this.w) + this.w) % this.w;
            y = ((y % this.h) + this.h) % this.h;
            var twinkle = 0.75 + 0.25 * Math.sin(this.elapsed * 0.8 + s.x);
            var a = s.base * twinkle;
            var bucket = Math.min(7, Math.floor(a / 0.02));
            buckets[bucket].push(x | 0, y | 0);
        }
        for (var b = 0; b < buckets.length; b++) {
            var pts = buckets[b];
            if (!pts.length) continue;
            ctx.fillStyle = "rgba(148, 163, 214, " + ((b + 1) * 0.02).toFixed(3) + ")";
            for (var p = 0; p < pts.length; p += 2) {
                ctx.fillRect(pts[p], pts[p + 1], 1, 1);
            }
        }

        this.updateSignals(dt);
    };

    /**
     * Signal flares: a pixel brightens, holds, and decays, with a one-pixel
     * cross around it at peak. Spawn rate is low on purpose — this should read
     * as an occasional event, not a light show.
     */
    Backdrop.prototype.updateSignals = function (dt) {
        var ctx = this.ctx;

        if (this.signals.length < 7 && this.rand() < dt * 1.4) {
            this.signals.push({
                x: Math.floor(this.rand() * this.w),
                y: Math.floor(this.rand() * this.h),
                life: 0,
                span: 2.2 + this.rand() * 2.4,
                warm: this.rand() < 0.25
            });
        }

        for (var i = this.signals.length - 1; i >= 0; i--) {
            var sig = this.signals[i];
            sig.life += dt;
            if (sig.life > sig.span) { this.signals.splice(i, 1); continue; }

            var t = sig.life / sig.span;
            var intensity = Math.sin(t * Math.PI);
            var alpha = intensity * 0.5;
            // A single warm flare in four marks an elevated-risk signal, which
            // keeps the backdrop tied to what the dashboard actually reports.
            ctx.fillStyle = sig.warm
                ? "rgba(251, 146, 120, " + alpha.toFixed(3) + ")"
                : "rgba(125, 211, 233, " + alpha.toFixed(3) + ")";
            ctx.fillRect(sig.x, sig.y, 1, 1);

            if (intensity > 0.55) {
                ctx.fillStyle = sig.warm
                    ? "rgba(251, 146, 120, " + (alpha * 0.32).toFixed(3) + ")"
                    : "rgba(125, 211, 233, " + (alpha * 0.32).toFixed(3) + ")";
                ctx.fillRect(sig.x - 1, sig.y, 1, 1);
                ctx.fillRect(sig.x + 1, sig.y, 1, 1);
                ctx.fillRect(sig.x, sig.y - 1, 1, 1);
                ctx.fillRect(sig.x, sig.y + 1, 1, 1);
            }
        }
    };

    Backdrop.prototype.tick = function (now) {
        if (!this.running) return;
        if (!this.lastPaint) this.lastPaint = now;
        var delta = now - this.lastPaint;
        if (delta >= FRAME_MS) {
            this.lastPaint = now;
            this.paint(Math.min(delta / 1000, 0.1));
        }
        this.frame = global.requestAnimationFrame(this.tick.bind(this));
    };

    Backdrop.prototype.start = function () {
        if (this.running) return;
        this.running = true;
        this.lastPaint = 0;
        this.frame = global.requestAnimationFrame(this.tick.bind(this));
    };

    Backdrop.prototype.stop = function () {
        this.running = false;
        if (this.frame) global.cancelAnimationFrame(this.frame);
        this.frame = null;
    };

    /**
     * Mount the backdrop. Motion is skipped entirely for reduced-motion users
     * and while the tab is hidden; a single static frame is left painted so
     * the page never looks broken.
     */
    function mount(canvas, options) {
        if (!canvas || !canvas.getContext) return null;

        var backdrop;
        try {
            backdrop = new Backdrop(canvas, options);
        } catch (err) {
            console.error("Backdrop failed to initialise:", err);
            return null;
        }

        var motionQuery = global.matchMedia("(prefers-reduced-motion: reduce)");
        var paused = false;

        function sync() {
            if (!motionQuery.matches && !paused && !global.document.hidden) backdrop.start();
            else backdrop.stop();
        }

        if (typeof motionQuery.addEventListener === "function") {
            motionQuery.addEventListener("change", sync);
        }
        global.document.addEventListener("visibilitychange", sync);

        var resizeTimer = null;
        global.addEventListener("resize", function () {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(function () { backdrop.resize(); }, 200);
        });

        sync();

        return {
            backdrop: backdrop,
            setPaused: function (value) { paused = !!value; sync(); }
        };
    }

    global.AuraBackdrop = { mount: mount };
})(window);
