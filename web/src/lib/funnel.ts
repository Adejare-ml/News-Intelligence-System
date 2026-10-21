/**
 * The pipeline's yield, from articles screened to claims on the register.
 * One small number at the end reads as "found nothing"; the same number at
 * the end of a funnel reads as what it is: what survived checking.
 */
export interface FunnelInput {
  sources: { total?: number }[];
  days: { date?: string; articles?: number }[];
  gate: { checked?: number; published?: number };
  holdings: number;
  roles: number;
}

export interface FunnelStep {
  value: number;
  label: string;
  hint: string;
}

const sum = (xs: number[]) => xs.reduce((n, x) => n + (Number.isFinite(x) ? x : 0), 0);

export function buildFunnel(input: FunnelInput, since?: string): FunnelStep[] {
  const screened = sum(input.sources.map((s) => Number(s.total) || 0));
  const read = sum(input.days.map((d) => Number(d.articles) || 0));
  const claims = Number(input.gate.checked) || 0;
  const passed = Number(input.gate.published) || 0;
  const sinceLabel = since ? ` since ${since}` : "";
  const steps: FunnelStep[] = [
    { value: screened, label: "Articles screened", hint: `Nigerian business news${sinceLabel}` },
    { value: read, label: "Read by the model", hint: "after the topic guard" },
    { value: claims, label: "Ownership claims extracted", hint: "a named holder and company" },
    {
      value: input.holdings,
      label: "On the register",
      hint: [
        passed && claims ? `${claims - passed} withheld by the checks` : "",
        input.roles ? `plus ${input.roles} board ${input.roles === 1 ? "role" : "roles"}` : "",
      ].filter(Boolean).join(" · ") || "sourced ownership claims",
    },
  ];
  // A pipeline that has not run yet has no funnel to show.
  return steps.filter((s, i) => s.value > 0 || i === steps.length - 1);
}
