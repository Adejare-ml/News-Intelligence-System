/**
 * The dispute form (/dispute/): fills in the record from ?ref= (the
 * "Dispute this record" links) and posts the form as JSON to /api/dispute.
 * Without JavaScript the browser posts the form itself and gets a page back.
 */
document.querySelectorAll<HTMLFormElement>("form[data-dispute]").forEach((form) => {
  const status = form.querySelector<HTMLElement>("[data-dispute-status]");
  const say = (msg: string, kind: "ok" | "error" | "" = "") => {
    if (!status) return;
    status.textContent = msg;
    status.classList.toggle("ok", kind === "ok");
    status.classList.toggle("error", kind === "error");
  };
  const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement | null;

  const ref = new URLSearchParams(location.search).get("ref");
  const refInput = field("ref");
  if (ref && refInput && !refInput.value) refInput.value = ref.slice(0, 200);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const relationship = form.querySelector<HTMLInputElement>('input[name="relationship"]:checked')?.value || "";
    const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (button) button.disabled = true;
    say("Sending…");
    try {
      const res = await fetch(form.action, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          ref: field("ref")?.value.trim() || "",
          name: field("name")?.value.trim() || "",
          email: field("email")?.value.trim() || "",
          relationship,
          message: field("message")?.value.trim() || "",
          company_site: field("company_site")?.value || "",
        }),
      });
      if (res.status === 404 || res.status === 405) {
        // This copy of the site has no server (the GitHub Pages mirror).
        const fallback = form.dataset.fallback;
        say(fallback ? "This form is not available on this copy of the site. Opening the corrections page instead…" : "This form is not available here yet.", "error");
        if (fallback) location.assign(fallback);
      } else if (res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        say(body.message || "Thank you. Your message has been received.", "ok");
        form.reset();
      } else {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        say(body.error || "Something went wrong. Please try again in a moment.", "error");
      }
    } catch {
      say("You seem to be offline. Please try again.", "error");
    } finally {
      if (button) button.disabled = false;
    }
  });
});
