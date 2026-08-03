/**
 * AURA offshore-exposure globe.
 *
 * A rotating pixel dot-matrix Earth drawn to a 2D canvas. Every dot is a square
 * rather than a circle: fillRect is roughly twice as cheap as arc() at this dot
 * count, and the square grid reads as deliberate pixel art instead of a
 * low-effort particle field.
 *
 * Why hand-written rather than three.js/globe.gl: the page ships under a strict
 * CSP where every CDN script is pinned with a Subresource Integrity hash, and
 * `img-src` is 'self' data: only. A bare ESM `import` from a CDN cannot carry an
 * SRI hash, and an Earth texture cannot be fetched at runtime at all. Rendering
 * procedurally from the baked mask in globe-data.js keeps the existing supply
 * chain guarantees intact and costs ~12 KB instead of ~600 KB.
 *
 * The arcs are not decoration. They trace Lagos and Abuja to the secrecy
 * jurisdictions that show up in beneficial-ownership chains, which is the same
 * relationship the PSC panel flags as "Complex Offshore Vehicle".
 */
(function (global) {
    "use strict";

    var DEG = Math.PI / 180;

    // Secrecy jurisdictions that recur in Nigerian beneficial-ownership chains.
    // Sourced from the intermediate-entity vehicles the PSC panel already
    // tracks (e.g. Tengen Holdings (Mauritius) Limited on Access Holdings).
    var OFFSHORE_ROUTES = [
        { label: "Mauritius", lat: -20.35, lon: 57.55 },
        { label: "London", lat: 51.51, lon: -0.13 },
        { label: "Jersey", lat: 49.21, lon: -2.13 },
        { label: "Cayman Islands", lat: 19.31, lon: -81.25 },
        { label: "British Virgin Islands", lat: 18.42, lon: -64.64 },
        { label: "Dubai (DIFC)", lat: 25.20, lon: 55.27 },
        { label: "Delaware", lat: 39.16, lon: -75.52 },
        { label: "Singapore", lat: 1.35, lon: 103.82 },
        { label: "Zurich", lat: 47.37, lon: 8.54 }
    ];

    var HOME_PORTS = [
        { label: "Lagos", lat: 6.52, lon: 3.38 },
        { label: "Abuja", lat: 9.06, lon: 7.49 }
    ];

    /** Unit vector on the sphere for a geographic coordinate. */
    function toVector(lat, lon) {
        var phi = lat * DEG;
        var theta = lon * DEG;
        var c = Math.cos(phi);
        return { x: c * Math.sin(theta), y: Math.sin(phi), z: c * Math.cos(theta) };
    }

    /** Spherical linear interpolation, so arcs follow great circles. */
    function slerp(a, b, t) {
        var dot = Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z));
        var omega = Math.acos(dot);
        if (omega < 1e-6) return { x: a.x, y: a.y, z: a.z };
        var s = Math.sin(omega);
        var w1 = Math.sin((1 - t) * omega) / s;
        var w2 = Math.sin(t * omega) / s;
        return {
            x: a.x * w1 + b.x * w2,
            y: a.y * w1 + b.y * w2,
            z: a.z * w1 + b.z * w2
        };
    }

    /** Unpack the base64 bit array from globe-data.js into a Uint8Array of 0/1. */
    function decodeMask(data) {
        var binary = global.atob(data.mask);
        var total = data.maskWidth * data.maskHeight;
        var out = new Uint8Array(total);
        for (var i = 0; i < total; i++) {
            var byte = binary.charCodeAt(i >> 3);
            out[i] = (byte >> (7 - (i & 7))) & 1;
        }
        return out;
    }

    function GlobeRenderer(canvas, data, options) {
        this.canvas = canvas;
        this.ctx = canvas.getContext("2d", { alpha: true });
        this.data = data;
        this.mask = decodeMask(data);
        this.options = options || {};

        this.rotation = this.options.initialRotation || 0;
        this.speed = this.options.speed || 0.055;   // radians per second
        this.tilt = (this.options.tilt || 16) * DEG;
        this.running = false;
        this.frame = null;
        this.lastTime = 0;
        this.elapsed = 0;
        this.dpr = 1;
        this.width = 0;
        this.height = 0;

        this.dots = this.buildDots();
        this.focus = this.buildFocusOutline();
        this.arcs = this.buildArcs();
        this.resize();
    }

    /**
     * Even-area dot distribution: the number of dots on a latitude band scales
     * with cos(lat), otherwise they bunch into a dense cap at each pole.
     */
    GlobeRenderer.prototype.buildDots = function () {
        var data = this.data;
        var mask = this.mask;
        var step = this.options.dotStep || 2.2;       // degrees between bands
        var dots = [];

        for (var lat = -88; lat <= 88; lat += step) {
            var circumference = Math.cos(lat * DEG);
            var count = Math.max(6, Math.round((360 / step) * circumference));
            for (var i = 0; i < count; i++) {
                var lon = -180 + (360 * i) / count;

                var mx = Math.floor(((lon + 180) / 360) * data.maskWidth);
                var my = Math.floor(((90 - lat) / 180) * data.maskHeight);
                mx = Math.min(data.maskWidth - 1, Math.max(0, mx));
                my = Math.min(data.maskHeight - 1, Math.max(0, my));

                var isLand = mask[my * data.maskWidth + mx] === 1;
                // Ocean dots are kept at full density but drawn very faint.
                // Dropping them made the sphere disappear whenever an
                // ocean-heavy hemisphere (the Pacific) faced the viewer; the
                // separation between sea and land is carried by contrast, not
                // by presence.
                var v = toVector(lat, lon);
                dots.push({ x: v.x, y: v.y, z: v.z, land: isLand });
            }
        }
        return dots;
    };

    GlobeRenderer.prototype.buildFocusOutline = function () {
        var ring = this.data.focusOutline || [];
        var points = [];
        for (var i = 0; i < ring.length; i++) {
            points.push(toVector(ring[i][1], ring[i][0]));
        }
        return points;
    };

    /**
     * One arc per offshore jurisdiction, alternating between the two home
     * ports so the bundle does not all originate from a single point.
     */
    GlobeRenderer.prototype.buildArcs = function () {
        var arcs = [];
        for (var i = 0; i < OFFSHORE_ROUTES.length; i++) {
            var origin = HOME_PORTS[i % HOME_PORTS.length];
            var target = OFFSHORE_ROUTES[i];
            arcs.push({
                from: toVector(origin.lat, origin.lon),
                to: toVector(target.lat, target.lon),
                label: target.label,
                // Staggered so pulses do not fire in lockstep.
                phase: i / OFFSHORE_ROUTES.length
            });
        }
        return arcs;
    };

    GlobeRenderer.prototype.resize = function () {
        var rect = this.canvas.getBoundingClientRect();
        var cssWidth = rect.width || this.canvas.clientWidth || 320;
        var cssHeight = rect.height || this.canvas.clientHeight || 320;

        // Capping DPR at 2 keeps the fill rate sane on phones that report 3-4.
        this.dpr = Math.min(global.devicePixelRatio || 1, 2);
        this.width = cssWidth;
        this.height = cssHeight;
        this.canvas.width = Math.round(cssWidth * this.dpr);
        this.canvas.height = Math.round(cssHeight * this.dpr);
        this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        this.radius = Math.min(cssWidth, cssHeight) * 0.42;
        this.render();
    };

    /** Rotate about Y (spin), then about X (fixed tilt), then project. */
    GlobeRenderer.prototype.project = function (v) {
        var cosR = Math.cos(this.rotation);
        var sinR = Math.sin(this.rotation);
        var x = v.x * cosR + v.z * sinR;
        var z = -v.x * sinR + v.z * cosR;

        var cosT = Math.cos(this.tilt);
        var sinT = Math.sin(this.tilt);
        var y = v.y * cosT - z * sinT;
        var z2 = v.y * sinT + z * cosT;

        // Mild perspective: the near face reads slightly larger, which is what
        // sells the sphere as a solid rather than a flat disc of dots. Kept
        // gentle on purpose -- a stronger term spreads the near-side dots out
        // and leaves a visibly hollow centre.
        var depth = 2.2 / (2.2 - z2 * 0.25);
        return {
            sx: this.width / 2 + x * this.radius * depth,
            sy: this.height / 2 - y * this.radius * depth,
            z: z2
        };
    };

    GlobeRenderer.prototype.render = function () {
        var ctx = this.ctx;
        if (!ctx || !this.width) return;
        ctx.clearRect(0, 0, this.width, this.height);

        this.drawDots(ctx);
        this.drawFocus(ctx);
        this.drawArcs(ctx);
        this.drawMarkers(ctx);
    };

    /**
     * Dots are batched into two fill passes rather than setting fillStyle per
     * dot. Canvas state changes dominate the cost at this dot count, so one
     * style change instead of ~4700 keeps the frame well inside budget.
     */
    GlobeRenderer.prototype.drawDots = function (ctx) {
        var size = Math.max(1.4, this.radius * 0.0165);

        // Sea first, so land always paints over it at shared grid positions.
        ctx.fillStyle = "rgba(99, 116, 158, 0.16)";
        this.paintDots(ctx, size, false);

        ctx.fillStyle = "rgba(176, 152, 252, 0.82)";
        this.paintDots(ctx, size * 1.15, true);
    };

    GlobeRenderer.prototype.paintDots = function (ctx, size, wantLand) {
        for (var i = 0; i < this.dots.length; i++) {
            var d = this.dots[i];
            if (d.land !== wantLand) continue;
            var p = this.project(d);
            if (p.z < 0) continue;   // cull the far hemisphere

            // Shrinking with depth reads as curvature; opacity is left flat so
            // the terminator does not smear into a grey band.
            var s = size * (0.72 + 0.28 * p.z);
            ctx.fillRect(p.sx - s / 2, p.sy - s / 2, s, s);
        }
    };

    GlobeRenderer.prototype.drawFocus = function (ctx) {
        if (!this.focus.length) return;

        // Only draw the outline when the country is actually facing the viewer,
        // otherwise it smears across the silhouette as a meaningless scribble.
        var visible = 0;
        for (var i = 0; i < this.focus.length; i++) {
            if (this.project(this.focus[i]).z > 0) visible++;
        }
        if (visible < this.focus.length * 0.55) return;

        ctx.beginPath();
        var started = false;
        for (var j = 0; j < this.focus.length; j++) {
            var p = this.project(this.focus[j]);
            if (p.z <= 0) continue;
            if (!started) { ctx.moveTo(p.sx, p.sy); started = true; }
            else ctx.lineTo(p.sx, p.sy);
        }
        if (!started) return;
        ctx.closePath();
        ctx.fillStyle = "rgba(6, 182, 212, 0.18)";
        ctx.fill();
        ctx.strokeStyle = "rgba(103, 232, 249, 0.75)";
        ctx.lineWidth = 1.2;
        ctx.stroke();
    };

    GlobeRenderer.prototype.drawArcs = function (ctx) {
        var STEPS = 36;
        for (var a = 0; a < this.arcs.length; a++) {
            var arc = this.arcs[a];
            var points = [];
            var anyVisible = false;

            for (var s = 0; s <= STEPS; s++) {
                var t = s / STEPS;
                var v = slerp(arc.from, arc.to, t);
                // Lift the mid-point off the surface so the arc arches over the
                // globe instead of being buried in it.
                var lift = 1 + 0.28 * Math.sin(t * Math.PI);
                var p = this.project({ x: v.x * lift, y: v.y * lift, z: v.z * lift });
                points.push(p);
                if (p.z > -0.1) anyVisible = true;
            }
            if (!anyVisible) continue;

            ctx.beginPath();
            var drawing = false;
            for (var i = 0; i < points.length; i++) {
                if (points[i].z <= -0.1) { drawing = false; continue; }
                if (!drawing) { ctx.moveTo(points[i].sx, points[i].sy); drawing = true; }
                else ctx.lineTo(points[i].sx, points[i].sy);
            }
            ctx.strokeStyle = "rgba(244, 114, 182, 0.30)";
            ctx.lineWidth = 1;
            ctx.stroke();

            // A packet travelling the route. Direction encodes the flow of
            // beneficial ownership: out of Nigeria, into the secrecy vehicle.
            var travel = (this.elapsed * 0.22 + arc.phase) % 1;
            var head = points[Math.floor(travel * STEPS)];
            if (head && head.z > -0.05) {
                var glow = 0.55 + 0.45 * Math.sin(travel * Math.PI);
                ctx.fillStyle = "rgba(253, 164, 175, " + glow.toFixed(3) + ")";
                var ps = Math.max(1.6, this.radius * 0.016);
                ctx.fillRect(head.sx - ps / 2, head.sy - ps / 2, ps, ps);
            }
        }
    };

    GlobeRenderer.prototype.drawMarkers = function (ctx) {
        var pulse = 0.5 + 0.5 * Math.sin(this.elapsed * 2.0);
        for (var i = 0; i < HOME_PORTS.length; i++) {
            var port = HOME_PORTS[i];
            var p = this.project(toVector(port.lat, port.lon));
            if (p.z <= 0) continue;

            var r = this.radius * (0.028 + 0.018 * pulse);
            ctx.beginPath();
            ctx.arc(p.sx, p.sy, r, 0, Math.PI * 2);
            ctx.strokeStyle = "rgba(103, 232, 249, " + (0.55 * (1 - pulse) + 0.2).toFixed(3) + ")";
            ctx.lineWidth = 1.2;
            ctx.stroke();

            var core = Math.max(2, this.radius * 0.018);
            ctx.fillStyle = "rgba(207, 250, 254, 0.95)";
            ctx.fillRect(p.sx - core / 2, p.sy - core / 2, core, core);
        }
    };

    GlobeRenderer.prototype.tick = function (now) {
        if (!this.running) return;
        var dt = this.lastTime ? Math.min((now - this.lastTime) / 1000, 0.05) : 0.016;
        this.lastTime = now;
        this.elapsed += dt;
        this.rotation += this.speed * dt;
        this.render();
        this.frame = global.requestAnimationFrame(this.tick.bind(this));
    };

    GlobeRenderer.prototype.start = function () {
        if (this.running) return;
        this.running = true;
        this.lastTime = 0;
        this.frame = global.requestAnimationFrame(this.tick.bind(this));
    };

    GlobeRenderer.prototype.stop = function () {
        this.running = false;
        if (this.frame) global.cancelAnimationFrame(this.frame);
        this.frame = null;
    };

    /**
     * Mount a globe onto a canvas.
     *
     * Motion is gated three ways, per WCAG 2.2.2 (moving content lasting more
     * than five seconds must be pausable) and 2.3.3:
     *   - prefers-reduced-motion renders one static frame and never animates,
     *     and the listener re-checks when the OS setting changes at runtime;
     *   - an IntersectionObserver stops the loop while the canvas is offscreen;
     *   - the Page Visibility API stops it while the tab is in the background.
     */
    function mount(canvas, options) {
        var data = global.AURA_GLOBE_DATA;
        if (!canvas || !data || !canvas.getContext) return null;

        var renderer;
        try {
            renderer = new GlobeRenderer(canvas, data, options);
        } catch (err) {
            console.error("Globe failed to initialise:", err);
            return null;
        }

        var motionQuery = global.matchMedia("(prefers-reduced-motion: reduce)");
        var onScreen = true;
        var userPaused = false;

        function shouldRun() {
            return !motionQuery.matches && onScreen && !userPaused && !global.document.hidden;
        }

        function sync() {
            if (shouldRun()) renderer.start();
            else { renderer.stop(); renderer.render(); }
        }

        if (typeof motionQuery.addEventListener === "function") {
            motionQuery.addEventListener("change", sync);
        }

        if (typeof global.IntersectionObserver === "function") {
            new global.IntersectionObserver(function (entries) {
                onScreen = entries[0].isIntersecting;
                sync();
            }, { threshold: 0.01 }).observe(canvas);
        }

        global.document.addEventListener("visibilitychange", sync);

        var resizeTimer = null;
        global.addEventListener("resize", function () {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(function () { renderer.resize(); }, 150);
        });

        sync();

        return {
            renderer: renderer,
            isPaused: function () { return userPaused; },
            toggle: function () {
                userPaused = !userPaused;
                sync();
                return userPaused;
            },
            routes: OFFSHORE_ROUTES.slice()
        };
    }

    global.AuraGlobe = { mount: mount, routes: OFFSHORE_ROUTES.slice(), ports: HOME_PORTS.slice() };
})(window);
