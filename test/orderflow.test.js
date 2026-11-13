import { test } from "node:test";
import assert from "node:assert/strict";
import { flow, instrumentOf, toRow, trades } from "../lib/orderflow.js";
import { parseTrade } from "../lib/cryptoflow.js";
import { addTrade, mergeBars, totals, imbalances, sessionDelta, divergence } from "../public/lib/footprint.js";
import { buildProfile, sessionProfiles, niceStep, profileOptions } from "../public/lib/market-profile.js";
import { LAYOUTS, cells, layoutById, layoutWithout } from "../public/js/layouts.js";

const q = (t, p, v, bid, ask) => ({ t, p, v, b: [[bid, 1, 1]], a: [[ask, 1, 1]] });

test("volume takes its side from the previous best bid and ask, then the price move", () => {
  const { minutes, unknown } = flow([
    q(0, 100, 1000, 99, 101),
    q(1000, 101, 1100, 100, 102), // at the ask: buy 100
    q(2000, 100, 1130, 99, 101), // at the bid: sell 30
    q(3000, 100.5, 1140, 100, 101), // between, price up: buy 10
    q(4000, 100.5, 1145, 100, 101), // no move: keeps the side, buy 5
    q(5000, 100.5, 1145, 100, 101), // no new volume
  ]);
  assert.equal(unknown, 0);
  assert.deepEqual([minutes[0].buy, minutes[0].sell, minutes[0].delta, minutes[0].cvd], [115, 30, 85, 85]);
  assert.deepEqual(minutes[0].prices[101], { buy: 100, sell: 0 });
  assert.deepEqual(minutes[0].prices[100], { buy: 0, sell: 30 });
});

test("the first row and volume across a gap are not guessed", () => {
  const { minutes, unknown } = flow([q(0, 100, 5000, 99, 101), q(120000, 101, 5500, 100, 102), q(121000, 101, 5510, 100, 102)]);
  assert.equal(unknown, 500);
  assert.equal(minutes[0].buy, 10);
  assert.equal(minutes[0].at, 120000);
});

test("no known side yet stays unknown; a falling day counter is ignored", () => {
  const { minutes, unknown } = flow([q(0, 100, 10, 0, 0), q(1000, 100, 15, 0, 0), q(2000, 100, 3, 0, 0)]);
  assert.equal(unknown, 5);
  assert.equal(minutes.length, 0);
});

test("any stock or index maps to what gets recorded, and nothing else does", () => {
  assert.deepEqual(instrumentOf("YAHOO:RELIANCE.NS"), { name: "RELIANCE", seg: "nse_cm", stock: "RELIANCE" });
  assert.equal(instrumentOf(" reliance ").name, "RELIANCE");
  assert.equal(instrumentOf("YAHOO:M&M.BO").name, "M&M");
  assert.deepEqual(instrumentOf("YAHOO:^NSEI"), { name: "NIFTY", seg: "nse_fo", future: "NIFTY" });
  assert.equal(instrumentOf("NIFTY").future, "NIFTY");
  assert.equal(instrumentOf("^BSESN").seg, "bse_fo");
  for (const bad of ["../../secret", "BINANCE:BTCUSDT", "", "A/B", "NFO:../X"]) assert.equal(instrumentOf(bad), null, bad);
  // F&O contracts: this month's index future shares the index's recording; others record on their own.
  const nov = Date.UTC(2026, 10, 9, 6);
  assert.equal(instrumentOf("NFO:NIFTY26NOVFUT", nov).name, "NIFTY");
  assert.deepEqual(instrumentOf("NFO:NIFTY26DECFUT", nov), { name: "NIFTY26DECFUT", seg: "nse_fo", contract: "NIFTY26DECFUT" });
  assert.deepEqual(instrumentOf("BFO:SENSEX26N1376000CE", nov), { name: "SENSEX26N1376000CE", seg: "bse_fo", contract: "SENSEX26N1376000CE" });
});

test("reading a recording in parts gives the same trades as reading it whole", () => {
  const rows = [q(0, 100, 1000, 99, 101), q(1000, 101, 1100, 100, 102), q(2000, 100, 1130, 99, 101), q(3000, 100.5, 1140, 100, 101), q(4000, 100.5, 1145, 100, 101)];
  const state = { prev: null, side: 0 };
  const parts = [...trades(rows.slice(0, 2), state).list, ...trades(rows.slice(2), state).list];
  assert.deepEqual(parts, trades(rows).list);
  assert.deepEqual(parts.at(-1), { t: 4000, price: 100.5, qty: 5, isSell: false });
});

test("a Kotak quote becomes a row of numbers", () => {
  const row = toRow(
    { ltp: "736.70", last_traded_quantity: "1", last_volume: "50", total_buy: "4", total_sell: "0", open_int: "0", lstup_time: "9", depth: { buy: [{ price: "736", quantity: "4", orders: "5" }], sell: [] } },
    7,
  );
  assert.deepEqual(row, { t: 7, ex: 9, p: 736.7, q: 1, v: 50, tb: 4, ts: 0, oi: 0, b: [[736, 4, 5]], a: [] });
});

test("a Binance file row reads the same in microseconds or milliseconds, and a header is skipped", () => {
  const spot = parseTrade("4103800764,77582.02,0.00105,6809266910,6809266910,1793491200447286,True,True");
  assert.deepEqual(spot, { id: 4103800764, price: 77582.02, qty: 0.00105, t: 1793491200447.286, isSell: true });
  assert.equal(parseTrade("3503629129,77522.6,0.016,8224000617,8224000617,1793491200016,false").t, 1793491200016);
  assert.equal(parseTrade("3503629129,77522.6,0.016,8224000617,8224000617,1793491200016,false").isSell, false);
  assert.equal(parseTrade("agg_trade_id,price,quantity,first_trade_id,last_trade_id,transact_time,is_buyer_maker"), null);
});

test("trades build a bar, and minutes merge into a larger bar and row size", () => {
  const m = new Map();
  addTrade(m, 60000, 102, 1, false);
  addTrade(m, 61000, 108, 2, false);
  addTrade(m, 62000, 101, 3, true);
  addTrade(m, 120000, 111, 4, true);
  const [a, b] = [...m.values()];
  assert.deepEqual([a.o, a.h, a.l, a.c], [102, 108, 101, 101]);
  assert.deepEqual(a.cells, { 100: [1, 3], 105: [2, 0] });
  const [big] = mergeBars([a, b], 300000, 10);
  assert.deepEqual([big.at, big.o, big.h, big.l, big.c], [0, 102, 111, 101, 111]);
  assert.deepEqual(big.cells, { 100: [3, 3], 110: [0, 4] });
  assert.deepEqual(totals(big), { buy: 3, sell: 7, delta: -4, poc: 100 });
});

test("imbalances compare diagonally and three in a row make a stack", () => {
  const bar = { cells: { 100: [1, 2], 105: [9, 8], 110: [6, 1], 115: [6, 1], 120: [1, 8] } };
  const { buys, sells, stacks } = imbalances(bar, 5, 3, 2);
  assert.deepEqual([...buys], [105, 115]); // 105 beats the 2 sold below it; 110 loses to the 8 sold at 105
  assert.deepEqual([...sells], [120]);
  assert.deepEqual(stacks, []);
  const run = imbalances({ cells: { 100: [9, 0], 105: [9, 0], 110: [9, 0], 120: [9, 0] } }, 5, 3, 2);
  assert.deepEqual(run.stacks, [{ side: "buy", from: 100, to: 110 }]);
});

test("a profile prints one letter per period on every row it touched", () => {
  const bars = [
    { time: 0, high: 12, low: 10 },
    { time: 900, high: 13, low: 11 }, // still period A
    { time: 1800, high: 12, low: 11 },
    { time: 3600, high: 12, low: 11 },
    { time: 5400, high: 15, low: 14 },
  ];
  const p = buildProfile(bars, { periodSec: 1800, step: 1, valueArea: 70 });
  assert.deepEqual(p.letters, ["A", "ABC", "ABC", "A", "D", "D"]); // rows 10 to 15
  assert.equal(p.poc, 12); // rows 11 and 12 tie; 12 is nearer the middle of 10-15
  assert.deepEqual([p.val, p.vah], [11, 14]); // 12, then 11, then 13 reaches 7 of 10 letters
  assert.deepEqual(p.ib, { high: 13, low: 10 });
  assert.equal(p.poorHigh, false);
  assert.equal(p.poorLow, false);
});

test("sessions split by day, and a POC stays naked until price returns", () => {
  const day = 86400;
  const bars = [
    { time: 0, high: 101, low: 100 },
    { time: 1800, high: 101, low: 100 },
    { time: day, high: 120, low: 110 },
    { time: day + 1800, high: 120, low: 100 },
    { time: 2 * day, high: 130, low: 125 },
  ];
  const list = sessionProfiles(bars, (t) => Math.floor(t / day), { periodSec: 1800, step: 1 });
  assert.deepEqual(list.map((p) => [p.from, p.to]), [[0, 1], [2, 3], [4, 4]]);
  assert.equal(list[0].nakedTo, 3);
  assert.equal(list[2].nakedTo, null);
});

test("round row sizes and the session a timeframe uses", () => {
  assert.deepEqual([niceStep(0.3), niceStep(7), niceStep(180), niceStep(0)], [0.5, 10, 200, 1]);
  assert.deepEqual(profileOptions(300), { session: "day", periodSec: 1800, ib: true });
  assert.deepEqual(profileOptions(86400), { session: "month", periodSec: 86400, ib: false });
  assert.equal(profileOptions(300, { period: "Week" }).session, "week");
});

test("every layout is a set of whole rectangles that fill the grid", () => {
  const ids = new Set();
  for (const l of LAYOUTS) {
    assert.ok(!ids.has(l.id), l.id);
    ids.add(l.id);
    const widths = l.areas.map((r) => r.split(" ").length);
    assert.ok(widths.every((w) => w === widths[0]), `${l.id} has uneven rows`);
    const { width, height, cells: list } = cells(l);
    assert.equal(list.length, l.count, l.id);
    const area = list.reduce((a, c) => a + (c.x1 - c.x0 + 1) * (c.y1 - c.y0 + 1), 0);
    assert.equal(area, width * height, `${l.id} has a chart that isn't a rectangle`);
  }
  for (const old of ["1", "2v", "2h", "3", "4", "6", "8", "16"]) assert.ok(ids.has(old), `saved layout ${old} must keep working`);
  const count = (n) => LAYOUTS.filter((l) => l.count === n).length;
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(count), [1, 2, 6, 13, 12, 10]);
});

test("delta divergence needs a new extreme, a matching close and the opposite delta", () => {
  const bar = (o, h, l, c, buy, sell) => ({ o, h, l, c, cells: { 100: [buy, sell] } });
  const flat = Array.from({ length: 5 }, () => bar(100, 101, 99, 100, 1, 1));
  const at = (b, lead = flat) => divergence([...lead, b], lead.length);
  assert.equal(at(bar(100, 102, 99, 101, 1, 3)), "bear");
  assert.equal(at(bar(100, 101, 98, 99, 3, 1)), "bull");
  assert.equal(at(bar(100, 102, 99, 101, 3, 1)), null); // buying agrees with the rise
  assert.equal(at(bar(100, 100.5, 99, 100.2, 1, 3)), null); // no new high
  assert.equal(at(bar(100, 102, 99, 100, 1, 3)), null); // no up close
  assert.equal(at(bar(100, 102, 99, 101, 1, 3), flat.slice(1)), null); // not enough bars before it
});

test("session delta adds up only the newest bar's UTC day", () => {
  const day = 864e5;
  const bar = (at, buy, sell) => ({ at, cells: { 100: [buy, sell] } });
  assert.equal(sessionDelta([]), 0);
  assert.equal(sessionDelta([bar(day - 6e4, 50, 0), bar(day, 3, 1), bar(day + 6e4, 1, 4)]), -1);
});

test("closing a chart leaves a layout with one fewer, the others keeping their places", () => {
  const less = (id, i) => layoutWithout(layoutById(id), i);
  assert.equal(less("3c", 1).id, "2v"); // three across, middle closed: two across
  assert.equal(less("3r", 0).id, "2h"); // three stacked, top closed: two stacked
  assert.equal(less("2v", 0).id, "1");
  assert.equal(less("4", 3).id, "3t"); // 2x2 less the bottom right: two on top, one wide
  assert.equal(less("4t", 0).id, "3c"); // the wide top chart closed: the three below
  assert.deepEqual(less("6", 2).areas, ["a b b", "c d e"]); // not in the list: kept as its own shape
  assert.equal(layoutById(less("6", 2).id).count, 5, "an unlisted shape is saved and read back by its id");
  for (const l of LAYOUTS)
    for (let i = 0; l.count > 1 && i < l.count; i++) {
      const r = layoutWithout(l, i);
      assert.equal(r.count, l.count - 1, `${l.id} less ${i}`);
      assert.ok(layoutById(r.id), `${l.id} less ${i} gives a usable layout`);
    }
  for (const bad of ["x:ab/c", "x:aa/ba", "x:ac", "x:../", "nope"]) assert.equal(layoutById(bad), null, bad);
});
