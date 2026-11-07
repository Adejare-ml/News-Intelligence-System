/**
 * Morning Brief sign-up: POSTs to /api/subscribe (a Cloudflare Pages Function)
 * with the reader's email and the kinds of news they chose.
 */
const checkedValues = (form: HTMLFormElement, name: string) =>
  [...form.querySelectorAll<HTMLInputElement>(`input[name="${name}"]:checked`)].map((i) => i.value);

/** "Headlines from" only matters once a headline category is ticked. */
function syncRegion(form: HTMLFormElement): void {
  const region = form.querySelector<HTMLElement>("[data-region]");
  if (region) region.hidden = !checkedValues(form, "categories").some((c) => c !== "business");
}

/** /news/technology/ links here with ?topic=technology: tick it for the reader. */
function preselect(form: HTMLFormElement): void {
  const topic = new URLSearchParams(location.search).get("topic");
  const box = topic ? form.querySelector<HTMLInputElement>(`input[name="categories"][value="${CSS.escape(topic)}"]`) : null;
  if (box) box.checked = true;
}

document.querySelectorAll<HTMLFormElement>("form[data-subscribe]").forEach((form) => {
  const status = form.querySelector<HTMLElement>("[data-subscribe-status]");
  const input = form.querySelector<HTMLInputElement>('input[type="email"]');
  const say = (msg: string, kind: "ok" | "error" | "" = "") => {
    if (!status) return;
    status.textContent = msg;
    status.classList.toggle("ok", kind === "ok");
    status.classList.toggle("error", kind === "error");
  };

  preselect(form);
  syncRegion(form);
  form.addEventListener("change", (event) => {
    if ((event.target as HTMLInputElement).name === "categories") syncRegion(form);
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = input?.value.trim() || "";
    if (!input || !input.checkValidity() || !email) {
      say("That email address doesn’t look right.", "error");
      input?.focus();
      return;
    }
    const categories = checkedValues(form, "categories");
    if (!categories.length) {
      say("Choose at least one kind of news.", "error");
      form.querySelector<HTMLInputElement>('input[name="categories"]')?.focus();
      return;
    }
    form.classList.add("is-busy");
    say("Adding you to the list…");
    try {
      const res = await fetch(form.action, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          email,
          categories,
          region: checkedValues(form, "region")[0] || "nigeria",
          frequency: checkedValues(form, "frequency")[0] || "daily",
          choices: "1",
          company_site: (form.elements.namedItem("company_site") as HTMLInputElement)?.value || "",
        }),
      });
      if (res.status === 404 || res.status === 405) {
        say("Sign-ups open very soon. The brief is already live at the top of this page.", "");
      } else if (res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        form.classList.add("is-done");
        say(body.message || "You’re on the list.", "ok");
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
