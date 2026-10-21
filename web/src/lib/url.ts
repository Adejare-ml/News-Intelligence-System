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
