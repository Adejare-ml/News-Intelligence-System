/**
 * Procurement rows (procurement.json) made readable: amounts formatted the
 * way Nigerian business press writes them, placeholders treated as unknown,
 * and the publisher suffix dropped from project titles.
 */
import { cleanTitle, publisherName } from "./stories.ts";

export interface ProcurementRow {
  Agency?: string;
  Contractor?: string;
  Amount?: string;
  Project?: string;
  Source?: string;
  Date?: string;
  "Amount Value"?: number | null;
  "Amount Currency"?: string | null;
}

export interface Contract {
  agency: string;
  contractor: string;
  project: string;
  source: string;
  date: string;
  amount: number | null;
  currency: string | null;
  amountLabel: string;
}

const EMPTY = new Set(["", "none", "n/a", "null", "unknown", "not disclosed"]);

export function known(value: unknown): string {
  const text = String(value ?? "").trim();
  if (EMPTY.has(text.toLowerCase()) || /^tbd\b/i.test(text)) return "";
  return text;
}

const SYMBOL: Record<string, string> = { NGN: "₦", USD: "$", GBP: "£", EUR: "€" };

/** 104489205000 USD -> "$104bn"; 4_250_000_000 NGN -> "₦4.25bn"; 100e9 -> "₦100bn". */
export function formatAmount(value: number | null | undefined, currency: string | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return "";
  const sym = SYMBOL[String(currency || "").toUpperCase()] ?? `${currency ?? ""} `;
  const units: [number, string][] = [[1e12, "trn"], [1e9, "bn"], [1e6, "m"], [1e3, "k"]];
  for (const [size, suffix] of units) {
    if (value >= size) {
      const n = value / size;
      const digits = n >= 100 ? 0 : 2;
      // Trim trailing zeros after the decimal point only ("4.50" -> "4.5", "100" stays).
      const text = digits ? n.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "") : n.toFixed(0);
      return `${sym}${text}${suffix}`;
    }
  }
  return `${sym}${Math.round(value).toLocaleString("en-NG")}`;
}

export function toContract(row: ProcurementRow): Contract {
  const amount = typeof row["Amount Value"] === "number" ? row["Amount Value"] : null;
  const currency = row["Amount Currency"] ?? null;
  const source = publisherName(known(row.Source));
  return {
    agency: known(row.Agency) || "Unnamed agency",
    contractor: known(row.Contractor),
    project: cleanTitle(known(row.Project), known(row.Source)).title,
    source,
    date: known(row.Date).slice(0, 10),
    amount,
    currency,
    amountLabel: formatAmount(amount, currency),
  };
}

/** Disclosed values first (largest first), then the rest newest first. */
export function sortContracts(list: Contract[]): Contract[] {
  return [...list].sort((a, b) => {
    if ((a.amount !== null) !== (b.amount !== null)) return a.amount !== null ? -1 : 1;
    if (a.amount !== null && b.amount !== null && a.currency === b.currency) return b.amount - a.amount;
    if (a.amount !== null && b.amount !== null) return String(a.currency).localeCompare(String(b.currency));
    return b.date.localeCompare(a.date);
  });
}

/** Share of rows where a field is known; used to decide whether a column earns its place. */
export function coverage(list: Contract[], pick: (c: Contract) => string): number {
  if (!list.length) return 0;
  return list.filter((c) => pick(c) !== "").length / list.length;
}
