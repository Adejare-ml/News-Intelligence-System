/**
 * The page is built once per pipeline run, so "stale" decided at build time
 * goes wrong the moment a run is missed. The visitor's clock decides here.
 */
import { isStale, nextRunAfter, lagosTime } from "../lib/edition.ts";

const bar = document.querySelector<HTMLElement>("[data-edition-bar]");
const updatedAt = bar?.dataset.updated ? new Date(bar.dataset.updated) : null;

function refresh() {
  if (!bar) return;
  const now = new Date();
  const stale = isStale(updatedAt && !Number.isNaN(updatedAt.getTime()) ? updatedAt : null, now);
  bar.classList.toggle("stale", stale);
  const label = bar.querySelector<HTMLElement>("[data-live-label]");
  if (label) label.textContent = stale ? "Data may be out of date" : "Live edition";
  const note = bar.querySelector<HTMLElement>("[data-stale-note]");
  if (note) note.hidden = !stale;
  const next = bar.querySelector<HTMLTimeElement>("[data-next-run]");
  if (next) {
    const from = updatedAt && updatedAt.getTime() > now.getTime() - 36e5 * 9 ? updatedAt : now;
    let at = nextRunAfter(from);
    if (at.getTime() < now.getTime()) at = nextRunAfter(now);
    next.dateTime = at.toISOString();
    next.textContent = lagosTime(at);
  }
}

refresh();
// A tab left open overnight should notice too.
setInterval(refresh, 5 * 60_000);

export {};
