"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("item stock survives closing and reopening the configured store", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "indian-snacks-stock-"));
  const oldDir = process.env.DATA_DIR;
  const oldUrl = process.env.DATABASE_URL;
  const oldHost = process.env.PGHOST;
  process.env.DATA_DIR = dir;
  // Keep the configured backend: file by default, real Postgres when DATABASE_URL/PGHOST is set.
  const { createStore } = require("../db");
  const id = "stock-persistence-test-" + process.pid;
  let first;
  let second;
  try {
    first = createStore();
    await first.init();
    await first.setStock(id, false);
    await first.close();
    first = null;

    second = createStore();
    await second.init();
    assert.equal((await second.listStock())[id], false);
    await second.setStock(id, true);
    assert.equal((await second.listStock())[id], true);
  } finally {
    if (first) await first.close().catch(() => {});
    if (second) await second.close().catch(() => {});
    if (oldDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = oldDir;
    if (oldUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = oldUrl;
    if (oldHost === undefined) delete process.env.PGHOST; else process.env.PGHOST = oldHost;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
