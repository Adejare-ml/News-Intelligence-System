// Runs before first paint (blocking, external so a strict CSP can allow it):
// applies the saved theme so a light-theme reader never sees a dark flash,
// and marks the page as scripted so reveal animations only hide content
// when the script that reveals it is actually going to run.
(function () {
  var root = document.documentElement;
  root.classList.add("js");
  try {
    var saved = localStorage.getItem("aura-theme");
    if (saved === "light" || saved === "dark") root.setAttribute("data-theme", saved);
  } catch (e) {
    /* storage blocked: default dark theme */
  }
})();
