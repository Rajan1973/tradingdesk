// Simple Volume: bar colours, highest/lowest volume labels, Bull Snort, Power Volume and the table.
import { test } from "node:test";
import assert from "node:assert/strict";
import { simpleVolume, SV_COLORS as C } from "../public/lib/simplevolume.js";
import { defaults } from "../public/lib/indicators.js";

const P = defaults("simplevolume");
const DAY = 86400;
// Daily bars from [open, close, volume, high?, low?]. Up/down days follow open vs close by default.
const barsOf = (rows) =>
  rows.map(([open, close, volume, high = Math.max(open, close) + 1, low = Math.min(open, close) - 1], i) => ({ time: 1.7e9 + i * DAY, open, high, low, close, volume }));
const flat = (k) => Array.from({ length: k }, (_, i) => (i % 2 ? [101, 100, 1000] : [100, 101, 1000])); // alternate up/down days

test("defaults follow the original's settings panel", () => {
  assert.deepEqual([P.ppvLength, P.maLength, P.rvolLength, P.udLength, P.snortLength, P.turnoverLength, P.turnoverType], ["10", 34, 20, 17, 50, "50 period", "VWAP"]);
  assert.deepEqual([P.prevClose, P.dry, P.dryDivisor, P.power, P.powerVolume, P.powerDown, P.bullSnort], [false, true, "5", false, 500000, true, false]);
});

test("colours: pocket pivot blue, above-average green/red, dry orange (below 1/5), the rest dark grey", () => {
  const rows = [...flat(60), [100, 103, 1500], [103, 101, 3000], [101, 102, 100], [102, 103, 900]];
  const { colors } = simpleVolume(barsOf(rows), P);
  assert.equal(colors[60], C.ppv, "up day beating every down day's 1000");
  assert.equal(colors[61], C.down, "down day above average");
  assert.equal(colors[62], C.dry, "a tenth of average");
  assert.equal(colors[63], C.noise, "up day, below average, doesn't beat the 3000 down day");
  // Colour by previous close: a red candle that closed above yesterday counts as an up day.
  const gap = [...flat(60), [110, 105, 5000]]; // opened 110, closed 105, but above the previous close (100)
  assert.equal(simpleVolume(barsOf(gap), P).colors[60], C.down);
  assert.equal(simpleVolume(barsOf(gap), { ...P, prevClose: true }).colors[60], C.ppv);
});

test("HVE / HVY / HVQ labels as text, Y / Q lows, latest only by default", () => {
  const rows = [];
  for (let i = 0; i < 300; i++) rows.push([100, 100 + (i % 3), 1000 + (i % 7)]);
  rows[100][2] = 50000; // highest ever
  rows[280][2] = 9000; //  highest in a year, not ever
  rows[290][2] = 200; //   lowest
  const { paneMarkers } = simpleVolume(barsOf(rows), P);
  const at = (i) => paneMarkers.filter((m) => m.time === 1.7e9 + i * DAY).map((m) => m.text);
  assert.deepEqual(at(100), ["HVE 50.0K"]);
  assert.ok(/^HV[YQ] 9\.0K$/.test(at(280)[0]), at(280));
  assert.ok(["Y", "Q"].includes(at(290)[0]));
  assert.equal(paneMarkers.find((m) => m.text.startsWith("HVE")).size, 0, "text only, no symbol");
  assert.ok(simpleVolume(barsOf(rows), { ...P, showPct: true }).paneMarkers.some((m) => /^HVE 50\.0K \(\d+%\)$/.test(m.text)));
  assert.ok(simpleVolume(barsOf(rows), { ...P, hvLabels: "All" }).paneMarkers.filter((m) => m.text.startsWith("HV")).length > 3);
  assert.equal(simpleVolume(barsOf(rows), { ...P, hvLabels: "Off" }).paneMarkers.length, 0);
});

test("no volume labels on intraday bars", () => {
  const rows = Array.from({ length: 300 }, (_, i) => ({ time: 1.7e9 + i * 300, open: 100, high: 101, low: 99, close: 100 + (i % 2), volume: i === 200 ? 99999 : 1000 }));
  assert.equal(simpleVolume(rows, P).paneMarkers.length, 0);
});

test("Bull Snort and Power Volume only when switched on", () => {
  const rows = Array.from({ length: 60 }, (_, i) => (i % 2 ? [101, 100, 100000] : [100, 101, 100000]));
  rows.push([100, 110, 400000, 111, 100]); // 4× volume, up 9%, close in the top 10% of the range
  rows.push([110, 100, 400000, 112, 99]); //  down 9%, big volume
  const on = { ...P, bullSnort: true, power: true, powerVolume: 300000 };
  const kinds = (p, i) => simpleVolume(barsOf(rows), p).paneMarkers.filter((m) => m.time === 1.7e9 + i * DAY).map((m) => m.kind).sort();
  assert.deepEqual(kinds(P, 60), [], "off by default");
  assert.deepEqual(kinds(on, 60), ["power", "snort"]);
  assert.deepEqual(kinds(on, 61), ["power"]);
  assert.deepEqual(kinds({ ...on, powerDown: false }, 61), []);
});

test("table: Avg₹Vol in crores with the threshold colour, RVol, U/D Vol, projected RVol when asked", () => {
  const rows = Array.from({ length: 60 }, (_, i) => (i % 2 ? [1001, 1000, 100000, 1001, 1000] : [1000, 1001, 100000, 1001, 1000]));
  rows.push([1001, 1003, 50000, 1003, 1001]);
  const bars = barsOf(rows);
  const t = Object.fromEntries(simpleVolume(bars, P).table.map((x) => [x.label, x]));
  assert.equal(t["Avg₹Vol"].text, "10.01 Cr"); // volume × typical price (VWAP stand-in), about ₹10 Cr a day
  assert.equal(t["Avg₹Vol"].tone, "up", "above the ₹5 Cr threshold");
  assert.equal(simpleVolume(bars, { ...P, turnoverThreshold: 20 }).table[0].tone, "down");
  assert.equal(t.RVol.text, "50%");
  assert.ok(t["U/D Vol"]);
  assert.equal(simpleVolume(bars, { ...P, rvolStyle: "Multiplier" }).table.find((x) => x.label === "RVol").text, "0.50x");
  // The last bar is "today", 2 hours into the 6¼-hour session: 50K so far projects to about 156K.
  const day0 = bars.at(-1).time + 19800 - ((bars.at(-1).time + 19800) % DAY) - 19800;
  const now = (day0 + 9.25 * 3600 + 2 * 3600) * 1000;
  assert.equal(simpleVolume(bars, P, now).table.find((x) => x.label === "Proj RVol"), undefined, "off by default");
  assert.equal(simpleVolume(bars, { ...P, projection: true }, now).table.find((x) => x.label === "Proj RVol").text, "156%");
  assert.equal(simpleVolume(bars, { ...P, table: "Off" }).table.length, 0);
});
