// Time-based forced exit: GTT/OCO (lib/gtt.js) only triggers on price, with no "flat by time T
// regardless of price" leg, so this is a separate, independent watcher — same timer shape as
// alerts.js/gtt.js — that closes a named position at its cutoff by calling the broker's own
// existing exit functions (lib/brokers.js), never new order-placement code.

import * as brokers from "./brokers.js";
import * as store from "./store.js";
import { isTradingDay } from "./market-hours.js";

let items = store.read("squareoff", []); // { id, account, symbol, product, flatBy: "HH:MM", active, result? }
const save = () => store.write("squareoff", items);

export const list = () => items;

export function add({ account, symbol, product, flatBy }) {
  if (!account || !symbol || !product) throw bad("Need account, symbol and product.");
  if (!/^\d{1,2}:\d{2}$/.test(flatBy || "")) throw bad('flatBy must be "HH:MM" (IST).');
  const item = { id: crypto.randomUUID(), account, symbol, product: String(product).toUpperCase(), flatBy, active: true };
  items.push(item);
  save();
  return item;
}

export function remove(id) {
  items = items.filter((i) => i.id !== id);
  save();
}

function bad(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function istMinutesNow() {
  const ist = new Date(Date.now() + 5.5 * 3600e3);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}
const toMins = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

async function squareOff(item) {
  const { side, room, qty } = await brokers.stockPosition(item.account, item.symbol, item.product);
  if (!side || !room) {
    item.active = false;
    item.result = "No open position left to square off.";
    return;
  }
  try {
    await brokers.placeStockExit(item.account, { symbol: item.symbol, product: item.product, side, qty: room, type: "MARKET" });
    item.result = `Squared off ${room} ${side === "SELL" ? "sold" : "bought"} at ${item.flatBy} IST.`;
  } catch (e) {
    item.result = `Square-off failed: ${e.message}`;
  } finally {
    item.active = false;
  }
}

let running = null;
async function evaluateOnce() {
  if (!isTradingDay()) return;
  const now = istMinutesNow();
  const due = items.filter((i) => i.active && now >= toMins(i.flatBy));
  for (const item of due) await squareOff(item).catch((e) => (item.result = e.message));
  if (due.length) save();
}
function evaluate() {
  running ||= evaluateOnce().finally(() => (running = null));
  return running;
}

let timer = null;
export function start(intervalMs = 60e3) {
  if (timer) return;
  const tick = () => evaluate().catch(() => {}).finally(() => (timer = setTimeout(tick, intervalMs)));
  timer = setTimeout(tick, 5000);
}
export function stop() {
  clearTimeout(timer);
  timer = null;
}
