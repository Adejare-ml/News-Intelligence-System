/** News filters: topic chips, risk and publisher selects, and text search. */
const items = [...document.querySelectorAll<HTMLElement>("[data-story]")];
const days = [...document.querySelectorAll<HTMLElement>("[data-day]")];
const chips = [...document.querySelectorAll<HTMLButtonElement>("[data-cat]")].filter((el) => el.tagName === "BUTTON");
const risk = document.querySelector<HTMLSelectElement>("[data-risk]");
const source = document.querySelector<HTMLSelectElement>("[data-source]");
const search = document.querySelector<HTMLInputElement>("[data-news-search]");
const result = document.querySelector<HTMLElement>("[data-news-result]");
const empty = document.querySelector<HTMLElement>("[data-news-empty]");

let cat = "all";

function apply() {
  const q = (search?.value || "").trim().toLowerCase();
  const r = risk?.value || "all";
  const src = source?.value || "all";
  let shown = 0;
  for (const el of items) {
    const d = el.dataset;
    const ok =
      (cat === "all" || d.cat === cat) &&
      (r === "all" || (r === "critical" ? d.level === "critical" : d.level === "critical" || d.level === "high")) &&
      (src === "all" || d.source === src) &&
      (!q || (d.text || "").includes(q));
    el.hidden = !ok;
    if (ok) {
      shown++;
      el.classList.add("is-in");
    }
  }
  for (const day of days) day.hidden = !day.querySelector("[data-story]:not([hidden])");
  if (result) result.textContent = `${shown} ${shown === 1 ? "story" : "stories"}`;
  if (empty) empty.hidden = shown > 0;
}

chips.forEach((chip) =>
  chip.addEventListener("click", () => {
    cat = chip.dataset.cat || "all";
    chips.forEach((c) => c.setAttribute("aria-pressed", String(c === chip)));
    apply();
  }),
);
risk?.addEventListener("change", apply);
source?.addEventListener("change", apply);
let t = 0;
search?.addEventListener("input", () => {
  window.clearTimeout(t);
  t = window.setTimeout(apply, 80);
});

document.querySelectorAll<HTMLImageElement>("img[data-story-img]").forEach((img) => {
  const fail = () => img.remove();
  if (img.complete && img.naturalWidth === 0) fail();
  else img.addEventListener("error", fail, { once: true });
});

export {};
