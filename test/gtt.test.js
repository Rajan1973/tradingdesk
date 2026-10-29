// GTT orders kept in the terminal: triggers, trailing stops, OCO, login and no double orders,
// with a fake price feed and a fake broker (no network, no real orders).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.QT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "qt-gtt-"));
const gtt = await import("../lib/gtt.js");

const SYM = "YAHOO:RBLBANK.NS";
function setup({ connected = true, broker = "zerodha", failWith = null } = {}) {
  const placed = [], alerts = [];
  let price = 100;
  gtt._reset([]);
  gtt.configure({
    quotes: async (syms) => Object.fromEntries(syms.map((s) => [s, { price }])),
    place: async (acct, body, ltp) => {
      if (failWith) throw failWith;
      placed.push({ acct, ...body, ltp });
      return { orderId: `ORD${placed.length}` };
    },
    connected: () => connected,
    accountName: () => "Zerodha",
    brokerOf: () => broker,
    notify: (e) => alerts.push(e.text),
    now: () => Date.UTC(2026, 9, 26, 5, 0), // 10:30 IST, market open
  });
  return { placed, alerts, setPrice: (p) => (price = p), setConnected: (c) => (connected = c) };
}
const base = { account: "zerodha-1", symbol: SYM, side: "SELL", qty: 10, product: "CNC" };

test("a single stop-loss places nothing until the price falls to it, then places once", async () => {
  const t = setup();
  const g = gtt.add({ ...base, kind: "single", legs: [{ trigger: 95, orderType: "LIMIT", price: 94.5 }] }, 100);
  t.setPrice(97);
  await gtt.evaluate();
  assert.equal(t.placed.length, 0);
  t.setPrice(94.9);
  await gtt.evaluate();
  await gtt.evaluate(); // a second pass must not send it again
  assert.equal(t.placed.length, 1);
  assert.deepEqual([t.placed[0].side, t.placed[0].qty, t.placed[0].type, t.placed[0].price], ["SELL", 10, "LIMIT", 94.5]);
  assert.equal(g.status, "triggered");
  assert.equal(t.alerts.length, 1);
});

test("a trailing stop follows the high by the trail %, never moves down, and fires on the pullback", async () => {
  const t = setup();
  const g = gtt.add({ ...base, kind: "single", legs: [{ trigger: 95, orderType: "LIMIT", price: 94.5, trail: { type: "pct", value: 5 } }] }, 100);
  for (const p of [104, 110, 108]) {
    t.setPrice(p);
    await gtt.evaluate();
  }
  // Best 110, 5% trail: stop 104.5, limit keeps its 0.5 offset below the trigger.
  assert.equal(g.legs[0].trigger, 104.5);
  assert.equal(g.legs[0].price, 104);
  assert.equal(t.placed.length, 0, "108 is above the stop");
  t.setPrice(104.4);
  await gtt.evaluate();
  assert.equal(t.placed.length, 1);
  assert.equal(t.placed[0].price, 104);
});

test("a trailing stop by points, for a short (buy stop above the price)", async () => {
  const t = setup();
  const g = gtt.add({ ...base, side: "BUY", kind: "single", legs: [{ trigger: 106, orderType: "MARKET", trail: { type: "pts", value: 4 } }] }, 100);
  t.setPrice(90);
  await gtt.evaluate();
  assert.equal(g.legs[0].trigger, 94); // lowest 90 + 4
  t.setPrice(95);
  await gtt.evaluate();
  assert.equal(t.placed.length, 1);
  assert.equal(t.placed[0].side, "BUY");
});

test("OCO: the target fires and the stop-loss is cancelled with it", async () => {
  const t = setup();
  const g = gtt.add({ ...base, kind: "oco", legs: [{ name: "stoploss", trigger: 95, orderType: "MARKET" }, { name: "target", trigger: 105, orderType: "LIMIT", price: 105 }] }, 100);
  t.setPrice(105.2);
  await gtt.evaluate();
  t.setPrice(90); // would have hit the stop, but the GTT is done
  await gtt.evaluate();
  assert.equal(t.placed.length, 1);
  assert.equal(g.result.leg, "target");
});

test("triggers on the wrong side of the price are refused", () => {
  setup();
  assert.throws(() => gtt.add({ ...base, kind: "oco", legs: [{ name: "stoploss", trigger: 102, orderType: "MARKET" }, { name: "target", trigger: 110, orderType: "MARKET" }] }, 100), /must be below/);
  assert.throws(() => gtt.add({ ...base, kind: "single", legs: [{ trigger: 105, orderType: "MARKET", trail: { type: "pct", value: 2 } }] }, 100), /must be a stop/);
});

test("logged out: alerts once, keeps the GTT, and places after you log in", async () => {
  const t = setup({ connected: false });
  const g = gtt.add({ ...base, kind: "single", legs: [{ trigger: 95, orderType: "MARKET" }] }, 100);
  t.setPrice(94);
  await gtt.evaluate();
  await gtt.evaluate();
  assert.equal(g.status, "needs-login");
  assert.equal(t.alerts.length, 1);
  assert.equal(t.placed.length, 0);
  t.setConnected(true);
  await gtt.evaluate();
  assert.equal(t.placed.length, 1);
  assert.equal(g.status, "triggered");
});

test("a refused order is not retried", async () => {
  const t = setup({ failWith: Object.assign(new Error("RMS: Margin Exceeds"), { status: 502 }) });
  const g = gtt.add({ ...base, kind: "single", legs: [{ trigger: 95, orderType: "MARKET" }] }, 100);
  t.setPrice(94);
  await gtt.evaluate();
  await gtt.evaluate();
  assert.equal(g.status, "failed");
  assert.match(g.result.error, /Margin/);
  assert.equal(t.alerts.length, 1);
});

test("ICICI: a market leg goes out as a limit order 1% through the price", async () => {
  const t = setup({ broker: "icici" });
  gtt.add({ ...base, kind: "single", legs: [{ trigger: 95, orderType: "MARKET" }] }, 100);
  t.setPrice(94);
  await gtt.evaluate();
  assert.deepEqual([t.placed[0].type, t.placed[0].price], ["LIMIT", 93.06]);
});

test("market hours are 09:15 to 15:30 IST on weekdays", () => {
  assert.equal(gtt.marketOpen(Date.UTC(2026, 9, 26, 3, 44)), false); // 09:14 IST Monday
  assert.equal(gtt.marketOpen(Date.UTC(2026, 9, 26, 3, 45)), true);
  assert.equal(gtt.marketOpen(Date.UTC(2026, 9, 26, 10, 1)), false); // 15:31
  assert.equal(gtt.marketOpen(Date.UTC(2026, 9, 25, 5, 0)), false); // Sunday
});
