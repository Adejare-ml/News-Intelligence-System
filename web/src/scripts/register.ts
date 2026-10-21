/**
 * Register filters with FLIP layout animation: when the set of visible cards
 * changes, survivors glide from their old position to the new one (WAAPI,
 * transform only), newcomers fade up, leavers drop out instantly. Typing in
 * the search box filters without animation, since it fires on every key.
 */
const grid = document.querySelector<HTMLElement>("[data-grid]");
const cards = [...document.querySelectorAll<HTMLElement>("[data-holding]")];
const buttons = [...document.querySelectorAll<HTMLButtonElement>("[data-filter]")];
const search = document.querySelector<HTMLInputElement>("[data-register-search]");
const result = document.querySelector<HTMLElement>("[data-result]");
const empty = document.querySelector<HTMLElement>("[data-empty]");
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

let filter = "all";
let query = "";

function matches(card: HTMLElement): boolean {
  const d = card.dataset;
  if (filter === "stake" && d.stake !== "1") return false;
  if (filter === "pattern" && d.pattern !== "1") return false;
  if (filter === "band" && d.band !== "BAND_5_25") return false;
  if (filter === "multi" && d.multi !== "1") return false;
  if (query && !(d.search || "").includes(query)) return false;
  return true;
}

function apply(animate: boolean) {
  if (!grid) return;
  const before = new Map<HTMLElement, DOMRect>();
  if (animate) for (const c of cards) if (!c.hidden) before.set(c, c.getBoundingClientRect());

  let shown = 0;
  for (const c of cards) {
    const show = matches(c);
    c.hidden = !show;
    if (show) {
      shown++;
      // Filtering must never leave a card stuck at its pre-reveal opacity.
      c.classList.add("is-in");
    }
  }
  if (result) result.textContent = `${shown} ${shown === 1 ? "holding" : "holdings"}`;
  if (empty) empty.hidden = shown > 0;

  if (!animate || reduceMotion) return;
  for (const c of cards) {
    if (c.hidden) continue;
    const first = before.get(c);
    const last = c.getBoundingClientRect();
    if (first) {
      const dx = first.left - last.left;
      const dy = first.top - last.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      c.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
        duration: 420,
        easing: "cubic-bezier(0.23, 1, 0.32, 1)",
      });
    } else {
      c.animate(
        [{ opacity: 0, transform: "translateY(12px) scale(0.98)" }, { opacity: 1, transform: "none" }],
        { duration: 320, easing: "cubic-bezier(0.23, 1, 0.32, 1)" },
      );
    }
  }
}

buttons.forEach((btn) =>
  btn.addEventListener("click", () => {
    filter = btn.dataset.filter || "all";
    buttons.forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
    apply(true);
  }),
);

let typing = 0;
search?.addEventListener("input", () => {
  window.clearTimeout(typing);
  typing = window.setTimeout(() => {
    query = search.value.trim().toLowerCase();
    apply(false);
  }, 80);
});

document.querySelector("[data-clear]")?.addEventListener("click", () => {
  filter = "all";
  query = "";
  if (search) search.value = "";
  buttons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.filter === "all")));
  apply(true);
});

// Deep links: /register/?q=otedola or ?filter=band
const params = new URLSearchParams(location.search);
if (params.get("q") && search) {
  search.value = params.get("q")!;
  query = search.value.trim().toLowerCase();
}
const initial = params.get("filter");
if (initial && buttons.some((b) => b.dataset.filter === initial)) {
  filter = initial;
  buttons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.filter === initial)));
}
if (query || filter !== "all") apply(false);

export {};
