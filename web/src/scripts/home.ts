/**
 * Today page behaviour:
 *  - the globe intro (once per session; skippable; replayable from the footer)
 *  - the hero headline rising in as the globe forms
 *  - KPI counters rolling up with number-flow on first view
 *  - story cards tilting toward the pointer on a critically damped spring
 *  - images revealing once loaded, falling back to their generated cover
 *  - the Morning Brief sign-up form
 */
import "number-flow";
import { mountGlobe, type Route } from "./globe.ts";
import { Spring } from "./spring.ts";

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
const INTRO_KEY = "aura-intro-seen";

/* ---------- Globe + intro ---------- */
function introSeen(): boolean {
  try {
    return sessionStorage.getItem(INTRO_KEY) === "1";
  } catch {
    return false;
  }
}
function markIntroSeen() {
  try {
    sessionStorage.setItem(INTRO_KEY, "1");
  } catch {
    /* ignore */
  }
}

const hero = document.querySelector<HTMLElement>("[data-hero]");
const title = hero?.querySelector<HTMLElement>("[data-split]");
const canvas = document.querySelector<HTMLCanvasElement>("[data-globe]");
const routeData = document.getElementById("globe-routes");
let routes: Route[] | undefined;
try {
  routes = routeData ? (JSON.parse(routeData.textContent || "null") as Route[]) : undefined;
} catch {
  routes = undefined;
}

const playIntro = !reduceMotion && !introSeen();
let titleShown = false;
const showTitle = () => {
  if (titleShown) return;
  titleShown = true;
  title?.classList.add("is-in");
};

if (canvas) {
  const globe = mountGlobe(canvas, {
    routes,
    intro: playIntro,
    onIntroProgress: (p) => {
      // The headline rises as the planet finishes forming.
      if (p > 0.32) showTitle();
    },
    onIntroDone: () => {
      showTitle();
      markIntroSeen();
    },
  });
  if (!playIntro) showTitle();

  if (globe) {
    // Any key or click skips ahead; the intro never blocks anything.
    const skip = () => globe.skipIntro();
    window.addEventListener("keydown", skip, { once: true });

    document.querySelectorAll<HTMLElement>("[data-replay-intro]").forEach((btn) =>
      btn.addEventListener("click", () => {
        window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
        if (!reduceMotion) globe.replayIntro();
      }),
    );

    // Scroll-linked: the globe slows and tilts as the hero leaves.
    if (hero) {
      let ticking = false;
      const update = () => {
        ticking = false;
        const h = hero.offsetHeight || 1;
        globe.setScroll(window.scrollY / h);
      };
      window.addEventListener(
        "scroll",
        () => {
          if (!ticking) {
            ticking = true;
            requestAnimationFrame(update);
          }
        },
        { passive: true },
      );
    }
  }
} else {
  showTitle();
}
// Even with no canvas support the headline must appear.
setTimeout(showTitle, 2500);

/* ---------- KPI counters ---------- */
function upgradeCounters() {
  const els = document.querySelectorAll<HTMLElement>("[data-count]");
  if (reduceMotion || !("IntersectionObserver" in window)) return;
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        io.unobserve(entry.target);
        const el = entry.target as HTMLElement;
        const target = Number(el.dataset.count);
        if (!Number.isFinite(target)) continue;
        const flow = document.createElement("number-flow");
        flow.className = el.className;
        flow.setAttribute("aria-label", String(target));
        el.replaceWith(flow);
        flow.update(0);
        // Start after the intro has had a moment, so the eye lands on the globe first.
        setTimeout(() => flow.update(target), playIntro ? 900 : 150);
      }
    },
    { threshold: 0.4 },
  );
  els.forEach((el) => io.observe(el));
}
upgradeCounters();

/* ---------- Story card tilt ---------- */
function bindTilt(card: HTMLElement) {
  const rx = new Spring(0, 0.4);
  const ry = new Spring(0, 0.4);
  const press = new Spring(1, 0.18);
  let raf = 0;
  let last = 0;
  const MAX = 4; // degrees

  const loop = (now: number) => {
    const dt = last ? Math.min((now - last) / 1000, 0.05) : 0.016;
    last = now;
    const a = rx.step(dt);
    const b = ry.step(dt);
    const c = press.step(dt);
    card.style.transform = `perspective(1200px) rotateX(${rx.value.toFixed(3)}deg) rotateY(${ry.value.toFixed(3)}deg) scale(${press.value.toFixed(4)})`;
    if (a || b || c) raf = requestAnimationFrame(loop);
    else {
      raf = 0;
      last = 0;
      if (rx.value === 0 && ry.value === 0 && press.value === 1) card.style.transform = "";
    }
  };
  const kick = () => {
    if (!raf) raf = requestAnimationFrame(loop);
  };

  card.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse") return;
    const r = card.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width - 0.5;
    const py = (e.clientY - r.top) / r.height - 0.5;
    ry.target = px * MAX * 2;
    rx.target = -py * MAX * 2;
    kick();
  });
  card.addEventListener("pointerleave", () => {
    rx.target = 0;
    ry.target = 0;
    press.target = 1;
    kick();
  });
  card.addEventListener("pointerdown", () => {
    press.target = 0.975;
    kick();
  });
  const release = () => {
    press.target = 1;
    kick();
  };
  card.addEventListener("pointerup", release);
  card.addEventListener("pointercancel", release);
}
if (finePointer && !reduceMotion) {
  document.querySelectorAll<HTMLElement>("[data-tilt]").forEach(bindTilt);
}

/* ---------- Images ---------- */
document.querySelectorAll<HTMLImageElement>("img[data-story-img]").forEach((img) => {
  const done = () => img.classList.add("is-loaded");
  const fail = () => img.remove(); // the generated cover underneath stays
  if (img.complete) {
    if (img.naturalWidth > 0) done();
    else fail();
  } else {
    img.addEventListener("load", done, { once: true });
    img.addEventListener("error", fail, { once: true });
  }
});

/* ---------- Morning Brief sign-up ---------- */
document.querySelectorAll<HTMLFormElement>("form[data-subscribe]").forEach((form) => {
  const status = form.querySelector<HTMLElement>("[data-subscribe-status]");
  const input = form.querySelector<HTMLInputElement>('input[type="email"]');
  const say = (msg: string, kind: "ok" | "error" | "" = "") => {
    if (!status) return;
    status.textContent = msg;
    status.classList.toggle("ok", kind === "ok");
    status.classList.toggle("error", kind === "error");
  };
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = input?.value.trim() || "";
    if (!input || !input.checkValidity() || !email) {
      say("That email address doesn’t look right.", "error");
      input?.focus();
      return;
    }
    form.classList.add("is-busy");
    say("Adding you to the list…");
    try {
      const res = await fetch(form.action, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ email, company_site: (form.elements.namedItem("company_site") as HTMLInputElement)?.value || "" }),
      });
      if (res.status === 404 || res.status === 405) {
        say("Sign-ups open very soon. The brief is already live at the top of this page.", "");
      } else if (res.ok) {
        form.classList.add("is-done");
        say("You’re on the list. Check your inbox to confirm.", "ok");
        input.value = "";
      } else {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        say(body.error || "Something went wrong. Please try again in a moment.", "error");
      }
    } catch {
      say("You seem to be offline. Please try again.", "error");
    } finally {
      form.classList.remove("is-busy");
    }
  });
});
