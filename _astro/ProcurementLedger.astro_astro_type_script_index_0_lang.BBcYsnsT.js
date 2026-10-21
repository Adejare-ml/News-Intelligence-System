document.querySelectorAll("[data-show-more]").forEach(e=>{e.addEventListener("click",()=>{const r=e.parentElement?.querySelector("[data-more]");r&&(r.hidden=!1,e.remove())})});
