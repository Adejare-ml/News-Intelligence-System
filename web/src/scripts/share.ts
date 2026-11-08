/**
 * Share buttons on a Morning Brief edition page. The WhatsApp link works
 * without this script; the Share and Copy link buttons stay hidden unless the
 * browser can do them, so nobody sees a button that does nothing.
 */
document.querySelectorAll<HTMLElement>("[data-share]").forEach((box) => {
  const title = box.dataset.title ?? document.title;
  const url = box.dataset.url ?? location.href;
  const native = box.querySelector<HTMLButtonElement>("[data-share-native]");
  const copy = box.querySelector<HTMLButtonElement>("[data-share-copy]");
  const status = box.querySelector<HTMLElement>("[data-share-status]");

  if (native && typeof navigator.share === "function") {
    native.hidden = false;
    native.addEventListener("click", () => {
      // Closing the share sheet rejects; that is the reader's choice, not an error.
      navigator.share({ title, url }).catch(() => {});
    });
  }

  if (copy && navigator.clipboard) {
    copy.hidden = false;
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(url);
        if (status) status.textContent = "Link copied.";
      } catch {
        if (status) status.textContent = "Could not copy; the link is in the address bar.";
      }
    });
  }
});
