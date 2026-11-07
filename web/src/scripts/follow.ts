/**
 * "Get updates by email" on company pages: POSTs the address and the
 * company's slug to /api/follow (a Cloudflare Pages Function).
 */
document.querySelectorAll<HTMLFormElement>("form[data-follow]").forEach((form) => {
  const status = form.querySelector<HTMLElement>("[data-follow-status]");
  const input = form.querySelector<HTMLInputElement>('input[type="email"]');
  const field = (name: string) => (form.elements.namedItem(name) as HTMLInputElement | null)?.value || "";
  const say = (msg: string, kind: "ok" | "error" | "" = "") => {
    if (!status) return;
    status.textContent = msg;
    status.classList.toggle("ok", kind === "ok");
    status.classList.toggle("error", kind === "error");
  };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = input?.value.trim() || "";
    if (!input || !input.checkValidity() || !email) {
      say("That email address doesn’t look right.", "error");
      input?.focus();
      return;
    }
    form.classList.add("is-busy");
    say("Sending…");
    try {
      const res = await fetch(form.action, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ email, slug: field("slug"), company_site: field("company_site") }),
      });
      const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
      // The GitHub Pages mirror has no Functions: say so plainly instead of failing.
      if (res.status === 404 || res.status === 405) say("Updates by email open very soon.");
      else if (res.ok) {
        say(body.message || "Check your inbox.", "ok");
        input.value = "";
      } else say(body.error || "Something went wrong. Please try again in a moment.", "error");
    } catch {
      say("You seem to be offline. Please try again.", "error");
    } finally {
      form.classList.remove("is-busy");
    }
  });
});
