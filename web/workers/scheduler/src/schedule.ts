/**
 * Starts the AURA pipeline on time from Cloudflare's scheduler.
 *
 * GitHub's own cron is unreliable for this repo: on 2-3 Nov 2026 it dropped
 * the 07:11 UTC run (no Morning Brief) and started others 40+ minutes late.
 * Cloudflare cron triggers fire on time, so this Worker starts the
 * "AI News Intelligence Scheduler" workflow through GitHub's API at each
 * slot, and checks again later in case that start failed.
 *
 * It never starts a second run for a slot: if any run (from this Worker,
 * GitHub's cron, the watchdog or a person) was created since the slot began,
 * it does nothing. The GitHub cron runs skip themselves the same way when
 * this Worker got there first (the "guard" job in news_scheduler.yml).
 */

export interface Env {
  GITHUB_TOKEN: string;     // fine-grained token: this repo, Actions read and write
  REPO?: string;            // owner/name
  WORKFLOW?: string;        // workflow file
  REF?: string;             // branch to run on
}

export const SLOTS = [7, 13, 17, 23];        // UTC hours; 07 is the Morning Brief
export const EDITION_SLOT = 7;
const DEFAULTS = { REPO: "Adejare-ml/News-Intelligence-System", WORKFLOW: "news_scheduler.yml", REF: "main" };

/** The start of the slot a check at `now` covers: the latest slot hour at or before now. */
export function slotStart(now: Date): Date {
  const hour = now.getUTCHours();
  const slot = [...SLOTS].reverse().find((h) => h <= hour);
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), slot ?? SLOTS[SLOTS.length - 1]));
  if (slot === undefined) start.setUTCDate(start.getUTCDate() - 1);   // before 07:00: last night's 23:00
  return start;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface Outcome {
  action: "started" | "already_running" | "error";
  slot: string;
  email_edition?: boolean;
  detail?: string;
}

export async function ensureRun(env: Env, now: Date, fetcher: Fetch = fetch): Promise<Outcome> {
  const repo = env.REPO || DEFAULTS.REPO;
  const workflow = env.WORKFLOW || DEFAULTS.WORKFLOW;
  const start = slotStart(now);
  const slot = start.toISOString().replace(".000Z", "Z");
  if (!env.GITHUB_TOKEN) return { action: "error", slot, detail: "GITHUB_TOKEN is not set" };
  const headers = {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "aura-scheduler",
  };
  const base = `https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}`;

  const list = await fetcher(`${base}/runs?per_page=1&created=${encodeURIComponent(">=" + slot)}`, { headers });
  if (!list.ok) return { action: "error", slot, detail: `listing runs: HTTP ${list.status}` };
  const runs = (await list.json()) as { total_count?: number };
  if ((runs.total_count ?? 0) > 0) return { action: "already_running", slot };

  const email_edition = start.getUTCHours() === EDITION_SLOT;
  const dispatch = await fetcher(`${base}/dispatches`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ ref: env.REF || DEFAULTS.REF, inputs: { email_edition: String(email_edition) } }),
  });
  if (dispatch.status !== 204 && dispatch.status !== 200) {
    return { action: "error", slot, email_edition, detail: `starting the run: HTTP ${dispatch.status} ${(await dispatch.text()).slice(0, 200)}` };
  }
  return { action: "started", slot, email_edition };
}
