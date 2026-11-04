// Chart layouts for the picker. Each row of `areas` is a row of the grid and each letter a chart, in
// the order charts fill it. The first ids are the ones saved in older states and saved layouts.
const L = (id, rows, cols) => ({ id, areas: rows, cols, count: new Set(rows.join(" ").split(" ")).size });

export const LAYOUTS = [
  L("1", ["a"]),
  L("2v", ["a b"]),
  L("2h", ["a", "b"]),
  L("3", ["a b", "a c"], "2fr 1fr"),
  L("3r", ["a", "b", "c"]),
  L("3c", ["a b c"]),
  L("3l", ["a c", "b c"]),
  L("3t", ["a b", "c c"]),
  L("3b", ["a a", "b c"]),
  L("4", ["a b", "c d"]),
  L("4c", ["a b c d"]),
  L("4r", ["a", "b", "c", "d"]),
  L("4l", ["a b", "a c", "a d"]),
  L("4e", ["a d", "b d", "c d"]),
  L("4t", ["a a a", "b c d"]),
  L("4b", ["a b c", "d d d"]),
  L("4m", ["a a", "b c", "d d"]),
  L("4u", ["a b", "c c", "d d"]),
  L("4d", ["a a", "b b", "c d"]),
  L("4x", ["a b d", "a c d"]),
  L("4y", ["a c d", "b c d"]),
  L("4z", ["a b c", "a b d"]),
  L("5t", ["a a a a", "b c d e"]),
  L("5b", ["a b c d", "e e e e"]),
  L("5l", ["a b", "a c", "a d", "a e"]),
  L("5e", ["a e", "b e", "c e", "d e"]),
  L("5u", ["a a a b b b", "c c d d e e"]),
  L("5d", ["a a b b c c", "d d d e e e"]),
  L("5m", ["a b", "c d", "e e"]),
  L("5n", ["a a", "b c", "d e"]),
  L("5x", ["a c e", "b d e"]),
  L("5y", ["a b d", "a c e"]),
  L("5c", ["a b c d e"]),
  L("5r", ["a", "b", "c", "d", "e"]),
  L("6", ["a b c", "d e f"]),
  L("6w", ["a b", "c d", "e f"]),
  L("6t", ["a a b b", "c d e f"]),
  L("6b", ["a b c d", "e e f f"]),
  L("6u", ["a a a a a a", "b b b c c c", "d d e e f f"]),
  L("6d", ["a a b b c c", "d d d e e e", "f f f f f f"]),
  L("6x", ["a b d f", "a c e f"]),
  L("6y", ["a c e f", "b d e f"]),
  L("6r", ["a", "b", "c", "d", "e", "f"]),
  L("6c", ["a b c d e f"]),
  L("8", ["a b c d", "e f g h"]),
  L("16", ["a b c d", "e f g h", "i j k l", "m n o p"]),
];
export const LAYOUT_BY_ID = Object.fromEntries(LAYOUTS.map((l) => [l.id, l]));

export function applyLayout(grid, def) {
  const rows = def.areas.map((r) => r.split(" "));
  grid.style.gridTemplateAreas = rows.map((r) => `"${r.join(" ")}"`).join(" ");
  grid.style.gridTemplateColumns = def.cols || `repeat(${rows[0].length}, minmax(0, 1fr))`;
  grid.style.gridTemplateRows = `repeat(${rows.length}, minmax(0, 1fr))`;
}

// Each chart's cell as { col, row, cols, rows }, in units of the grid.
export function cells(def) {
  const rows = def.areas.map((r) => r.split(" "));
  const out = new Map();
  rows.forEach((r, y) =>
    r.forEach((name, x) => {
      const c = out.get(name);
      if (!c) out.set(name, { x0: x, x1: x, y0: y, y1: y });
      else {
        c.x1 = Math.max(c.x1, x);
        c.y1 = Math.max(c.y1, y);
      }
    }),
  );
  return { width: rows[0].length, height: rows.length, cells: [...out.values()] };
}

export function layoutIcon(def) {
  const { width, height, cells: list } = cells(def);
  const W = 24, H = 18;
  const rects = list
    .map((c) => `<rect x="${(c.x0 * W) / width + 1}" y="${(c.y0 * H) / height + 1}" width="${((c.x1 - c.x0 + 1) * W) / width}" height="${((c.y1 - c.y0 + 1) * H) / height}" rx="1"/>`)
    .join("");
  return `<svg viewBox="0 0 26 20" width="26" height="20" fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true">${rects}</svg>`;
}
