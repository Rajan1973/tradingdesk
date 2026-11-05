// Footprint arithmetic shared by the server (stored history) and the browser (live trades).
// A bar is { at (ms), o, h, l, c, cells: { rowPrice: [buyQty, sellQty] } }.
export const BASE_STEP = 5; // the finest row stored, in dollars
export const TF_MS = { "1m": 6e4, "5m": 3e5, "15m": 9e5, "30m": 18e5, "1h": 36e5, "4h": 144e5 };
export const STEPS = [5, 10, 25, 50, 100, 250];
export const STOCK_STEPS = [0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500];

const rowOf = (price, step) => Math.floor(price / step) * step;

// Adds one trade to its bar. `bars` is a Map of bar time -> bar; returns the bar.
export function addTrade(bars, t, price, qty, isSell, tfMs = TF_MS["1m"], step = BASE_STEP) {
  const at = Math.floor(t / tfMs) * tfMs;
  let b = bars.get(at);
  if (!b) bars.set(at, (b = { at, o: price, h: price, l: price, c: price, cells: {} }));
  if (price > b.h) b.h = price;
  if (price < b.l) b.l = price;
  b.c = price;
  const cell = (b.cells[rowOf(price, step)] ||= [0, 0]);
  cell[isSell ? 1 : 0] += qty;
  return b;
}

// Combines time-ordered 1-minute bars into a larger timeframe and row size.
export function mergeBars(minutes, tfMs, step) {
  const out = new Map();
  for (const m of minutes) {
    const at = Math.floor(m.at / tfMs) * tfMs;
    let b = out.get(at);
    if (!b) out.set(at, (b = { at, o: m.o, h: m.h, l: m.l, c: m.c, cells: {} }));
    if (m.h > b.h) b.h = m.h;
    if (m.l < b.l) b.l = m.l;
    b.c = m.c;
    for (const [p, [buy, sell]] of Object.entries(m.cells)) {
      const cell = (b.cells[rowOf(+p, step)] ||= [0, 0]);
      cell[0] += buy;
      cell[1] += sell;
    }
  }
  return [...out.values()];
}

export function totals(bar) {
  let buy = 0, sell = 0, poc = null, most = -1;
  for (const [p, [b, s]] of Object.entries(bar.cells)) {
    buy += b;
    sell += s;
    if (b + s > most) (most = b + s), (poc = +p);
  }
  return { buy, sell, delta: buy - sell, poc };
}

// Total delta of the newest bar's session. Sessions are UTC days, as crypto has no closing bell.
export function sessionDelta(bars) {
  const day = (b) => Math.floor(b.at / 864e5);
  let sum = 0;
  for (let i = bars.length - 1; i >= 0 && day(bars[i]) === day(bars.at(-1)); i--) sum += totals(bars[i]).delta;
  return sum;
}

// Delta divergence at bar i: a close up to a new high on net selling ("bear"), or a close down to a
// new low on net buying ("bull"). The 5-bar test keeps out the third of all bars that disagree with delta.
export function divergence(bars, i, lookback = 5) {
  if (i < lookback) return null;
  const b = bars[i], d = totals(b).delta, prev = bars.slice(i - lookback, i);
  if (b.c > b.o && d < 0 && b.h >= Math.max(...prev.map((x) => x.h))) return "bear";
  if (b.c < b.o && d > 0 && b.l <= Math.min(...prev.map((x) => x.l))) return "bull";
  return null;
}

// Imbalances compare diagonally, the way aggressors meet: buyers at a row against sellers one row
// below, sellers at a row against buyers one row above. Three or more in a row make a stack.
export function imbalances(bar, step, ratio, minQty) {
  const rows = Object.keys(bar.cells).map(Number).sort((a, x) => a - x);
  const buys = new Set(), sells = new Set();
  for (const p of rows) {
    const [b, s] = bar.cells[p];
    if (b >= minQty && b >= ratio * (bar.cells[p - step]?.[1] || 0)) buys.add(p);
    if (s >= minQty && s >= ratio * (bar.cells[p + step]?.[0] || 0)) sells.add(p);
  }
  const stacks = [];
  for (const [side, set] of [["buy", buys], ["sell", sells]]) {
    let from = null, prev = null;
    const close = () => {
      if (from !== null && (prev - from) / step >= 2) stacks.push({ side, from, to: prev });
    };
    for (const p of [...set].sort((a, x) => a - x)) {
      if (prev === null || p !== prev + step) {
        close();
        from = p;
      }
      prev = p;
    }
    close();
  }
  return { buys, sells, stacks };
}
