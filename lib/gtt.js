// GTT orders kept inside Quant Terminal (good-till-triggered): nothing is sent to the broker until
// a trigger is hit. The server watches prices every few seconds during market hours, moves
// trailing stops, and when a trigger is crossed it places the order with the chosen broker
// account, alerts you, and records what happened. The app must be running for this to work.
//
// A GTT:
//   { account: "zerodha-1", symbol: "YAHOO:RBLBANK.NS", side: "SELL", qty: 10, product: "CNC",
//     kind: "single" | "oco",
//     legs: [{ name: "stoploss" | "target" | "trigger", trigger: 465.5, orderType: "LIMIT" | "MARKET",
//              price: 465, trail: { type: "pct" | "pts", value: 2 } | null }] }
//
// A leg fires when the price crosses its trigger: a stop-loss when it falls to it (rises, for a
// buy), a target when it rises to it (falls, for a buy), a single trigger in whichever direction
// it was set from the price at the time. A trailing stop follows the best price since the GTT was
// made (highest for a sell, lowest for a buy) by the trail amount, and never moves back.
// OCO: whichever leg fires first places its order and the other is cancelled.

import crypto from "node:crypto";
import * as store from "./store.js";

const DAY = 86400e3;
const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const log = (msg) => console.error(`[gtt] ${new Date().toISOString()} ${msg}`);

let gtts = store.read("gtt", []);
const save = () => store.write("gtt", gtts);

// Wired up by the server (and by tests): price quotes, order placement, login state, alerts.
let deps = {
  quotes: async () => ({}),
  place: async () => {
    throw new Error("No broker connected");
  },
  connected: () => false,
  accountName: (id) => id,
  brokerOf: () => "",
  notify: () => {},
  now: () => Date.now(),
};
export function configure(d) {
  deps = { ...deps, ...d };
}

export const list = () => gtts;
const round = (v) => Math.round(v * 100) / 100;
const fmt = (v) => `₹${round(v).toLocaleString("en-IN")}`;

// NSE trades 09:15 to 15:30 IST, Monday to Friday (exchange holidays aren't known here).
export function marketOpen(t = deps.now()) {
  const ist = new Date(t + 5.5 * 3600e3);
  const day = ist.getUTCDay(), mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return day >= 1 && day <= 5 && mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
}

// Which way the price has to move to set a leg off.
function directionOf(g, leg) {
  if (leg.name === "stoploss") return g.side === "SELL" ? "below" : "above";
  if (leg.name === "target") return g.side === "SELL" ? "above" : "below";
  return leg.direction;
}

export function describe(g) {
  const name = deps.accountName(g.account);
  const legs = g.legs
    .map((l) => `${l.name} ${fmt(l.trigger)}${l.trail ? ` (trailing ${l.trail.type === "pct" ? `${l.trail.value}%` : fmt(l.trail.value)})` : ""}`)
    .join(", ");
  return `${g.side} ${g.qty} ${g.symbol.replace(/^YAHOO:|\.NS$/g, "")} on ${name}: ${legs}`;
}

// Checks a new GTT against the current price, so a stop isn't set on the wrong side of it.
export function add(input, ltp) {
  if (!input || typeof input !== "object") throw bad("Send the GTT as a JSON object.");
  const side = String(input.side || "").toUpperCase();
  const product = String(input.product || "CNC").toUpperCase();
  const qty = Number(input.qty);
  const kind = input.kind === "oco" ? "oco" : "single";
  if (!input.account) throw bad("Choose a broker account.");
  if (!/^YAHOO:[A-Z0-9&\-]+\.NS$/i.test(String(input.symbol || ""))) throw bad("GTT orders are for NSE stocks (symbols ending in .NS).");
  if (!["BUY", "SELL"].includes(side)) throw bad("Side must be BUY or SELL.");
  if (!["CNC", "MIS"].includes(product)) throw bad("Product must be CNC (longterm) or MIS (intraday).");
  if (!Number.isInteger(qty) || qty < 1) throw bad("Quantity must be a whole number of shares, 1 or more.");
  if (!(ltp > 0)) throw bad("Couldn't get the current price to check the triggers. Try again in a moment.");
  const rawLegs = Array.isArray(input.legs) ? input.legs : [];
  const want = kind === "oco" ? ["stoploss", "target"] : null;
  if (kind === "oco" && (rawLegs.length !== 2 || !want.every((n) => rawLegs.some((l) => l.name === n))))
    throw bad("An OCO needs a stop-loss leg and a target leg.");
  if (kind === "single" && rawLegs.length !== 1) throw bad("A single-trigger GTT has one leg.");
  const legs = rawLegs.map((l) => {
    const trigger = Number(l.trigger);
    const orderType = String(l.orderType || "LIMIT").toUpperCase();
    const price = l.price === "" || l.price == null ? null : Number(l.price);
    if (!(trigger > 0)) throw bad("Every leg needs a trigger price.");
    if (!["LIMIT", "MARKET"].includes(orderType)) throw bad("Each leg's order is Limit or Market.");
    if (orderType === "LIMIT" && !(price > 0)) throw bad(`Enter the limit price for the ${l.name || "trigger"} order.`);
    let trail = null;
    if (l.trail && Number(l.trail.value) > 0) {
      // Only a stop can trail: an OCO's stop-loss leg, or a single trigger that is a stop (a sell
      // below the price, or a buy above it).
      const isStop = kind === "oco" ? l.name === "stoploss" : side === "SELL" ? Number(l.trigger) < ltp : Number(l.trigger) > ltp;
      if (!isStop)
        throw bad(kind === "oco" ? "Only the stop-loss leg of an OCO can trail." : "A trailing trigger must be a stop: below the price for a sell, above it for a buy.");
      const type = l.trail.type === "pts" ? "pts" : "pct";
      const value = Number(l.trail.value);
      if (type === "pct" && value >= 50) throw bad("A trailing percentage must be under 50%.");
      trail = { type, value, best: ltp };
    }
    const leg = {
      name: kind === "oco" ? l.name : "trigger",
      trigger: round(trigger),
      orderType,
      price: price ? round(price) : null,
      // A limit order keeps its distance from the trigger as a trailing stop moves.
      offset: price ? round(price - trigger) : 0,
      trail,
    };
    if (kind === "single") leg.direction = trigger < ltp ? "below" : "above";
    return leg;
  });
  const g0 = { side };
  for (const leg of legs) {
    const dir = kind === "single" ? leg.direction : directionOf(g0, leg);
    if (dir === "below" && !(leg.trigger < ltp)) throw bad(`The ${leg.name} trigger (${fmt(leg.trigger)}) must be below the current price (${fmt(ltp)}).`);
    if (dir === "above" && !(leg.trigger > ltp)) throw bad(`The ${leg.name} trigger (${fmt(leg.trigger)}) must be above the current price (${fmt(ltp)}).`);
  }
  const now = deps.now();
  const g = {
    id: crypto.randomUUID(),
    account: String(input.account),
    symbol: String(input.symbol).toUpperCase().replace(/^YAHOO:/, "YAHOO:"),
    side,
    qty,
    product,
    kind,
    legs,
    status: "active",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 365 * DAY).toISOString(),
    ltpAtCreate: ltp,
    lastPrice: ltp,
    history: [{ at: new Date(now).toISOString(), text: `Created at ${fmt(ltp)}` }],
  };
  gtts.unshift(g);
  save();
  log(`created ${g.id}: ${describe(g)}`);
  return g;
}

export function cancel(id) {
  const g = gtts.find((x) => x.id === id);
  if (!g) throw bad("No such GTT.", 404);
  if (g.status === "placing") throw bad("This GTT is placing its order right now.", 409);
  if (["active", "needs-login"].includes(g.status)) {
    g.status = "cancelled";
    g.history.push({ at: new Date(deps.now()).toISOString(), text: "Cancelled" });
  }
  save();
  return g;
}

// Removes finished GTTs (triggered, cancelled, failed, expired) from the list.
export function remove(id) {
  const g = gtts.find((x) => x.id === id);
  if (!g) throw bad("No such GTT.", 404);
  if (["active", "needs-login", "placing"].includes(g.status)) throw bad("Cancel the GTT before removing it.", 409);
  gtts = gtts.filter((x) => x.id !== id);
  save();
}

// Moves a trailing stop with the best price seen; it only ever tightens.
export function trail(g, leg, price) {
  const t = leg.trail;
  if (!t) return false;
  const sell = g.side === "SELL";
  t.best = sell ? Math.max(t.best, price) : Math.min(t.best, price);
  const target = t.type === "pct" ? (sell ? t.best * (1 - t.value / 100) : t.best * (1 + t.value / 100)) : sell ? t.best - t.value : t.best + t.value;
  const next = round(target);
  if (sell ? next > leg.trigger : next < leg.trigger) {
    leg.trigger = next;
    if (leg.price) leg.price = round(next + leg.offset);
    return true;
  }
  return false;
}

const crossed = (dir, price, trigger) => (dir === "below" ? price <= trigger : price >= trigger);

async function fire(g, leg, price) {
  const name = deps.accountName(g.account);
  const at = () => new Date(deps.now()).toISOString();
  if (!deps.connected(g.account)) {
    if (g.status !== "needs-login") {
      g.status = "needs-login";
      g.history.push({ at: at(), text: `${leg.name} triggered at ${fmt(price)}, but ${name} isn't logged in. It will place as soon as you log in (if the price is still past the trigger).` });
      deps.notify({ kind: "gtt", gttId: g.id, text: `GTT ${leg.name} hit for ${describe(g)} at ${fmt(price)}, but ${name} isn't logged in. Log in from the Broker tab to place it.` });
      log(`${g.id} needs login (${name})`);
    }
    return;
  }
  // Saved before anything is sent, so the order can never go out twice.
  g.status = "placing";
  g.firedLeg = leg.name;
  save();
  let orderType = leg.orderType, limit = leg.price;
  // ICICI's API takes no market orders: a 1% limit buffer does the same job.
  if (orderType === "MARKET" && deps.brokerOf(g.account) === "icici") {
    orderType = "LIMIT";
    limit = round(g.side === "SELL" ? price * 0.99 : price * 1.01);
  }
  const body = { symbol: g.symbol, side: g.side, qty: g.qty, type: orderType, price: orderType === "LIMIT" ? limit : undefined, product: g.product };
  try {
    const r = await deps.place(g.account, body, price);
    g.status = "triggered";
    g.result = { leg: leg.name, orderId: r.orderId, price, at: at(), ok: true };
    g.history.push({ at: at(), text: `${leg.name} triggered at ${fmt(price)}: ${g.side} ${g.qty} ${orderType}${orderType === "LIMIT" ? ` @ ${fmt(limit)}` : ""} sent to ${name}, order ${r.orderId}${g.kind === "oco" ? `. The ${leg.name === "stoploss" ? "target" : "stop-loss"} is cancelled.` : ""}` });
    deps.notify({ kind: "gtt", gttId: g.id, text: `GTT ${leg.name} triggered at ${fmt(price)}: ${g.side} ${g.qty} ${g.symbol.replace(/^YAHOO:|\.NS$/g, "")} sent to ${name} (order ${r.orderId}). Check its status in the Broker tab.` });
    log(`${g.id} fired ${leg.name} at ${price}: order ${r.orderId}`);
  } catch (e) {
    if (e.status === 401) {
      g.status = "needs-login";
      g.history.push({ at: at(), text: `${leg.name} triggered at ${fmt(price)}, but the ${name} session had ended: ${e.message}` });
      deps.notify({ kind: "gtt", gttId: g.id, text: `GTT ${leg.name} hit for ${describe(g)}, but the ${name} session has ended. Log in to place it.` });
    } else {
      // Not retried: the broker refused it (funds, limits, IP...), and a retry could double up.
      g.status = "failed";
      g.result = { leg: leg.name, price, at: at(), ok: false, error: e.message };
      g.history.push({ at: at(), text: `${leg.name} triggered at ${fmt(price)}, but the order was refused: ${e.message}` });
      deps.notify({ kind: "gtt", gttId: g.id, text: `GTT ${leg.name} triggered for ${describe(g)} but the order was refused: ${e.message}` });
    }
    log(`${g.id} ${leg.name} order failed: ${e.message}`);
  }
  save();
}

// One pass over every live GTT. Exported for tests and a manual "check now".
let running = null;
export function evaluate() {
  running ||= evaluateOnce().finally(() => (running = null));
  return running;
}

async function evaluateOnce() {
  const now = deps.now();
  let changed = false;
  for (const g of gtts)
    if (["active", "needs-login"].includes(g.status) && Date.parse(g.expiresAt) < now) {
      g.status = "expired";
      g.history.push({ at: new Date(now).toISOString(), text: "Expired" });
      changed = true;
    }
  const live = gtts.filter((g) => ["active", "needs-login"].includes(g.status));
  if (!live.length) {
    if (changed) save();
    return;
  }
  const quotes = await deps.quotes([...new Set(live.map((g) => g.symbol))]).catch(() => ({}));
  for (const g of live) {
    const price = quotes[g.symbol]?.price;
    if (!(price > 0)) continue;
    g.lastPrice = price;
    g.lastCheckedAt = new Date(now).toISOString();
    changed = true;
    for (const leg of g.legs)
      if (trail(g, leg, price)) {
        g.history.push({ at: new Date(now).toISOString(), text: `Trailing ${leg.name} moved to ${fmt(leg.trigger)} (best ${fmt(leg.trail.best)})` });
        log(`${g.id} trailing ${leg.name} -> ${leg.trigger}`);
      }
    const hit = g.legs.find((leg) => crossed(g.kind === "single" ? leg.direction : directionOf(g, leg), price, leg.trigger));
    if (hit) await fire(g, hit, price);
  }
  if (changed) save();
}

// The watcher: every few seconds in market hours, every minute outside them (to expire old GTTs).
let timer = null;
export function start({ openMs = 5000, closedMs = 60000 } = {}) {
  if (timer) return;
  const tick = () =>
    (marketOpen() ? evaluate() : Promise.resolve())
      .catch((e) => log(`check failed: ${e.message}`))
      .finally(() => {
        timer = setTimeout(tick, marketOpen() ? openMs : closedMs);
      });
  timer = setTimeout(tick, 3000);
}

export function stop() {
  clearTimeout(timer);
  timer = null;
}

// For tests: replace the stored list.
export function _reset(list = []) {
  gtts = list;
}
