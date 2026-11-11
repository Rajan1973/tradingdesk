// Catalyst dots (data/catalysts.csv), drawn a clear gap above each bar's high so the wick tip
// stays easy to see and click when drawing trend lines and Fibonacci levels. Several events on
// one bar stack upwards. The pane asks hitTest() which dot is under the mouse for the hover card.
const GAP = 18; // pixels between the bar's high and the first dot
const R = 5; // dot radius
const STACK = 2 * R + 4; // centre-to-centre distance when events share a bar

export class CatalystLayer {
  constructor(pane) {
    this.pane = pane;
    this.dots = []; // last drawn: { x, y, events }
    this._view = {
      zOrder: () => "top",
      renderer: () => ({
        draw: (target) =>
          target.useMediaCoordinateSpace(({ context }) => this.draw(context)),
      }),
    };
  }

  attached({ series, requestUpdate }) {
    this.series = series;
    this.requestUpdate = requestUpdate;
  }
  detached() {
    this.series = null;
    this.dots = [];
  }
  updateAllViews() {}
  paneViews() {
    return [this._view];
  }
  update() {
    this.requestUpdate?.();
  }

  // Room above the highest bar for the gap and the tallest stack, so dots never sit off-screen.
  autoscaleInfo() {
    const groups = this.pane.catalystAt;
    if (!groups?.size) return null;
    let most = 1;
    for (const list of groups.values()) most = Math.max(most, list.length);
    return { priceRange: null, margins: { above: GAP + R + (most - 1) * STACK + 4, below: 0 } };
  }

  draw(ctx) {
    this.dots = [];
    const pane = this.pane;
    if (!this.series || !pane.catalystAt?.size) return;
    const lastShown = pane.times.at(-1);
    for (const [t, events] of pane.catalystAt) {
      // In bar replay, only events up to the replayed bar.
      if (pane.replay && pane.toChart(t) > lastShown) continue;
      const bar = pane.barByTime?.get(t);
      const x = pane.timeToX(t);
      const yHigh = bar ? this.series.priceToCoordinate(bar.high) : null;
      if (x == null || yHigh == null) continue;
      events.forEach((e, k) => {
        const y = yHigh - GAP - k * STACK;
        ctx.beginPath();
        // Diamonds are analyst calls, squares negative news, circles everything else.
        if (e.kind === "analyst") {
          const d = R + 1.5;
          ctx.moveTo(x, y - d);
          ctx.lineTo(x + d, y);
          ctx.lineTo(x, y + d);
          ctx.lineTo(x - d, y);
          ctx.closePath();
        } else if ((e.sentiment || "").toLowerCase() === "negative") ctx.rect(x - R, y - R, 2 * R, 2 * R);
        else ctx.arc(x, y, R, 0, Math.PI * 2);
        ctx.fillStyle = e.color;
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = "rgba(0, 0, 0, 0.55)";
        ctx.stroke();
        this.dots.push({ x, y, event: e, events });
      });
    }
  }

  // The dot under a point (pane pixels), with a little slack so it's easy to hover.
  dotAt(px, py) {
    let best = null,
      bestD = (R + 4) ** 2;
    for (const d of this.dots) {
      const dd = (d.x - px) ** 2 + (d.y - py) ** 2;
      if (dd <= bestD) (best = d), (bestD = dd);
    }
    return best;
  }
}

// Pivot high / low markers: a tiny dot just off the wick tip with its price beyond it. Drawn here
// because the chart library won't draw a marker circle smaller than about 10 pixels.
const PIVOT_R = 1.5;
const PIVOT_GAP = 4; // pixels between the wick tip and the dot
const LABEL_H = 14;

export class PivotLayer {
  constructor(pane) {
    this.pane = pane;
    this.pivots = [];
    this._view = {
      zOrder: () => "top",
      renderer: () => ({
        draw: (target) => target.useMediaCoordinateSpace(({ context }) => this.draw(context)),
      }),
    };
  }

  attached({ series, requestUpdate }) {
    this.series = series;
    this.requestUpdate = requestUpdate;
  }
  detached() {
    this.series = null;
  }
  updateAllViews() {}
  paneViews() {
    return [this._view];
  }
  set(pivots) {
    this.pivots = pivots;
    this.requestUpdate?.();
  }

  // Keeps the price labels on screen when the pivot is the chart's highest or lowest bar.
  autoscaleInfo() {
    if (!this.pivots.length) return null;
    const room = PIVOT_GAP + 2 * PIVOT_R + LABEL_H + 2;
    return { priceRange: null, margins: { above: room, below: room } };
  }

  draw(ctx) {
    if (!this.series) return;
    const pane = this.pane;
    ctx.font = `11px ${pane.chart.options().layout.fontFamily}`;
    ctx.textAlign = "center";
    for (const m of this.pivots) {
      const x = pane.timeToX(m.utc);
      const tip = this.series.priceToCoordinate(m.dot);
      if (x == null || tip == null) continue;
      const up = m.position === "aboveBar";
      const y = up ? tip - PIVOT_GAP - PIVOT_R : tip + PIVOT_GAP + PIVOT_R;
      ctx.fillStyle = m.color;
      ctx.beginPath();
      ctx.arc(x, y, PIVOT_R, 0, Math.PI * 2);
      ctx.fill();
      // A high's label clears any catalyst dots stacked on the same bar.
      const events = up ? pane.catalystAt?.get(m.utc)?.length || 0 : 0;
      const clear = events ? GAP + R + (events - 1) * STACK : PIVOT_GAP + 2 * PIVOT_R;
      ctx.textBaseline = up ? "bottom" : "top";
      ctx.fillText(m.text, x, up ? tip - clear - 2 : tip + clear + 2);
    }
  }
}

// Earnings markers: a dashed vertical guide down to the time axis with a small "E" tag, on Daily
// charts only. Separate from CatalystLayer's dots so a results date doesn't double-count there.
export class EarningsLayer {
  constructor(pane) {
    this.pane = pane;
    this.dates = []; // [{ time, date }], time = bar time the earnings date falls on
    this._view = {
      zOrder: () => "bottom",
      renderer: () => ({
        draw: (target) => target.useMediaCoordinateSpace(({ context, mediaSize }) => this.draw(context, mediaSize)),
      }),
    };
  }

  attached({ requestUpdate }) {
    this.requestUpdate = requestUpdate;
  }
  detached() {
    this.dates = [];
  }
  updateAllViews() {}
  paneViews() {
    return [this._view];
  }
  set(dates) {
    this.dates = dates || [];
    this.requestUpdate?.();
  }

  draw(ctx, mediaSize) {
    const pane = this.pane;
    if (!this.dates.length || pane.cfg?.tf !== "1D") return;
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = "rgba(255, 152, 0, 0.55)";
    ctx.fillStyle = "#ff9800";
    ctx.font = `10px ${pane.chart.options().layout.fontFamily}`;
    ctx.textAlign = "center";
    for (const { time } of this.dates) {
      const x = pane.timeToX(time);
      if (x == null) continue;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, mediaSize.height);
      ctx.stroke();
      ctx.fillRect(x - 6, mediaSize.height - 14, 12, 12);
      ctx.fillStyle = "#1b1b1b";
      ctx.fillText("E", x, mediaSize.height - 4);
      ctx.fillStyle = "#ff9800";
    }
    ctx.restore();
  }
}
