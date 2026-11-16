"use strict";

// Visual effects only. Nothing here is needed to place an order.
(function () {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const $ = (s) => document.querySelector(s);

  /* ---- Marigold toran: a garland of pennant flags across the top of the hero ---- */
  function buildToran() {
    const el = $("#toran");
    if (!el) return;
    const colors = ["#F5A700", "#D62828", "#1F7A4A", "#FF7A00"];
    const count = Math.ceil(window.innerWidth / 54) + 2;
    let html = "";
    for (let i = 0; i < count; i++) {
      const c = colors[i % colors.length];
      const delay = ((i * 0.37) % 2.4).toFixed(2);
      html += `<svg class="flag" viewBox="0 0 40 58" style="animation-delay:-${delay}s" width="40" height="58">
        <path d="M2 0h36v34L20 56 2 34z" fill="${c}"/>
        <path d="M2 0h36v34L20 56 2 34z" fill="none" stroke="rgba(0,0,0,.18)" stroke-width="1.5"/>
        <circle cx="20" cy="22" r="7" fill="rgba(255,255,255,.85)"/>
        <circle cx="20" cy="22" r="3" fill="${c}"/>
      </svg>`;
    }
    el.innerHTML = `<i class="rope"></i><div class="flags">${html}</div>`;
  }

  /* ---- Plates: real dishes from the menu, floating in the hero ---- */
  function buildPlates(menu) {
    const box = $("#plates");
    if (!box) return;
    const withPhoto = menu.items.filter((i) => i.image && !i.soldOut);
    // One dish per category first so the hero shows variety.
    const picks = [];
    for (const c of menu.categories) {
      const it = withPhoto.find((i) => i.category === c.id && !picks.includes(i));
      if (it) picks.push(it);
    }
    for (const it of withPhoto) if (picks.length < 4 && !picks.includes(it)) picks.push(it);
    const spots = ["p1", "p2", "p3", "p4"];
    box.innerHTML = picks
      .slice(0, 4)
      .map(
        (it, n) => `<a class="plate ${spots[n]}" href="#cat-${it.category}" data-depth="${[18, 30, 12, 24][n]}" tabindex="-1">
          <img src="${it.image}" alt="" loading="eager" decoding="async">
          <span class="plate-name">${it.name}</span>
        </a>`
      )
      .join("");
  }

  /* ---- Pointer parallax for the plates ---- */
  function parallax() {
    const hero = $("#hero");
    const box = $("#plates");
    if (!hero || !box || reduce) return;
    let raf = 0;
    hero.addEventListener("pointermove", (e) => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const r = hero.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width - 0.5;
        const y = (e.clientY - r.top) / r.height - 0.5;
        box.querySelectorAll(".plate").forEach((p) => {
          const d = Number(p.dataset.depth) || 10;
          p.style.setProperty("--px", `${(-x * d).toFixed(1)}px`);
          p.style.setProperty("--py", `${(-y * d).toFixed(1)}px`);
        });
      });
    });
    hero.addEventListener("pointerleave", () => {
      box.querySelectorAll(".plate").forEach((p) => {
        p.style.setProperty("--px", "0px");
        p.style.setProperty("--py", "0px");
      });
    });
  }

  /* ---- Basket button bounces when the count changes ---- */
  function cartBounce() {
    const badge = $("#cartBadge");
    const btn = $("#cartBtn");
    if (!badge || !btn || reduce) return;
    let last = badge.textContent;
    new MutationObserver(() => {
      if (badge.textContent === last) return;
      last = badge.textContent;
      btn.classList.remove("bump");
      void btn.offsetWidth;
      btn.classList.add("bump");
    }).observe(badge, { childList: true, characterData: true, subtree: true });
  }

  /* ---- Top bar gets a stronger shadow once the page scrolls ---- */
  function topbarShadow() {
    const bar = document.querySelector(".topbar");
    if (!bar) return;
    const on = () => bar.classList.toggle("scrolled", window.scrollY > 8);
    window.addEventListener("scroll", on, { passive: true });
    on();
  }

  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(buildToran, 200);
  });

  buildToran();
  cartBounce();
  topbarShadow();
  parallax();
  document.addEventListener("menu:ready", (e) => buildPlates(e.detail));
})();
