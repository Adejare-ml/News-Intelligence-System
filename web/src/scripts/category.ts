/**
 * Category pages: switch between the Nigeria and Global editions. Without
 * JavaScript both lists simply show, one after the other.
 */
const buttons = [...document.querySelectorAll<HTMLButtonElement>("[data-region-btn]")];
const panels = [...document.querySelectorAll<HTMLElement>("[data-region-panel]")];
const bar = document.querySelector<HTMLElement>("[data-region-switch]");

function show(region: string): void {
  for (const b of buttons) b.setAttribute("aria-pressed", String(b.dataset.regionBtn === region));
  for (const p of panels) p.hidden = p.dataset.regionPanel !== region;
}

if (bar && buttons.length && panels.length) {
  bar.hidden = false;
  for (const b of buttons) b.addEventListener("click", () => show(b.dataset.regionBtn!));
  show(buttons[0].dataset.regionBtn!);
}
