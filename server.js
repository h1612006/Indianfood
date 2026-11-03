"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { createStore } = require("./db");

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// MENU_FILE lets tests (or a second shop) use a different menu; normally it is data/menu.json.
const menu = JSON.parse(
  fs.readFileSync(process.env.MENU_FILE || path.join(__dirname, "data", "menu.json"), "utf8")
);
const itemsById = new Map(menu.items.map((i) => [i.id, i]));

const STATUSES = ["received", "preparing", "ready", "completed", "cancelled"];
const ORDER_TYPES = ["pickup", "delivery"];
const MAX_QTY = 100; // per line, e.g. 60 samosas for a party
// "card" is only a demo (nothing is charged), so it is off unless the menu turns it on.
const PAYMENTS = menu.payments || (menu.cardPaymentDemo ? ["counter", "card"] : ["counter"]);

const store = createStore();

/* A mistake in what the customer sent (shown to them, HTTP 400). */
class UserError extends Error {}

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
    createdAt: now,
    updatedAt: now,
  };
}

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

/* ---------- app ---------- */

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "50kb" }));
app.use(express.static(path.join(__dirname, "public")));

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
    const stock = await store.listStock();
    for (const line of (req.body && Array.isArray(req.body.items) ? req.body.items : [])) {
      if (stock[line && line.itemId] === false) throw new UserError("Out of stock.");
    }
    const order = buildOrder(req.body); // throws UserError on bad input

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
    res.json({ order: publicOrder(order) });
  })
);

/* ---------- admin ---------- */

function requireAdmin(req, res, next) {
  const given = Buffer.from(String(req.get("x-admin-password") || ""));
  const real = Buffer.from(ADMIN_PASSWORD || "");
  const ok = given.length === real.length && crypto.timingSafeEqual(given, real);
  if (!ok) return res.status(401).json({ error: "Wrong admin password." });
  next();
}

app.get(
  "/api/admin/orders",
  requireAdmin,
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

app.patch(
  "/api/admin/orders/:id",
  requireAdmin,
  wrap(async (req, res) => {
    const status = req.body && req.body.status;
    if (!STATUSES.includes(status)) throw new UserError("Invalid status.");
    const order = await store.setStatus(req.params.id, status, new Date().toISOString());
    if (!order) return res.status(404).json({ error: "Order not found." });
    res.json({ order });
  })
);

app.use("/api", (_req, res) => res.status(404).json({ error: "Not found." }));

// Last stop for errors: always answer with JSON, never leak internals.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err instanceof UserError) return res.status(400).json({ error: err.message });
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
  console.log("Order storage:", store.kind);

  const server = app.listen(PORT, () => {
    console.log(`${menu.brand} running on http://localhost:${PORT}`);
    console.log(`Kitchen screen: http://localhost:${PORT}/admin.html`);
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
