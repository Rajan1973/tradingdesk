// Scanner: a pre-market pass over a chosen NSE index for daily chart setups (breakout_20d,
// reclaim_ma20, oversold, oversold_bounce, bull_flag), plus an intraday opening-range-breakout
// (ORB) check on 5-minute bars. Matches are "a chart matched a rule", never a buy signal.
//
// Runs on its own timer, independent of alerts.js/gtt.js/orderflow.js/upstox.js, following the
// same self-rescheduling setTimeout + single-flight pattern they use.

import { nifty500List, getCandles } from "./providers.js";
import { compute } from "../public/lib/indicators.js";
import { marketOpen } from "./gtt.js";
import * as store from "./store.js";

const OFFLINE = process.env.QT_OFFLINE === "1";
const toSymbol = (ticker) => `YAHOO:${ticker}.NS`;

let watchlist = store.read("scanner-watchlist", { daily: [], orb: [], updatedAt: null, universe: "nifty500" });
const save = () => store.write("scanner-watchlist", watchlist);

export const list = () => watchlist;

async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k], k);
      }
    }),
  );
  return out;
}

// Daily setups off the latest closed daily bar. `bars` oldest-first, needs 21+ for the 20-day lookback.
export function detectDaily(bars) {
  if (bars.length < 21) return [];
  const n = bars.length - 1;
  const closes = bars.map((b) => b.close);
  const hits = [];

  const priorHigh = Math.max(...closes.slice(n - 20, n));
  if (closes[n] > priorHigh) hits.push({ setup: "breakout_20d", level: priorHigh });

  const sma20 = compute("sma", bars, { length: 20 }).value;
  if (sma20[n] != null && sma20[n - 1] != null && closes[n - 1] < sma20[n - 1] && closes[n] >= sma20[n])
    hits.push({ setup: "reclaim_ma20", level: sma20[n] });

  const rsi = compute("rsi", bars, { length: 14 }).value;
  if (rsi[n] != null && rsi[n] < 30) hits.push({ setup: "oversold", level: rsi[n] });
  if (rsi[n] != null && rsi[n - 1] != null && rsi[n - 1] < 30 && rsi[n] >= 30)
    hits.push({ setup: "oversold_bounce", level: rsi[n] });

  const flag = detectBullFlag(bars, n);
  if (flag) hits.push(flag);

  return hits;
}

// shortcut: a heuristic (sharp pole + tight consolidation near the highs), not a strict pattern
// match. A pole of 2-5 bars gaining 8%+ followed by 1-3 quiet bars that hold within 3% of each
// other's close and stay inside the pole's range. Upgrade: real swing-point pattern detection.
function detectBullFlag(bars, n) {
  for (let consolidation = 1; consolidation <= 3; consolidation++) {
    for (let pole = 2; pole <= 5; pole++) {
      const poleStart = n - consolidation - pole;
      if (poleStart < 0) continue;
      const poleStartClose = bars[poleStart].close;
      const poleEndClose = bars[poleStart + pole].close;
      const gain = (poleEndClose - poleStartClose) / poleStartClose;
      if (gain < 0.08) continue;
      const poleHigh = Math.max(...bars.slice(poleStart, poleStart + pole + 1).map((b) => b.high));
      const consolBars = bars.slice(poleStart + pole + 1, n + 1);
      if (consolBars.length !== consolidation) continue;
      const consolCloses = consolBars.map((b) => b.close);
      const band = (Math.max(...consolCloses) - Math.min(...consolCloses)) / Math.min(...consolCloses);
      const insideRange = consolBars.every((b) => b.high <= poleHigh * 1.01);
      if (band <= 0.03 && insideRange) return { setup: "bull_flag", level: poleHigh };
    }
  }
  return null;
}

// Opening-range breakout: the 9:15-9:30 IST range, then the first completed 5m bar to CLOSE above
// it. Long side only, matching the rest of the pipeline.
function istDate(unixSeconds) {
  return new Date(unixSeconds * 1000 + 5.5 * 3600e3).toISOString().slice(0, 10);
}

export function detectOrb(bars) {
  if (!bars.length) return null;
  const today = istDate(bars.at(-1).time);
  const session = bars.filter((b) => istDate(b.time) === today);
  if (session.length < 4) return null;
  const or = session.slice(0, 3); // 9:15, 9:20, 9:25 bars cover the first 15 minutes
  if (or.length < 3) return null;
  const orHigh = Math.max(...or.map((b) => b.high));
  const orLow = Math.min(...or.map((b) => b.low));
  for (const b of session.slice(3)) {
    if (b.close > orHigh) return { setup: "orb_breakout", level: orHigh, orHigh, orLow, at: b.time, price: b.close };
  }
  return null;
}

async function scanDaily(universe) {
  const members = await nifty500List(universe);
  const rows = await mapLimit(members, 6, async (m) => {
    try {
      const { candles } = await getCandles(toSymbol(m.ticker), "1D", 60);
      const hits = detectDaily(candles);
      if (!hits.length) return [];
      const close = candles.at(-1).close;
      return hits.map((h) => ({ ticker: m.ticker, name: m.name, symbol: toSymbol(m.ticker), close, ...h }));
    } catch {
      return [];
    }
  });
  return rows.flat();
}

async function scanOrb(universe) {
  if (!marketOpen()) return [];
  const members = await nifty500List(universe);
  const rows = await mapLimit(members, 6, async (m) => {
    try {
      const { candles } = await getCandles(toSymbol(m.ticker), "5m", 100);
      const hit = detectOrb(candles);
      if (!hit) return null;
      return { ticker: m.ticker, name: m.name, symbol: toSymbol(m.ticker), ...hit };
    } catch {
      return null;
    }
  });
  return rows.filter(Boolean);
}

export async function run(universe = watchlist.universe || "nifty500") {
  if (OFFLINE) return watchlist;
  const [daily, orb] = await Promise.all([scanDaily(universe), scanOrb(universe)]);
  watchlist = { daily, orb, universe, updatedAt: new Date().toISOString() };
  save();
  return watchlist;
}

// Its own independent timer, same shape as alerts.js/gtt.js: a self-rescheduling setTimeout and a
// single-flight guard, so a slow scan can't overlap the next tick.
let timer = null;
let running = null;
function tick() {
  running ||= run().catch(() => {}).finally(() => (running = null));
  return running;
}
export function start(intervalMs = 5 * 60e3) {
  if (timer) return;
  const loop = () => tick().finally(() => (timer = setTimeout(loop, intervalMs)));
  timer = setTimeout(loop, 3000);
}
export function stop() {
  clearTimeout(timer);
  timer = null;
}
