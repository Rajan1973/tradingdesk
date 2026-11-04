// The order flow test screen: footprint cells on a candle chart, with delta and cumulative delta
// below. History comes from the server; live trades come straight from Binance in the browser.
import { addTrade, divergence, imbalances, sessionDelta, totals, TF_MS } from "/lib/footprint.js";
import { sessionProfiles } from "/lib/market-profile.js";
import { drawProfiles } from "/js/market-profile-draw.js";

const LW = window.LightweightCharts;
const $ = (id) => document.getElementById(id);
const IST = 19800; // the chart's clock shows India time
const HOSTS = ["wss://stream.binance.com:9443/ws/", "wss://data-stream.binance.vision/ws/"];
const UP = "#26a69a", DOWN = "#ef5350", DIVERGE = "#9333ea";
const panel = new URLSearchParams(location.search).get("panel");
const SAVED = panel ? `qt.orderflow.${panel}` : "qt.orderflow";
if (panel) document.body.classList.add("embed");

const view = { tf: "5m", step: 100, view: "bidask", ratio: 3, minQty: 0.5 };
try {
  Object.assign(view, JSON.parse(localStorage.getItem(SAVED) || "{}"));
} catch { /* the defaults do */ }
for (const k of ["tf", "step", "view", "ratio", "minQty"]) $(k).value = view[k];
const isProfile = () => view.view === "profile";
const tfNow = () => (isProfile() ? "30m" : view.tf); // Market Profile prints one letter per 30 minutes

let bars = [], byAt = new Map(), through = 0, live = [], cvdBefore = 0, requestDraw = () => {};
let wsOpen = false, tradesThisTick = 0, footprintOn = null, dirty = false, loaded = false;
let diverged = new Map(), closed = null; // bar time -> "bear" or "bull"; only finished bars are judged

const chart = LW.createChart($("chart"), {
  autoSize: true,
  layout: { attributionLogo: false, background: { color: "#ffffff" }, textColor: "#374151", fontSize: 11, panes: { separatorColor: "#e5e7eb" } },
  grid: { vertLines: { color: "#f3f4f6" }, horzLines: { color: "#f3f4f6" } },
  timeScale: { timeVisible: true, secondsVisible: false, borderColor: "#e5e7eb", barSpacing: 90, minBarSpacing: 1, rightOffset: 4 },
  rightPriceScale: { borderColor: "#e5e7eb" },
  crosshair: { mode: LW.CrosshairMode.Normal },
});
const candles = chart.addSeries(LW.CandlestickSeries, { upColor: UP, downColor: DOWN, wickUpColor: UP, wickDownColor: DOWN, borderVisible: false, priceFormat: { type: "price", precision: 1, minMove: 0.1 } });
const qtyFormat = { type: "volume" };
const deltaSeries = chart.addSeries(LW.HistogramSeries, { priceFormat: qtyFormat, title: "Delta", priceLineVisible: false, lastValueVisible: true }, 1);
const cvdSeries = chart.addSeries(LW.LineSeries, { color: "#4338ca", lineWidth: 1.5, priceFormat: qtyFormat, title: "CVD", priceLineVisible: false }, 2);
const ts = chart.timeScale();

const qty = (v) => {
  if (!v) return "·";
  const a = Math.abs(v);
  return a >= 1000 ? `${(v / 1000).toFixed(1)}k` : a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2);
};

// ---------- the footprint layer ----------
function drawMarketProfile(ctx) {
  const range = ts.getVisibleLogicalRange();
  if (!range) return;
  // UTC days, because crypto has no closing bell. The lowest letter is the 00:00 UTC (05:30 IST) one.
  const rows = bars.map((b) => ({ time: b.at / 1000, high: b.h, low: b.l }));
  const fits = drawProfiles(ctx, sessionProfiles(rows, (t) => Math.floor(t / 86400), { periodSec: 1800, step: view.step }), {
    priceToY: (v) => candles.priceToCoordinate(v),
    xOf: (i) => ts.logicalToCoordinate(i),
    spacing: ts.options().barSpacing,
    lastIndex: bars.length - 1,
    from: range.from,
    to: range.to,
  });
  const hint = fits ? "" : "Letters hidden: zoom in or pick a larger row size.";
  if ($("hint").textContent !== hint) $("hint").textContent = hint;
}

function drawFootprint(ctx) {
  if (view.view === "candles" || !bars.length) return;
  if (isProfile()) return drawMarketProfile(ctx);
  const range = ts.getVisibleLogicalRange();
  const spacing = ts.options().barSpacing;
  if (!range || spacing < 6) return;
  const from = Math.max(0, Math.floor(range.from)), to = Math.min(bars.length - 1, Math.ceil(range.to));
  const step = view.step;
  const y0 = candles.priceToCoordinate(bars[to].c), y1 = candles.priceToCoordinate(bars[to].c + step);
  if (y0 == null || y1 == null) return;
  const rowH = Math.abs(y0 - y1);
  if (rowH < 1) return;

  let most = 0;
  for (let i = from; i <= to; i++)
    for (const [b, s] of Object.values(bars[i].cells)) most = Math.max(most, view.view === "bidask" ? Math.max(b, s) : b + s);
  const shade = (v) => 0.06 + 0.6 * Math.sqrt(Math.min(1, v / (most || 1)));

  const stick = spacing >= 24 ? 6 : 0; // room on the left for a small candle
  const width = spacing * 0.9 - stick;
  const twoCols = view.view === "bidask";
  const showText = rowH >= 11 && width >= (twoCols ? 46 : 28);
  ctx.font = "10px system-ui, 'Segoe UI', sans-serif";
  ctx.textBaseline = "middle";
  const hint = showText ? "" : rowH < 11 ? "Numbers hidden: rows are too thin. Pick a larger row size." : "Numbers hidden: zoom in on the bars.";
  if ($("hint").textContent !== hint) $("hint").textContent = hint;

  for (let i = from; i <= to; i++) {
    const bar = bars[i];
    const cx = ts.logicalToCoordinate(i);
    if (cx == null) continue;
    const left = cx - spacing * 0.45 + stick;
    const { poc } = totals(bar);
    const marks = spacing >= 20 ? imbalances(bar, step, view.ratio, view.minQty) : null;

    for (const [key, [b, s]] of Object.entries(bar.cells)) {
      const p = +key;
      const top = candles.priceToCoordinate(p + step), bottom = candles.priceToCoordinate(p);
      if (top == null || bottom == null) continue;
      const h = Math.max(1, bottom - top - (rowH >= 4 ? 1 : 0));
      if (twoCols) {
        ctx.fillStyle = `rgba(239,83,80,${shade(s)})`;
        ctx.fillRect(left, top, width / 2, h);
        ctx.fillStyle = `rgba(38,166,154,${shade(b)})`;
        ctx.fillRect(left + width / 2, top, width / 2, h);
      } else if (view.view === "delta") {
        ctx.fillStyle = b >= s ? `rgba(38,166,154,${shade(Math.abs(b - s))})` : `rgba(239,83,80,${shade(Math.abs(b - s))})`;
        ctx.fillRect(left, top, width, h);
      } else {
        ctx.fillStyle = `rgba(67,56,202,${shade(b + s)})`;
        ctx.fillRect(left, top, width, h);
      }
      if (showText) {
        const mid = top + h / 2;
        const put = (text, x, align, strong) => {
          ctx.textAlign = align;
          ctx.font = `${strong ? "700 " : ""}10px system-ui, 'Segoe UI', sans-serif`;
          ctx.fillStyle = strong || "#111827";
          ctx.fillText(text, x, mid);
        };
        if (twoCols) {
          put(qty(s), left + width / 2 - 3, "right", marks?.sells.has(p) ? "#8e0000" : null);
          put(qty(b), left + width / 2 + 3, "left", marks?.buys.has(p) ? "#004d40" : null);
        } else put(qty(view.view === "delta" ? b - s : b + s), left + width / 2, "center");
      }
      if (p === poc && spacing >= 20) {
        ctx.strokeStyle = "#f57c00";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(left + 0.5, top + 0.5, width - 1, Math.max(1, h - 1));
      }
    }

    for (const st of marks?.stacks || []) {
      const top = candles.priceToCoordinate(st.to + step), bottom = candles.priceToCoordinate(st.from);
      if (top == null || bottom == null) continue;
      ctx.fillStyle = st.side === "buy" ? "#00796b" : "#c62828";
      ctx.fillRect(left + width + 1, top, 3, bottom - top);
    }

    if (stick) {
      const color = bar.c >= bar.o ? UP : DOWN;
      const x = Math.round(left - 4), yO = candles.priceToCoordinate(bar.o), yC = candles.priceToCoordinate(bar.c);
      const yH = candles.priceToCoordinate(bar.h), yL = candles.priceToCoordinate(bar.l);
      if ([yO, yC, yH, yL].some((v) => v == null)) continue;
      ctx.fillStyle = color;
      ctx.fillRect(x, yH, 1, yL - yH);
      ctx.fillRect(x - 2, Math.min(yO, yC), 5, Math.max(1, Math.abs(yO - yC)));
    }
  }
}

// A purple triangle clear of the bar: above it on a bearish divergence, below it on a bullish one.
// Not on Market Profile, whose letters aren't bars.
function drawDivergences(ctx) {
  const range = ts.getVisibleLogicalRange();
  if (isProfile() || !range) return;
  const step = view.step;
  ctx.fillStyle = DIVERGE;
  for (let i = Math.max(0, Math.floor(range.from)); i <= Math.min(bars.length - 1, Math.ceil(range.to)); i++) {
    const side = diverged.get(bars[i].at);
    if (!side) continue;
    const bear = side === "bear";
    const x = ts.logicalToCoordinate(i);
    const y = candles.priceToCoordinate(bear ? (Math.floor(bars[i].h / step) + 1) * step : Math.floor(bars[i].l / step) * step);
    if (x == null || y == null) continue;
    const tip = bear ? y - 3 : y + 3, base = bear ? y - 10 : y + 10;
    ctx.beginPath();
    ctx.moveTo(x, tip);
    ctx.lineTo(x - 5, base);
    ctx.lineTo(x + 5, base);
    ctx.fill();
  }
}

candles.attachPrimitive({
  attached({ requestUpdate }) {
    requestDraw = requestUpdate;
  },
  updateAllViews() {},
  paneViews: () => [
    {
      zOrder: () => "top",
      renderer: () => ({
        draw: (t) =>
          t.useMediaCoordinateSpace(({ context }) => {
            drawFootprint(context);
            drawDivergences(context);
          }),
      }),
    },
  ],
});

// The running total for the session, in the top right corner of the delta chart.
deltaSeries.attachPrimitive({
  updateAllViews() {},
  paneViews: () => [
    {
      zOrder: () => "top",
      renderer: () => ({
        draw: (t) =>
          t.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
            if (!bars.length) return;
            const sum = sessionDelta(bars);
            ctx.font = "600 12px system-ui, 'Segoe UI', sans-serif";
            ctx.textAlign = "right";
            ctx.textBaseline = "top";
            ctx.fillStyle = sum >= 0 ? "#00796b" : "#c62828";
            ctx.fillText(`Session delta ${sum >= 0 ? "+" : ""}${qty(sum)} BTC`, mediaSize.width - 8, 6);
          }),
      }),
    },
  ],
});

// The library's candles step aside once the footprint draws its own.
function syncCandleColors() {
  const on = isProfile() || (view.view !== "candles" && ts.options().barSpacing >= 6);
  if (on === footprintOn) return;
  footprintOn = on;
  const clear = "rgba(0,0,0,0)";
  candles.applyOptions(
    on
      ? { upColor: clear, downColor: clear, wickUpColor: clear, wickDownColor: clear, lastValueVisible: true }
      : { upColor: UP, downColor: DOWN, wickUpColor: UP, wickDownColor: DOWN },
  );
}
ts.subscribeVisibleLogicalRangeChange(() => {
  syncCandleColors();
  requestDraw();
});

// ---------- series ----------
const toTime = (b) => b.at / 1000 + IST;
const candlePoint = (b) => ({ time: toTime(b), open: b.o, high: b.h, low: b.l, close: b.c });
const deltaPoint = (b, d) => ({ time: toTime(b), value: d, color: diverged.has(b.at) ? DIVERGE : d >= 0 ? UP : DOWN });
const judge = (i) => {
  const side = divergence(bars, i);
  if (side) diverged.set(bars[i].at, side);
};

function setAll() {
  let cum = 0;
  const cvd = [], delta = [];
  diverged = new Map();
  closed = null;
  for (let i = 0; i < bars.length - 1; i++) judge(i);
  for (const b of bars) {
    const d = totals(b).delta;
    cum += d;
    cvd.push({ time: toTime(b), value: cum });
    delta.push(deltaPoint(b, d));
  }
  cvdBefore = cum - (bars.length ? totals(bars.at(-1)).delta : 0);
  candles.setData(bars.map(candlePoint));
  deltaSeries.setData(delta);
  cvdSeries.setData(cvd);
  chart.panes().forEach((p, i) => p.setStretchFactor(i === 0 ? 5 : 1));
  requestDraw();
}

// A live trade goes into its bar; a new bar moves the cumulative delta along.
function addLive(tr) {
  if (!loaded || tr.t < through) return;
  const before = bars.at(-1);
  const bar = addTrade(byAt, tr.t, tr.price, tr.qty, tr.isSell, TF_MS[tfNow()], view.step);
  if (bar !== before && bar.at > (before?.at ?? 0)) {
    if (before) cvdBefore += totals(before).delta;
    bars.push(bar);
    closed = before;
  }
  dirty = true;
}

setInterval(() => {
  if (!dirty || !bars.length) return;
  dirty = false;
  if (closed) {
    judge(bars.length - 2);
    deltaSeries.update(deltaPoint(closed, totals(closed).delta));
    closed = null;
  }
  const b = bars.at(-1), d = totals(b).delta;
  candles.update(candlePoint(b));
  deltaSeries.update(deltaPoint(b, d));
  cvdSeries.update({ time: toTime(b), value: cvdBefore + d });
  requestDraw();
}, 250);

// ---------- data ----------
async function load({ keepView = true } = {}) {
  const r = await fetch(`/api/cryptoflow/bars?tf=${tfNow()}&step=${view.step}`);
  if (!r.ok) throw new Error(`Couldn't read the stored data (HTTP ${r.status}).`);
  const data = await r.json();
  const range = keepView && loaded ? ts.getVisibleRange() : null;
  loaded = true;
  bars = data.bars;
  byAt = new Map(bars.map((b) => [b.at, b]));
  through = data.through;
  for (const tr of live) addLive(tr);
  setAll();
  if (range) ts.setVisibleRange(range);
  else latest();
}

// Set just after the data: the library fits everything on screen on its first draw.
function latest() {
  setTimeout(() => {
    // Market Profile: about three days, so the letters fit. Footprint: wide enough for numbers.
    const shown = isProfile() ? 150 : Math.max(2, ($("chart").clientWidth - 70) / 90); // a hidden panel has no width
    ts.setVisibleLogicalRange({ from: bars.length - shown + 2, to: bars.length + 2 });
  }, 50);
}

function connect(host = 0) {
  let opened = false;
  const ws = new WebSocket(`${HOSTS[host]}btcusdt@aggTrade`);
  ws.onopen = () => {
    opened = true;
    wsOpen = true;
  };
  ws.onmessage = (m) => {
    const x = JSON.parse(m.data);
    const tr = { t: x.T, price: +x.p, qty: +x.q, isSell: x.m };
    live.push(tr);
    tradesThisTick++;
    addLive(tr);
  };
  ws.onclose = () => {
    wsOpen = false;
    // A dropped feed misses trades, so fetch them from the server once it's back.
    setTimeout(() => connect(opened ? host : (host + 1) % HOSTS.length), 3000);
    if (opened) needSync = true;
  };
}

let needSync = true, wasRunning = false, lastLoad = 0;

async function post() {
  await fetch("/api/cryptoflow/sync", { method: "POST", headers: { "x-qt": "1" } });
  needSync = false;
}

async function tick() {
  try {
    if (needSync) await post();
    const s = await (await fetch("/api/cryptoflow/status")).json();
    const el = $("state");
    if (s.error) {
      el.className = "bad";
      el.textContent = s.error;
    } else if (s.running) {
      el.className = "";
      el.textContent = `Filling the week: ${s.pct}%`;
    } else {
      el.className = wsOpen ? "live" : "bad";
      el.textContent = wsOpen ? `● Live · ${tradesThisTick / 5} trades/s` : "Live feed disconnected, retrying…";
    }
    tradesThisTick = 0;
    // Keep what the screen holds small: the server has everything older.
    if (s.through) live = live.filter((t) => t.t >= s.through - 6e4);
    const finished = wasRunning && !s.running;
    if (finished || !lastLoad || (s.running && Date.now() - lastLoad > 30000)) {
      lastLoad = Date.now();
      await load();
    }
    wasRunning = s.running;
  } catch (e) {
    $("state").className = "bad";
    $("state").textContent = e.message;
  }
}

setInterval(tick, 5000);
setInterval(() => (needSync = true), 60000); // keeps the local copy up to date while this is open

// ---------- controls ----------
function save() {
  try {
    localStorage.setItem(SAVED, JSON.stringify(view));
  } catch { /* only a convenience */ }
}
for (const id of ["tf", "step", "view", "ratio", "minQty"]) {
  $(id).onchange = async () => {
    const wasProfile = isProfile();
    view[id] = id === "tf" || id === "view" ? $(id).value : Number($(id).value);
    save();
    $("tf").disabled = isProfile();
    $("hint").textContent = "";
    const newBars = id === "tf" || (id === "view" && wasProfile !== isProfile());
    if (newBars || id === "step") await load({ keepView: !newBars }).catch((e) => ($("state").textContent = e.message));
    syncCandleColors();
    requestDraw();
  };
}
$("zoom").onclick = latest;

chart.subscribeCrosshairMove((p) => {
  const b = p.logical != null ? bars[Math.round(p.logical)] : null;
  if (!b) return;
  const t = totals(b);
  const when = new Date(b.at + IST * 1000).toISOString().slice(0, 16).replace("T", " ");
  const side = diverged.get(b.at);
  $("read").innerHTML =
    `${when} IST &nbsp; O ${b.o} H ${b.h} L ${b.l} C ${b.c} &nbsp; Buy <b class="up">${qty(t.buy)}</b> Sell <b class="dn">${qty(t.sell)}</b> ` +
    `Delta <b class="${t.delta >= 0 ? "up" : "dn"}">${qty(t.delta)}</b> &nbsp; POC ${t.poc}` +
    (side ? ` &nbsp; <b style="color:${DIVERGE}">Divergence: ${side === "bear" ? "new high on net selling" : "new low on net buying"}</b>` : "");
});

$("tf").disabled = isProfile();
syncCandleColors();
connect();
tick();
