// Records live quotes to data/orderflow/<day>/<name>.jsonl during market hours, one line per changed
// quote, so order flow can be worked out later. Kotak has no past quotes: no recording, no data.
// Needs a Kotak login in the app that day. Raw snapshots are kept so the estimate can be improved.
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./store.js";
import * as brokers from "./brokers.js";
import { marketOpen } from "./gtt.js";

// An index has no traded volume, so "NIFTY" means its nearest future.
export const WATCH = [
  { name: "NIFTY", seg: "nse_fo", future: "NIFTY" },
  // The Nifty's seven largest weights as of 29 Oct 2026. Weights drift, so review this now and then.
  ...["HDFCBANK", "ICICIBANK", "RELIANCE", "BHARTIARTL", "LT", "SBIN", "INFY"].map((stock) => ({ name: stock, seg: "nse_cm", stock })),
];
const GAP_MS = 15000; // volume across a longer silence can't be given a side
const istDay = (t) => new Date(t + 5.5 * 3600e3).toISOString().slice(0, 10);
const levels = (list = []) => list.map((l) => [+l.price, +l.quantity, +l.orders]);

export function toRow(q, t) {
  return {
    t,
    ex: +q.lstup_time,
    p: +q.ltp,
    q: +q.last_traded_quantity,
    v: +q.last_volume,
    tb: +q.total_buy,
    ts: +q.total_sell,
    oi: +q.open_int,
    b: levels(q.depth?.buy),
    a: levels(q.depth?.sell),
  };
}

// shortcut: snapshots about a second apart merge trades and put them all at the last price, so this
// is an estimate; a tick-by-tick feed would be needed for true bid/ask volume.
// Added volume is a buy at or above the previous best ask, a sell at or below the previous best bid,
// otherwise it follows the price move, and on no move keeps the last side.
export function flow(rows) {
  const minutes = new Map();
  let prev = null, side = 0, cvd = 0, unknown = 0;
  for (const r of rows) {
    if (prev) {
      const dv = r.v - prev.v;
      if (dv > 0) {
        const ask = prev.a?.[0]?.[0], bid = prev.b?.[0]?.[0];
        if (ask > 0 && r.p >= ask) side = 1;
        else if (bid > 0 && r.p <= bid) side = -1;
        else if (r.p !== prev.p) side = r.p > prev.p ? 1 : -1;
        if (!side || r.t - prev.t > GAP_MS) unknown += dv;
        else {
          const at = Math.floor(r.t / 60000) * 60000;
          if (!minutes.has(at)) minutes.set(at, { at, buy: 0, sell: 0, prices: {} });
          const m = minutes.get(at);
          const key = side > 0 ? "buy" : "sell";
          m[key] += dv;
          const cell = (m.prices[r.p] ||= { buy: 0, sell: 0 });
          cell[key] += dv;
          cvd += side * dv;
          m.delta = m.buy - m.sell;
          m.cvd = cvd;
        }
      }
    }
    prev = r;
  }
  return { minutes: [...minutes.values()], unknown };
}

export function read(name, day) {
  const file = path.join(DATA_DIR, "orderflow", day, `${name}.jsonl`);
  if (!fs.existsSync(file)) return [];
  // A power cut can leave half a last line; everything before it is still good.
  return fs.readFileSync(file, "utf8").split("\n").flatMap((l) => {
    try {
      return l ? [JSON.parse(l)] : [];
    } catch {
      return [];
    }
  });
}

let keys = null, keysDay = null;
const last = new Map();

// One round of quotes; returns how many lines were written.
export async function pollOnce(now = Date.now()) {
  const day = istDay(now);
  if (keysDay !== day) {
    keys = await Promise.all(
      WATCH.map(async (w) => ({
        name: w.name,
        key: `${w.seg}|${w.future ? await brokers.kotakNearFuture(w.seg, w.future) : await brokers.kotakCode(w.seg, w.stock)}`,
      })),
    );
    keysDay = day;
    last.clear();
  }
  const quotes = await brokers.kotakQuotes(keys.map((k) => k.key));
  const dir = path.join(DATA_DIR, "orderflow", day);
  fs.mkdirSync(dir, { recursive: true });
  let wrote = 0;
  for (const k of keys) {
    const q = quotes.find((x) => `${x.exchange}|${x.exchange_token}` === k.key);
    if (!q) continue;
    const row = toRow(q, now);
    const same = JSON.stringify({ ...row, t: 0 });
    if (last.get(k.name) === same) continue;
    last.set(k.name, same);
    fs.appendFileSync(path.join(dir, `${k.name}.jsonl`), JSON.stringify(row) + "\n");
    wrote++;
  }
  return wrote;
}

export function start() {
  let failing = false;
  const tick = async () => {
    let wait = 30000;
    if (marketOpen() && brokers.kotakReady()) {
      wait = 1000;
      try {
        await pollOnce();
        if (failing) console.error(`[orderflow] ${new Date().toISOString()} recording again`);
        failing = false;
      } catch (e) {
        if (!failing) console.error(`[orderflow] ${new Date().toISOString()} ${e.message}`);
        failing = true;
        wait = 5000;
      }
    }
    setTimeout(tick, wait);
  };
  setTimeout(tick, 3000);
}
