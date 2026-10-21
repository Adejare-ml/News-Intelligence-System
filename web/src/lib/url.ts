/** Site-relative URL that respects the deploy base path (/ or /News-Intelligence-System/). */
export function href(path = ""): string {
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  const clean = String(path).replace(/^\//, "");
  return `${base}/${clean}`;
}

/** True when `path` is the current page or one of its children. */
export function isActive(current: string, path: string): boolean {
  const target = href(path).replace(/\/$/, "");
  const here = current.replace(/\/$/, "");
  if (path === "" || path === "/") return here === target || here === "";
  return here === target || here.startsWith(`${target}/`);
}

/**
 * Lead-image URL. On Cloudflare (PUBLIC_IMG_PROXY=1) images go through the
 * /img function so the browser never contacts the publisher; elsewhere
 * (the GitHub Pages mirror has no functions) the publisher URL is used.
 */
export function imageSrc(url: string): string {
  if (!url) return "";
  return import.meta.env.PUBLIC_IMG_PROXY === "1" ? href(`img?u=${encodeURIComponent(url)}`) : url;
}
