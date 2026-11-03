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
let menuItems = [];
let stock = {};
let menuCategories = [];
let editingMenuId = null;
let staffApplications = [];
let activeSection = "ordersPanel";

const ACTIVE = ["received", "preparing", "ready", "out_for_delivery", "picked_up"];

const FILTERS = [
  { id: "active", label: "Active" },
  { id: "done", label: "Done" },
  { id: "all", label: "All" },
];

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", "x-admin-password": password, "Authorization": localStorage.getItem("ss_chef_token") ? "Bearer " + localStorage.getItem("ss_chef_token") : (localStorage.getItem("ss_admin_token") ? "Bearer " + localStorage.getItem("ss_admin_token") : ""), ...(options.headers || {}) },
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
  const chefOnly = !!localStorage.getItem("ss_chef_token");
  const adminOnly = !!localStorage.getItem("ss_admin_token") || !!password;
  const approvalsButton = $('#kitchenNav [data-section="staffApprovals"]');
  if (approvalsButton) approvalsButton.hidden = chefOnly;
  if (chefOnly && activeSection === "staffApprovals") activeSection = "ordersPanel";
  showSection(activeSection);
}

function showSection(sectionId) {
  const allowed = ["ordersPanel", "stockPanel", "menuPanel", "staffApprovals"];
  if (!allowed.includes(sectionId)) sectionId = "ordersPanel";
  if (sectionId === "staffApprovals" && localStorage.getItem("ss_chef_token")) sectionId = "ordersPanel";
  activeSection = sectionId;
  document.querySelectorAll(".kitchen-section").forEach(section => {
    section.hidden = section.id !== activeSection;
  });
  document.querySelectorAll("#kitchenNav [data-section]").forEach(button => {
    button.classList.toggle("active", button.dataset.section === activeSection);
    button.setAttribute("aria-current", button.dataset.section === activeSection ? "page" : "false");
  });
}

async function load() {
  clearTimeout(timer);
  try {
    const data = await api("/api/admin/orders");
    orders = data.orders;
    showBoard();
    $("#boardErr").hidden = true;
    try { await loadStock(); } catch (stockError) { $("#stockItems").textContent = "Could not load stock: " + stockError.message; }
    if (!localStorage.getItem("ss_chef_token")) { try { await loadStaffApplications(); } catch (staffError) { $("#staffApplications").textContent = "Could not load applications: " + staffError.message; } }

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

async function loadStock() {
  const [stockData, menuData] = await Promise.all([
    api("/api/admin/stock"),
    api("/api/admin/menu/items"),
  ]);
  stock = stockData.stock || {};
  menuItems = menuData.items || [];
  menuCategories = menuData.categories || [];
  renderStock();
  renderMenuItems();
}

function renderStock() {
  $("#stockItems").innerHTML = menuItems.map((item) => {
    const available = stock[item.id] !== false;
    return `<div class="stock-row"><strong>${esc(item.name)}</strong><button class="stock-toggle ${available ? "" : "off"}" data-stock="${esc(item.id)}" data-available="${available}">${available ? "In stock" : "Out of stock"}</button></div>`;
  }).join("");
}

function renderMenuItems() {
  $("#menuItemsEditor").innerHTML = menuItems.map((item) => {
    const category = menuCategories.find((c) => c.id === item.category);
    return `<div class="menu-item-row">
      <div><strong>${esc(item.emoji || "🍽️")} ${esc(item.name)}</strong><small>${esc(category ? category.name : item.category)} · ${esc(item.unit || "standard portion")}</small></div>
      <strong class="item-price">${money(item.price)}</strong>
      <button type="button" class="btn" data-edit-menu="${esc(item.id)}">Edit</button>
    </div>`;
  }).join("") || '<p class="empty-a">No menu items yet.</p>';
}

function openMenuEditor(item = null) {
  editingMenuId = item ? item.id : null;
  const form = $("#menuItemForm");
  $("#menuEditorTitle").textContent = item ? "Edit menu item" : "Add menu item";
  $("#saveMenuItem").textContent = item ? "Save changes" : "Add item";
  form.elements.name.value = item ? item.name : "";
  form.elements.category.innerHTML = menuCategories.map((category) =>
    `<option value="${esc(category.id)}">${esc(category.emoji || "")} ${esc(category.name)}</option>`
  ).join("");
  form.elements.category.value = item ? item.category : (menuCategories[0] && menuCategories[0].id) || "";
  form.elements.price.value = item ? item.price : "";
  form.elements.unit.value = item ? item.unit || "" : "";
  form.elements.description.value = item ? item.description || "" : "";
  form.elements.image.value = item ? item.image || "" : "";
  form.elements.emoji.value = item ? item.emoji || "" : "🍽️";
  $("#menuFormError").hidden = true;
  $("#menuEditor").hidden = false;
  $("#menuEditor").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function setStock(id, available, button) {
  button.disabled = true;
  try { const data = await api("/api/admin/stock/" + encodeURIComponent(id), { method:"PATCH", body:JSON.stringify({available}) }); stock = data.stock || stock; renderStock(); }
  catch (ex) { alert(ex.message); button.disabled = false; }
}


async function loadStaffApplications() {
  const data=await api("/api/admin/staff-applications");
  staffApplications=data.applications||[];
  $("#staffApplications").innerHTML=staffApplications.map(u=>`<div class="menu-item-row"><div><strong>${esc(u.name)}</strong><small>${esc(u.email)} · ${esc(u.role)} · Applied ${esc(new Date(u.createdAt).toLocaleDateString())}</small></div><button class="btn primary" data-staff-approve="true" data-email="${esc(u.email)}">Approve</button><button class="btn danger" data-staff-approve="false" data-email="${esc(u.email)}">Reject</button></div>`).join("")||'<p class="empty-a">No pending staff applications.</p>';
}
async function reviewStaff(email, approved) {
  try { await api("/api/admin/staff-applications/"+encodeURIComponent(email),{method:"PATCH",body:JSON.stringify({approved})}); await loadStaffApplications(); }
  catch(ex) { alert(ex.message); }
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
    received: { to: "preparing", label: "Accept order · start preparing" },
    preparing: { to: delivery ? "out_for_delivery" : "ready", label: delivery ? "Out for delivery · generate OTPs" : "Mark ready" },
    ready: { to: "completed", label: o.type === "eat_here" ? "Mark served" : "Mark picked up" },
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
          <span class="o-pill ${esc(o.type)}">${o.type === "delivery" ? "🛵 Delivery" : o.type === "eat_here" ? "🍽️ Eat here" : "🥡 Takeaway"}</span>
          <span class="o-pill">${esc(o.status.replaceAll("_", " "))}</span>
          <span class="o-pill">${({cash:"Cash",card:"Card",bizum:"Bizum",counter:"Pay at counter"})[o.payment] || esc(o.payment)}</span>
        </div>
        <div class="o-cust">
          <strong>${esc(o.customer.name)}</strong> · ${esc(o.customer.phone)}
          ${o.type === "delivery" ? `<br>📍 ${esc(o.customer.address)}<br>🚚 Driver: ${esc(o.driverAcceptedBy || "Awaiting acceptance")}` : ""}
        </div>
        <div class="o-items">
          ${o.items
            .map((l) => {
              const extra = [l.unit, l.size, ...(l.spice ? ["Spice: " + l.spice] : []), ...l.addons.map((a) => "+ " + a), ...l.removed.map((r) => "NO " + r.toUpperCase())].filter(Boolean);
              return `<div class="l"><strong>${l.qty}×</strong> ${esc(l.name)}${extra.length ? `<span class="m">${extra.map(esc).join(" · ")}</span>` : ""}</div>`;
            })
            .join("")}
        </div>
        ${o.customer.notes ? `<div class="o-notes">📝 ${esc(o.customer.notes)}</div>` : ""}
        <div class="o-foot"><span>Total</span><span>${money(o.total)}</span></div>
        <div class="o-notes">Payment: <strong>${o.paymentReceived ? "RECEIVED ✓" : "NOT RECEIVED"}</strong> · <button class="link-btn" data-payment="${o.paymentReceived ? "false" : "true"}">${o.paymentReceived ? "Mark not received" : "Mark received"}</button></div>
        ${o.status === "out_for_delivery" || o.status === "picked_up" ? `<div class="o-notes"><strong>Handover codes — manager only</strong><br>Pickup code: <strong>${esc(o.pickupOtp || "Already confirmed")}</strong><br>Customer delivery code: <strong>${esc(o.deliveryOtp || "Already confirmed")}</strong><br><small>Share the pickup code with the driver and the delivery code with the customer. Never show the customer code to the driver.</small></div>` : ""}
        <div class="o-actions">
          ${act ? `<button class="btn primary" data-set="${act.to}">${esc(act.label)}</button>` : ""}
          ${final ? `<button class="btn" data-set="received">Reopen</button>` : `<button class="btn danger" data-set="cancelled">Cancel</button>`}
        </div>
      </article>`;
    })
    .join("");
}

async function setPayment(id, received) {
  try { await api("/api/admin/orders/" + encodeURIComponent(id) + "/payment", {method:"PATCH", body:JSON.stringify({received})}); load(); }
  catch (ex) { alert(ex.message); }
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
    const menu = await (await fetch("/api/menu")).json();
    currency = menu.currency || currency;
    menuItems = menu.items || [];
  } catch (_) {
    /* keep default */
  }

  $("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email=$("#staffEmail").value.trim();
    password=$("#pw").value;
    if(email){
      try{
        const r=await fetch("/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email,password})});
        const d=await r.json();
        if(!r.ok) throw new Error(d.error||"Login failed.");
        if(d.user.role!=="chef") throw new Error("This account is not an approved kitchen staff account.");
        localStorage.setItem("ss_chef_token",d.token); password="";
      }catch(ex){showLogin(ex.message);return;}
    }else{sessionStorage.setItem("ss_admin",password);}
    firstLoad=true;load();
  });

  $("#logout").addEventListener("click", () => {
    sessionStorage.removeItem("ss_admin");
    localStorage.removeItem("ss_chef_token");
    localStorage.removeItem("ss_admin_token");
    password = "";
    $("#pw").value = "";
    showLogin();
  });

  $("#kitchenNav").addEventListener("click", (e) => {
    const button = e.target.closest("[data-section]");
    if (button && !button.hidden) showSection(button.dataset.section);
  });

  $("#filters").addEventListener("click", (e) => {
    const b = e.target.closest("[data-filter]");
    if (b) {
      filter = b.dataset.filter;
      render();
    }
  });

  $("#staffApplications").addEventListener("click", e => { const b=e.target.closest("[data-staff-approve]"); if(b) reviewStaff(b.dataset.email,b.dataset.staffApprove==="true"); });

  $("#stockItems").addEventListener("click", (e) => {
    const b = e.target.closest("[data-stock]");
    if (b) setStock(b.dataset.stock, b.dataset.available !== "true", b);
  });

  $("#newMenuItem").addEventListener("click", () => openMenuEditor());
  $("#cancelMenuEdit").addEventListener("click", () => { $("#menuEditor").hidden = true; editingMenuId = null; });
  $("#menuItemsEditor").addEventListener("click", (e) => {
    const b = e.target.closest("[data-edit-menu]");
    if (b) openMenuEditor(menuItems.find((item) => item.id === b.dataset.editMenu));
  });
  $("#menuItemForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const body = {
      name: form.elements.name.value.trim(),
      category: form.elements.category.value,
      price: Number(form.elements.price.value),
      unit: form.elements.unit.value.trim(),
      description: form.elements.description.value.trim(),
      image: form.elements.image.value.trim(),
      emoji: form.elements.emoji.value.trim() || "🍽️",
    };
    const save = $("#saveMenuItem");
    const error = $("#menuFormError");
    save.disabled = true;
    error.hidden = true;
    try {
      const path = editingMenuId
        ? "/api/admin/menu/items/" + encodeURIComponent(editingMenuId)
        : "/api/admin/menu/items";
      await api(path, { method: editingMenuId ? "PATCH" : "POST", body: JSON.stringify(body) });
      $("#menuEditor").hidden = true;
      editingMenuId = null;
      await loadStock();
      alert("Menu item saved. It is now available on the customer menu.");
    } catch (ex) {
      error.textContent = ex.message;
      error.hidden = false;
    } finally {
      save.disabled = false;
    }
  });

  $("#orders").addEventListener("click", (e) => {
    const pay = e.target.closest("[data-payment]");
    if (pay) { setPayment(pay.closest(".o-card").dataset.id, pay.dataset.payment === "true"); return; }
    const b = e.target.closest("[data-set]");
    if (!b) return;
    setStatus(b.closest(".o-card").dataset.id, b.dataset.set);
  });

  if (password || localStorage.getItem("ss_chef_token") || localStorage.getItem("ss_admin_token")) load();
  else showLogin();
}

boot();
