"use strict";

/* ---------- helpers ---------- */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let menu = null;
const itemsById = new Map();

const money = (n) => `${menu.currency}${n.toFixed(2)}`;
const isAvailable = (item) => !menu.stock || menu.stock[item.id] !== false;
const round2 = (n) => Math.round(n * 100) / 100;
const MAX_QTY = 100; // keep in step with the server

// Photo if the item has one, otherwise its emoji. A broken photo falls back to the emoji.
function artHtml(item) {
  return item.image
    ? `<img src="${esc(item.image)}" alt="${esc(item.name)}" loading="lazy" data-fallback="${esc(item.emoji || "🍽️")}">`
    : esc(item.emoji || "🍽️");
}
document.addEventListener(
  "error",
  (e) => {
    const t = e.target;
    if (t && t.tagName === "IMG" && t.dataset.fallback) {
      const s = document.createElement("span");
      s.textContent = t.dataset.fallback;
      t.replaceWith(s);
    }
  },
  true
);

// "€8.00 · 20 pieces"
function priceHtml(item) {
  return `<span class="price">${money(item.price)}${item.unit ? `<small class="unit"> · ${esc(item.unit)}</small>` : ""}</span>`;
}

function store(key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem(key));
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch (_) {
    return null;
  }
  return value;
}

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2200);
}

/* ---------- state ---------- */

let cart = store("ss_cart") || []; // [{key,itemId,qty,size,addons,removed}]
let orderType = ["delivery","eat_here"].includes(store("ss_type")) ? store("ss_type") : "pickup";
let trackTimer = null;

function saveCart() {
  store("ss_cart", cart);
}

/* ---------- pricing ---------- */

function sizeList(item) {
  return item.sizes ? menu.sizes[item.sizes] : null;
}

function unitPrice(item, sel) {
  let p = item.price;
  const sizes = sizeList(item);
  if (sizes) p += (sizes.find((s) => s.id === sel.size) || sizes[0]).delta;
  for (const id of sel.addons) {
    const a = (item.addons || []).find((x) => x.id === id);
    if (a) p += a.price;
  }
  return round2(p);
}

function cartTotals() {
  const subtotal = round2(
    cart.reduce((s, l) => s + unitPrice(itemsById.get(l.itemId), l) * l.qty, 0)
  );
  let fee = 0;
  if (orderType === "delivery" && subtotal > 0) {
    fee = subtotal >= menu.freeDeliveryOver ? 0 : menu.deliveryFee;
  }
  return { subtotal, fee, total: round2(subtotal + fee) };
}

const cartCount = () => cart.reduce((n, l) => n + l.qty, 0);

/* ---------- overlays ---------- */

function openOverlay(id) {
  $(id).hidden = false;
  document.body.style.overflow = "hidden";
}

function closeOverlay(el) {
  el.hidden = true;
  if (el.id === "trackOverlay") stopTracking();
  if ($$(".overlay").every((o) => o.hidden)) document.body.style.overflow = "";
}

function wireOverlays() {
  $$(".overlay").forEach((ov) => {
    ov.addEventListener("click", (e) => {
      if (e.target === ov || e.target.closest("[data-close]")) closeOverlay(ov);
    });
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const open = $$(".overlay").filter((o) => !o.hidden).pop();
    if (open) closeOverlay(open);
  });
}

/* ---------- menu ---------- */

function tagsHtml(item) {
  return (item.tags || [])
    .map((t) => `<span class="tag ${esc(t)}">${t === "veg" ? "Veg" : t === "spicy" ? "Spicy 🌶️" : esc(t)}</span>`)
    .join("");
}

function renderMenu() {
  $("#brandName").textContent = menu.brand;
  $("#brandFooter").textContent = menu.brand;
  $("#tagline").textContent = menu.tagline;
  document.title = `${menu.brand} — Order online`;

  $("#cats").innerHTML = menu.categories
    .map((c) => `<a class="cat-tab" href="#cat-${esc(c.id)}" data-cat="${esc(c.id)}">${c.emoji} ${esc(c.name)}</a>`)
    .join("");

  $("#menuRoot").innerHTML = menu.categories
    .map((c) => {
      const items = menu.items.filter((i) => i.category === c.id);
      return `
      <section class="menu-section" id="cat-${esc(c.id)}">
        <h2>${c.emoji} ${esc(c.name)}</h2>
        <div class="grid">
          ${items
            .map(
              (i) => `
            <button class="card" data-id="${esc(i.id)}" data-cat="${esc(i.category)}" ${!isAvailable(i) ? "disabled" : ""}>
              <div class="card-art${i.image ? " has-img" : ""}">${artHtml(i)}</div>
              <div class="card-body">
                <div class="card-title"><h3>${esc(i.name)}</h3>${priceHtml(i)}</div>
                <p class="desc">${esc(i.description)}</p>
                <div class="card-foot">
                  <span>${tagsHtml(i)}${i.calories ? `<span class="cal">${i.calories} kcal</span>` : ""}</span>
                  ${!isAvailable(i) ? `<span class="stock-badge">OUT OF STOCK</span>` : `<span class="add-chip" aria-hidden="true">+</span>`}
                </div>
              </div>
            </button>`
            )
            .join("")}
        </div>
      </section>`;
    })
    .join("");

  $$(".card").forEach((c) => c.addEventListener("click", () => openItem(c.dataset.id)));

  // Highlight the tab of the section currently on screen.
  const tabs = $$(".cat-tab");
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          tabs.forEach((t) => t.classList.toggle("active", t.dataset.cat === e.target.id.replace("cat-", "")));
        }
      }
    },
    { rootMargin: "-140px 0px -65% 0px" }
  );
  $$(".menu-section").forEach((s) => io.observe(s));
  if (tabs[0]) tabs[0].classList.add("active");
}

/* ---------- item customization ---------- */

let draft = null; // {item,size,addons:Set,removed:Set,qty}

function openItem(id) {
  const item = itemsById.get(id);
  if (!isAvailable(item)) { toast("Out of stock"); return; }
  const sizes = sizeList(item);
  draft = { item, size: sizes ? sizes[0].id : null, spice: item.spiceLevels ? item.spiceLevels[0] : null, addons: new Set(), removed: new Set(), qty: 1 };
  renderItem();
  openOverlay("#itemOverlay");
}

function renderItem() {
  const { item } = draft;
  const sizes = sizeList(item);
  const sel = { size: draft.size, addons: [...draft.addons] };
  const unit = unitPrice(item, sel);

  $("#itemBody").innerHTML = `
    <div class="item-art${item.image ? " has-img" : ""}">${artHtml(item)}</div>
    <div class="item-head"><h2 id="itemTitle">${esc(item.name)}</h2>${priceHtml(item)}</div>
    <p class="desc">${esc(item.description)}</p>
    <p>${tagsHtml(item)}${item.calories ? `<span class="cal">${item.calories} kcal</span>` : ""}</p>

    ${
      sizes
        ? `<div class="group"><h4>Size</h4>${sizes
            .map(
              (s) => `<label class="opt"><input type="radio" name="size" value="${esc(s.id)}" ${draft.size === s.id ? "checked" : ""}>
              <span>${esc(s.name)}</span><span class="opt-price">${s.delta ? "+" + money(s.delta) : "Included"}</span></label>`
            )
            .join("")}</div>`
        : ""
    }

    ${
      (item.addons || []).length
        ? `<div class="group"><h4>Add extras</h4>${item.addons
            .map(
              (a) => `<label class="opt"><input type="checkbox" data-addon="${esc(a.id)}" ${draft.addons.has(a.id) ? "checked" : ""}>
              <span>${esc(a.name)}</span><span class="opt-price">+${money(a.price)}</span></label>`
            )
            .join("")}</div>`
        : ""
    }

    ${
      (item.spiceLevels || []).length
        ? `<div class="group"><h4>Spice level</h4>${item.spiceLevels.map((level) => `<label class="opt"><input type="radio" name="spice" value="${esc(level)}" ${draft.spice === level ? "checked" : ""} required><span>${esc(level)}</span></label>`).join("")}</div>`
        : ""
    }

    ${
      (item.removals || []).length
        ? `<div class="group"><h4>Remove</h4>${item.removals
            .map(
              (r) => `<label class="opt"><input type="checkbox" data-remove="${esc(r)}" ${draft.removed.has(r) ? "checked" : ""}>
              <span>No ${esc(r.toLowerCase())}</span><span class="opt-price">Free</span></label>`
            )
            .join("")}</div>`
        : ""
    }

    <div class="item-foot">
      <div class="stepper">
        <button type="button" data-qty="-1" aria-label="Decrease quantity">−</button>
        <span aria-live="polite">${draft.qty}</span>
        <button type="button" data-qty="1" aria-label="Increase quantity">+</button>
      </div>
      <button class="btn primary" id="addToCart" type="button">Add to basket · ${money(round2(unit * draft.qty))}</button>
    </div>`;

  const body = $("#itemBody");
  $$('input[name="size"]', body).forEach((r) =>
    r.addEventListener("change", () => {
      draft.size = r.value;
      renderItem();
    })
  );
  $$("[data-addon]", body).forEach((c) =>
    c.addEventListener("change", () => {
      c.checked ? draft.addons.add(c.dataset.addon) : draft.addons.delete(c.dataset.addon);
      renderItem();
    })
  );
  $$("[data-remove]", body).forEach((c) =>
    c.addEventListener("change", () => {
      c.checked ? draft.removed.add(c.dataset.remove) : draft.removed.delete(c.dataset.remove);
      renderItem();
    })
  );
  $$("[data-qty]", body).forEach((b) =>
    b.addEventListener("click", () => {
      draft.qty = Math.min(MAX_QTY, Math.max(1, draft.qty + Number(b.dataset.qty)));
      renderItem();
    })
  );
  $("#addToCart", body).addEventListener("click", addDraftToCart);
}

function lineKey(l) {
  return [l.itemId, l.size || "", l.spice || "", [...l.addons].sort().join(","), [...l.removed].sort().join(",")].join("|");
}

function addDraftToCart() {
  if (!isAvailable(draft.item)) { toast("Out of stock"); closeOverlay($("#itemOverlay")); return; }
  const line = {
    itemId: draft.item.id,
    spice: draft.spice,
    qty: draft.qty,
    size: draft.size,
    addons: [...draft.addons],
    removed: [...draft.removed],
  };
  line.key = lineKey(line);
  const existing = cart.find((l) => l.key === line.key);
  if (existing) existing.qty = Math.min(MAX_QTY, existing.qty + line.qty);
  else cart.push(line);
  saveCart();
  renderCartBits();
  closeOverlay($("#itemOverlay"));
  toast(`${draft.item.name} added to basket`);
}

/* ---------- basket ---------- */

function lineMeta(l) {
  const item = itemsById.get(l.itemId);
  const parts = [];
  if (item.unit) parts.push(item.unit);
  if (l.spice) parts.push("Spice: " + l.spice);
  const sizes = sizeList(item);
  if (sizes) parts.push((sizes.find((s) => s.id === l.size) || sizes[0]).name);
  for (const id of l.addons) {
    const a = (item.addons || []).find((x) => x.id === id);
    if (a) parts.push("+ " + a.name);
  }
  for (const r of l.removed) parts.push("No " + r.toLowerCase());
  return parts;
}

function renderCartBits() {
  const t = cartTotals();
  $("#cartBadge").textContent = cartCount();
  $("#cartTotalTop").textContent = money(t.subtotal);
  $$(".seg-btn").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.type === orderType)));
  renderCartDrawer();
}

function renderCartDrawer() {
  const body = $("#cartBody");
  const foot = $("#cartFoot");

  if (!cart.length) {
    body.innerHTML = `<div class="empty"><span class="big">🛒</span>Your basket is empty.<br>Pick something tasty from the menu.</div>`;
    foot.innerHTML = "";
    return;
  }

  body.innerHTML = cart
    .map((l) => {
      const item = itemsById.get(l.itemId);
      const meta = lineMeta(l);
      const unavailable = !isAvailable(item);
      return `<div class="line" data-key="${esc(l.key)}">
        <div class="line-emoji">${artHtml(item)}</div>
        <div>
          <div class="line-name">${esc(item.name)}${unavailable ? ` <strong class="stock-badge">OUT OF STOCK</strong>` : ""}</div>
          ${meta.length ? `<div class="line-meta">${meta.map(esc).join(" · ")}</div>` : ""}
          <div class="line-actions">
            <div class="stepper">
              <button type="button" data-act="dec" aria-label="Decrease">−</button>
              <span>${l.qty}</span>
              <button type="button" data-act="inc" aria-label="Increase">+</button>
            </div>
            <button type="button" class="link-btn" data-act="del">Remove</button>
          </div>
        </div>
        <div class="line-total">${money(round2(unitPrice(item, l) * l.qty))}</div>
      </div>`;
    })
    .join("");

  const t = cartTotals();
  const underMin = orderType === "delivery" && t.subtotal < menu.minDeliveryOrder;
  const hasUnavailable = cart.some((l) => !isAvailable(itemsById.get(l.itemId)));
  let note = "";
  if (underMin) {
    note = `<p class="note warn">Delivery needs a minimum of ${money(menu.minDeliveryOrder)} — add ${money(round2(menu.minDeliveryOrder - t.subtotal))} more, or switch to pickup.</p>`;
  } else if (orderType === "delivery" && t.fee > 0) {
    note = `<p class="note">Add ${money(round2(menu.freeDeliveryOver - t.subtotal))} more for free delivery.</p>`;
  }

  foot.innerHTML = `
    <div class="totals">
      <div class="row"><span>Subtotal</span><span>${money(t.subtotal)}</span></div>
      ${orderType === "delivery" ? `<div class="row"><span>Delivery</span><span>${t.fee ? money(t.fee) : "Free"}</span></div>` : ""}
      <div class="row grand"><span>Total</span><span>${money(t.total)}</span></div>
    </div>
    ${note}
    ${hasUnavailable ? `<p class="note warn">Remove out-of-stock items before checkout.</p>` : ""}
    <button class="btn primary block" id="toCheckout" ${underMin || hasUnavailable ? "disabled" : ""}>Go to checkout</button>`;

  $("#toCheckout", foot).addEventListener("click", openCheckout);
}

function wireCart() {
  $("#cartBtn").addEventListener("click", () => {
    renderCartBits();
    openOverlay("#cartOverlay");
  });

  $$(".seg-btn").forEach((b) =>
    b.addEventListener("click", () => {
      orderType = b.dataset.type;
      store("ss_type", orderType);
      renderCartBits();
    })
  );

  $("#cartBody").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const key = btn.closest(".line").dataset.key;
    const line = cart.find((l) => l.key === key);
    if (!line) return;
    if (btn.dataset.act === "inc") line.qty = Math.min(MAX_QTY, line.qty + 1);
    if (btn.dataset.act === "dec") line.qty -= 1;
    if (btn.dataset.act === "del" || line.qty < 1) cart = cart.filter((l) => l.key !== key);
    saveCart();
    renderCartBits();
  });
}

/* ---------- checkout ---------- */

function openCheckout() {
  const t = cartTotals();
  const delivery = orderType === "delivery";
  $("#addressRow").hidden = !delivery;
  $("#checkoutError").hidden = true;

  $('#checkoutForm input[name="payment"][value="cash"]').checked = true;

  const saved = store("ss_customer") || {};
  const f = $("#checkoutForm").elements;
  f.name.value = saved.name || "";
  f.phone.value = saved.phone || "";
  f.address.value = saved.address || "";

  $("#checkoutSummary").innerHTML = `
    <div class="row"><span>${cartCount()} item${cartCount() === 1 ? "" : "s"} · ${delivery ? "Delivery" : orderType === "eat_here" ? "Eat here" : "Takeaway"}</span><span>${money(t.subtotal)}</span></div>
    ${delivery ? `<div class="row"><span>Delivery</span><span>${t.fee ? money(t.fee) : "Free"}</span></div>` : ""}
    <div class="row grand"><span>Total</span><span>${money(t.total)}</span></div>`;

  closeOverlay($("#cartOverlay"));
  openOverlay("#checkoutOverlay");
}

function wireCheckout() {
  $("#checkoutForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const err = $("#checkoutError");
    const btn = $("#placeBtn");
    err.hidden = true;

    const payload = {
      type: orderType,
      payment: f.payment.value,
      customer: {
        name: f.name.value,
        phone: f.phone.value,
        address: orderType === "delivery" ? f.address.value : "",
        notes: f.notes.value,
      },
      items: cart.map((l) => ({ itemId: l.itemId, qty: l.qty, size: l.size, spice: l.spice, addons: l.addons, removed: l.removed })),
    };

    btn.disabled = true;
    btn.textContent = "Placing order…";
    try {
      const res = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Something went wrong.");

      store("ss_customer", { name: payload.customer.name, phone: payload.customer.phone, address: f.address.value });
      store("ss_last_order", data.order.id);
      cart = [];
      saveCart();
      f.notes.value = "";
      renderCartBits();
      showTrackButton();
      closeOverlay($("#checkoutOverlay"));
      openTracker(data.order.id);
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = "Place order";
    }
  });
}

/* ---------- order tracking ---------- */

const STEP_LABELS = {
  pickup: ["Received", "Preparing", "Ready for takeaway", "Picked up"],
  eat_here: ["Received", "Preparing", "Ready to eat", "Served"],
  delivery: ["Received", "Preparing", "On its way", "Delivered"],
};
const STEP_ICONS = ["📝", "👨‍🍳", "🛍️", "✅"];
const STATUS_INDEX = { received: 0, preparing: 1, ready: 2, out_for_delivery: 2, picked_up: 2, completed: 3 };

function headline(order) {
  const d = order.type === "delivery";
  return {
    received: "We've got your order!",
    preparing: "Your food is on the grill 🔥",
    ready: d ? "Your order is on its way 🛵" : order.type === "eat_here" ? "Your table order is ready! 🎉" : "Ready for pickup! 🎉",
    out_for_delivery: "Your order is on its way 🛵",
    picked_up: "Your driver has your order 🛵",
    completed: d ? "Delivered — enjoy! 😋" : order.type === "eat_here" ? "Served — enjoy! 😋" : "Picked up — enjoy! 😋",
    cancelled: "This order was cancelled",
  }[order.status];
}

function renderTracker(order) {
  const labels = STEP_LABELS[order.type];
  const idx = STATUS_INDEX[order.status];
  const cancelled = order.status === "cancelled";

  $("#trackBody").innerHTML = `
    <div class="track-id">ORDER ${esc(order.id)}</div>
    <h2 class="track-title" id="trackTitle">${esc(headline(order))}</h2>
    <p class="muted">${order.type === "delivery" ? "Delivery" : order.type === "eat_here" ? "Eat here" : "Takeaway"} · ${({cash:"Cash",card:"Card",bizum:"Bizum",counter:order.type === "delivery" ? "Pay on delivery" : "Pay at the counter"})[order.payment] || esc(order.payment)}</p>
    ${
      cancelled
        ? `<div class="cancelled-banner">Sorry — the restaurant cancelled this order. Please call us or place a new one.</div>`
        : `<div class="steps">${labels
            .map((l, i) => {
              const cls = i < idx || order.status === "completed" ? "done" : i === idx ? "current" : "";
              return `<div class="step ${cls}"><div class="dot">${cls === "done" ? "✓" : STEP_ICONS[i]}</div>${esc(l)}</div>`;
            })
            .join("")}</div>
          <div class="bar"><i style="width:${(idx / 3) * 100}%"></i></div>`
    }
    <div class="track-items">
      ${order.items
        .map((l) => {
          const extra = [l.unit, l.size, ...(l.spice ? ["Spice: " + l.spice] : []), ...l.addons.map((a) => "+ " + a), ...l.removed.map((r) => "No " + r.toLowerCase())].filter(Boolean);
          return `<div class="row"><span>${l.qty}× ${esc(l.name)}${extra.length ? ` <span class="muted">(${extra.map(esc).join(", ")})</span>` : ""}</span><span>${money(l.lineTotal)}</span></div>`;
        })
        .join("")}
      ${order.deliveryFee ? `<div class="row"><span>Delivery</span><span>${money(order.deliveryFee)}</span></div>` : ""}
      <div class="row" style="font-weight:900;font-size:17px;margin-top:6px"><span>Total</span><span>${money(order.total)}</span></div>
    </div>
    ${
      order.status === "completed" || cancelled
        ? `<button class="btn primary block" style="margin-top:16px" data-close>Back to menu</button>`
        : `<p class="note">This page updates automatically.</p>`
    }`;
}

async function fetchOrder(id) {
  const res = await fetch("/api/orders/" + encodeURIComponent(id));
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Order not found.");
  return data.order;
}

function stopTracking() {
  clearTimeout(trackTimer);
  trackTimer = null;
}

async function openTracker(id) {
  stopTracking();
  $("#trackBody").innerHTML = `<p class="muted">Loading your order…</p>`;
  openOverlay("#trackOverlay");

  const tick = async () => {
    if ($("#trackOverlay").hidden) return;
    try {
      const order = await fetchOrder(id);
      renderTracker(order);
      if (order.status !== "completed" && order.status !== "cancelled") {
        trackTimer = setTimeout(tick, 4000);
      }
    } catch (ex) {
      $("#trackBody").innerHTML = `<h2>Order not found</h2><p class="muted">${esc(ex.message)}</p>`;
      store("ss_last_order", null);
      showTrackButton();
    }
  };
  tick();
}

function showTrackButton() {
  const id = store("ss_last_order");
  const btn = $("#trackBtn");
  btn.hidden = !id;
  btn.onclick = () => id && openTracker(id);
}


async function refreshStock() {
  try {
    const res = await fetch("/api/menu", { cache: "no-store" });
    if (!res.ok) return;
    const latest = await res.json();
    const catalogChanged = JSON.stringify(menu.items) !== JSON.stringify(latest.items) ||
      JSON.stringify(menu.categories) !== JSON.stringify(latest.categories);
    const stockChanged = JSON.stringify(menu.stock || {}) !== JSON.stringify(latest.stock || {});

    // Refresh the whole catalogue as well as stock. This makes new or edited
    // dishes appear on customer pages that were already open.
    menu = { ...menu, ...latest, stock: latest.stock || {} };
    if (catalogChanged) {
      itemsById.clear();
      menu.items.forEach((item) => itemsById.set(item.id, item));
    }
    if (catalogChanged || stockChanged) {
      renderMenu();
      renderCartBits();
    }
  } catch (_) {
    // Keep the last known menu and stock state if the network is temporarily unavailable.
  }
}

/* ---------- boot ---------- */

async function init() {
  wireOverlays();
  try {
    const res = await fetch("/api/menu", { cache: "no-store" });
    if (!res.ok) throw new Error("Menu request failed");
    menu = await res.json();
  } catch (_) {
    $("#menuRoot").innerHTML = `<p class="error">Couldn't load the menu. Please refresh the page.</p>`;
    return;
  }
  menu.items.forEach((i) => itemsById.set(i.id, i));

  // Drop basket lines for items that no longer exist on the menu.
  cart = cart.filter((l) => itemsById.has(l.itemId));

  renderMenu();
  wireCart();
  wireCheckout();
  renderCartBits();
  showTrackButton();
  setInterval(refreshStock, 15000);

  const fromUrl = new URLSearchParams(location.search).get("order");
  if (fromUrl) openTracker(fromUrl.toUpperCase());
}

init();

// Lets phones offer "Install app" / "Add to Home Screen".
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* the site works fine without it */
    });
  });
}
