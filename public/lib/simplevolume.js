// Simple Volume: volume bars coloured only where they matter, after "Simple Volume" by finallynitin
// (TradingView; the script itself is protected, so this follows its published description and
// its settings panel).
//   Blue    pocket pivot: an up day whose volume beats every down day's in the last N days
//   Green   up-day volume above its average     Red     down-day volume above its average
//   Orange  dry volume: below 1/N of the average     Dark grey  everything else (noise)
// Labels: HVE / HVY / HVQ (highest volume ever, in a year, in a quarter), Y / Q (lowest in a year /
// quarter), Bull Snort (≥ 3× average, close near the high, up day) and Power Volume (big volume
// with a ≥ 5% move). Table: average traded value, relative volume, projected RVol for a day still
// trading, and the up/down volume ratio.
// Up and down days compare the close with the open, or with the previous close when that's chosen.
// Year = 252 bars, quarter = 63 (daily and higher charts). Pure: no DOM, so it runs in tests.

export const SV_COLORS = { ppv: "#2196f3", up: "#4caf50", down: "#f23645", noise: "#434651", dry: "#ff9800", snort: "#9c27b0", powerUp: "#00bcd4", powerDown: "#e040fb" };
const YEAR = 252, QUARTER = 63;
const num = (x, d) => (Number.isFinite(parseFloat(x)) ? parseFloat(x) : d); // "50 period" -> 50

// Average of the last `n` values ending at i (fewer at the start), skipping the current bar if `excl`.
function avgAt(v, i, n, excl = false) {
  const end = excl ? i - 1 : i, start = Math.max(0, end - n + 1);
  if (end < start) return NaN;
  let s = 0;
  for (let k = start; k <= end; k++) s += v[k];
  return s / (end - start + 1);
}

const short = (v) => (v >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : String(Math.round(v)));

export function simpleVolume(bars, p, now = Date.now()) {
  const n = bars.length;
  const v = bars.map((b) => b.volume || 0);
  const base = (i) => (p.prevClose && i > 0 ? bars[i - 1].close : bars[i].open);
  const upDay = (i) => bars[i].close > base(i);
  const downDay = (i) => bars[i].close < base(i);
  const maLen = Math.max(1, num(p.maLength, 34) | 0), ppvLen = Math.max(1, num(p.ppvLength, 10) | 0);
  const ma = v.map((_, i) => avgAt(v, i, maLen));
  const dry = p.dry === false ? 0 : 1 / Math.max(1, num(p.dryDivisor, 5));
  const colors = new Array(n), markers = [];
  // Labels need whole days: on intraday charts a "year" of bars isn't a year.
  const daily = n > 1 && (bars[n - 1].time - bars[0].time) / (n - 1) >= 20 * 3600;

  for (let i = 0; i < n; i++) {
    const b = bars[i], avg = ma[i];
    let maxDown = -1;
    for (let k = Math.max(0, i - ppvLen); k < i; k++) if (downDay(k)) maxDown = Math.max(maxDown, v[k]);
    const ppv = upDay(i) && maxDown >= 0 && v[i] > maxDown;
    colors[i] = ppv ? SV_COLORS.ppv : v[i] > avg ? (upDay(i) ? SV_COLORS.up : SV_COLORS.down) : v[i] < avg * dry ? SV_COLORS.dry : SV_COLORS.noise;

    // Bull Snort (Oliver Kell): ≥ snortMult × its own average, above the previous close, close in the top of the range.
    const range = b.high - b.low;
    if (p.bullSnort && i > 0 && v[i] >= num(p.snortMult, 3) * avgAt(v, i, num(p.snortLength, 50) | 0, true) && b.close > bars[i - 1].close && range > 0 && (b.close - b.low) / range >= 1 - num(p.snortRange, 35) / 100)
      markers.push({ time: b.time, position: "belowBar", shape: "circle", color: SV_COLORS.snort, text: "Snort", kind: "snort" });
    // Power volume: big volume and a big move.
    const move = i > 0 ? (b.close / bars[i - 1].close - 1) * 100 : 0;
    if (p.power && v[i] >= num(p.powerVolume, 500000) && Math.abs(move) >= num(p.powerPct, 5) && (move > 0 || p.powerDown !== false))
      markers.push({ time: b.time, position: "belowBar", shape: "square", color: move > 0 ? SV_COLORS.powerUp : SV_COLORS.powerDown, text: "", kind: "power" });
  }

  // Highest / lowest volume events (daily and higher only). "Latest only" keeps the newest of each.
  if (daily && p.hvLabels !== "Off") {
    const events = [];
    let maxSoFar = -1;
    const winMax = (i, w) => Math.max(...v.slice(Math.max(0, i - w + 1), i + 1));
    const winMin = (i, w) => Math.min(...v.slice(Math.max(0, i - w + 1), i + 1).filter((x) => x > 0));
    for (let i = 0; i < n; i++) {
      const ever = v[i] > maxSoFar && i >= QUARTER;
      maxSoFar = Math.max(maxSoFar, v[i]);
      const kind = ever ? "HVE" : i >= YEAR && v[i] === winMax(i, YEAR) ? "HVY" : i >= QUARTER && v[i] === winMax(i, QUARTER) ? "HVQ" : null;
      if (kind && v[i] > 0) events.push({ i, kind, high: true });
      // The day still trading can't be a "lowest" yet.
      if (p.lowLabels !== false && i < n - 1 && v[i] > 0) {
        const low = i >= YEAR && v[i] === winMin(i, YEAR) ? "Y" : i >= QUARTER && v[i] === winMin(i, QUARTER) ? "Q" : null;
        if (low) events.push({ i, kind: low, high: false });
      }
    }
    const keep = p.hvLabels === "All" ? events : [...new Map(events.map((e) => [e.kind, e])).values()];
    for (const e of keep) {
      const pct = Math.round((v[e.i] / ma[e.i]) * 100);
      const text = e.high ? [e.kind, p.showValue !== false ? short(v[e.i]) : "", p.showPct && Number.isFinite(pct) ? `(${pct}%)` : ""].filter(Boolean).join(" ") : e.kind;
      // Highs are a text label over the bar (no symbol), lows a small orange "Y" / "Q".
      markers.push({ time: bars[e.i].time, position: "aboveBar", shape: "circle", size: e.high ? 0 : 0.5, color: e.high ? SV_COLORS.ppv : SV_COLORS.dry, text, kind: e.high ? "hv" : "lv" });
    }
  }
  markers.sort((a, b) => a.time - b.time);

  // ---------- table ----------
  const table = [];
  if (n) {
    const last = n - 1;
    // Turnover: volume × VWAP (the day's typical price, hlc3, stands in for it) or × close, before today.
    const vwap = p.turnoverType !== "SMA";
    const value = bars.map((b) => (b.volume || 0) * (vwap ? (b.high + b.low + b.close) / 3 : b.close));
    const turnover = avgAt(value, last, num(p.turnoverLength, 50) | 0, true);
    if (Number.isFinite(turnover)) {
      const cr = p.turnoverUnit !== "Millions";
      const x = turnover / (cr ? 1e7 : 1e6);
      const okAt = num(p.turnoverThreshold, 5);
      table.push({ label: "Avg₹Vol", text: `${x >= 1000 ? Math.round(x).toLocaleString("en-IN") : x.toFixed(2)} ${cr ? "Cr" : "M"}`, tone: okAt > 0 ? (x >= okAt ? "up" : "down") : "" });
    }
    const avg = avgAt(v, last, Math.max(1, num(p.rvolLength, 20) | 0), true);
    const rv = (x) => (p.rvolStyle === "Multiplier" ? `${x.toFixed(2)}x` : `${Math.round(x * 100)}%`);
    if (p.showRvol !== false && avg > 0) table.push({ label: "RVol", text: rv(v[last] / avg), tone: v[last] >= avg ? "up" : "" });
    // Projected RVol for a day still trading: today's pace over the NSE session (09:15-15:30 IST).
    if (daily && avg > 0 && p.projection) {
      const open = Math.floor((now / 1000 + 19800) / 86400) * 86400 - 19800 + 9.25 * 3600;
      const elapsed = now / 1000 - open, session = 6.25 * 3600;
      const today = Math.floor((bars[last].time + 19800) / 86400) === Math.floor((now / 1000 + 19800) / 86400);
      if (today && elapsed > 300 && elapsed < session) table.push({ label: "Proj RVol", text: rv((v[last] * session) / elapsed / avg) });
    }
    let up = 0, down = 0;
    for (let k = Math.max(0, n - num(p.udLength, 17)); k < n; k++) (upDay(k) ? (up += v[k]) : downDay(k) ? (down += v[k]) : 0);
    if (down > 0) table.push({ label: "U/D Vol", text: (up / down).toFixed(1), tone: up >= down ? "up" : "down" });
  }
  return { value: v, colors, paneMarkers: markers, table: p.table === "Off" ? [] : table, tablePos: p.table };
}
