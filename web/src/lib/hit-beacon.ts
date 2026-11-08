/**
 * The logic behind scripts/hit.ts, kept free of the browser so it can be
 * tested: whether to count this page view at all, and what to send.
 */

/** The navigator fields that carry a reader's privacy choices. */
export interface PrivacySignals {
  doNotTrack?: string | null;
  globalPrivacyControl?: boolean;
}

/**
 * False when the reader has asked not to be tracked (Do Not Track or Global
 * Privacy Control), and on the GitHub Pages copy: it is served under a base
 * path and has no Pages Functions to receive a count.
 */
export function trackingAllowed(nav: PrivacySignals, base: string): boolean {
  return base === "/" && nav.doNotTrack !== "1" && nav.globalPrivacyControl !== true;
}

/**
 * The beacon body for this page (its path, plus the ?src= tag a Morning Brief
 * link carries), and the address to show without that tag, or null when
 * there was none to remove. Dropping it keeps shared links clean, so a
 * forwarded link is not counted as another email click.
 */
export function pageHit(loc: { pathname: string; search: string; hash: string }): {
  body: { p: string; s?: string };
  cleanUrl: string | null;
} {
  const params = new URLSearchParams(loc.search);
  const source = params.get("src");
  if (source === null) return { body: { p: loc.pathname }, cleanUrl: null };
  params.delete("src");
  const rest = params.toString();
  return {
    body: { p: loc.pathname, s: source },
    cleanUrl: `${loc.pathname}${rest ? `?${rest}` : ""}${loc.hash}`,
  };
}
