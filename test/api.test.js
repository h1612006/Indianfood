"use strict";

/*
 * End-to-end API tests. They start the real server as a separate process and talk to it
 * over HTTP, so they exercise exactly what customers and the kitchen use.
 *
 *   npm test                                  -> uses a temporary JSON file store
 *   DATABASE_URL=postgres://... npm test      -> uses Postgres
 *   (PGHOST, PGUSER, PGPASSWORD, PGDATABASE also work)
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const net = require("node:net");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

const ADMIN = "test-admin-pw";
const DRIVER = "test-driver-password-123";
let child;
let base;
let tmpDir;
let defaultCustomerToken;
let chefToken;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

async function waitForHealth(url, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url + "/healthz");
      if (r.ok) return;
    } catch (_) {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Server did not become healthy in time");
}

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spice-test-"));
  child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: {
      ...process.env,
      PORT: String(port),
      ADMIN_PASSWORD: ADMIN,
      DRIVER_PASSWORD: DRIVER,
      DATA_DIR: tmpDir,
      // A fixed test menu with sizes, extras and removals, so these tests do not change
      // when the real menu in data/menu.json is edited.
      MENU_FILE: path.join(__dirname, "fixtures", "menu.fixture.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  child.on("exit", (code) => {
    if (code) console.error("Server exited early:\n" + log);
  });
  await waitForHealth(base);
  const customerRegistration = await fetch(base + "/api/auth/register", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:"Default Test Customer",email:"default-customer@example.com",phone:"+34 600 000 000",password:"default-customer-password",role:"customer"})});
  defaultCustomerToken = (await customerRegistration.json()).token;
  await fetch(base + "/api/auth/register", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:"Kitchen Test Chef",email:"kitchen-chef@example.com",phone:"+34 600 000 001",password:"kitchen-chef-password",role:"chef"})});
  await fetch(base + "/api/admin/staff-applications/kitchen-chef%40example.com", {method:"PATCH",headers:{"Content-Type":"application/json",...{"x-admin-password":ADMIN}},body:JSON.stringify({approved:true})});
  const chefLogin=await fetch(base+"/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:"kitchen-chef@example.com",password:"kitchen-chef-password"})});
  chefToken=(await chefLogin.json()).token;
  console.log("Testing against:", /Order storage: (.*)/.exec(log)?.[1] || "unknown storage");
});

after(async () => {
  if (child) {
    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/* ---------- helpers ---------- */

const json = (method, url, body, headers = {}) =>
  fetch(base + url, {
    method,
    headers: { "Content-Type": "application/json", ...(defaultCustomerToken ? {"Authorization":"Bearer "+defaultCustomerToken} : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const admin = { "x-admin-password": ADMIN };
const chefHeaders = { "Authorization": "Bearer " + (chefToken || "") };
const customer = { name: "Test Customer", phone: "+34 600 111 222" };

async function placeOrder(overrides = {}) {
  const res = await json("POST", "/api/orders", {
    type: "pickup",
    payment: "counter",
    customer,
    items: [{ itemId: "classic-smash", qty: 1 }],
    ...overrides,
  });
  return { res, data: await res.json() };
}

/* ---------- tests ---------- */

test("health check and menu", async () => {
  assert.equal((await fetch(base + "/healthz")).status, 200);
  const menu = await (await fetch(base + "/api/menu")).json();
  assert.equal(menu.brand, "Spice Smash");
  assert.ok(menu.items.length >= 19, "menu includes the fixture catalogue and any persisted manager additions");
});

test("prices are calculated on the server (sizes, extras, quantities)", async () => {
  const { res, data } = await placeOrder({
    items: [
      { itemId: "classic-smash", qty: 2, addons: ["bacon", "combo"], removed: ["Pickles"] },
      { itemId: "masala-fries", qty: 1, size: "l" },
    ],
  });
  assert.equal(res.status, 201);
  // 2 x (6.90 + 1.20 + 3.50) + (3.50 + 1.50) = 28.20
  assert.equal(data.order.subtotal, 28.2);
  assert.equal(data.order.total, 28.2);
  assert.equal(data.order.status, "received");
  assert.match(data.order.id, /^SS-[A-Z0-9]{5}$/);
  assert.deepEqual(data.order.items[0].removed, ["Pickles"]);
});

test("a price sent by the browser is ignored", async () => {
  const { data } = await placeOrder({
    items: [{ itemId: "classic-smash", qty: 1, price: 0.01, unitPrice: 0.01 }],
    total: 0.01,
  });
  assert.equal(data.order.total, 6.9);
});

test("invalid orders are rejected with a helpful message (400)", async () => {
  const cases = [
    [{ items: [{ itemId: "nope", qty: 1 }] }, /Unknown menu item/],
    [{ items: [{ itemId: "water", qty: -3 }] }, /Quantity/],
    [{ items: [{ itemId: "water", qty: 101 }] }, /Quantity/],
    [{ items: [{ itemId: "water", qty: 1, addons: ["bacon"] }] }, /add-on/],
    [{ items: [] }, /basket is empty/],
    [{ type: "teleport" }, /pickup or delivery/],
    [{ customer: { name: "", phone: customer.phone } }, /name/],
    [{ customer: { name: "A", phone: "abc" } }, /phone/],
    [
      { type: "delivery", customer: { ...customer, address: "Calle Mayor 1" }, items: [{ itemId: "water", qty: 1 }] },
      /Minimum order/,
    ],
    [{ type: "delivery", customer, items: [{ itemId: "classic-smash", qty: 2 }] }, /address/],
  ];
  for (const [override, message] of cases) {
    const { res, data } = await placeOrder(override);
    assert.equal(res.status, 400, JSON.stringify(override));
    assert.match(data.error, message);
  }
});

test("malformed JSON gets a clean 400, not a crash", async () => {
  const res = await fetch(base + "/api/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{not json",
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "Invalid request.");
  assert.equal((await fetch(base + "/healthz")).status, 200);
});

test("delivery fee applies below the free-delivery threshold only", async () => {
  const delivery = { type: "delivery", customer: { ...customer, address: "Calle Mayor 1" } };
  const small = (await placeOrder({ ...delivery, items: [{ itemId: "classic-smash", qty: 3 }] })).data.order;
  assert.deepEqual([small.subtotal, small.deliveryFee, small.total], [20.7, 2.5, 23.2]);
  const big = (await placeOrder({ ...delivery, items: [{ itemId: "classic-smash", qty: 4 }] })).data.order;
  assert.deepEqual([big.subtotal, big.deliveryFee, big.total], [27.6, 0, 27.6]);
});

test("customers can track their order but never see personal details", async () => {
  const { data } = await placeOrder({ customer: { ...customer, notes: "secret note" } });
  const id = data.order.id;

  const lower = await fetch(base + "/api/orders/" + id.toLowerCase());
  assert.equal(lower.status, 200);
  const tracked = (await lower.json()).order;
  assert.equal(tracked.id, id);
  assert.equal("customer" in tracked, false);
  assert.equal(JSON.stringify(tracked).includes("secret note"), false);
  assert.equal(JSON.stringify(tracked).includes(customer.phone), false);

  assert.equal((await fetch(base + "/api/orders/SS-NOPE0")).status, 404);
});

test("kitchen endpoints need the admin password", async () => {
  assert.equal((await fetch(base + "/api/admin/orders")).status, 401);
  assert.equal((await json("GET", "/api/admin/orders", undefined, { "x-admin-password": "wrong" })).status, 401);
  const { data } = await placeOrder();
  assert.equal((await json("PATCH", "/api/admin/orders/" + data.order.id, { status: "ready" })).status, 403);
});

test("kitchen can move an order through every status, and the customer sees it", async () => {
  const { data } = await placeOrder();
  const id = data.order.id;

  for (const status of ["preparing", "ready", "completed"]) {
    const res = await json("PATCH", "/api/admin/orders/" + id, { status }, chefHeaders);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).order.status, status);
    const seen = (await (await fetch(base + "/api/orders/" + id)).json()).order;
    assert.equal(seen.status, status);
  }

  assert.equal((await json("PATCH", "/api/admin/orders/" + id, { status: "bogus" }, chefHeaders)).status, 400);
  assert.equal((await json("PATCH", "/api/admin/orders/SS-NOPE0", { status: "ready" }, chefHeaders)).status, 404);
});

test("kitchen list shows full details, newest first", async () => {
  const first = (await placeOrder({ customer: { ...customer, name: "First" } })).data.order.id;
  await new Promise((r) => setTimeout(r, 15));
  const second = (await placeOrder({ customer: { ...customer, name: "Second" } })).data.order.id;

  const { orders } = await (await json("GET", "/api/admin/orders", undefined, admin)).json();
  const ids = orders.map((o) => o.id);
  assert.ok(ids.indexOf(second) < ids.indexOf(first), "newest order comes first");
  const found = orders.find((o) => o.id === second);
  assert.equal(found.customer.name, "Second");
  assert.equal(found.customer.phone, customer.phone);
});

test("HTML in customer text is stored as plain text (the pages escape it)", async () => {
  const evil = '<img src=x onerror="alert(1)">';
  const { data } = await placeOrder({ customer: { ...customer, name: evil } });
  const { orders } = await (await json("GET", "/api/admin/orders", undefined, admin)).json();
  assert.equal(orders.find((o) => o.id === data.order.id).customer.name, evil);
});

test("20 simultaneous orders all succeed with unique ids", async () => {
  const results = await Promise.all(Array.from({ length: 20 }, () => placeOrder()));
  assert.ok(results.every((r) => r.res.status === 201));
  const ids = results.map((r) => r.data.order.id);
  assert.equal(new Set(ids).size, 20);
});


test("customers can register and staff need admin approval", async () => {
  const customerReg=await json("POST","/api/auth/register",{name:"Profile Customer",email:"customer-profile@example.com",phone:"+34 600 222 333",password:"customer-password-123",role:"customer"});
  assert.equal(customerReg.status,201);
  const customerData=await customerReg.json();
  assert.ok(customerData.token);
  assert.equal(customerData.user.role,"customer");
  const staffReg=await json("POST","/api/auth/register",{name:"New Driver",email:"new-driver@example.com",phone:"+34 600 333 444",password:"driver-password-123",role:"driver"});
  assert.equal(staffReg.status,201);
  assert.equal((await json("POST","/api/auth/login",{email:"new-driver@example.com",password:"driver-password-123"})).status,403);
  const pending=await json("GET","/api/admin/staff-applications",undefined,admin);
  const pendingData=await pending.json();
  const driverApplication=pendingData.applications.find(u=>u.email==="new-driver@example.com");
  assert.ok(driverApplication);
  assert.match(driverApplication.staffId,/^DRV-[A-F0-9]{6}$/);
  const approved=await json("PATCH","/api/admin/staff-applications/new-driver%40example.com",{approved:true},admin);
  assert.equal(approved.status,200);
  const login=await json("POST","/api/auth/login",{email:"new-driver@example.com",password:"driver-password-123"});
  assert.equal(login.status,200);
  const driverUser=(await login.json()).user;
  assert.equal(driverUser.role,"driver");
  const byStaffId=await json("POST","/api/auth/login",{email:driverUser.staffId,password:"driver-password-123"});
  assert.equal(byStaffId.status,200);
  assert.equal((await byStaffId.json()).user.email,"new-driver@example.com");
});


test("admin can create and remove customer and staff accounts", async () => {
  const adminLogin=await json("POST","/api/auth/admin-login",{password:ADMIN});
  assert.equal(adminLogin.status,200);
  const adminToken=(await adminLogin.json()).token;
  const adminSession={Authorization:"Bearer "+adminToken};
  const created=await json("POST","/api/admin/users",{name:"Managed Kitchen",email:"managed-kitchen@example.com",phone:"+34 600 555 111",password:"managed-kitchen-password",role:"chef"},adminSession);
  assert.equal(created.status,201);
  const createdUser=(await created.json()).user;
  assert.match(createdUser.staffId,/^KCH-[A-F0-9]{6}$/);
  assert.equal(createdUser.approved,true);
  const listed=await json("GET","/api/admin/users",undefined,adminSession);
  assert.ok((await listed.json()).users.some(u=>u.email==="managed-kitchen@example.com"));
  const removed=await json("DELETE","/api/admin/users/managed-kitchen%40example.com",undefined,adminSession);
  assert.equal(removed.status,200);
  assert.equal((await json("POST","/api/auth/login",{email:"managed-kitchen@example.com",password:"managed-kitchen-password"})).status,401);
});

test("only kitchen staff can accept and update orders", async () => {
  const {data}=await placeOrder();
  const id=data.order.id;
  assert.equal((await json("PATCH","/api/admin/orders/"+id,{status:"preparing"},admin)).status,403);
  assert.equal((await json("PATCH","/api/admin/orders/"+id,{status:"preparing"},chefHeaders)).status,200);
});

test("unknown API routes return JSON 404", async () => {
  const res = await fetch(base + "/api/does-not-exist");
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, "Not found.");
});

test("admin can persist item stock and unavailable items cannot be ordered", async () => {
  const id = "classic-smash";
  const changed = await json("PATCH", "/api/admin/stock/" + id, { available: false }, admin);
  assert.equal(changed.status, 200);
  const changedData = await changed.json();
  const menu = await (await fetch(base + "/api/menu")).json();
  assert.equal(menu.stock[id], false);
  const rejected = await placeOrder();
  assert.equal(rejected.res.status, 400);
  assert.match(rejected.data.error, /out of stock/i);

  const restored = await json("PATCH", "/api/admin/stock/" + id, { available: true }, admin);
  assert.equal(restored.status, 200);
  const restoredData = await restored.json();
  assert.equal(restoredData.stock[id], true);
});


test("kitchen can add and edit menu items and customers can order the saved item", async () => {
  assert.equal((await json("GET", "/api/admin/menu/items")).status, 401);
  const created = await json("POST", "/api/admin/menu/items", {
    name: "Masala Dosa",
    category: "sides",
    price: 8.5,
    unit: "per portion",
    description: "Crisp dosa with spiced potato filling.",
    emoji: "🥞",
  }, admin);
  assert.equal(created.status, 201);
  const item = (await created.json()).item;
  assert.equal(item.id, "masala-dosa");

  const menuAfterCreate = await (await fetch(base + "/api/menu")).json();
  assert.equal(menuAfterCreate.items.find((entry) => entry.id === item.id).price, 8.5);

  const edited = await json("PATCH", "/api/admin/menu/items/" + item.id, {
    name: "Masala Dosa Special",
    category: "sides",
    price: 9.25,
    unit: "per plate",
    description: "Crisp dosa with potato masala and chutney.",
    emoji: "🥞",
  }, admin);
  assert.equal(edited.status, 200);
  assert.equal((await edited.json()).item.price, 9.25);

  const ordered = await placeOrder({ items: [{ itemId: item.id, qty: 1, spice: "Mid" }] });
  assert.equal(ordered.res.status, 201);
  assert.equal(ordered.data.order.items[0].name, "Masala Dosa Special");
  assert.equal(ordered.data.order.total, 9.25);
});

test("eat-here orders are accepted and recorded separately from takeaway", async () => {
  const {res,data}=await placeOrder({type:"eat_here"});
  assert.equal(res.status,201);
  assert.equal(data.order.type,"eat_here");
  assert.equal(data.order.serviceType,"eat_here");
});

test("admin can mark payment received or not received", async () => {
  const {data}=await placeOrder();
  const id=data.order.id;
  const changed=await json("PATCH","/api/admin/orders/"+id+"/payment",{received:true},admin);
  assert.equal(changed.status,200);
  assert.equal((await changed.json()).order.paymentReceived,true);
  const reset=await json("PATCH","/api/admin/orders/"+id+"/payment",{received:false},admin);
  assert.equal((await reset.json()).order.paymentReceived,false);
});

test("driver pickup and customer delivery OTPs are verified separately", async () => {
  const registration=await json("POST","/api/auth/register",{name:"Delivery Customer",email:"delivery-customer@example.com",phone:customer.phone,password:"customer-password-123",role:"customer"});
  const customerSession=await registration.json();
  const delivery={type:"delivery",customer:{...customer,address:"Calle Mayor 1"},items:[{itemId:"classic-smash",qty:3}]};
  const placedRes=await fetch(base+"/api/orders",{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+customerSession.token},body:JSON.stringify(delivery)});
  const placed={res:placedRes,data:await placedRes.json()};
  const id=placed.data.order.id;
  assert.equal(placed.res.status,201);
  await json("PATCH","/api/admin/orders/"+id,{status:"preparing"},chefHeaders);

  const driverHeaders={"x-driver-password":DRIVER};
  const preparingJobs=await (await json("GET","/api/driver/orders",undefined,driverHeaders)).json();
  const preparingJob=preparingJobs.orders.find(o=>o.id===id);
  assert.ok(preparingJob, "driver can see delivery orders while they are being prepared");
  assert.equal(preparingJob.status,"preparing");
  assert.equal("pickupOtp" in preparingJob,false);
  assert.equal("deliveryOtp" in preparingJob,false);
  assert.equal((await json("POST","/api/driver/orders/"+id+"/handover",{action:"pickup",otp:"123456"},driverHeaders)).status,400);

  const accepted=await json("POST","/api/driver/orders/"+id+"/decision",{decision:"accept"},driverHeaders);
  assert.equal(accepted.status,200);
  const sent=await json("PATCH","/api/admin/orders/"+id,{status:"out_for_delivery"},chefHeaders);
  assert.equal(sent.status,200);
  const adminOrders=(await (await json("GET","/api/admin/orders",undefined,admin)).json()).orders;
  const managed=adminOrders.find(o=>o.id===id);
  assert.match(managed.pickupOtp,/^\d{6}$/);
  assert.match(managed.deliveryOtp,/^\d{6}$/);
  const customerView=await (await fetch(base+"/api/orders/"+id,{headers:{"Authorization":"Bearer "+customerSession.token}})).json();
  assert.equal(customerView.order.deliveryOtp,managed.deliveryOtp,"customer account sees its delivery OTP");
  const publicView=await (await fetch(base+"/api/orders/"+id)).json();
  assert.equal("deliveryOtp" in publicView.order,false,"public tracking never reveals the OTP");

  const jobs=await (await json("GET","/api/driver/orders",undefined,driverHeaders)).json();
  const job=jobs.orders.find(o=>o.id===id);
  assert.ok(job);
  assert.equal("deliveryOtp" in job,false);
  assert.equal((await json("POST","/api/driver/orders/"+id+"/handover",{action:"pickup",otp:"000000"},driverHeaders)).status,400);

  const picked=await json("POST","/api/driver/orders/"+id+"/handover",{action:"pickup",otp:managed.pickupOtp},driverHeaders);
  assert.equal(picked.status,200);
  assert.equal((await picked.json()).order.status,"picked_up");
  assert.equal((await json("POST","/api/driver/orders/"+id+"/handover",{action:"delivered",otp:managed.pickupOtp},driverHeaders)).status,400);

  const delivered=await json("POST","/api/driver/orders/"+id+"/handover",{action:"delivered",otp:managed.deliveryOtp},driverHeaders);
  assert.equal(delivered.status,200);
  assert.equal((await delivered.json()).order.status,"completed");
  const afterDelivery=await (await json("GET","/api/driver/orders",undefined,driverHeaders)).json();
  assert.equal(afterDelivery.orders.some(o=>o.id===id),false,"completed deliveries disappear from the active driver list");
});
