"use strict";
// Hamburger menu for the admin pages: opens the left drawer, closes on Esc, outside tap or choosing an item.
(function () {
  const btn = document.getElementById("menuBtn");
  const drawer = document.getElementById("kitchenNav");
  const backdrop = document.getElementById("drawerBackdrop");
  if (!btn || !drawer || !backdrop) return;
  function setOpen(open) {
    drawer.classList.toggle("open", open);
    backdrop.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
    btn.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    if (open) { const first = drawer.querySelector("a,button"); if (first) first.focus(); } else if (document.activeElement && drawer.contains(document.activeElement)) btn.focus();
  }
  btn.addEventListener("click", () => setOpen(!drawer.classList.contains("open")));
  backdrop.addEventListener("click", () => setOpen(false));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && drawer.classList.contains("open")) setOpen(false); });
  drawer.addEventListener("click", (e) => { if (e.target.closest("a,button")) setOpen(false); });
})();
