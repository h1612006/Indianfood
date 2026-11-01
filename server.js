"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";

const MENU_FILE = path.join(__dirname, "data", "menu.json");
const ORDERS_FILE = path.join(__dirname, "data", "orders.json");

const menu = JSON.parse(fs.readFileSync(MENU_FILE, "utf8"));
const itemsById = new Map(menu.items.map((i) => [i.id, i]));

const STATUSES = ["received", "preparing", "ready", "completed", "cancelled"];
const ORDER_TYPES = ["pickup", "delivery"];
const PAYMENTS = ["counter", "card"];

/* ---------- order storage (JSON file, kept in memory) ---------- */

let orders = [];
try {
  orders = JSON.parse(fs.readFileSync(ORDERS_FILE, "utf8"));
} catch (_) {
  orders = [];
}

function saveOrders() {
  const tmp = ORDERS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(orders, null, 2));
  fs.renameSync(tmp, ORDERS_FILE);
}

function newOrderId() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id;
  do {
    id = "SS-";
    const bytes = crypto.randomBytes(5);
    for (const b of bytes) id += alphabet[b % alphabet.length];
  } while (orders.some((o) => o.id === id));
  return id;
}

const round2 = (n) => Math.round(n * 100) / 100;

/* ---------- pricing (always computed on the server) ---------- */

function priceLine(raw) {
  const item = itemsById.get(raw && raw.itemId);
  if (!item) throw new Error("Unknown menu item.");

  const qty = Number(raw.qty);
  if (!Number.isInteger(qty) || qty < 1 || qty > 20) {
    throw new Error("Quantity must be between 1 and 20.");
  }

  let unit = item.price;
  let sizeName = null;
  if (item.sizes) {
    const sizes = menu.sizes[item.sizes];
    const size = sizes.find((s) => s.id === raw.size) || sizes[0];
    unit += size.delta;
    sizeName = size.name;
  }

  const addonIds = Array.isArray(raw.addons) ? [...new Set(raw.addons)] : [];
  const addons = addonIds.map((id) => {
    const a = (item.addons || []).find((x) => x.id === id);
    if (!a) throw new Error("Unknown add-on for " + item.name + ".");
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

/* ---------- app ---------- */

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "50kb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/menu", (_req, res) => res.json(menu));

app.post("/api/orders", (req, res) => {
  try {
    const body = req.body || {};
    const type = body.type;
    if (!ORDER_TYPES.includes(type)) throw new Error("Choose pickup or delivery.");
    const payment = PAYMENTS.includes(body.payment) ? body.payment : "counter";

    const c = body.customer || {};
    const customer = {
      name: clean(c.name, 60),
      phone: clean(c.phone, 30),
      address: clean(c.address, 200),
      notes: clean(c.notes, 300),
    };
    if (!customer.name) throw new Error("Please enter your name.");
    if (!/^[+\d][\d\s().-]{5,}$/.test(customer.phone)) {
      throw new Error("Please enter a valid phone number.");
    }
    if (type === "delivery" && !customer.address) {
      throw new Error("Please enter a delivery address.");
    }

    if (!Array.isArray(body.items) || body.items.length === 0) {
      throw new Error("Your basket is empty.");
    }
    if (body.items.length > 40) throw new Error("Too many items in one order.");

    const lines = body.items.map(priceLine);
    const subtotal = round2(lines.reduce((s, l) => s + l.lineTotal, 0));

    let deliveryFee = 0;
    if (type === "delivery") {
      if (subtotal < menu.minDeliveryOrder) {
        throw new Error(
          `Minimum order for delivery is ${menu.currency}${menu.minDeliveryOrder.toFixed(2)}.`
        );
      }
      deliveryFee = subtotal >= menu.freeDeliveryOver ? 0 : menu.deliveryFee;
    }

    const order = {
      id: newOrderId(),
      type,
      payment,
      customer,
      items: lines,
      subtotal,
      deliveryFee,
      total: round2(subtotal + deliveryFee),
      status: "received",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    orders.push(order);
    saveOrders();
    res.status(201).json({ order: publicOrder(order) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Customers only see what they need to track their own order.
function publicOrder(o) {
  return {
    id: o.id,
    type: o.type,
    payment: o.payment,
    items: o.items,
    subtotal: o.subtotal,
    deliveryFee: o.deliveryFee,
    total: o.total,
    status: o.status,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}

app.get("/api/orders/:id", (req, res) => {
  const order = orders.find((o) => o.id === String(req.params.id).toUpperCase());
  if (!order) return res.status(404).json({ error: "Order not found." });
  res.json({ order: publicOrder(order) });
});

/* ---------- admin ---------- */

function requireAdmin(req, res, next) {
  const given = Buffer.from(String(req.get("x-admin-password") || ""));
  const real = Buffer.from(ADMIN_PASSWORD);
  const ok = given.length === real.length && crypto.timingSafeEqual(given, real);
  if (!ok) return res.status(401).json({ error: "Wrong admin password." });
  next();
}

app.get("/api/admin/orders", requireAdmin, (_req, res) => {
  res.json({ orders: [...orders].reverse() });
});

app.patch("/api/admin/orders/:id", requireAdmin, (req, res) => {
  const order = orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found." });
  const status = req.body && req.body.status;
  if (!STATUSES.includes(status)) {
    return res.status(400).json({ error: "Invalid status." });
  }
  order.status = status;
  order.updatedAt = new Date().toISOString();
  saveOrders();
  res.json({ order });
});

app.use("/api", (_req, res) => res.status(404).json({ error: "Not found." }));

app.listen(PORT, () => {
  console.log(`${menu.brand} running on http://localhost:${PORT}`);
  console.log(`Kitchen screen: http://localhost:${PORT}/admin.html`);
  if (!process.env.ADMIN_PASSWORD) {
    console.log('Using default admin password "admin123" - set ADMIN_PASSWORD before going live.');
  }
});
