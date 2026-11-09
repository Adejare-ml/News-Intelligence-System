// Runs before first paint (blocking, external so a strict CSP can allow it):
// applies the saved theme so a light-theme reader never sees a dark flash,
// and marks the page as scripted so reveal animations only hide content
// when the script that reveals it is actually going to run. It also hides
// the "New to AURA?" explainer for a reader who closed it (key shared with
// src/lib/explainer.ts), so the page does not jump when it loads.
(function () {
  var root = document.documentElement;
  root.classList.add("js");
  try {
    var saved = localStorage.getItem("aura-theme");
    if (saved === "light" || saved === "dark") root.setAttribute("data-theme", saved);
    if (localStorage.getItem("aura-explainer") === "closed") root.classList.add("explainer-closed");
  } catch (e) {
    /* storage blocked: default dark theme */
  }
})();
