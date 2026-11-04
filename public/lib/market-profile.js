// Market Profile (TPO): each time period gets a letter, printed on every price row it traded at.
// Bars are { time (seconds), high, low }.
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const letter = (n) => LETTERS[n % LETTERS.length];

// A round row size near `raw`: 1, 2, 2.5 or 5 times a power of ten.
export function niceStep(raw) {
  if (!(raw > 0)) return 1;
  const unit = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].find((m) => m * unit >= raw) * unit;
}

export function buildProfile(bars, { periodSec = 1800, step, rows = 30, valueArea = 70, ib = true } = {}) {
  if (!bars.length) return null;
  const hi = Math.max(...bars.map((b) => b.high)), lo = Math.min(...bars.map((b) => b.low));
  const size = step || niceStep((hi - lo) / rows);

  const periods = [];
  let at = null;
  for (const b of bars) {
    const k = Math.floor((b.time - bars[0].time) / periodSec);
    if (k !== at) {
      periods.push({ high: b.high, low: b.low });
      at = k;
    } else {
      const p = periods.at(-1);
      p.high = Math.max(p.high, b.high);
      p.low = Math.min(p.low, b.low);
    }
  }

  const first = Math.floor(lo / size), last = Math.floor(hi / size);
  const letters = Array.from({ length: last - first + 1 }, () => "");
  periods.forEach((p, n) => {
    for (let i = Math.floor(p.low / size); i <= Math.floor(p.high / size); i++) letters[i - first] += letter(n);
  });

  // The busiest row; on a tie, the one nearest the middle of the range.
  const mid = (letters.length - 1) / 2;
  let poc = 0;
  letters.forEach((l, i) => {
    const best = letters[poc].length;
    if (l.length > best || (l.length === best && Math.abs(i - mid) < Math.abs(poc - mid))) poc = i;
  });

  // Value area: grow outwards from the POC, always taking the busier neighbour.
  const total = letters.reduce((a, l) => a + l.length, 0);
  let a = poc, z = poc, inside = letters[poc].length;
  while ((inside / total) * 100 < valueArea && (a > 0 || z < letters.length - 1)) {
    const up = z < letters.length - 1 ? letters[z + 1].length : -1;
    const down = a > 0 ? letters[a - 1].length : -1;
    if (up >= down) inside += letters[++z].length;
    else inside += letters[--a].length;
  }

  const opening = periods.slice(0, 2);
  return {
    step: size,
    first,
    letters,
    maxCount: Math.max(...letters.map((l) => l.length)),
    poc: first + poc,
    pocPrice: (first + poc + 0.5) * size,
    vaLow: first + a,
    vaHigh: first + z,
    val: (first + a) * size,
    vah: (first + z + 1) * size,
    ib: ib && periods.length > 1 ? { high: Math.max(...opening.map((p) => p.high)), low: Math.min(...opening.map((p) => p.low)) } : null,
    poorHigh: letters.at(-1).length >= 2,
    poorLow: letters[0].length >= 2,
    high: hi,
    low: lo,
  };
}

// One profile per session. keyOf(seconds) names a bar's session. A POC stays "naked" until price
// comes back to it: nakedTo is the bar index it was reached at, or null if it never was.
export function sessionProfiles(bars, keyOf, options) {
  const out = [];
  let key = null, from = 0;
  const close = (to) => {
    const p = buildProfile(bars.slice(from, to + 1), options);
    if (p) out.push({ ...p, from, to });
  };
  bars.forEach((b, i) => {
    const k = keyOf(b.time);
    if (key !== null && k !== key) {
      close(i - 1);
      from = i;
    }
    key = k;
  });
  if (bars.length) close(bars.length - 1);
  for (const p of out) {
    p.nakedTo = null;
    for (let i = p.to + 1; i < bars.length; i++)
      if (bars[i].low <= p.pocPrice && bars[i].high >= p.pocPrice) {
        p.nakedTo = i;
        break;
      }
  }
  return out;
}

// What to draw for a chart's settings: daily sessions on intraday charts, monthly or yearly above.
export function profileOptions(tfSeconds, { period = "Auto", letterMinutes = 30 } = {}) {
  const auto = tfSeconds < 86400 ? "day" : tfSeconds < 7 * 86400 ? "month" : "year";
  const session = period && period !== "Auto" ? period.toLowerCase() : auto;
  const intraday = tfSeconds < 86400;
  return { session, periodSec: intraday ? Math.max(letterMinutes * 60, tfSeconds) : tfSeconds, ib: intraday };
}
