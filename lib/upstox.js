// Upstox as a read-only market data source: chart history, live prices, and a recording of the order
// flow instruments beside Kotak's so the two can be compared. It can't place orders. The token is
// Upstox's free 1-year read-only "Analytics Token", kept in data/upstox.json and sent only to Upstox.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import * as store from "./store.js";
import { marketOpen } from "./gtt.js";
import { WATCH } from "./orderflow.js";
import { foKeyOf, isFoSymbol } from "./brokers.js";
import { parseTf } from "../public/lib/series.js";

const API = "https://api.upstox.com";
const FILES = "https://assets.upstox.com/market-quote/instruments/exchange";
const FEED_PATH = "/v3/feed/market-data-feed/authorize";
const INDEX = { "^NSEI": "NSE_INDEX|Nifty 50", "^NSEBANK": "NSE_INDEX|Nifty Bank", "^BSESN": "BSE_INDEX|SENSEX" };
const istDay = (t = Date.now()) => new Date(t + 5.5 * 3600e3).toISOString().slice(0, 10);
const savedToken = () => store.read("upstox", {}).token || "";

async function get(url, token = savedToken()) {
  let res;
  try {
    res = await fetch(API + url, { headers: { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(15000) });
  } catch (e) {
    throw new Error(`Upstox couldn't be reached (${e.cause?.code || e.message}).`);
  }
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error("Upstox refused the token: generate a new one on its Developer Apps page.");
  if (!res.ok || body.status !== "success") throw new Error(`Upstox: ${body.errors?.[0]?.message || `HTTP ${res.status}`}`);
  return body.data;
}

// ---------- instruments ----------
// Upstox names everything by its own key (RELIANCE = NSE_EQ|INE002A01018), listed in a daily file.
export function buildInstruments(rows, day, now = Date.now()) {
  const out = { day, NS: {}, BO: {}, fut: {} };
  const soonest = {};
  for (const x of rows) {
    if (x.segment === "NSE_EQ" && /^(EQ|BE|BZ|SM|ST)$/.test(x.instrument_type)) out.NS[x.trading_symbol] = x.instrument_key;
    else if (x.segment === "BSE_EQ") out.BO[x.trading_symbol] = x.instrument_key;
    else if (x.segment === "NSE_FO" && x.instrument_type === "FUT" && x.expiry > now && !(soonest[x.underlying_symbol] < x.expiry)) {
      soonest[x.underlying_symbol] = x.expiry;
      out.fut[x.underlying_symbol] = x.instrument_key;
    }
  }
  return out;
}

async function downloadRows(name) {
  const res = await fetch(`${FILES}/${name}.json.gz`, { signal: AbortSignal.timeout(90000) });
  if (!res.ok) throw new Error(`Upstox's ${name} instrument list returned HTTP ${res.status}.`);
  return JSON.parse(zlib.gunzipSync(Buffer.from(await res.arrayBuffer())).toString("utf8"));
}

let list = null, loading = null;
async function instruments() {
  const day = istDay();
  if (list?.day === day) return list;
  const saved = store.read("upstox-instruments", null);
  if (saved?.day === day) return (list = saved);
  loading ||= Promise.all([downloadRows("NSE"), downloadRows("BSE")])
    .then(([nse, bse]) => {
      list = buildInstruments(nse.concat(bse), day);
      store.write("upstox-instruments", list);
      return list;
    })
    .catch((e) => {
      if (!saved) throw e;
      return saved; // yesterday's keys beat none; stocks keep theirs, a future may have rolled
    })
    .finally(() => (loading = null));
  return loading;
}

async function keyOf(symbol) {
  // Upstox and Kotak share the exchange's number for a contract.
  if (isFoSymbol(symbol)) return (await foKeyOf(symbol)).replace(/^nse_fo/, "NSE_FO").replace(/^bse_fo/, "BSE_FO");
  const t = /^YAHOO:(.+)$/.exec(symbol || "")?.[1];
  if (!t) return null;
  if (INDEX[t]) return INDEX[t];
  const m = /^(.+)\.(NS|BO)$/.exec(t);
  return m ? (await instruments())[m[2]][m[1]] || null : null;
}

// ---------- history ----------
// Timeframes Upstox makes itself. Anything else (seconds, 2D) stays with Yahoo.
export function intervalOf(tf) {
  const { n, unit } = parseTf(tf);
  if (unit === "m" && n <= 300) return ["minutes", n];
  if (unit === "h" && n <= 5) return ["hours", n];
  const long = { D: "days", W: "weeks", M: "months" }[unit];
  return long && n === 1 ? [long, 1] : null;
}

// The most one request may span, in days: Upstox allows a month up to 15 minutes, a quarter above
// that, a decade for days and no limit for weeks and months.
function spanOf(unit, n) {
  if (unit === "minutes") return n <= 15 ? 28 : 85;
  if (unit === "hours") return 85;
  return unit === "days" ? 3600 : 10000;
}

// Upstox: [time, open, high, low, close, volume, oi], newest first. Daily bars sit at midnight UTC of
// their date, like the app's others.
export function parseCandles(rows, daily) {
  return rows
    .map(([t, open, high, low, close, volume]) => ({ time: (daily ? Date.parse(`${t.slice(0, 10)}T00:00:00Z`) : Date.parse(t)) / 1000, open, high, low, close, volume }))
    .reverse();
}

const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

const memo = new Map();
async function cachedCandles(url, ttl) {
  const hit = memo.get(url);
  if (hit && Date.now() - hit.at < ttl) return hit.rows;
  const rows = (await get(url)).candles || [];
  if (memo.size > 500) memo.clear();
  memo.set(url, { at: Date.now(), rows });
  return rows;
}

// Null when Upstox doesn't cover this chart, so the caller falls back to Yahoo.
export async function candles(symbol, tf, limit) {
  const iv = intervalOf(tf);
  const key = iv && (await keyOf(symbol));
  if (!key) return null;
  limit = Math.max(10, Math.min(Number(limit) || 1500, 20000));
  const [unit, n] = iv, daily = !["minutes", "hours"].includes(unit);
  const base = `${encodeURIComponent(key)}/${unit}/${n}`;
  const floor = daily ? "2000-01-01" : "2022-01-01";
  const bars = new Map();
  const add = (rows) => parseCandles(rows, daily).forEach((b) => bars.set(b.time, b));

  // Backwards window by window, until there are enough bars or the stock's history runs out.
  let to = istDay(), empty = 0;
  while (bars.size < limit && to >= floor && empty < 2) {
    const start = addDays(to, -spanOf(unit, n));
    const from = start < floor ? floor : start;
    const rows = await cachedCandles(`/v3/historical-candle/${base}/${to}/${from}`, 600000);
    add(rows);
    empty = rows.length ? 0 : empty + 1;
    to = addDays(from, -1);
  }
  // Today, last so it wins. Cached because every open chart asks every 10 s; live prices move the last bar.
  if (unit !== "weeks" && unit !== "months") add(await cachedCandles(`/v3/historical-candle/intraday/${base}`, 30000));
  if (!bars.size) return null;
  const sorted = [...bars.values()].sort((a, b) => a.time - b.time);
  return { symbol, tf, provider: "Upstox", candles: sorted.slice(-limit), notes: [] };
}

// Upstox's history can lag: at 3 am it still lacked the previous day. Rather than a silent hole, days
// of the last week it doesn't have come from the other source, and the chart says so. Older gaps are
// left: they're holidays Yahoo shows a stray bar for. Weekly and monthly bars are left alone too.
export function fillMissingDays(r, other, now = Date.now() / 1000) {
  const { unit } = parseTf(r.tf);
  if (unit === "W" || unit === "M" || !other?.candles?.length) return r;
  const day = (t) => new Date((t + 19800) * 1000).toISOString().slice(0, 10);
  const have = new Set(r.candles.map((b) => day(b.time)));
  const extra = other.candles.filter((b) => b.time > Math.max(r.candles[0].time, now - 7 * 86400) && !have.has(day(b.time)));
  if (!extra.length) return r;
  const days = [...new Set(extra.map((b) => day(b.time)))].join(", ");
  return {
    ...r,
    candles: [...r.candles, ...extra].sort((a, b) => a.time - b.time).slice(-r.candles.length),
    notes: [`Upstox doesn't have ${days} yet, so those bars are from ${other.provider}.`],
  };
}

// ---------- reading the live feed ----------
// The feed is protobuf (MarketDataFeed.proto, v3). These few field numbers are all we read, which
// saves a dependency: the app has none.
function fields(buf) {
  const out = [];
  let i = 0;
  const varint = () => {
    let v = 0, m = 1, b;
    do {
      b = buf[i++];
      v += (b & 127) * m;
      m *= 128;
    } while (b & 128);
    return v;
  };
  while (i < buf.length) {
    const tag = varint(), no = Math.floor(tag / 8), wire = tag & 7;
    if (wire === 0) out.push([no, varint()]);
    else if (wire === 1) {
      out.push([no, buf.readDoubleLE(i)]);
      i += 8;
    } else if (wire === 2) {
      const len = varint();
      out.push([no, buf.subarray(i, i + len)]);
      i += len;
    } else if (wire === 5) i += 4;
    else throw new Error(`Unexpected protobuf wire type ${wire}`);
  }
  return out;
}
const one = (buf) => Object.fromEntries(fields(buf));

const readLtpc = (buf) => {
  const c = one(buf);
  return { ltp: c[1] || 0, ltt: c[2] || 0, ltq: c[3] || 0 };
};

// FeedResponse -> { key: { ltp, ltt, ltq, full?, vtt, oi, tbq, tsq, bids, asks } }. Bids and asks are
// [price, quantity, orders]; Upstox gives no order count, so that's 0.
export function decodeFeed(buf) {
  const feeds = {};
  for (const [no, entry] of fields(buf)) {
    if (no !== 2) continue;
    const e = one(entry), feed = one(e[2] || Buffer.alloc(0));
    const key = e[1]?.toString();
    if (feed[1]) feeds[key] = readLtpc(feed[1]);
    else if (feed[2]) {
      const full = one(feed[2]);
      if (full[2]) feeds[key] = readLtpc(one(full[2])[1] || Buffer.alloc(0));
      else if (full[1]) {
        const m = one(full[1]);
        const quotes = m[2] ? fields(m[2]).filter(([n]) => n === 1).map(([, q]) => one(q)) : [];
        feeds[key] = {
          ...readLtpc(m[1] || Buffer.alloc(0)),
          full: true,
          vtt: m[6] || 0,
          oi: m[7] || 0,
          tbq: m[9] || 0,
          tsq: m[10] || 0,
          bids: quotes.map((q) => [q[2] || 0, q[1] || 0, 0]),
          asks: quotes.map((q) => [q[4] || 0, q[3] || 0, 0]),
        };
      }
    }
  }
  return feeds;
}

const subscribe = (ws, keys, mode) =>
  ws.send(Buffer.from(JSON.stringify({ guid: crypto.randomUUID(), method: "sub", data: { mode, instrumentKeys: keys } })));

// Proves a token works for the live feed, at any hour: Upstox opens with a snapshot of the last price.
export async function checkFeed(token) {
  const { authorized_redirect_uri: uri } = await get(FEED_PATH, token);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(uri);
    ws.binaryType = "arraybuffer";
    const done = (fn, v) => {
      clearTimeout(timer);
      ws.onclose = null;
      ws.close();
      fn(v);
    };
    const timer = setTimeout(() => done(reject, new Error("Upstox's live feed sent no price within 15 seconds.")), 15000);
    ws.onopen = () => subscribe(ws, [INDEX["^NSEI"]], "ltpc");
    ws.onmessage = (m) => {
      const ltp = decodeFeed(Buffer.from(m.data))[INDEX["^NSEI"]]?.ltp;
      if (ltp) done(resolve, { ltp });
    };
    ws.onclose = () => done(reject, new Error("Upstox closed the live feed. The token may not allow it."));
  });
}

// ---------- the running feed ----------
const feed = { ws: null, open: false, error: "", lastTick: 0, nextTry: 0 };
const last = new Map(); // key -> price
const charts = new Set(); // keys chart prices were asked for
const recording = new Map(); // key -> order flow name
const lastRow = new Map();

export function toRow(f, t) {
  return { t, ex: f.ltt, p: f.ltp, q: f.ltq, v: f.vtt, tb: f.tbq, ts: f.tsq, oi: f.oi, b: f.bids, a: f.asks };
}

// Same line format as Kotak's recording (lib/orderflow.js), in a folder of its own for comparing.
function record(name, f, now) {
  const row = toRow(f, now);
  const same = JSON.stringify({ ...row, t: 0 });
  if (lastRow.get(name) === same) return;
  lastRow.set(name, same);
  const dir = path.join(store.DATA_DIR, "orderflow-upstox", istDay(now));
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, `${name}.jsonl`), JSON.stringify(row) + "\n");
}

function onMessage(m) {
  const now = Date.now();
  let feeds;
  try {
    feeds = decodeFeed(Buffer.from(m.data));
  } catch (e) {
    feed.error = `Couldn't read a live update: ${e.message}`;
    return;
  }
  for (const [key, f] of Object.entries(feeds)) {
    if (!f.ltp) continue;
    last.set(key, f.ltp);
    feed.lastTick = now;
    const name = recording.get(key);
    if (name && f.full) record(name, f, now);
  }
}

async function connect() {
  const list = await instruments();
  recording.clear();
  for (const w of WATCH) {
    const key = w.future ? list.fut[w.future] : list.NS[w.stock];
    if (key) recording.set(key, w.name);
  }
  const { authorized_redirect_uri: uri } = await get(FEED_PATH);
  const ws = new WebSocket(uri);
  ws.binaryType = "arraybuffer";
  feed.ws = ws;
  ws.onopen = () => {
    feed.open = true;
    feed.error = "";
    if (charts.size) subscribe(ws, [...charts].filter((k) => !recording.has(k)), "ltpc");
    subscribe(ws, [...recording.keys()], "full");
  };
  ws.onmessage = onMessage;
  ws.onclose = () => {
    if (feed.ws !== ws) return;
    feed.ws = null;
    feed.open = false;
    last.clear(); // an old price mustn't pass for a live one
    feed.nextTry = Date.now() + 5000;
  };
}

function stop() {
  const ws = feed.ws;
  feed.ws = null;
  feed.open = false;
  last.clear();
  ws?.close();
}

export function start() {
  setInterval(async () => {
    if (!marketOpen() || !savedToken()) return stop();
    if (feed.ws || Date.now() < feed.nextTry) return;
    feed.nextTry = Date.now() + 60000; // a refused token shouldn't be retried every few seconds
    await connect().catch((e) => (feed.error = e.message));
  }, 3000);
}

// Latest price of a chart's symbol, or null until the first update arrives.
export async function livePrice(symbol) {
  const key = await keyOf(symbol);
  if (!key) return null;
  if (!charts.has(key)) {
    charts.add(key);
    if (feed.open && !recording.has(key)) subscribe(feed.ws, [key], "ltpc");
  }
  return last.get(key) ?? null;
}

export function status() {
  return { hasToken: !!savedToken(), connected: feed.open, error: feed.error, lastTick: feed.lastTick, symbols: new Set([...charts, ...recording.keys()]).size, recording: [...recording.values()] };
}

// Tests a new token before keeping it. An empty one removes the saved token.
export async function setToken(raw) {
  const token = String(raw ?? "").trim();
  if (!token) {
    store.write("upstox", {});
    stop();
    return { removed: true };
  }
  if (!/^[\w.-]{20,}$/.test(token)) throw new Error("That doesn't look like an Upstox token: copy the whole of it.");
  const { ltp } = await checkFeed(token);
  store.write("upstox", { token });
  stop();
  feed.error = "";
  feed.nextTry = 0;
  return { ok: true, ltp };
}
