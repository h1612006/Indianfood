"use strict";

/*
 * Order storage. Two interchangeable stores with the same interface:
 *
 *   - Postgres  (used when DATABASE_URL or PGHOST is set; this is what Docker uses)
 *   - JSON file (used otherwise; handy for quick local runs without a database)
 *
 * Interface (all async):
 *   init()                      prepare the store (create table, connect, ...)
 *   ping()                      throws if the store is not usable (health check)
 *   insertOrder(order)          throws an error with code "DUPLICATE" if the id exists
 *   getOrder(id)                -> order | null
 *   listOrders()                -> orders, newest first
 *   setStatus(id, status, at)   -> updated order | null
 *   close()
 */

const fs = require("fs");
const path = require("path");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------- JSON file store ---------------------------- */

function createFileStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "orders.json");
  let orders = [];
  let stock = {};
  let menuItems = {};
  let users = {};
  const usersFile = path.join(dir, "users.json");
  const menuItemsFile = path.join(dir, "menu-items.json");
  const stockFile = path.join(dir, "stock.json");
  function persistStock() {
    const tmp = stockFile + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(stock, null, 2));
    fs.renameSync(tmp, stockFile);
  }

  function persist() {
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(orders, null, 2));
    fs.renameSync(tmp, file);
  }

  return {
    kind: "file (" + file + ")",
    persistent: false,

    async init() {
      try {
        orders = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch (_) {
        orders = [];
      }
      try { stock = JSON.parse(fs.readFileSync(stockFile, "utf8")); } catch (_) { stock = {}; }
      try { menuItems = JSON.parse(fs.readFileSync(menuItemsFile, "utf8")); } catch (_) { menuItems = {}; }
      try { users = JSON.parse(fs.readFileSync(usersFile, "utf8")); } catch (_) { users = {}; }
    },

    async ping() {
      fs.accessSync(dir, fs.constants.W_OK);
    },

    async insertOrder(order) {
      if (orders.some((o) => o.id === order.id)) {
        throw Object.assign(new Error("Duplicate order id"), { code: "DUPLICATE" });
      }
      orders.push(order);
      try {
        persist();
      } catch (e) {
        orders.pop(); // never keep an order we could not store
        throw e;
      }
    },

    async getOrder(id) {
      return orders.find((o) => o.id === id) || null;
    },

    async getUser(email) { return users[email] || null; },
    async listUsers() { return Object.values(users); },
    async saveUser(user) {
      const key = user.email.toLowerCase();
      if (users[key]) throw Object.assign(new Error("Email already registered"), { code: "USER_EXISTS" });
      users[key] = user;
      try { fs.writeFileSync(usersFile + ".tmp", JSON.stringify(users, null, 2)); fs.renameSync(usersFile + ".tmp", usersFile); }
      catch (e) { delete users[key]; throw e; }
      return user;
    },
    async updateUser(email, patch) {
      const key = email.toLowerCase(), current = users[key];
      if (!current) return null;
      users[key] = { ...current, ...patch };
      fs.writeFileSync(usersFile + ".tmp", JSON.stringify(users, null, 2)); fs.renameSync(usersFile + ".tmp", usersFile);
      return users[key];
    },

    async listMenuItems() { return Object.values(menuItems); },
    async saveMenuItem(item) {
      const before = menuItems[item.id];
      menuItems[item.id] = item;
      const tmp = menuItemsFile + ".tmp";
      try {
        fs.writeFileSync(tmp, JSON.stringify(menuItems, null, 2));
        fs.renameSync(tmp, menuItemsFile);
      } catch (e) {
        if (before === undefined) delete menuItems[item.id]; else menuItems[item.id] = before;
        throw e;
      }
      return item;
    },

    async listStock() { return { ...stock }; },
    async setStock(id, available) {
      const before = stock[id]; stock[id] = available;
      try { persistStock(); } catch (e) { if (before === undefined) delete stock[id]; else stock[id] = before; throw e; }
      return { ...stock };
    },

    async listOrders() {
      return [...orders].reverse();
    },

    async claimOrder(id, driver, at) {
      const order = orders.find((o) => o.id === id);
      if (!order || (order.driverAcceptedBy && order.driverAcceptedBy !== driver)) return null;
      const before = { ...order };
      Object.assign(order, { driverAcceptedBy: driver, driverDecision: "accepted", driverAcceptedAt: at, driverRejectedBy: null, updatedAt: at });
      try { persist(); } catch (e) { Object.assign(order, before); throw e; }
      return order;
    },

    async setStatus(id, status, at, extra = {}) {
      const order = orders.find((o) => o.id === id);
      if (!order) return null;
      const before = { ...order };
      Object.assign(order, extra, { status, updatedAt: at });
      try {
        persist();
      } catch (e) {
        Object.assign(order, before);
        throw e;
      }
      return order;
    },

    async close() {},
  };
}

/* ----------------------------- Postgres store ---------------------------- */

function createPgStore() {
  const { Pool } = require("pg");

  const config = process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {}; // else PGHOST, PGUSER, ... are read by `pg`
  if (/^(1|true|require)$/i.test(process.env.DATABASE_SSL || "")) {
    config.ssl = { rejectUnauthorized: false };
  }
  config.max = 10;
  config.connectionTimeoutMillis = 5000;

  const pool = new Pool(config);
  pool.on("error", (e) => console.error("Postgres connection error:", e.message));

  // The full order lives in `data` (JSONB); status and timestamps are real columns
  // so they can be indexed and updated cheaply. Reads merge them back together.
  const toOrder = (row) => ({
    ...row.data,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });

  return {
    kind: "postgres",
    persistent: true,

    async init() {
      // In Docker the database may still be starting; keep trying for a while.
      let lastError;
      for (let attempt = 1; attempt <= 30; attempt++) {
        try {
          await pool.query(`
            CREATE TABLE IF NOT EXISTS orders (
              id          TEXT PRIMARY KEY,
              status      TEXT NOT NULL,
              created_at  TIMESTAMPTZ NOT NULL,
              updated_at  TIMESTAMPTZ NOT NULL,
              data        JSONB NOT NULL
            );
            CREATE TABLE IF NOT EXISTS menu_items (
              item_id TEXT PRIMARY KEY,
              data JSONB NOT NULL,
              updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
            CREATE TABLE IF NOT EXISTS item_stock (
              item_id TEXT PRIMARY KEY,
              available BOOLEAN NOT NULL,
              updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
            CREATE TABLE IF NOT EXISTS app_users (
              email TEXT PRIMARY KEY,
              data JSONB NOT NULL,
              created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
            CREATE INDEX IF NOT EXISTS orders_created_idx ON orders (created_at DESC);
          `);
          return;
        } catch (e) {
          lastError = e;
          console.log(`Waiting for the database (${attempt}/30): ${e.message}`);
          await sleep(1000);
        }
      }
      throw new Error("Could not reach the database: " + lastError.message);
    },

    async ping() {
      await pool.query("SELECT 1");
    },

    async insertOrder(order) {
      try {
        await pool.query(
          "INSERT INTO orders (id, status, created_at, updated_at, data) VALUES ($1, $2, $3, $4, $5)",
          [order.id, order.status, order.createdAt, order.updatedAt, JSON.stringify(order)]
        );
      } catch (e) {
        if (e.code === "23505") throw Object.assign(new Error("Duplicate order id"), { code: "DUPLICATE" });
        throw e;
      }
    },

    async getOrder(id) {
      const { rows } = await pool.query(
        "SELECT status, created_at, updated_at, data FROM orders WHERE id = $1",
        [id]
      );
      return rows[0] ? toOrder(rows[0]) : null;
    },

    async getUser(email) {
      const { rows } = await pool.query("SELECT data FROM app_users WHERE email = $1", [email.toLowerCase()]);
      return rows[0] ? rows[0].data : null;
    },
    async listUsers() {
      const { rows } = await pool.query("SELECT data FROM app_users ORDER BY created_at DESC");
      return rows.map(r => r.data);
    },
    async saveUser(user) {
      try { await pool.query("INSERT INTO app_users (email, data) VALUES ($1, $2)", [user.email.toLowerCase(), JSON.stringify(user)]); }
      catch (e) { if (e.code === "23505") throw Object.assign(new Error("Email already registered"), { code: "USER_EXISTS" }); throw e; }
      return user;
    },
    async updateUser(email, patch) {
      const current = await this.getUser(email);
      if (!current) return null;
      const updated = { ...current, ...patch };
      const { rows } = await pool.query("UPDATE app_users SET data = $2 WHERE email = $1 RETURNING data", [email.toLowerCase(), JSON.stringify(updated)]);
      return rows[0] ? rows[0].data : null;
    },

    async listMenuItems() {
      const { rows } = await pool.query("SELECT data FROM menu_items ORDER BY item_id");
      return rows.map((r) => r.data);
    },
    async saveMenuItem(item) {
      await pool.query(
        "INSERT INTO menu_items (item_id, data) VALUES ($1, $2) ON CONFLICT (item_id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()",
        [item.id, JSON.stringify(item)]
      );
      return item;
    },

    async listStock() {
      const { rows } = await pool.query("SELECT item_id, available FROM item_stock");
      return Object.fromEntries(rows.map((r) => [r.item_id, r.available]));
    },
    async setStock(id, available) {
      await pool.query("INSERT INTO item_stock (item_id, available) VALUES ($1, $2) ON CONFLICT (item_id) DO UPDATE SET available = EXCLUDED.available, updated_at = NOW()", [id, available]);
      return this.listStock();
    },

    async listOrders() {
      const { rows } = await pool.query(
        "SELECT status, created_at, updated_at, data FROM orders ORDER BY created_at DESC LIMIT 500"
      );
      return rows.map(toOrder);
    },

    async claimOrder(id, driver, at) {
      const { rows } = await pool.query(
        \`UPDATE orders SET updated_at = $3,
         data = data || jsonb_build_object('driverAcceptedBy', $2::text, 'driverDecision', 'accepted', 'driverAcceptedAt', $3::text, 'driverRejectedBy', NULL, 'updatedAt', $3::text)
         WHERE id = $1 AND (data->>'driverAcceptedBy' IS NULL OR data->>'driverAcceptedBy' = $2)
         RETURNING status, created_at, updated_at, data\`,
        [id, driver, at]
      );
      return rows[0] ? toOrder(rows[0]) : null;
    },

    async setStatus(id, status, at, extra = {}) {\n      const current = await this.getOrder(id);
      if (!current) return null;
      const updated = { ...current, ...extra, status, updatedAt: at };
      const { rows } = await pool.query(
        `UPDATE orders SET status = $2, updated_at = $3, data = $4 WHERE id = $1
         RETURNING status, created_at, updated_at, data`,
        [id, status, at, JSON.stringify(updated)]
      );
      return rows[0] ? toOrder(rows[0]) : null;
    },

    async close() {
      await pool.end();
    },
  };
}

function createStore() {
  if (process.env.DATABASE_URL || process.env.PGHOST) return createPgStore();
  return createFileStore(process.env.DATA_DIR || path.join(__dirname, "data"));
}

module.exports = { createStore, createFileStore };
