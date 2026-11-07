/**
 * Open and close the "New to AURA?" explainer. theme-init.js has already
 * applied a saved "closed" state before paint, so this only syncs the
 * button and saves the reader's next choice.
 */
import { saveClosed } from "../lib/explainer.ts";

const root = document.documentElement;

document.querySelectorAll<HTMLButtonElement>("[data-explainer-toggle]").forEach((btn) => {
  btn.setAttribute("aria-expanded", String(!root.classList.contains("explainer-closed")));
  btn.addEventListener("click", () => {
    const closed = root.classList.toggle("explainer-closed");
    btn.setAttribute("aria-expanded", String(!closed));
    saveClosed(() => localStorage, closed);
  });
});
