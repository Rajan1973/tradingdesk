import { api, download, esc, ticker, exchange } from "./api.js";
import { ChartPane, CHART_TYPES, newUid } from "./chart.js";
import { TOOLS } from "./drawings.js";
import {
  INDICATORS,
  BY_ID,
  registerIndicator,
  compute,
} from "../lib/indicators.js";
import { parseTf, toCsv } from "../lib/series.js";
import { initPanels } from "./panels.js";
import { MARKER_TYPES, markerSwatch, markerShape } from "../lib/marker-types.js";

const $ = (s, el = document) => el.querySelector(s);
// Symbol search market switch. Drawn as SVG: Windows shows flag emoji as plain letters.
const INDIA_FLAG = `<svg viewBox="0 0 30 20" width="22" height="15" aria-label="India"><rect width="30" height="20" fill="#fff"/><rect width="30" height="6.67" fill="#ff9933"/><rect y="13.33" width="30" height="6.67" fill="#138808"/><circle cx="15" cy="10" r="2.6" fill="none" stroke="#000080" stroke-width=".7"/><circle cx="15" cy="10" r=".6" fill="#000080"/></svg>`;
const GLOBE_ICON = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" aria-label="All markets"><circle cx="12" cy="12" r="9.5"/><path d="M2.5 12h19M12 2.5c2.8 2.6 4.2 5.8 4.2 9.5s-1.4 6.9-4.2 9.5c-2.8-2.6-4.2-5.8-4.2-9.5s1.4-6.9 4.2-9.5z"/></svg>`;
// Rows that open a chart when clicked, and so can be stepped through with the arrow keys.
const NAV_ROW = ".wl-row[data-sym], .cal-row[data-sym], tr[data-s]";
const TF_QUICK = ["1m", "5m", "15m", "1h", "4h", "1D", "1W"];
const LAYOUTS = { 1: 1, "2v": 2, "2h": 2, 3: 3, 4: 4, 6: 6, 8: 8, 16: 16 };
const DEFAULT_WATCHLISTS = {
  Main: [
    "BINANCE:BTCUSDT",
    "BINANCE:ETHUSDT",
    "BINANCE:SOLUSDT",
    "US:AAPL",
    "US:NVDA",
    "US:SPY",
    "US:QQQ",
    "FX:EURUSD",
  ],
};

class App {
  constructor() {
    this.panes = [];
    this.active = null;
    this.tool = "cursor";
    this.prices = {};
    this.priceListeners = new Set();
    this.saveTimer = null;
  }

  async init() {
    let state = {};
    try {
      state = await api.get("/api/state");
    } catch {
      /* first run */
    }
    this.state = {
      layout: "1",
      panes: [
        {
          symbol: "BINANCE:BTCUSDT",
          tf: "1D",
          type: "candles",
          indicators: [
            { uid: newUid(), id: "ema", params: { length: 21 } },
            { uid: newUid(), id: "rsi", params: {} },
          ],
        },
      ],
      watchlists: DEFAULT_WATCHLISTS,
      activeWatchlist: "Main",
      drawings: {},
      settings: {},
      paper: null,
      strategies: {},
      ...state,
    };
    this.settings = {
      theme: "dark",
      volume: true,
      bars: 3000,
      utc: false,
      stayInDrawMode: false,
      syncCrosshair: false,
      keyNav: true,
      ...this.state.settings,
    };
    this.state.settings = this.settings;
    document.documentElement.dataset.theme = this.settings.theme;
    await this.loadCustomIndicators();
    this.buildToolbar();
    this.buildDrawbar();
    this.setLayout(this.state.layout, false);
    this.panels = initPanels(this);
    this.bindKeys();
    this.listenAlerts();
    this.checkHealth();
    setInterval(() => this.checkHealth(), 60000);
  }

  // ---------- persistence ----------
  persist() {
    this.state.panes = this.panes.map((p) => p.cfg);
    this.state.active = this.panes.indexOf(this.active);
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(
      () =>
        api
          .put("/api/state", this.state)
          .catch((e) => this.toast(`Couldn't save: ${e.message}`, "err")),
      400,
    );
  }
  getDrawings(symbol) {
    return structuredClone(this.state.drawings[symbol] || []);
  }
  saveDrawings(symbol, items) {
    this.state.drawings[symbol] = items.map(
      ({ id, type, points, text, color, rr }) => ({
        id,
        type,
        points,
        text,
        color,
        rr,
      }),
    );
    for (const p of this.panes)
      if (p.cfg.symbol === symbol && p.drawings.items !== items)
        p.drawings.setItems(this.getDrawings(symbol));
    this.persist();
  }

  // ---------- custom indicators ----------
  async loadCustomIndicators() {
    try {
      const list = await api.get("/api/custom");
      for (const c of list) await this.importCustom(c.file, c.mtime);
    } catch {
      /* none */
    }
  }
  async importCustom(file, v = Date.now()) {
    try {
      const mod = await import(`/custom/${encodeURIComponent(file)}?v=${v}`);
      return registerIndicator({
        ...mod.default,
        id: `custom:${file.replace(/\.js$/, "")}`,
      });
    } catch (e) {
      this.toast(
        `Custom indicator ${file} failed to load: ${e.message}`,
        "err",
      );
      return null;
    }
  }

  // ---------- layout ----------
  setLayout(layout, save = true) {
    const count = LAYOUTS[layout] || 1;
    this.state.layout = String(layout);
    const grid = $("#grid");
    grid.dataset.count = count;
    const cols = {
      1: "1fr",
      2: layout === "2h" ? "1fr" : "1fr 1fr",
      3: "2fr 1fr",
      4: "1fr 1fr",
      6: "1fr 1fr 1fr",
      8: "1fr 1fr 1fr 1fr",
      16: "repeat(4, 1fr)",
    }[count];
    const rows = {
      1: "1fr",
      2: layout === "2h" ? "1fr 1fr" : "1fr",
      3: "1fr 1fr",
      4: "1fr 1fr",
      6: "1fr 1fr",
      8: "1fr 1fr",
      16: "repeat(4, 1fr)",
    }[count];
    grid.style.gridTemplateColumns = cols;
    grid.style.gridTemplateRows = rows;
    const cfgs = this.panes.length
      ? this.panes.map((p) => p.cfg)
      : this.state.panes;
    while (this.panes.length > count) this.panes.pop().destroy();
    const tfs = ["1D", "4h", "1h", "15m", "1W", "5m", "30m", "2h"];
    for (let i = 0; i < count; i++) {
      if (this.panes[i]) continue;
      const el = document.createElement("div");
      el.className = "pane";
      grid.appendChild(el);
      const base = cfgs[i] || {
        ...structuredClone(cfgs[0] || {}),
        tf: tfs[i % tfs.length],
        indicators: [],
      };
      const pane = new ChartPane(this, el, base);
      this.panes.push(pane);
      pane.load();
    }
    [...grid.children].forEach((el) => {
      if (!this.panes.some((p) => p.el === el)) el.remove();
    });
    if (count === 3) this.panes[0].el.style.gridRow = "span 2";
    else if (this.panes[0]) this.panes[0].el.style.gridRow = "";
    this.setActive(
      this.panes[Math.min(this.state.active ?? 0, count - 1)] || this.panes[0],
    );
    $("#layoutSel").value = this.state.layout;
    if (save) this.persist();
  }

  // ---------- layout templates ----------
  // A template is the whole chart area: the layout, and each chart's symbol, timeframe, chart type and
  // indicators with their settings. Kept in state.templates (data/state.json) under the name you give it.
  openTemplates() {
    const all = (this.state.templates ||= {});
    const summary = (t) =>
      t.panes.map((c) => `${ticker(c.symbol)} ${c.tf}${c.indicators?.length ? ` · ${c.indicators.length} ind.` : ""}`).join(", ");
    const rows = Object.entries(all)
      .sort((a, b) => b[1].savedAt - a[1].savedAt)
      .map(
        ([name, t]) =>
          `<tr><td class="l"><b>${esc(name)}</b><div class="hint-text">${esc(summary(t))}</div></td><td class="l muted">${esc($(`#layoutSel option[value="${t.layout}"]`)?.textContent || t.layout)}</td><td class="muted">${new Date(t.savedAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</td><td><button class="btn small primary" data-load="${esc(name)}">Open</button> <button class="btn small" data-del="${esc(name)}" title="Delete">×</button></td></tr>`,
      )
      .join("");
    const card = this.modal(
      "Layouts",
      `<div class="row-flex"><input id="tplName" class="search-in" style="flex:1" placeholder="Name for the current layout, e.g. Morning scan" autocomplete="off"><button class="btn primary" id="tplSave">Save current</button></div>
      <p class="hint-text">Saves the ${this.panes.length} chart${this.panes.length === 1 ? "" : "s"} on screen with their stocks, timeframes, chart types and indicators. Saving with an existing name replaces it.</p>
      ${rows ? `<table class="t"><thead><tr><th class="l">Saved layout</th><th class="l">Charts</th><th>Saved</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="hint-text">No saved layouts yet.</p>'}`,
      { wide: true },
    );
    const name = card.querySelector("#tplName");
    const save = () => {
      // The browser's own prompt is the fallback when the name box can't be typed in.
      const n = (name.value.trim() || prompt("Name for this layout:", "") || "").trim();
      if (!n) return;
      if (all[n] && !confirm(`Replace the saved layout "${n}"?`)) return;
      try {
        // A JSON copy, the same form the app saves state in, so nothing live is carried along.
        all[n] = { layout: this.state.layout, active: this.panes.indexOf(this.active), panes: JSON.parse(JSON.stringify(this.panes.map((p) => p.cfg))), savedAt: Date.now() };
      } catch (e) {
        return this.toast(`Couldn't save the layout: ${e.message}`, "err");
      }
      this.persist();
      this.toast(`Saved layout "${n}".`);
      this.openTemplates();
    };
    card.querySelector("#tplSave").onclick = save;
    // A block body: an on-handler returning false cancels the key, which stopped typing in the box.
    name.onkeydown = (e) => {
      if (e.key === "Enter") save();
    };
    card.querySelectorAll("[data-load]").forEach((b) => (b.onclick = () => this.loadTemplate(b.dataset.load)));
    // Clicks anywhere in the window keep the name box usable (and a stray chart key handler away from it).
    name.onmousedown = (e) => e.stopPropagation();
    card.querySelectorAll("[data-del]").forEach(
      (b) =>
        (b.onclick = () => {
          if (!confirm(`Delete the saved layout "${b.dataset.del}"?`)) return;
          delete all[b.dataset.del];
          this.persist();
          this.openTemplates();
        }),
    );
    setTimeout(() => name.focus(), 0);
  }

  loadTemplate(n) {
    const t = this.state.templates?.[n];
    if (!t) return;
    this.closeModal();
    while (this.panes.length) this.panes.pop().destroy();
    this.active = null;
    this.state.panes = JSON.parse(JSON.stringify(t.panes));
    this.state.active = t.active ?? 0;
    this.setLayout(t.layout);
    this.toast(`Opened layout "${n}".`);
  }

  setActive(pane) {
    if (!pane || this.active === pane) return;
    this.active?.el.classList.remove("active");
    this.active = pane;
    pane.el.classList.add("active");
    this.syncToolbar();
    this.panels?.onActiveChange?.();
  }

  onPaneLoaded(pane) {
    if (pane === this.active) {
      this.syncToolbar();
      this.panels?.onActiveChange?.();
    }
  }

  // ---------- toolbar ----------
  buildToolbar() {
    const tfBox = $("#tfButtons");
    tfBox.innerHTML = TF_QUICK.map(
      (t) => `<button data-tf="${t}">${t}</button>`,
    ).join("");
    tfBox.onclick = (e) => {
      const tf = e.target.dataset.tf;
      if (tf) this.setTf(tf);
    };
    $("#tfCustom").onkeydown = (e) => {
      if (e.key !== "Enter") return;
      const v = e.target.value
        .trim()
        .replace(/^(\d+)d$/i, "$1D")
        .replace(/^(\d+)w$/i, "$1W");
      try {
        parseTf(v);
        this.setTf(v);
        e.target.value = "";
        e.target.blur();
      } catch (err) {
        this.toast(err.message, "err");
      }
    };
    $("#chartType").innerHTML = CHART_TYPES.map(
      ([v, l]) => `<option value="${v}">${l}</option>`,
    ).join("");
    $("#chartType").onchange = (e) => {
      this.active.cfg.type = e.target.value;
      this.active.render(true);
      this.persist();
    };
    $("#symbolBtn").onclick = () => this.openSymbolSearch();
    $("#indicatorsBtn").onclick = () => this.openIndicatorPicker();
    $("#compareBtn").onclick = () =>
      this.openSymbolSearch(
        "",
        (sym) => {
          this.active.cfg.compare.push(sym);
          this.persist();
          this.active.load({ keepView: true });
        },
        "Compare with…",
      );
    $("#layoutSel").onchange = (e) => this.setLayout(e.target.value);
    $("#templatesBtn").onclick = () => this.openTemplates();
    $("#syncSymbol").checked = !!this.settings.syncSymbol;
    $("#syncSymbol").onchange = (e) => {
      this.settings.syncSymbol = e.target.checked;
      this.persist();
    };
    $("#replayBtn").onclick = () => {
      if (this.active.replay) return this.active.stopReplay();
      this.setTool("replay-pick");
      this.toast("Click the bar you want replay to start from.");
    };
    $("#alertBtn").onclick = () => this.panels.openAlertDialog();
    $("#logBtn").onclick = () => {
      this.active.cfg.log = !this.active.cfg.log;
      this.active.render(false);
      this.syncToolbar();
      this.persist();
    };
    $("#snapBtn").onclick = () =>
      this.active
        .screenshot()
        .toBlob((b) =>
          download(
            `${ticker(this.active.cfg.symbol)}-${this.active.cfg.tf}.png`,
            b,
          ),
        );
    $("#csvBtn").onclick = () => this.exportCsv();
    $("#themeBtn").onclick = () => {
      this.settings.theme = this.settings.theme === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = this.settings.theme;
      this.panes.forEach((p) => p.applyTheme());
      this.panels.onTheme?.();
      this.persist();
    };
    $("#settingsBtn").onclick = () => this.openSettings();
  }

  syncToolbar() {
    const p = this.active;
    if (!p) return;
    $("#symbolLabel").textContent = ticker(p.cfg.symbol);
    $("#symbolBtn").title =
      `${p.cfg.symbol} — change symbol (or just start typing)`;
    document
      .querySelectorAll("#tfButtons button")
      .forEach((b) => b.classList.toggle("active", b.dataset.tf === p.cfg.tf));
    $("#tfCustom").placeholder = TF_QUICK.includes(p.cfg.tf) ? "7m" : p.cfg.tf;
    $("#tfCustom").classList.toggle("on", !TF_QUICK.includes(p.cfg.tf));
    $("#chartType").value = p.cfg.type;
    $("#logBtn").classList.toggle("on", !!p.cfg.log);
    $("#replayBtn").classList.toggle("on", !!p.replay);
  }

  setTf(tf) {
    this.active.cfg.tf = tf;
    this.active.load();
    this.syncToolbar();
    this.persist();
  }

  setSymbol(sym, pane = this.active) {
    const targets = this.settings.syncSymbol ? this.panes : [pane];
    const loads = targets.map((p) => {
      p.cfg.symbol = sym;
      p.cfg.compare = p.cfg.compare.filter((s) => s !== sym);
      return p.load();
    });
    // A new instrument starts every chart from a clean view: latest bars, price scales fitted.
    const token = (this.symbolToken = {});
    Promise.allSettled(loads).then(() => {
      if (token === this.symbolToken) this.panes.forEach((p) => p.resetView());
    });
    this.syncToolbar();
    this.persist();
  }

  buildDrawbar() {
    const bar = $("#drawbar");
    bar.innerHTML =
      TOOLS.map(
        (t, i) =>
          `${i === 1 ? "<hr>" : ""}<button data-tool="${t.id}" title="${t.label}"><svg viewBox="0 0 24 24">${t.icon}</svg></button>`,
      ).join("") +
      '<hr><button data-act="alert" title="Alert when price crosses the selected line"><svg viewBox="0 0 24 24"><path d="M6 16V11a6 6 0 1 1 12 0v5l2 2H4zM10 20h4"/></svg></button>' +
      '<button data-act="delete" title="Delete selected drawing (Delete key)"><svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button>' +
      '<button data-act="clear" title="Remove all drawings on this symbol"><svg viewBox="0 0 24 24"><path d="M5 5l14 14M19 5L5 19"/></svg></button>';
    bar.onclick = (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.tool)
        this.setTool(this.tool === b.dataset.tool ? "cursor" : b.dataset.tool);
      if (b.dataset.act === "alert") this.alertOnSelectedDrawing();
      if (b.dataset.act === "delete" && !this.active.deleteSelectedDrawing())
        this.toast("Click a drawing first to select it.");
      if (
        b.dataset.act === "clear" &&
        confirm(`Remove every drawing on ${ticker(this.active.cfg.symbol)}?`)
      )
        this.active.clearDrawings();
    };
    this.setTool("cursor");
  }

  setTool(tool) {
    this.tool = tool;
    document
      .querySelectorAll("#drawbar [data-tool]")
      .forEach((b) => b.classList.toggle("active", b.dataset.tool === tool));
    for (const p of this.panes) p.setInteractive(tool === "cursor");
    document.body.style.cursor = tool === "cursor" ? "" : "crosshair";
  }

  // ---------- modals ----------
  modal(title, bodyHtml, { foot = "", wide = false } = {}) {
    const card = $("#modalCard");
    card.style.width = wide ? "min(780px, 96vw)" : "";
    card.innerHTML = `<div class="modal-head"><span>${esc(title)}</span><button data-close title="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div><div class="modal-body">${bodyHtml}</div>${foot ? `<div class="modal-foot">${foot}</div>` : ""}`;
    $("#modal").classList.remove("hidden");
    card.querySelector("[data-close]").onclick = () => this.closeModal();
    $("#modal").onmousedown = (e) => {
      if (e.target.id === "modal") this.closeModal();
    };
    return card;
  }
  closeModal() {
    $("#modal").classList.add("hidden");
    $("#modalCard").innerHTML = "";
  }

  openSymbolSearch(initial = "", onPick = null, title = "Symbol search") {
    // India (NSE .NS and BSE .BO only) or All markets; the choice is remembered.
    let market = "india";
    try {
      market = localStorage.getItem("qt.symMarket") === "all" ? "all" : "india";
    } catch {}
    const card = this.modal(
      title,
      `<div class="sym-row"><input class="search-in" id="symQ" autocomplete="off" value="${esc(initial)}"><div class="sym-mkt" role="group" aria-label="Market"><button type="button" data-m="india" title="India: NSE and BSE only">${INDIA_FLAG}</button><button type="button" data-m="all" title="All markets">${GLOBE_ICON}</button></div></div><div class="list" id="symList"></div><div class="hint-text" id="symHint" style="margin-top:8px"></div>`,
    );
    const q = card.querySelector("#symQ"),
      list = card.querySelector("#symList"),
      hint = card.querySelector("#symHint"),
      mkt = card.querySelector(".sym-mkt");
    const showMarket = () => {
      for (const b of mkt.children) b.classList.toggle("on", b.dataset.m === market);
      q.placeholder = market === "india" ? "Reliance, HDFCBANK, Nifty BeES…" : "BTC, AAPL, EURUSD, ^FTSE, VOD.L…";
      hint.textContent =
        market === "india"
          ? "India only: NSE (.NS) and BSE (.BO) stocks, SME stocks and ETFs. Search by code or company name. Click the globe for all markets."
          : "Crypto: Binance (falls back to Coinbase and Kraken). US stocks and ETFs: Nasdaq. Forex: Kraken. Global indices, futures and non-US stocks use Yahoo symbols (YAHOO:^FTSE, YAHOO:GC=F) when Yahoo is reachable.";
    };
    mkt.onclick = (e) => {
      const b = e.target.closest("button");
      if (!b || b.dataset.m === market) return q.focus();
      market = b.dataset.m;
      try {
        localStorage.setItem("qt.symMarket", market);
      } catch {}
      showMarket();
      q.focus();
      run();
    };
    // In India mode a bare code typed and entered opens its NSE listing.
    const raw = () => {
      const v = q.value.trim().toUpperCase();
      return market === "india" && /^[A-Z0-9&\-]+$/.test(v) ? `YAHOO:${v}.NS` : v;
    };
    let sel = 0,
      results = [],
      timer;
    const pick = (sym) => {
      this.closeModal();
      if (onPick) onPick(sym);
      else this.setSymbol(sym);
    };
    const draw = () => {
      list.innerHTML =
        results
          .map(
            (r, i) =>
              `<div class="item ${i === sel ? "sel" : ""}" data-i="${i}"><span><b>${esc(ticker(r.symbol))}</b> <span class="muted">${esc(r.name || "")}</span></span><span class="meta">${esc(r.type || "")} · ${esc(r.exchange || "")}</span></div>`,
          )
          .join("") ||
        (q.value.trim()
          ? `<div class="item" data-raw="1"><span>Open <b>${esc(ticker(raw()))}</b></span><span class="meta">press Enter</span></div>`
          : "");
    };
    const run = async () => {
      const v = q.value.trim(),
        m = market;
      if (!v) {
        results = [];
        draw();
        return;
      }
      try {
        results = await api.search(v, market);
        if (market === "india") results = results.filter((r) => /\.(NS|BO)$/i.test(r.symbol));
      } catch {
        results = [];
      }
      if (q.value.trim() === v && market === m) {
        sel = 0;
        draw();
      }
    };
    q.oninput = () => {
      clearTimeout(timer);
      timer = setTimeout(run, 180);
    };
    q.onkeydown = (e) => {
      if (e.key === "ArrowDown") {
        sel = Math.min(sel + 1, results.length - 1);
        draw();
        e.preventDefault();
      }
      if (e.key === "ArrowUp") {
        sel = Math.max(sel - 1, 0);
        draw();
        e.preventDefault();
      }
      if (e.key === "Enter") pick(results[sel]?.symbol || raw());
    };
    list.onclick = (e) => {
      const it = e.target.closest(".item");
      if (!it) return;
      pick(
        it.dataset.raw ? raw() : results[Number(it.dataset.i)].symbol,
      );
    };
    showMarket();
    q.focus();
    q.setSelectionRange(q.value.length, q.value.length);
    if (initial) run();
  }

  openIndicatorPicker() {
    const card = this.modal(
      "Indicators",
      `<input class="search-in" id="indQ" placeholder="Search ${INDICATORS.length} indicators…" autocomplete="off"><div class="list" id="indList"></div>`,
      {
        foot: '<span class="hint-text" style="margin-right:auto">No limit per chart. Write your own in the Indicator editor tab.</span><button class="btn" data-new>New custom indicator</button>',
      },
    );
    const q = card.querySelector("#indQ"),
      list = card.querySelector("#indList");
    const draw = () => {
      const term = q.value.trim().toLowerCase();
      const groups = {};
      for (const d of INDICATORS) {
        if (
          term &&
          !`${d.name} ${d.id} ${d.group}`.toLowerCase().includes(term)
        )
          continue;
        (groups[d.group || "Other"] ||= []).push(d);
      }
      list.innerHTML = Object.entries(groups)
        .sort(([g1], [g2]) => (g2 === "Quant (bonus)") - (g1 === "Quant (bonus)"))
        .map(
          ([g, ds]) =>
            `<div class="group ${g === "Quant (bonus)" ? "gold-text" : ""}">${esc(g)}</div>${ds.map((d) => `<div class="item" data-id="${esc(d.id)}"><span>${esc(d.name)}</span><span class="meta">${d.overlay ? "on price" : "own pane"}</span></div>`).join("")}`,
        )
        .join("");
    };
    q.oninput = draw;
    list.onclick = (e) => {
      const it = e.target.closest("[data-id]");
      if (!it) return;
      const uid = this.active.addIndicator(it.dataset.id);
      const anchor = (BY_ID[it.dataset.id].inputs || []).find((i) => i.type === "time");
      if (anchor) {
        this.closeModal();
        this.pickAnchor(this.active, uid, anchor.key);
      } else this.toast(`Added ${BY_ID[it.dataset.id].name}`);
    };
    card.querySelector("[data-new]").onclick = () => {
      this.closeModal();
      this.panels.showBottom("editor");
    };
    draw();
    q.focus();
  }

  /** Wait for a click on the chart and anchor indicator `uid` there (Anchored VWAP). Escape keeps the current anchor. */
  pickAnchor(pane, uid, key) {
    this.pendingAnchor = { pane, uid, key };
    this.setTool("anchor-pick");
    this.toast("Click the bar to anchor it to.");
  }

  openIndicatorSettings(pane, ind) {
    const def = BY_ID[ind.id];
    const fields = (def.inputs || [])
      .map((i) => {
        const v = ind.params?.[i.key] ?? i.default;
        if (i.type === "source") {
          // Indicators on indicators: any output of another indicator on this chart can be the source.
          const others = pane.cfg.indicators
            .filter((x) => x.uid !== ind.uid && !String(x.params?.source || "").includes(ind.uid) && BY_ID[x.id]?.outputs.length)
            .flatMap((x) => BY_ID[x.id].outputs.map((o) => [`ind:${x.uid}:${o.key}`, `${(/\(([^)]+)\)$/.exec(BY_ID[x.id].name)?.[1].split(" / ")[0] || BY_ID[x.id].name)} ${pane.indicatorParamsLabel(x)}: ${o.label}`]));
          const price = ["close", "open", "high", "low", "hl2", "hlc3", "ohlc4", "hlcc4"].map((s) => `<option ${s === v ? "selected" : ""}>${s}</option>`).join("");
          const inds = others.map(([val, label]) => `<option value="${esc(val)}" ${val === v ? "selected" : ""}>${esc(label)}</option>`).join("");
          return `<label class="field">${esc(i.label)}<select data-k="${i.key}"><optgroup label="Price">${price}</optgroup>${inds ? `<optgroup label="Another indicator">${inds}</optgroup>` : ""}</select></label>`;
        }
        if (i.type === "select")
          return `<label class="field">${esc(i.label)}<select data-k="${i.key}">${i.options.map((s) => `<option ${s === v ? "selected" : ""}>${s}</option>`).join("")}</select></label>`;
        if (i.type === "color") return `<label class="field">${esc(i.label)}<input data-k="${i.key}" type="color" value="${esc(v)}"></label>`;
        if (i.type === "time") {
          const local = v ? new Date((v - new Date(v * 1000).getTimezoneOffset() * 60) * 1000).toISOString().slice(0, 16) : "";
          return `<label class="field">${esc(i.label)}<input data-k="${i.key}" data-type="time" type="datetime-local" value="${local}"><button class="btn small" type="button" data-pick="${i.key}">Pick on chart</button></label>`;
        }
        return `<label class="field">${esc(i.label)}<input data-k="${i.key}" data-type="${i.type}" type="number" step="${i.type === "int" ? 1 : "any"}" value="${v}"></label>`;
      })
      .join("");
    const colors = def.outputs
      .map(
        (o) =>
          `<label class="field">${esc(o.label)}<input data-c="${o.key}" type="color" value="${(ind.colors?.[o.key] || o.color).slice(0, 7)}"></label>`,
      )
      .join("");
    const card = this.modal(
      def.name,
      `<div class="form-grid">${fields || '<span class="hint-text">No inputs.</span>'}<label class="field">Timeframe<select data-tf>${["", "5m", "15m", "1h", "4h", "1D", "1W", "1M"].map((t) => `<option value="${t}" ${(ind.tf || "") === t ? "selected" : ""}>${t || `Same as chart (${pane.cfg.tf})`}</option>`).join("")}</select></label></div><p class="hint-text">A higher timeframe shows its value once each of its bars has closed, so history never peeks ahead.</p>${colors ? `<h4>Colours</h4><div class="form-grid">${colors}</div>` : ""}`,
      {
        foot: '<button class="btn" data-reset>Defaults</button><button class="btn primary" data-ok>Apply</button>',
      },
    );
    card.querySelector("[data-ok]").onclick = () => {
      ind.params = {};
      card.querySelectorAll("[data-k]").forEach((el) => {
        ind.params[el.dataset.k] =
          el.dataset.type === "time"
            ? el.value
              ? Math.floor(new Date(el.value).getTime() / 1000)
              : 0
            : el.dataset.type
              ? Number(el.value)
              : el.value;
      });
      ind.colors = {};
      card.querySelectorAll("[data-c]").forEach((el) => {
        ind.colors[el.dataset.c] = el.value;
      });
      ind.tf = card.querySelector("[data-tf]").value || undefined;
      this.closeModal();
      pane.render(false);
      this.persist();
    };
    card.querySelectorAll("[data-pick]").forEach((b) => {
      b.onclick = () => {
        this.closeModal();
        this.pickAnchor(pane, ind.uid, b.dataset.pick);
      };
    });
    card.querySelector("[data-reset]").onclick = () => {
      ind.params = {};
      ind.colors = {};
      this.closeModal();
      pane.render(false);
      this.persist();
    };
  }

  // Remember which list a clicked row belongs to: the nearest element with an id, and which table
  // inside it (broker has holdings, orders, positions and GTTs), so it survives the list redrawing.
  navFrom(row) {
    const root = row.parentElement.closest("[id]");
    if (!root) return;
    const body = row.closest("tbody");
    this.nav = { id: root.id, table: body ? [...root.querySelectorAll("tbody")].indexOf(body) : -1, sym: row.dataset.sym || row.dataset.s };
  }

  navRows() {
    const nav = this.nav || { id: "wlRows", table: -1 };
    let scope = document.getElementById(nav.id);
    if (scope && nav.table >= 0) scope = scope.querySelectorAll("tbody")[nav.table];
    // A list that's closed or hidden (another tab) falls back to the watchlist.
    if (!scope || !scope.offsetParent) scope = document.getElementById("wlRows");
    return scope ? [...scope.querySelectorAll(NAV_ROW)].filter((r) => r.offsetParent) : [];
  }

  navStep(dir) {
    const rows = this.navRows();
    if (!rows.length) return false;
    const symOf = (r) => r.dataset.sym || r.dataset.s;
    const cur = this.nav?.sym || this.active?.cfg.symbol;
    let i = rows.findIndex((r) => r.classList.contains("kb-sel"));
    if (i < 0) i = rows.findIndex((r) => symOf(r) === cur);
    const next = rows[Math.max(0, Math.min(rows.length - 1, i < 0 ? 0 : i + dir))];
    rows.forEach((r) => r.classList.toggle("kb-sel", r === next));
    next.scrollIntoView({ block: "nearest" });
    this.navFrom(next);
    // Holding the key skims the list; the chart loads once you stop on a stock.
    clearTimeout(this.navTimer);
    this.navTimer = setTimeout(() => this.setSymbol(symOf(next)), 180);
    return true;
  }

  openSettings() {
    const s = this.settings;
    const card = this.modal(
      "Settings",
      `<div class="form-grid">
      <label class="field">Bars to load per chart<input id="sBars" type="number" min="200" max="20000" step="100" value="${s.bars}"></label>
      <label class="field">Time axis<select id="sUtc"><option value="0" ${!s.utc ? "selected" : ""}>My local time</option><option value="1" ${s.utc ? "selected" : ""}>UTC</option></select></label>
      <label class="field">Volume on the price chart<select id="sVol"><option value="1" ${s.volume ? "selected" : ""}>Show</option><option value="0" ${!s.volume ? "selected" : ""}>Hide</option></select></label>
      <label class="field">After placing a drawing<select id="sStay"><option value="0" ${!s.stayInDrawMode ? "selected" : ""}>Back to cursor</option><option value="1" ${s.stayInDrawMode ? "selected" : ""}>Keep the tool</option></select></label>
      <label class="field">Indian chart prices<select id="sFeed"><option value="yahoo" ${s.chartFeed !== "kotak" ? "selected" : ""}>Yahoo</option><option value="kotak" ${s.chartFeed === "kotak" ? "selected" : ""}>Yahoo history + Kotak Neo live price</option></select></label>
      <label class="field">↑ ↓ keys<select id="sKeyNav"><option value="1" ${s.keyNav !== false ? "selected" : ""}>Step through the stock list</option><option value="0" ${s.keyNav === false ? "selected" : ""}>Do nothing</option></select></label>
      <label class="field">Crosshair across charts<select id="sSync"><option value="0" ${!s.syncCrosshair ? "selected" : ""}>Independent</option><option value="1" ${s.syncCrosshair ? "selected" : ""}>Synced</option></select></label>
    </div>
    <div class="mk-filter"><div class="row-flex" style="align-items:center"><b>Chart markers</b><span class="hint-text">Which events show above the candles on daily charts</span><span class="spacer"></span><button class="btn small" data-mk="all">All</button><button class="btn small" data-mk="none">None</button></div>
    <p class="hint-text mk-key">Shapes: ${markerShape("circle", "#9e9e9e")} circle = company event · ${markerShape("square", "#9e9e9e")} square = negative news (fraud, default, penalty) · ${markerShape("diamond", "#9e9e9e")} diamond = analyst call. Hover over any marker on a chart for the details.</p>
    <div class="mk-grid">${MARKER_TYPES.map(([id, label]) => `<label class="${id === "analyst" || id === "mine" ? "mk-wide" : ""}"><input type="checkbox" data-mt="${esc(id)}" ${(s.markerHidden || []).includes(id) ? "" : "checked"}>${id === "analyst" || id === "mine" ? `${esc(label)}<span class="mk-shapes" style="margin-left:6px">${markerSwatch(id)}</span>` : `<span class="mk-shapes">${markerSwatch(id)}</span>${esc(label)}`}</label>`).join("")}</div></div>
    <div class="mk-filter"><b>Broker accounts</b> <span class="hint-text">Add, rename or remove accounts in <code>data/brokers.json</code>; log in from the Broker tab.</span><div id="sAccounts" class="hint-text" style="margin-top:6px">Loading…</div></div>
    <p class="hint-text">Everything you save lives in the <code>data</code> folder next to the app, on your machine.</p>
    <p><a class="btn" href="/manual.html?theme=${s.theme === "light" ? "light" : "dark"}" target="_blank" rel="noopener">📖 Open the user manual</a> <span class="hint-text">Every feature explained, in a new tab.</span></p>`,
      { foot: '<button class="btn primary" data-ok>Save</button>' },
    );
    api.get("/api/broker/status").then(
      (st) => {
        const box = card.querySelector("#sAccounts");
        if (!box) return;
        box.innerHTML = st.accounts.length
          ? `<table class="t"><thead><tr><th class="l">Name</th><th class="l">Broker</th><th class="l">Id</th><th class="l">Status</th></tr></thead><tbody>${st.accounts
              .map((a) => `<tr><td class="l">${esc(a.name)}</td><td class="l">${esc(a.brokerName)}</td><td class="l muted">${esc(a.id)}</td><td class="l ${a.connected ? "up" : ""}">${a.connected ? `Connected${a.user ? ` (${esc(a.user)})` : ""}` : a.configured ? "Set up, not logged in" : "Keys not added yet"}</td></tr>`)
              .join("")}</tbody></table>`
          : "No broker accounts yet.";
      },
      () => {},
    );
    card.querySelectorAll("[data-mk]").forEach(
      (b) => (b.onclick = () => card.querySelectorAll("[data-mt]").forEach((c) => (c.checked = b.dataset.mk === "all"))),
    );
    card.querySelector("[data-ok]").onclick = () => {
      Object.assign(s, {
        markerHidden: [...card.querySelectorAll("[data-mt]")].filter((c) => !c.checked).map((c) => c.dataset.mt),
        bars: Math.max(200, Math.min(20000, Number($("#sBars").value) || 3000)),
        utc: $("#sUtc").value === "1",
        volume: $("#sVol").value === "1",
        stayInDrawMode: $("#sStay").value === "1",
        syncCrosshair: $("#sSync").value === "1",
        keyNav: $("#sKeyNav").value === "1",
        chartFeed: $("#sFeed").value,
      });
      this.closeModal();
      this.persist();
      this.panes.forEach((p) => p.load({ keepView: true }));
    };
  }

  syncCrosshair(src, p) {
    const utc = src.timeOfLogical(p.logical);
    for (const pane of this.panes) {
      if (pane === src || !pane.shown.length) continue;
      const l = pane.logicalOf(utc);
      const i = Math.max(0, Math.min(pane.shown.length - 1, Math.round(l)));
      const b = pane.shown[i];
      if (b) pane.chart.setCrosshairPosition(b.close, pane.times[i], pane.main);
    }
  }

  exportCsv() {
    const p = this.active;
    const extra = {};
    for (const ind of p.cfg.indicators) {
      const def = BY_ID[ind.id];
      const res = p.indResults[ind.uid] || {};
      for (const o of def?.outputs || [])
        if (Array.isArray(res[o.key])) extra[`${ind.id}_${o.key}`] = res[o.key];
    }
    download(`${ticker(p.cfg.symbol)}-${p.cfg.tf}.csv`, toCsv(p.shown, extra));
  }

  // ---------- keys ----------
  bindKeys() {
    // Up / Down step through the list you last clicked a stock in (watchlist, screener, broker
    // holdings / orders / positions / GTTs, calendar) and open each one's chart.
    document.addEventListener(
      "pointerdown",
      (e) => {
        const row = e.target.closest?.(NAV_ROW);
        if (row) this.navFrom(row);
      },
      true,
    );
    document.addEventListener("keydown", (e) => {
      const typing = /INPUT|TEXTAREA|SELECT/.test(
        document.activeElement?.tagName,
      );
      if (e.key === "Escape") {
        if (!$("#modal").classList.contains("hidden")) return this.closeModal();
        if (this.tool !== "cursor") return this.setTool("cursor");
        if (this.active?.drawings.selected) {
          this.active.drawings.selected = null;
          this.active.drawings.update();
        }
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (
        (e.key === "Delete" || e.key === "Backspace") &&
        this.active?.deleteSelectedDrawing()
      ) {
        e.preventDefault();
        return;
      }
      if (!$("#modal").classList.contains("hidden")) return;
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && this.settings.keyNav !== false && this.navStep(e.key === "ArrowDown" ? 1 : -1)) {
        e.preventDefault();
        return;
      }
      if (/^[a-z0-9^]$/i.test(e.key)) {
        e.preventDefault();
        this.openSymbolSearch(e.key.toUpperCase());
      }
    });
  }

  // A drawn line as an alert condition: trend lines and rays are checked at the line's price on
  // each bar, on the server, so they fire with this tab closed.
  lineOperandFor(d) {
    const [a, b] = d.points;
    const line = (extend, label) => ({ kind: "line", label, line: { t1: a.time, p1: a.price, t2: b.time, p2: b.price, extend } });
    switch (d.type) {
      case "hline": return { kind: "value", v: Number(a.price.toPrecision(8)) };
      case "hray": return { kind: "line", label: "Horizontal ray", line: { t1: a.time, p1: a.price, t2: a.time + 1, p2: a.price, extend: "right" } };
      case "trend": return line("none", "Trend line (between its two points)");
      case "ray": return line("right", "Ray");
      case "extended": return line("both", "Extended line");
      case "channel": return line("none", "Channel's first line");
      default: return null;
    }
  }

  alertOnSelectedDrawing() {
    const d = this.active?.drawings.selected;
    if (!d) return this.toast("Click a line on the chart first to select it.");
    const right = this.lineOperandFor(d);
    if (!right) return this.toast("Alerts work on trend lines, rays, extended and horizontal lines.");
    this.panels.openAlertDialog({ rules: [{ left: { kind: "price", field: "close" }, op: "crosses", right }] });
  }

  // ---------- replay across charts ----------
  syncReplayFrom(pane, bar) {
    if (!bar) return;
    const end = bar.time + parseTf(pane.cfg.tf).seconds;
    for (const p of this.panes) if (p !== pane && p.bars.length && !(p.replay && !p.replay.follower)) p.replayTo(end);
  }
  onReplayStart(pane) {
    if (this.settings.syncReplay && !pane.replay?.follower) this.syncReplayFrom(pane, pane.bars[pane.replay.index]);
    this.syncToolbar();
    this.panels?.onReplayChange?.();
  }
  onReplayBar(pane, bar) {
    if (this.settings.syncReplay && !pane.replay?.follower) this.syncReplayFrom(pane, bar);
    this.panels?.onReplayBar?.(pane, bar);
  }
  onReplayStop(pane) {
    for (const p of this.panes) if (p !== pane && p.replay?.follower) p.stopReplay();
    this.syncToolbar();
    this.panels?.onReplayChange?.();
  }

  // ---------- prices, alerts, status ----------
  onPrice(symbol, price) {
    this.prices[symbol] = price;
    for (const fn of this.priceListeners) fn(symbol, price);
  }

  listenAlerts() {
    const es = new EventSource("/api/events");
    es.addEventListener("alert", (m) => {
      const e = JSON.parse(m.data);
      this.toast(`<b>Alert</b><br>${esc(e.text)}`, "alert", 12000);
      this.beep();
      if ("Notification" in window && Notification.permission === "granted")
        new Notification("Quant Terminal alert", { body: e.text });
      this.panels?.onAlertFired?.(e);
    });
  }

  beep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator(),
        g = ctx.createGain();
      o.connect(g);
      g.connect(ctx.destination);
      o.frequency.value = 880;
      g.gain.value = 0.08;
      o.start();
      o.stop(ctx.currentTime + 0.25);
    } catch {
      /* no audio */
    }
  }

  async checkHealth() {
    try {
      const h = await api.get("/api/health");
      const failing = Object.entries(h.providers || {})
        .filter(([, v]) => !v.ok)
        .map(([k]) => k);
      this.setStatus(
        failing.length ? "warn" : "ok",
        failing.length
          ? `Some sources are failing (${failing.join(", ")}); fallbacks are in use.`
          : "All data sources responding",
      );
    } catch {
      this.setStatus(
        "bad",
        "The local server is not responding. Is it still running?",
      );
    }
  }
  setStatus(level, title) {
    const el = $("#status");
    el.className = `status ${level}`;
    if (title) el.title = title;
  }

  toast(html, kind = "", ms = 3500) {
    const el = document.createElement("div");
    el.className = `toast ${kind}`;
    el.innerHTML = html;
    $("#toasts").appendChild(el);
    setTimeout(() => el.remove(), ms);
  }
}

const app = new App();
window.app = app;
app.init().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML(
    "beforeend",
    `<div class="toast err" style="position:fixed;left:20px;bottom:20px">Startup failed: ${esc(e.message)}</div>`,
  );
});
