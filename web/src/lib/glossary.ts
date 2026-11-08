/**
 * The abbreviations a newcomer meets on the register, in plain English.
 * Shown by the Term component wherever the abbreviation appears.
 */
export const GLOSSARY = {
  PSC: {
    expansion: "Person with significant control",
    definition: "Anyone who holds at least 5% of a Nigerian company's shares or votes, or can otherwise direct it. CAMA 2020 says companies must disclose them to the CAC.",
  },
  CAC: {
    expansion: "Corporate Affairs Commission",
    definition: "The federal body that registers Nigerian companies and keeps the official record of who owns them. AURA's records come from press reports, not CAC filings.",
  },
  CAMA: {
    expansion: "Companies and Allied Matters Act 2020",
    definition: "Nigeria's company law. Section 868 sets the 5% threshold at which an owner must be disclosed.",
  },
  BPP: {
    expansion: "Bureau of Public Procurement",
    definition: "The federal agency that oversees and publishes government contract awards. Contracts here come from news reports, not BPP records.",
  },
} as const;

export type GlossaryTerm = keyof typeof GLOSSARY;

let uses = 0;

/** A page-unique id per use, so the same term can be explained twice on one page. */
export function termId(term: GlossaryTerm): string {
  uses += 1;
  return `term-${term.toLowerCase()}-${uses}`;
}
