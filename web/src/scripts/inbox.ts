/**
 * Alerts inbox.
 *  - Bell badge shows unread alerts; it rings once (a small rotate spring)
 *    when the page loads with unread alerts.
 *  - The drawer slides in on a critically damped spring and can be grabbed
 *    mid-flight: every animation starts from the panel's live position.
 *  - Drag right to dismiss. Release velocity is handed to the spring, and a
 *    quick flick dismisses regardless of distance.
 *  - A one-time toast says how many alerts arrived since the last visit.
 * Read state is per-browser (localStorage) and wrapped in try/catch.
 */
import { animate } from "motion";
import type { Alert } from "../lib/alerts.ts";

const READ_KEY = "aura-alerts-read";
const SEEN_KEY = "aura-alerts-last-visit";
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const alerts: Alert[] = (() => {
  try {
    return JSON.parse(document.getElementById("aura-alerts")?.textContent || "[]");
  } catch {
    return [];
  }
})();

const panel = document.querySelector<HTMLElement>("[data-inbox]");
const scrim = document.querySelector<HTMLElement>("[data-inbox-scrim]");
const list = document.querySelector<HTMLElement>("[data-inbox-list]");
const summary = document.querySelector<HTMLElement>("[data-inbox-summary]");
const markAll = document.querySelector<HTMLButtonElement>("[data-inbox-markall]");

function store<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode */
  }
}

const read = new Set<string>(store<string[]>(READ_KEY, []));
const unread = () => alerts.filter((a) => !read.has(a.id));

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function dayLabel(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return "Undated";
  return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" });
}

function renderList() {
  if (!list) return;
  let day = "";
  list.innerHTML = alerts
    .map((a) => {
      const head = a.date !== day ? `<li class="day">${esc(dayLabel((day = a.date)))}</li>` : "";
      const chip = a.level === "Critical" ? "chip-crimson" : a.level === "High" ? "chip-gold" : "";
      return `${head}<li><a href="${esc(a.url)}" target="_blank" rel="noopener noreferrer" data-alert="${a.id}" class="${read.has(a.id) ? "is-read" : ""}">
        <span class="unread-dot" aria-hidden="true"></span>
        <span class="a-title">${esc(a.title)}</span>
        <span class="a-meta"><span class="chip ${chip}">${esc(a.level)}</span>${esc(a.source)}</span>
      </a></li>`;
    })
    .join("");
  if (!alerts.length) list.innerHTML = '<li class="day">No alerts in the last few days.</li>';
}

function syncCounts() {
  const n = unread().length;
  document.querySelectorAll<HTMLElement>("[data-bell-count]").forEach((el) => {
    el.textContent = n > 9 ? "9+" : String(n);
    el.hidden = n === 0;
  });
  document.querySelectorAll<HTMLElement>("[data-open-inbox][aria-label]").forEach((el) => {
    el.setAttribute("aria-label", n ? `Alerts, ${n} unread` : "Alerts");
  });
  if (summary) summary.textContent = n ? `${n} unread of ${alerts.length}` : `All ${alerts.length} read`;
  if (markAll) markAll.disabled = n === 0;
}

/* ---------- Drawer physics ---------- */
let x = 0; // current translateX in px (0 = open)
let width = 440;
let control: { stop: () => void } | null = null;
let isOpen = false;
let lastFocus: HTMLElement | null = null;

const setX = (v: number) => {
  x = v;
  if (panel) panel.style.transform = `translateX(${v}px)`;
  if (scrim) scrim.style.opacity = String(Math.max(0, Math.min(1, 1 - v / width)));
};

function springTo(target: number, velocity = 0, done?: () => void) {
  control?.stop();
  if (reduceMotion) {
    setX(target);
    done?.();
    return;
  }
  // Starts from the live position, so a drawer grabbed mid-flight never jumps.
  const anim = animate(x, target, {
    type: "spring",
    bounce: 0,
    visualDuration: target === 0 ? 0.38 : 0.26, // exit faster than entry
    velocity,
    onUpdate: setX,
  });
  control = anim;
  anim.then(() => done?.());
}

function open() {
  if (!panel || !scrim || isOpen) return;
  isOpen = true;
  lastFocus = document.activeElement as HTMLElement;
  panel.hidden = false;
  scrim.hidden = false;
  width = panel.getBoundingClientRect().width + 20;
  if (!control) setX(width);
  scrim.classList.add("is-open");
  springTo(0);
  document.documentElement.style.overflow = "hidden";
  panel.querySelector<HTMLElement>("[data-inbox-close]")?.focus({ preventScroll: true });
  save(SEEN_KEY, Date.now());
}

function close(velocity = 0) {
  if (!panel || !scrim || !isOpen) return;
  isOpen = false;
  scrim.classList.remove("is-open");
  document.documentElement.style.overflow = "";
  springTo(width, velocity, () => {
    if (!isOpen) {
      panel.hidden = true;
      scrim.hidden = true;
      control = null;
    }
  });
  lastFocus?.focus?.({ preventScroll: true });
}

// Drag to dismiss: 1:1 to the right, rubber-banded to the left.
let dragStart = 0;
let dragHistory: { x: number; t: number }[] = [];
let dragging = false;
panel?.addEventListener("pointerdown", (e) => {
  if ((e.target as Element).closest("a, button") || e.pointerType === "mouse" && e.button !== 0) return;
  dragging = true;
  control?.stop();
  dragStart = e.clientX - x;
  dragHistory = [{ x: e.clientX, t: performance.now() }];
  panel.setPointerCapture(e.pointerId);
});
panel?.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  let next = e.clientX - dragStart;
  if (next < 0) next = -Math.sqrt(-next) * 2; // resist past fully open
  setX(next);
  const now = performance.now();
  dragHistory.push({ x: e.clientX, t: now });
  while (dragHistory.length > 2 && now - dragHistory[0].t > 100) dragHistory.shift();
});
const endDrag = () => {
  if (!dragging) return;
  dragging = false;
  const first = dragHistory[0];
  const last = dragHistory[dragHistory.length - 1];
  const v = first && last && last.t > first.t ? ((last.x - first.x) / (last.t - first.t)) * 1000 : 0; // px/s
  if (x > width * 0.35 || v > 500) close(v);
  else springTo(0, v);
};
panel?.addEventListener("pointerup", endDrag);
panel?.addEventListener("pointercancel", endDrag);

document.addEventListener("click", (e) => {
  const t = e.target as Element;
  if (t.closest("[data-open-inbox]")) {
    hideToast();
    open();
  } else if (t.closest("[data-inbox-close]") || t === scrim) {
    close();
  } else {
    const link = t.closest<HTMLElement>("[data-alert]");
    if (link) {
      read.add(link.dataset.alert!);
      link.classList.add("is-read");
      save(READ_KEY, [...read]);
      syncCounts();
    }
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && isOpen) close();
});
markAll?.addEventListener("click", () => {
  alerts.forEach((a) => read.add(a.id));
  save(READ_KEY, [...read]);
  list?.querySelectorAll("[data-alert]").forEach((el) => el.classList.add("is-read"));
  syncCounts();
});

/* ---------- Bell ring + toast ---------- */
const toast = document.querySelector<HTMLElement>("[data-toast]");
let toastTimer = 0;
function hideToast() {
  if (!toast || toast.hidden) return;
  toast.classList.add("is-leaving");
  window.setTimeout(() => {
    toast.hidden = true;
    toast.classList.remove("is-leaving");
  }, 240);
}

function greet() {
  const n = unread().length;
  if (!n) return;
  if (!reduceMotion) {
    document.querySelectorAll<HTMLElement>("[data-bell]").forEach((bell) =>
      animate(bell, { transform: ["rotate(0deg)", "rotate(14deg)", "rotate(-10deg)", "rotate(6deg)", "rotate(0deg)"] }, { duration: 0.7, ease: "easeOut" }),
    );
  }
  // The toast only speaks about alerts newer than the reader's last visit.
  const lastVisit = store<number>(SEEN_KEY, 0);
  const fresh = lastVisit
    ? unread().filter((a) => new Date(`${a.date}T23:59:59Z`).getTime() > lastVisit).length
    : 0;
  save(SEEN_KEY, Date.now());
  if (!toast || !fresh) return;
  const text = toast.querySelector("[data-toast-text]");
  if (text) text.textContent = `${fresh} new ${fresh === 1 ? "alert" : "alerts"} since your last visit`;
  toast.hidden = false;
  const start = () => {
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(hideToast, 6000);
  };
  // The timer pauses while the reader is looking at it, or away from the tab.
  toast.addEventListener("pointerenter", () => window.clearTimeout(toastTimer));
  toast.addEventListener("pointerleave", start);
  document.addEventListener("visibilitychange", () => (document.hidden ? window.clearTimeout(toastTimer) : start()));
  start();
}

renderList();
syncCounts();
// After the intro has had its moment.
window.setTimeout(greet, document.querySelector("[data-hero]") ? 2600 : 900);
