/**
 * Links to the official records a reader can check a company against.
 *
 * AURA's register is read from news reporting, so every company gets a way
 * to the primary sources: the CAC register, the procurement bureau's
 * contracts portal, the SEC and the exchange. These are plain links: the
 * site never fetches from them, so the CSP is untouched.
 */

export interface OfficialLink {
  key: "cac" | "nocopo" | "sec" | "ngx";
  label: string;
  href: string;
  /** What to search for once there. */
  note: string;
  /** The record most worth checking first for this company. */
  emphasis: boolean;
}

const SOURCES: Array<Omit<OfficialLink, "note" | "emphasis"> & { what: string }> = [
  { key: "cac", label: "CAC company search", href: "https://search.cac.gov.ng/home", what: "registration, directors and persons with significant control" },
  { key: "nocopo", label: "NOCOPO contracts (BPP)", href: "https://nocopo.bpp.gov.ng/", what: "federal contracts awarded" },
  { key: "sec", label: "SEC Nigeria", href: "https://sec.gov.ng/", what: "registrations and enforcement" },
  { key: "ngx", label: "NGX company profiles", href: "https://ngxgroup.com/exchange/data/company-profiles/", what: "listing and disclosures" },
];

// Only a public limited company can list on the Nigerian Exchange, so for
// a Plc the exchange's disclosures are the likeliest record to exist. The
// data says nothing firmer about which companies are listed.
const PUBLIC_COMPANY = /\bplc\b\.?$/i;

export function officialLinks(company: string): OfficialLink[] {
  const name = String(company ?? "").trim();
  if (!name) return [];
  const isPublic = PUBLIC_COMPANY.test(name);
  // None of these sites accepts a search in the URL, so each link carries
  // the name to type.
  const links = SOURCES.map(({ what, ...source }) => ({
    ...source,
    note: `Search for ${name}: ${what}.`,
    emphasis: isPublic && source.key === "ngx",
  }));
  return isPublic ? [...links.filter((l) => l.emphasis), ...links.filter((l) => !l.emphasis)] : links;
}
