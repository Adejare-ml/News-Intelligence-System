/**
 * Open and close the "New to AURA?" explainer. The heading ships as plain
 * text; this swaps it for a real button, so the toggle only exists once it
 * can work. theme-init.js has already applied a saved "closed" state before
 * paint, so this only syncs the button and saves the reader's next choice.
 */
import { saveClosed } from "../lib/explainer.ts";

const root = document.documentElement;

document.querySelectorAll<HTMLElement>("[data-explainer-toggle]").forEach((label) => {
  const btn = document.createElement("button");
  btn.type = "button";
  // Copying every attribute keeps the class and Astro's scoped-style marker.
  for (const { name, value } of [...label.attributes]) btn.setAttribute(name, value);
  btn.append(...label.childNodes);
  label.replaceWith(btn);
  btn.setAttribute("aria-controls", "explainer-body");
  btn.setAttribute("aria-expanded", String(!root.classList.contains("explainer-closed")));
  btn.addEventListener("click", () => {
    const closed = root.classList.toggle("explainer-closed");
    btn.setAttribute("aria-expanded", String(!closed));
    saveClosed(() => localStorage, closed);
  });
});
