/**
 * Remembers that the reader closed the "New to AURA?" explainer, so a
 * returning reader is not shown it again. public/theme-init.js reads the
 * same key before first paint and marks <html> with .explainer-closed.
 */
export const EXPLAINER_KEY = "aura-explainer";

/**
 * Storage is passed as a getter because merely reading window.localStorage
 * throws when the browser blocks it; that, like a failed write, just means
 * the choice lasts for this page only.
 */
export function saveClosed(storage: () => Storage, closed: boolean): void {
  try {
    if (closed) storage().setItem(EXPLAINER_KEY, "closed");
    else storage().removeItem(EXPLAINER_KEY);
  } catch {
    /* storage blocked */
  }
}
