// Draws Key Levels zones (public/lib/keylevels.js) behind the candles, and their price labels
// `offset` bars to the right of the last bar with a thin line back to it.

const rgba = (hex, alpha) => {
  const h = String(hex || "#888888").replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) || 0);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};
// Dark text on light label colours (yellow, light blue), white on dark ones.
const textOn = (hex) => {
  const h = String(hex || "").replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) || 0);
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#131722" : "#ffffff";
};

export class KeyLevelsLayer {
  constructor(pane, cfg) {
    this.pane = pane;
    this.cfg = cfg; // { zones, labels, supColor, resColor, borderOpacity, fillOpacity, extend, offset, showLabels }
    const view = (z, fn) => ({
      zOrder: () => z,
      renderer: () => ({ draw: (target) => target.useMediaCoordinateSpace(({ context, mediaSize }) => fn(context, mediaSize)) }),
    });
    this._views = [view("bottom", (c, s) => this.drawZones(c, s)), view("top", (c, s) => this.drawLabels(c, s))];
  }

  attached({ series, requestUpdate }) {
    this.series = series;
    requestUpdate?.();
  }
  detached() {
    this.series = null;
  }
  updateAllViews() {}
  paneViews() {
    return this._views;
  }

  drawZones(ctx, size) {
    if (!this.series) return;
    const { zones, supColor, resColor, borderOpacity, fillOpacity, extend } = this.cfg;
    for (const z of zones) {
      const x1 = this.pane.timeToX(z.from);
      const x2 = z.live && extend ? size.width : this.pane.timeToX(z.to);
      const y1 = this.series.priceToCoordinate(z.top), y2 = this.series.priceToCoordinate(z.bottom);
      if (x1 == null || x2 == null || y1 == null || y2 == null || x2 < 0 || x1 > size.width) continue;
      const color = z.bull ? supColor : resColor;
      const [x, y, w, h] = [Math.round(x1) + 0.5, Math.round(Math.min(y1, y2)) + 0.5, Math.max(1, Math.round(x2 - x1)), Math.max(1, Math.round(Math.abs(y2 - y1)))];
      ctx.fillStyle = rgba(color, fillOpacity / 100);
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = rgba(color, borderOpacity / 100);
      ctx.lineWidth = 1;
      ctx.strokeRect(x, y, w, h);
    }
  }

  drawLabels(ctx, size) {
    const { labels, supColor, resColor, borderOpacity, extend, offset, showLabels } = this.cfg;
    if (!this.series || !showLabels || !labels.length) return;
    const ts = this.pane.chart.timeScale();
    const last = this.pane.shown.length - 1;
    const x0 = ts.logicalToCoordinate(last), far = ts.logicalToCoordinate(last + Math.max(0, offset));
    if (x0 == null || far == null) return;
    ctx.font = `11px ${this.pane.chart.options().layout.fontFamily}`;
    // `offset` bars right of the last bar, but never past the chart's right edge (labels stay readable).
    const widest = Math.max(...labels.map((l) => ctx.measureText(this.pane.formatPrice(l.price)).width)) + 12;
    const xl = Math.max(x0, Math.min(far, size.width - widest / 2 - 4));
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const l of labels) {
      const y = this.series.priceToCoordinate(l.price);
      if (y == null) continue;
      const color = l.bull ? supColor : resColor;
      // The level carried out to the label (not when zones already extend right).
      if (!extend && offset > 0) {
        ctx.strokeStyle = rgba(color, Math.max(0.35, borderOpacity / 100));
        ctx.beginPath();
        ctx.moveTo(x0, Math.round(y) + 0.5);
        ctx.lineTo(xl, Math.round(y) + 0.5);
        ctx.stroke();
      }
      const text = this.pane.formatPrice(l.price);
      const w = ctx.measureText(text).width + 12, h = 17, tip = 5;
      // "up" labels hang under the level with their point up; "down" ones sit over it.
      const top = l.up ? y + tip : y - tip - h;
      ctx.fillStyle = rgba(color, 0.85);
      ctx.beginPath();
      ctx.moveTo(xl - 5, l.up ? y + tip : y - tip);
      ctx.lineTo(xl, y);
      ctx.lineTo(xl + 5, l.up ? y + tip : y - tip);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.roundRect?.(xl - w / 2, top, w, h, 3) ?? ctx.rect(xl - w / 2, top, w, h);
      ctx.fill();
      ctx.fillStyle = textOn(color);
      ctx.fillText(text, xl, top + h / 2 + 0.5);
    }
  }
}
