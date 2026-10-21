/**
 * Site-wide behaviour, loaded on every page.
 *  - theme toggle (persisted, eased, no flash: theme-init.js applies it first)
 *  - header scroll-edge state
 *  - reveal-on-scroll and headline word splits (once per element)
 */

const root = document.documentElement;
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

function currentTheme(): "dark" | "light" {
  return root.getAttribute("data-theme") === "light" ? "light" : "dark";
}

function syncThemeButtons() {
  const next = currentTheme() === "light" ? "dark" : "light";
  document.querySelectorAll<HTMLButtonElement>("[data-theme-toggle]").forEach((btn) => {
    btn.setAttribute("aria-label", `Switch to ${next} theme`);
  });
}

function setTheme(theme: "dark" | "light") {
  const apply = () => {
    root.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("aura-theme", theme);
    } catch {
      /* private mode: the choice lasts for this page only */
    }
    syncThemeButtons();
    window.dispatchEvent(new CustomEvent("aura:theme", { detail: theme }));
  };
  // A cross-fade instead of an abrupt brightness jump.
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  if (doc.startViewTransition && !reduceMotion.matches) doc.startViewTransition(apply);
  else apply();
}

document.addEventListener("click", (event) => {
  const target = event.target as Element | null;
  if (target?.closest("[data-theme-toggle]")) {
    setTheme(currentTheme() === "light" ? "dark" : "light");
  }
});
syncThemeButtons();

// Header gains its scroll-edge fade only once content sits underneath it.
let scrolled = false;
const onScroll = () => {
  const now = window.scrollY > 8;
  if (now !== scrolled) {
    scrolled = now;
    root.classList.toggle("is-scrolled", now);
  }
};
window.addEventListener("scroll", onScroll, { passive: true });
onScroll();

/** Wrap each word of a [data-split] headline so it can rise from a clip. */
function splitWords(el: HTMLElement) {
  if (el.dataset.splitDone) return;
  el.dataset.splitDone = "1";
  const label = el.textContent?.trim() ?? "";
  let w = 0;
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const parts = (node.textContent ?? "").split(/(\s+)/);
      const frag = document.createDocumentFragment();
      for (const part of parts) {
        if (!part) continue;
        if (/^\s+$/.test(part)) {
          frag.append(part);
          continue;
        }
        const span = document.createElement("span");
        span.className = "word";
        span.style.setProperty("--w", String(w++));
        span.textContent = part;
        span.setAttribute("aria-hidden", "true");
        frag.append(span);
      }
      node.parentNode?.replaceChild(frag, node);
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      [...node.childNodes].forEach(walk);
    }
  };
  [...el.childNodes].forEach(walk);
  // Screen readers get the sentence once, not word by word.
  el.setAttribute("aria-label", label);
}

const revealTargets = document.querySelectorAll<HTMLElement>("[data-reveal], [data-split]");
document.querySelectorAll<HTMLElement>("[data-split]").forEach(splitWords);

if ("IntersectionObserver" in window) {
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-in");
        io.unobserve(entry.target);
      }
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
  );
  revealTargets.forEach((el) => {
    if (!el.hasAttribute("data-reveal-manual")) io.observe(el);
  });
} else {
  revealTargets.forEach((el) => el.classList.add("is-in"));
}

/** Let page scripts reveal manually-controlled elements (e.g. after the intro). */
export function revealNow(selector: string) {
  document.querySelectorAll<HTMLElement>(selector).forEach((el) => el.classList.add("is-in"));
}
