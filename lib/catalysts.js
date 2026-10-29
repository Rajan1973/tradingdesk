// Your stock catalysts (order wins, JVs, fund raises...) from data/catalysts.csv, shown as
// markers on the chart. Columns: date, stock, industry, category, theme, sentiment, title,
// score, conviction, and optionally symbol (an NSE/BSE code, to skip the name lookup).
//
// "stock" is a company name; it's matched to a ticker through NSE's list of listed companies,
// then Yahoo's search (which also finds BSE-only stocks). Matches are saved in
// data/catalyst-symbols.json; edit that file to correct one.
//
// Each theme gets a fixed colour. To choose your own, add data/catalyst-colors.json:
//   { "Solar EPC": "#ff9800", "Luxury housing": "#ab47bc" }

import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./store.js";
import * as store from "./store.js";
import { eventsFor as nseEventsFor } from "./nse-events.js";
import { eventsFor as analystEventsFor, searchName } from "./analyst-events.js";

export const CATALYSTS_FILE = path.join(DATA_DIR, "catalysts.csv");
const COLORS_FILE = path.join(DATA_DIR, "catalyst-colors.json");
const UA = { "User-Agent": "Mozilla/5.0" };
const OFFLINE = process.env.QT_OFFLINE === "1";

// Twenty colours that stay apart from each other and from the green/red candles.
const PALETTE = [
  "#2962ff", "#ff9800", "#ab47bc", "#00bcd4", "#ffd600", "#ec407a", "#8d6e63", "#7cb342",
  "#5c6bc0", "#ff7043", "#26a69a", "#d4e157", "#f06292", "#42a5f5", "#ba68c8", "#ffb74d",
  "#4dd0e1", "#a1887f", "#9575cd", "#e0e0e0",
];
const hash = (s) => {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
};
function customColors() {
  try {
    return JSON.parse(fs.readFileSync(COLORS_FILE, "utf8"));
  } catch {
    return {};
  }
}
function colorOf(theme) {
  return customColors()[theme] || PALETTE[hash(theme.toLowerCase()) % PALETTE.length];
}

// Quoted fields, commas and quotes inside quotes, Excel's BOM.
export function parseCsv(text) {
  const rows = [];
  let row = [],
    cell = "",
    q = false;
  text = text.replace(/^﻿/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") row.push(cell), (cell = "");
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell), rows.push(row), (row = []), (cell = "");
    } else cell += c;
  }
  if (cell || row.length) row.push(cell), rows.push(row);
  const head = (rows.shift() || []).map((h) => h.trim().toLowerCase());
  return rows
    .filter((r) => r.some((c) => c.trim()))
    .map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] || "").trim()])));
}

let memo = { mtime: -1, events: [] };
export function events() {
  let st;
  try {
    st = fs.statSync(CATALYSTS_FILE);
  } catch {
    return [];
  }
  if (st.mtimeMs !== memo.mtime) {
    const rows = parseCsv(fs.readFileSync(CATALYSTS_FILE, "utf8"));
    memo = {
      mtime: st.mtimeMs,
      events: rows
        .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && r.stock && r.title)
        .map((r, i) => ({
          id: i,
          date: r.date,
          stock: r.stock,
          symbol: r.symbol || "",
          industry: r.industry || "",
          category: r.category || "",
          theme: r.theme || r.category || "Other",
          sentiment: r.sentiment || "",
          title: r.title,
          score: r.score || "",
          conviction: r.conviction || "",
        })),
    };
  }
  return memo.events;
}

// ---------- company name -> ticker ----------
const norm = (s) =>
  String(s)
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\b(limited|ltd|the|india|company|co|corporation|corp)\b/g, " ")
    .replace(/\s+/g, "");

let nseList = null;
async function nseNames() {
  if (nseList && Date.now() - nseList.at < 24 * 3600e3) return nseList;
  const map = new Map(), syms = new Set(), full = new Map();
  try {
    const res = await fetch("https://archives.nseindia.com/content/equities/EQUITY_L.csv", {
      headers: UA,
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok)
      for (const r of parseCsv(await res.text())) {
        const sym = r.symbol, name = r["name of company"];
        if (sym) syms.add(sym);
        if (sym && name) full.set(sym, name);
        if (sym && name && !map.has(norm(name))) map.set(norm(name), sym);
      }
  } catch {
    /* fall back to Yahoo's search */
  }
  nseList = { at: Date.now(), map, syms, full };
  return nseList;
}

async function yahooSearch(name) {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(name)}&quotesCount=6&newsCount=0`,
      { headers: UA, signal: AbortSignal.timeout(10000) },
    );
    if (!res.ok) return null;
    const quotes = ((await res.json()).quotes || []).filter((x) => /\.(NS|BO)$/.test(x.symbol || ""));
    const pick = quotes.find((x) => x.symbol.endsWith(".NS") && !x.symbol.includes("-")) ||
      quotes.find((x) => x.symbol.endsWith(".BO"));
    return pick ? `YAHOO:${pick.symbol}` : null;
  } catch {
    return null;
  }
}

async function resolveName(name) {
  const key = norm(name);
  const { map, syms } = await nseNames();
  let sym = map.get(key);
  // A name that is already an NSE code ("NCC", "KSB").
  if (!sym && syms.has(key.toUpperCase())) sym = key.toUpperCase();
  if (!sym)
    for (const [k, v] of map)
      if (k.startsWith(key) && key.length >= 5) {
        sym = v;
        break;
      }
  if (sym) return `YAHOO:${sym}.NS`;
  return yahooSearch(name);
}

const symbolsMemo = { pending: null };
// Every company in the file, matched once and remembered in data/catalyst-symbols.json.
export async function symbols() {
  if (symbolsMemo.pending) return symbolsMemo.pending;
  symbolsMemo.pending = (async () => {
    const saved = store.read("catalyst-symbols", {});
    let changed = false;
    for (const e of events()) {
      if (e.symbol) continue;
      if (e.stock in saved) continue;
      if (OFFLINE) continue;
      saved[e.stock] = (await resolveName(e.stock)) || "";
      changed = true;
    }
    if (changed) store.write("catalyst-symbols", saved);
    return saved;
  })().finally(() => (symbolsMemo.pending = null));
  return symbolsMemo.pending;
}

const base = (s) =>
  String(s || "").toUpperCase().replace(/^YAHOO:/, "").replace(/\.(NS|BO)$/, "");

function withSymbol(e, saved) {
  const sym = e.symbol
    ? `YAHOO:${base(e.symbol)}.${/\.BO$/i.test(e.symbol) ? "BO" : "NS"}`
    : saved[e.stock] || "";
  return { ...e, appSymbol: sym, color: colorOf(e.theme) };
}

// Events for one chart symbol (RELIANCE.NS and RELIANCE.BO count as the same company).
// A company's NSE name, and other companies whose names contain it ("Union Bank of India" for
// Bank of India), so headlines about those aren't read as this one's.
async function companyInfo(ticker) {
  const { full } = await nseNames();
  const name = full?.get(ticker);
  if (!name) return null;
  const mine = searchName(name).toLowerCase();
  const others = [];
  for (const [sym, n] of full)
    if (sym !== ticker && n.toLowerCase().includes(mine)) others.push(searchName(n.replace(/\b(limited|ltd\.?)\b/gi, "")));
  return { name, others };
}

// Events for one chart symbol (RELIANCE.NS and RELIANCE.BO count as the same company): your
// own file first, then NSE's filings (order wins, results, splits... see nse-events.js), then
// analyst calls from news headlines (analyst-events.js).
export async function forSymbol(symbol) {
  const want = base(symbol);
  if (!want) return [];
  const info = await companyInfo(want).catch(() => null);
  const [saved, nse, analyst] = await Promise.all([
    symbols(),
    nseEventsFor(want).catch(() => []),
    info ? analystEventsFor(want, info.name, info.others).catch(() => []) : [],
  ]);
  const mine = events()
    .map((e) => withSymbol(e, saved))
    .filter((e) => e.appSymbol && base(e.appSymbol) === want)
    .map((e) => ({ ...e, source: "Your catalyst file" }));
  // Your file wins when it already has an order win (or the same theme) on that day.
  const taken = new Set(mine.map((e) => `${e.date}|${/order/i.test(e.category) ? "Order win" : e.theme}`));
  const custom = customColors();
  return [
    ...mine,
    ...nse
      .filter((e) => !taken.has(`${e.date}|${e.theme}`))
      .map((e) => ({ ...e, color: custom[e.theme] || e.color })),
    ...analyst,
  ];
}

// Every event with its matched symbol, and the names that couldn't be matched.
export async function all() {
  const saved = await symbols();
  const list = events().map((e) => withSymbol(e, saved));
  return {
    file: CATALYSTS_FILE,
    events: list,
    unmatched: [...new Set(list.filter((e) => !e.appSymbol).map((e) => e.stock))],
  };
}
