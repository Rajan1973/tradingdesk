// Key Levels zones: pivots open zones, width from ATR, closes flip them, only nPiv tracked per side.
import { test } from "node:test";
import assert from "node:assert/strict";
import { keyLevels } from "../public/lib/keylevels.js";

// Bars from closes: a small fixed range around each close, so the ATR is steady and known.
const barsOf = (closes) => closes.map((c, i) => ({ time: 1000 + i * 60, open: c, high: c + 1, low: c - 1, close: c }));
const P = { left: 2, right: 2, nPiv: 4, atrLen: 3, mult: 0.5, maxPct: 5, pivotSource: "High/Low", align: true, highs: true, lows: true };

test("a pivot high opens a resistance zone; a close above it turns it into support from that bar", () => {
  //            0    1    2    3    4    5    6    7    8
  const closes = [100, 101, 110, 101, 100, 101, 102, 115, 116];
  const r = keyLevels(barsOf(closes), P);
  const res = r.zones.find((z) => !z.bull);
  // Pivot high at bar 2 (high 111). ATR: true ranges settle near 2-10; band = min(ATR*0.5, 5%)/2.
  assert.equal(res.from, 1000 + 2 * 60);
  assert.ok(res.top > 111 && res.bottom < 111 && Math.abs(res.top + res.bottom - 222) < 1e-9, "centred on the pivot");
  assert.equal(res.live, false, "ended when price closed above it");
  const sup = r.zones.find((z) => z.bull && z.top === res.top);
  assert.ok(sup, "the same edges carry on as support");
  assert.equal(sup.from, 1000 + 7 * 60, "from the bar that closed above (115)");
  assert.equal(sup.live, true);
  assert.equal(sup.to, 1000 + 8 * 60, "reaching the last bar");
  // Price is above it, so the label sits on its top edge, under the level.
  assert.ok(r.labels.some((l) => l.price === sup.top && l.up && l.bull));
});

test("only the newest nPiv zones per side keep growing; older ones stop", () => {
  const closes = [];
  for (let k = 0; k < 8; k++) closes.push(100, 100, 120 + k * 0.01, 100, 100); // 8 separate pivot highs, never broken
  const r = keyLevels(barsOf(closes), { ...P, nPiv: 3, align: false, lows: false });
  const res = r.zones.filter((z) => !z.bull);
  assert.equal(res.length, 8);
  assert.equal(res.filter((z) => z.live).length, 3);
  assert.equal(r.labels.length, 3, "labels for the tracked zones only");
});

test("align: a new zone overlapping a tracked one takes its edges", () => {
  // Two pivot highs at 120 and 120.5: zones overlap, so the second lines up with the first.
  const closes = [100, 100, 119, 100, 100, 100, 119.5, 100, 100];
  const a = keyLevels(barsOf(closes), { ...P, lows: false });
  const [z1, z2] = a.zones.filter((z) => !z.bull);
  assert.deepEqual([z2.top, z2.bottom], [z1.top, z1.bottom]);
  const b = keyLevels(barsOf(closes), { ...P, lows: false, align: false });
  const [, w2] = b.zones.filter((z) => !z.bull);
  assert.notEqual(w2.top, z1.top);
});

test("the zone is never wider than the max % of price, and HA is the default source", () => {
  const closes = [100, 100, 130, 100, 100, 100, 100];
  const r = keyLevels(barsOf(closes), { ...P, mult: 50, maxPct: 1, pivotSource: undefined, lows: false });
  const z = r.zones[0];
  // The band is min(ATR × 50, 1% of the pivot bar's close) = 1.3, split half above and half below.
  assert.ok(Math.abs(z.top - z.bottom - 1.3) < 1e-9, `width ${z.top - z.bottom}`);
});
