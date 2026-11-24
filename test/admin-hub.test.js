"use strict";

/* Admin dashboard (day's takings and profit), Client page (customers, comments) and the comment API. */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const net = require("node:net");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

const ADMIN = "test-admin-pw";
let child, base, tmpDir, token, chefToken;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on("error", reject);
});
const adminGet = (p) => fetch(base + p, { headers: { "x-admin-password": ADMIN } });
const adminSend = (method, p, body) => fetch(base + p, { method, headers: { "Content-Type": "application/json", "x-admin-password": ADMIN }, body: body ? JSON.stringify(body) : undefined });
const order = (payment, type = "pickup", qty = 2) => fetch(base + "/api/orders", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
  body: JSON.stringify({ type, payment, customer: { name: "Dash Customer", phone: "+34 600 111 222", address: "Calle Mayor 1" }, items: [{ itemId: "classic-smash", qty }] }),
}).then((r) => r.json());
const comment = (body, tok = token) => fetch(base + "/api/comments", {
  method: "POST", headers: { "Content-Type": "application/json", ...(tok ? { Authorization: "Bearer " + tok } : {}) }, body: JSON.stringify(body),
});

before(async () => {
  const menu = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "menu.fixture.json"), "utf8"));
  menu.payments = ["counter", "card", "bizum"];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spice-hub-"));
  const menuFile = path.join(tmpDir, "menu.json");
  fs.writeFileSync(menuFile, JSON.stringify(menu));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(port), ADMIN_PASSWORD: ADMIN, DRIVER_PASSWORD: "test-driver-password-123", DATA_DIR: tmpDir, MENU_FILE: menuFile, EMAIL_TEST_MODE: "true", DATABASE_URL: "", PGHOST: "", STRIPE_SECRET_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const end = Date.now() + 30000;
  for (;;) {
    try { if ((await fetch(base + "/healthz")).ok) break; } catch (_) { /* wait */ }
    if (Date.now() > end) throw new Error("server did not start:\n" + log);
    await new Promise((r) => setTimeout(r, 200));
  }
  const h = { "Content-Type": "application/json" };
  const reg = await fetch(base + "/api/auth/register", { method: "POST", headers: h, body: JSON.stringify({ name: "Dash Customer", email: "dash@example.com", phone: "+34 600 000 000", password: "dash-customer-password", role: "customer" }) });
  assert.equal(reg.status, 201);
  const login = await fetch(base + "/api/auth/login", { method: "POST", headers: h, body: JSON.stringify({ email: "dash@example.com", password: "dash-customer-password" }) });
  token = (await login.json()).token;
  // orders are updated by approved kitchen staff, not by the admin
  const chef = await fetch(base + "/api/auth/register", { method: "POST", headers: h, body: JSON.stringify({ name: "Hub Chef", email: "hub-chef@example.com", phone: "+34 600 000 002", password: "hub-chef-password-1", role: "chef" }) });
  assert.equal(chef.status, 201);
  assert.equal((await adminSend("PATCH", "/api/admin/staff-applications/hub-chef%40example.com", { approved: true })).status, 200);
  chefToken = (await (await fetch(base + "/api/auth/login", { method: "POST", headers: h, body: JSON.stringify({ email: "hub-chef@example.com", password: "hub-chef-password-1" }) })).json()).token;
});
const chefPatch = (id, body) => fetch(base + "/api/admin/orders/" + id, { method: "PATCH", headers: { "Content-Type": "application/json", Authorization: "Bearer " + chefToken }, body: JSON.stringify(body) });

after(async () => {
  if (child) { child.kill("SIGTERM"); await new Promise((r) => child.once("exit", r)); }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("the dashboard and client pages need the admin", async () => {
  assert.equal((await fetch(base + "/api/admin/dashboard")).status, 401);
  assert.equal((await fetch(base + "/api/admin/clients")).status, 401);
  assert.equal((await fetch(base + "/api/admin/dashboard", { headers: { Authorization: "Bearer " + token } })).status, 401, "a customer is not an admin");
});

test("an empty day shows zeros and no profit", async () => {
  const d = await (await adminGet("/api/admin/dashboard")).json();
  assert.equal(d.orders, 0);
  assert.equal(d.revenue, 0);
  assert.equal(d.profit, null);
  assert.equal(d.trend.length, 7);
  assert.equal(d.date, d.today);
});

test("today's takings add up orders, payment methods, order types and best sellers", async () => {
  const a = (await order("counter", "pickup", 2)).order;
  const b = (await order("bizum", "delivery", 3)).order;
  const d = await (await adminGet("/api/admin/dashboard")).json();
  assert.equal(d.orders, 2);
  assert.equal(d.revenue, Math.round((a.total + b.total) * 100) / 100);
  assert.equal(d.itemsSold, 5);
  assert.equal(d.byPayment.counter.orders, 1);
  assert.equal(d.byPayment.bizum.amount, b.total);
  assert.equal(d.byType.delivery.orders, 1);
  assert.equal(d.deliveryFees, b.deliveryFee);
  assert.equal(d.topItems[0].qty, 5);
  assert.equal(d.toCollect, d.revenue, "nothing marked as paid yet");
  assert.equal(d.trend.at(-1).revenue, d.revenue);
  // marking an order paid moves it from "still to collect" to "received"
  assert.equal((await fetch(base + "/api/admin/orders/" + a.id + "/payment", { method: "PATCH", headers: { "Content-Type": "application/json", Authorization: "Bearer " + chefToken }, body: JSON.stringify({ received: true }) })).status, 200);
  const d2 = await (await adminGet("/api/admin/dashboard")).json();
  assert.equal(d2.collected, a.total);
});

test("cancelled orders are not counted as money in", async () => {
  const c = (await order("counter", "pickup", 1)).order;
  assert.equal((await chefPatch(c.id, { status: "cancelled" })).status, 200);
  const d = await (await adminGet("/api/admin/dashboard")).json();
  assert.equal(d.orders, 2);
  assert.equal(d.cancelled, 1);
});

test("profit is estimated from the cost set on a dish, and the cost stays private", async () => {
  const items = (await (await adminGet("/api/admin/menu/items")).json());
  const item = items.items.find((i) => i.id === "classic-smash");
  const saved = await adminSend("PATCH", "/api/admin/menu/items/classic-smash", { name: item.name, description: item.description, category: item.category, price: item.price, unit: item.unit || "", emoji: item.emoji || "🍔", image: item.image || "", cost: "1.50" });
  assert.equal(saved.status, 200);
  const d = await (await adminGet("/api/admin/dashboard")).json();
  const expected = Math.round((d.itemsSold * item.price - d.itemsSold * 1.5) * 100) / 100;
  assert.equal(d.profit, expected);
  assert.equal(d.costCoverage, 100);
  const publicMenu = await (await fetch(base + "/api/menu")).json();
  assert.ok(publicMenu.items.every((i) => !("cost" in i)), "customers never see the cost");
});

test("another day with no orders is empty", async () => {
  const d = await (await adminGet("/api/admin/dashboard?date=2001-01-01")).json();
  assert.equal(d.orders, 0);
  assert.equal(d.date, "2001-01-01");
});

test("a customer can leave a comment and the admin sees it on the Client page", async () => {
  assert.equal((await comment({ message: "Great samosas!", rating: 5 })).status, 201);
  const c = await (await adminGet("/api/admin/clients")).json();
  assert.equal(c.comments.length, 1);
  assert.equal(c.comments[0].message, "Great samosas!");
  assert.equal(c.comments[0].rating, 5);
  assert.equal(c.comments[0].name, "Dash Customer");
  const me = c.customers.find((x) => x.email === "dash@example.com");
  assert.ok(me, "customer is listed");
  assert.equal(me.orders, 2);
  assert.ok(me.spent > 0);
});

test("comments need a signed-in customer, a real message and a 1-5 rating", async () => {
  assert.equal((await comment({ message: "hello there" }, "")).status, 400);
  assert.equal((await comment({ message: "ok" })).status, 400);
  assert.equal((await comment({ message: "fine food", rating: 9 })).status, 400);
  assert.equal((await comment({ message: "no rating needed" })).status, 201);
});

test("comments are limited to five an hour per customer", async () => {
  let last;
  for (let i = 0; i < 6; i++) last = await comment({ message: "spam spam " + i });
  assert.equal(last.status, 400);
});

test("the admin can delete a comment", async () => {
  const list = (await (await adminGet("/api/admin/clients")).json()).comments;
  assert.equal((await adminSend("DELETE", "/api/admin/comments/" + list[0].id)).status, 200);
  const after = (await (await adminGet("/api/admin/clients")).json()).comments;
  assert.equal(after.length, list.length - 1);
  assert.equal((await adminSend("DELETE", "/api/admin/comments/NOPE")).status, 404);
});

test("favourites are saved on the customer's account, ignore unknown dishes and need a customer", async () => {
  const put = (body, tok = token) => fetch(base + "/api/customer/favorites", { method: "PUT", headers: { "Content-Type": "application/json", ...(tok ? { Authorization: "Bearer " + tok } : {}) }, body: JSON.stringify(body) });
  assert.equal((await put({ favorites: ["classic-smash"] }, "")).status, 400, "signed-out visitors can't save");
  const saved = await (await put({ favorites: ["classic-smash", "classic-smash", "not-a-dish", 42] })).json();
  assert.deepEqual(saved.favorites, ["classic-smash"]);
  const got = await (await fetch(base + "/api/customer/favorites", { headers: { Authorization: "Bearer " + token } })).json();
  assert.deepEqual(got.favorites, ["classic-smash"]);
  assert.equal((await put({ favorites: "nope" })).status, 400);
  assert.deepEqual((await (await put({ favorites: [] })).json()).favorites, [], "clearing works");
});

test("the Veg and Spicy tags can be set on a dish and are kept when other fields are edited", async () => {
  const items = (await (await adminGet("/api/admin/menu/items")).json()).items;
  const item = items.find((i) => i.id === "classic-smash");
  const base_ = { name: item.name, description: item.description, category: item.category, price: item.price, unit: item.unit || "", emoji: item.emoji || "🍔", image: item.image || "" };
  assert.equal((await adminSend("PATCH", "/api/admin/menu/items/classic-smash", { ...base_, veg: true, spicy: true })).status, 200);
  let pub = (await (await fetch(base + "/api/menu")).json()).items.find((i) => i.id === "classic-smash");
  assert.deepEqual(pub.tags, ["veg", "spicy"]);
  assert.equal((await adminSend("PATCH", "/api/admin/menu/items/classic-smash", { ...base_, price: item.price })).status, 200);
  pub = (await (await fetch(base + "/api/menu")).json()).items.find((i) => i.id === "classic-smash");
  assert.deepEqual(pub.tags, ["veg", "spicy"], "tags survive an edit that doesn't mention them");
});
