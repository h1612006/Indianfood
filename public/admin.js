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
let activeSection = "";

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
  $("#kitchenNav").hidden = true;
  $("#menuBtn").hidden = true;
  $("#screenTitle").textContent = "Spice Smash staff access";
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
  $("#kitchenNav").hidden = !adminOnly;
  $("#menuBtn").hidden = !adminOnly;
  $("#dashboard").hidden = !adminOnly;
  $("#screenTitle").textContent = adminOnly ? "⚙️ Spice Smash Admin" : "🔥 Kitchen staff";
  if (chefOnly) activeSection = "ordersPanel";
  else if (adminOnly && !activeSection) activeSection = (location.hash || "").slice(1) || "ordersPanel";
  showSection(activeSection);
}
function showSection(sectionId) {
  const adminOnly = !!localStorage.getItem("ss_admin_token") || !!password;
  const allowed = adminOnly ? ["ordersPanel", "stockPanel", "menuPanel", "staffApprovals", "clientPanel"] : ["ordersPanel"];
  if (!allowed.includes(sectionId)) sectionId = "ordersPanel";
  activeSection = sectionId;
  document.querySelectorAll(".kitchen-section").forEach(section => { section.hidden = section.id !== activeSection; });
  document.querySelectorAll("#kitchenNav [data-section]").forEach(button => {
    button.classList.toggle("active", button.dataset.section === activeSection);
    button.setAttribute("aria-current", button.dataset.section === activeSection ? "page" : "false");
  });
  if (adminOnly) history.replaceState(null, "", "#" + sectionId);
  if (adminOnly && sectionId === "clientPanel") loadClients().catch((err) => { $("#clientComments").textContent = "Could not load: " + err.message; });
}

/* ---------- Home: the day's takings ---------- */
const eur = (n) => "€" + Number(n || 0).toFixed(2);
const PAY_LABEL = { counter: "Pay at counter", cash: "Cash", card: "Card", bizum: "Bizum", other: "Other" };
const TYPE_LABEL = { pickup: "Takeaway", eat_here: "Eat here", delivery: "Delivery", other: "Other" };
let dashDay = "";

function barRows(obj, labels, total) {
  const rows = Object.entries(obj || {});
  if (!rows.length) return '<p class="muted">No orders yet.</p>';
  return rows.sort((a, b) => b[1].amount - a[1].amount).map(([k, v]) => {
    const pct = total > 0 ? Math.round((v.amount / total) * 100) : 0;
    return `<div class="bar-row"><div class="bar-label"><span>${esc(labels[k] || k)}</span><strong>${eur(v.amount)} <small>· ${v.orders} order${v.orders === 1 ? "" : "s"}</small></strong></div><div class="bar-track"><i style="width:${pct}%"></i></div></div>`;
  }).join("");
}

async function loadDashboard() {
  const d = await api("/api/admin/dashboard" + (dashDay ? "?date=" + encodeURIComponent(dashDay) : ""));
  const input = $("#dashDate");
  if (document.activeElement !== input) input.value = d.date;
  input.max = d.today;
  const isToday = d.date === d.today;
  $("#dashTitle").textContent = isToday ? "Today" : new Date(d.date + "T12:00:00").toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
  const profit = d.profit === null
    ? `<div class="kpi dim"><span>Estimated profit</span><strong>–</strong><small>Add “Cost to make” to dishes in Menu</small></div>`
    : `<div class="kpi good"><span>Estimated profit</span><strong>${eur(d.profit)}</strong><small>${d.costCoverage}% of sold dishes have a cost</small></div>`;
  $("#kpis").innerHTML = `
    <div class="kpi main"><span>Money in</span><strong>${eur(d.revenue)}</strong><small>${d.orders} order${d.orders === 1 ? "" : "s"}${d.cancelled ? " · " + d.cancelled + " cancelled" : ""}</small></div>
    <div class="kpi"><span>Received</span><strong>${eur(d.collected)}</strong><small>${eur(d.toCollect)} still to collect</small></div>
    ${profit}
    <div class="kpi"><span>Items sold</span><strong>${d.itemsSold}</strong><small>${eur(d.itemsSales)} from food</small></div>
    <div class="kpi"><span>Average order</span><strong>${eur(d.average)}</strong></div>
    <div class="kpi"><span>Delivery fees</span><strong>${eur(d.deliveryFees)}</strong>${d.tips ? `<small>+ ${eur(d.tips)} tips</small>` : ""}</div>`;
  $("#dashPay").innerHTML = barRows(d.byPayment, PAY_LABEL, d.revenue);
  $("#dashType").innerHTML = barRows(d.byType, TYPE_LABEL, d.revenue);
  $("#dashTop").innerHTML = d.topItems.length
    ? d.topItems.map((t, i) => `<div class="top-row"><span class="rank">${i + 1}</span><span class="nm">${esc(t.name)}</span><span class="qty">${t.qty}×</span><strong>${eur(t.amount)}</strong></div>`).join("")
    : '<p class="muted">Nothing sold yet.</p>';
  const max = Math.max(1, ...d.trend.map((t) => t.revenue));
  $("#dashTrend").innerHTML = d.trend.map((t) => {
    const h = Math.max(3, Math.round((t.revenue / max) * 100));
    const label = new Date(t.date + "T12:00:00").toLocaleDateString(undefined, { weekday: "short" });
    return `<button type="button" class="tbar${t.date === d.date ? " on" : ""}" data-day="${t.date}" title="${eur(t.revenue)} · ${t.orders} orders"><em>${t.revenue ? eur(t.revenue).replace(".00", "") : ""}</em><i style="height:${h}%"></i><span>${label}</span></button>`;
  }).join("");
}

/* ---------- Client: comments and customers ---------- */
function stars(n) { return n ? "★".repeat(n) + "☆".repeat(5 - n) : ""; }
async function loadClients() {
  const d = await api("/api/admin/clients");
  const rated = d.comments.filter((c) => c.rating);
  const avg = rated.length ? (rated.reduce((t, c) => t + c.rating, 0) / rated.length).toFixed(1) : null;
  $("#clientComments").innerHTML = d.comments.length
    ? `<p class="muted">${d.comments.length} comment${d.comments.length === 1 ? "" : "s"}${avg ? ` · average <strong class="avg">${avg} ★</strong>` : ""}</p>
       <div class="comment-list">${d.comments.map((c) => `
         <article class="comment" data-id="${esc(c.id)}">
           <div class="c-head"><strong>${esc(c.name)}</strong><span class="c-stars" aria-label="${c.rating || 0} out of 5">${stars(c.rating)}</span></div>
           <p class="c-msg">${esc(c.message)}</p>
           <div class="c-foot"><small>${esc(c.email)} · ${new Date(c.createdAt).toLocaleString()}</small><button type="button" class="btn danger" data-del-comment="${esc(c.id)}">Delete</button></div>
         </article>`).join("")}</div>`
    : '<p class="muted">No comments yet. Customers can leave one at the bottom of the menu page.</p>';
  $("#clientCustomers").innerHTML = d.customers.length
    ? `<p class="muted">${d.customers.length} customer${d.customers.length === 1 ? "" : "s"}, biggest spenders first.</p><div class="menu-list">${d.customers.map((c) => `
        <div class="menu-item-row"><div><strong>${esc(c.name)}</strong><small>${esc(c.email)}${c.phone ? " · " + esc(c.phone) : ""}</small></div><span class="item-price">${c.orders} order${c.orders === 1 ? "" : "s"}</span><strong>${eur(c.spent)}</strong></div>`).join("")}</div>`
    : '<p class="muted">No customer accounts yet.</p>';
}

async function load() {
  clearTimeout(timer);
  try {
    const data = await api("/api/admin/orders");
    orders = data.orders;
    showBoard();
    $("#boardErr").hidden = true;
    if (!localStorage.getItem("ss_chef_token")) { try { await loadDashboard(); } catch (dashError) { $("#kpis").textContent = "Could not load the summary: " + dashError.message; } }
    try { await loadStock(); } catch (stockError) { $("#stockItems").textContent = "Could not load stock: " + stockError.message; }
    if (!localStorage.getItem("ss_chef_token")) { try { await loadStaffApplications(); await loadStaffDirectory(); } catch (staffError) { $("#staffApplicationsList").textContent = "Could not load staff: " + staffError.message; } }

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
  form.elements.cost.value = item && item.cost != null ? item.cost : "";
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
  $("#staffApplicationsList").innerHTML=staffApplications.map(u=>"<div class='menu-item-row'><div><strong>"+esc(u.name)+"</strong><small>"+esc(u.email)+" · "+esc(u.role)+" · "+(u.emailVerified?"Email verified":"Email not verified")+" · Applied "+esc(new Date(u.createdAt).toLocaleDateString())+"</small></div><button class='btn primary' data-staff-approve='true' data-email='"+esc(u.email)+"'>Approve</button><button class='btn danger' data-staff-approve='false' data-email='"+esc(u.email)+"'>Reject</button></div>").join("")||"<p class='empty-a'>No pending staff applications.</p>";
}
async function loadStaffDirectory() {
  const data=await api("/api/admin/users");
  const staff=(data.users||[]).filter(u=>["chef","driver"].includes(u.role));
  $("#staffDirectoryList").innerHTML=staff.map(u=>"<article class='staff-card'><strong>"+esc(u.name||"")+"</strong><small>Role: "+esc(u.role)+" · ID: "+esc(u.staffId||"Not assigned")+"</small><small>Email: "+esc(u.email)+"</small><small>Phone: "+esc(u.phone||"Not provided")+"</small><small>Address: "+esc(u.address||"Not provided")+"</small><small>Email: "+(u.emailVerified?"Verified":"Not verified")+" · Account: "+(u.approved?"Approved":"Pending / rejected")+"</small><small>Created: "+(u.createdAt?esc(new Date(u.createdAt).toLocaleString()):"—")+"</small></article>").join("")||"<p class='empty-a'>No staff accounts yet.</p>";
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
      const kitchenCanUpdate = !!localStorage.getItem("ss_chef_token");
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
          ${act && kitchenCanUpdate ? `<button class="btn primary" data-set="${act.to}">${esc(act.label)}</button>` : ""}
          ${kitchenCanUpdate ? (final ? `<button class="btn" data-set="received">Reopen</button>` : `<button class="btn danger" data-set="cancelled">Cancel</button>`) : ""}
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
        if(!r.ok) throw new Error((d.error||"Login failed.")+(d.verificationRequired?" Open the main account page (/profile.html) to enter your email code.":""));
        if(d.user.role!=="chef") throw new Error("This account is not an approved kitchen staff account.");
        localStorage.setItem("ss_chef_token",d.token); password="";
      }catch(ex){showLogin(ex.message);return;}
    }else{sessionStorage.setItem("ss_admin",password);}
    firstLoad=true;load();
  });

  $("#logout").addEventListener("click", () => {
    sessionStorage.removeItem("ss_admin");
    ["ss_auth_token","ss_chef_token","ss_driver_token","ss_admin_token","ss_customer_profile"].forEach(k=>localStorage.removeItem(k));
    password = "";
    $("#pw").value = "";
    showLogin();
  });

  $("#kitchenNav").addEventListener("click", (e) => {
    const button = e.target.closest("[data-section]");
    if (button && !button.hidden) showSection(button.dataset.section);
  });

  $("#dashDate").addEventListener("change", (e) => { dashDay = e.target.value; loadDashboard().catch(() => {}); });
  $("#dashTrend").addEventListener("click", (e) => { const b = e.target.closest("[data-day]"); if (b) { dashDay = b.dataset.day; loadDashboard().catch(() => {}); } });
  $("#clientPanel").addEventListener("click", async (e) => {
    const v = e.target.closest("[data-client-view]");
    if (v) {
      const customers = v.dataset.clientView === "customers";
      $("#clientComments").hidden = customers; $("#clientCustomers").hidden = !customers;
      document.querySelectorAll("[data-client-view]").forEach((x) => x.classList.toggle("active", x === v));
      return;
    }
    const del = e.target.closest("[data-del-comment]");
    if (del && confirm("Delete this comment?")) {
      try { await api("/api/admin/comments/" + encodeURIComponent(del.dataset.delComment), { method: "DELETE" }); await loadClients(); }
      catch (err) { alert(err.message); }
    }
  });

  $("#filters").addEventListener("click", (e) => {
    const b = e.target.closest("[data-filter]");
    if (b) {
      filter = b.dataset.filter;
      render();
    }
  });

  $("#staffApplications").addEventListener("click", e => { const b=e.target.closest("[data-staff-approve]"); if(b) reviewStaff(b.dataset.email,b.dataset.staffApprove==="true"); });
  $("#staffApprovals").addEventListener("click", e => { const b=e.target.closest("[data-staff-view]"); if(!b)return; const directory=b.dataset.staffView==="directory"; $("#staffApplications").hidden=directory; $("#staffDirectory").hidden=!directory; document.querySelectorAll("[data-staff-view]").forEach(x=>x.classList.toggle("active",x===b)); if(directory)loadStaffDirectory().catch(err=>$("#staffDirectoryList").textContent=err.message); });

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
      cost: form.elements.cost.value,
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
