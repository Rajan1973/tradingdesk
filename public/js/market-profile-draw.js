// Draws Market Profile sessions: letters when they fit, plain bars when zoomed out. Used by the
// indicator on normal charts and by the order flow screen.
import { VolumeProfile } from "./volume-profile.js";
import { sessionProfiles, profileOptions } from "../lib/market-profile.js";
import { periodKey } from "../lib/indicators.js";
import { parseTf } from "../lib/series.js";

// Returns false when any visible session was too tight for letters.
export function drawProfiles(ctx, profiles, { priceToY, xOf, spacing, lastIndex, from, to, ink = "#1f2937" }) {
  let fits = true;
  for (const p of profiles) {
    if (p.from > to + 1) continue;
    const x0 = xOf(p.from) - spacing / 2, span = xOf(p.to) - xOf(p.from) + spacing;

    // A POC not yet revisited runs on, dashed, until price reaches it.
    const yPoc = priceToY(p.pocPrice);
    const reached = p.nakedTo ?? lastIndex;
    if (yPoc != null && reached > p.to && reached >= from) {
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = "#f57c00";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x0 + span, yPoc);
      ctx.lineTo(xOf(reached), yPoc);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (p.to < from - 1) continue;

    const a = priceToY(p.step), b = priceToY(0);
    const rowH = a != null && b != null ? Math.abs(b - a) : 0;
    const cellW = Math.min(9, span / p.maxCount);
    const letters = rowH >= 9 && cellW >= 5.5;
    if (!letters) fits = false;
    ctx.font = `${Math.min(11, Math.max(8, rowH - 1))}px ui-monospace, Consolas, monospace`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";

    p.letters.forEach((text, k) => {
      if (!text) return;
      const row = p.first + k;
      const top = priceToY((row + 1) * p.step), bottom = priceToY(row * p.step);
      if (top == null || bottom == null) return;
      const h = Math.max(1, bottom - top - (rowH >= 4 ? 1 : 0));
      const inVa = row >= p.vaLow && row <= p.vaHigh;
      ctx.fillStyle =
        row === p.poc ? "rgba(245,124,0,0.45)" : text.length === 1 ? "rgba(255,193,7,0.4)" : inVa ? "rgba(67,56,202,0.2)" : "rgba(107,114,128,0.14)";
      ctx.fillRect(x0 + 3, top, text.length * cellW, h);
      if (letters) {
        ctx.fillStyle = ink;
        for (let n = 0; n < text.length; n++) ctx.fillText(text[n], x0 + 3 + (n + 0.5) * cellW, top + h / 2);
      }
    });

    // Value area edges across the session.
    ctx.strokeStyle = "rgba(67,56,202,0.65)";
    ctx.lineWidth = 1;
    for (const price of [p.vah, p.val]) {
      const y = priceToY(price);
      if (y == null) continue;
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x0 + span, y);
      ctx.stroke();
    }
    // The initial balance as a green bar on the left.
    if (p.ib) {
      const yH = priceToY(p.ib.high), yL = priceToY(p.ib.low);
      if (yH != null && yL != null) {
        ctx.fillStyle = "#00796b";
        ctx.fillRect(x0, yH, 2, yL - yH);
      }
    }
    // A flat, unfinished extreme gets a red edge.
    ctx.fillStyle = "#c62828";
    if (p.poorHigh) {
      const y = priceToY((p.first + p.letters.length) * p.step);
      if (y != null) ctx.fillRect(x0 + 3, y - 1, p.letters.at(-1).length * cellW, 2);
    }
    if (p.poorLow) {
      const y = priceToY(p.first * p.step);
      if (y != null) ctx.fillRect(x0 + 3, y - 1, p.letters[0].length * cellW, 2);
    }
  }
  return fits;
}

// The indicator's layer on a normal chart.
export class MarketProfileLayer extends VolumeProfile {
  constructor(pane, params) {
    super(pane, params);
    this._view.zOrder = () => "normal";
  }

  draw(ctx) {
    const pane = this.pane, bars = pane.shown, ts = pane.chart.timeScale();
    const range = ts.getVisibleLogicalRange();
    if (!bars?.length || !range || !this.series) return;
    const key = `${bars.length}:${bars.at(-1).high}:${bars.at(-1).low}:${bars[0].time}`;
    if (key !== this.cacheKey) {
      const o = profileOptions(parseTf(pane.cfg.tf).seconds, this.p);
      this.profiles = sessionProfiles(bars, (t) => periodKey(t, o.session), { ...o, rows: this.p.rows, valueArea: this.p.valueArea });
      this.cacheKey = key;
    }
    drawProfiles(ctx, this.profiles, {
      priceToY: (v) => this.series.priceToCoordinate(v),
      xOf: (i) => ts.logicalToCoordinate(i),
      spacing: ts.options().barSpacing || 6,
      lastIndex: bars.length - 1,
      from: range.from,
      to: range.to,
      ink: getComputedStyle(document.documentElement).getPropertyValue("--text").trim() || "#1f2937",
    });
  }
}
