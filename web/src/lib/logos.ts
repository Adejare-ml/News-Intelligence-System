/**
 * Organisation logos for story and entity banners.
 *
 * Logos are fetched at deploy time (scripts/fetch-logos.mjs) from each
 * organisation's own site into public/logos/<key>.png, and only files that
 * exist at build time are used: a story with no known organisation, or
 * whose logo could not be fetched, gets a plain typographic card instead.
 * Logos identify the organisation a story is about; nothing more is implied.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export interface LogoEntry {
  key: string;
  name: string;
  domain: string;
  /** Whole-word names and abbreviations the reporting uses for it. */
  aliases: string[];
}

export const LOGOS: LogoEntry[] = [
  { key: "efcc", name: "EFCC", domain: "efcc.gov.ng", aliases: ["EFCC", "Economic and Financial Crimes Commission"] },
  { key: "icpc", name: "ICPC", domain: "icpc.gov.ng", aliases: ["ICPC", "Independent Corrupt Practices"] },
  { key: "cbn", name: "Central Bank of Nigeria", domain: "cbn.gov.ng", aliases: ["CBN", "Central Bank of Nigeria"] },
  { key: "nnpc", name: "NNPC", domain: "nnpcgroup.com", aliases: ["NNPC", "NNPCL", "Nigerian National Petroleum"] },
  { key: "faan", name: "FAAN", domain: "faan.gov.ng", aliases: ["FAAN", "Federal Airports Authority"] },
  { key: "ncc", name: "Nigerian Communications Commission", domain: "ncc.gov.ng", aliases: ["NCC", "Nigerian Communications Commission"] },
  { key: "nafdac", name: "NAFDAC", domain: "nafdac.gov.ng", aliases: ["NAFDAC"] },
  { key: "sec", name: "Securities and Exchange Commission", domain: "sec.gov.ng", aliases: ["Securities and Exchange Commission", "SEC Nigeria"] },
  { key: "customs", name: "Nigeria Customs Service", domain: "customs.gov.ng", aliases: ["Nigeria Customs", "Customs Service", "Customs", "NCS"] },
  { key: "firs", name: "FIRS", domain: "firs.gov.ng", aliases: ["FIRS", "Federal Inland Revenue", "Nigeria Revenue Service"] },
  { key: "ngx", name: "Nigerian Exchange", domain: "ngxgroup.com", aliases: ["NGX", "Nigerian Exchange"] },
  { key: "npa", name: "Nigerian Ports Authority", domain: "nigerianports.gov.ng", aliases: ["NPA", "Nigerian Ports Authority"] },
  { key: "nimasa", name: "NIMASA", domain: "nimasa.gov.ng", aliases: ["NIMASA"] },
  { key: "ndic", name: "NDIC", domain: "ndic.gov.ng", aliases: ["NDIC"] },
  { key: "pencom", name: "PenCom", domain: "pencom.gov.ng", aliases: ["PenCom", "National Pension Commission"] },
  { key: "inec", name: "INEC", domain: "inecnigeria.org", aliases: ["INEC"] },
  { key: "nimc", name: "NIMC", domain: "nimc.gov.ng", aliases: ["NIMC"] },
  { key: "dangote", name: "Dangote Group", domain: "dangote.com", aliases: ["Dangote"] },
  { key: "bua", name: "BUA Group", domain: "buagroup.com", aliases: ["BUA"] },
  { key: "mtn", name: "MTN Nigeria", domain: "mtn.ng", aliases: ["MTN"] },
  { key: "airtel", name: "Airtel Africa", domain: "airtel.com.ng", aliases: ["Airtel"] },
  { key: "access", name: "Access Holdings", domain: "accessbankplc.com", aliases: ["Access Bank", "Access Holdings"] },
  { key: "zenith", name: "Zenith Bank", domain: "zenithbank.com", aliases: ["Zenith Bank"] },
  { key: "uba", name: "UBA", domain: "ubagroup.com", aliases: ["UBA", "United Bank for Africa"] },
  { key: "firstbank", name: "First HoldCo", domain: "firstbanknigeria.com", aliases: ["First HoldCo", "FirstHoldCo", "First Bank", "FirstBank", "FBN Holdings"] },
  { key: "gtco", name: "GTCO", domain: "gtcoplc.com", aliases: ["GTCO", "GTBank", "Guaranty Trust"] },
  { key: "seplat", name: "Seplat Energy", domain: "seplatenergy.com", aliases: ["Seplat"] },
  { key: "oando", name: "Oando", domain: "oandoplc.com", aliases: ["Oando"] },
  { key: "kuda", name: "Kuda", domain: "kuda.com", aliases: ["Kuda"] },
  { key: "afdb", name: "African Development Bank", domain: "afdb.org", aliases: ["AfDB", "African Development Bank"] },
  { key: "worldbank", name: "World Bank", domain: "worldbank.org", aliases: ["World Bank"] },
  { key: "imf", name: "IMF", domain: "imf.org", aliases: ["IMF", "International Monetary Fund"] },
  { key: "ifc", name: "IFC", domain: "ifc.org", aliases: ["IFC", "International Finance Corporation"] },
  { key: "afreximbank", name: "Afreximbank", domain: "afreximbank.com", aliases: ["Afreximbank"] },
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const boundary = (alts: string[]) => `(?:^|[^A-Za-z0-9])(?:${alts.map(escapeRe).join("|")})(?![A-Za-z0-9])`;
// Abbreviations match case-sensitively ("NCC", not "ncc" inside a word);
// full names match without case.
const MATCHERS = LOGOS.map((l) => {
  const abbr = l.aliases.filter((a) => a === a.toUpperCase());
  const names = l.aliases.filter((a) => a !== a.toUpperCase());
  return {
    entry: l,
    res: [abbr.length ? new RegExp(boundary(abbr)) : null, names.length ? new RegExp(boundary(names), "i") : null]
      .filter((r): r is RegExp => r !== null),
  };
});

/** First organisation named in the given texts (most important text first). */
export function matchOrganisation(texts: string[]): LogoEntry | null {
  for (const text of texts) {
    if (!text) continue;
    let best: { entry: LogoEntry; at: number } | null = null;
    for (const m of MATCHERS) {
      for (const re of m.res) {
        const hit = re.exec(text);
        if (hit && (best === null || hit.index < best.at)) best = { entry: m.entry, at: hit.index };
      }
    }
    if (best) return best.entry;
  }
  return null;
}

const LOGO_DIR = resolve(process.cwd(), "public/logos");
const present = new Map<string, boolean>();

/** True when the deploy fetched this organisation's logo. */
export function hasLogo(key: string): boolean {
  if (!present.has(key)) present.set(key, existsSync(resolve(LOGO_DIR, `${key}.png`)));
  return present.get(key)!;
}

/** The logo for a story or entity, or null when there is none to show. */
export function logoFor(texts: string[]): { key: string; name: string; path: string } | null {
  const org = matchOrganisation(texts);
  if (!org || !hasLogo(org.key)) return null;
  return { key: org.key, name: org.name, path: `logos/${org.key}.png` };
}
