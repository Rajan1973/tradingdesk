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
        ? `<table class="t"><thead><tr><th class="l">Instrument</th><th>Product</th><th>Qty</th><th>Avg</th><th>LTP</th><th>P&amp;L</th><th></th></tr></thead><tbody>${d.positions
            .map((p, i) =>
              row(
                p.fo ? `${p.fo.seg === "bse_fo" ? "BFO" : "NFO"}:${p.fo.tradingSymbol}` : p.symbol,
                `<td class="l">${esc(p.name)}</td><td>${esc(p.product || "")}</td><td>${fmtNum(p.qty, 0)}</td><td>${p.avg == null ? "—" : fmtPrice(p.avg)}</td><td data-fo-ltp="${i}">${p.ltp == null ? "—" : fmtPrice(p.ltp)}</td><td data-fo-pnl="${i}" class="${(p.pnl || 0) >= 0 ? "up" : "down"}">${p.pnl == null ? "—" : inr(p.pnl)}</td><td>${exitable(p) ? `<button class="btn small pos-dots" data-pos-menu="${i}" title="Exit this position" aria-label="Exit ${esc(p.name)}">⋮</button>` : ""}</td>`,
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
  box.querySelectorAll("tr[data-s]").forEach((tr) => (tr.onclick = (e) => !e.target.closest("button") && app.setSymbol(tr.dataset.s)));
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
  clearInterval(gttTimer);
  gttTimer = setInterval(() => {
    if (!box.isConnected) return clearInterval(gttTimer);
    if (view.pane === "gtt" && !document.hidden) drawGtts(el, app, panels, b);
  }, 5000);
  box.querySelectorAll("[data-pos-menu]").forEach(
    (x) =>
      (x.onclick = (e) => {
        const p = d.positions[x.dataset.posMenu];
        popMenu(e, [
          ["Exit: single order", () => openExit(el, app, panels, b, p, "single")],
          ["Exit: OCO (stop-loss + target)", () => openExit(el, app, panels, b, p, "oco")],
        ]);
      }),
  );
  watchFoPrices(box, b, d.positions);
}

// F&O positions: the price and P&L refresh every 5 seconds while the Positions tab is showing.
let foTimer = null;
function watchFoPrices(box, b, positions) {
  clearInterval(foTimer);
  const keyOf = (p) => `${p.fo.seg}|${p.fo.token}`;
  const open = positions.map((p, i) => [p, i]).filter(([p]) => p.fo && p.qty);
  if (!open.length) return;
  foTimer = setInterval(async () => {
    if (!box.isConnected) return clearInterval(foTimer);
    if (view.pane !== "positions" || document.hidden) return;
    const prices = await api.get(`/api/broker/${encodeURIComponent(b)}/fo-prices?keys=${encodeURIComponent(open.map(([p]) => keyOf(p)).join(","))}`).catch(() => null);
    for (const [p, i] of open) {
      const ltp = prices?.[keyOf(p)];
      const cell = box.querySelector(`[data-fo-ltp="${i}"]`), pnl = box.querySelector(`[data-fo-pnl="${i}"]`);
      if (!ltp || !cell || !pnl) continue;
      p.ltp = ltp;
      p.pnl = p.qty * ltp - p.cost;
      cell.textContent = fmtPrice(ltp);
      pnl.textContent = inr(p.pnl);
      pnl.className = p.pnl >= 0 ? "up" : "down";
    }
  }, 5000);
}

// Positions that can be exited from here: NSE stocks on any broker, and F&O on Kotak Neo.
const exitable = (p) => !!p.qty && (!!p.fo || /^YAHOO:[A-Z0-9&\-]+\.NS$/i.test(p.symbol || ""));

// A small menu by the button that opened it (same look as the chart's right-click menu).
function popMenu(e, items) {
  document.querySelector(".chart-menu.pos-menu")?.remove();
  const m = document.createElement("div");
  m.className = "chart-menu pos-menu";
  for (const [label, fn] of items) {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.onclick = () => (m.remove(), fn());
    m.appendChild(btn);
  }
  document.body.appendChild(m);
  const r = e.currentTarget.getBoundingClientRect();
  m.style.left = `${Math.max(4, Math.min(r.right - m.offsetWidth, innerWidth - m.offsetWidth - 4))}px`;
  m.style.top = `${r.bottom + 2 + m.offsetHeight > innerHeight ? r.top - m.offsetHeight - 2 : r.bottom + 2}px`;
  const close = (ev) => {
    if (ev.type === "keydown" && ev.key !== "Escape") return;
    if (ev.type === "mousedown" && m.contains(ev.target)) return;
    m.remove();
    removeEventListener("mousedown", close, true);
    removeEventListener("keydown", close, true);
  };
  setTimeout(() => (addEventListener("mousedown", close, true), addEventListener("keydown", close, true)));
}

// Exit a position: the reverse order for what you hold. "single" goes to the broker now; "oco" is a
// stop-loss and target kept in Quant Terminal, and only the leg that's hit is sent.
function openExit(el, app, panels, b, p, mode) {
  if (!p.ltp) return app.toast("No live price yet for this position. Try again in a moment.", "err");
  const long = p.qty > 0, side = long ? "SELL" : "BUY";
  const lot = p.fo?.lot || 1, held = Math.abs(p.qty);
  const tick = (v) => Math.round(v * 20) / 20;
  // The positions list isn't live for stocks, so the form reads the live price and keeps it current.
  let ltp = p.ltp;
  const who = p.fo ? { tradingSymbol: p.fo.tradingSymbol } : { symbol: p.symbol };
  const head = `<p class="hint-text">${long ? "Long" : "Short"} ${fmtNum(held, 0)} ${esc(p.name)} (${esc(p.product)}), now <b id="exNow">₹${fmtPrice(ltp)}</b> <span class="muted">(live)</span>. The exit is a <b>${side}</b>.</p>
    <div class="form-grid"><label class="field">Quantity to ${side.toLowerCase()}${lot > 1 ? ` (lots of ${lot})` : ""}<input id="exQty" type="number" min="${lot}" step="${lot}" max="${held}" value="${held}"></label></div>`;
  const body =
    mode === "single"
      ? `${head}<div class="form-grid">
          <label class="field">Order<select id="exType"><option value="MARKET">Market</option><option value="LIMIT">Limit</option></select></label>
          <label class="field">Limit price (₹)<input id="exPrice" type="number" min="0" step="0.05" value="${tick(ltp)}" disabled></label></div>
          <p class="hint-text">Sent to ${esc(nameOf(b))} straight away.</p>`
      : `${head}<h4>Stop-loss</h4><div class="form-grid">
          <label class="field">Stop-loss (₹), trailing starts here<input id="exSl" type="number" min="0" step="0.05" value="${tick(long ? ltp - 20 : ltp + 20)}"></label>
          <label class="field">When hit, send<select id="exSlType"><option value="MARKET">Market order</option><option value="LIMIT">Limit order at the stop</option></select></label>
          <label class="field"><span><input type="checkbox" id="exTrail"> Trail, in points</span><input id="exStep" type="number" min="0" step="0.5" value="5" disabled></label></div>
          <p class="hint-text" id="exTrailNote"></p>
          <h4>Target</h4><div class="form-grid">
          <label class="field">Target (₹), sends a limit order<input id="exTg" type="number" min="0" step="0.05" value="${tick(long ? ltp + 20 : ltp - 20)}"></label></div>
          <p class="hint-text">Kept in Quant Terminal, not sent to ${esc(nameOf(b))} until one is hit. Then only that order is sent, the other is cancelled, and the OCO leaves the list. The app must be running and ${esc(nameOf(b))} logged in.${p.product === "MIS" ? " Intraday: it ends at 3:15 pm." : ""}</p>`;
  const card = app.modal(
    `${mode === "single" ? "Exit" : "Exit OCO"}: ${p.name}`,
    `${body}<p class="ow-err" id="exErr" role="alert" hidden></p><div class="row-flex" style="justify-content:flex-end;margin-top:10px"><button class="btn" id="exCancel">Cancel</button> <button class="btn ${side === "SELL" ? "ow-sell" : "ow-buy"}" id="exGo">${mode === "single" ? `${side === "SELL" ? "Sell" : "Buy"} now` : "Save OCO"}</button></div>`,
  );
  const f = (id) => card.querySelector(id);
  f("#exCancel").onclick = () => app.closeModal();
  const showErr = (text) => {
    f("#exErr").hidden = !text;
    f("#exErr").textContent = text || "";
  };
  let note = () => {};
  // Defaults follow the live price until you type in a box.
  const touched = new Set();
  card.querySelectorAll("input").forEach((i) => i.addEventListener("input", () => touched.add(i.id)));
  const setDefaults = () => {
    const put = (id, v) => f(id) && !touched.has(id.slice(1)) && (f(id).value = tick(v));
    put("#exPrice", ltp);
    put("#exSl", long ? ltp - 20 : ltp + 20);
    put("#exTg", long ? ltp + 20 : ltp - 20);
  };
  const key = p.fo ? `${p.fo.seg}|${p.fo.token}` : null;
  const refreshPrice = async () => {
    const v = await (key ? api.get(`/api/broker/${encodeURIComponent(b)}/fo-prices?keys=${encodeURIComponent(key)}`).then((r) => r[key]) : api.quotes([p.symbol]).then((r) => r[p.symbol]?.price)).catch(() => null);
    if (!(v > 0) || !card.isConnected) return;
    ltp = v;
    f("#exNow").textContent = `₹${fmtPrice(v)}`;
    setDefaults();
    note();
  };
  refreshPrice();
  const priceTimer = setInterval(() => (card.isConnected ? !document.hidden && refreshPrice() : clearInterval(priceTimer)), 3000);
  if (mode === "single") f("#exType").onchange = () => (f("#exPrice").disabled = f("#exType").value === "MARKET");
  else {
    note = () => {
      const on = f("#exTrail").checked, step = Number(f("#exStep").value);
      f("#exStep").disabled = !on;
      f("#exTrailNote").textContent =
        on && step > 0
          ? `Each time the price moves ${step} points ${long ? "up" : "down"} from ₹${fmtPrice(ltp)}, the stop moves ${step} points ${long ? "up" : "down"} from ₹${f("#exSl").value}. It never moves back.`
          : "";
    };
    f("#exTrail").onchange = f("#exStep").oninput = f("#exSl").oninput = note;
    note();
  }
  f("#exGo").onclick = async () => {
    const qty = Number(f("#exQty").value);
    showErr("");
    if (!(qty > 0) || qty > held || qty % lot) return showErr(`Quantity must be up to ${held}${lot > 1 ? `, in lots of ${lot}` : ""}.`);
    let url, payload, text;
    if (mode === "single") {
      const type = f("#exType").value, price = type === "LIMIT" ? Number(f("#exPrice").value) : null;
      text = `REAL ORDER on ${nameOf(b)}\n\nExit: ${side} ${qty} × ${p.name} (${p.product})\n${type === "MARKET" ? "at market price" : `at limit ₹${price}`}\n\nSend this order now?`;
      url = `/api/broker/${encodeURIComponent(b)}/order`;
      payload = { exit: true, ...who, side, qty, type, price, product: p.product };
    } else {
      const sl = Number(f("#exSl").value), tg = Number(f("#exTg").value), slType = f("#exSlType").value;
      const trail = f("#exTrail").checked && Number(f("#exStep").value) > 0 ? { type: "pts", value: Number(f("#exStep").value) } : null;
      // Checked against the live price here too, so a wrong side is caught before the confirm box.
      const where = (v) => (long ? (v < ltp ? "below" : "above") : v > ltp ? "above" : "below");
      if (where(sl) !== (long ? "below" : "above")) return showErr(`The stop-loss (₹${sl}) must be ${long ? "below" : "above"} the live price (₹${fmtPrice(ltp)}).`);
      if (where(tg) !== (long ? "above" : "below")) return showErr(`The target (₹${tg}) must be ${long ? "above" : "below"} the live price (₹${fmtPrice(ltp)}).`);
      text = `Exit OCO on ${nameOf(b)} (kept in Quant Terminal)\n\n${side} ${qty} × ${p.name} (${p.product})\nStop-loss ₹${sl} → ${slType === "MARKET" ? "market order" : `limit ₹${sl}`}${trail ? `, trailing ${trail.value} points` : ""}\nTarget ₹${tg} → limit ₹${tg}\n\nNow ₹${ltp}. When one is hit, a REAL order is sent for it and the other is cancelled.\n\nSave this OCO?`;
      url = "/api/gtt";
      payload = {
        account: b,
        ...(p.fo ? { tradingSymbol: p.fo.tradingSymbol } : { exitSymbol: p.symbol }),
        product: p.product,
        qty,
        kind: "oco",
        legs: [
          { name: "stoploss", trigger: sl, orderType: slType, price: slType === "LIMIT" ? sl : null, ...(trail ? { trail } : {}) },
          { name: "target", trigger: tg, orderType: "LIMIT", price: tg },
        ],
      };
    }
    if (!confirm(text)) return;
    f("#exGo").disabled = true;
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "x-qt": "1", "x-qt-live-order": "confirmed" }, body: JSON.stringify(payload) });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r.error || `HTTP ${res.status}`);
      app.closeModal();
      app.toast(mode === "single" ? `${r.broker} received the exit order (ID ${r.orderId}).` : `Exit OCO saved on ${p.name}. Quant Terminal is watching it.`);
      view.pane = mode === "single" ? "orders" : "gtt";
      renderBroker(el.closest("#bottomBody") || el, app, panels);
    } catch (e) {
      f("#exGo").disabled = false;
      showErr(`${e.message} ${mode === "single" ? "Nothing was sent." : "Nothing was saved."}`);
    }
  };
}

// ---------- order window (Zerodha-style) ----------
// Regular: an order sent now. GTT: triggers kept inside Quant Terminal (single, OCO, trailing
// stop) that place the order only when the price gets there. Orders are REAL either way.
const tradable = (sym) => /^YAHOO:[A-Z0-9&\-]+\.NS$/i.test(sym || "");
const T = () => view.ticket;
if (!view.ticket.tab) Object.assign(view.ticket, { tab: "regular", gttKind: "oco", sl: { pct: -5, orderType: "LIMIT", trail: false, trailType: "pct", trailValue: 2 }, tg: { pct: 5, orderType: "LIMIT" } });
if (!view.ticket.att) view.ticket.att = { slOn: false, sl: 2, tgOn: false, tg: 4 };
const quotesFor = {}; // symbol, or a Kotak contract's "seg|token" -> { nse, bse }
// A contract picked in the order window's search (Kotak only). Without one, it follows the chart.
const pickedOf = (b) => (acctOf(b)?.broker === "kotak" ? T().instrument || null : null);
const keyOf = (c) => `${c.seg}|${c.token}`;
const SEG = { nse_cm: "NSE", bse_cm: "BSE", nse_fo: "NFO", bse_fo: "BFO" };
const contractName = (c) => (c.kind === "eq" ? c.name : c.opt === "FUT" ? `${c.name} FUT ${c.expiry}` : `${c.name} ${c.strike} ${c.opt} ${c.expiry}`);
const unitsOf = (t, c) => (t.qty || 0) * (c?.kind === "fo" ? c.lot : 1);
function pick(c) {
  const t = T();
  Object.assign(t, { instrument: c, qty: 1, price: null, trigger: null, tab: t.tab });
  for (const key of ["sl", "tg"]) Object.assign(t[key], { trigger: null, price: null });
}
const findBox = (b, hint = "") =>
  acctOf(b)?.broker === "kotak"
    ? `<div class="ow-find"><input id="owFind" autocomplete="off" aria-label="Search stocks and F&amp;O" placeholder="Search stock or F&amp;O: NIFTY 23900 CE"><div id="owFound"></div>${hint}</div>`
    : "";

// Defaults from the live price, filled in before the window is drawn: the limit price, and GTT
// triggers 5% either side (stop below and target above for a sell, the other way for a buy).
function fillDefaultsFor(app, sym) {
  const t = T();
  const p = quotesFor[sym]?.nse || app.prices?.[sym];
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
  const c = pickedOf(b);
  const sym = c ? keyOf(c) : app.active?.cfg.symbol;
  const t = T();
  fillDefaultsFor(app, sym);
  const a = acctOf(b);
  const fno = c?.kind === "fo";
  if (fno && t.product === "CNC") t.product = "NRML";
  if (!fno && t.product === "NRML") t.product = "CNC";
  const icici = a?.broker === "icici";
  if (icici) {
    if (!["LIMIT", "SL"].includes(t.type)) t.type = "LIMIT";
    t.product = "CNC";
  }
  if (!c && !tradable(sym))
    return `<div class="ow"><div class="ow-head buy"><b>Order window</b></div>${findBox(b)}<p class="hint-text" style="padding:10px">${a?.broker === "kotak" ? "Search above for a stock or F&amp;O contract, or open" : "Open"} an NSE stock chart (a symbol ending in .NS) to place an order or a GTT on it.</p></div>`;
  const name = c ? contractName(c) : ticker(sym).replace(/\.NS$/, "");
  const q = quotesFor[sym] || {};
  const sell = t.side === "SELL";
  const radio = (group, value, label, sub = "", disabled = false) =>
    `<label class="ow-radio ${disabled ? "off" : ""}"><input type="radio" name="${group}" value="${value}" ${t[group === "owProd" ? "product" : group === "owType" ? "type" : group === "owKind" ? "gttKind" : group] === value ? "checked" : ""} ${disabled ? "disabled" : ""}> ${label}${sub ? ` <span class="muted">${sub}</span>` : ""}</label>`;
  const head = `<div class="ow-head ${sell ? "sell" : "buy"}">
      <div class="row-flex" style="align-items:center"><b>${esc(name)}</b><span class="spacer"></span><span class="muted" style="margin-right:6px">${sell ? "Sell" : "Buy"}</span><label class="ow-switch" title="Buy / Sell"><input type="checkbox" id="owSide" ${sell ? "checked" : ""}><span></span></label></div>
      <div class="ow-ex">${
        c
          ? `<label title="Orders go to ${SEG[c.seg]}"><input type="radio" checked> ${SEG[c.seg]} <b id="owNse">${q.nse ? `₹${fmtPrice(q.nse)}` : "…"}</b></label>${fno ? `<span>Lot ${c.lot}</span>` : ""}${fno ? `<button class="btn small" id="owOpenChart" type="button">Open chart</button>` : ""}<button class="btn small" id="owChart" type="button">Back to chart stock</button>`
          : `<label title="Orders go to NSE"><input type="radio" checked> NSE <b id="owNse">${q.nse ? `₹${fmtPrice(q.nse)}` : "…"}</b></label><label class="${a?.broker === "kotak" ? "" : "off"}" title="${a?.broker === "kotak" ? "Send orders to BSE" : "BSE orders are for Kotak Neo accounts"}"><input type="radio" id="owToBse" ${a?.broker === "kotak" ? "" : "disabled"}> BSE <b id="owBse">${q.bse ? `₹${fmtPrice(q.bse)}` : "…"}</b></label>`
      }</div>
    </div>`;
  const tabs = `<div class="ow-tabs"><button data-tab="regular" class="${t.tab === "regular" ? "on" : ""}">Regular</button><button data-tab="gtt" class="${t.tab === "gtt" ? "on" : ""}">GTT</button><span class="spacer"></span><span class="hint-text">${esc(nameOf(b))}</span></div>`;
  const product = `<div class="row-flex ow-row">${radio("owProd", "MIS", "Intraday", "MIS", icici)}${fno ? radio("owProd", "NRML", "Overnight", "NRML") : radio("owProd", "CNC", "Longterm", "CNC")}</div>`;
  const qtyName = fno ? `Lots <span class="muted">× ${c.lot}</span>` : "Qty.";
  let body;
  if (t.tab === "regular") {
    const priceOn = t.type === "LIMIT" || t.type === "SL", trigOn = t.type === "SL" || t.type === "SL-M";
    body = `${product}
      <div class="row-flex ow-row">
        <label class="ow-field">${qtyName}<input id="owQty" type="number" min="1" step="1" value="${t.qty}"></label>
        <label class="ow-field ${priceOn ? "" : "off"}">Price<input id="owPrice" type="number" step="0.05" min="0" value="${priceOn ? (t.price ?? "") : ""}" ${priceOn ? "" : "disabled"} placeholder="${priceOn ? "" : "Market"}"></label>
        <label class="ow-field ${trigOn ? "" : "off"}">Trigger price<input id="owTrig" type="number" step="0.05" min="0" value="${trigOn ? (t.trigger ?? "") : ""}" ${trigOn ? "" : "disabled"}></label>
      </div>
      <div class="row-flex ow-row">${radio("owType", "MARKET", "Market", "", icici)}${radio("owType", "LIMIT", "Limit")}<span class="spacer"></span>${radio("owType", "SL", "SL")}${radio("owType", "SL-M", "SL-M", "", icici)}</div>
      ${
        c && c.kind !== "fo"
          ? ""
          : `<div class="row-flex ow-row ow-att"><span class="ow-gtt-badge">GTT</span>
        <label class="ow-radio"><input type="checkbox" id="owSlOn" ${t.att.slOn ? "checked" : ""}> Stoploss</label><label class="ow-pct ${t.att.slOn ? "" : "off"}"><input id="owSlPct" type="number" min="0" step="0.5" value="${t.att.sl}" ${t.att.slOn ? "" : "disabled"} aria-label="Stoploss %"> %</label>
        <label class="ow-radio"><input type="checkbox" id="owTgOn" ${t.att.tgOn ? "checked" : ""}> Target</label><label class="ow-pct ${t.att.tgOn ? "" : "off"}"><input id="owTgPct" type="number" min="0" step="0.5" value="${t.att.tg}" ${t.att.tgOn ? "" : "disabled"} aria-label="Target %"> %</label>
        <span class="spacer"></span><span class="ow-info" title="Once this order fills, Quant Terminal sets a stop-loss and/or target this % from the fill price, kept in Quant Terminal (OCO). Only the one that's hit is sent; the stop-loss sends a market order, the target a limit order.">ⓘ</span></div>`
      }`;
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
        ${key === "sl" ? `<div class="row-flex ow-row" style="align-items:center"><label class="ow-radio"><input type="checkbox" id="owTrail" ${L.trail ? "checked" : ""}> Trailing</label>${L.trail ? `<label class="ow-field small">Trail by<input id="owTrailV" type="number" step="0.5" min="0" value="${L.trailValue}"></label><select id="owTrailT" class="in"><option value="pct" ${L.trailType === "pct" ? "selected" : ""}>% steps</option><option value="pts" ${L.trailType === "pts" ? "selected" : ""}>points (₹) steps</option></select>` : `<span class="hint-text">The stop moves one step ${sell ? "up" : "down"} each time the price moves one step, and never moves back.</span>`}</div>` : ""}
      </div>`;
    };
    const single = t.gttKind === "single";
    body = `<div class="row-flex ow-row">${radio("owKind", "single", "Single")}${radio("owKind", "oco", "OCO", "stop-loss + target")}<span class="spacer"></span><label class="ow-field small">${qtyName}<input id="owQty" type="number" min="1" step="1" value="${t.qty}"></label></div>
      ${product}
      ${single ? leg("sl", sell ? "Stop-loss (sell below)" : "Stop / breakout (buy above)", "sl") : leg("sl", "Stop-loss", "sl") + leg("tg", "Target", "tg")}
      <p class="hint-text ow-note">Kept in Quant Terminal, not sent to ${esc(nameOf(b))} until triggered. The app must be running and the account logged in when it triggers. Expires in 1 year.${icici ? " ICICI takes no market orders: a Market leg goes out as a limit 1% through the price." : ""}</p>`;
  }
  const funds = view.data[b]?.funds?.available;
  return `<div class="ow">${head}${findBox(b)}${tabs}<div class="ow-body">${body}</div>
    <div class="ow-foot"><span class="hint-text" id="owReq"></span><span class="spacer"></span><button class="btn ${sell ? "ow-sell" : "ow-buy"}" id="owSend">${t.tab === "gtt" ? "Place GTT" : sell ? "Sell" : "Buy"}</button><button class="btn" id="owReset">Cancel</button></div>
    <div class="hint-text ow-avail">Available ${funds == null ? "—" : inr(funds)}</div></div>`;
}

let ticketTimer = null;
function bindTicket(el, app, panels, b) {
  const t = T();
  const q = (s) => el.querySelector(s);
  const redraw = () => drawPortfolio(el, app, panels, b, view.data[b]);
  clearInterval(ticketTimer);
  // Search every stock and F&O contract Kotak lists.
  if (q("#owFind")) {
    let wait = null;
    q("#owFind").oninput = (e) => {
      clearTimeout(wait);
      const text = e.target.value.trim(), box = q("#owFound");
      if (!text) return (box.innerHTML = "");
      wait = setTimeout(async () => {
        box.textContent = "Searching…";
        try {
          const list = await api.get(`/api/broker/${encodeURIComponent(b)}/contracts?q=${encodeURIComponent(text)}`);
          if (q("#owFind")?.value.trim() !== text) return;
          box.innerHTML = list.length
            ? list.map((c, i) => `<button type="button" data-found="${i}"><b>${esc(contractName(c))}</b> <span class="muted">${SEG[c.seg]}${c.kind === "fo" ? ` · lot ${c.lot}` : ""}</span></button>`).join("")
            : '<span class="hint-text">Nothing matches.</span>';
          box.querySelectorAll("[data-found]").forEach((x) => (x.onclick = () => (pick(list[x.dataset.found]), redraw())));
        } catch (err) {
          box.textContent = err.message;
        }
      }, 250);
    };
  }
  const send = q("#owSend");
  if (!send) return;
  const c = pickedOf(b);
  const chartSym = app.active?.cfg.symbol;
  const sym = c ? keyOf(c) : chartSym;
  const ltp = () => quotesFor[sym]?.nse || app.prices?.[sym] || null;
  if (q("#owChart")) q("#owChart").onclick = () => (pick(null), redraw());
  if (q("#owOpenChart")) q("#owOpenChart").onclick = () => app.setSymbol(`${c.seg === "bse_fo" ? "BFO" : "NFO"}:${c.trd}`);
  if (q("#owToBse"))
    q("#owToBse").onclick = async () => {
      const stock = ticker(chartSym).replace(/\.NS$/, "");
      const list = await api.get(`/api/broker/${encodeURIComponent(b)}/contracts?q=${encodeURIComponent(stock)}`).catch(() => []);
      const found = list.find((x) => x.seg === "bse_cm" && x.name === stock);
      if (!found) return app.toast(`${stock} wasn't found on BSE.`, "err");
      pick(found);
      redraw();
    };
  const read = () => {
    if (q("#owQty")) t.qty = Number(q("#owQty").value);
    if (q("#owPrice") && !q("#owPrice").disabled) t.price = q("#owPrice").value === "" ? null : Number(q("#owPrice").value);
    if (q("#owTrig") && !q("#owTrig").disabled) t.trigger = q("#owTrig").value === "" ? null : Number(q("#owTrig").value);
    el.querySelectorAll("[data-leg]").forEach((i) => {
      const L = t[i.dataset.leg];
      if (!i.disabled) L[i.dataset.f] = i.value === "" ? null : Number(i.value);
    });
    if (q("#owSlPct")) t.att.sl = Number(q("#owSlPct").value);
    if (q("#owTgPct")) t.att.tg = Number(q("#owTgPct").value);
    if (q("#owTrailV")) t.sl.trailValue = Number(q("#owTrailV").value);
    if (q("#owTrailT")) t.sl.trailType = q("#owTrailT").value;
  };
  const fillDefaults = () => fillDefaultsFor(app, sym);
  const required = () => {
    const p = t.tab === "regular" ? (t.type === "MARKET" || t.type === "SL-M" ? ltp() : t.price) : t.sl.trigger;
    const out = q("#owReq");
    if (!out) return;
    if (!(p > 0) || !(t.qty > 0)) return (out.textContent = "");
    if (c?.kind === "fo") return (out.textContent = c.opt !== "FUT" && t.side === "BUY" ? `Premium ${inr(p * unitsOf(t, c))}` : "Kotak checks the margin when you send");
    const full = p * t.qty;
    out.textContent = t.product === "MIS" ? `Required ≈ ${inr(full / 5)} (intraday, about 5×)` : `Required ${inr(full)}`;
  };
  // Live NSE and BSE prices in the header.
  const fetchPrices = async () => {
    if (c) {
      const r = await api.get(`/api/broker/${encodeURIComponent(b)}/fo-prices?keys=${encodeURIComponent(sym)}`);
      return { nse: r[sym] };
    }
    const bse = sym.replace(/\.NS$/, ".BO");
    const r = await api.quotes([sym, bse]);
    return { nse: r[sym]?.price, bse: r[bse]?.price };
  };
  const showPrices = (p) => {
    quotesFor[sym] = p;
    if (q("#owNse") && p.nse) q("#owNse").textContent = `₹${fmtPrice(p.nse)}`;
    if (q("#owBse") && p.bse) q("#owBse").textContent = `₹${fmtPrice(p.bse)}`;
  };
  // Kept live while a broker is connected and the window is on screen.
  if (sym && acctOf(b)?.broker === "kotak")
    ticketTimer = setInterval(() => {
      if (!send.isConnected) return clearInterval(ticketTimer);
      if (!document.hidden) fetchPrices().then((p) => (showPrices(p), required()), () => {});
    }, 3000);
  if (sym) {
    fetchPrices().then((r) => {
      showPrices(r);
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
  if (q("#owSlOn")) q("#owSlOn").onchange = (e) => (read(), (t.att.slOn = e.target.checked), redraw());
  if (q("#owTgOn")) q("#owTgOn").onchange = (e) => (read(), (t.att.tgOn = e.target.checked), redraw());
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
    if (t.tab === "regular") return sendRegular(el, app, panels, b, chartSym);
    return sendGtt(el, app, panels, b, chartSym, ltp());
  };
}

// How an order reads in its confirmation, and what identifies it to the server.
function orderOf(b, sym) {
  const t = T(), c = pickedOf(b);
  if (!c) return { label: `${t.qty} × ${ticker(sym)} (NSE)`, productText: t.product === "CNC" ? "Longterm (CNC)" : "Intraday (MIS)", warn: "", qty: t.qty };
  const units = unitsOf(t, c);
  return {
    label: `${c.kind === "fo" ? `${t.qty} lot${t.qty === 1 ? "" : "s"} (${units} qty) of ` : `${units} × `}${c.trd} (${SEG[c.seg]})`,
    productText: { CNC: "Longterm (CNC)", MIS: "Intraday (MIS)", NRML: "Overnight (NRML)" }[t.product],
    // A sale without a holding opens a short, which carries much larger risk than buying.
    warn: t.side === "SELL" && c.kind === "fo" ? "\n\nIf you don't already hold this, the sale OPENS A SHORT POSITION." : "",
    qty: units,
    contract: { seg: c.seg, token: c.token },
  };
}

async function sendRegular(el, app, panels, b, sym) {
  const t = T();
  const order = orderOf(b, sym);
  const priceText =
    t.type === "MARKET" ? "at market price" :
    t.type === "LIMIT" ? `at limit ₹${t.price}` :
    t.type === "SL" ? `stop-loss: trigger ₹${t.trigger}, limit ₹${t.price}` :
    `stop-loss market: trigger ₹${t.trigger}`;
  const c = pickedOf(b);
  const att = (!c || c.kind === "fo") && (t.att.slOn || t.att.tgOn) ? { sl: t.att.slOn ? t.att.sl : null, tg: t.att.tgOn ? t.att.tg : null } : null;
  const buy = t.side === "BUY";
  const attText = att
    ? `\n\nOnce it fills, Quant Terminal keeps an exit (${att.sl != null && att.tg != null ? "OCO" : "GTT"}):${att.sl != null ? `\nStop-loss ${att.sl}% ${buy ? "below" : "above"} the fill → market order` : ""}${att.tg != null ? `\nTarget ${att.tg}% ${buy ? "above" : "below"} the fill → limit order` : ""}\nOnly the one that's hit is sent to ${nameOf(b)}.`
    : "";
  const ok = confirm(`REAL ORDER on ${nameOf(b)}\n\n${t.side} ${order.label}\n${priceText}\n${order.productText}, valid for today${order.warn}${attText}\n\nSend this order?`);
  if (!ok) return;
  el.querySelector("#owSend").disabled = true;
  try {
    const res = await fetch(`/api/broker/${encodeURIComponent(b)}/order`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-qt": "1", "x-qt-live-order": "confirmed" },
      body: JSON.stringify({ ...(order.contract || { symbol: sym }), side: t.side, qty: order.qty, type: t.type, product: t.product, price: t.price, trigger: t.trigger, ...(att ? { attach: att } : {}) }),
    });
    const r = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(r.error || `HTTP ${res.status}`);
    app.toast(`${r.broker} received the order (ID ${r.orderId}). Checking its status…`);
    if (r.gttError) app.toast(`The stop-loss / target wasn't set: ${r.gttError}`, "err");
    else if (r.gtt) app.toast("Stop-loss / target will be set when the order fills (see GTT orders).");
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
  const order = orderOf(b, sym);
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
    `GTT on ${nameOf(b)} (kept in Quant Terminal)\n\n${t.side} ${order.label}, ${order.productText}\n${legs.map(line).join("\n")}\n\nNow ₹${ltp ?? "?"}. When a trigger is hit, a REAL order is placed automatically (the app must be running and ${nameOf(b)} logged in).${order.warn}\n\nSave this GTT?`,
  );
  if (!ok) return;
  el.querySelector("#owSend").disabled = true;
  try {
    const res = await fetch("/api/gtt", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-qt": "1", "x-qt-live-order": "confirmed" },
      body: JSON.stringify({ account: b, ...(order.contract ? { instrument: order.contract } : { symbol: sym }), side: t.side, qty: order.qty, product: t.product, kind: t.gttKind, legs }),
    });
    const r = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(r.error || `HTTP ${res.status}`);
    app.toast(`GTT saved: ${t.side} ${order.label}. Quant Terminal is watching it.`);
    view.pane = "gtt";
    for (const key of ["sl", "tg"]) Object.assign(t[key], { trigger: null, price: null });
  } catch (e) {
    app.toast(e.message, "err");
  }
  renderBroker(el.closest("#bottomBody") || el, app, panels);
}

// ---------- GTT list ----------
// Each account's open positions, read at most once a minute, for the GTT list's P&L.
const posCache = {};
async function positionsOf(acct) {
  const hit = posCache[acct];
  if (hit && Date.now() - hit.at < 60000) return hit.list;
  const pf = await api.get(`/api/broker/${encodeURIComponent(acct)}/portfolio`).catch(() => null);
  const list = pf?.positions || hit?.list || [];
  posCache[acct] = { at: Date.now(), list };
  return list;
}

async function gttHtml() {
  const list = await api.get("/api/gtt").catch(() => []);
  view.gtts = list;
  const live = list.filter((g) => ["active", "needs-login", "placing", "waiting-fill"].includes(g.status));
  // The position each live GTT protects: its P&L now, at the GTT's last price, and if the stop is hit.
  const held = {};
  for (const acct of new Set(live.map((g) => g.account))) held[acct] = await positionsOf(acct);
  const posOf = (g) => held[g.account]?.find((p) => p.qty && p.product === g.product && (g.fo ? p.fo?.tradingSymbol === g.fo.tradingSymbol : p.symbol === g.symbol));
  const money = (v) => `<span class="${v >= 0 ? "up" : "down"}">${inr(v)}</span>`;
  const pnl = (g) => {
    const p = live.includes(g) ? posOf(g) : null;
    if (!p || !(g.lastPrice > 0)) return "—";
    // The broker's figure (today's net for the instrument, closed trades included), moved by the price
    // since it was read, so it matches the broker's own app. Without one, from the average price.
    const at = (price) => (p.pnl != null && p.ltp > 0 ? p.pnl + (price - p.ltp) * p.qty : p.avg > 0 ? (price - p.avg) * p.qty : null);
    if (at(g.lastPrice) == null) return "—";
    const stop = g.legs.find((l) => l.name === "stoploss" || l.name === "trigger");
    const atStop = stop ? `<br><span class="muted">${inr(at(stop.trigger))} at the stop</span>` : "";
    return `<span title="As your broker shows it: today's net for this instrument, including trades already closed">${money(at(g.lastPrice))}</span>${atStop}`;
  };
  // How far a trailing stop has moved from where it started.
  const trailed = (g) => {
    const l = g.legs.find((x) => x.trail?.start != null);
    if (!l) return "—";
    const moved = Math.abs(l.trigger - l.trail.start);
    const step = l.trail.type === "pct" ? (l.trail.from * l.trail.value) / 100 : l.trail.value;
    const steps = step > 0 ? Math.round(moved / step) : 0;
    return moved > 0 ? `₹${fmtPrice(moved)} <span class="muted">(${steps} step${steps === 1 ? "" : "s"}) from ₹${fmtPrice(l.trail.start)}</span>` : `<span class="muted">Not yet, from ₹${fmtPrice(l.trail.start)}</span>`;
  };
  const done = list.filter((g) => !["active", "needs-login", "placing", "waiting-fill"].includes(g.status)).slice(0, 15);
  const status = { active: "Watching", "needs-login": "Needs login", placing: "Placing…", "waiting-fill": "Waiting for fill", triggered: "Triggered", failed: "Order refused", cancelled: "Cancelled", expired: "Expired" };
  const legs = (g) =>
    g.status === "waiting-fill"
      ? [g.entry.sl != null ? `SL ${g.entry.sl}%` : "", g.entry.tg != null ? `Target ${g.entry.tg}%` : ""].filter(Boolean).join(" · ") + ` <span class="muted">from the fill of order ${esc(g.entry.orderId)}</span>`
      : g.legs
      .map((l) => `${l.name === "trigger" ? "Trigger" : l.name === "stoploss" ? "SL" : "Target"} ₹${fmtPrice(l.trigger)}${l.trail ? ` <span class="muted">(trailing ${l.trail.type === "pct" ? `${l.trail.value}%` : `₹${l.trail.value}`}, best ₹${fmtPrice(l.trail.best)})</span>` : ""}`)
      .join("<br>");
  const row = (g) => {
    const last = g.history?.[g.history.length - 1]?.text || "";
    return `<tr ${g.fo ? "" : `data-s="${esc(g.symbol)}" style="cursor:pointer"`}><td class="l"><b>${esc(ticker(g.symbol).replace(/\.NS$/, ""))}</b></td><td class="l">${esc(g.accountName)}</td><td class="${g.side === "BUY" ? "up" : "down"}">${g.side}</td><td>${g.qty}</td><td class="l">${g.kind === "oco" ? "OCO" : "Single"} · ${g.product}</td><td class="l">${legs(g)}</td><td class="l">${trailed(g)}</td><td>${g.lastPrice ? fmtPrice(g.lastPrice) : "—"}</td><td>${pnl(g)}</td><td class="l ${g.status === "needs-login" || g.status === "failed" ? "down" : g.status === "triggered" ? "up" : ""}" title="${esc(last)}">${status[g.status] || g.status}</td><td>${["active", "needs-login"].includes(g.status) ? `<button class="btn small" data-gtt-edit="${g.id}">Modify</button> <button class="btn small" data-gtt-cancel="${g.id}">Cancel</button>` : g.status === "waiting-fill" ? `<button class="btn small" data-gtt-cancel="${g.id}">Cancel</button>` : g.status === "placing" ? "" : `<button class="btn small" data-gtt-remove="${g.id}" title="Remove from the list">×</button>`}</td></tr>`;
  };
  const head = `<thead><tr><th class="l">Stock</th><th class="l">Account</th><th>Side</th><th>Qty</th><th class="l">Type</th><th class="l">Triggers</th><th class="l">Trailed</th><th>LTP</th><th>P&amp;L</th><th class="l">Status</th><th></th></tr></thead>`;
  return `<h4>GTT orders (${live.length} watching) <span class="hint-text">kept in Quant Terminal, checked every 5 seconds in market hours</span></h4>
    ${live.length ? `<table class="t">${head}<tbody>${live.map(row).join("")}</tbody></table>` : '<p class="hint-text">No active GTTs. Make one from the order window\'s GTT tab.</p>'}
    ${done.length ? `<details class="ow-done"><summary class="hint-text">Finished GTTs (${done.length})</summary><table class="t">${head}<tbody>${done.map(row).join("")}</tbody></table></details>` : ""}`;
}

// Change a watching GTT: its quantity and, per leg, the trigger, the order sent and any trailing.
function openGttEdit(el, app, panels, b, g) {
  const lot = g.fo?.seg.endsWith("_fo") ? g.fo.lot : 1;
  const legName = (l) => (l.name === "trigger" ? "Trigger" : l.name === "stoploss" ? "Stop-loss" : "Target");
  const sell = g.side === "SELL";
  const legHtml = (l, i) => {
    const canTrail = l.name === "stoploss" || l.name === "trigger";
    return `<h4>${legName(l)}</h4><div class="form-grid">
      <label class="field">Trigger (₹)<input data-g="trigger" data-i="${i}" type="number" min="0" step="0.05" value="${l.trigger}"></label>
      <label class="field">When hit, send<select data-g="orderType" data-i="${i}"><option value="LIMIT" ${l.orderType === "LIMIT" ? "selected" : ""}>Limit order</option><option value="MARKET" ${l.orderType === "MARKET" ? "selected" : ""}>Market order</option></select></label>
      <label class="field">Limit price (₹)<input data-g="price" data-i="${i}" type="number" min="0" step="0.05" value="${l.price ?? ""}" ${l.orderType === "LIMIT" ? "" : "disabled"}></label>
      ${
        canTrail
          ? `<label class="field">Trailing<select data-g="trailOn" data-i="${i}"><option value="1" ${l.trail ? "selected" : ""}>On</option><option value="0" ${l.trail ? "" : "selected"}>Off</option></select></label>
      <label class="field">Trail by<input data-g="trailValue" data-i="${i}" type="number" min="0" step="0.5" value="${l.trail?.value ?? 5}" ${l.trail ? "" : "disabled"}></label>
      <label class="field">Trail in<select data-g="trailType" data-i="${i}" ${l.trail ? "" : "disabled"}><option value="pct" ${l.trail?.type !== "pts" ? "selected" : ""}>% steps</option><option value="pts" ${l.trail?.type === "pts" ? "selected" : ""}>points (₹) steps</option></select></label>
      <p class="hint-text" data-g="note" data-i="${i}" style="grid-column:1/-1"></p>`
          : ""
      }
    </div>`;
  };
  const card = app.modal(
    `Modify GTT: ${ticker(g.symbol).replace(/\.NS$/, "")}`,
    `<p class="hint-text">${g.side}, ${esc(g.product)}, on ${esc(nameOf(b))}. Last price ₹${g.lastPrice ? fmtPrice(g.lastPrice) : "?"}.</p>
    <div class="form-grid"><label class="field">Quantity${lot > 1 ? ` (lots of ${lot})` : ""}<input id="geQty" type="number" min="${lot}" step="${lot}" value="${g.qty}"></label></div>
    ${g.legs.map(legHtml).join("")}
    <div class="row-flex" style="justify-content:flex-end;margin-top:10px"><button class="btn" id="geCancel">Keep as it is</button> <button class="btn primary" id="geSave">Save changes</button></div>`,
  );
  const f = (name, i) => card.querySelector(`[data-g="${name}"][data-i="${i}"]`);
  // A step trail: say how the stop will move from the trigger you set.
  const refresh = (i) => {
    const on = f("trailOn", i)?.value === "1";
    if (!f("trailOn", i)) return;
    f("trailValue", i).disabled = f("trailType", i).disabled = !on;
    const v = Number(f("trailValue", i).value), unit = f("trailType", i).value === "pct" ? `${v}%` : `₹${v}`;
    f("note", i).textContent = on && v > 0 ? `The stop starts at ₹${f("trigger", i).value} and moves ${unit} ${sell ? "up" : "down"} each time the price moves ${unit} ${sell ? "up" : "down"} from now. It never moves back.` : "";
  };
  g.legs.forEach((_, i) => {
    f("orderType", i).onchange = () => (f("price", i).disabled = f("orderType", i).value === "MARKET");
    for (const name of ["trigger", "trailOn", "trailValue", "trailType"]) if (f(name, i)) f(name, i).oninput = f(name, i).onchange = () => refresh(i);
    refresh(i);
  });
  card.querySelector("#geCancel").onclick = () => app.closeModal();
  card.querySelector("#geSave").onclick = async () => {
    const qty = Number(card.querySelector("#geQty").value);
    const legs = g.legs.map((l, i) => ({
      name: l.name,
      trigger: Number(f("trigger", i).value),
      orderType: f("orderType", i).value,
      price: f("orderType", i).value === "LIMIT" ? Number(f("price", i).value) : null,
      ...(f("trailOn", i)?.value === "1" ? { trail: { type: f("trailType", i).value, value: Number(f("trailValue", i).value) } } : {}),
    }));
    const line = (l) => `${legName(l)} at ₹${l.trigger} → ${l.orderType === "MARKET" ? "market order" : `limit ₹${l.price}`}${l.trail ? `, trailing ${l.trail.type === "pct" ? `${l.trail.value}%` : `₹${l.trail.value}`}` : ", not trailing"}`;
    if (!confirm(`Change this GTT on ${nameOf(b)}?\n\n${g.side} ${qty} × ${ticker(g.symbol).replace(/\.NS$/, "")}\n${legs.map(line).join("\n")}\n\nWhen a trigger is hit, a REAL order is placed automatically.`)) return;
    try {
      const res = await fetch(`/api/gtt/${g.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "x-qt": "1", "x-qt-live-order": "confirmed" },
        body: JSON.stringify({ qty, legs }),
      });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r.error || `HTTP ${res.status}`);
      app.closeModal();
      app.toast("GTT changed. Quant Terminal is watching the new values.");
      drawGtts(el, app, panels, b);
    } catch (e) {
      app.toast(`${e.message} The GTT wasn't changed.`, "err");
    }
  };
}

let gttTimer = null;
async function drawGtts(el, app, panels, b) {
  const box = el.querySelector("#brGtt");
  if (!box) return;
  const finishedOpen = box.querySelector("details.ow-done")?.open;
  box.innerHTML = await gttHtml();
  if (finishedOpen && box.querySelector("details.ow-done")) box.querySelector("details.ow-done").open = true;
  const n = el.querySelector("#brGttCount");
  if (n) n.textContent = view.gtts.filter((g) => ["active", "needs-login", "placing", "waiting-fill"].includes(g.status)).length;
  box.querySelectorAll("tr[data-s]").forEach((tr) => (tr.onclick = (e) => !e.target.closest("button") && app.setSymbol(tr.dataset.s)));
  box.querySelectorAll("[data-gtt-edit]").forEach((x) => (x.onclick = () => openGttEdit(el, app, panels, b, view.gtts.find((g) => g.id === x.dataset.gttEdit))));
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
