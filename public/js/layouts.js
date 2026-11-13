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

// ---------- closing a chart ----------
const LETTERS = "abcdefghijklmnop";
const grid = (def) => def.areas.map((r) => r.split(" "));
const asDef = (rows, id) => ({ ...L(id, rows.map((r) => r.join(" "))), custom: !LAYOUT_BY_ID[id] });

// Adjacent rows (and columns) that are identical say nothing a single one doesn't: 3 equal charts
// side by side, less one, is the plain 2-across layout.
function squeeze(rows) {
  const out = rows.filter((r, i) => i === 0 || r.join() !== rows[i - 1].join());
  const keep = out[0].map((_, x) => x === 0 || out.some((r) => r[x] !== r[x - 1]));
  return out.map((r) => r.filter((_, x) => keep[x]));
}
const key = (rows) => rows.map((r) => r.join("")).join("/");
const BY_SHAPE = new Map(LAYOUTS.map((l) => [key(squeeze(grid(l))), l]));

// A layout not in the list, saved as "x:ab/cb" (rows of chart letters).
export function layoutById(id) {
  if (LAYOUT_BY_ID[id]) return LAYOUT_BY_ID[id];
  const m = /^x:([a-p]+(?:\/[a-p]+)*)$/.exec(String(id || ""));
  if (!m) return null;
  const rows = m[1].split("/").map((r) => r.split(""));
  if (rows.some((r) => r.length !== rows[0].length)) return null;
  const def = asDef(rows, id);
  // Every chart a rectangle, and the letters a, b, c... with none skipped.
  const { cells: list } = cells(def);
  const names = [...new Set(rows.flat())].sort().join("");
  if (names !== LETTERS.slice(0, names.length)) return null;
  const whole = list.every((c) => rows.slice(c.y0, c.y1 + 1).every((r) => new Set(r.slice(c.x0, c.x1 + 1)).size === 1));
  return whole ? def : null;
}

// The layout left when chart number `index` (0 = a) closes. Its space goes to a neighbour that stays a
// rectangle; the charts after it move up a letter, so each keeps its place on screen.
export function layoutWithout(def, index) {
  if (def.count < 2) return def;
  const gone = LETTERS[index];
  let rows = grid(def).filter((r) => r.some((c) => c !== gone));
  const cols = rows[0].map((_, x) => rows.some((r) => r[x] !== gone));
  rows = rows.map((r) => r.filter((_, x) => cols[x]));
  if (rows.flat().includes(gone)) {
    const rect = (g, n) => {
      const at = g.flatMap((r, y) => r.map((c, x) => (c === n ? [x, y] : null)).filter(Boolean));
      const [x0, x1] = [Math.min(...at.map((p) => p[0])), Math.max(...at.map((p) => p[0]))];
      const [y0, y1] = [Math.min(...at.map((p) => p[1])), Math.max(...at.map((p) => p[1]))];
      return at.length === (x1 - x0 + 1) * (y1 - y0 + 1);
    };
    const others = [...new Set(rows.flat())].filter((n) => n !== gone);
    const fills = others.map((n) => rows.map((r) => r.map((c) => (c === gone ? n : c)))).filter((g, i) => rect(g, others[i]));
    const renamed = (g) => squeeze(g.map((r) => r.map((c) => (c > gone ? LETTERS[LETTERS.indexOf(c) - 1] : c))));
    // Of the neighbours that could take the space, one that leaves a listed layout wins.
    const fill = fills.find((g) => BY_SHAPE.has(key(renamed(g)))) || fills[0];
    // shortcut: every listed layout has a neighbour that can take the space; a hand-made one may not, so it falls back to columns.
    rows = fill || [others.map((n) => n)];
  }
  rows = squeeze(rows.map((r) => r.map((c) => (c > gone ? LETTERS[LETTERS.indexOf(c) - 1] : c))));
  return BY_SHAPE.get(key(rows)) || asDef(rows, `x:${key(rows)}`);
}
