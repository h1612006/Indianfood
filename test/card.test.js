"use strict";

/*
 * Online card payment (Stripe) tests. A fake Stripe server stands in for api.stripe.com,
 * so nothing real is charged. The real app runs as a separate process.
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

const ADMIN = "test-admin-pw";
const WHSEC = "whsec_test_secret";
let child, base, tmpDir, token, fake, fakeBase, failStripe = false;
const stripeCalls = [];

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on("error", reject);
});

before(async () => {
  // fake Stripe
  const fport = await freePort();
  fakeBase = `http://127.0.0.1:${fport}/v1/`;
  fake = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      if (failStripe) { res.statusCode = 500; return res.end(JSON.stringify({ error: { message: "boom" } })); }
      const params = Object.fromEntries(new URLSearchParams(body));
      stripeCalls.push({ auth: req.headers.authorization, url: req.url, params });
      const id = "cs_test_" + stripeCalls.length;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ id, url: "https://checkout.stripe.test/pay/" + id }));
    });
  });
  await new Promise((r) => fake.listen(fport, r));

  // menu that offers card
  const menu = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "menu.fixture.json"), "utf8"));
  menu.payments = ["counter", "card"];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spice-card-"));
  const menuFile = path.join(tmpDir, "menu.json");
  fs.writeFileSync(menuFile, JSON.stringify(menu));

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: {
      ...process.env, PORT: String(port), ADMIN_PASSWORD: ADMIN, DRIVER_PASSWORD: "test-driver-password-123",
      DATA_DIR: tmpDir, MENU_FILE: menuFile, EMAIL_TEST_MODE: "true",
      DATABASE_URL: "", PGHOST: "",
      STRIPE_SECRET_KEY: "sk_test_fake", STRIPE_WEBHOOK_SECRET: WHSEC, STRIPE_API_BASE: fakeBase,
      PUBLIC_URL: "https://shop.example.com",
    },
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
  const reg = await fetch(base + "/api/auth/register", { method: "POST", headers: h, body: JSON.stringify({ name: "Card Customer", email: "card@example.com", phone: "+34 600 000 000", password: "card-customer-password", role: "customer" }) });
  assert.equal(reg.status, 201);
  const login = await fetch(base + "/api/auth/login", { method: "POST", headers: h, body: JSON.stringify({ email: "card@example.com", password: "card-customer-password" }) });
  token = (await login.json()).token;
});

after(async () => {
  if (child) { child.kill("SIGTERM"); await new Promise((r) => child.once("exit", r)); }
  if (fake) await new Promise((r) => fake.close(r));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const order = (payment) => fetch(base + "/api/orders", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
  body: JSON.stringify({ type: "pickup", payment, customer: { name: "Card Customer", phone: "+34 600 111 222" }, items: [{ itemId: "classic-smash", qty: 2 }] }),
});
const kitchen = async () => (await (await fetch(base + "/api/admin/orders", { headers: { "x-admin-password": ADMIN } })).json()).orders;

function webhook(event, { secret = WHSEC, t = Math.floor(Date.now() / 1000) } = {}) {
  const raw = JSON.stringify(event);
  const sig = crypto.createHmac("sha256", secret).update(t + "." + raw).digest("hex");
  return fetch(base + "/api/stripe/webhook", { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": `t=${t},v1=${sig}` }, body: raw });
}
const completed = (o, sessionId, extra = {}) => ({
  type: "checkout.session.completed",
  data: { object: { id: sessionId, payment_status: "paid", amount_total: Math.round(o.total * 100), currency: "eur", metadata: { orderId: o.id }, ...extra } },
});

test("the menu tells the page that online card payment is on", async () => {
  assert.equal((await (await fetch(base + "/api/menu")).json()).onlineCard, true);
});

test("a card order opens a Stripe payment for the exact server-side total", async () => {
  const res = await order("card");
  const data = await res.json();
  assert.equal(res.status, 201);
  assert.match(data.checkoutUrl, /^https:\/\/checkout\.stripe\.test\/pay\//);
  assert.equal(data.order.awaitingPayment, true);
  assert.equal(data.order.paymentReceived, false);
  const call = stripeCalls.at(-1);
  assert.equal(call.auth, "Bearer sk_test_fake");
  assert.equal(call.params["line_items[0][price_data][unit_amount]"], String(Math.round(data.order.total * 100)));
  assert.equal(call.params["line_items[0][price_data][currency]"], "eur");
  assert.equal(call.params["metadata[orderId]"], data.order.id);
  assert.equal(call.params.success_url, `https://shop.example.com/menu.html?paid=${data.order.id}`);
  assert.equal(call.params.cancel_url, `https://shop.example.com/menu.html?cancelled=${data.order.id}`);
});

test("an unpaid card order stays hidden from the kitchen until Stripe confirms it", async () => {
  const data = await (await order("card")).json();
  assert.ok(!(await kitchen()).some((o) => o.id === data.order.id));
});

test("the webhook rejects a wrong signature, a wrong secret and an old timestamp", async () => {
  const data = await (await order("card")).json();
  const ev = completed(data.order, "cs_test_" + stripeCalls.length);
  assert.equal((await fetch(base + "/api/stripe/webhook", { method: "POST", headers: { "Stripe-Signature": "t=1,v1=abc" }, body: JSON.stringify(ev) })).status, 400);
  assert.equal((await webhook(ev, { secret: "whsec_other" })).status, 400);
  assert.equal((await webhook(ev, { t: Math.floor(Date.now() / 1000) - 3600 })).status, 400);
  assert.ok(!(await kitchen()).some((o) => o.id === data.order.id));
});

test("a paid event marks the order paid and shows it to the kitchen", async () => {
  const data = await (await order("card")).json();
  const sid = "cs_test_" + stripeCalls.length;
  assert.equal((await webhook(completed(data.order, sid))).status, 200);
  const mine = (await kitchen()).find((o) => o.id === data.order.id);
  assert.ok(mine, "kitchen sees it now");
  assert.equal(mine.paymentReceived, true);
  assert.equal(mine.paidOnline, true);
  const tracked = (await (await fetch(base + "/api/orders/" + data.order.id)).json()).order;
  assert.equal(tracked.paymentReceived, true);
  assert.equal(tracked.awaitingPayment, false);
  assert.equal((await webhook(completed(data.order, sid))).status, 200, "a repeat delivery is harmless");
});

test("a payment of the wrong amount or for another session is ignored", async () => {
  const data = await (await order("card")).json();
  const sid = "cs_test_" + stripeCalls.length;
  await webhook(completed(data.order, sid, { amount_total: 1 }));
  await webhook(completed(data.order, "cs_other"));
  await webhook(completed(data.order, sid, { payment_status: "unpaid" }));
  assert.ok(!(await kitchen()).some((o) => o.id === data.order.id));
});

test("an abandoned card payment is cancelled when Stripe says the session expired", async () => {
  const data = await (await order("card")).json();
  const sid = "cs_test_" + stripeCalls.length;
  await webhook({ type: "checkout.session.expired", data: { object: { id: sid, metadata: { orderId: data.order.id } } } });
  const tracked = (await (await fetch(base + "/api/orders/" + data.order.id)).json()).order;
  assert.equal(tracked.status, "cancelled");
});

test("counter orders are unaffected and go straight to the kitchen", async () => {
  const data = await (await order("counter")).json();
  assert.equal(data.checkoutUrl, undefined);
  assert.ok((await kitchen()).some((o) => o.id === data.order.id));
});

test("if Stripe is down the customer gets a clear message and no ghost order", async () => {
  failStripe = true;
  const before = (await kitchen()).length;
  const res = await order("card");
  failStripe = false;
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Card payment is not available/);
  assert.equal((await kitchen()).length, before);
});
