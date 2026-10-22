/**
 * Persons with Significant Control: Nigerian disclosure bands, the
 * patterns worth checking, and holdings grouped from repeated reports.
 *
 * Ported from the legacy js/psc-core.js. The rules are unchanged; the
 * user-facing wording is softer ("pattern worth checking", not "red flag")
 * because every record here is extracted from news reporting, not a filing.
 *
 * Jurisdiction note: Nigeria's PSC threshold is 5%, not 25%. CAMA 2020
 * s.868 with the CAC PSC Regulations 2022 makes anyone with at least 5% of
 * shares or voting rights a Person with Significant Control.
 */

export type PscRecord = Record<string, unknown>;

export interface Band {
  id: string;
  floor: number;
  label: string;
  short: string;
  tone: "critical" | "high" | "elevated" | "nigeria" | "muted";
}

export interface Flag {
  id: string;
  severity: "high" | "medium";
  title: string;
  detail: string;
}

export const BANDS: Band[] = [
  { id: "BAND_75_100", floor: 75, label: "75–100%", short: "75+", tone: "critical" },
  { id: "BAND_50_75", floor: 50, label: "50–75%", short: "50–75", tone: "high" },
  { id: "BAND_25_50", floor: 25, label: "25–50%", short: "25–50", tone: "elevated" },
  { id: "BAND_5_25", floor: 5, label: "5–25%", short: "5–25", tone: "nigeria" },
  { id: "BELOW_THRESHOLD", floor: 0, label: "Below 5%", short: "<5", tone: "muted" },
];

export const BAND_BY_ID: Record<string, Band> = Object.fromEntries(BANDS.map((b) => [b.id, b]));

export const SECRECY_JURISDICTIONS = [
  "mauritius", "cayman", "british virgin", "bvi", "jersey", "guernsey",
  "isle of man", "panama", "seychelles", "bahamas", "bermuda", "belize",
  "liechtenstein", "gibraltar", "delaware", "luxembourg", "cyprus",
  "marshall islands", "samoa", "curacao", "offshore",
];

const NOMINEE_MARKERS = ["nominee", "nominees", "trustee", "trust ", "proxy", "custodian"];

/** "28.5%", " 28.5 ", 28.5 -> 28.5; null when nothing was disclosed. */
export function toPercent(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const text = String(value).replace("%", "").trim();
  if (!text) return null;
  const num = Number(text);
  return Number.isFinite(num) ? num : null;
}

export function classifyBand(value: unknown): Band | null {
  const pct = toPercent(value);
  if (pct === null) return null;
  for (const band of BANDS) if (pct >= band.floor) return band;
  return BAND_BY_ID.BELOW_THRESHOLD;
}

export function bandFor(record: PscRecord | null | undefined): Band | null {
  const stored = record?.["Share Band"];
  if (typeof stored === "string" && BAND_BY_ID[stored]) return BAND_BY_ID[stored];
  return classifyBand(record?.Percentage);
}

function textOf(record: PscRecord, key: string): string {
  return String(record?.[key] ?? "").toLowerCase();
}

/**
 * The pipeline's validation gate exports canonical keys ("Alhaji Aliko
 * Dangote" and "Aliko Dangote" share one); older rows fall back to the name.
 */
export function personKey(record: PscRecord | null | undefined): string {
  const canon = String(record?.["Person Key"] ?? "").trim();
  return canon || String(record?.["Person Name"] ?? "").trim().toLowerCase();
}

export function companyKey(record: PscRecord | null | undefined): string {
  const canon = String(record?.["Company Key"] ?? "").trim();
  return canon || String(record?.Company ?? "").trim().toLowerCase();
}

/** Held back by the gate as implausible (a footballer "controlling" a business). */
export function isQuarantined(record: PscRecord | null | undefined): boolean {
  const q = record?.Quarantined;
  return q === true || String(q).toLowerCase() === "true";
}

/**
 * The publishing contract: a row reaches a page only if it names a source
 * and the validation gate did not quarantine it. A "no source" label next
 * to a named person and a stake would still publish the claim, so such
 * rows are never shown, only counted (register_quality.json).
 */
export function isPublic(record: PscRecord | null | undefined): boolean {
  if (!record || isQuarantined(record)) return false;
  // "Source" only says how the row was made ("extracted", "seed"); a claim is
  // published only with a link to the article that reported it.
  return /^https?:\/\//.test(String(record["Source URL"] ?? "").trim());
}

export function publicRecords(records: PscRecord[]): PscRecord[] {
  return (records || []).filter(isPublic);
}

function sourceOf(record: PscRecord): string {
  const s = String(record?.Source ?? "").trim();
  return PLACEHOLDER.has(s.toLowerCase()) ? "" : s;
}

const ROLE_WORDS = /\b(chairman|chairperson|chair|founder|co-?founder|director|ceo|chief executive|managing director|president)\b/i;
const STAKE_WORDS = /\b(shares?|shareholding|voting|ownership|owns?|equity|stake)\b/i;

/** What a row claims: a stake, a board role, or control with neither. */
export function kindOf(record: PscRecord): HoldingKind {
  const stored = String(record?.Kind ?? "").trim();
  if (stored === "stake" || stored === "role" || stored === "influence") return stored;
  if (toPercent(record?.Percentage) !== null) return "stake";
  const nature = String(record?.["Nature of Control"] ?? "");
  if (STAKE_WORDS.test(nature)) return "stake";
  const role = String(record?.["Board Role"] ?? "").trim();
  if ((role && !PLACEHOLDER.has(role.toLowerCase()) && ROLE_WORDS.test(role)) || ROLE_WORDS.test(nature)) return "role";
  return "influence";
}

export function isDirectHolding(text: unknown): boolean {
  const t = String(text ?? "").trim().toLowerCase();
  return !t || t === "direct holding" || t === "direct shareholder" || t === "direct" || t === "n/a";
}

export interface Context {
  byPerson: Record<string, PscRecord[]>;
  byCompany: Record<string, PscRecord[]>;
}

export function buildContext(records: PscRecord[]): Context {
  const byPerson: Record<string, PscRecord[]> = {};
  const byCompany: Record<string, PscRecord[]> = {};
  for (const r of records || []) {
    const p = personKey(r);
    const c = companyKey(r);
    if (p) (byPerson[p] ||= []).push(r);
    if (c) (byCompany[c] ||= []).push(r);
  }
  return { byPerson, byCompany };
}

/** Distinct companies (not rows) one person holds control in. */
export function companiesFor(record: PscRecord, context?: Context): string[] {
  const ctx = context || buildContext([record]);
  const seen = new Set<string>();
  for (const r of ctx.byPerson[personKey(record)] || []) {
    const c = companyKey(r);
    if (c) seen.add(c);
  }
  return [...seen];
}

type Rule = { id: string; run: (r: PscRecord, ctx: Context) => Omit<Flag, "id"> | null };

const RULES: Rule[] = [
  {
    id: "R1_SUB_THRESHOLD",
    run(record, ctx) {
      const pct = toPercent(record.Percentage);
      if (pct === null || pct >= 5 || pct < 3.5) return null;
      const parked = (ctx.byCompany[companyKey(record)] || []).filter((r) => {
        const p = toPercent(r.Percentage);
        return p !== null && p >= 3.5 && p < 5;
      });
      if (parked.length < 2) return null;
      return {
        severity: "high",
        title: "Several holders just under 5%",
        detail: `${parked.length} holders in this company sit between 3.5% and 5%, just under the CAMA 2020 s.868 disclosure threshold.`,
      };
    },
  },
  {
    id: "R3_VOTING_MISMATCH",
    run(record) {
      const shares = toPercent(record["Direct %"]);
      const indirect = toPercent(record["Indirect %"]);
      const equity = shares === null && indirect === null
        ? toPercent(record.Percentage)
        : (shares || 0) + (indirect || 0);
      const voting = toPercent(record["Voting Rights %"]);
      if (equity === null || voting === null) return null;
      const gap = voting - equity;
      if (gap < 20) return null;
      return {
        severity: "high",
        title: "Voting rights exceed equity",
        detail: `Reported voting rights of ${voting.toFixed(1)}% against an equity interest of ${equity.toFixed(1)}%, a ${gap.toFixed(1)} point gap.`,
      };
    },
  },
  {
    id: "R7_SECRECY_VEHICLE",
    run(record) {
      const vehicle = textOf(record, "Intermediate Entities");
      if (isDirectHolding(vehicle)) return null;
      const hit = SECRECY_JURISDICTIONS.find((j) => vehicle.includes(j));
      if (!hit) return null;
      return {
        severity: "high",
        title: "Held through an offshore vehicle",
        detail: `Control is reported to run through an entity connected to ${hit}, a jurisdiction often used to obscure ownership.`,
      };
    },
  },
  {
    id: "R4_NOMINEE",
    run(record) {
      const hay = `${textOf(record, "Intermediate Entities")} ${textOf(record, "Previous Holder")}`;
      if (!NOMINEE_MARKERS.some((m) => hay.includes(m))) return null;
      return {
        severity: "medium",
        title: "Nominee or trust arrangement",
        detail: "A nominee, trustee or custodian is reported in the control chain.",
      };
    },
  },
  {
    id: "R9_PEP",
    run(record) {
      if (!textOf(record, "PEP Status").startsWith("yes")) return null;
      return {
        severity: "high",
        title: "Politically exposed person",
        detail: "The holder is recorded as politically exposed.",
      };
    },
  },
  {
    id: "R8_RAPID_CHANGE",
    run(record) {
      const change = textOf(record, "Change Type");
      if (!change.includes("increas") && !change.includes("acquir")) return null;
      const prev = String(record["Previous Holder"] ?? "").trim();
      if (!prev) return null;
      return {
        severity: "medium",
        title: "Recent change of control",
        detail: `Control is reported to have moved from ${prev}.`,
      };
    },
  },
  {
    id: "R12_CROSS_ENTITY",
    run(record, ctx) {
      const companies = companiesFor(record, ctx);
      if (companies.length < 2) return null;
      return {
        severity: "medium",
        title: "Holdings in several companies",
        detail: `Reported in ${companies.length} tracked companies.`,
      };
    },
  },
  {
    id: "R6_UNKNOWN_OWNER",
    run(record) {
      const pct = toPercent(record.Percentage);
      const nature = String(record["Nature of Control"] ?? "").trim();
      if (pct !== null || nature) return null;
      return {
        severity: "medium",
        title: "Interest not quantified",
        detail: "Neither a stake nor a nature of control was reported.",
      };
    },
  },
];

export function flagsFor(record: PscRecord | null | undefined, context?: Context): Flag[] {
  if (!record) return [];
  const ctx = context || buildContext([record]);
  const flags: Flag[] = [];
  for (const rule of RULES) {
    let hit: Omit<Flag, "id"> | null = null;
    try {
      hit = rule.run(record, ctx);
    } catch {
      hit = null;
    }
    if (hit) flags.push({ id: rule.id, ...hit });
  }
  return flags.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "high" ? -1 : 1));
}

export interface ChainStep {
  kind: "person" | "vehicle" | "company";
  title: string;
  subtitle: string;
}

export function controlChain(record: PscRecord | null | undefined): ChainStep[] {
  if (!record) return [];
  const chain: ChainStep[] = [{
    kind: "person",
    title: String(record["Person Name"] || "Undisclosed holder"),
    subtitle: String(record["Board Role"] || "Natural person"),
  }];
  const vehicle = record["Intermediate Entities"];
  if (!isDirectHolding(vehicle)) {
    chain.push({ kind: "vehicle", title: String(vehicle), subtitle: "Intermediate vehicle" });
  }
  chain.push({ kind: "company", title: String(record.Company || "Undisclosed company"), subtitle: "Operating company" });
  return chain;
}

export type HoldingKind = "stake" | "role" | "influence";

/** One holding (holder x company), built from every report of it. */
export interface Holding {
  /** A stake if any report gives one, else a board role, else influence. */
  kind: HoldingKind;
  key: string;
  person: string;
  company: string;
  role: string;
  /** The most recent disclosed stake, or null if no report gave one. */
  stake: number | null;
  stakeLabel: string;
  band: Band | null;
  nature: string;
  vehicle: string;
  reports: { date: string; stake: number | null; nature: string; source: string }[];
  /** Distinct days it was reported on: repeated extractions are not repeat reporting. */
  days: number;
  /** The articles behind it, where the pipeline recorded them. */
  sources: { url: string; title: string; publisher: string; date: string }[];
  firstReported: string;
  lastReported: string;
  flags: Flag[];
  hasFilingRef: boolean;
  isSeed: boolean;
}

/** Values the extractor writes when it has nothing: never shown as data. */
const PLACEHOLDER = new Set(["null", "none", "n/a", "na", "unknown", "-", "undefined"]);

function dateOf(r: PscRecord): string {
  return String(r.Date ?? "").slice(0, 10);
}

/** Article links recorded on the rows, newest first, one per URL. */
function articleSources(rows: PscRecord[]): Holding["sources"] {
  const seen = new Set<string>();
  const out: Holding["sources"] = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    const url = String(r["Source URL"] ?? "").trim();
    if (!/^https?:\/\//.test(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({
      url,
      title: String(r["Source Title"] ?? "").trim(),
      publisher: String(r.Publisher ?? "").trim(),
      date: dateOf(r),
    });
  }
  return out;
}

/** Strongest claims first: a disclosed stake, then control, then board roles. */
export function registerOrder(a: Holding, b: Holding): number {
  const rank = (h: Holding) => (h.stake !== null ? 0 : h.kind === "stake" ? 1 : h.kind === "influence" ? 2 : 3);
  return rank(a) - rank(b)
    || (b.stake ?? 0) - (a.stake ?? 0)
    || b.days - a.days
    || b.lastReported.localeCompare(a.lastReported);
}

/**
 * One spelling per canonical key, so "Alhaji Aliko Dangote" and "Aliko
 * Dangote" share a name and an entity page: the most reported spelling,
 * the shorter one on a tie.
 */
function displayNames(records: PscRecord[], keyOf: (r: PscRecord) => string, field: string): Map<string, string> {
  const tally = new Map<string, Map<string, number>>();
  for (const r of records || []) {
    const key = keyOf(r);
    const name = String(r[field] ?? "").trim();
    if (!key || !name) continue;
    const t = tally.get(key) ?? new Map<string, number>();
    t.set(name, (t.get(name) ?? 0) + 1);
    tally.set(key, t);
  }
  const out = new Map<string, string>();
  for (const [key, t] of tally) {
    const best = [...t.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0];
    out.set(key, best[0]);
  }
  return out;
}

/**
 * Collapse the register's one-row-per-report into one entry per holding.
 *
 * The pipeline appends a row each time an article reports a holding, so
 * "Femi Otedola / First HoldCo" appears five times. Shown raw, that reads as
 * five owners. Grouped, it reads as one holding with five reports, and the
 * best stake (most recent disclosed) is the one shown.
 */
export function groupHoldings(records: PscRecord[]): Holding[] {
  // Only publishable rows become holdings, whoever the caller is.
  const wanted = publicRecords(records);
  const ctx = buildContext(wanted);
  const personName = displayNames(records, personKey, "Person Name");
  const companyName = displayNames(records, companyKey, "Company");
  const groups = new Map<string, PscRecord[]>();
  for (const r of wanted) {
    const p = personKey(r);
    const c = companyKey(r);
    if (!p && !c) continue;
    // "FirstHoldCo" and "First HoldCo" are the same company in the reporting.
    const key = `${p.replace(/[^a-z0-9]/g, "")}::${c.replace(/[^a-z0-9]/g, "")}`;
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }

  const holdings: Holding[] = [];
  for (const [key, rows] of groups) {
    const sorted = [...rows].sort((a, b) => dateOf(a).localeCompare(dateOf(b)));
    const latest = sorted[sorted.length - 1];
    const withStake = sorted.filter((r) => toPercent(r.Percentage) !== null);
    const stakeRow = withStake[withStake.length - 1];
    const stake = stakeRow ? toPercent(stakeRow.Percentage) : null;
    const pick = (field: string) => {
      for (let i = sorted.length - 1; i >= 0; i--) {
        const v = String(sorted[i][field] ?? "").trim();
        if (v && !PLACEHOLDER.has(v.toLowerCase())) return v;
      }
      return "";
    };
    const vehicleText = pick("Intermediate Entities");
    const seenFlags = new Map<string, Flag>();
    for (const r of sorted) for (const f of flagsFor(r, ctx)) if (!seenFlags.has(f.id)) seenFlags.set(f.id, f);
    // A stake disclosed in any report answers "interest not quantified".
    if (stake !== null || pick("Nature of Control")) seenFlags.delete("R6_UNKNOWN_OWNER");
    const flags = [...seenFlags.values()].sort((a, b) =>
      a.severity === b.severity ? 0 : a.severity === "high" ? -1 : 1);

    const kinds = new Set(sorted.map(kindOf));
    holdings.push({
      key,
      kind: kinds.has("stake") ? "stake" : kinds.has("role") ? "role" : "influence",
      person: personName.get(personKey(latest)) || "Undisclosed holder",
      company: companyName.get(companyKey(latest)) || "Undisclosed company",
      role: pick("Board Role"),
      stake,
      stakeLabel: stake === null ? "Stake not disclosed" : `${stake % 1 === 0 ? stake.toFixed(0) : stake.toFixed(2).replace(/0$/, "")}%`,
      band: stake === null ? null : classifyBand(stake),
      nature: pick("Nature of Control"),
      vehicle: isDirectHolding(vehicleText) ? "" : vehicleText,
      reports: sorted.map((r) => ({
        date: dateOf(r),
        stake: toPercent(r.Percentage),
        nature: String(r["Nature of Control"] ?? "").trim(),
        source: sourceOf(r),
      })),
      days: new Set(sorted.map(dateOf).filter(Boolean)).size,
      sources: articleSources(sorted),
      firstReported: dateOf(sorted[0]),
      lastReported: dateOf(latest),
      flags,
      hasFilingRef: sorted.some((r) => String(r["Regulatory Filing Ref"] ?? "").trim() !== ""),
      isSeed: sorted.some((r) => String(r.Source ?? "").toLowerCase() === "seed"),
    });
  }
  return holdings.sort((a, b) =>
    b.lastReported.localeCompare(a.lastReported) || a.person.localeCompare(b.person));
}

export interface RegisterSummary {
  /** Sourced ownership claims: what every headline number counts. */
  holdings: number;
  /** Board posts with no reported stake (shown, not counted as holdings). */
  roles: number;
  holders: number;
  companies: number;
  withStake: number;
  /** Holdings with at least one pattern worth checking. */
  withPattern: number;
  /** Holdings with a high-severity pattern. */
  highSeverity: number;
  nigeriaBand: number;
  offshore: number;
  filingRefRate: number | null;
  isDemo: boolean;
}

/** The holdings the headline numbers count: ownership claims, not bare board roles. */
export function counted(holdings: Holding[]): Holding[] {
  return holdings.filter((h) => h.kind !== "role");
}

export function summarise(all: Holding[]): RegisterSummary {
  const holdings = counted(all);
  const holders = new Set(holdings.map((h) => h.person.toLowerCase()));
  const companies = new Set(holdings.map((h) => h.company.toLowerCase()));
  return {
    holdings: holdings.length,
    roles: all.filter((h) => h.kind === "role").length,
    holders: holders.size,
    companies: companies.size,
    withStake: holdings.filter((h) => h.stake !== null).length,
    withPattern: holdings.filter((h) => h.flags.length > 0).length,
    highSeverity: holdings.filter((h) => h.flags.some((f) => f.severity === "high")).length,
    nigeriaBand: holdings.filter((h) => h.band?.id === "BAND_5_25").length,
    offshore: holdings.filter((h) => h.flags.some((f) => f.id === "R7_SECRECY_VEHICLE")).length,
    filingRefRate: holdings.length ? holdings.filter((h) => h.hasFilingRef).length / holdings.length : null,
    isDemo: all.some((h) => h.isSeed),
  };
}

/** Plain-English one-liner: "owns 27.49% of First HoldCo". */
export function describeHolding(h: Holding): string {
  if (h.stake !== null) return `owns ${h.stakeLabel} of ${h.company}`;
  if (h.kind === "role" && h.role) {
    const role = h.role.toLowerCase();
    return /founder/.test(role) ? `is a founder of ${h.company}` : `is ${role} of ${h.company}`;
  }
  const nature = h.nature.toLowerCase();
  if (nature.includes("influence")) return `has significant influence over ${h.company}`;
  if (nature.includes("director")) return `can appoint directors at ${h.company}`;
  if (nature.includes("share")) return `holds shares in ${h.company} (stake not disclosed)`;
  return `is reported to control ${h.company}`;
}
