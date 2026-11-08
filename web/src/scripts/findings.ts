/**
 * Finding page share buttons: copy the LinkedIn or X text to the clipboard.
 * LinkedIn's share link carries only a URL, so copying is how a reader posts
 * the prepared wording; X gets the same treatment so both work alike.
 */
const copyStatus = document.querySelector<HTMLElement>("[data-copy-status]");

document.querySelectorAll<HTMLButtonElement>("button[data-copy]").forEach((button) => {
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(button.dataset.copy || "");
      if (copyStatus) copyStatus.textContent = "Copied. Paste it into your post.";
    } catch {
      if (copyStatus) copyStatus.textContent = "Your browser blocked copying. Select the text on this page instead.";
    }
  });
});
