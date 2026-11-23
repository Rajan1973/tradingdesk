// A small table in a corner of an indicator's pane (Simple Volume's Avg₹Vol / RVol / U/D Vol):
// one row per item, label and value, tinted green or red by its tone.

const TINT = { up: ["rgba(76, 175, 80, 0.18)", "--up-text"], down: ["rgba(242, 54, 69, 0.16)", "--down-text"], "": ["rgba(127, 127, 127, 0.12)", "--text"] };

export class PaneTable {
  constructor(pane, rows, pos = "Top right") {
    this.pane = pane;
    this.rows = rows;
    this.left = pos === "Top left";
    this._view = {
      zOrder: () => "top",
      renderer: () => ({ draw: (target) => target.useMediaCoordinateSpace(({ context, mediaSize }) => this.draw(context, mediaSize)) }),
    };
  }
  attached({ requestUpdate }) {
    requestUpdate?.();
  }
  detached() {}
  updateAllViews() {}
  paneViews() {
    return [this._view];
  }
  draw(ctx, size) {
    if (!this.rows.length) return;
    const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
    ctx.font = `11px ${this.pane.chart.options().layout.fontFamily}`;
    ctx.textBaseline = "middle";
    const texts = this.rows.map((r) => `${r.label}: ${r.text}`);
    const w = Math.max(...texts.map((t) => ctx.measureText(t).width)) + 16, h = 18, gap = 2;
    // Clear of the price scale on the right; under the legend on the left.
    const x = this.left ? 8 : size.width - w - 8;
    this.rows.forEach((r, k) => {
      const y = 6 + k * (h + gap);
      const [bg, fg] = TINT[r.tone || ""] || TINT[""];
      ctx.fillStyle = bg;
      ctx.beginPath();
      ctx.roundRect?.(x, y, w, h, 3) ?? ctx.rect(x, y, w, h);
      ctx.fill();
      ctx.fillStyle = css(fg) || "#888";
      ctx.textAlign = "right";
      ctx.fillText(texts[k], x + w - 8, y + h / 2 + 0.5);
    });
  }
}
