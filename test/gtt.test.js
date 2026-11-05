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

const FO = { seg: "nse_fo", token: "61471", tradingSymbol: "NIFTY26N0923900CE", lot: 65 };
const foBase = { account: "kotak-2", fo: FO, side: "SELL", qty: 65, product: "NRML", kind: "single" };

test("an F&O stop trails, then sends a limit on the 0.05 tick with the position's details", async () => {
  const t = setup({ broker: "kotak" });
  const g = gtt.add({ ...foBase, legs: [{ trigger: 90, orderType: "LIMIT", price: 88.33, trail: { type: "pct", value: 10 } }] }, 100);
  assert.equal(g.symbol, "NFO:NIFTY26N0923900CE");
  t.setPrice(120);
  await gtt.evaluate();
  assert.equal(g.legs[0].trigger, 108);
  t.setPrice(107);
  await gtt.evaluate();
  assert.equal(t.placed.length, 1);
  assert.deepEqual([t.placed[0].side, t.placed[0].qty, t.placed[0].product, t.placed[0].price, t.placed[0].fo], ["SELL", 65, "NRML", 106.35, FO]); // 106.33 to the tick
});

test("an F&O stop must be whole lots of a complete position", () => {
  setup();
  const legs = [{ trigger: 90, orderType: "MARKET" }];
  assert.throws(() => gtt.add({ ...foBase, qty: 60, legs }, 100), /whole number of lots of 65/);
  assert.throws(() => gtt.add({ ...foBase, product: "CNC", legs }, 100), /NRML or MIS/);
  assert.throws(() => gtt.add({ ...foBase, fo: { ...FO, token: "" }, legs }, 100), /incomplete/);
});

test("an order that wasn't sent stays active and retries, alerting once", async () => {
  const t = setup({ failWith: Object.assign(new Error("network"), { notSent: true }) });
  const g = gtt.add({ ...foBase, legs: [{ trigger: 90, orderType: "MARKET" }] }, 100);
  t.setPrice(89);
  await gtt.evaluate();
  await gtt.evaluate();
  assert.equal(g.status, "active");
  assert.equal(t.alerts.length, 1);
});

test("no prices for a minute: says the stop isn't being watched, once", async () => {
  const placed = [], alerts = [];
  let now = Date.UTC(2026, 9, 26, 5, 0), quote = { price: 100 };
  gtt._reset([]);
  gtt.configure({ quotes: async (s) => Object.fromEntries(s.map((x) => [x, quote])), place: async () => placed.push(1), connected: () => false, accountName: () => "Kotak Neo 2", notify: (e) => alerts.push(e.text), now: () => now });
  const g = gtt.add({ ...foBase, legs: [{ trigger: 90, orderType: "MARKET" }] }, 100);
  quote = {};
  await gtt.evaluate();
  assert.equal(alerts.length, 0);
  now += 61000;
  await gtt.evaluate();
  now += 61000;
  await gtt.evaluate();
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /ISN'T being watched.*isn't logged in/);
  quote = { price: 100 };
  await gtt.evaluate();
  assert.equal(g.noPriceAlerted, false);
});

test("Kotak positions: F&O details and cost; an exit can't go past the position or working orders", async () => {
  const { kotakPositions, exitRoom } = await import("../lib/brokers.js");
  const [p] = kotakPositions([{ exSeg: "nse_fo", tok: "61471", trdSym: FO.tradingSymbol, sym: "NIFTY", prod: "NRML", lotSz: "65", cfBuyQty: "130", flBuyQty: "0", cfSellQty: "0", flSellQty: "65", cfBuyAmt: "23000", buyAmt: "0", sellAmt: "13000", cfSellAmt: "0" }]);
  assert.deepEqual([p.qty, p.avg, p.cost, p.fo], [65, 176.92307692307693, 10000, FO]);
  assert.equal(p.symbol, null);
  const order = (over) => ({ exSeg: "nse_fo", trdSym: FO.tradingSymbol, trnsTp: "S", ordSt: "open", qty: "65", fldQty: "0", ...over });
  assert.deepEqual(exitRoom([p], [], FO, "NRML"), { side: "SELL", room: 65 });
  assert.equal(exitRoom([p], [order()], FO, "NRML").room, 0);
  assert.equal(exitRoom([p], [order({ ordSt: "rejected" }), order({ trnsTp: "B" }), order({ trdSym: "OTHER" })], FO, "NRML").room, 65);
  assert.deepEqual(exitRoom([p], [], FO, "MIS"), { side: null, room: 0 });
});

test("Kotak contract files: lots, price steps, expiry from the key, quoted names; expired rows dropped", async () => {
  const { parseContracts, searchContracts, checkContractOrder } = await import("../lib/brokers.js");
  const head = "pSymbol,pGroup,pExchSeg,pInstType,pSymbolName,pTrdSymbol,pOptionType,pScripRefKey,pDesc,dTickSize ,lLotSize,dStrikePrice;,pExpiryDate";
  const nfo = [head, "39956,XX,nse_fo,OPTIDX,NIFTY,NIFTY26N0923900CE,CE,NIFTY09NOV2623900.00CE,,5,65,2.39e+06,1478701800", "61471,XX,nse_fo,FUTIDX,NIFTY,NIFTY26NOVFUT,XX,NIFTY23NOV26FUT,,5,65,-1,1479911400", "7,XX,nse_fo,OPTIDX,NIFTY,OLD,CE,NIFTY28OCT2623900.00CE,,5,65,2.39e+06,1", "8,XX,nse_fo,OPTIDX,BANKNIFTY,BANKNIFTY26N0923900CE,CE,BANKNIFTY09NOV2623900.00CE,,5,30,2.39e+06,1"].join("\n");
  const fo = parseContracts(nfo, "nse_fo", "2026-11-05");
  assert.deepEqual(fo[0], { seg: "nse_fo", token: "39956", trd: "NIFTY26N0923900CE", name: "NIFTY", kind: "fo", opt: "CE", strike: 23900, lot: 65, tick: 0.05, expiry: "2026-11-09" });
  assert.equal(fo[1].opt, "FUT");
  assert.equal(fo.length, 3);
  const cm = parseContracts([head, '2885,EQ,nse_cm,,RELIANCE,RELIANCE-EQ,XX,RELIANCE,"RELIANCE, INDUSTRIES",10,1,-1,0', "9,GS,nse_cm,,711GS,711GS-GS,XX,711GS,BOND,1,1,-1,0"].join("\n"), "nse_cm", "2026-11-05");
  assert.deepEqual([cm.length, cm[0].tick, cm[0].lot, cm[0].kind], [1, 0.1, 1, "eq"]);

  const rows = [...fo, ...cm];
  assert.deepEqual(searchContracts(rows, "nifty").map((r) => r.token), ["61471", "39956", "8"]);
  assert.deepEqual(searchContracts(rows, "nifty 23900 ce").map((r) => r.token), ["39956", "8"]);
  assert.deepEqual(searchContracts(rows, "reliance").map((r) => r.token), ["2885"]);
  assert.deepEqual(searchContracts(rows, "  "), []);

  const opt = fo[0], ok = { side: "buy", type: "limit", product: "nrml", qty: 130, price: 178.25 };
  assert.deepEqual(checkContractOrder(opt, ok), { side: "BUY", type: "LIMIT", product: "NRML", qty: 130, price: 178.25, trigger: NaN });
  assert.throws(() => checkContractOrder(opt, { ...ok, qty: 100 }), /whole number of lots of 65/);
  assert.throws(() => checkContractOrder(opt, { ...ok, price: 178.26 }), /steps of ₹0.05/);
  assert.throws(() => checkContractOrder(opt, { ...ok, product: "CNC" }), /NRML or MIS/);
  assert.throws(() => checkContractOrder(cm[0], { ...ok, qty: 1, product: "NRML", price: 1300 }), /CNC or MIS/);
  assert.throws(() => checkContractOrder(cm[0], { ...ok, qty: 1, product: "CNC", price: 1300.05 }), /steps of ₹0.1/);
  assert.throws(() => checkContractOrder(opt, { ...ok, type: "SL", trigger: 0 }), /trigger/);
});

test("a GTT from the order window may open a position; one on a position may not", async () => {
  const t = setup({ broker: "kotak" });
  const stock = { seg: "bse_cm", token: "500325", tradingSymbol: "RELIANCE", lot: 1, tick: 0.05 };
  const g = gtt.add({ account: "kotak-2", fo: stock, allowOpen: true, side: "BUY", qty: 5, product: "CNC", kind: "single", legs: [{ trigger: 105, orderType: "LIMIT", price: 105.13 }] }, 100);
  t.setPrice(106);
  await gtt.evaluate();
  assert.deepEqual([t.placed[0].allowOpen, t.placed[0].fo.seg, t.placed[0].price], [true, "bse_cm", 105.15]);
  assert.equal(g.status, "triggered");
  const t2 = setup({ broker: "kotak" });
  gtt.add({ ...foBase, legs: [{ trigger: 90, orderType: "MARKET" }] }, 100);
  t2.setPrice(89);
  await gtt.evaluate();
  assert.equal(t2.placed[0].allowOpen, false);
});
