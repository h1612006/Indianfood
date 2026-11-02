"use strict";

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let password = sessionStorage.getItem("ss_admin") || "";
let orders = [];
let filter = "active";
let currency = "€";
let timer = null;
let knownIds = new Set();
let firstLoad = true;

const ACTIVE = ["received", "preparing", "ready"];

const FILTERS = [
  { id: "active", label: "Active" },
  { id: "done", label: "Done" },
  { id: "all", label: "All" },
];

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", "x-admin-password": password, ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw Object.assign(new Error(data.error || "Unauthorized"), { auth: true });
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

function showLogin(msg) {
  clearTimeout(timer);
  $("#board").hidden = true;
  $("#logout").hidden = true;
  $("#loginBox").hidden = false;
  const e = $("#loginErr");
  e.hidden = !msg;
  e.textContent = msg || "";
}

function showBoard() {
  $("#loginBox").hidden = true;
  $("#board").hidden = false;
  $("#logout").hidden = false;
}

async function load() {
  clearTimeout(timer);
  try {
    const data = await api("/api/admin/orders");
    orders = data.orders;
    showBoard();
    $("#boardErr").hidden = true;

    const newOnes = orders.filter((o) => !knownIds.has(o.id));
    if (!firstLoad && newOnes.length) beep();
    knownIds = new Set(orders.map((o) => o.id));
    firstLoad = false;

    render();
  } catch (ex) {
    if (ex.auth) {
      sessionStorage.removeItem("ss_admin");
      password = "";
      showLogin(ex.message);
      return;
    }
    $("#boardErr").textContent = "Connection problem — retrying… (" + ex.message + ")";
    $("#boardErr").hidden = false;
  }
  timer = setTimeout(load, 5000);
}

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
    osc.start();
    osc.stop(ctx.currentTime + 0.5);
  } catch (_) {
    /* sound is optional */
  }
}

const money = (n) => `${currency}${Number(n).toFixed(2)}`;

function timeAgo(iso) {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso)) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return mins + " min ago";
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function nextAction(o) {
  const delivery = o.type === "delivery";
  return {
    received: { to: "preparing", label: "Start preparing" },
    preparing: { to: "ready", label: delivery ? "Out for delivery" : "Mark ready" },
    ready: { to: "completed", label: delivery ? "Mark delivered" : "Mark picked up" },
  }[o.status];
}

function render() {
  const counts = {
    active: orders.filter((o) => ACTIVE.includes(o.status)).length,
    done: orders.filter((o) => !ACTIVE.includes(o.status)).length,
    all: orders.length,
  };
  $("#filters").innerHTML =
    FILTERS.map(
      (f) => `<button class="cat-tab ${filter === f.id ? "active" : ""}" data-filter="${f.id}">${f.label} (${counts[f.id]})</button>`
    ).join("") + `<span class="status-line">Auto-refreshing every 5s</span>`;

  document.title = counts.active ? `(${counts.active}) Kitchen screen` : "Kitchen screen";

  const shown = orders
    .filter((o) => (filter === "all" ? true : filter === "active" ? ACTIVE.includes(o.status) : !ACTIVE.includes(o.status)))
    // Active orders: oldest first so nothing gets forgotten. Others: newest first (as returned).
    .sort((a, b) => (filter === "active" ? new Date(a.createdAt) - new Date(b.createdAt) : 0));

  if (!shown.length) {
    $("#orders").innerHTML = `<div class="empty-a" style="grid-column:1/-1">No ${filter === "all" ? "" : filter + " "}orders right now. 🍔</div>`;
    return;
  }

  $("#orders").innerHTML = shown
    .map((o) => {
      const act = nextAction(o);
      const final = !ACTIVE.includes(o.status);
      return `<article class="o-card ${esc(o.status)}" data-id="${esc(o.id)}">
        <div class="o-head"><span class="o-id">${esc(o.id)}</span><span class="o-time">${esc(timeAgo(o.createdAt))}</span></div>
        <div>
          <span class="o-pill ${esc(o.type)}">${o.type === "delivery" ? "🛵 Delivery" : "🏪 Pickup"}</span>
          <span class="o-pill">${esc(o.status)}</span>
          <span class="o-pill">${o.payment === "card" ? "Card (demo)" : "Pay " + (o.type === "delivery" ? "on delivery" : "at counter")}</span>
        </div>
        <div class="o-cust">
          <strong>${esc(o.customer.name)}</strong> · ${esc(o.customer.phone)}
          ${o.type === "delivery" ? `<br>📍 ${esc(o.customer.address)}` : ""}
        </div>
        <div class="o-items">
          ${o.items
            .map((l) => {
              const extra = [l.unit, l.size, ...l.addons.map((a) => "+ " + a), ...l.removed.map((r) => "NO " + r.toUpperCase())].filter(Boolean);
              return `<div class="l"><strong>${l.qty}×</strong> ${esc(l.name)}${extra.length ? `<span class="m">${extra.map(esc).join(" · ")}</span>` : ""}</div>`;
            })
            .join("")}
        </div>
        ${o.customer.notes ? `<div class="o-notes">📝 ${esc(o.customer.notes)}</div>` : ""}
        <div class="o-foot"><span>Total</span><span>${money(o.total)}</span></div>
        <div class="o-actions">
          ${act ? `<button class="btn primary" data-set="${act.to}">${esc(act.label)}</button>` : ""}
          ${final ? `<button class="btn" data-set="received">Reopen</button>` : `<button class="btn danger" data-set="cancelled">Cancel</button>`}
        </div>
      </article>`;
    })
    .join("");
}

async function setStatus(id, status) {
  if (status === "cancelled" && !confirm("Cancel order " + id + "?")) return;
  try {
    await api("/api/admin/orders/" + encodeURIComponent(id), { method: "PATCH", body: JSON.stringify({ status }) });
    load();
  } catch (ex) {
    alert(ex.message);
  }
}

async function boot() {
  // The menu file tells us which currency symbol to show.
  try {
    currency = (await (await fetch("/api/menu")).json()).currency || currency;
  } catch (_) {
    /* keep default */
  }

  $("#loginForm").addEventListener("submit", (e) => {
    e.preventDefault();
    password = $("#pw").value;
    sessionStorage.setItem("ss_admin", password);
    firstLoad = true;
    load();
    // If the password was wrong, load() sends us back to the login form with a message.
  });

  $("#logout").addEventListener("click", () => {
    sessionStorage.removeItem("ss_admin");
    password = "";
    $("#pw").value = "";
    showLogin();
  });

  $("#filters").addEventListener("click", (e) => {
    const b = e.target.closest("[data-filter]");
    if (b) {
      filter = b.dataset.filter;
      render();
    }
  });

  $("#orders").addEventListener("click", (e) => {
    const b = e.target.closest("[data-set]");
    if (!b) return;
    setStatus(b.closest(".o-card").dataset.id, b.dataset.set);
  });

  if (password) load();
  else showLogin();
}

boot();
