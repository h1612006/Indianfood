"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { createStore } = require("./db");

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const DRIVER_PASSWORD = process.env.DRIVER_PASSWORD;

// MENU_FILE lets tests (or a second shop) use a different menu; normally it is data/menu.json.
const menu = JSON.parse(
  fs.readFileSync(process.env.MENU_FILE || path.join(__dirname, "data", "menu.json"), "utf8")
);
const itemsById = new Map(menu.items.map((i) => [i.id, i]));

const STATUSES = ["received", "preparing", "ready", "out_for_delivery", "picked_up", "completed", "cancelled"];
const ORDER_TYPES = ["pickup", "delivery", "eat_here"];
const MAX_QTY = 100; // per line, e.g. 60 samosas for a party
// "card" is only a demo (nothing is charged), so it is off unless the menu turns it on.
const PAYMENTS = menu.payments || (menu.cardPaymentDemo ? ["counter", "card"] : ["counter"]);

const store = createStore();
const otpFailures = new Map();
const sessions = new Map();

/* A mistake in what the customer sent (shown to them, HTTP 400). */
class UserError extends Error {}

// Never return password hashes, salts, or email-verification secrets to any browser.
function safeUser(user) {
  if (!user) return null;
  const { password, passwordHash, passwordSalt, emailOtpHash, emailOtpExpiresAt, emailOtpAttempts, emailOtpSentAt, ...safe } = user;
  return safe;
}
function otpHash(email, code) {
  return crypto.createHash("sha256").update(email.toLowerCase() + ":" + code + ":" + (process.env.OTP_PEPPER || ADMIN_PASSWORD || "spice-smash-email-otp")).digest("hex");
}
async function sendVerificationEmail(email, code) {
  if (process.env.EMAIL_TEST_MODE === "true" && process.env.NODE_ENV !== "production") return;
  const apiKey = process.env.RESEND_API_KEY, from = process.env.EMAIL_FROM;
  if (!apiKey || !from) throw new Error("Email verification is not configured. Set RESEND_API_KEY and EMAIL_FROM in Render.");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": "Bearer " + apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      from, to: [email], subject: "Your Spice Smash verification code",
      html: "<div style='font-family:Arial,sans-serif;max-width:520px;margin:auto'><h2>Verify your Spice Smash email</h2><p>Enter this one-time code to verify your email address:</p><p style='font-size:30px;font-weight:bold;letter-spacing:8px'>" + code + "</p><p>This code expires in 10 minutes and can only be used once. If you did not request this, you can ignore this email.</p></div>"
    })
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error("Could not send verification email. Check the email sender configuration. " + detail.slice(0, 240));
  }
}
async function issueEmailOtp(user, { allowResend = false } = {}) {
  const now = Date.now();
  if (!allowResend && user.emailOtpSentAt && now - Date.parse(user.emailOtpSentAt) < 60000) {
    throw Object.assign(new UserError("A verification code was sent recently. Check your inbox or wait one minute before requesting another."), { status: 429 });
  }
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  const updated = await store.updateUser(user.email, {
    emailVerified: false,
    emailOtpHash: otpHash(user.email, code),
    emailOtpExpiresAt: new Date(now + 10 * 60 * 1000).toISOString(),
    emailOtpAttempts: 0,
    emailOtpSentAt: new Date(now).toISOString()
  });
  try { await sendVerificationEmail(user.email, code); }
  catch (error) {
    await store.updateUser(user.email, { emailOtpHash: null, emailOtpExpiresAt: null });
    throw error;
  }
  return process.env.EMAIL_TEST_MODE === "true" && process.env.NODE_ENV !== "production" ? code : undefined;
}

const round2 = (n) => Math.round(n * 100) / 100;

function newOrderId() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id = "SS-";
  for (const b of crypto.randomBytes(5)) id += alphabet[b % alphabet.length];
  return id;
}

/* ---------- pricing (always computed on the server) ---------- */

function priceLine(raw) {
  const item = itemsById.get(raw && raw.itemId);
  if (!item) throw new UserError("Unknown menu item.");

  const qty = Number(raw.qty);
  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) {
    throw new UserError(`Quantity must be between 1 and ${MAX_QTY}.`);
  }

  let unit = item.price;
  let sizeName = null;
  if (item.sizes) {
    const sizes = menu.sizes[item.sizes];
    const size = sizes.find((s) => s.id === raw.size) || sizes[0];
    unit += size.delta;
    sizeName = size.name;
  }

  let spice = null;
  if (Array.isArray(item.spiceLevels) && item.spiceLevels.length) {
    if (!item.spiceLevels.includes(raw.spice)) throw new UserError("Choose a spice level for " + item.name + ".");
    spice = raw.spice;
  }
  const addonIds = Array.isArray(raw.addons) ? [...new Set(raw.addons)] : [];
  const addons = addonIds.map((id) => {
    const a = (item.addons || []).find((x) => x.id === id);
    if (!a) throw new UserError("Unknown add-on for " + item.name + ".");
    unit += a.price;
    return a.name;
  });

  const removed = (Array.isArray(raw.removed) ? raw.removed : []).filter((r) =>
    (item.removals || []).includes(r)
  );

  unit = round2(unit);
  return {
    itemId: item.id,
    name: item.name,
    emoji: item.emoji,
    unit: item.unit || null,
    spice,
    qty,
    size: sizeName,
    addons,
    removed: [...new Set(removed)],
    unitPrice: unit,
    lineTotal: round2(unit * qty),
  };
}

function clean(str, max) {
  return String(str || "").trim().slice(0, max);
}

/* Turns the request body into a ready-to-store order (or throws UserError). */
function buildOrder(body) {
  body = body || {};
  const type = body.type;
  if (!ORDER_TYPES.includes(type)) throw new UserError("Choose pickup or delivery.");
  const payment = body.payment || (PAYMENTS.includes("counter") ? "counter" : PAYMENTS[0]);
  if (!PAYMENTS.includes(payment)) throw new UserError("Choose a valid payment method.");

  const c = body.customer || {};
  const customer = {
    name: clean(c.name, 60),
    phone: clean(c.phone, 30),
    address: clean(c.address, 200),
    notes: clean(c.notes, 300),
  };
  if (!customer.name) throw new UserError("Please enter your name.");
  if (!/^[+\d][\d\s().-]{5,}$/.test(customer.phone)) {
    throw new UserError("Please enter a valid phone number.");
  }
  if (type === "delivery" && !customer.address) {
    throw new UserError("Please enter a delivery address.");
  }

  if (!Array.isArray(body.items) || body.items.length === 0) {
    throw new UserError("Your basket is empty.");
  }
  if (body.items.length > 40) throw new UserError("Too many items in one order.");

  const lines = body.items.map(priceLine);
  const subtotal = round2(lines.reduce((s, l) => s + l.lineTotal, 0));

  let deliveryFee = 0;
  if (type === "delivery") {
    if (subtotal < menu.minDeliveryOrder) {
      throw new UserError(
        `Minimum order for delivery is ${menu.currency}${menu.minDeliveryOrder.toFixed(2)}.`
      );
    }
    deliveryFee = subtotal >= menu.freeDeliveryOver ? 0 : menu.deliveryFee;
  }

  const now = new Date().toISOString();
  return {
    type,
    payment,
    customer,
    items: lines,
    subtotal,
    deliveryFee,
    total: round2(subtotal + deliveryFee),
    status: "received",
    serviceType: type === "eat_here" ? "eat_here" : (type === "pickup" ? "takeaway" : "delivery"),
    paymentReceived: false,
    createdAt: now,
    updatedAt: now,
  };
}

// Customers only see what they need to track their own order.
function publicOrder(o, user = null) {
  return {
    id: o.id,
    type: o.type,
    payment: o.payment,
    items: o.items,
    subtotal: o.subtotal,
    deliveryFee: o.deliveryFee,
    total: o.total,
    status: o.status,
    serviceType: o.serviceType || (o.type === "pickup" ? "takeaway" : o.type),
    paymentReceived: !!o.paymentReceived,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    ...(user && user.role === "customer" && o.customerEmail === user.email && o.deliveryOtp ? { deliveryOtp: o.deliveryOtp } : {}),
  };
}

/* ---------- app ---------- */

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "50kb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use((req,res,next)=>{const token=String(req.get("authorization")||"").replace(/^Bearer /,"");req.user=sessions.get(token)||null;next();});

// Express 4 does not catch errors from async handlers, so wrap them.
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// Used by Docker and hosting platforms to check the app (and its database) is alive.
app.get(
  "/healthz",
  wrap(async (_req, res) => {
    try {
      await store.ping();
      res.type("text").send("ok");
    } catch (e) {
      console.error("Health check failed:", e.message);
      res.status(503).type("text").send("storage unavailable");
    }
  })
);

app.get("/api/menu", wrap(async (_req, res) => res.json({ ...menu, stock: await store.listStock() })));

app.post(
  "/api/orders",
  wrap(async (req, res) => {
    if (!req.user || req.user.role !== "customer" || !req.user.approved) throw new UserError("Create a customer account and sign in before ordering.");
    const stock = await store.listStock();
    for (const line of (req.body && Array.isArray(req.body.items) ? req.body.items : [])) {
      if (stock[line && line.itemId] === false) throw new UserError("Out of stock.");
    }
    const order = buildOrder(req.body); // throws UserError on bad input
    if (req.user && req.user.role === "customer" && req.user.approved) order.customerEmail = req.user.email;
    if (req.user && (req.user.role !== "customer" || !req.user.approved)) throw new UserError("Use a customer account to place this order.");

    for (let attempt = 0; ; attempt++) {
      order.id = newOrderId();
      try {
        await store.insertOrder(order);
        break;
      } catch (e) {
        if (e.code === "DUPLICATE" && attempt < 5) continue; // id clash: pick another
        throw e;
      }
    }
    res.status(201).json({ order: publicOrder(order) });
  })
);

app.get(
  "/api/orders/:id",
  wrap(async (req, res) => {
    const order = await store.getOrder(String(req.params.id).toUpperCase());
    if (!order) return res.status(404).json({ error: "Order not found." });
    res.json({ order: publicOrder(order, req.user) });
  })
);


/* ---------- customer and staff accounts ---------- */
app.post("/api/auth/register", wrap(async (req,res) => {
  const email = clean(req.body.email,160).toLowerCase();
  const name = clean(req.body.name,80);
  const phone = clean(req.body.phone,30);
  const address = clean(req.body.address,200);
  const password = String(req.body.password || "");
  const role = req.body.role || "customer";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !name || password.length < 10) throw new UserError("Enter a valid email, your name and a password of at least 10 characters.");
  if (!["customer","chef","driver"].includes(role)) throw new UserError("Choose customer, chef or driver.");
  const salt = crypto.randomBytes(16).toString("hex");
  const user = {email,name,phone,address,role,staffId:role==="chef"?"KCH-"+crypto.randomBytes(3).toString("hex").toUpperCase():role==="driver"?"DRV-"+crypto.randomBytes(3).toString("hex").toUpperCase():null,approved:role==="customer",status:role==="customer"?"approved":"pending",emailVerified:false,passwordSalt:salt,passwordHash:crypto.scryptSync(password,salt,64).toString("hex"),createdAt:new Date().toISOString()};
  try { await store.saveUser(user); } catch(e) { if(e.code==="USER_EXISTS") throw new UserError("An account with this email already exists."); throw e; }
  try {
    const testCode = await issueEmailOtp(user);
    res.status(201).json({message:"We sent a 6-digit verification code to your email. Enter it to verify your account.",verificationRequired:true,email:user.email,...(testCode?{testCode}: {})});
  } catch(error) {
    await store.deleteUser(email);
    throw error;
  }
}));
app.post("/api/auth/login", wrap(async (req,res) => {
  const loginId=clean(req.body.email,160).toLowerCase(), password=String(req.body.password||"");
  const user=loginId.includes("@")?await store.getUser(loginId):(await store.listUsers()).find(u=>String(u.staffId||"").toLowerCase()===loginId)||null;
  const hash=user?crypto.scryptSync(password,user.passwordSalt,64).toString("hex"):"";
  if(!user || hash!==user.passwordHash) return res.status(401).json({error:"Email or password is incorrect."});
  if(user.emailVerified !== true) {
    let testCode;
    if (!user.emailOtpHash || !user.emailOtpExpiresAt || Date.parse(user.emailOtpExpiresAt) <= Date.now()) testCode = await issueEmailOtp(user);
    return res.status(403).json({error:"Please verify your email address before signing in. We have sent a one-time code.",verificationRequired:true,email:user.email,...(testCode?{testCode}: {})});
  }
  if(!user.approved) return res.status(403).json({error:"Your email is verified. Your staff account is awaiting admin approval."});
  const token=crypto.randomBytes(32).toString("hex");
  const safe=safeUser(user);
  sessions.set(token,safe); res.json({token,user:safe});
}));
app.post("/api/auth/resend-verification", wrap(async (req,res) => {
  const email=clean(req.body.email,160).toLowerCase(), password=String(req.body.password||"");
  const user=await store.getUser(email);
  const hash=user?crypto.scryptSync(password,user.passwordSalt,64).toString("hex"):"";
  if(!user || hash!==user.passwordHash) return res.status(401).json({error:"Email or password is incorrect."});
  if(user.emailVerified===true) return res.json({message:"This email is already verified."});
  const testCode=await issueEmailOtp(user);
  res.json({message:"A new verification code has been sent.",verificationRequired:true,email,...(testCode?{testCode}:{})});
}));
app.post("/api/auth/verify-email", wrap(async (req,res) => {
  const email=clean(req.body.email,160).toLowerCase(), code=String(req.body.code||"").trim();
  const user=await store.getUser(email);
  if(!user) return res.status(400).json({error:"The email or verification code is invalid."});
  if(user.emailVerified===true) {
    if(!user.approved) return res.status(403).json({error:"Email verified. Your staff account is awaiting admin approval.",verified:true});
    const token=crypto.randomBytes(32).toString("hex"), safe=safeUser(user); sessions.set(token,safe); return res.json({token,user:safe});
  }
  if(!/^\d{6}$/.test(code) || !user.emailOtpHash || !user.emailOtpExpiresAt || Date.parse(user.emailOtpExpiresAt)<=Date.now()) return res.status(400).json({error:"That code is invalid or expired. Request a new one."});
  if(Number(user.emailOtpAttempts||0)>=5) return res.status(429).json({error:"Too many incorrect attempts. Request a new code."});
  const expected=Buffer.from(user.emailOtpHash), actual=Buffer.from(otpHash(email,code));
  if(expected.length!==actual.length || !crypto.timingSafeEqual(expected,actual)) {
    await store.updateUser(email,{emailOtpAttempts:Number(user.emailOtpAttempts||0)+1});
    return res.status(400).json({error:"That verification code is incorrect."});
  }
  const updated=await store.updateUser(email,{emailVerified:true,emailOtpHash:null,emailOtpExpiresAt:null,emailOtpAttempts:0});
  if(!updated.approved) return res.json({verified:true,message:"Email verified successfully. Your staff account is waiting for administrator approval.",user:safeUser(updated)});
  const token=crypto.randomBytes(32).toString("hex"), safe=safeUser(updated); sessions.set(token,safe);
  res.json({verified:true,token,user:safe});
}));

app.post("/api/auth/admin-login", wrap(async (req,res) => {
  const password=String(req.body.password||"");
  const given=Buffer.from(password), real=Buffer.from(ADMIN_PASSWORD||"");
  if(!real.length || given.length!==real.length || !crypto.timingSafeEqual(given,real)) return res.status(401).json({error:"Admin password is incorrect."});
  const token=crypto.randomBytes(32).toString("hex");
  const user={email:"admin",name:"Administrator",role:"admin",approved:true};
  sessions.set(token,user);
  res.json({token,user});
}));

app.patch("/api/auth/profile", wrap(async (req,res) => {
  if(!req.user) return res.status(401).json({error:"Please sign in."});
  const name=clean(req.body.name,80), phone=clean(req.body.phone,30), address=clean(req.body.address,200);
  if(!name) throw new UserError("Enter your name.");
  const updated=await store.updateUser(req.user.email,{name,phone,address});
  const safe=safeUser(updated);
  for(const [key,value] of sessions) if(value.email===updated.email) sessions.set(key,safe);
  res.json({user:safe});
}));

app.get("/api/auth/me", (req,res) => req.user ? res.json({user:req.user}) : res.status(401).json({error:"Please sign in."}));
app.post("/api/auth/logout", (req,res) => { sessions.delete(String(req.get("authorization")||"").replace(/^Bearer /,"")); res.json({ok:true}); });

/* ---------- admin ---------- */

function requireAdmin(req, res, next) {
  if (req.user && req.user.role === "admin" && req.user.approved) return next();
  const given = Buffer.from(String(req.get("x-admin-password") || ""));
  const real = Buffer.from(ADMIN_PASSWORD || "");
  const ok = real.length > 0 && given.length === real.length && crypto.timingSafeEqual(given, real);
  if (!ok) return res.status(401).json({ error: "Admin access required." });
  next();
}
function requireKitchen(req,res,next) {
  if (req.user && req.user.approved && ["chef","admin"].includes(req.user.role)) return next();
  const given=Buffer.from(String(req.get("x-admin-password")||"")), real=Buffer.from(ADMIN_PASSWORD||"");
  if(real.length>0 && given.length===real.length && crypto.timingSafeEqual(given,real)) return next();
  return res.status(401).json({error:"Sign in with an approved kitchen staff or admin account."});
}
function requireChef(req,res,next) {
  if (req.user && req.user.role === "chef" && req.user.approved) return next();
  if (!req.user) { const given=Buffer.from(String(req.get("x-admin-password")||"")), real=Buffer.from(ADMIN_PASSWORD||""); if(real.length>0 && given.length===real.length && crypto.timingSafeEqual(given,real)) return res.status(403).json({error:"Administrators cannot accept or progress orders. An approved kitchen staff member must do this."}); return res.status(401).json({error:"Sign in with an approved kitchen staff account."}); }
  return res.status(403).json({error:"Only approved kitchen staff can accept and update orders."});
}
function requireSuperAdmin(req,res,next) {
  if(req.user && req.user.role==="admin" && req.user.approved) return next();
  const given=Buffer.from(String(req.get("x-admin-password")||""));
  const real=Buffer.from(ADMIN_PASSWORD||"");
  const ok=given.length===real.length&&crypto.timingSafeEqual(given,real);
  if(!ok) return res.status(401).json({error:"Only the admin can approve staff applications."});
  next();
}


app.get("/api/admin/users", requireAdmin, wrap(async (_req,res) => {
  const users=(await store.listUsers()).map(safeUser);
  res.json({users});
}));
app.post("/api/admin/users", requireAdmin, wrap(async (req,res) => {
  const email=clean(req.body.email,160).toLowerCase(), name=clean(req.body.name,80);
  const phone=clean(req.body.phone,30), address=clean(req.body.address,200);
  const password=String(req.body.password||""), role=req.body.role;
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!name||password.length<10) throw new UserError("Enter a valid email, name and password of at least 10 characters.");
  if(!["customer","chef","driver"].includes(role)) throw new UserError("Choose customer, kitchen staff or driver.");
  const salt=crypto.randomBytes(16).toString("hex");
  const user={email,name,phone,address,role,staffId:role==="chef"?"KCH-"+crypto.randomBytes(3).toString("hex").toUpperCase():role==="driver"?"DRV-"+crypto.randomBytes(3).toString("hex").toUpperCase():null,approved:true,status:"approved",emailVerified:false,passwordSalt:salt,passwordHash:crypto.scryptSync(password,salt,64).toString("hex"),createdAt:new Date().toISOString(),createdBy:"admin"};
  try{await store.saveUser(user);}catch(e){if(e.code==="USER_EXISTS")throw new UserError("An account with this email already exists.");throw e;}
  try { const testCode=await issueEmailOtp(user); res.status(201).json({user:safeUser(user),verificationSent:true,...(testCode?{testCode}:{})}); } catch(error) { await store.deleteUser(email); throw error; }
}));
app.delete("/api/admin/users/:email", requireAdmin, wrap(async (req,res) => {
  const email=decodeURIComponent(req.params.email).toLowerCase();
  if(email==="admin") throw new UserError("The primary admin account cannot be deleted here.");
  const existing=await store.getUser(email);
  if(!existing) return res.status(404).json({error:"Account not found."});
  await store.deleteUser(email);
  for(const [key,value] of sessions) if(value.email===email) sessions.delete(key);
  res.json({ok:true});
}));

app.get("/api/admin/staff-applications", requireSuperAdmin, wrap(async (_req,res) => {
  const applications=(await store.listUsers()).filter(u=>["chef","driver"].includes(u.role)&&!u.approved).map(safeUser);
  res.json({applications});
}));
app.patch("/api/admin/staff-applications/:email", requireSuperAdmin, wrap(async (req,res) => {
  const email=decodeURIComponent(req.params.email).toLowerCase(), approved=req.body&&req.body.approved;
  if(typeof approved!=="boolean") throw new UserError("Choose approve or reject.");
  const user=await store.getUser(email);
  if(!user||!["chef","driver"].includes(user.role)) return res.status(404).json({error:"Staff application not found."});
  const updated=await store.updateUser(email,{approved,status:approved?"approved":"rejected",reviewedAt:new Date().toISOString()});
  res.json({user:safeUser(updated)});
}));

app.get(
  "/api/admin/orders",
  requireKitchen,
  wrap(async (_req, res) => {
    res.json({ orders: await store.listOrders() });
  })
);


app.get("/api/admin/stock", requireAdmin, wrap(async (_req, res) => {
  res.json({ stock: await store.listStock() });
}));

app.patch("/api/admin/stock/:id", requireAdmin, wrap(async (req, res) => {
  const id = String(req.params.id);
  if (!itemsById.has(id)) throw new UserError("Unknown menu item.");
  if (typeof req.body.available !== "boolean") throw new UserError("Stock availability must be true or false.");
  res.json({ stock: await store.setStock(id, req.body.available) });
}));


function menuItemInput(body, existing = null) {
  body = body || {};
  const name = clean(body.name, 80);
  const description = clean(body.description, 300);
  const category = clean(body.category, 40);
  const price = Number(body.price);
  const unit = clean(body.unit, 60);
  const emoji = clean(body.emoji || "🍽️", 12);
  const image = clean(body.image, 500);
  if (!name) throw new UserError("Enter an item name.");
  if (!menu.categories.some((c) => c.id === category)) throw new UserError("Choose a valid category.");
  if (!Number.isFinite(price) || price <= 0 || Math.round(price * 100) / 100 !== price) {
    throw new UserError("Enter a price greater than zero with no more than 2 decimal places.");
  }
  if (!description) throw new UserError("Enter an item description.");
  if (image && !image.startsWith("/img/") && !/^https:\/\//i.test(image)) {
    throw new UserError("Photo must be a /img/ path or an https URL.");
  }
  const id = existing ? existing.id : clean(body.id || name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), 80);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) throw new UserError("Item name must produce a valid menu ID.");
  return {
    ...(existing || {}),
    id, name, description, category, price, unit: unit || undefined,
    emoji, image: image || undefined,
    spiceLevels: existing && existing.spiceLevels ? existing.spiceLevels : ["Mid", "High", "Super High"],
  };
}

app.get("/api/admin/menu/items", requireAdmin, wrap(async (_req, res) => {
  res.json({ items: menu.items, categories: menu.categories });
}));

app.post("/api/admin/menu/items", requireAdmin, wrap(async (req, res) => {
  const item = menuItemInput(req.body);
  if (itemsById.has(item.id)) throw new UserError("An item with this name already exists.");
  await store.saveMenuItem(item);
  menu.items.push(item);
  itemsById.set(item.id, item);
  res.status(201).json({ item });
}));

app.patch("/api/admin/menu/items/:id", requireAdmin, wrap(async (req, res) => {
  const id = String(req.params.id);
  const existing = itemsById.get(id);
  if (!existing) return res.status(404).json({ error: "Menu item not found." });
  const item = menuItemInput(req.body, existing);
  await store.saveMenuItem(item);
  const index = menu.items.findIndex((entry) => entry.id === id);
  if (index >= 0) menu.items[index] = item;
  itemsById.set(id, item);
  res.json({ item });
}));

app.patch(
  "/api/admin/orders/:id",
  requireChef,
  wrap(async (req, res) => {
    const status = req.body && req.body.status;
    if (!STATUSES.includes(status)) throw new UserError("Invalid status.");
    const extra = {};
    if (status === "out_for_delivery") {
      const existing = await store.getOrder(req.params.id);
      if (!existing || existing.type !== "delivery") throw new UserError("Only delivery orders can be sent out.");
      if (!existing.driverAcceptedBy) throw new UserError("A driver must accept this delivery before dispatch.");
      extra.pickupOtp = String(crypto.randomInt(100000, 1000000));
      extra.deliveryOtp = String(crypto.randomInt(100000, 1000000));
      extra.pickupVerified = false;
      extra.deliveryVerified = false;
    }
    const order = await store.setStatus(req.params.id, status, new Date().toISOString(), extra);
    if (!order) return res.status(404).json({ error: "Order not found." });
    res.json({ order });
  })
);

app.patch("/api/admin/orders/:id/payment", requireKitchen, wrap(async (req, res) => {
  if (typeof req.body.received !== "boolean") throw new UserError("Payment status must be true or false.");
  const current = await store.getOrder(req.params.id);
  if (!current) return res.status(404).json({ error: "Order not found." });
  const order = await store.setStatus(req.params.id, current.status, new Date().toISOString(), { paymentReceived: req.body.received });
  res.json({ order });
}));

function requireDriver(req, res, next) {
  if (req.user && req.user.role === "driver" && req.user.approved) { req.driver = req.user; return next(); }
  const given = Buffer.from(String(req.get("x-driver-password") || ""));
  const real = Buffer.from(DRIVER_PASSWORD || "");
  const ok = real.length >= 12 && given.length === real.length && crypto.timingSafeEqual(given, real);
  if (!ok) return res.status(401).json({ error: "Wrong driver password or driver access is not configured." });
  next();
}

app.get("/api/driver/orders", requireDriver, wrap(async (_req, res) => {
  // Show active delivery jobs to drivers as soon as they are placed, not only
  // after the kitchen dispatches them. OTP actions remain available only after
  // the manager moves an order to out_for_delivery.
  const driverId = (_req.driver && _req.driver.email) || "legacy-driver";
  const orders = (await store.listOrders())
    .filter(o => o.type === "delivery" && ["received", "preparing", "ready", "out_for_delivery", "picked_up"].includes(o.status) && (!o.driverAcceptedBy || o.driverAcceptedBy === driverId) && !(Array.isArray(o.driverRejectedBy) ? o.driverRejectedBy.includes(driverId) : o.driverRejectedBy === driverId))
    .map(o => ({
      id: o.id,
      status: o.status,
      driverDecision: o.driverDecision || "open",
      acceptedByMe: !!o.driverAcceptedBy && o.driverAcceptedBy === driverId,
      customer: { name: o.customer.name, address: o.customer.address, phone: o.customer.phone },
      items: o.items,
      total: o.total,
      createdAt: o.createdAt
    }));
  res.json({orders});
}));


app.post("/api/driver/orders/:id/decision", requireDriver, wrap(async (req,res) => {
  const decision=req.body&&req.body.decision;
  if(!["accept","reject"].includes(decision)) throw new UserError("Choose accept or reject.");
  const id=String(req.params.id).toUpperCase(), order=await store.getOrder(id);
  if(!order||order.type!=="delivery"||!["received","preparing","ready"].includes(order.status)) return res.status(404).json({error:"This delivery is no longer available."});
  const driver=(req.driver && req.driver.email) || "legacy-driver";
  const rejectedBy=Array.isArray(order.driverRejectedBy)?order.driverRejectedBy:(order.driverRejectedBy?[order.driverRejectedBy]:[]);
  if(decision==="accept") {
    if(rejectedBy.includes(driver)) throw new UserError("You already rejected this delivery.");
    if(order.driverAcceptedBy&&order.driverAcceptedBy!==driver) throw new UserError("Another driver has already accepted this order.");
    const claimed=await store.claimOrder(id,driver,new Date().toISOString());
    if(!claimed) throw new UserError("Another driver has already accepted this order.");
  } else {
    if(order.driverAcceptedBy&&order.driverAcceptedBy!==driver) throw new UserError("This order has already been accepted by another driver.");
    await store.setStatus(id,order.status,new Date().toISOString(),{driverAcceptedBy:null,driverDecision:"rejected",driverRejectedBy:[...rejectedBy,driver],driverRejectedAt:new Date().toISOString()});
  }
  res.json({ok:true,decision});
}));

app.post("/api/driver/orders/:id/handover", requireDriver, wrap(async (req, res) => {
  const action = req.body && req.body.action;
  const code = String(req.body && req.body.otp || "").trim();
  if (!/^\d{6}$/.test(code)) throw new UserError("Enter the 6-digit handover code.");
  const order = await store.getOrder(String(req.params.id).toUpperCase());
  if (!order || order.type !== "delivery") return res.status(404).json({error:"Delivery order not found."});
  if (order.driverAcceptedBy && order.driverAcceptedBy !== ((req.driver && req.driver.email) || "legacy-driver")) throw new UserError("This delivery is assigned to another driver.");
  const failKey = req.ip + ":" + order.id;
  const attempt = otpFailures.get(failKey) || {count:0,until:0};
  if (attempt.until > Date.now()) throw new UserError("Too many incorrect codes. Try again in 5 minutes.");
  if (action === "pickup") {
    if (order.status !== "out_for_delivery") throw new UserError("This order is not waiting for pickup.");
    if (!order.pickupOtp || code !== order.pickupOtp) { attempt.count++; if (attempt.count >= 8) attempt.until = Date.now() + 5 * 60 * 1000; otpFailures.set(failKey, attempt); throw new UserError("Pickup code is incorrect."); }
    otpFailures.delete(failKey);
    const updated = await store.setStatus(order.id, "picked_up", new Date().toISOString(), {pickupVerified:true, pickupOtp:null});
    return res.json({order:{id:updated.id,status:updated.status}});
  }
  if (action === "delivered") {
    if (order.status !== "picked_up") throw new UserError("Confirm pickup before delivery.");
    if (!order.deliveryOtp || code !== order.deliveryOtp) { attempt.count++; if (attempt.count >= 8) attempt.until = Date.now() + 5 * 60 * 1000; otpFailures.set(failKey, attempt); throw new UserError("Customer delivery code is incorrect."); }
    otpFailures.delete(failKey);
    const updated = await store.setStatus(order.id, "completed", new Date().toISOString(), {deliveryVerified:true, deliveryOtp:null});
    return res.json({order:{id:updated.id,status:updated.status}});
  }
  throw new UserError("Unknown handover action.");
}));


app.use("/api", (_req, res) => res.status(404).json({ error: "Not found." }));

// Last stop for errors: always answer with JSON, never leak internals.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err instanceof UserError) return res.status(err.status || 400).json({ error: err.message });
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Invalid request." });
  if (err.type === "entity.too.large") return res.status(413).json({ error: "Request too large." });
  console.error("Server error:", err);
  res.status(500).json({ error: "Something went wrong on our side. Please try again." });
});

/* ---------- start ---------- */

async function main() {
  if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 12) {
    throw new Error("Set ADMIN_PASSWORD to a strong password of at least 12 characters before starting the app.");
  }
  await store.init();
  // Apply manager-created/edited items from persistent storage over the bundled starter menu.
  for (const item of await store.listMenuItems()) {
    const index = menu.items.findIndex((entry) => entry.id === item.id);
    if (index >= 0) menu.items[index] = item;
    else menu.items.push(item);
    itemsById.set(item.id, item);
  }
  console.log("Order storage:", store.kind);

  const server = app.listen(PORT, () => {
    console.log(`${menu.brand} running on http://localhost:${PORT}`);
    console.log(`Kitchen screen: http://localhost:${PORT}/admin.html`);
    console.log(`Delivery screen: http://localhost:${PORT}/driver.html`);
    if (!DRIVER_PASSWORD || DRIVER_PASSWORD.length < 12) console.log("Driver login disabled: set DRIVER_PASSWORD (at least 12 characters).");
    if (!store.persistent) {
      console.log("Orders are kept in a local file. Set DATABASE_URL (or use Docker) to use Postgres.");
    }
  });

  server.on("error", (e) => {
    if (e.code === "EADDRINUSE") {
      console.error(`\nPort ${PORT} is already in use (is the app already running?).`);
      console.error("Use another port, for example:");
      console.error("  PowerShell:  $env:PORT=3001; npm start");
      console.error("  Mac/Linux:   PORT=3001 npm start\n");
    } else {
      console.error(e);
    }
    process.exit(1);
  });

  const shutdown = (signal) => {
    console.log(`${signal} received, shutting down...`);
    server.close(async () => {
      await store.close().catch(() => {});
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 8000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((e) => {
  console.error("Failed to start:", e.message);
  process.exit(1);
});
