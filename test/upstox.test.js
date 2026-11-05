import { test } from "node:test";
import assert from "node:assert/strict";
import { buildInstruments, decodeFeed, fillMissingDays, intervalOf, parseCandles, toRow } from "../lib/upstox.js";
import { flow } from "../lib/orderflow.js";
import { applyLivePrice } from "../public/lib/series.js";

// A small protobuf writer, field numbers as in Upstox's MarketDataFeed.proto.
const varint = (v) => {
  const out = [];
  while (v >= 128) {
    out.push((v % 128) | 128);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return Buffer.from(out);
};
const int = (no, v) => Buffer.concat([varint(no * 8), varint(v)]);
const dbl = (no, v) => {
  const b = Buffer.alloc(9);
  b[0] = no * 8 + 1;
  b.writeDoubleLE(v, 1);
  return b;
};
const msg = (no, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([varint(no * 8 + 2), varint(body.length), body]);
};
const text = (no, s) => msg(no, Buffer.from(s));
const ltpc = (no, ltp, ltt, ltq) => msg(no, dbl(1, ltp), int(2, ltt), int(3, ltq));
const entry = (key, ...feed) => msg(2, text(1, key), msg(2, ...feed));

test("the live feed decodes prices, and depth, volume and totals in full mode", () => {
  const quote = (bidQ, bidP, askQ, askP) => msg(1, int(1, bidQ), dbl(2, bidP), int(3, askQ), dbl(4, askP));
  const buf = Buffer.concat([
    int(1, 1),
    entry("NSE_EQ|A", ltpc(1, 1300.5, 1793000000123, 7)),
    entry("NSE_FO|B", msg(2, msg(1, ltpc(1, 24000.5, 1793000000456, 75), msg(2, quote(10, 24000, 20, 24001), quote(30, 23999, 40, 24002)), int(6, 150000), dbl(7, 9000), dbl(9, 500), dbl(10, 600)))),
    entry("NSE_INDEX|C", msg(2, msg(2, ltpc(1, 23800.25, 1793000000789, 0)))),
    int(3, 1793000000999),
  ]);
  const f = decodeFeed(buf);
  assert.deepEqual(f["NSE_EQ|A"], { ltp: 1300.5, ltt: 1793000000123, ltq: 7 });
  assert.deepEqual(f["NSE_FO|B"], {
    ltp: 24000.5, ltt: 1793000000456, ltq: 75, full: true, vtt: 150000, oi: 9000, tbq: 500, tsq: 600,
    bids: [[24000, 10, 0], [23999, 30, 0]],
    asks: [[24001, 20, 0], [24002, 40, 0]],
  });
  assert.equal(f["NSE_INDEX|C"].ltp, 23800.25);
  assert.deepEqual(decodeFeed(int(1, 2)), {}); // a market status message has no prices
});

test("recorded rows work with the order flow estimate", () => {
  const row = (t, p, v, bid, ask) => toRow({ ltp: p, ltt: t, ltq: 1, vtt: v, tbq: 0, tsq: 0, oi: 0, bids: [[bid, 1, 0]], asks: [[ask, 1, 0]] }, t);
  const { minutes } = flow([row(0, 100, 1000, 99, 101), row(1000, 101, 1100, 100, 102), row(2000, 100, 1130, 99, 101)]);
  assert.deepEqual([minutes[0].buy, minutes[0].sell], [100, 30]);
});

test("instrument list: stocks by symbol, and the nearest live future", () => {
  const list = buildInstruments(
    [
      { segment: "NSE_EQ", instrument_type: "EQ", trading_symbol: "RELIANCE", instrument_key: "NSE_EQ|R" },
      { segment: "NSE_EQ", instrument_type: "SG", trading_symbol: "711GS", instrument_key: "NSE_EQ|bond" },
      { segment: "BSE_EQ", instrument_type: "A", trading_symbol: "RELIANCE", instrument_key: "BSE_EQ|R" },
      { segment: "NSE_FO", instrument_type: "FUT", underlying_symbol: "NIFTY", expiry: 300, instrument_key: "far" },
      { segment: "NSE_FO", instrument_type: "FUT", underlying_symbol: "NIFTY", expiry: 200, instrument_key: "near" },
      { segment: "NSE_FO", instrument_type: "FUT", underlying_symbol: "NIFTY", expiry: 50, instrument_key: "expired" },
      { segment: "NSE_FO", instrument_type: "CE", underlying_symbol: "NIFTY", expiry: 150, instrument_key: "option" },
    ],
    "2026-11-05",
    100,
  );
  assert.deepEqual(list, { day: "2026-11-05", NS: { RELIANCE: "NSE_EQ|R" }, BO: { RELIANCE: "BSE_EQ|R" }, fut: { NIFTY: "near" } });
});

test("timeframes map to Upstox's, and the rest stay with Yahoo", () => {
  assert.deepEqual(["1m", "300m", "1h", "1D", "1W", "1M"].map(intervalOf), [["minutes", 1], ["minutes", 300], ["hours", 1], ["days", 1], ["weeks", 1], ["months", 1]]);
  assert.deepEqual(["1s", "301m", "6h", "2D"].map(intervalOf), [null, null, null, null]);
});

test("candles come oldest first, with daily bars at midnight UTC of their date", () => {
  const rows = [["2026-11-03T09:20:00+05:30", 2, 4, 1, 3, 50, 0], ["2026-11-03T09:15:00+05:30", 1, 2, 1, 2, 40, 0]];
  assert.deepEqual(parseCandles(rows, false).map((b) => [b.time, b.close, b.volume]), [[Date.UTC(2026, 10, 3, 3, 45) / 1000, 2, 40], [Date.UTC(2026, 10, 3, 3, 50) / 1000, 3, 50]]);
  assert.equal(parseCandles([["2026-11-03T00:00:00+05:30", 1, 1, 1, 1, 1, 0]], true)[0].time, Date.UTC(2026, 10, 3) / 1000);
});

test("days Upstox lacks are filled from the other source and named", () => {
  const at = (d, h = 4) => Date.UTC(2026, 10, d, h) / 1000;
  const bar = (time, close) => ({ time, close });
  const r = { tf: "5m", candles: [bar(at(3), 1), bar(at(5), 3)], notes: [] };
  const filled = fillMissingDays(r, { provider: "Yahoo", candles: [bar(at(2), 9), bar(at(3), 9), bar(at(4), 2), bar(at(5), 9)] }, at(6));
  assert.deepEqual(filled.candles, [bar(at(4), 2), bar(at(5), 3)]); // same bar count, newest kept
  assert.match(filled.notes[0], /2026-11-04.*Yahoo/);
  assert.equal(fillMissingDays(r, { candles: [bar(at(4), 2)] }, at(20)), r); // an old gap stays a gap
  assert.equal(fillMissingDays(r, null), r);
  assert.equal(fillMissingDays(r, { candles: [bar(at(3), 9)] }), r);
  const weeks = { tf: "1W", candles: [bar(at(2), 1)], notes: [] };
  assert.equal(fillMissingDays(weeks, { candles: [bar(at(3), 9)] }), weeks);
});

test("a live price moves the current bar, or starts one on the same 09:15 grid", () => {
  const open = Date.UTC(2026, 10, 3, 3, 45) / 1000; // 09:15 IST, not on a round half hour
  const bar = { time: open, open: 100, high: 101, low: 99, close: 100, volume: 5 };
  assert.deepEqual(applyLivePrice([bar], "30m", 103, open + 600).at(-1), { ...bar, close: 103, high: 103 });
  assert.deepEqual(applyLivePrice([bar], "30m", 98, open + 2000).at(-1), { time: open + 1800, open: 98, high: 98, low: 98, close: 98, volume: 0 });
  const day = { ...bar, time: Date.UTC(2026, 10, 3) / 1000 };
  assert.equal(applyLivePrice([day], "1D", 103, open + 600).at(-1).close, 103);
  assert.equal(applyLivePrice([day], "1D", 103, open + 86400), null); // today's daily bar comes from the source
});

test("F&O chart symbols pass the symbol check, including an ampersand", async () => {
  const { resolve } = await import("../lib/providers.js");
  assert.equal((await resolve("nfo:nifty26n0923900ce")).id, "NFO:NIFTY26N0923900CE");
  assert.equal((await resolve("NFO:M&M26NOV3000CE")).id, "NFO:M&M26NOV3000CE");
  await assert.rejects(resolve("NFO:A/../B&C"));
});
