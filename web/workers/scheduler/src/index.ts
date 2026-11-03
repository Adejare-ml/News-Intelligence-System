import { ensureRun, type Env } from "./schedule.ts";

export default {
  async scheduled(event: { scheduledTime: number }, env: Env): Promise<void> {
    const outcome = await ensureRun(env, new Date(event.scheduledTime));
    console.log(JSON.stringify(outcome));
    // Throwing marks the invocation as failed in the Worker's logs and metrics.
    if (outcome.action === "error") throw new Error(outcome.detail);
  },

  // No trigger over HTTP: the page only says what this Worker is.
  async fetch(): Promise<Response> {
    return new Response("AURA scheduler: starts the news pipeline at 07, 13, 17 and 23 UTC.\n", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};
