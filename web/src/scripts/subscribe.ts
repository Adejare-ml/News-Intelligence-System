/** Morning Brief sign-up: POSTs to /api/subscribe (a Cloudflare Pages Function). */
document.querySelectorAll<HTMLFormElement>("form[data-subscribe]").forEach((form) => {
  const status = form.querySelector<HTMLElement>("[data-subscribe-status]");
  const input = form.querySelector<HTMLInputElement>('input[type="email"]');
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
    say("Adding you to the list…");
    try {
      const res = await fetch(form.action, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ email, company_site: (form.elements.namedItem("company_site") as HTMLInputElement)?.value || "" }),
      });
      if (res.status === 404 || res.status === 405) {
        say("Sign-ups open very soon. The brief is already live at the top of this page.", "");
      } else if (res.ok) {
        form.classList.add("is-done");
        say("You’re on the list. Check your inbox to confirm.", "ok");
        input.value = "";
      } else {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        say(body.error || "Something went wrong. Please try again in a moment.", "error");
      }
    } catch {
      say("You seem to be offline. Please try again.", "error");
    } finally {
      form.classList.remove("is-busy");
    }
  });
});
