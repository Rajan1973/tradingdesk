// Your Indian broker accounts: any number of Zerodha (Kite Connect), Kotak Neo (Neo Trade API)
// and ICICI Direct (Breeze API) accounts. Holdings, positions, funds and today's orders, and
// REAL orders placed from the Broker tab.
//
// You fill in data/brokers.json yourself (the data folder never leaves this computer, and an
// update keeps it). Each key is only ever sent to its own broker:
//
//   {
//     "accounts": [
//       { "id": "zerodha-1", "broker": "zerodha", "name": "Zerodha", "apiKey": "...", "apiSecret": "..." },
//       { "id": "kotak-1", "broker": "kotak", "name": "Kotak Neo", "accessToken": "...", "mobileNumber": "+91...", "ucc": "..." },
//       { "id": "icici-1", "broker": "icici", "name": "ICICI Direct", "apiKey": "...", "apiSecret": "..." }
//     ],
//     "maxOrderValue": 500000
//   }
//
// "id" is fixed (it's in the redirect URLs); "name" is what the app shows and names the
// account's watchlist section. Add as many accounts of each broker as you like.
//
//   Zerodha  An app at https://developers.kite.trade per Zerodha account (each app is tied to
//            one client ID). Redirect URL: http://127.0.0.1:3777/api/broker/kite/callback
//   Kotak    A Trade API application in Neo (More > Trade API) per account, with TOTP registered
//            and this computer's IP whitelisted for orders.
//   ICICI    An app at https://api.icicidirect.com (Breeze API) per account, with Redirect URL
//            http://127.0.0.1:3777/api/broker/<id>/callback and a static IP for orders.
//
// Day sessions (not your keys) are kept in data/broker-sessions.json until they expire.
// Orders are capped at maxOrderValue rupees (default 5 lakh) so a typo can't send a huge order.

import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import zlib from "node:zlib";
import { DATA_DIR } from "./store.js";
import * as store from "./store.js";

export const BROKERS_FILE = path.join(DATA_DIR, "brokers.json");
const TIMEOUT_MS = 15000;
const KITE = "https://api.kite.trade";
const KOTAK_LOGIN = "https://mis.kotaksecurities.com";
const BREEZE = "https://api.icicidirect.com/breezeapi/api/v1/";
export const BROKER_NAMES = { zerodha: "Zerodha", kotak: "Kotak Neo", icici: "ICICI Direct" };
const FIELDS = {
  zerodha: ["apiKey", "apiSecret"],
  kotak: ["accessToken", "mobileNumber", "ucc"],
  icici: ["apiKey", "apiSecret"],
};

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const log = (msg) => console.error(`[broker] ${new Date().toISOString()} ${msg}`);

// ---------- accounts ----------
function readFile() {
  try {
    return JSON.parse(fs.readFileSync(BROKERS_FILE, "utf8"));
  } catch {
    return {};
  }
}

// The first version of the file had one account per broker ({ kite: {...}, kotak: {...} }).
// Turn it into the accounts list once, keeping your keys and today's logins.
function migrate(c) {
  if (Array.isArray(c.accounts)) return c;
  const accounts = [];
  if (c.kite) accounts.push({ id: "zerodha-1", broker: "zerodha", name: "Zerodha", apiKey: c.kite.apiKey || "", apiSecret: c.kite.apiSecret || "" });
  if (c.kotak)
    accounts.push({ id: "kotak-1", broker: "kotak", name: "Kotak Neo", accessToken: c.kotak.accessToken || "", mobileNumber: c.kotak.mobileNumber || "", ucc: c.kotak.ucc || "" });
  const next = { accounts, maxOrderValue: c.maxOrderValue ?? 500000 };
  if (fs.existsSync(BROKERS_FILE)) fs.copyFileSync(BROKERS_FILE, `${BROKERS_FILE}.before-accounts.bak`);
  fs.writeFileSync(BROKERS_FILE, JSON.stringify(next, null, 2));
  const s = store.read("broker-sessions", {});
  if (s.kite || s.kotak) {
    const moved = { ...s };
    if (s.kite) (moved["zerodha-1"] = s.kite), delete moved.kite;
    if (s.kotak) (moved["kotak-1"] = s.kotak), delete moved.kotak;
    store.write("broker-sessions", moved);
  }
  log("brokers.json moved to the accounts list (old copy kept as brokers.json.before-accounts.bak)");
  return next;
}

export function config() {
  return migrate(readFile());
}

export function accounts() {
  return (config().accounts || []).filter((a) => a && a.id && BROKER_NAMES[a.broker]);
}

function account(id) {
  // "kite" and "kotak" were the ids before multiple accounts; they mean the first of each.
  const legacy = { kite: "zerodha", kotak: "kotak" }[id];
  const a = legacy ? accounts().find((x) => x.broker === legacy) : accounts().find((x) => x.id === id);
  if (!a) throw fail(`No broker account "${id}" in data/brokers.json.`, 404);
  return a;
}

const isConfigured = (a) => FIELDS[a.broker].every((f) => String(a[f] || "").trim());

// A starter file with every broker's fields empty, so you only have to paste keys in.
export function ensureTemplate() {
  if (fs.existsSync(BROKERS_FILE)) return;
  fs.writeFileSync(
    BROKERS_FILE,
    JSON.stringify(
      {
        accounts: [
          { id: "zerodha-1", broker: "zerodha", name: "Zerodha", apiKey: "", apiSecret: "" },
          { id: "kotak-1", broker: "kotak", name: "Kotak Neo", accessToken: "", mobileNumber: "", ucc: "" },
          { id: "icici-1", broker: "icici", name: "ICICI Direct", apiKey: "", apiSecret: "" },
        ],
        maxOrderValue: 500000,
      },
      null,
      2,
    ),
  );
}

// ---------- day sessions ----------
const sessions = () => store.read("broker-sessions", {});
function saveSession(id, value) {
  const all = sessions();
  if (value) all[id] = value;
  else delete all[id];
  store.write("broker-sessions", all);
}
// Brokers end API sessions overnight; treat anything from before 6 am IST today as gone.
function session(id) {
  const s = sessions()[id];
  if (!s) return null;
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 3600e3);
  const sixAmIst = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 6) - 5.5 * 3600e3;
  const cutoff = now.getTime() >= sixAmIst ? sixAmIst : sixAmIst - 86400e3;
  if (s.at < cutoff) {
    saveSession(id, null);
    return null;
  }
  return s;
}

export function status() {
  return {
    accounts: accounts().map((a) => {
      const s = session(a.id);
      return {
        id: a.id,
        broker: a.broker,
        brokerName: BROKER_NAMES[a.broker],
        name: a.name || `${BROKER_NAMES[a.broker]} (${a.id})`,
        configured: isConfigured(a),
        connected: !!s,
        user: s?.user || null,
      };
    }),
    file: BROKERS_FILE,
  };
}

// ---------- HTTP ----------
async function http(url, opts = {}) {
  let res;
  try {
    res = await fetch(url, { ...opts, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw Object.assign(new Error(`${new URL(url).host} couldn't be reached (${e.cause?.code || e.message})`), { upstream: true });
  }
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { message: text.slice(0, 200) };
  }
  return { ok: res.ok, status: res.status, body };
}

// Breeze sends a JSON body even on GET, which fetch() won't do, so it goes through https directly.
function httpWithBody(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      { method, hostname: u.hostname, path: u.pathname + u.search, headers: { ...headers, "Content-Length": Buffer.byteLength(body) }, timeout: TIMEOUT_MS },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json;
          try {
            json = JSON.parse(text);
          } catch {
            json = { Error: text.slice(0, 200) };
          }
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: json });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", (e) => reject(Object.assign(new Error(`${u.host} couldn't be reached (${e.code || e.message})`), { upstream: true })));
    req.end(body);
  });
}

// App symbols for NSE/BSE stocks are YAHOO:RELIANCE.NS / YAHOO:RELIANCE.BO. Brokers add the NSE
// series to some names (E2E-BE, IDEA-EQ, SME stocks' -SM / -ST); Yahoo uses the bare name.
const toApp = (sym, exch) =>
  `YAHOO:${String(sym).replace(/-(EQ|BE|BZ|BL|SM|ST|IL|RL|GB|GS)$/i, "")}.${/^(BSE|bse)/.test(exch) ? "BO" : "NS"}`;
function fromApp(symbol) {
  const m = /^YAHOO:([A-Z0-9&\-]+)\.NS$/.exec(String(symbol || "").toUpperCase());
  if (!m) throw fail("Orders can be placed for NSE stocks only (symbols ending in .NS).");
  return m[1];
}
const n = (v) => {
  const x = Number(String(v ?? "").trim());
  return Number.isFinite(x) ? x : 0;
};

// ---------- Zerodha (Kite Connect v3) ----------
// Zerodha hands redirect_params back on the redirect: "popup=1" makes the callback answer with a
// small page that closes itself, and "acct" says which Zerodha account is logging in.
export function kiteLoginUrl(id, { popup = false } = {}) {
  const a = account(id);
  if (!isConfigured(a)) throw fail(`Add the apiKey and apiSecret for "${a.name}" to data/brokers.json first.`);
  const params = new URLSearchParams({ acct: a.id, ...(popup ? { popup: "1" } : {}) }).toString();
  return `https://kite.zerodha.com/connect/login?v=3&api_key=${encodeURIComponent(a.apiKey)}&redirect_params=${encodeURIComponent(params)}`;
}

export async function kiteCallback(id, requestToken) {
  const a = account(id);
  if (!requestToken) throw fail("Zerodha didn't send a request token.");
  const checksum = crypto.createHash("sha256").update(a.apiKey + requestToken + a.apiSecret).digest("hex");
  const r = await http(`${KITE}/session/token`, {
    method: "POST",
    headers: { "X-Kite-Version": "3", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ api_key: a.apiKey, request_token: requestToken, checksum }),
  });
  if (!r.ok || r.body.status !== "success") {
    const why = String(r.body.message || `HTTP ${r.status}`).replace(/\.+$/, "");
    const hint = /checksum/i.test(why)
      ? ` The API secret for "${a.name}" doesn't match its API key: copy it again from developers.kite.trade.`
      : /token is invalid|expired/i.test(why)
        ? " The one-time login code was already used or expired: click Log in again."
        : /api_key/i.test(why)
          ? ` Check the API key for "${a.name}" in data/brokers.json.`
          : /not enabled/i.test(why)
            ? ` You logged in with a Zerodha ID that isn't linked to this Kite app: log in with the account the app belongs to.`
            : "";
    throw fail(`Zerodha login failed: ${why}.${hint}`, 502);
  }
  saveSession(a.id, { at: Date.now(), accessToken: r.body.data.access_token, user: r.body.data.user_name || r.body.data.user_id });
  log(`${a.name} (${a.id}) login OK`);
}

async function kite(a, method, p, form) {
  const s = session(a.id);
  if (!s) throw fail(`Log in to ${a.name} from the Broker tab first.`, 401);
  const r = await http(`${KITE}${p}`, {
    method,
    headers: {
      "X-Kite-Version": "3",
      Authorization: `token ${a.apiKey}:${s.accessToken}`,
      ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: form ? new URLSearchParams(form) : undefined,
  });
  if (r.status === 403 && r.body.error_type === "TokenException") {
    saveSession(a.id, null);
    throw fail(`Your ${a.name} session has ended. Log in again from the Broker tab.`, 401);
  }
  if (!r.ok || r.body.status !== "success") throw fail(`${a.name}: ${r.body.message || `HTTP ${r.status}`}`, 502);
  return r.body.data;
}

async function kitePortfolio(a) {
  const [holdings, positions, margins, orders] = await Promise.all([
    kite(a, "GET", "/portfolio/holdings"),
    kite(a, "GET", "/portfolio/positions"),
    kite(a, "GET", "/user/margins").catch(() => null),
    kite(a, "GET", "/orders").catch(() => []),
  ]);
  return {
    holdings: holdings.map((h) => ({
      symbol: toApp(h.tradingsymbol, h.exchange),
      name: h.tradingsymbol,
      qty: (h.quantity || 0) + (h.t1_quantity || 0),
      avg: h.average_price,
      ltp: h.last_price,
      value: ((h.quantity || 0) + (h.t1_quantity || 0)) * h.last_price,
      pnl: h.pnl,
      dayChangePct: h.day_change_percentage,
    })),
    positions: (positions?.net || [])
      .filter((p) => p.quantity !== 0 || p.pnl)
      .map((p) => ({
        symbol: /^(NSE|BSE)$/.test(p.exchange) ? toApp(p.tradingsymbol, p.exchange) : null,
        name: p.tradingsymbol,
        product: p.product,
        qty: p.quantity,
        avg: p.average_price,
        ltp: p.last_price,
        pnl: p.pnl,
      })),
    funds: margins?.equity ? { available: margins.equity.net, used: margins.equity.utilised?.debits } : null,
    orders: (orders || []).map((o) => ({
      id: o.order_id,
      time: o.order_timestamp,
      name: o.tradingsymbol,
      symbol: /^(NSE|BSE)$/.test(o.exchange) ? toApp(o.tradingsymbol, o.exchange) : null,
      product: o.product,
      side: o.transaction_type,
      qty: o.quantity,
      type: o.order_type,
      price: o.average_price || o.price,
      status: o.status,
      message: o.status_message || "",
    })),
  };
}

async function kiteOrder(a, o) {
  const form = {
    tradingsymbol: o.tradingSymbol,
    exchange: "NSE",
    transaction_type: o.side,
    order_type: o.type,
    quantity: String(o.qty),
    product: o.product,
    validity: "DAY",
    tag: "quantterm",
  };
  if (o.type === "LIMIT" || o.type === "SL") form.price = String(o.price);
  if (o.type === "SL" || o.type === "SL-M") form.trigger_price = String(o.trigger);
  // Zerodha requires market protection on API market orders; -1 lets it pick the band.
  if (o.type === "MARKET" || o.type === "SL-M") form.market_protection = "-1";
  const d = await kite(a, "POST", "/orders/regular", form);
  return d.order_id;
}

// ---------- Kotak Neo (Neo Trade API) ----------
export async function kotakLogin(id, totp, mpin) {
  const a = account(id);
  if (!isConfigured(a)) throw fail(`Add the accessToken, mobileNumber and ucc for "${a.name}" to data/brokers.json first.`);
  if (!/^\d{6}$/.test(String(totp || ""))) throw fail("The TOTP is the 6-digit code from your authenticator app.");
  if (!/^\d{4,6}$/.test(String(mpin || ""))) throw fail("Enter your Kotak MPIN.");
  const base = { Authorization: a.accessToken, "neo-fin-key": "neotradeapi", "Content-Type": "application/json" };
  const view = await http(`${KOTAK_LOGIN}/login/1.0/tradeApiLogin`, {
    method: "POST",
    headers: base,
    body: JSON.stringify({ mobileNumber: a.mobileNumber, ucc: a.ucc, totp: String(totp) }),
  });
  if (!view.ok || !view.body?.data?.token) {
    const why = kotakMsg(view);
    log(`${a.name} (${a.id}) TOTP step failed: ${why}`);
    const hint = /totp/i.test(why)
      ? " Check the 6-digit code is the current one from your authenticator app (they change every 30 seconds)."
      : /token|unauthori|consumer|invalid key/i.test(why) || view.status === 401
        ? ` The accessToken for "${a.name}" isn't accepted: copy it again from Neo (More > Trade API).`
        : /mobile|ucc|client/i.test(why)
          ? ` Check mobileNumber (with +91) and ucc (client code) for "${a.name}" in data/brokers.json.`
          : "";
    throw fail(`Kotak login failed: ${why}.${hint}`, 502);
  }
  const trade = await http(`${KOTAK_LOGIN}/login/1.0/tradeApiValidate`, {
    method: "POST",
    headers: { ...base, sid: view.body.data.sid, Auth: view.body.data.token },
    body: JSON.stringify({ mpin: String(mpin) }),
  });
  const d = trade.body?.data;
  if (!trade.ok || !d?.token || !d?.baseUrl) {
    log(`${a.name} (${a.id}) MPIN step failed: ${kotakMsg(trade)}`);
    throw fail(`Kotak MPIN check failed: ${kotakMsg(trade)}. Check your MPIN (the one you use to log in to the Neo app).`, 502);
  }
  log(`${a.name} (${a.id}) login OK`);
  saveSession(a.id, { at: Date.now(), token: d.token, sid: d.sid, serverId: d.hsServerId || "", baseUrl: d.baseUrl.replace(/\/$/, ""), user: d.greetingName || a.ucc });
}

const kotakMsg = (r) => r.body?.message || r.body?.emsg || r.body?.errMsg || r.body?.error?.[0]?.message || `HTTP ${r.status}`;

// Requests follow Kotak's current SDK (kotak-neo-python): no sId on any call, and the consumer
// key as Authorization on order calls (place, cancel, modify), on top of the session headers.
async function kotak(a, method, p, body, { withConsumerKey = false } = {}) {
  const s = session(a.id);
  if (!s) throw fail(`Log in to ${a.name} from the Broker tab first.`, 401);
  const r = await http(`${s.baseUrl}/${p}`, {
    method,
    headers: {
      ...(withConsumerKey ? { Authorization: a.accessToken } : {}),
      Sid: s.sid,
      Auth: s.token,
      accept: "application/json",
      ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    // Neo takes its parameters as JSON inside a form field called jData.
    body: body ? new URLSearchParams({ jData: JSON.stringify(body) }) : undefined,
  });
  if (r.status === 401 || r.status === 403) {
    const why = kotakMsg(r);
    log(`${a.name} (${a.id}) refused ${method} ${p}: HTTP ${r.status} ${why}`);
    // A refused order isn't always an ended session (an unregistered IP looks the same), so
    // check the session with a harmless read before logging you out.
    if (method !== "GET") {
      const probe = await http(`${s.baseUrl}/quick/user/positions`, { headers: { Sid: s.sid, Auth: s.token, accept: "application/json" } }).catch(() => null);
      if (probe?.ok) {
        const ip = await kotakIp(a.id).catch(() => null);
        throw fail(
          `${a.name} refused the order: ${why}. Kotak only accepts API orders from an IP address whitelisted on your Trade API application${ip ? `; it sees this computer as ${ip}` : ""}. Whitelist that IP in Neo (More > Trade API, on the same application as your token), log in again here, then retry. You're still logged in.`,
          502,
        );
      }
    }
    saveSession(a.id, null);
    throw fail(`Your ${a.name} session has ended (${why}). Log in again from the Broker tab.`, 401);
  }
  const st = String(r.body?.stat || "").toLowerCase();
  if (!r.ok || (st && st !== "ok")) {
    log(`${a.name} (${a.id}) ${method} ${p} failed: HTTP ${r.status} ${kotakMsg(r)}`);
    throw fail(`${a.name}: ${kotakMsg(r)}`, 502);
  }
  return r.body;
}

// Kotak's position rows in the app's shape. F&O rows also carry what's needed to price and exit them:
// quantities are in units (65 for one Nifty lot of 65), and cost is what's been paid net of sales.
export function kotakPositions(rows = []) {
  return rows
    .map((p) => {
      const buyQty = n(p.flBuyQty) + n(p.cfBuyQty),
        sellQty = n(p.flSellQty) + n(p.cfSellQty);
      const buyAmt = n(p.buyAmt) + n(p.cfBuyAmt),
        sellAmt = n(p.sellAmt) + n(p.cfSellAmt);
      const qty = buyQty - sellQty;
      const fo = /_fo$/.test(p.exSeg || "") && p.tok ? { seg: p.exSeg, token: String(p.tok), tradingSymbol: p.trdSym, lot: n(p.lotSz) || 1 } : null;
      return {
        symbol: /cm$/.test(p.exSeg || "") ? toApp(p.sym, p.exSeg) : null,
        name: p.trdSym || p.sym,
        product: p.prod,
        qty,
        avg: qty > 0 && buyQty ? buyAmt / buyQty : qty < 0 && sellQty ? sellAmt / sellQty : null,
        ltp: null,
        pnl: qty === 0 ? sellAmt - buyAmt : null,
        ...(fo ? { fo, cost: buyAmt - sellAmt } : {}),
      };
    })
    .filter((p) => p.qty !== 0 || p.pnl);
}

// Latest prices by quote key ("nse_fo|66728"), from any logged-in Kotak account.
export async function foPrices(keys) {
  const quotes = await kotakQuotes(keys);
  return Object.fromEntries(quotes.filter((x) => Number(x.ltp) > 0).map((x) => [`${x.exchange}|${x.exchange_token}`, Number(x.ltp)]));
}
const foKey = (fo) => `${fo.seg}|${fo.token}`;

async function kotakPortfolio(a) {
  const [holdings, positions, limits, orders] = await Promise.all([
    kotak(a, "GET", "portfolio/v1/holdings"),
    kotak(a, "GET", "quick/user/positions").catch(() => ({ data: [] })),
    kotak(a, "POST", "quick/user/limits", { seg: "ALL", exch: "ALL", prod: "ALL" }).catch(() => null),
    kotak(a, "GET", "quick/user/orders").catch(() => ({ data: [] })),
  ]);
  const openPositions = kotakPositions(positions.data);
  const open = openPositions.filter((p) => p.fo && p.qty);
  if (open.length) {
    const prices = await foPrices(open.map((p) => foKey(p.fo))).catch(() => ({}));
    for (const p of open) {
      p.ltp = prices[foKey(p.fo)] ?? null;
      if (p.ltp != null) p.pnl = p.qty * p.ltp - p.cost;
    }
  }
  return {
    holdings: (holdings.data || []).map((h) => {
      const ltp = h.quantity ? n(h.mktValue) / n(h.quantity) : n(h.closingPrice);
      return {
        symbol: /cm$/.test(h.exchangeSegment || "") ? toApp(h.displaySymbol || h.symbol, h.exchangeSegment) : null,
        name: h.displaySymbol || h.symbol,
        qty: n(h.quantity),
        avg: n(h.averagePrice),
        ltp,
        value: n(h.mktValue),
        pnl: n(h.mktValue) - n(h.holdingCost),
        // Kotak's closingPrice is often today's price: the server fills the day's change from a quote.
        dayChangePct: null,
      };
    }),
    positions: openPositions,
    funds: limits ? { available: n(limits.Net), used: n(limits.MarginUsed) } : null,
    orders: (orders.data || []).map((o) => ({
      id: o.nOrdNo,
      time: o.ordDtTm || o.flDtTm || "",
      name: o.trdSym,
      symbol: /cm$/.test(o.exSeg || "") ? toApp(o.trdSym, o.exSeg) : null,
      product: o.prod,
      side: o.trnsTp === "B" ? "BUY" : o.trnsTp === "S" ? "SELL" : o.trnsTp,
      qty: n(o.qty),
      type: o.prcTp,
      price: n(o.avgPrc) || n(o.prc),
      status: o.ordSt,
      message: o.rejRsn && o.rejRsn !== "--" ? o.rejRsn : "",
    })),
  };
}

async function kotakOrder(a, o) {
  const pt = { MARKET: "MKT", LIMIT: "L", SL: "SL", "SL-M": "SL-M" }[o.type];
  const r = await kotak(
    a,
    "POST",
    "quick/order/rule/ms/place",
    {
      am: "NO",
      dq: "0",
      es: o.seg || "nse_cm",
      mp: "0",
      pc: o.product,
      pf: "N",
      pr: o.type === "LIMIT" || o.type === "SL" ? String(o.price) : "0",
      pt,
      qt: String(o.qty),
      rt: "DAY",
      tp: o.type === "SL" || o.type === "SL-M" ? String(o.trigger) : "0",
      ts: o.seg ? o.tradingSymbol : `${o.tradingSymbol}-EQ`,
      tt: o.side === "BUY" ? "B" : "S",
      os: "NEOTRADEAPI",
    },
    { withConsumerKey: true },
  );
  if (!r.nOrdNo) throw fail(`${a.name}: ${kotakMsg({ body: r, status: 200 })}`, 502);
  return r.nOrdNo;
}

// The public IP address Kotak sees for this computer: the one to whitelist for API orders.
export async function kotakIp(id) {
  const a = account(id);
  const s = session(a.id);
  if (!s) throw fail(`Log in to ${a.name} from the Broker tab first.`, 401);
  const r = await http(`${KOTAK_LOGIN}/login/1.0/get-client-ip`, {
    headers: { Authorization: a.accessToken, Sid: s.sid, Auth: s.token, accept: "application/json" },
  });
  const ip = r.body?.data?.[0]?.ip;
  if (!r.ok || !ip) throw fail(`Kotak didn't return your IP: ${kotakMsg(r)}`, 502);
  return ip;
}

// ---------- ICICI Direct (Breeze API) ----------
// Login: ICICI's page sends you back to /api/broker/<id>/callback?apisession=...; that one-time
// code is swapped for a session token (CustomerDetails). Every later call is signed with
// SHA-256(timestamp + JSON body + secret key). ICICI's rules: orders only from the static IP
// registered with your API key, limit orders only (no market orders), NSE only.
export function iciciLoginUrl(id) {
  const a = account(id);
  if (!isConfigured(a)) throw fail(`Add the apiKey and apiSecret for "${a.name}" to data/brokers.json first.`);
  return `https://api.icicidirect.com/apiuser/login?api_key=${encodeURIComponent(a.apiKey)}`;
}

export async function iciciCallback(id, apiSession) {
  const a = account(id);
  if (!apiSession) throw fail("ICICI didn't send an API session code.");
  const body = JSON.stringify({ SessionToken: apiSession, AppKey: a.apiKey });
  const r = await httpWithBody("GET", `${BREEZE}customerdetails`, { "Content-Type": "application/json" }, body);
  const ok = r.body?.Success;
  if (!ok?.session_token) {
    const why = String(r.body?.Error || `HTTP ${r.status}`);
    const hint = /public key/i.test(why)
      ? ` The apiKey for "${a.name}" isn't recognised: copy it again from the Breeze API portal.`
      : /invalid session|resource not available/i.test(why)
        ? " The login code was already used or expired: click Log in again."
        : "";
    log(`${a.name} (${a.id}) login failed: ${why}`);
    throw fail(`ICICI Direct login failed: ${why}.${hint}`, 502);
  }
  saveSession(a.id, { at: Date.now(), sessionToken: ok.session_token, user: ok.idirect_user_name || ok.idirect_userid || "" });
  log(`${a.name} (${a.id}) login OK`);
}

async function breeze(a, method, endpoint, payload = {}) {
  const s = session(a.id);
  if (!s) throw fail(`Log in to ${a.name} from the Broker tab first.`, 401);
  const body = JSON.stringify(payload);
  const ts = new Date().toISOString().slice(0, 19) + ".000Z";
  const checksum = crypto.createHash("sha256").update(ts + body + a.apiSecret).digest("hex");
  const r = await httpWithBody(
    method,
    BREEZE + endpoint,
    {
      "Content-Type": "application/json",
      "X-Checksum": `token ${checksum}`,
      "X-Timestamp": ts,
      "X-AppKey": a.apiKey,
      "X-SessionToken": s.sessionToken,
    },
    body,
  );
  const err = r.body?.Error;
  if (err || !r.ok || (r.body?.Status && r.body.Status !== 200)) {
    const why = String(err || `HTTP ${r.status}`);
    log(`${a.name} (${a.id}) ${method} ${endpoint} failed: ${why}`);
    if (/session|token|unauthori/i.test(why) && !/ip/i.test(why)) {
      saveSession(a.id, null);
      throw fail(`Your ${a.name} session has ended (${why}). Log in again from the Broker tab.`, 401);
    }
    throw fail(`${a.name}: ${why}`, 502);
  }
  return r.body.Success;
}

// ICICI's own stock codes (DIXTEC, RELIND, HDFBAN...) from its Security Master, both ways.
let scrips = null;
async function iciciScrips() {
  if (scrips && Date.now() - scrips.at < 24 * 3600e3) return scrips;
  const saved = store.read("icici-scrips", null);
  const build = (pairs) => ({
    toNse: new Map(pairs.map(([i, x]) => [i, x])),
    toIcici: new Map(pairs.map(([i, x]) => [x, i])),
    byIsin: new Map(pairs.filter((p) => p[2]).map(([, x, isin]) => [isin, x])),
  });
  if (saved?.v === 2 && Date.now() - saved.at < 24 * 3600e3) return (scrips = { ...saved, ...build(saved.pairs) });
  const res = await fetch("https://directlink.icicidirect.com/MotherAppMaster/SecurityMaster.zip", { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw fail(`ICICI's Security Master returned HTTP ${res.status}`, 502);
  const text = unzipEntry(Buffer.from(await res.arrayBuffer()), "NSEScripMaster.txt").toString("utf8");
  const lines = text.split(/\r?\n/);
  const cols = lines[0].split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
  const iShort = cols.indexOf("ShortName"), iExch = cols.indexOf("ExchangeCode"), iSeries = cols.indexOf("Series"), iIsin = cols.indexOf("ISINCode");
  const pairs = [];
  const seen = new Set();
  for (const line of lines.slice(1)) {
    const c = line.split(",").map((x) => x.trim().replace(/^"|"$/g, ""));
    if (!c[iShort] || !c[iExch]) continue;
    if (!["EQ", "BE", "BZ", "SM", "ST"].includes(c[iSeries]) || seen.has(c[iExch])) continue;
    seen.add(c[iExch]);
    pairs.push([c[iShort], c[iExch], c[iIsin] || ""]);
  }
  store.write("icici-scrips", { v: 2, at: Date.now(), pairs });
  return (scrips = { at: Date.now(), pairs, ...build(pairs) });
}

// ---------- live prices from Kotak Neo (for the latest chart candle) ----------
// Kotak quotes stocks by its numeric code (RELIANCE = nse_cm|2885), listed in its daily scrip master.
let kotakCodes = null;
async function kotakScrips(a, s) {
  const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  if (kotakCodes?.day === today) return kotakCodes;
  const saved = store.read("kotak-scrips", null);
  if (saved?.day === today) return (kotakCodes = saved);
  const r = await http(`${s.baseUrl}/script-details/1.0/masterscrip/file-paths`, { headers: { Authorization: a.accessToken, accept: "application/json" } });
  const files = r.body?.data?.filesPaths || [];
  const out = { day: today, nse_cm: {}, bse_cm: {} };
  for (const seg of ["nse_cm", "bse_cm"]) {
    const url = files.find((f) => f.includes(`/${seg}`) && f.endsWith(".csv")); // e.g. .../nse_cm-v1.csv
    if (!url) continue;
    const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) continue;
    const lines = (await res.text()).split(/\r?\n/);
    const cols = lines[0].split(",").map((c) => c.trim());
    const iCode = cols.indexOf("pSymbol"), iTrd = cols.indexOf("pTrdSymbol");
    for (const line of lines.slice(1)) {
      const c = line.split(",");
      const [name, series = "EQ"] = String(c[iTrd] || "").split("-");
      // The EQ listing wins over BE / BZ / SM listings of the same stock.
      if (name && c[iCode] && (series === "EQ" || !out[seg][name])) out[seg][name] = c[iCode];
    }
  }
  if (!Object.keys(out.nse_cm).length) throw fail("Kotak's scrip master couldn't be read.", 502);
  store.write("kotak-scrips", out);
  return (kotakCodes = out);
}

// Latest traded price of an Indian stock (YAHOO:X.NS / X.BO) from the first logged-in Kotak Neo
// account, or null when none is logged in or Kotak doesn't know the stock. Cached 2 s, so several
// charts of one stock make one call.
const kotakLtpCache = new Map();
export async function kotakLtp(symbol) {
  const m = /^YAHOO:(.+)\.(NS|BO)$/.exec(symbol || "");
  if (!m) return null;
  const a = accounts().find((x) => x.broker === "kotak" && session(x.id));
  if (!a) return null;
  const hit = kotakLtpCache.get(symbol);
  if (hit && Date.now() - hit.at < 2000) return hit.ltp;
  const s = session(a.id);
  const seg = m[2] === "NS" ? "nse_cm" : "bse_cm";
  const code = (await kotakScrips(a, s))[seg][m[1]];
  if (!code) return null;
  const r = await http(`${s.baseUrl}/script-details/1.0/quotes/neosymbol/${encodeURIComponent(`${seg}|${code}`)}/ltp`, {
    headers: { Authorization: a.accessToken, accept: "application/json" },
  });
  const ltp = Number(Array.isArray(r.body) ? r.body[0]?.ltp : NaN);
  const val = ltp > 0 ? ltp : null;
  kotakLtpCache.set(symbol, { at: Date.now(), ltp: val });
  return val;
}

// ---------- Kotak quotes for the order flow recorder ----------
const kotakAccount = () => accounts().find((x) => x.broker === "kotak" && session(x.id));
export const kotakReady = () => !!kotakAccount();

function needKotak() {
  const a = kotakAccount();
  if (!a) throw fail("Log in to Kotak in the app to record order flow.");
  return a;
}

export async function kotakCode(seg, name) {
  const a = needKotak();
  const code = (await kotakScrips(a, session(a.id)))[seg]?.[name];
  if (!code) throw fail(`Kotak has no code for ${name}.`);
  return code;
}

// The nearest monthly future of an underlying, e.g. NIFTY -> NIFTY26NOVFUT. Expired ones leave Kotak's list.
export async function kotakNearFuture(seg, underlying) {
  const a = needKotak();
  const s = session(a.id);
  const r = await http(`${s.baseUrl}/script-details/1.0/masterscrip/file-paths`, { headers: { Authorization: a.accessToken, accept: "application/json" } });
  const url = (r.body?.data?.filesPaths || []).find((f) => f.includes(`/${seg}`) && f.endsWith(".csv"));
  if (!url) throw fail(`Kotak's ${seg} list isn't available.`, 502);
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw fail(`Kotak's ${seg} list couldn't be read.`, 502);
  const lines = (await res.text()).split(/\r?\n/);
  const cols = lines[0].split(",").map((c) => c.trim());
  const iCode = cols.indexOf("pSymbol"), iTrd = cols.indexOf("pTrdSymbol");
  const pattern = new RegExp(`^${underlying}(\\d{2})([A-Z]{3})FUT$`);
  let best = null;
  for (const line of lines.slice(1)) {
    const c = line.split(",");
    const m = pattern.exec(c[iTrd] || "");
    if (!m) continue;
    const when = +m[1] * 12 + "JANFEBMARAPRMAYJUNJULAUGSEPOCTNOVDEC".indexOf(m[2]) / 3;
    if (!best || when < best.when) best = { when, code: c[iCode] };
  }
  if (!best) throw fail(`Kotak lists no ${underlying} future.`, 502);
  return best.code;
}

export async function kotakQuotes(keys) {
  const a = needKotak();
  const r = await http(`${session(a.id).baseUrl}/script-details/1.0/quotes/neosymbol/${keys.map(encodeURIComponent).join(",")}/all`, {
    headers: { Authorization: a.accessToken, accept: "application/json" },
  });
  if (!Array.isArray(r.body)) throw fail(`Kotak quotes failed: ${kotakMsg(r)}`, 502);
  return r.body;
}

// ---------- every Kotak stock and F&O contract, for search and orders ----------
// Company names can hold commas inside quotes, which would shift the columns after them.
function csvCells(line) {
  if (!line.includes('"')) return line.split(",");
  const out = [];
  let cell = "", quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) {
      out.push(cell);
      cell = "";
    } else cell += ch;
  }
  out.push(cell);
  return out;
}

const MONTHS = "JANFEBMARAPRMAYJUNJULAUGSEPOCTNOVDEC";

// One of Kotak's daily files as contracts. Its tick is in paise. The file's expiry column uses
// different epochs by exchange, so the date is read from pScripRefKey (NIFTY09NOV2623900.00CE).
export function parseContracts(csv, seg, today) {
  const lines = csv.split(/\r?\n/);
  const cols = csvCells(lines[0]).map((c) => c.trim());
  const at = Object.fromEntries(cols.map((c, i) => [c, i]));
  const isFo = seg.endsWith("_fo");
  const out = [];
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const c = csvCells(line);
    const token = c[at.pSymbol], trd = c[at.pTrdSymbol], name = c[at.pSymbolName];
    const tick = n(c[at.dTickSize]) / 100;
    if (!/^\d+$/.test(token || "") || !trd || !name || !(tick > 0)) continue;
    if (isFo) {
      const m = /^(\d{2})([A-Z]{3})(\d{2})/.exec(String(c[at.pScripRefKey] || "").slice(name.length));
      const lot = n(c[at.lLotSize]);
      if (!m || !Number.isInteger(lot) || lot < 1) continue;
      const expiry = `20${m[3]}-${String(MONTHS.indexOf(m[2]) / 3 + 1).padStart(2, "0")}-${m[1]}`;
      if (expiry < today) continue;
      const opt = /^(CE|PE)$/.test(c[at.pOptionType]) ? c[at.pOptionType] : "FUT";
      out.push({ seg, token, trd, name, kind: "fo", opt, strike: opt === "FUT" ? 0 : n(c[at["dStrikePrice;"]]) / 100, lot, tick, expiry });
    } else {
      if (seg === "nse_cm" ? !/-(EQ|BE|BZ|SM|ST)$/.test(trd) : /^(F|G|GS)$/.test(c[at.pGroup])) continue;
      out.push({ seg, token, trd, name, kind: "eq", opt: "", strike: 0, lot: 1, tick, expiry: "" });
    }
  }
  return out;
}

// Every word must match. The exact underlying comes first (NIFTY before BANKNIFTY), then stocks,
// futures, the nearest expiry and the strike.
export function searchContracts(rows, query, limit = 40) {
  const words = String(query || "").toUpperCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hits = rows.filter((r) => words.every((w) => `${r.name} ${r.trd} ${r.strike || ""} ${r.opt} ${r.expiry}`.toUpperCase().includes(w)));
  const rank = (r) => (r.name === words[0] ? 0 : 1) * 10 + (r.kind === "eq" ? 0 : r.opt === "FUT" ? 1 : 2);
  return hits
    .sort((a, b) => rank(a) - rank(b) || a.expiry.localeCompare(b.expiry) || a.strike - b.strike || a.seg.localeCompare(b.seg))
    .slice(0, limit);
}

let contracts = null, contractsLoading = null;
async function kotakContracts() {
  const day = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  if (contracts?.day === day) return contracts;
  const a = needKotak();
  contractsLoading ||= (async () => {
    const r = await http(`${session(a.id).baseUrl}/script-details/1.0/masterscrip/file-paths`, { headers: { Authorization: a.accessToken, accept: "application/json" } });
    const files = r.body?.data?.filesPaths || [];
    const rows = [];
    for (const seg of ["nse_cm", "bse_cm", "nse_fo", "bse_fo"]) {
      const url = files.find((f) => f.includes(`/${seg}`) && f.endsWith(".csv"));
      if (!url) throw fail(`Kotak's ${seg} list isn't available.`, 502);
      const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
      if (!res.ok) throw fail(`Kotak's ${seg} list couldn't be read.`, 502);
      rows.push(...parseContracts(await res.text(), seg, day));
    }
    contracts = { day, rows, byKey: new Map(rows.map((c) => [`${c.seg}|${c.token}`, c])) };
    return contracts;
  })().finally(() => (contractsLoading = null));
  return contractsLoading;
}

export const kotakSearch = async (query) => searchContracts((await kotakContracts()).rows, query);

// F&O chart symbols are NFO:NIFTY26N0923900CE and BFO:SENSEX26NOVFUT.
export const isFoSymbol = (s) => /^[NB]FO:/.test(s || "");
export const foSymbol = (seg, trd) => `${seg === "bse_fo" ? "BFO" : "NFO"}:${trd}`;

// Never waits for Kotak's large lists: the first search starts loading them and the next ones find them.
export function kotakFoResults(query) {
  if (!kotakReady() || String(query || "").trim().length < 3) return [];
  if (!contracts) {
    kotakContracts().catch(() => {});
    return [];
  }
  const label = (c) => (c.opt === "FUT" ? `${c.name} future, ${c.expiry}` : `${c.name} ${c.strike} ${c.opt}, ${c.expiry}`);
  return searchContracts(contracts.rows, query, 60)
    .filter((c) => c.kind === "fo")
    .slice(0, 15)
    .map((c) => ({ symbol: foSymbol(c.seg, c.trd), name: label(c), type: "F&O", exchange: c.seg === "bse_fo" ? "BFO" : "NFO" }));
}

// Its quote key. Kept once found, so a saved chart still opens before you log in the next day.
export async function foKeyOf(symbol) {
  const saved = store.read("fo-chart-keys", {});
  if (saved[symbol]) return saved[symbol];
  const [prefix, trd] = symbol.split(":");
  const seg = prefix === "BFO" ? "bse_fo" : "nse_fo";
  if (!kotakReady()) throw fail("Log in to Kotak in the Broker tab to open this F&O chart.", 400);
  const c = (await kotakContracts()).rows.find((x) => x.seg === seg && x.trd === trd);
  if (!c) throw fail(`Kotak doesn't list ${trd} today. It may have expired.`, 400);
  store.write("fo-chart-keys", { ...saved, [symbol]: `${seg}|${c.token}` });
  return `${seg}|${c.token}`;
}

export async function kotakContract(seg, token) {
  const c = (await kotakContracts()).byKey.get(`${seg}|${token}`);
  if (!c) throw fail("Kotak doesn't list that contract today. It may have expired.");
  return c;
}

// Checks a stock or F&O order against the contract itself, before anything is sent.
export function checkContractOrder(c, input) {
  const side = String(input.side || "").toUpperCase();
  const type = String(input.type || "").toUpperCase();
  const product = String(input.product || "").toUpperCase();
  const qty = Number(input.qty), price = Number(input.price), trigger = Number(input.trigger);
  const onTick = (v) => Math.abs(v / c.tick - Math.round(v / c.tick)) < 1e-6;
  if (!["BUY", "SELL"].includes(side)) throw fail("Side must be BUY or SELL.");
  if (!["MARKET", "LIMIT", "SL", "SL-M"].includes(type)) throw fail("Order type must be MARKET, LIMIT, SL or SL-M.");
  if (!(c.kind === "fo" ? ["NRML", "MIS"] : ["CNC", "MIS"]).includes(product)) throw fail(c.kind === "fo" ? "An F&O order's product is NRML or MIS." : "A stock order's product is CNC or MIS.");
  if (!Number.isInteger(qty) || qty < 1 || qty % c.lot) throw fail(c.kind === "fo" ? `Quantity must be a whole number of lots of ${c.lot}.` : "Quantity must be a whole number, 1 or more.");
  if ((type === "LIMIT" || type === "SL") && !(price > 0)) throw fail("Enter a limit price.");
  if ((type === "SL" || type === "SL-M") && !(trigger > 0)) throw fail("Enter a trigger price.");
  if (price > 0 && !onTick(price)) throw fail(`${c.trd} moves in steps of ₹${c.tick}: change the price to fit.`);
  if (trigger > 0 && !onTick(trigger)) throw fail(`${c.trd} moves in steps of ₹${c.tick}: change the trigger to fit.`);
  return { side, type, product, qty, price, trigger };
}

// A REAL order on any Kotak stock or F&O contract, capped by maxOrderValue like every other order.
export async function placeKotakOrder(id, input, ltp) {
  const a = account(id);
  if (a.broker !== "kotak") throw fail("These contracts are for Kotak Neo accounts.");
  const c = await kotakContract(input.seg, input.token);
  const o = checkContractOrder(c, input);
  const refPrice = o.type === "LIMIT" || o.type === "SL" ? o.price : o.type === "SL-M" ? o.trigger : ltp;
  const cap = Number(config().maxOrderValue) || 500000;
  if (!(refPrice > 0)) throw fail("Couldn't get a price to check the order size; use a limit order.");
  if (o.qty * refPrice > cap)
    throw fail(`This order is worth about ₹${Math.round(o.qty * refPrice).toLocaleString("en-IN")}, above your ₹${cap.toLocaleString("en-IN")} limit (maxOrderValue in data/brokers.json).`);
  const what = `${a.name} (${a.id}) ${o.side} ${o.qty} ${c.trd} ${c.seg} ${o.type}${o.price ? ` @${o.price}` : ""}${o.trigger ? ` trig ${o.trigger}` : ""} ${o.product}`;
  try {
    const orderId = await kotakOrder(a, { ...o, tradingSymbol: c.trd, seg: c.seg });
    log(`ORDER ${what} -> accepted, order id ${orderId}`);
    return { ok: true, broker: a.name, orderId };
  } catch (e) {
    log(`ORDER ${what} -> refused: ${e.message}`);
    throw e;
  }
}

// Live prices for app symbols (YAHOO:X.NS / X.BO) in one call, when a Kotak account is logged in.
export async function kotakPrices(symbols) {
  const a = kotakAccount();
  if (!a) return {};
  const codes = await kotakScrips(a, session(a.id));
  const keys = new Map();
  for (const s of symbols) {
    if (isFoSymbol(s)) {
      const key = await foKeyOf(s).catch(() => null);
      if (key) keys.set(key, s);
      continue;
    }
    const m = /^YAHOO:(.+)\.(NS|BO)$/.exec(s);
    const seg = m && (m[2] === "NS" ? "nse_cm" : "bse_cm");
    const code = m && codes[seg]?.[m[1]];
    if (code) keys.set(`${seg}|${code}`, s);
  }
  const out = {};
  const list = [...keys.keys()];
  for (let i = 0; i < list.length; i += 100) {
    for (const q of await kotakQuotes(list.slice(i, i + 100))) {
      const sym = keys.get(`${q.exchange}|${q.exchange_token}`), price = Number(q.ltp), close = Number(q.ohlc?.close);
      if (sym && price > 0) out[sym] = { price, changePct: close > 0 ? ((price - close) / close) * 100 : null };
    }
  }
  return out;
}

// ---------- closing F&O positions (Kotak) ----------
// How much of a position can still be closed: its size less exit orders already working at the broker.
export function exitRoom(positions, orders, fo, product) {
  const pos = positions.find((p) => p.fo?.seg === fo.seg && p.fo.tradingSymbol === fo.tradingSymbol && p.product === product);
  if (!pos?.qty) return { side: null, room: 0 };
  const side = pos.qty > 0 ? "SELL" : "BUY";
  const working = orders
    .filter((o) => o.exSeg === fo.seg && o.trdSym === fo.tradingSymbol && o.trnsTp === side[0] && !/complete|reject|cancel|executed|traded|expired|lapsed/i.test(o.ordSt || ""))
    .reduce((sum, o) => sum + Math.max(0, n(o.qty) - n(o.fldQty)), 0);
  return { side, room: Math.abs(pos.qty) - working };
}

async function kotakBook(a) {
  // Kotak answers "No Data" when the day's list is empty. Any other failure must stop the order.
  const orEmpty = (e) => {
    if (/no data/i.test(e.message)) return { data: [] };
    throw e;
  };
  const [positions, orders] = await Promise.all([kotak(a, "GET", "quick/user/positions").catch(orEmpty), kotak(a, "GET", "quick/user/orders").catch(orEmpty)]);
  return { positions: kotakPositions(positions.data), orders: orders.data || [] };
}

// An open F&O position, read fresh from Kotak, and how much of it can still be closed.
export async function kotakFoPosition(id, tradingSymbol, product) {
  const a = account(id);
  if (a.broker !== "kotak") throw fail("Trailing stops on F&O positions work with Kotak Neo accounts.");
  const { positions, orders } = await kotakBook(a);
  const p = positions.find((x) => x.fo?.tradingSymbol === tradingSymbol && x.product === product && x.qty);
  if (!p) throw fail(`${a.name} has no open ${tradingSymbol} position.`);
  // The contract list knows the price step; without it, a stop falls back to the usual 0.05.
  const tick = await kotakContract(p.fo.seg, p.fo.token).then((c) => c.tick, () => null);
  return { ...p, fo: { ...p.fo, ...(tick ? { tick } : {}) }, room: exitRoom(positions, orders, p.fo, p.product).room };
}

// Only ever reduces a position, checked against Kotak just before sending, so a stop can't open a new
// short after the position was closed by hand. The order value cap isn't used: the position is the cap,
// and a stop mustn't be refused for being large.
export async function placeFnoExit(id, body) {
  const a = account(id);
  const { fo, side, type, product } = body;
  const qty = Number(body.qty), price = Number(body.price);
  if (a.broker !== "kotak") throw fail("F&O exits work with Kotak Neo accounts.");
  if (!["LIMIT", "MARKET"].includes(type)) throw fail("An F&O exit is a limit or market order.");
  if (type === "LIMIT" && !(price > 0)) throw fail("Enter a limit price.");
  if (!Number.isInteger(qty) || qty < 1 || qty % fo.lot) throw fail(`Quantity must be a whole number of lots of ${fo.lot}.`);
  let book;
  try {
    book = await kotakBook(a);
  } catch (e) {
    if (e.status === 401) throw e;
    throw Object.assign(new Error(`Couldn't read your positions from ${a.name}: ${e.message}`), { notSent: true });
  }
  const { side: needed, room } = exitRoom(book.positions, book.orders, fo, product);
  if (side !== needed || qty > room)
    throw fail(`Not sent: ${side} ${qty} would go beyond your open ${fo.tradingSymbol} position (${room} can still be closed).`);
  const what = `${a.name} (${a.id}) ${side} ${qty} ${fo.tradingSymbol} ${type}${price ? ` @${price}` : ""} ${product}`;
  try {
    const orderId = await kotakOrder(a, { side, type, product, qty, price, tradingSymbol: fo.tradingSymbol, seg: fo.seg });
    log(`ORDER ${what} -> accepted, order id ${orderId}`);
    return { ok: true, broker: a.name, orderId };
  } catch (e) {
    log(`ORDER ${what} -> refused: ${e.message}`);
    throw e;
  }
}

// One file out of a zip (stored or deflated), with Node's own zlib: no zip library needed.
export function unzipEntry(buf, name) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw fail("The download isn't a zip file.", 502);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extra = buf.readUInt16LE(p + 30), comment = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const entry = buf.toString("utf8", p + 46, p + 46 + nameLen);
    if (entry === name) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      return method === 8 ? zlib.inflateRawSync(data) : data;
    }
    p += 46 + nameLen + extra + comment;
  }
  throw fail(`${name} isn't in the download.`, 502);
}

async function iciciPortfolio(a) {
  const map = await iciciScrips().catch(() => null);
  // ICICI's codes differ from NSE symbols (HDFBAN = HDFCBANK, NIFJUN = JUNIORBEES), so match by
  // ISIN first, then by ICICI code. A holding with neither (unlisted, like NSE's own shares)
  // keeps ICICI's name and gets no chart.
  const nseOf = (code, isin) => map?.byIsin.get(String(isin || "").replace(/\s+/g, "")) || map?.toNse.get(code) || null;
  const nse = (code, isin) => nseOf(code, isin) || code;
  const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  const yearAgo = new Date(Date.now() - 365 * 86400e3).toISOString().slice(0, 10);
  const [demat, portfolio, positions, funds, orders] = await Promise.all([
    breeze(a, "GET", "dematholdings").catch(() => []),
    // Average prices, where ICICI gives them without a stock code.
    breeze(a, "GET", "portfolioholdings", { exchange_code: "NSE", from_date: `${yearAgo}T06:00:00.000Z`, to_date: `${today}T06:00:00.000Z` }).catch(() => []),
    breeze(a, "GET", "portfoliopositions").catch(() => []),
    breeze(a, "GET", "funds").catch(() => null),
    breeze(a, "GET", "order", { exchange_code: "NSE", from_date: `${today}T00:00:00.000Z`, to_date: `${today}T23:59:59.000Z` }).catch(() => []),
  ]);
  const avgOf = new Map((Array.isArray(portfolio) ? portfolio : []).map((h) => [h.stock_code, n(h.average_price)]));
  return {
    holdings: (Array.isArray(demat) ? demat : [])
      .filter((h) => n(h.quantity) > 0)
      .map((h) => {
        const qty = n(h.quantity), avg = avgOf.get(h.stock_code) || null;
        const listed = nseOf(h.stock_code, h.stock_ISIN);
        return { symbol: listed ? toApp(listed, "NSE") : null, name: listed || `${h.stock_code} (unlisted)`, qty, avg, ltp: null, value: null, pnl: null, dayChangePct: null };
      }),
    positions: (Array.isArray(positions) ? positions : [])
      .filter((p) => /cash|equity/i.test(`${p.segment} ${p.product_type}`) || p.exchange_code === "NSE")
      .map((p) => {
        const qty = n(p.quantity) * (/sell/i.test(p.action) ? -1 : 1);
        return { symbol: toApp(nse(p.stock_code), "NSE"), name: nse(p.stock_code), product: p.product_type, qty, avg: n(p.average_price) || null, ltp: n(p.ltp) || null, pnl: p.pnl != null ? n(p.pnl) : null };
      })
      .filter((p) => p.qty !== 0 || p.pnl),
    funds: funds ? { available: n(funds.allocated_equity) - n(funds.block_by_trade_equity), used: n(funds.block_by_trade_equity) } : null,
    orders: (Array.isArray(orders) ? orders : []).map((o) => ({
      id: String(o.order_id || "").replace(/\s+/g, ""),
      time: String(o.order_datetime || "").replace(/\s+/g, " "),
      name: nse(o.stock_code),
      symbol: nse(o.stock_code) ? toApp(nse(o.stock_code), "NSE") : null,
      product: o.product_type,
      side: String(o.action || "").toUpperCase(),
      qty: n(o.quantity),
      type: o.order_type,
      price: n(o.average_price) || n(o.price),
      status: o.status,
      message: "",
    })),
    // The server fills prices, values and P&L from live quotes (ICICI's demat list has none).
    fillValues: true,
  };
}

async function iciciOrder(a, o) {
  if (o.type === "MARKET" || o.type === "SL-M")
    throw fail("ICICI Direct doesn't allow market orders through its API (SEBI rule). Use a limit or stop-loss limit order.");
  if (o.product !== "CNC") throw fail("ICICI Direct's API doesn't allow intraday margin orders. Use Delivery (CNC).");
  const map = await iciciScrips();
  const code = map.toIcici.get(o.tradingSymbol);
  if (!code) throw fail(`${o.tradingSymbol} isn't in ICICI's list of NSE stocks.`);
  const d = await breeze(a, "POST", "order", {
    stock_code: code,
    exchange_code: "NSE",
    product: "cash",
    action: o.side.toLowerCase(),
    order_type: o.type === "SL" ? "stoploss" : "limit",
    quantity: String(o.qty),
    price: String(o.price),
    ...(o.type === "SL" ? { stoploss: String(o.trigger) } : {}),
    validity: "day",
    user_remark: "quantterm",
  });
  if (!d?.order_id) throw fail(`${a.name}: ${d?.message || "no order id returned"}`, 502);
  return String(d.order_id).replace(/\s+/g, "");
}

// ---------- shared ----------
export async function portfolio(id) {
  const a = account(id);
  if (a.broker === "zerodha") return kitePortfolio(a);
  if (a.broker === "kotak") return kotakPortfolio(a);
  return iciciPortfolio(a);
}

export function logout(id) {
  saveSession(account(id).id, null);
}

export const accountOf = account;

// ---------- closing stock positions (any broker) ----------
const OPEN_ORDER = (status) => !/complete|reject|cancel|executed|traded|expired|lapsed/i.test(status || "");

// A stock position from a portfolio, and how much of it can still be closed: its size less exit
// orders already working at the broker.
export function stockExitRoom(pf, symbol, product) {
  const pos = pf.positions.find((p) => p.symbol === symbol && p.product === product && p.qty);
  if (!pos) return { side: null, room: 0, qty: 0 };
  const side = pos.qty > 0 ? "SELL" : "BUY";
  const working = pf.orders.filter((o) => o.symbol === symbol && o.product === product && o.side === side && OPEN_ORDER(o.status)).reduce((sum, o) => sum + n(o.qty), 0);
  return { side, room: Math.abs(pos.qty) - working, qty: pos.qty };
}

export async function stockPosition(id, symbol, product) {
  const r = stockExitRoom(await portfolio(id), symbol, product);
  if (!r.side) throw fail(`${account(id).name} has no open ${String(symbol).replace(/^YAHOO:|\.NS$/g, "")} ${product} position.`);
  return r;
}

// Only ever reduces a stock position, checked against the broker just before sending, so a stop
// can't open a new position after the old one was closed by hand. No order value cap: the position is.
export async function placeStockExit(id, body, ltp) {
  let pf;
  try {
    pf = await portfolio(id);
  } catch (e) {
    if (e.status === 401) throw e;
    throw Object.assign(new Error(`Couldn't read your positions from ${account(id).name}: ${e.message}`), { notSent: true });
  }
  const { side, room } = stockExitRoom(pf, body.symbol, String(body.product || "").toUpperCase());
  const qty = Number(body.qty);
  if (String(body.side).toUpperCase() !== side || qty > room)
    throw fail(`Not sent: ${body.side} ${qty} would go beyond your open ${String(body.symbol).replace(/^YAHOO:|\.NS$/g, "")} position (${Math.max(0, room)} can still be closed).`);
  return placeOrder(id, body, ltp, { exit: true });
}

// What became of an order, from the broker's order book.
export async function orderFill(id, orderId) {
  const o = (await portfolio(id)).orders.find((x) => String(x.id) === String(orderId));
  if (!o) return { state: "open" };
  if (/^(complete|traded|executed|fully executed)$/i.test(String(o.status).trim())) return { state: "filled", price: n(o.price), qty: n(o.qty), status: o.status };
  if (OPEN_ORDER(o.status)) return { state: "open", status: o.status };
  return { state: "closed", status: o.status };
}

// Validates everything before anything is sent: a real order with real money.
export async function placeOrder(id, body, ltp, { exit = false } = {}) {
  const a = account(id);
  const side = String(body.side || "").toUpperCase();
  const type = String(body.type || "").toUpperCase();
  const product = String(body.product || "").toUpperCase();
  const qty = Number(body.qty);
  const price = Number(body.price);
  const trigger = Number(body.trigger);
  if (!["BUY", "SELL"].includes(side)) throw fail("Side must be BUY or SELL.");
  if (!["MARKET", "LIMIT", "SL", "SL-M"].includes(type)) throw fail("Order type must be MARKET, LIMIT, SL or SL-M.");
  if (!["CNC", "MIS"].includes(product)) throw fail("Product must be CNC (delivery) or MIS (intraday).");
  if (!Number.isInteger(qty) || qty < 1) throw fail("Quantity must be a whole number of shares, 1 or more.");
  if ((type === "LIMIT" || type === "SL") && !(price > 0)) throw fail("Enter a limit price.");
  if ((type === "SL" || type === "SL-M") && !(trigger > 0)) throw fail("Enter a trigger price.");
  const tradingSymbol = fromApp(body.symbol);
  const refPrice = type === "LIMIT" || type === "SL" ? price : type === "SL-M" ? trigger : ltp;
  const cap = Number(config().maxOrderValue) || 500000;
  if (!exit && !(refPrice > 0)) throw fail("Couldn't get a price to check the order size; use a limit order.");
  if (!exit && qty * refPrice > cap)
    throw fail(`This order is worth about ₹${Math.round(qty * refPrice).toLocaleString("en-IN")}, above your ₹${cap.toLocaleString("en-IN")} limit (maxOrderValue in data/brokers.json).`);
  const o = { side, type, product, qty, price, trigger, tradingSymbol };
  // Every order attempt and its answer go to data/server.log (no keys or tokens).
  const what = `${a.name} (${a.id}) ${side} ${qty} ${tradingSymbol} ${type}${price ? ` @${price}` : ""}${trigger ? ` trig ${trigger}` : ""} ${product}`;
  try {
    const orderId = a.broker === "zerodha" ? await kiteOrder(a, o) : a.broker === "kotak" ? await kotakOrder(a, o) : await iciciOrder(a, o);
    log(`ORDER ${what} -> accepted, order id ${orderId}`);
    return { ok: true, broker: a.name, orderId };
  } catch (e) {
    log(`ORDER ${what} -> refused: ${e.message}`);
    throw e;
  }
}
