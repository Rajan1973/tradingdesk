// Key Levels: support and resistance zones, ported from the zone part of "Bjorgum Key Levels"
// (Pine Script, MPL-2.0, © Bjorgum). Only the zones and their price labels; the script's breakout,
// candle-pattern and TSI signals are left out.
//
// Bar by bar, like the script:
//   1. A pivot high (low) of the chosen source, `left` bars either side / `right` bars after, opens a
//      resistance (support) zone: the pivot ± half of min(ATR × mult, close × max%), from the pivot
//      bar to now. The newest `nPiv` highs and `nPiv` lows are tracked; an older one stops growing.
//   2. Align: a new zone that overlaps a tracked one takes that zone's edges, so recurring levels
//      line up and stack.
//   3. Tracked zones reach the current bar. A close above a resistance zone ends it and starts a
//      support zone with the same edges from that bar (and the other way round).
// Pure: no DOM, so it runs in tests.

// ta.atr: Wilder's average (RMA) of the true range, seeded with the first `len` bars' mean.
function atrOf(bars, len) {
  const out = new Array(bars.length).fill(NaN);
  let sum = 0, prev = NaN;
  bars.forEach((b, i) => {
    const tr = i === 0 ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close));
    if (i < len) {
      sum += tr;
      if (i === len - 1) out[i] = prev = sum / len;
    } else out[i] = prev = (prev * (len - 1) + tr) / len;
  });
  return out;
}

// Strictly above the `left` bars before, and not below the `right` bars after (ta.pivothigh).
function isPivot(src, c, left, right, high) {
  const v = src[c];
  if (!Number.isFinite(v)) return false;
  for (let j = 1; j <= left; j++) if (high ? src[c - j] >= v : src[c - j] <= v) return false;
  for (let j = 1; j <= right; j++) if (high ? src[c + j] > v : src[c + j] < v) return false;
  return true;
}

export function keyLevels(bars, p) {
  const n = bars.length;
  const left = Math.max(1, p.left | 0), right = Math.max(1, p.right | 0), nPiv = Math.max(1, p.nPiv | 0);
  // Heikin Ashi bodies by default: averaged price action, so a level can sit where support and
  // resistance overlap. "High/Low Body" uses real bodies, "High/Low" the wicks.
  let hiSrc, loSrc;
  if (p.pivotSource === "High/Low") {
    hiSrc = bars.map((b) => b.high);
    loSrc = bars.map((b) => b.low);
  } else if (p.pivotSource === "High/Low Body") {
    hiSrc = bars.map((b) => Math.max(b.open, b.close));
    loSrc = bars.map((b) => Math.min(b.open, b.close));
  } else {
    hiSrc = new Array(n);
    loSrc = new Array(n);
    let haOpen = NaN, haClose = NaN;
    bars.forEach((b, i) => {
      haOpen = i === 0 ? (b.open + b.close) / 2 : (haOpen + haClose) / 2;
      haClose = (b.open + b.high + b.low + b.close) / 4;
      hiSrc[i] = Math.max(haOpen, haClose);
      loSrc[i] = Math.min(haOpen, haClose);
    });
  }
  const atr = atrOf(bars, Math.max(1, p.atrLen | 0));
  const all = [];
  const zone = (from, to, top, bottom, bull) => {
    const z = { from, to, top, bottom, bull, live: true };
    all.push(z);
    return z;
  };
  const highs = new Array(nPiv).fill(null), lows = new Array(nPiv).fill(null);
  const track = (arr, z) => {
    arr.unshift(z);
    const old = arr.pop();
    if (old) old.live = false;
  };
  // A zone that overlaps one of `xs` takes its edges (the newest of `ys` only, as in the script).
  const align = (xs, ys) => {
    const y = ys[0];
    if (!y) return;
    for (const x of xs) {
      if (!x) continue;
      const [T, B, t, b] = [y.top, y.bottom, x.top, x.bottom];
      if ((T > b && T < t) || (B < t && B > b) || (T > t && B < b) || (B > b && T < t)) {
        y.top = t;
        y.bottom = b;
      }
    }
  };
  // Price closing through a zone ends it and starts the opposite kind with the same edges.
  const flip = (arr, i, close) => {
    arr.forEach((z, k) => {
      if (!z) return;
      if (close > z.top && !z.bull) {
        z.live = false;
        arr[k] = zone(i, i, z.top, z.bottom, true);
      } else if (close < z.bottom && z.bull) {
        z.live = false;
        arr[k] = zone(i, i, z.top, z.bottom, false);
      }
    });
  };

  for (let i = 0; i < n; i++) {
    const c = i - right;
    if (c >= left) {
      const band = Math.min(atr[c] * p.mult, (bars[c].close * p.maxPct) / 100) / 2;
      if (p.highs !== false && isPivot(hiSrc, c, left, right, true)) track(highs, zone(c, i, hiSrc[c] + band, hiSrc[c] - band, false));
      if (p.lows !== false && isPivot(loSrc, c, left, right, false)) track(lows, zone(c, i, loSrc[c] + band, loSrc[c] - band, true));
    }
    if (p.align !== false) {
      align(highs, highs);
      align(highs, lows);
      align(lows, lows);
      align(lows, highs);
    }
    for (const z of [...highs, ...lows]) if (z) z.to = i;
    flip(highs, i, bars[i].close);
    flip(lows, i, bars[i].close);
  }

  // Price labels for the tracked zones, from the last close: the edge price is nearest to, both
  // edges when price is inside. "up" labels sit under the level, "down" ones over it.
  const close = bars.at(-1)?.close;
  const labels = [];
  for (const z of [...highs, ...lows]) {
    if (!z || !Number.isFinite(z.top) || !Number.isFinite(z.bottom)) continue;
    if (close > z.top) labels.push({ price: z.top, up: true, bull: z.bull });
    else if (close < z.bottom) labels.push({ price: z.bottom, up: false, bull: z.bull });
    else labels.push({ price: z.top, up: false, bull: z.bull }, { price: z.bottom, up: true, bull: z.bull });
  }
  // Like Pine's 500-box cap: the oldest finished zones go first.
  const zones = all.filter((z) => Number.isFinite(z.top) && Number.isFinite(z.bottom));
  const kept = zones.length > 500 ? zones.slice(zones.length - 500) : zones;
  return {
    zones: kept.map((z) => ({ from: bars[z.from].time, to: bars[z.to].time, top: z.top, bottom: z.bottom, bull: z.bull, live: z.live })),
    labels,
  };
}
