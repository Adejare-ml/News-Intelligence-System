/**
 * CSV for the downloads (/downloads/*.csv). Pure, so it is tested without a build.
 *
 * Headlines and names come from the open web. A cell that starts with "="
 * (or + - @, tab, CR) is run as a formula when the file is opened in Excel
 * or Google Sheets, so such text cells get a leading apostrophe: the
 * spreadsheet then shows the text instead of running it.
 */

const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  // A real number is never a formula; only text needs the guard.
  let text = String(value);
  if (typeof value !== "number" && FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Header row plus one line per row, CRLF line endings as RFC 4180 asks. */
export function toCsv(headers: string[], rows: unknown[][]): string {
  return [headers, ...rows].map((row) => row.map(csvCell).join(",") + "\r\n").join("");
}
