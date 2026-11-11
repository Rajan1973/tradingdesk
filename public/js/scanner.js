// Scanner panel: daily setups + opening-range breakouts across an NSE index, with "Watch entry"
// (arms an alert that fires on the first closed bar past a level) and "Plan exit" (stop/target
// calculator) actions per row. A match is "matched a rule", never a recommendation.
import { api, esc, fmtPrice } from "./api.js";

const SETUP_LABEL = {
  breakout_20d: "20D breakout",
  reclaim_ma20: "Reclaim MA20",
  oversold: "Oversold (RSI<30)",
  oversold_bounce: "Oversold bounce",
  bull_flag: "Bull flag",
  orb_breakout: "ORB breakout",
};

const sn = { universe: "nifty500", filter: "all", data: { daily: [], orb: [], updatedAt: null } };

export async function renderScanner(el, app) {
  el.innerHTML = `
    <div class="pad row-flex">
      <select id="snUniverse" class="field">
        <option value="nifty500">Nifty 500</option>
        <option value="nifty50">Nifty 50</option>
        <option value="bank">Nifty Bank</option>
        <option value="it">Nifty IT</option>
      </select>
      <select id="snFilter" class="field">
        <option value="all">All setups</option>
        ${Object.entries(SETUP_LABEL).map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}
      </select>
      <button id="snRun" class="btn">Scan now</button>
      <span class="spacer"></span>
      <span id="snUpdated" class="hint-text"></span>
    </div>
    <div id="snTable"></div>
    <div class="pad hint-text">A scan is a list of charts that match a rule, not a list of stocks to buy.</div>`;

  const $ = (s) => el.querySelector(s);
  $("#snUniverse").value = sn.universe;
  $("#snUniverse").onchange = () => (sn.universe = $("#snUniverse").value);
  $("#snFilter").onchange = () => (sn.filter = $("#snFilter").value, draw());
  $("#snRun").onclick = async () => {
    $("#snRun").disabled = true;
    $("#snRun").textContent = "Scanning…";
    try {
      sn.data = await api.post("/api/scanner/run", { universe: sn.universe });
    } catch (e) {
      app.toast(e.message, "err");
    } finally {
      $("#snRun").disabled = false;
      $("#snRun").textContent = "Scan now";
      draw();
    }
  };

  try {
    sn.data = await api.get("/api/scanner/watchlist");
  } catch {
    sn.data = { daily: [], orb: [], updatedAt: null };
  }
  draw();

  function rows() {
    const all = [...(sn.data.daily || []), ...(sn.data.orb || [])];
    return sn.filter === "all" ? all : all.filter((r) => r.setup === sn.filter);
  }

  function draw() {
    const box = el.querySelector("#snTable");
    el.querySelector("#snUpdated").textContent = sn.data.updatedAt ? `Updated ${new Date(sn.data.updatedAt).toLocaleTimeString()}` : "Not scanned yet";
    const r = rows();
    if (!r.length) {
      box.innerHTML = `<div class="pad hint-text">No matches. Click "Scan now" to run one.</div>`;
      return;
    }
    box.innerHTML = `<table class="t"><thead><tr><th>Symbol</th><th class="l">Name</th><th>Setup</th><th>Level</th><th>Close</th><th></th></tr></thead><tbody>${r
      .map(
        (row, i) =>
          `<tr data-i="${i}" data-s="${esc(row.symbol)}"><td><b>${esc(row.ticker)}</b></td><td class="l muted">${esc((row.name || "").slice(0, 32))}</td><td><span class="pill">${SETUP_LABEL[row.setup] || row.setup}</span></td><td>${fmtPrice(row.level)}</td><td>${fmtPrice(row.close ?? row.price)}</td><td><button data-watch="${i}" class="btn small">Watch entry</button> <button data-plan="${i}" class="btn small">Plan exit</button></td></tr>`,
      )
      .join("")}</tbody></table>`;
    box.querySelectorAll("[data-s]").forEach((tr) => (tr.onclick = (e) => {
      if (e.target.closest("button")) return;
      app.setSymbol(tr.dataset.s);
    }));
    box.querySelectorAll("[data-watch]").forEach((btn) => (btn.onclick = () => armEntry(r[Number(btn.dataset.watch)], app)));
    box.querySelectorAll("[data-plan]").forEach((btn) => (btn.onclick = () => planExit(r[Number(btn.dataset.plan)], app)));
  }
}

async function armEntry(row, app) {
  const level = prompt(`Entry level for ${row.ticker} (close must cross above this on a closed 5m bar):`, row.level ?? row.close);
  if (level == null) return;
  try {
    await api.post("/api/entry/arm", { symbol: row.symbol, level: Number(level), tf: "5m", message: `Entry: ${row.ticker} closed above ${level}` });
    app.toast(`Entry watch armed for ${row.ticker}. See it in the Alerts tab.`);
  } catch (e) {
    app.toast(e.message, "err");
  }
}

async function planExit(row, app) {
  const entry = Number(prompt(`Entry price for ${row.ticker}:`, row.close ?? row.level));
  if (!entry) return;
  const stopRule = row.orHigh != null && row.orLow != null ? "or-mid" : { pct: 1.5 };
  try {
    const plan = await api.post("/api/exit-plan", { symbol: row.symbol, entry, stopRule, targetRule: { r: 2 }, orHigh: row.orHigh, orLow: row.orLow });
    app.modal(`Exit plan: ${row.ticker}`, `<div class="pad">
      <div>Entry <b>${fmtPrice(plan.entry)}</b></div>
      <div>Stop <b>${fmtPrice(plan.stop)}</b> (risk ${fmtPrice(plan.riskPerShare)}/share)</div>
      <div>Target <b>${fmtPrice(plan.target)}</b> (reward:risk ${plan.rewardRisk})</div>
      <div>Flat by <b>${plan.flatBy}</b> IST</div>
      <div class="hint-text" style="margin-top:8px">A stop is a plan, not a guarantee. Enter these numbers in the Broker tab's OCO ticket once your position is open.</div>
    </div>`);
  } catch (e) {
    app.toast(e.message, "err");
  }
}
