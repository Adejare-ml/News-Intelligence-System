/**
 * Where a named person or company can ask for a correction or removal.
 * Set PUBLIC_CORRECTIONS_URL at build time to use an email form or a
 * mailto: address; by default it opens a pre-filled issue on the public
 * repository.
 */
const DEFAULT = "https://github.com/Adejare-ml/News-Intelligence-System/issues/new";

export function correctionUrl(subject = ""): string {
  const base = import.meta.env.PUBLIC_CORRECTIONS_URL || DEFAULT;
  if (base.startsWith("mailto:")) {
    return `${base}${base.includes("?") ? "&" : "?"}subject=${encodeURIComponent(`Correction: ${subject}`.trim())}`;
  }
  if (base !== DEFAULT) return base;
  const title = encodeURIComponent(`Correction: ${subject}`.trim());
  const body = encodeURIComponent(
    "What is wrong, and what is correct (with a source if you have one):\n\n" +
      "Are you the person or company named? (yes / no)\n",
  );
  return `${DEFAULT}?labels=correction&title=${title}&body=${body}`;
}
