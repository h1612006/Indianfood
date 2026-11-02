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

    async listOrders() {
      return [...orders].reverse();
    },

    async setStatus(id, status, at) {
      const order = orders.find((o) => o.id === id);
      if (!order) return null;
      const before = { status: order.status, updatedAt: order.updatedAt };
      order.status = status;
      order.updatedAt = at;
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

    async listOrders() {
      const { rows } = await pool.query(
        "SELECT status, created_at, updated_at, data FROM orders ORDER BY created_at DESC LIMIT 500"
      );
      return rows.map(toOrder);
    },

    async setStatus(id, status, at) {
      const { rows } = await pool.query(
        `UPDATE orders SET status = $2, updated_at = $3 WHERE id = $1
         RETURNING status, created_at, updated_at, data`,
        [id, status, at]
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
