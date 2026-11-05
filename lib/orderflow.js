// Records live quotes to data/orderflow/<day>/<name>.jsonl during market hours, one line per changed
// quote, so order flow can be worked out later. Kotak has no past quotes: no recording, no data.
// Needs a Kotak login in the app that day. Raw snapshots are kept so the estimate can be improved.
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./store.js";
import * as brokers from "./brokers.js";
import * as store from "./store.js";
import { marketOpen } from "./gtt.js";
import { addTrade, TF_MS, STOCK_STEPS } from "../public/lib/footprint.js";

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
export function trades(rows, state = { prev: null, side: 0 }) {
  const list = [];
  let unknown = 0;
  for (const r of rows) {
    const prev = state.prev;
    if (prev) {
      const dv = r.v - prev.v;
      if (dv > 0) {
        const ask = prev.a?.[0]?.[0], bid = prev.b?.[0]?.[0];
        if (ask > 0 && r.p >= ask) state.side = 1;
        else if (bid > 0 && r.p <= bid) state.side = -1;
        else if (r.p !== prev.p) state.side = r.p > prev.p ? 1 : -1;
        if (!state.side || r.t - prev.t > GAP_MS) unknown += dv;
        else list.push({ t: r.t, price: r.p, qty: dv, isSell: state.side < 0 });
      }
    }
    state.prev = r;
  }
  return { list, unknown };
}

export function flow(rows) {
  const minutes = new Map();
  const { list, unknown } = trades(rows);
  let cvd = 0;
  for (const { t, price, qty, isSell } of list) {
    const at = Math.floor(t / 60000) * 60000;
    if (!minutes.has(at)) minutes.set(at, { at, buy: 0, sell: 0, prices: {} });
    const m = minutes.get(at);
    const key = isSell ? "sell" : "buy";
    m[key] += qty;
    const cell = (m.prices[price] ||= { buy: 0, sell: 0 });
    cell[key] += qty;
    cvd += isSell ? -qty : qty;
    m.delta = m.buy - m.sell;
    m.cvd = cvd;
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

// ---------- any stock, on demand ----------
// An index has no volume, so it means its nearest future. Anything else is an NSE stock name.
const INDEX = {
  "^NSEI": { name: "NIFTY", seg: "nse_fo", future: "NIFTY" },
  "^NSEBANK": { name: "BANKNIFTY", seg: "nse_fo", future: "BANKNIFTY" },
  "^BSESN": { name: "SENSEX", seg: "bse_fo", future: "SENSEX" },
};
for (const w of Object.values({ ...INDEX })) INDEX[w.name] = w;

// "YAHOO:RELIANCE.NS", "RELIANCE" or "^NSEI" -> what to record. Null for what can't be recorded.
export function instrumentOf(input) {
  const s = String(input || "").trim().toUpperCase().replace(/^YAHOO:/, "").replace(/\.(NS|BO)$/, "");
  if (INDEX[s]) return INDEX[s];
  return /^[A-Z0-9&-]{1,30}$/.test(s) ? { name: s, seg: "nse_cm", stock: s } : null;
}

// Stocks opened today, on top of the fixed list. It resets each day so one look isn't recorded for ever.
const MAX_RECORDED = 30;
const today = (t = Date.now()) => istDay(t);
const extras = () => {
  const saved = store.read("orderflow-watch", null);
  return saved?.day === today() ? saved.list : [];
};
const watchList = () => {
  const out = [...WATCH];
  for (const w of extras()) if (!out.some((x) => x.name === w.name)) out.push(w);
  return out;
};

const keyFor = async (w) => `${w.seg}|${w.future ? await brokers.kotakNearFuture(w.seg, w.future) : await brokers.kotakCode(w.seg, w.stock)}`;

// Starts recording an instrument. Throws if Kotak doesn't know it or the list is full.
export async function watch(w) {
  const list = watchList();
  if (list.some((x) => x.name === w.name)) return;
  if (list.length >= MAX_RECORDED) throw new Error(`Order flow already records ${MAX_RECORDED} instruments today, so ${w.name} isn't being recorded.`);
  await keyFor(w);
  store.write("orderflow-watch", { day: today(), list: [...extras(), w] });
}

export function names() {
  const dir = path.join(DATA_DIR, "orderflow");
  const found = new Set(watchList().map((w) => w.name));
  if (fs.existsSync(dir))
    for (const day of fs.readdirSync(dir).filter((d) => /^\d{4}-\d\d-\d\d$/.test(d)).slice(-7))
      for (const f of fs.readdirSync(path.join(dir, day))) found.add(f.replace(/\.jsonl$/, ""));
  return [...found].sort();
}

// A day's file read once, then only what's been added, so a screen refreshing every few seconds stays cheap.
const fileCache = new Map();
function dayTrades(name, day) {
  const file = path.join(DATA_DIR, "orderflow", day, `${name}.jsonl`);
  const c = fileCache.get(file) || { offset: 0, state: { prev: null, side: 0 }, list: [] };
  fileCache.set(file, c);
  const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  if (size <= c.offset) return c.list;
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(size - c.offset);
  fs.readSync(fd, buf, 0, buf.length, c.offset);
  fs.closeSync(fd);
  const end = buf.lastIndexOf(10); // a half-written last line waits for the next read
  if (end < 0) return c.list;
  c.offset += end + 1;
  const rows = buf.toString("utf8", 0, end).split("\n").flatMap((l) => {
    try {
      return l ? [JSON.parse(l)] : [];
    } catch {
      return [];
    }
  });
  c.list.push(...trades(rows, c.state).list);
  return c.list;
}

// Footprint bars from up to 7 recorded days. With no step, one is chosen from the price.
export function bars(name, tf, step) {
  const tfMs = TF_MS[tf];
  const dir = path.join(DATA_DIR, "orderflow");
  const days = fs.existsSync(dir) ? fs.readdirSync(dir).filter((d) => /^\d{4}-\d\d-\d\d$/.test(d)).sort().slice(-7) : [];
  const all = days.flatMap((d) => dayTrades(name, d));
  const size = step || STOCK_STEPS.find((v) => v >= (all.at(-1)?.price || 0) * 0.001) || STOCK_STEPS.at(-1);
  if (!tfMs || !STOCK_STEPS.includes(size)) return null;
  const out = new Map();
  for (const t of all) addTrade(out, t.t, t.price, t.qty, t.isSell, tfMs, size);
  return { symbol: name, step: size, bars: [...out.values()] };
}

const keyOf = new Map(), keyFailed = new Map();
let keysDay = null;
const last = new Map();

// One round of quotes; returns how many lines were written.
export async function pollOnce(now = Date.now()) {
  const day = istDay(now);
  if (keysDay !== day) {
    keyOf.clear();
    keyFailed.clear();
    keysDay = day;
    last.clear();
  }
  for (const w of watchList()) {
    if (keyOf.has(w.name) || now - (keyFailed.get(w.name) || 0) < 60000) continue;
    try {
      keyOf.set(w.name, await keyFor(w));
    } catch (e) {
      keyFailed.set(w.name, now);
      console.error(`[orderflow] ${new Date(now).toISOString()} ${w.name}: ${e.message}`);
    }
  }
  const keys = [...keyOf].map(([name, key]) => ({ name, key }));
  if (!keys.length) return 0;
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
