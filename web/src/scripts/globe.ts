/**
 * The AURA globe: a dot-matrix Earth with gold routes from Lagos and Abuja
 * to the secrecy jurisdictions that appear in Nigerian ownership chains.
 *
 * Ported from the legacy js/globe.js and given an intro:
 *   1. ~4,700 dots drift in from a scattered field and settle onto the sphere
 *      (land first, then sea), each on its own delay, so the planet "forms".
 *   2. Nigeria fills in gold.
 *   3. The offshore routes draw out one by one, each ending in a pulse.
 * After that it rotates slowly, can be dragged (with momentum that decays
 * back to the idle spin), and slows and tilts as the hero scrolls away.
 *
 * Canvas 2D, no dependencies. Respects reduced motion (one static frame),
 * pauses offscreen and in background tabs.
 */
import globeData from "../lib/globe-data.ts";

const DEG = Math.PI / 180;

import { DEFAULT_ROUTES, type Route } from "../lib/routes.ts";

export type { Route };

const HOME_PORTS = [
  { label: "Lagos", lat: 6.52, lon: 3.38 },
  { label: "Abuja", lat: 9.06, lon: 7.49 },
];

interface Palette {
  sea: string;
  land: string;
  focusFill: string;
  focusStroke: string;
  arc: string;
  packet: string;
  marker: string;
  markerCore: string;
  halo: string;
}

const PALETTES: Record<"dark" | "light", Palette> = {
  dark: {
    sea: "110, 139, 255",
    land: "237, 230, 216",
    focusFill: "rgba(212, 168, 74, 0.30)",
    focusStroke: "rgba(232, 190, 98, 0.95)",
    arc: "212, 168, 74",
    packet: "246, 214, 140",
    marker: "110, 139, 255",
    markerCore: "rgba(246, 240, 228, 0.98)",
    halo: "47, 85, 212",
  },
  light: {
    sea: "30, 63, 174",
    land: "27, 26, 23",
    focusFill: "rgba(156, 116, 32, 0.22)",
    focusStroke: "rgba(125, 92, 22, 0.95)",
    arc: "156, 116, 32",
    packet: "125, 92, 22",
    marker: "30, 63, 174",
    markerCore: "rgba(27, 26, 23, 0.95)",
    halo: "30, 63, 174",
  },
};

interface Vec {
  x: number;
  y: number;
  z: number;
}

interface Dot extends Vec {
  land: boolean;
  /** Scatter start, as a fraction of the canvas size relative to centre. */
  sx: number;
  sy: number;
  delay: number;
}

interface Arc {
  from: Vec;
  to: Vec;
  label: string;
  weight: number;
  phase: number;
  start: number;
}

function toVector(lat: number, lon: number): Vec {
  const phi = lat * DEG;
  const theta = lon * DEG;
  const c = Math.cos(phi);
  return { x: c * Math.sin(theta), y: Math.sin(phi), z: c * Math.cos(theta) };
}

function slerp(a: Vec, b: Vec, t: number): Vec {
  const dot = Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z));
  const omega = Math.acos(dot);
  if (omega < 1e-6) return { ...a };
  const s = Math.sin(omega);
  const w1 = Math.sin((1 - t) * omega) / s;
  const w2 = Math.sin(t * omega) / s;
  return { x: a.x * w1 + b.x * w2, y: a.y * w1 + b.y * w2, z: a.z * w1 + b.z * w2 };
}

function decodeMask(): Uint8Array {
  const binary = atob(globeData.mask);
  const total = globeData.maskWidth * globeData.maskHeight;
  const out = new Uint8Array(total);
  for (let i = 0; i < total; i++) out[i] = (binary.charCodeAt(i >> 3) >> (7 - (i & 7))) & 1;
  return out;
}

/** Small deterministic PRNG so the scatter is the same on every visit. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const easeOutQuint = (t: number) => 1 - Math.pow(1 - t, 5);
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const clamp01 = (t: number) => Math.max(0, Math.min(1, t));

/** Intro timeline, in seconds. */
const T_DOTS = 1.25; // dots finish converging by ~DOT_SPREAD + T_DOTS
const DOT_SPREAD = 0.45;
const T_FOCUS = 1.35;
const T_ARCS = 1.6;
const ARC_STAGGER = 0.11;
const ARC_DRAW = 0.6;

export interface GlobeOptions {
  routes?: Route[];
  /** Routes are the watch-list, not recorded chains: drawn dim and dashed. */
  illustrative?: boolean;
  intro?: boolean;
  onIntroProgress?: (p: number) => void;
  onIntroDone?: () => void;
}

export class Globe {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private dots: Dot[] = [];
  private focus: Vec[] = [];
  private arcs: Arc[] = [];
  private pal: Palette = PALETTES.dark;
  private width = 0;
  private height = 0;
  private radius = 0;
  private dpr = 1;
  private rotation = -0.62;
  private tilt = 14 * DEG;
  private baseSpeed = 0.06;
  private spinVelocity = 0;
  private scrollFactor = 0;
  private elapsed = 0;
  private introTime = 0;
  private introActive: boolean;
  private introDone = false;
  private running = false;
  private frame = 0;
  private last = 0;
  private cosR = 1;
  private sinR = 0;
  private cosT = 1;
  private sinT = 0;
  private dragging = false;
  private dragX = 0;
  private dragHistory: { x: number; t: number }[] = [];
  private opts: GlobeOptions;

  constructor(canvas: HTMLCanvasElement, opts: GlobeOptions = {}) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) throw new Error("2D canvas unavailable");
    this.ctx = ctx;
    this.opts = opts;
    this.introActive = opts.intro !== false;
    this.buildDots();
    this.focus = (globeData.focusOutline || []).map(([lon, lat]) => toVector(lat, lon));
    this.setRoutes(opts.routes?.length ? opts.routes : DEFAULT_ROUTES);
    this.resize();
    this.bindPointer();
  }

  private buildDots() {
    const mask = decodeMask();
    const rand = mulberry32(20261021);
    const step = 2.2;
    for (let lat = -88; lat <= 88; lat += step) {
      const count = Math.max(6, Math.round((360 / step) * Math.cos(lat * DEG)));
      for (let i = 0; i < count; i++) {
        const lon = -180 + (360 * i) / count;
        const mx = Math.min(globeData.maskWidth - 1, Math.max(0, Math.floor(((lon + 180) / 360) * globeData.maskWidth)));
        const my = Math.min(globeData.maskHeight - 1, Math.max(0, Math.floor(((90 - lat) / 180) * globeData.maskHeight)));
        const land = mask[my * globeData.maskWidth + mx] === 1;
        // Scatter: a loose ring around the globe, wider for sea dots.
        const angle = rand() * Math.PI * 2;
        const dist = (land ? 0.55 : 0.75) + rand() * (land ? 0.55 : 0.8);
        this.dots.push({
            ...toVector(lat, lon),
            land,
            sx: Math.cos(angle) * dist,
            sy: Math.sin(angle) * dist * 0.8,
            // Land settles first so continents read before the oceans fill.
            delay: (land ? 0 : 0.18) + rand() * DOT_SPREAD,
          });
      }
    }
  }

  setRoutes(routes: Route[]) {
    this.arcs = routes.map((r, i) => {
      const origin = HOME_PORTS[i % HOME_PORTS.length];
      return {
        from: toVector(origin.lat, origin.lon),
        to: toVector(r.lat, r.lon),
        label: r.label,
        weight: r.weight || 1,
        phase: i / routes.length,
        start: T_ARCS + i * ARC_STAGGER,
      };
    });
  }

  get introLength() {
    return T_ARCS + Math.max(0, this.arcs.length - 1) * ARC_STAGGER + ARC_DRAW;
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.width = rect.width || 320;
    this.height = rect.height || 320;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.radius = Math.min(this.width, this.height) * 0.41;
    this.render();
  }

  /** 0 at the top of the page, 1 once the hero has scrolled away. */
  setScroll(p: number) {
    this.scrollFactor = clamp01(p);
  }

  /** Jump the intro to its end (click, key press, or replay toggled off). */
  skipIntro() {
    if (!this.introActive) return;
    this.introTime = this.introLength;
  }

  replayIntro() {
    this.introActive = true;
    this.introDone = false;
    this.introTime = 0;
    this.start();
  }

  private project(v: Vec) {
    const x = v.x * this.cosR + v.z * this.sinR;
    const z = -v.x * this.sinR + v.z * this.cosR;
    const y = v.y * this.cosT - z * this.sinT;
    const z2 = v.y * this.sinT + z * this.cosT;
    const depth = 2.2 / (2.2 - z2 * 0.25);
    return { sx: this.width / 2 + x * this.radius * depth, sy: this.height / 2 - y * this.radius * depth, z: z2 };
  }

  render() {
    const ctx = this.ctx;
    if (!this.width) return;
    this.pal = PALETTES[document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark"];
    const tilt = this.tilt + this.scrollFactor * 12 * DEG;
    this.cosR = Math.cos(this.rotation);
    this.sinR = Math.sin(this.rotation);
    this.cosT = Math.cos(tilt);
    this.sinT = Math.sin(tilt);
    ctx.clearRect(0, 0, this.width, this.height);
    const t = this.introActive ? this.introTime : Infinity;
    this.drawHalo(ctx, t);
    this.drawDots(ctx, t);
    this.drawFocus(ctx, t);
    this.drawArcs(ctx, t);
    this.drawMarkers(ctx, t);
  }

  /** A faint royal-blue atmosphere: barely there, it gives the sphere an edge. */
  private drawHalo(ctx: CanvasRenderingContext2D, t: number) {
    const a = clamp01((t - 0.6) / 0.8);
    if (a <= 0) return;
    const g = ctx.createRadialGradient(this.width / 2, this.height / 2, this.radius * 0.86, this.width / 2, this.height / 2, this.radius * 1.28);
    g.addColorStop(0, `rgba(${this.pal.halo}, ${0.08 * a})`);
    g.addColorStop(1, `rgba(${this.pal.halo}, 0)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.width, this.height);
  }

  private drawDots(ctx: CanvasRenderingContext2D, t: number) {
    const size = Math.max(1.3, this.radius * 0.0158);
    const span = Math.max(this.width, this.height) * 0.5;
    // Two passes (sea, land) so fillStyle changes twice per frame, not per dot.
    for (const land of [false, true]) {
      const rgb = land ? this.pal.land : this.pal.sea;
      const baseAlpha = land ? 0.74 : 0.15;
      for (const d of this.dots) {
        if (d.land !== land) continue;
        const p = this.project(d);
        const local = clamp01((t - d.delay) / T_DOTS);
        if (local >= 1) {
          if (p.z < 0) continue;
          const s = size * (land ? 1.12 : 1) * (0.72 + 0.28 * p.z);
          ctx.fillStyle = `rgba(${rgb}, ${baseAlpha * (0.55 + 0.45 * p.z)})`;
          ctx.fillRect(p.sx - s / 2, p.sy - s / 2, s, s);
          continue;
        }
        if (local <= 0) continue;
        // In flight: from the scatter point to the dot's place on the sphere,
        // fading the far hemisphere out as it lands.
        const e = easeOutQuint(local);
        const x0 = this.width / 2 + d.sx * span;
        const y0 = this.height / 2 + d.sy * span;
        const x = x0 + (p.sx - x0) * e;
        const y = y0 + (p.sy - y0) * e;
        const behind = p.z < 0 ? 1 - e : 1;
        const alpha = baseAlpha * Math.min(1, local * 2.2) * behind * (land ? 1 : 0.9);
        if (alpha <= 0.01) continue;
        const s = size * (1.4 - 0.4 * e);
        ctx.fillStyle = `rgba(${rgb}, ${alpha})`;
        ctx.fillRect(x - s / 2, y - s / 2, s, s);
      }
    }
  }

  private drawFocus(ctx: CanvasRenderingContext2D, t: number) {
    const a = easeOutCubic(clamp01((t - T_FOCUS) / 0.5));
    if (a <= 0 || !this.focus.length) return;
    const pts = this.focus.map((v) => this.project(v));
    if (pts.filter((p) => p.z > 0).length < pts.length * 0.55) return;
    ctx.beginPath();
    let started = false;
    for (const p of pts) {
      if (p.z <= 0) continue;
      if (!started) {
        ctx.moveTo(p.sx, p.sy);
        started = true;
      } else ctx.lineTo(p.sx, p.sy);
    }
    ctx.closePath();
    ctx.globalAlpha = a;
    ctx.fillStyle = this.pal.focusFill;
    ctx.fill();
    ctx.strokeStyle = this.pal.focusStroke;
    ctx.lineWidth = 1.3;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  private drawArcs(ctx: CanvasRenderingContext2D, t: number) {
    const STEPS = 48;
    for (const arc of this.arcs) {
      const drawn = easeInOut(clamp01((t - arc.start) / ARC_DRAW));
      if (drawn <= 0) continue;
      const pts = [];
      let visible = false;
      const last = Math.max(1, Math.round(STEPS * drawn));
      for (let s = 0; s <= last; s++) {
        const u = (s / STEPS);
        const v = slerp(arc.from, arc.to, u);
        const lift = 1 + 0.3 * Math.sin(u * Math.PI);
        const p = this.project({ x: v.x * lift, y: v.y * lift, z: v.z * lift });
        pts.push(p);
        if (p.z > -0.1) visible = true;
      }
      if (!visible) continue;

      // The route itself: a fine gold line, brighter while it is being drawn.
      const drawing = drawn < 1;
      ctx.beginPath();
      let on = false;
      for (const p of pts) {
        if (p.z <= -0.1) {
          on = false;
          continue;
        }
        if (!on) {
          ctx.moveTo(p.sx, p.sy);
          on = true;
        } else ctx.lineTo(p.sx, p.sy);
      }
      const dim = this.opts.illustrative;
      ctx.strokeStyle = `rgba(${this.pal.arc}, ${drawing ? (dim ? 0.5 : 0.8) : (dim ? 0.22 : 0.42)})`;
      ctx.lineWidth = dim ? 1 : Math.min(2.2, 0.9 + 0.35 * arc.weight);
      if (dim) ctx.setLineDash([3, 5]);
      ctx.stroke();
      if (dim) ctx.setLineDash([]);

      const head = pts[pts.length - 1];
      if (drawing && head.z > -0.05) {
        // The leading point of a route being drawn.
        ctx.fillStyle = `rgba(${this.pal.packet}, 1)`;
        ctx.beginPath();
        ctx.arc(head.sx, head.sy, Math.max(1.8, this.radius * 0.012), 0, Math.PI * 2);
        ctx.fill();
      } else if (!drawing) {
        // Landing pulse at the destination, then a slow travelling packet.
        const since = t - (arc.start + ARC_DRAW);
        if (since < 0.9 && head.z > 0) {
          const k = clamp01(since / 0.9);
          ctx.strokeStyle = `rgba(${this.pal.arc}, ${0.7 * (1 - k)})`;
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.arc(head.sx, head.sy, this.radius * (0.015 + 0.06 * easeOutCubic(k)), 0, Math.PI * 2);
          ctx.stroke();
        }
        // No packets travel a route nothing has been recorded on.
        if (this.opts.illustrative) continue;
        const travel = (this.elapsed * 0.16 + arc.phase) % 1;
        const p = pts[Math.min(pts.length - 1, Math.floor(travel * STEPS))];
        if (p && p.z > -0.05) {
          const glow = 0.45 + 0.55 * Math.sin(travel * Math.PI);
          const ps = Math.max(1.6, this.radius * 0.0145);
          ctx.fillStyle = `rgba(${this.pal.packet}, ${glow.toFixed(3)})`;
          ctx.fillRect(p.sx - ps / 2, p.sy - ps / 2, ps, ps);
        }
      }
    }
  }

  private drawMarkers(ctx: CanvasRenderingContext2D, t: number) {
    const a = clamp01((t - T_FOCUS) / 0.4);
    if (a <= 0) return;
    const pulse = 0.5 + 0.5 * Math.sin(this.elapsed * 1.6);
    for (const port of HOME_PORTS) {
      const p = this.project(toVector(port.lat, port.lon));
      if (p.z <= 0) continue;
      const r = this.radius * (0.026 + 0.016 * pulse);
      ctx.beginPath();
      ctx.arc(p.sx, p.sy, r, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${this.pal.marker}, ${(0.55 * (1 - pulse) + 0.2) * a})`;
      ctx.lineWidth = 1.2;
      ctx.stroke();
      const core = Math.max(2.2, this.radius * 0.017);
      ctx.globalAlpha = a;
      ctx.fillStyle = this.pal.markerCore;
      ctx.fillRect(p.sx - core / 2, p.sy - core / 2, core, core);
      ctx.globalAlpha = 1;
    }
  }

  private tick = (now: number) => {
    if (!this.running) return;
    this.frame = requestAnimationFrame(this.tick);
    const dt = this.last ? Math.min((now - this.last) / 1000, 0.05) : 0.016;
    this.last = now;
    this.elapsed += dt;

    if (this.introActive && !this.introDone) {
      this.introTime += dt;
      this.opts.onIntroProgress?.(clamp01(this.introTime / this.introLength));
      if (this.introTime >= this.introLength + 0.9) {
        this.introDone = true;
        this.opts.onIntroDone?.();
      }
    }

    // Idle spin slows as the hero scrolls away; a drag's momentum decays
    // back to it (friction, never a hard stop).
    const idle = this.baseSpeed * (1 - 0.75 * this.scrollFactor);
    if (!this.dragging) {
      this.spinVelocity *= Math.pow(0.04, dt); // ~96% of momentum gone per second
      this.rotation += (idle + this.spinVelocity) * dt;
    }
    this.render();
  };

  start() {
    if (this.running) return;
    this.running = true;
    this.last = 0;
    this.frame = requestAnimationFrame(this.tick);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.frame);
  }

  /** Static final frame for reduced motion. */
  settle() {
    this.introActive = false;
    this.introDone = true;
    this.render();
  }

  private bindPointer() {
    const c = this.canvas;
    c.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      this.skipIntro();
      this.dragging = true;
      this.dragX = e.clientX;
      this.dragHistory = [{ x: e.clientX, t: performance.now() }];
      this.spinVelocity = 0;
      c.setPointerCapture(e.pointerId);
      c.classList.add("is-dragging");
    });
    c.addEventListener("pointermove", (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.dragX;
      this.dragX = e.clientX;
      // 1:1 feel: a drag across the globe's diameter turns it ~180 degrees.
      this.rotation += (dx / (this.radius * 2)) * Math.PI;
      const now = performance.now();
      this.dragHistory.push({ x: e.clientX, t: now });
      while (this.dragHistory.length > 2 && now - this.dragHistory[0].t > 100) this.dragHistory.shift();
      if (!this.running) this.render();
    });
    const end = () => {
      if (!this.dragging) return;
      this.dragging = false;
      c.classList.remove("is-dragging");
      // Hand the release velocity to the spin so there is no seam.
      const h = this.dragHistory;
      if (h.length >= 2) {
        const first = h[0];
        const lastPt = h[h.length - 1];
        const dt = Math.max(16, lastPt.t - first.t) / 1000;
        const pxPerSec = (lastPt.x - first.x) / dt;
        this.spinVelocity = Math.max(-6, Math.min(6, (pxPerSec / (this.radius * 2)) * Math.PI));
      }
    };
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", end);
  }
}

/**
 * Mount on a canvas with all the motion gates: reduced motion renders one
 * static frame, offscreen and hidden tabs pause the loop.
 */
export function mountGlobe(canvas: HTMLCanvasElement, opts: GlobeOptions = {}): Globe | null {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  let globe: Globe;
  try {
    globe = new Globe(canvas, { ...opts, intro: opts.intro !== false && !reduce.matches });
  } catch (err) {
    console.error("Globe failed to start:", err);
    return null;
  }
  let onScreen = true;
  const sync = () => {
    if (reduce.matches) {
      globe.stop();
      globe.settle();
      if (opts.intro !== false) opts.onIntroDone?.();
      return;
    }
    if (onScreen && !document.hidden) globe.start();
    else globe.stop();
  };
  new IntersectionObserver((entries) => {
    onScreen = entries[0].isIntersecting;
    sync();
  }).observe(canvas);
  document.addEventListener("visibilitychange", sync);
  reduce.addEventListener("change", sync);
  window.addEventListener("aura:theme", () => globe.render());
  let resizeFrame = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => globe.resize());
  }).observe(canvas);
  sync();
  return globe;
}
