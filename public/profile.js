"use strict";
const $ = (s) => document.querySelector(s);
const TOKEN_KEYS = ["ss_auth_token", "ss_chef_token", "ss_driver_token", "ss_admin_token"];
const HOME = { admin: "/admin.html", chef: "/staff.html", driver: "/driver.html", customer: "/menu.html" };
let mode = "login";

function showMessage(text) { $("#message").textContent = text; $("#message").hidden = false; }
function currentToken() { for (const k of TOKEN_KEYS) { const t = localStorage.getItem(k); if (t) return t; } return ""; }
function clearSession() { [...TOKEN_KEYS, "ss_customer_profile"].forEach((k) => localStorage.removeItem(k)); }

function setMode(next) {
  mode = next;
  const reg = mode === "register";
  $("#authTitle").textContent = reg ? "Create account" : "Welcome";
  $("#nameField").hidden = !reg; $("#phoneField").hidden = !reg; $("#roleField").hidden = !reg;
  $("#passwordHint").hidden = !reg;
  $("#forgotLink").hidden = reg; $("#forgotBox").hidden = true;
  $("#password").autocomplete = reg ? "new-password" : "current-password";
  $("#submitButton").textContent = reg ? "Create account" : "Login";
  $("#switchLine").innerHTML = reg
    ? 'Already have an account? <a href="#" data-mode="login">Log in</a>'
    : 'Don\'t have an account? <a href="#" data-mode="register">Create one</a>';
  $("#termsLine").innerHTML = (reg ? "By creating an account" : "By logging in") + ' you accept the <a href="/terms.html">Terms &amp; Conditions</a>';
  $("#message").hidden = true;
}

function saveSession(d) {
  const role = d.user.role;
  TOKEN_KEYS.forEach((k) => localStorage.removeItem(k));
  const key = role === "chef" ? "ss_chef_token" : role === "driver" ? "ss_driver_token" : "ss_auth_token";
  localStorage.setItem(key, d.token);
  localStorage.setItem("ss_customer_profile", JSON.stringify(d.user));
  location.href = HOME[role] || HOME.customer;
}

document.addEventListener("click", (e) => {
  const sw = e.target.closest("[data-mode]");
  if (sw) { e.preventDefault(); setMode(sw.dataset.mode); }
});

$("#forgotLink").addEventListener("click", (e) => { e.preventDefault(); $("#forgotBox").hidden = !$("#forgotBox").hidden; });

$("#togglePw").addEventListener("click", () => {
  const input = $("#password");
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  $("#togglePw").setAttribute("aria-pressed", String(show));
  $("#togglePw").setAttribute("aria-label", show ? "Hide password" : "Show password");
  $("#togglePw").classList.toggle("on", show);
});

$("#accountForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.currentTarget.elements;
  const body = { email: f.email.value.trim(), password: f.password.value };
  if (!body.email || !body.password) { showMessage("Enter your email and password."); return; }

  if (mode === "login" && body.email.toLowerCase() === "admin") {
    try {
      const r = await fetch("/api/auth/admin-login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: body.password }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Admin login failed.");
      TOKEN_KEYS.forEach((k) => localStorage.removeItem(k));
      localStorage.setItem("ss_admin_token", d.token);
      location.href = HOME.admin;
    } catch (err) { showMessage(err.message); }
    return;
  }

  if (mode === "register") {
    body.name = f.name.value.trim(); body.phone = f.phone.value.trim(); body.address = f.address.value.trim(); body.role = f.role.value;
  }
  const btn = $("#submitButton");
  btn.disabled = true;
  try {
    const r = await fetch("/api/auth/" + (mode === "register" ? "register" : "login"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || d.message || "Could not continue.");
    if (d.token) { saveSession(d); return; }
    const email = body.email;
    setMode("login");
    f.email.value = email; f.password.value = "";
    showMessage(d.message || "Account created. Please log in.");
  } catch (err) { showMessage(err.message); } finally { btn.disabled = false; }
});

$("#logoutButton").addEventListener("click", async () => {
  try { await fetch("/api/auth/logout", { method: "POST", headers: { Authorization: "Bearer " + currentToken() } }); } catch (_) { /* ignore */ }
  clearSession();
  location.replace("/");
});

// Already signed in on this device? Offer to continue instead of showing the form.
if (currentToken()) {
  fetch("/api/auth/me", { headers: { Authorization: "Bearer " + currentToken() } })
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then((d) => {
      $("#authForm").hidden = true;
      $("#signedIn").hidden = false;
      $("#profileSummary").textContent = "Signed in as " + (d.user.name || d.user.email);
      $("#continueButton").href = HOME[d.user.role] || HOME.customer;
      if (d.user.role === "customer") showPastOrders();
    })
    .catch(clearSession);
}

// Past orders with a one-tap re-order (customers only)
function showPastOrders() {
  fetch("/api/customer/orders", { headers: { Authorization: "Bearer " + currentToken() } })
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then((res) => {
      if (!res.orders || !res.orders.length) return;
      $("#pastOrdersSection").hidden = false;
      $("#pastOrdersList").innerHTML = res.orders.map((o) => `
        <div class="past-order">
          <div class="past-head"><span>Order #${o.id}</span><span>€${o.total.toFixed(2)}</span></div>
          <div class="hint">${new Date(o.createdAt).toLocaleString()} · Status: <strong>${o.status}</strong></div>
          <div class="past-items">${o.items.map((i) => `${i.qty}× ${i.name}`).join(", ")}</div>
          <button class="btn ghost" type="button" data-reorder='${JSON.stringify(o.items).replace(/'/g, "&#39;")}'>🔄 Re-order</button>
        </div>`).join("");
      document.querySelectorAll("[data-reorder]").forEach((b) => b.addEventListener("click", () => {
        try {
          const items = JSON.parse(b.dataset.reorder);
          const cart = items.map((i) => {
            const line = { itemId: i.itemId, spice: i.spice || null, qty: i.qty, size: i.size || null, addons: [...(i.addons || [])], removed: [...(i.removed || [])] };
            line.key = [line.itemId, line.size || "", line.spice || "", [...line.addons].sort().join(","), [...line.removed].sort().join(",")].join("|");
            return line;
          });
          localStorage.setItem("ss_cart", JSON.stringify(cart));
          location.href = "/menu.html";
        } catch (_) { /* ignore */ }
      }));
    })
    .catch(() => {});
}
