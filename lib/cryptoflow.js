// Test data for the order flow screen: Bitcoin (Binance spot), the last 7 days, with a true buyer or
// seller flag on every trade. Finished days come from Binance's free daily files, the rest from its
// trades API. Saved as 1-minute footprints in data/orderflow/crypto/BTCUSDT/<day>.json.
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./store.js";
import { unzipEntry } from "./brokers.js";
import { addTrade, mergeBars, TF_MS, STEPS } from "../public/lib/footprint.js";

const SYMBOL = "BTCUSDT";
const DAYS = 7;
const DAY_MS = 864e5;
const dir = path.join(DATA_DIR, "orderflow", "crypto", SYMBOL);
const fileOf = (day) => path.join(dir, `${day}.json`);
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const status = { running: false, phase: "", pct: 0, through: 0, error: null, missing: [] };

function loadDay(day) {
  try {
    return JSON.parse(fs.readFileSync(fileOf(day), "utf8"));
  } catch {
    return null;
  }
}

function saveDay(day, map, extra) {
  fs.mkdirSync(dir, { recursive: true });
  const minutes = [...map.values()].sort((a, b) => a.at - b.at);
  for (const m of minutes)
    for (const c of Object.values(m.cells)) (c[0] = +c[0].toFixed(5)), (c[1] = +c[1].toFixed(5));
  // Written aside then swapped in, so a crash can't leave a half-written day.
  fs.writeFileSync(`${fileOf(day)}.tmp`, JSON.stringify({ ...extra, minutes }));
  fs.renameSync(`${fileOf(day)}.tmp`, fileOf(day));
}

// One row of a Binance daily file: id, price, qty, first id, last id, time, buyer-is-maker, ...
// Spot files give microseconds and futures milliseconds; some older files have a header.
export function parseTrade(line) {
  const c = line.split(",");
  const id = Number(c[0]);
  if (!id || c.length < 7) return null;
  const t = Number(c[5]);
  return { id, price: Number(c[1]), qty: Number(c[2]), t: t > 1e14 ? t / 1000 : t, isSell: c[6].toLowerCase() === "true" };
}

async function fillFromFile(day) {
  const name = `${SYMBOL}-aggTrades-${day}`;
  const r = await fetch(`https://data.binance.vision/data/spot/daily/aggTrades/${SYMBOL}/${name}.zip`, { signal: AbortSignal.timeout(180000) });
  if (r.status === 404 || r.status === 403) return false; // not published (yet)
  if (!r.ok) throw new Error(`Binance's file for ${day}: HTTP ${r.status}`);
  const csv = unzipEntry(Buffer.from(await r.arrayBuffer()), `${name}.csv`).toString("utf8");
  const map = new Map();
  let last = null;
  let at = 0;
  while (at < csv.length) {
    let end = csv.indexOf("\n", at);
    if (end < 0) end = csv.length;
    const tr = parseTrade(csv.slice(at, end));
    at = end + 1;
    if (!tr) continue;
    addTrade(map, tr.t, tr.price, tr.qty, tr.isSell);
    last = tr;
  }
  if (!last) throw new Error(`Binance's file for ${day} is empty.`);
  saveDay(day, map, { complete: true, lastId: last.id, lastT: last.t });
  return true;
}

async function tradesPage(params) {
  const r = await fetch(`https://api.binance.com/api/v3/aggTrades?symbol=${SYMBOL}&limit=1000&${params}`, { signal: AbortSignal.timeout(20000) });
  if (r.status === 429 || r.status === 418) throw new Error("Binance asked us to slow down; try again in a few minutes.");
  if (!r.ok) throw new Error(`Binance trades: HTTP ${r.status}`);
  return r.json();
}

async function fillFromApi(day, progress) {
  const start = Date.parse(`${day}T00:00:00Z`), end = start + DAY_MS;
  const saved = loadDay(day);
  const map = new Map((saved?.minutes || []).map((m) => [m.at, m]));
  let lastId = saved?.lastId, lastT = saved?.lastT || start, pages = 0;
  for (;;) {
    let page;
    if (lastId) page = await tradesPage(`fromId=${lastId + 1}`);
    else {
      // The API needs a window of under an hour when asked by time; quiet hours can be empty.
      page = [];
      for (let t = lastT; !page.length && t < Math.min(end, Date.now()); t += 36e5)
        page = await tradesPage(`startTime=${t}&endTime=${t + 36e5 - 1}`);
    }
    let over = !page.length;
    for (const x of page) {
      if (x.T >= end) {
        over = true;
        break;
      }
      addTrade(map, x.T, +x.p, +x.q, x.m);
      lastId = x.a;
      lastT = x.T;
    }
    progress((lastT - start) / Math.max(1, Math.min(end, Date.now()) - start));
    if (over || page.length < 1000) break;
    if (++pages % 100 === 0) saveDay(day, map, { complete: false, lastId, lastT });
    await sleep(100); // Well under Binance's limit of 6,000 weight a minute (4 a page).
  }
  if (lastId) saveDay(day, map, { complete: false, lastId, lastT });
}

const lastDays = (now = Date.now()) => Array.from({ length: DAYS }, (_, i) => dayOf(now - (DAYS - 1 - i) * DAY_MS));

function findThrough(days) {
  for (const d of [...days].reverse()) {
    const f = loadDay(d);
    if (f?.lastT) return Math.floor(f.lastT / 6e4) * 6e4;
  }
  return 0;
}

// Brings the stored week up to now. Only one runs at a time.
export async function sync() {
  if (status.running) return;
  Object.assign(status, { running: true, error: null, missing: [], pct: 0 });
  const days = lastDays();
  try {
    for (let i = 0; i < days.length; i++) {
      const day = days[i];
      const pct = (share) => (status.pct = Math.round(((i + share) / days.length) * 100));
      pct(0);
      status.phase = `Getting ${day}`;
      if (loadDay(day)?.complete) continue;
      if (i < days.length - 1 && (await fillFromFile(day))) continue;
      await fillFromApi(day, pct);
      if (!loadDay(day)) status.missing.push(day);
    }
    status.phase = "";
    status.pct = 100;
  } catch (e) {
    status.error = e.message;
    console.error(`[cryptoflow] ${new Date().toISOString()} ${e.message}`);
  } finally {
    status.through = findThrough(days);
    status.running = false;
  }
}

const finished = new Map(); // parsed finished days, so each timeframe change doesn't re-read them

export function bars(tf, step) {
  const tfMs = TF_MS[tf];
  if (!tfMs || !STEPS.includes(step)) return null;
  const days = lastDays();
  const through = findThrough(days);
  const minutes = [];
  for (const day of days) {
    let list = finished.get(day);
    if (!list) {
      const f = loadDay(day);
      list = f?.minutes || [];
      if (f?.complete) finished.set(day, list);
    }
    for (const m of list) if (m.at < through) minutes.push(m);
  }
  return { symbol: SYMBOL, through, bars: mergeBars(minutes, tfMs, step) };
}
