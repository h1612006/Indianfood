"use strict";

// Checks the real menu (data/menu.json) so a typo cannot reach customers.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const menu = JSON.parse(fs.readFileSync(path.join(root, "data", "menu.json"), "utf8"));

test("menu has the basic settings", () => {
  assert.ok(menu.brand && menu.tagline && menu.currency);
  for (const k of ["deliveryFee", "freeDeliveryOver", "minDeliveryOrder"]) {
    assert.ok(Number.isFinite(menu[k]) && menu[k] >= 0, k + " must be a number");
  }
  assert.ok(Array.isArray(menu.categories) && menu.categories.length > 0);
  assert.ok(Array.isArray(menu.items) && menu.items.length > 0);
});

test("every item is complete and valid", () => {
  const categoryIds = new Set(menu.categories.map((c) => c.id));
  assert.equal(categoryIds.size, menu.categories.length, "duplicate category id");
  const seen = new Set();

  for (const item of menu.items) {
    const where = `item "${item.id || item.name}"`;
    assert.match(item.id, /^[a-z0-9]+(-[a-z0-9]+)*$/, where + ": id must be lowercase-with-dashes");
    assert.ok(!seen.has(item.id), where + ": duplicate id");
    seen.add(item.id);
    assert.ok(item.name && item.name.trim(), where + ": missing name");
    assert.ok(item.description && item.description.trim(), where + ": missing description");
    assert.ok(categoryIds.has(item.category), where + ": unknown category " + item.category);
    assert.ok(Number.isFinite(item.price) && item.price > 0, where + ": bad price");
    assert.equal(Math.round(item.price * 100) / 100, item.price, where + ": price has more than 2 decimals");
    if (item.unit !== undefined) assert.ok(typeof item.unit === "string" && item.unit.trim(), where + ": empty unit");
    if (item.image) {
      assert.ok(item.image.startsWith("/img/"), where + ": image must be in /img/");
      assert.ok(fs.existsSync(path.join(root, "public", item.image)), where + ": image file is missing");
    }
  }
});

test("every category has at least one item", () => {
  for (const c of menu.categories) {
    assert.ok(menu.items.some((i) => i.category === c.id), `category "${c.id}" is empty`);
  }
});

test("spice levels and payment methods are set up", () => {
  assert.ok(Array.isArray(menu.spiceLevels) && menu.spiceLevels.length >= 1, "spiceLevels is missing");
  const spiceIds = menu.spiceLevels.map((x) => x.id);
  assert.equal(new Set(spiceIds).size, spiceIds.length, "duplicate spice level id");
  for (const level of menu.spiceLevels) assert.ok(level.id && level.name, "spice level needs id and name");

  assert.ok(Array.isArray(menu.paymentMethods) && menu.paymentMethods.length >= 1, "paymentMethods is missing");
  const payIds = menu.paymentMethods.map((x) => x.id);
  assert.equal(new Set(payIds).size, payIds.length, "duplicate payment method id");
  for (const m of menu.paymentMethods) assert.ok(m.id && m.name, "payment method needs id and name");
});

test("every photo has its real size recorded (so the page keeps its proportions)", () => {
  for (const item of menu.items.filter((i) => i.image)) {
    assert.ok(Number.isInteger(item.imageWidth) && item.imageWidth > 0, item.id + ": imageWidth");
    assert.ok(Number.isInteger(item.imageHeight) && item.imageHeight > 0, item.id + ": imageHeight");
  }
});
