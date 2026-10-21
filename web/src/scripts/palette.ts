/**
 * ⌘K palette. Opens instantly (no animation: it is keyboard-driven and
 * used often), fetches the index on first open, and is fully keyboard
 * navigable. Native <dialog> provides the focus trap and Escape.
 */
import { search, group, type Entry } from "../lib/search.ts";

const dialog = document.querySelector<HTMLDialogElement>("[data-palette]");
const input = dialog?.querySelector<HTMLInputElement>("[data-palette-input]");
const results = dialog?.querySelector<HTMLElement>("[data-palette-results]");
let index: Entry[] | null = null;
let loading: Promise<void> | null = null;
let active = 0;

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function highlight(label: string, q: string): string {
  const i = label.toLowerCase().indexOf(q.toLowerCase());
  if (!q || i < 0) return esc(label);
  return esc(label.slice(0, i)) + "<mark>" + esc(label.slice(i, i + q.length)) + "</mark>" + esc(label.slice(i + q.length));
}

function load(): Promise<void> {
  if (index) return Promise.resolve();
  if (!loading) {
    loading = fetch(dialog!.dataset.index!)
      .then((r) => (r.ok ? r.json() : []))
      .then((list: Entry[]) => {
        index = list;
      })
      .catch(() => {
        index = [];
      });
  }
  return loading;
}

function links(): HTMLAnchorElement[] {
  return [...(results?.querySelectorAll<HTMLAnchorElement>("a[role=option]") ?? [])];
}

function select(i: number) {
  const all = links();
  if (!all.length) return;
  active = (i + all.length) % all.length;
  all.forEach((a, n) => a.setAttribute("aria-selected", String(n === active)));
  all[active].scrollIntoView({ block: "nearest" });
  input?.setAttribute("aria-activedescendant", all[active].id);
}

function render() {
  if (!results || !input) return;
  const q = input.value.trim();
  if (!q) {
    results.innerHTML = '<p class="hint">Try a name like “Dangote”, a company like “Zenith”, or a word like “EFCC”.</p>';
    return;
  }
  if (!index) {
    results.innerHTML = '<p class="hint">Loading…</p>';
    return;
  }
  const groups = group(search(index, q));
  if (!groups.length) {
    results.innerHTML = `<p class="hint">Nothing found for “${esc(q)}”.</p>`;
    return;
  }
  let n = 0;
  results.innerHTML = groups
    .map((g) =>
      `<p class="group-label">${esc(g.label)}</p>` +
      g.items
        .map((e) => {
          const external = /^https?:/.test(e.u);
          return `<a role="option" id="pr-${n++}" href="${esc(e.u)}"${external ? ' target="_blank" rel="noopener noreferrer"' : ""}>` +
            `<span class="r-label">${highlight(e.l, q)}</span><span class="r-sub">${esc(e.s)}</span></a>`;
        })
        .join(""),
    )
    .join("");
  select(0);
}

export function openPalette() {
  if (!dialog || dialog.open) return;
  dialog.showModal();
  input?.focus();
  input?.select();
  load().then(render);
}

function closePalette() {
  dialog?.close();
}

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if (dialog?.open) closePalette();
    else openPalette();
  } else if (e.key === "/" && !dialog?.open && !(e.target as HTMLElement)?.closest("input, textarea, [contenteditable]")) {
    e.preventDefault();
    openPalette();
  }
});

document.addEventListener("click", (e) => {
  if ((e.target as Element)?.closest("[data-open-search]")) openPalette();
});

input?.addEventListener("input", () => {
  load().then(render);
  render();
});
input?.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    select(active + 1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    select(active - 1);
  } else if (e.key === "Enter") {
    const target = links()[active];
    if (target) {
      e.preventDefault();
      target.click();
      closePalette();
    }
  }
});
// Clicking the backdrop (the dialog element itself) closes it.
dialog?.addEventListener("click", (e) => {
  if (e.target === dialog) closePalette();
});
