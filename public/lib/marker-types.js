// The kinds of chart markers, for the Settings filter. "mine" is your catalyst file, "analyst"
// the analyst calls read from news; the rest are the NSE filing types (lib/nse-events.js).
export const MARKER_TYPES = [
  ["mine", "Your catalyst file"],
  ["analyst", "Analyst calls (rating and target)"],
  ["Order win", "Order wins"],
  ["Results", "Results dates"],
  ["JV / Agreement", "JVs and agreements"],
  ["M&A / Restructuring", "M&A and restructuring"],
  ["Split / Bonus", "Splits and bonuses"],
  ["Demerger", "Demergers"],
  ["Dividend", "Dividends"],
  ["Buyback", "Buybacks"],
  ["Fund raising", "Fund raising"],
  ["Capacity / Commissioning", "Capacity and commissioning"],
  ["Credit rating", "Credit rating changes"],
  ["Regulatory / Legal", "Regulatory and legal"],
  ["News", "Press releases and news"],
];

// Colours of the NSE filing types (lib/nse-events.js uses these too), and of analyst calls.
export const NSE_THEME_COLORS = {
  "Order win": "#2962ff",
  Results: "#ff9800",
  "JV / Agreement": "#ab47bc",
  "M&A / Restructuring": "#00bcd4",
  "Split / Bonus": "#ffd600",
  Demerger: "#26a69a",
  Dividend: "#8d6e63",
  Buyback: "#d4e157",
  "Fund raising": "#5c6bc0",
  "Capacity / Commissioning": "#7cb342",
  "Credit rating": "#90a4ae",
  "Regulatory / Legal": "#ec407a",
  News: "#e0e0e0",
};
export const ANALYST_COLORS = { buy: "#00c853", hold: "#ffb300", sell: "#ff1744", none: "#90a4ae" };

// Which filter entry an event belongs to.
export function markerType(e) {
  if (e.kind === "analyst") return "analyst";
  if (e.source === "Your catalyst file") return "mine";
  return e.theme;
}

// Small pictures of a marker type for the Settings window, drawn the way the chart draws them.
const shape = (kind, color, size = 12) => {
  const c = size / 2, r = size / 2 - 1.5;
  const body =
    kind === "diamond"
      ? `<path d="M${c} 0.5 L${size - 0.5} ${c} L${c} ${size - 0.5} L0.5 ${c} Z"/>`
      : kind === "square"
        ? `<rect x="1.5" y="1.5" width="${size - 3}" height="${size - 3}"/>`
        : `<circle cx="${c}" cy="${c}" r="${r}"/>`;
  // Inline style: the app's icon styles would otherwise empty the fill.
  return `<svg class="mk-sw" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="fill:${color};stroke:rgba(0,0,0,.55);stroke-width:1">${body}</svg>`;
};
export const markerShape = shape;
export function markerSwatch(id) {
  if (id === "analyst")
    return [
      [ANALYST_COLORS.buy, "Buy"],
      [ANALYST_COLORS.hold, "Hold"],
      [ANALYST_COLORS.sell, "Sell"],
      [ANALYST_COLORS.none, "target only"],
    ]
      .map(([c, l]) => `<span class="mk-sub">${shape("diamond", c)}${l}</span>`)
      .join("");
  if (id === "mine") return `${shape("circle", "#2962ff")}${shape("circle", "#ab47bc")}${shape("circle", "#ff9800")}<span class="mk-sub">your theme colours</span>`;
  const c = NSE_THEME_COLORS[id] || "#9e9e9e";
  return id === "Regulatory / Legal" ? `${shape("circle", c)}${shape("square", c)}` : shape("circle", c);
}
