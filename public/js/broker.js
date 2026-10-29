// Broker tab (bottom): every broker account in data/brokers.json (Zerodha, Kotak Neo, ICICI
// Direct, several of each), with holdings, positions, funds, today's orders, and an order ticket
// for the active chart. Orders are REAL: each one is confirmed before it is sent.
import { api, esc, fmtPrice, fmtNum, fmtPct, ticker } from "./api.js";

// One watchlist section per account, named after the account. Filled from the server's account
// list, so an account added to brokers.json gets its own section with nothing else to change.
export const BROKER_LISTS = [];
const view = { broker: null, data: {}, status: null, loginError: {}, pane: "portfolio", ticket: { side: "BUY", type: "LIMIT", product: "CNC", qty: 1 } };
const accountsOf = () => view.status?.accounts || [];
const acctOf = (id) => accountsOf().find((a) => a.id === id);
const nameOf = (id) => acctOf(id)?.name || id;

function setStatus(st, panels) {
  view.status = st;
  const names = st.accounts.map((a) => a.name);
  if (names.join("|") !== BROKER_LISTS.join("|")) {
    BROKER_LISTS.splice(0, BROKER_LISTS.length, ...names);
    panels?.refreshWatchlist?.();
  }
}

const inr = (v) =>
  v == null || !Number.isFinite(v) ? "—" : `₹${v.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const pnlCell = (v) =>
  v == null ? "<td>—</td>" : `<td class="${v >= 0 ? "up" : "down"}">${inr(v)}</td>`;

// Holdings become a watchlist section per account, refreshed on each load.
function syncWatchlist(app, id, holdings, panels) {
  const syms = [...new Set(holdings.map((h) => h.symbol).filter(Boolean))];
  if (!syms.length) return;
  const name = nameOf(id);
  const prev = app.state.watchlists[name] || [];
  if (prev.length === syms.length && prev.every((s, i) => s === syms[i])) return;
  app.state.watchlists[name] = syms;
  app.persist();
  panels?.refreshWatchlist?.();
}

async function load(app, id, panels) {
  view.data[id] = await api.get(`/api/broker/${encodeURIComponent(id)}/portfolio`);
  syncWatchlist(app, id, view.data[id].holdings, panels);
  return view.data[id];
}

// On start: pick up connected accounts' holdings, and finish a login redirect.
export async function initBroker(app, panels) {
  const url = new URL(location.href);
  const back = url.searchParams.get("broker");
  if (back) {
    const acct = url.searchParams.get("acct");
    const msg = url.searchParams.get("msg");
    for (const k of ["broker", "acct", "msg"]) url.searchParams.delete(k);
    history.replaceState(null, "", url.pathname + url.search);
    if (acct) view.broker = acct;
    if (back === "ok") app.toast("Broker account connected.");
    else {
      if (acct) view.loginError[acct] = msg || "The login didn't complete.";
      app.toast(msg || "The login didn't complete.", "err");
    }
    panels.showBottom("broker");
  }
  try {
    setStatus(await api.get("/api/broker/status"), panels);
    for (const a of accountsOf()) if (a.connected) await load(app, a.id, panels).catch(() => {});
  } catch {
    /* the broker tab shows the problem when opened */
  }
}

// What to do to connect each kind of account, with this account's own id in the URLs.
function setupHtml(a, file) {
  const f = `<code>${esc(file)}</code>`;
  const where = `in the account with <code>"id": "${esc(a.id)}"</code>`;
  if (a.broker === "zerodha")
    return `<p>To connect <b>${esc(a.name)}</b> (Zerodha):</p><ol class="hint-text">
      <li>Log in to <b>developers.kite.trade</b> with this Zerodha account and create a Kite Connect app. Each app works with one Zerodha client ID only.</li>
      <li>Set its <b>Redirect URL</b> to <code>http://127.0.0.1:3777/api/broker/kite/callback</code>.</li>
      <li>Paste its API key and secret into <code>"apiKey"</code> and <code>"apiSecret"</code> ${where} in ${f}, save, then reopen this tab.</li></ol>`;
  if (a.broker === "kotak")
    return `<p>To connect <b>${esc(a.name)}</b> (Kotak Neo):</p><ol class="hint-text">
      <li>Register for TOTP once at <b>kotaksecurities.com/platform/kotak-neo-trade-api</b>, scanning the QR code with Google or Microsoft Authenticator.</li>
      <li>In Neo, go to <b>More &gt; Trade API</b>, generate an application and copy its token (the consumer key). Whitelist this computer's IP on that application for orders.</li>
      <li>Put the token in <code>"accessToken"</code>, the registered mobile number with +91 in <code>"mobileNumber"</code> and the client code in <code>"ucc"</code> ${where} in ${f}, save, then reopen this tab.</li></ol>`;
  return `<p>To connect <b>${esc(a.name)}</b> (ICICI Direct, Breeze API):</p><ol class="hint-text">
      <li>Log in to <b>api.icicidirect.com</b> with this ICICI Direct account and register an app (Breeze API).</li>
      <li>Set its <b>Redirect URL</b> to <code>http://127.0.0.1:3777/api/broker/${esc(a.id)}/callback</code>, and register this computer's static IP (ICICI only accepts API orders from it).</li>
      <li>Paste the App Key and Secret Key into <code>"apiKey"</code> and <code>"apiSecret"</code> ${where} in ${f}, save, then reopen this tab.</li></ol>
      <p class="hint-text">ICICI's API rules: limit and stop-loss limit orders only (no market orders), delivery (CNC) only, NSE only.</p>`;
}

export async function renderBroker(el, app, panels) {
  el.innerHTML = '<div class="pad hint-text">Loading your broker accounts…</div>';
  try {
    setStatus(await api.get("/api/broker/status"), panels);
  } catch (e) {
    el.innerHTML = `<div class="pad hint-text">${esc(e.message)}</div>`;
    return;
  }
  const list = accountsOf();
  if (!list.length) {
    el.innerHTML = `<div class="pad hint-text">No broker accounts in <code>${esc(view.status.file)}</code> yet.</div>`;
    return;
  }
  if (!view.broker || !acctOf(view.broker)) view.broker = (list.find((a) => a.connected) || list[0]).id;
  const b = view.broker;
  const s = acctOf(b);

  const tabs = list
    .map((a) => `<button class="btn small ${a.id === b ? "primary" : ""}" data-b="${esc(a.id)}" title="${esc(a.brokerName)}${a.connected ? ", connected" : ""}">${esc(a.name)}${a.connected ? " ●" : ""}</button>`)
    .join("");

  let body;
  if (!s.configured) {
    body = setupHtml(s, view.status.file) + `<p class="hint-text">Your keys stay in that file on this computer and are only sent to your own broker.</p>`;
  } else if (!s.connected) {
    const err = view.loginError[b] ? `<p class="down">Last login attempt: ${esc(view.loginError[b])}</p>` : "";
    body =
      err +
      (s.broker === "kotak"
        ? `<p>${esc(s.name)} needs a login once a day. Your TOTP and MPIN go straight to Kotak and aren't saved.</p>
           <div class="row-flex"><label class="field">TOTP<input id="brTotp" inputmode="numeric" maxlength="6" autocomplete="one-time-code" style="width:90px"></label>
           <label class="field">MPIN<input id="brMpin" type="password" inputmode="numeric" maxlength="6" autocomplete="off" style="width:90px"></label>
           <button class="btn primary" id="brLogin" style="align-self:end">Log in to ${esc(s.name)}</button></div>`
        : `<p>${esc(s.name)} needs a login once a day. ${esc(s.brokerName)}'s own login page opens in a pop-up window.</p><button class="btn primary" id="brLogin">Log in to ${esc(s.name)}</button>`);
  } else {
    view.loginError[b] = null;
    body = `<div id="brData" class="hint-text">Loading ${esc(s.name)} portfolio…</div>`;
  }

  el.innerHTML = `<div class="pad"><div class="row-flex" style="flex-wrap:wrap">${tabs}<span class="spacer"></span>${
    s.connected
      ? `<span class="hint-text" style="align-self:center">Logged in as ${esc(s.user || "")}</span><button class="btn small" id="brRefresh">Refresh</button><button class="btn small" id="brLogout">Log out</button>`
      : ""
  }</div><div style="margin-top:8px">${body}</div></div>`;

  el.querySelectorAll("[data-b]").forEach((x) => (x.onclick = () => ((view.broker = x.dataset.b), renderBroker(el, app, panels))));
  const login = el.querySelector("#brLogin");
  if (login)
    login.onclick = async () => {
      if (s.broker !== "kotak") return loginPopup(el, app, panels, s);
      login.disabled = true;
      try {
        await api.post(`/api/broker/${encodeURIComponent(b)}/login`, {
          totp: el.querySelector("#brTotp").value.trim(),
          mpin: el.querySelector("#brMpin").value.trim(),
        });
        app.toast(`${s.name} connected.`);
      } catch (e) {
        app.toast(e.message, "err");
      }
      renderBroker(el, app, panels);
    };
  const out = el.querySelector("#brLogout");
  if (out)
    out.onclick = async () => {
      await api.post(`/api/broker/${encodeURIComponent(b)}/logout`).catch(() => {});
      renderBroker(el, app, panels);
    };
  const refresh = el.querySelector("#brRefresh");
  if (refresh) refresh.onclick = () => renderBroker(el, app, panels);

  if (s.connected) {
    // Kotak only takes API orders from a whitelisted IP: show which address it sees.
    if (s.broker === "kotak")
      api.get(`/api/broker/${encodeURIComponent(b)}/ip`).then(
        (r) => {
          el.querySelector("#brData")?.insertAdjacentHTML(
            "beforebegin",
            `<p class="hint-text" id="brIp">Kotak sees this computer's IP as <b>${esc(r.ip)}</b>. Orders only go through once this IP is whitelisted on this account's Trade API application in Neo (More &gt; Trade API).</p>`,
          );
        },
        () => {},
      );
    if (s.broker === "icici")
      el.querySelector("#brData")?.insertAdjacentHTML(
        "beforebegin",
        `<p class="hint-text">ICICI Direct's API takes limit and stop-loss limit orders for delivery (CNC) only, from the static IP registered with this API key.</p>`,
      );
    try {
      drawPortfolio(el, app, panels, b, await load(app, b, panels));
    } catch (e) {
      el.querySelector("#brData").textContent = e.message;
    }
  }
}

// The broker's own login page in a pop-up: your password and TOTP go to the broker, never to
// this app. When the broker sends the pop-up back, it closes itself and the app loads the account.
let loginWatch = null;
function loginPopup(el, app, panels, a) {
  const w = 520, h = 720;
  const left = Math.max(0, screenX + (outerWidth - w) / 2), top = Math.max(0, screenY + (outerHeight - h) / 2);
  const url = `/api/broker/${encodeURIComponent(a.id)}/login?popup=1`;
  const win = open(url, `login-${a.id}`, `popup,width=${w},height=${h},left=${left},top=${top}`);
  if (win) {
    win.focus();
    app.toast(`Log in on ${a.brokerName}'s page in the pop-up window.`);
  } else {
    // Pop-ups blocked: offer a new tab instead of leaving the app, and keep watching for the login.
    el.querySelector("#brLogin")?.insertAdjacentHTML(
      "afterend",
      `<p class="hint-text" id="brBlocked">Your browser blocked the pop-up. Allow pop-ups for this site, or <a href="${url}" target="_blank" rel="opener">open the ${esc(a.brokerName)} login in a new tab</a>. This tab will connect by itself when you finish.</p>`,
    );
  }
  clearInterval(loginWatch);
  const done = (ok, msg) => {
    clearInterval(loginWatch);
    loginWatch = null;
    removeEventListener("message", onMsg);
    view.broker = a.id;
    if (ok) {
      view.loginError[a.id] = null;
      app.toast(`${a.name} connected.`);
    } else if (msg) {
      view.loginError[a.id] = msg;
      app.toast(msg, "err");
    }
    renderBroker(el, app, panels);
  };
  const onMsg = (e) => {
    if (e.data?.quantTerminalBroker === a.id) done(e.data.ok, e.data.msg);
  };
  addEventListener("message", onMsg);
  // Also check the server, in case the pop-up's message can't reach this tab. Give up after 10 minutes.
  const started = Date.now();
  loginWatch = setInterval(async () => {
    const st = await api.get("/api/broker/status").catch(() => null);
    if (st?.accounts?.find((x) => x.id === a.id)?.connected) return done(true);
    if (win?.closed || Date.now() - started > 600e3) done(false, "");
  }, 1500);
}

function drawPortfolio(el, app, panels, b, d) {
  const box = el.querySelector("#brData");
  if (!box) return;
  const totalValue = d.holdings.reduce((a, h) => a + (h.value || 0), 0);
  const totalPnl = d.holdings.reduce((a, h) => a + (h.pnl || 0), 0);
  const row = (sym, cells) =>
    `<tr ${sym ? `data-s="${esc(sym)}" style="cursor:pointer"` : ""}>${cells}</tr>`;
  // Orders still working at the broker (open, trigger pending, ...) apart from finished ones.
  const isOpen = (o) => !/complete|reject|cancel|executed|traded|expired|lapsed/i.test(o.status || "");
  const openOrders = d.orders.filter(isOpen), doneOrders = d.orders.filter((o) => !isOpen(o));
  const orderTable = (list) =>
    `<table class="t"><thead><tr><th class="l">Time</th><th class="l">Stock</th><th>Side</th><th>Product</th><th>Qty</th><th>Type</th><th>Price</th><th class="l">Status</th></tr></thead><tbody>${list
      .map(
        (o) =>
          `<tr ${o.symbol ? `data-s="${esc(o.symbol)}" style="cursor:pointer"` : ""}><td class="l muted">${esc(String(o.time || "").slice(-8))}</td><td class="l">${esc(o.name)}</td><td class="${o.side === "BUY" ? "up" : "down"}">${esc(o.side)}</td><td>${esc(o.product || "")}</td><td>${fmtNum(o.qty, 0)}</td><td>${esc(o.type)}</td><td>${o.price ? fmtPrice(o.price) : "—"}</td><td class="l" title="${esc(o.message)}">${esc(o.status)}${o.message ? ` <span class="muted">${esc(o.message.slice(0, 40))}</span>` : ""}</td></tr>`,
      )
      .join("")}</tbody></table>`;
  const panes = [
    ["portfolio", `Portfolio <span class="n">${d.holdings.length}</span>`],
    ["orders", `Orders <span class="n">${openOrders.length ? `${openOrders.length} open` : d.orders.length}</span>`],
    ["positions", `Positions <span class="n">${d.positions.length}</span>`],
    ["gtt", `GTT orders <span class="n" id="brGttCount">…</span>`],
  ];
  const pane = (id) => `class="br-pane" data-pane="${id}" ${view.pane === id ? "" : "hidden"}`;
  box.className = "";
  box.innerHTML = `<div class="tester"><div class="left">
    ${ticketHtml(app, b)}
    <h4>Funds</h4>
    <div class="fin-stats">${
      d.funds
        ? `<div><span class="muted">Available</span><b>${inr(d.funds.available)}</b></div><div><span class="muted">Used</span><b>${inr(d.funds.used)}</b></div>`
        : '<div class="hint-text">Not available</div>'
    }<div><span class="muted">Holdings value</span><b>${inr(totalValue)}</b></div><div><span class="muted">Holdings P&amp;L</span><b class="${totalPnl >= 0 ? "up" : "down"}">${inr(totalPnl)}</b></div></div>
  </div><div class="right">
    <div class="br-tabs">${panes.map(([id, label]) => `<button data-pane="${id}" class="${view.pane === id ? "on" : ""}">${label}</button>`).join("")}</div>
    <div ${pane("gtt")}><div id="brGtt" class="hint-text">Loading GTT orders…</div></div>
    <div ${pane("portfolio")}>
    <h4>Holdings (${d.holdings.length}) <span class="hint-text">also in the "${esc(nameOf(b))}" watchlist</span></h4>
    ${
      d.holdings.length
        ? `<table class="t"><thead><tr><th class="l">Stock</th><th>Qty</th><th>Avg</th><th>LTP</th><th>Day %</th><th>Value</th><th>P&amp;L</th></tr></thead><tbody>${d.holdings
            .map((h) =>
              row(
                h.symbol,
                `<td class="l"><b>${esc(h.name)}</b></td><td>${fmtNum(h.qty, 0)}</td><td>${fmtPrice(h.avg)}</td><td>${fmtPrice(h.ltp)}</td><td class="${(h.dayChangePct || 0) >= 0 ? "up" : "down"}">${h.dayChangePct == null ? "—" : fmtPct(h.dayChangePct)}</td><td>${inr(h.value)}</td>${pnlCell(h.pnl)}`,
              ),
            )
            .join("")}</tbody></table>`
        : '<p class="hint-text">No holdings.</p>'
    }
    </div>
    <div ${pane("positions")}>
    <h4>Positions today (${d.positions.length})</h4>
    ${
      d.positions.length
        ? `<table class="t"><thead><tr><th class="l">Instrument</th><th>Product</th><th>Qty</th><th>Avg</th><th>LTP</th><th>P&amp;L</th></tr></thead><tbody>${d.positions
            .map((p) =>
              row(
                p.symbol,
                `<td class="l">${esc(p.name)}</td><td>${esc(p.product || "")}</td><td>${fmtNum(p.qty, 0)}</td><td>${p.avg == null ? "—" : fmtPrice(p.avg)}</td><td>${p.ltp == null ? "—" : fmtPrice(p.ltp)}</td>${pnlCell(p.pnl)}`,
              ),
            )
            .join("")}</tbody></table>`
        : '<p class="hint-text">No open positions.</p>'
    }
    </div>
    <div ${pane("orders")}>
    <h4>Open (${openOrders.length})</h4>
    ${openOrders.length ? orderTable(openOrders) : '<p class="hint-text">No open orders.</p>'}
    <h4>Executed and closed today (${doneOrders.length})</h4>
    ${doneOrders.length ? orderTable(doneOrders) : '<p class="hint-text">No executed, cancelled or rejected orders today.</p>'}
    </div>
  </div></div>`;
  box.querySelectorAll("tr[data-s]").forEach((tr) => (tr.onclick = () => app.setSymbol(tr.dataset.s)));
  box.querySelectorAll(".br-tabs [data-pane]").forEach(
    (x) =>
      (x.onclick = () => {
        view.pane = x.dataset.pane;
        box.querySelectorAll(".br-tabs [data-pane]").forEach((t) => t.classList.toggle("on", t === x));
        box.querySelectorAll(".br-pane").forEach((pn) => (pn.hidden = pn.dataset.pane !== view.pane));
      }),
  );
  bindTicket(el, app, panels, b);
  drawGtts(el, app, panels, b);
}

// ---------- order window (Zerodha-style) ----------
// Regular: an order sent now. GTT: triggers kept inside Quant Terminal (single, OCO, trailing
// stop) that place the order only when the price gets there. Orders are REAL either way.
const tradable = (sym) => /^YAHOO:[A-Z0-9&\-]+\.NS$/i.test(sym || "");
const T = () => view.ticket;
if (!view.ticket.tab) Object.assign(view.ticket, { tab: "regular", gttKind: "oco", sl: { pct: -5, orderType: "LIMIT", trail: false, trailType: "pct", trailValue: 2 }, tg: { pct: 5, orderType: "LIMIT" } });
const quotesFor = {}; // symbol -> { nse, bse }

// Defaults from the live price, filled in before the window is drawn: the limit price, and GTT
// triggers 5% either side (stop below and target above for a sell, the other way for a buy).
function fillDefaultsFor(app, sym) {
  const t = T();
  const p = quotesFor[sym]?.nse || app.prices[sym];
  if (!p) return;
  const r = (v) => Math.round(v * 20) / 20;
  for (const key of ["sl", "tg"]) {
    const L = t[key];
    if (L.trigger == null && L.pct != null) {
      const down = (key === "sl") === (t.side === "SELL");
      L.pct = down ? -Math.abs(L.pct) : Math.abs(L.pct);
      L.trigger = r(p * (1 + L.pct / 100));
    }
    if (L.orderType === "LIMIT" && L.price == null && L.trigger != null) L.price = L.trigger;
  }
  if (t.price == null) t.price = r(p);
}

function ticketHtml(app, b) {
  const sym = app.active?.cfg.symbol;
  const t = T();
  fillDefaultsFor(app, sym);
  const a = acctOf(b);
  const icici = a?.broker === "icici";
  if (icici) {
    if (!["LIMIT", "SL"].includes(t.type)) t.type = "LIMIT";
    t.product = "CNC";
  }
  if (!tradable(sym))
    return `<div class="ow"><div class="ow-head buy"><b>Order window</b></div><p class="hint-text" style="padding:10px">Open an NSE stock chart (a symbol ending in .NS) to place an order or a GTT on it.</p></div>`;
  const name = ticker(sym).replace(/\.NS$/, "");
  const q = quotesFor[sym] || {};
  const sell = t.side === "SELL";
  const radio = (group, value, label, sub = "", disabled = false) =>
    `<label class="ow-radio ${disabled ? "off" : ""}"><input type="radio" name="${group}" value="${value}" ${t[group === "owProd" ? "product" : group === "owType" ? "type" : group === "owKind" ? "gttKind" : group] === value ? "checked" : ""} ${disabled ? "disabled" : ""}> ${label}${sub ? ` <span class="muted">${sub}</span>` : ""}</label>`;
  const head = `<div class="ow-head ${sell ? "sell" : "buy"}">
      <div class="row-flex" style="align-items:center"><b>${esc(name)}</b><span class="spacer"></span><span class="muted" style="margin-right:6px">${sell ? "Sell" : "Buy"}</span><label class="ow-switch" title="Buy / Sell"><input type="checkbox" id="owSide" ${sell ? "checked" : ""}><span></span></label></div>
      <div class="ow-ex"><label title="Orders go to NSE"><input type="radio" checked> NSE <b id="owNse">${q.nse ? `₹${fmtPrice(q.nse)}` : "…"}</b></label><label class="off" title="BSE orders aren't supported yet"><input type="radio" disabled> BSE <b id="owBse">${q.bse ? `₹${fmtPrice(q.bse)}` : "…"}</b></label></div>
    </div>`;
  const tabs = `<div class="ow-tabs"><button data-tab="regular" class="${t.tab === "regular" ? "on" : ""}">Regular</button><button data-tab="gtt" class="${t.tab === "gtt" ? "on" : ""}">GTT</button><span class="spacer"></span><span class="hint-text">${esc(nameOf(b))}</span></div>`;
  const product = `<div class="row-flex ow-row">${radio("owProd", "MIS", "Intraday", "MIS", icici)}${radio("owProd", "CNC", "Longterm", "CNC")}</div>`;
  let body;
  if (t.tab === "regular") {
    const priceOn = t.type === "LIMIT" || t.type === "SL", trigOn = t.type === "SL" || t.type === "SL-M";
    body = `${product}
      <div class="row-flex ow-row">
        <label class="ow-field">Qty.<input id="owQty" type="number" min="1" step="1" value="${t.qty}"></label>
        <label class="ow-field ${priceOn ? "" : "off"}">Price<input id="owPrice" type="number" step="0.05" min="0" value="${priceOn ? (t.price ?? "") : ""}" ${priceOn ? "" : "disabled"} placeholder="${priceOn ? "" : "Market"}"></label>
        <label class="ow-field ${trigOn ? "" : "off"}">Trigger price<input id="owTrig" type="number" step="0.05" min="0" value="${trigOn ? (t.trigger ?? "") : ""}" ${trigOn ? "" : "disabled"}></label>
      </div>
      <div class="row-flex ow-row">${radio("owType", "MARKET", "Market", "", icici)}${radio("owType", "LIMIT", "Limit")}<span class="spacer"></span>${radio("owType", "SL", "SL")}${radio("owType", "SL-M", "SL-M", "", icici)}</div>`;
  } else {
    const leg = (key, label, cls) => {
      const L = t[key];
      return `<div class="ow-leg"><span class="ow-tag ${cls}">${label}</span>
        <div class="row-flex ow-row" style="align-items:flex-end">
          <label class="ow-field">Trigger price<input data-leg="${key}" data-f="trigger" type="number" step="0.05" value="${L.trigger ?? ""}"></label>
          <label class="ow-field small">% of LTP<input data-leg="${key}" data-f="pct" type="number" step="0.5" value="${L.pct ?? ""}"></label>
          <span class="hint-text" style="align-self:center">places order →</span>
          <label class="ow-radio"><input type="radio" name="ot-${key}" value="LIMIT" ${L.orderType === "LIMIT" ? "checked" : ""}> Limit</label>
          <label class="ow-radio"><input type="radio" name="ot-${key}" value="MARKET" ${L.orderType === "MARKET" ? "checked" : ""}> Market</label>
          <label class="ow-field ${L.orderType === "LIMIT" ? "" : "off"}">Price<input data-leg="${key}" data-f="price" type="number" step="0.05" value="${L.orderType === "LIMIT" ? (L.price ?? "") : ""}" ${L.orderType === "LIMIT" ? "" : "disabled"} placeholder="${L.orderType === "LIMIT" ? "" : "Market"}"></label>
        </div>
        ${key === "sl" ? `<div class="row-flex ow-row" style="align-items:center"><label class="ow-radio"><input type="checkbox" id="owTrail" ${L.trail ? "checked" : ""}> Trailing</label>${L.trail ? `<label class="ow-field small">Trail by<input id="owTrailV" type="number" step="0.5" min="0" value="${L.trailValue}"></label><select id="owTrailT" class="in"><option value="pct" ${L.trailType === "pct" ? "selected" : ""}>% from the best price</option><option value="pts" ${L.trailType === "pts" ? "selected" : ""}>₹ from the best price</option></select>` : `<span class="hint-text">The stop follows the price ${sell ? "up" : "down"} and never moves back.</span>`}</div>` : ""}
      </div>`;
    };
    const single = t.gttKind === "single";
    body = `<div class="row-flex ow-row">${radio("owKind", "single", "Single")}${radio("owKind", "oco", "OCO", "stop-loss + target")}<span class="spacer"></span><label class="ow-field small">Qty.<input id="owQty" type="number" min="1" step="1" value="${t.qty}"></label></div>
      ${product}
      ${single ? leg("sl", sell ? "Stop-loss (sell below)" : "Stop / breakout (buy above)", "sl") : leg("sl", "Stop-loss", "sl") + leg("tg", "Target", "tg")}
      <p class="hint-text ow-note">Kept in Quant Terminal, not sent to ${esc(nameOf(b))} until triggered. The app must be running and the account logged in when it triggers. Expires in 1 year.${icici ? " ICICI takes no market orders: a Market leg goes out as a limit 1% through the price." : ""}</p>`;
  }
  const funds = view.data[b]?.funds?.available;
  return `<div class="ow">${head}${tabs}<div class="ow-body">${body}</div>
    <div class="ow-foot"><span class="hint-text" id="owReq"></span><span class="spacer"></span><button class="btn ${sell ? "ow-sell" : "ow-buy"}" id="owSend">${t.tab === "gtt" ? "Place GTT" : sell ? "Sell" : "Buy"}</button><button class="btn" id="owReset">Cancel</button></div>
    <div class="hint-text ow-avail">Available ${funds == null ? "—" : inr(funds)}</div></div>`;
}

function bindTicket(el, app, panels, b) {
  const t = T();
  const q = (s) => el.querySelector(s);
  const send = q("#owSend");
  if (!send) return;
  const sym = app.active?.cfg.symbol;
  const ltp = () => quotesFor[sym]?.nse || app.prices[sym] || null;
  const redraw = () => drawPortfolio(el, app, panels, b, view.data[b]);
  const read = () => {
    if (q("#owQty")) t.qty = Number(q("#owQty").value);
    if (q("#owPrice") && !q("#owPrice").disabled) t.price = q("#owPrice").value === "" ? null : Number(q("#owPrice").value);
    if (q("#owTrig") && !q("#owTrig").disabled) t.trigger = q("#owTrig").value === "" ? null : Number(q("#owTrig").value);
    el.querySelectorAll("[data-leg]").forEach((i) => {
      const L = t[i.dataset.leg];
      if (!i.disabled) L[i.dataset.f] = i.value === "" ? null : Number(i.value);
    });
    if (q("#owTrailV")) t.sl.trailValue = Number(q("#owTrailV").value);
    if (q("#owTrailT")) t.sl.trailType = q("#owTrailT").value;
  };
  const fillDefaults = () => fillDefaultsFor(app, sym);
  const required = () => {
    const p = t.tab === "regular" ? (t.type === "MARKET" || t.type === "SL-M" ? ltp() : t.price) : t.sl.trigger;
    const out = q("#owReq");
    if (!out) return;
    if (!(p > 0) || !(t.qty > 0)) return (out.textContent = "");
    const full = p * t.qty;
    out.textContent = t.product === "MIS" ? `Required ≈ ${inr(full / 5)} (intraday, about 5×)` : `Required ${inr(full)}`;
  };
  // Live NSE and BSE prices in the header.
  if (sym) {
    const bse = sym.replace(/\.NS$/, ".BO");
    api.quotes([sym, bse]).then((r) => {
      quotesFor[sym] = { nse: r[sym]?.price, bse: r[bse]?.price };
      if (q("#owNse") && quotesFor[sym].nse) q("#owNse").textContent = `₹${fmtPrice(quotesFor[sym].nse)}`;
      if (q("#owBse") && quotesFor[sym].bse) q("#owBse").textContent = `₹${fmtPrice(quotesFor[sym].bse)}`;
      const first = t.tab === "gtt" && !q('[data-leg="sl"][data-f="trigger"]')?.value;
      fillDefaults();
      // The limit price starts at the live price, like Zerodha's window.
      const priceBox = q("#owPrice");
      if (priceBox && !priceBox.disabled && !priceBox.value && t.price) priceBox.value = t.price;
      if (first) redraw();
      required();
    }, () => {});
  }
  fillDefaults();
  required();

  q("#owSide").onchange = (e) => {
    read();
    t.side = e.target.checked ? "SELL" : "BUY";
    // GTT legs flip sides with Buy / Sell.
    for (const key of ["sl", "tg"]) Object.assign(t[key], { trigger: null, price: null });
    redraw();
  };
  el.querySelectorAll(".ow-tabs [data-tab]").forEach((x) => (x.onclick = () => (read(), (t.tab = x.dataset.tab), redraw())));
  el.querySelectorAll('input[name="owProd"]').forEach((x) => (x.onchange = () => (read(), (t.product = x.value), required())));
  el.querySelectorAll('input[name="owType"]').forEach((x) => (x.onchange = () => (read(), (t.type = x.value), redraw())));
  el.querySelectorAll('input[name="owKind"]').forEach((x) => (x.onchange = () => (read(), (t.gttKind = x.value), redraw())));
  for (const key of ["sl", "tg"])
    el.querySelectorAll(`input[name="ot-${key}"]`).forEach((x) => (x.onchange = () => (read(), (t[key].orderType = x.value), redraw())));
  if (q("#owTrail")) q("#owTrail").onchange = (e) => (read(), (t.sl.trail = e.target.checked), redraw());
  // Trigger and % of LTP stay in step.
  el.querySelectorAll("[data-leg]").forEach((i) => {
    i.oninput = () => {
      const L = t[i.dataset.leg], p = ltp();
      const v = i.value === "" ? null : Number(i.value);
      if (i.dataset.f === "pct" && p && v != null) {
        L.pct = v;
        L.trigger = Math.round(p * (1 + v / 100) * 20) / 20;
        const trig = el.querySelector(`[data-leg="${i.dataset.leg}"][data-f="trigger"]`);
        if (trig) trig.value = L.trigger;
      } else if (i.dataset.f === "trigger" && p && v) {
        L.trigger = v;
        L.pct = Math.round(((v - p) / p) * 1000) / 10;
        const pct = el.querySelector(`[data-leg="${i.dataset.leg}"][data-f="pct"]`);
        if (pct) pct.value = L.pct;
      } else L[i.dataset.f] = v;
      required();
    };
  });
  ["#owQty", "#owPrice", "#owTrig"].forEach((s) => q(s) && (q(s).oninput = () => (read(), required())));
  q("#owReset").onclick = () => {
    Object.assign(t, { qty: 1, price: null, trigger: null });
    for (const key of ["sl", "tg"]) Object.assign(t[key], { trigger: null, price: null });
    redraw();
  };

  send.onclick = async () => {
    read();
    if (t.tab === "regular") return sendRegular(el, app, panels, b, sym);
    return sendGtt(el, app, panels, b, sym, ltp());
  };
}

async function sendRegular(el, app, panels, b, sym) {
  const t = T();
  const priceText =
    t.type === "MARKET" ? "at market price" :
    t.type === "LIMIT" ? `at limit ₹${t.price}` :
    t.type === "SL" ? `stop-loss: trigger ₹${t.trigger}, limit ₹${t.price}` :
    `stop-loss market: trigger ₹${t.trigger}`;
  const ok = confirm(`REAL ORDER on ${nameOf(b)}\n\n${t.side} ${t.qty} × ${ticker(sym)} (NSE)\n${priceText}\n${t.product === "CNC" ? "Longterm (CNC)" : "Intraday (MIS)"}, valid for today\n\nSend this order?`);
  if (!ok) return;
  el.querySelector("#owSend").disabled = true;
  try {
    const res = await fetch(`/api/broker/${encodeURIComponent(b)}/order`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-qt": "1", "x-qt-live-order": "confirmed" },
      body: JSON.stringify({ symbol: sym, side: t.side, qty: t.qty, type: t.type, product: t.product, price: t.price, trigger: t.trigger }),
    });
    const r = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(r.error || `HTTP ${res.status}`);
    app.toast(`${r.broker} received the order (ID ${r.orderId}). Checking its status…`);
    // The broker's risk checks run after it takes the order, so read back what happened to it.
    await new Promise((ok) => setTimeout(ok, 2500));
    const pf = await api.get(`/api/broker/${encodeURIComponent(b)}/portfolio`).catch(() => null);
    const o = pf?.orders.find((x) => String(x.id) === String(r.orderId));
    if (o && /reject/i.test(o.status)) app.toast(`${r.broker} rejected the order: ${o.message || o.status}`, "err");
    else if (o) app.toast(`${r.broker} order ${r.orderId}: ${o.status}.`);
    else app.toast(`${r.broker} received the order (ID ${r.orderId}). See the Orders tab for its status.`);
    view.pane = "orders";
  } catch (e) {
    app.toast(e.message, "err");
  }
  renderBroker(el.closest("#bottomBody") || el, app, panels);
}

async function sendGtt(el, app, panels, b, sym, ltp) {
  const t = T();
  const legOf = (key, name) => {
    const L = t[key];
    return {
      name,
      trigger: L.trigger,
      orderType: L.orderType,
      price: L.orderType === "LIMIT" ? L.price : null,
      ...(key === "sl" && L.trail ? { trail: { type: L.trailType, value: L.trailValue } } : {}),
    };
  };
  const legs = t.gttKind === "oco" ? [legOf("sl", "stoploss"), legOf("tg", "target")] : [legOf("sl", "trigger")];
  const line = (l) =>
    `${l.name === "trigger" ? "Trigger" : l.name === "stoploss" ? "Stop-loss" : "Target"} at ₹${l.trigger} → ${l.orderType === "MARKET" ? "market order" : `limit ₹${l.price}`}${l.trail ? `, trailing ${l.trail.type === "pct" ? `${l.trail.value}%` : `₹${l.trail.value}`} from the best price` : ""}`;
  const ok = confirm(
    `GTT on ${nameOf(b)} (kept in Quant Terminal)\n\n${t.side} ${t.qty} × ${ticker(sym)} (NSE), ${t.product === "CNC" ? "Longterm (CNC)" : "Intraday (MIS)"}\n${legs.map(line).join("\n")}\n\nNow ₹${ltp ?? "?"}. When a trigger is hit, a REAL order is placed automatically (the app must be running and ${nameOf(b)} logged in).\n\nSave this GTT?`,
  );
  if (!ok) return;
  el.querySelector("#owSend").disabled = true;
  try {
    const res = await fetch("/api/gtt", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-qt": "1", "x-qt-live-order": "confirmed" },
      body: JSON.stringify({ account: b, symbol: sym, side: t.side, qty: t.qty, product: t.product, kind: t.gttKind, legs }),
    });
    const r = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(r.error || `HTTP ${res.status}`);
    app.toast(`GTT saved: ${t.side} ${t.qty} ${ticker(sym)}. Quant Terminal is watching it.`);
    view.pane = "gtt";
    for (const key of ["sl", "tg"]) Object.assign(t[key], { trigger: null, price: null });
  } catch (e) {
    app.toast(e.message, "err");
  }
  renderBroker(el.closest("#bottomBody") || el, app, panels);
}

// ---------- GTT list ----------
async function gttHtml() {
  const list = await api.get("/api/gtt").catch(() => []);
  view.gtts = list;
  const live = list.filter((g) => ["active", "needs-login", "placing"].includes(g.status));
  const done = list.filter((g) => !["active", "needs-login", "placing"].includes(g.status)).slice(0, 15);
  const status = { active: "Watching", "needs-login": "Needs login", placing: "Placing…", triggered: "Triggered", failed: "Order refused", cancelled: "Cancelled", expired: "Expired" };
  const legs = (g) =>
    g.legs
      .map((l) => `${l.name === "trigger" ? "Trigger" : l.name === "stoploss" ? "SL" : "Target"} ₹${fmtPrice(l.trigger)}${l.trail ? ` <span class="muted">(trailing ${l.trail.type === "pct" ? `${l.trail.value}%` : `₹${l.trail.value}`}, best ₹${fmtPrice(l.trail.best)})</span>` : ""}`)
      .join("<br>");
  const row = (g) => {
    const last = g.history?.[g.history.length - 1]?.text || "";
    return `<tr data-s="${esc(g.symbol)}" style="cursor:pointer"><td class="l"><b>${esc(ticker(g.symbol).replace(/\.NS$/, ""))}</b></td><td class="l">${esc(g.accountName)}</td><td class="${g.side === "BUY" ? "up" : "down"}">${g.side}</td><td>${g.qty}</td><td class="l">${g.kind === "oco" ? "OCO" : "Single"} · ${g.product}</td><td class="l">${legs(g)}</td><td>${g.lastPrice ? fmtPrice(g.lastPrice) : "—"}</td><td class="l ${g.status === "needs-login" || g.status === "failed" ? "down" : g.status === "triggered" ? "up" : ""}" title="${esc(last)}">${status[g.status] || g.status}</td><td>${["active", "needs-login"].includes(g.status) ? `<button class="btn small" data-gtt-cancel="${g.id}">Cancel</button>` : g.status === "placing" ? "" : `<button class="btn small" data-gtt-remove="${g.id}" title="Remove from the list">×</button>`}</td></tr>`;
  };
  const head = `<thead><tr><th class="l">Stock</th><th class="l">Account</th><th>Side</th><th>Qty</th><th class="l">Type</th><th class="l">Triggers</th><th>LTP</th><th class="l">Status</th><th></th></tr></thead>`;
  return `<h4>GTT orders (${live.length} watching) <span class="hint-text">kept in Quant Terminal, checked every 5 seconds in market hours</span></h4>
    ${live.length ? `<table class="t">${head}<tbody>${live.map(row).join("")}</tbody></table>` : '<p class="hint-text">No active GTTs. Make one from the order window\'s GTT tab.</p>'}
    ${done.length ? `<details class="ow-done"><summary class="hint-text">Finished GTTs (${done.length})</summary><table class="t">${head}<tbody>${done.map(row).join("")}</tbody></table></details>` : ""}`;
}

async function drawGtts(el, app, panels, b) {
  const box = el.querySelector("#brGtt");
  if (!box) return;
  box.innerHTML = await gttHtml();
  const n = el.querySelector("#brGttCount");
  if (n) n.textContent = view.gtts.filter((g) => ["active", "needs-login", "placing"].includes(g.status)).length;
  box.querySelectorAll("tr[data-s]").forEach((tr) => (tr.onclick = (e) => !e.target.closest("button") && app.setSymbol(tr.dataset.s)));
  box.querySelectorAll("[data-gtt-cancel]").forEach(
    (x) =>
      (x.onclick = async () => {
        if (!confirm("Cancel this GTT? Quant Terminal will stop watching it.")) return;
        await api.post(`/api/gtt/${x.dataset.gttCancel}/cancel`).catch((e) => app.toast(e.message, "err"));
        drawGtts(el, app, panels, b);
      }),
  );
  box.querySelectorAll("[data-gtt-remove]").forEach(
    (x) =>
      (x.onclick = async () => {
        await api.del(`/api/gtt/${x.dataset.gttRemove}`).catch((e) => app.toast(e.message, "err"));
        drawGtts(el, app, panels, b);
      }),
  );
}

// The order window follows the active chart without reloading the whole portfolio.
export function onBrokerSymbol(el, app, panels) {
  const b = view.broker;
  if (b && view.data[b] && acctOf(b)?.connected) drawPortfolio(el, app, panels, b, view.data[b]);
}
