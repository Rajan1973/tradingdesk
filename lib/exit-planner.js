// Exit Planner: fixes a stop and target before entry, long side only. Pure calculation — it never
// places an order or touches a position. The computed stop/target are meant to pre-fill the
// existing OCO ticket in the Broker tab (public/js/broker.js's openExit) and lib/gtt.js's "oco" leg
// pair; this module doesn't call either of them.

import { getCandles } from "./providers.js";
import { compute } from "../public/lib/indicators.js";

const round2 = (n) => Math.round(n * 100) / 100;

// stopRule: "or-mid" | "or-low" | { pct: X } | { atr: K } | { price: X }  (needs orHigh/orLow for or-*)
// targetRule: { r: X } (default 2) | { price: X }
export async function plan({ symbol, entry, stopRule = "or-mid", targetRule = { r: 2 }, orHigh, orLow, bars }) {
  if (!(entry > 0)) throw badPlan("Need a positive entry price.");

  let stop;
  if (stopRule === "or-mid" || stopRule === "or-low") {
    if (!(orHigh > orLow)) throw badPlan("or-mid/or-low needs the opening range (orHigh > orLow).");
    stop = stopRule === "or-mid" ? (orHigh + orLow) / 2 : orLow;
  } else if (stopRule && stopRule.pct != null) {
    stop = entry * (1 - stopRule.pct / 100);
  } else if (stopRule && stopRule.atr != null) {
    const candles = bars || (await getCandles(symbol, "1D", 60)).candles;
    const atr = compute("atr", candles, { length: 14 }).value;
    const last = atr.filter((v) => v != null).at(-1);
    if (!last) throw badPlan("Not enough bars to compute ATR.");
    stop = entry - stopRule.atr * last;
  } else if (stopRule && stopRule.price != null) {
    stop = Number(stopRule.price);
  } else {
    throw badPlan('Unknown stop rule. Use "or-mid", "or-low", { pct }, { atr } or { price }.');
  }
  stop = Math.floor(stop * 100) / 100; // round down (away from entry) to the cent

  if (stop >= entry) throw badPlan("The stop is at or above the entry.");
  const risk = round2(entry - stop);
  if (risk / entry < 0.0005) throw badPlan("The stop is too tight to survive the spread (under 0.05% of price).");

  let target;
  if (targetRule && targetRule.price != null) target = Number(targetRule.price);
  else target = entry + (targetRule?.r ?? 2) * risk;
  target = Math.round(target * 100) / 100;
  if (target <= entry) throw badPlan("The target is at or below the entry.");

  return {
    symbol,
    entry,
    stop,
    stopRule,
    target,
    targetRule,
    riskPerShare: risk,
    rewardRisk: round2((target - entry) / risk),
    flatBy: "15:15",
  };
}

function badPlan(message) {
  return Object.assign(new Error(message), { status: 400 });
}
