// Automatic catalyst markers for NSE stocks, from NSE's public filings: order wins, results,
// JVs and agreements, M&A, splits, bonuses, demergers, dividends, fund raising, capacity,
// credit ratings, regulatory actions and press releases. Routine paperwork (analyst meets,
// newspaper copies, trading-window notices...) is left out. Each event links to its filing.
//
// Three NSE endpoints per symbol, cached for 30 minutes:
//   corporate-announcements   every filing, with a category ("desc") and a PDF
//   corporates-corporateActions   splits, bonuses, dividends, demergers, buybacks (by ex-date)
//   corporate-board-meetings  results meetings

const UA = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  Accept: "application/json",
  Referer: "https://www.nseindia.com/",
};
const OFFLINE = process.env.QT_OFFLINE === "1";
const YEARS_BACK = 5;

// Marker groups. The first matching rule wins; the theme is what colours the marker.
import { NSE_THEME_COLORS } from "../public/lib/marker-types.js";
export const NSE_THEMES = NSE_THEME_COLORS;

const ANNOUNCEMENT_RULES = [
  [/bagging|receiving of orders|awarding of order/i, "Order win"],
  [/joint venture|memorandum of understanding|^agreements?$|agreement/i, "JV / Agreement"],
  [/acquisition|amalgamation|merger|sale or disposal|scheme of arrangement|disinvestment|restructuring/i, "M&A / Restructuring"],
  [/demerger/i, "Demerger"],
  [/buy ?back/i, "Buyback"],
  [/qualified institutional|preferential|rights issue|fund raising|issue of securities|allotment of securities/i, "Fund raising"],
  [/capacity addition|commencement of commercial|product launch|commissioning/i, "Capacity / Commissioning"],
  [/credit rating/i, "Credit rating"],
  [/fraud|default|arrest|action\(s\) (taken|initiated)|pendency of litigation|penalt/i, "Regulatory / Legal"],
  [/press release|news verification|rumour verification/i, "News"],
];
const NEGATIVE = /fraud|default|arrest|penalt|downgrad/i;

const cache = new Map();
async function nse(path) {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < 30 * 60e3) return hit.data;
  const res = await fetch(`https://www.nseindia.com/api/${path}`, {
    headers: UA,
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`NSE returned HTTP ${res.status}`);
  const data = await res.json();
  cache.set(path, { at: Date.now(), data });
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return data;
}

const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
// "19-Oct-2026 12:34:07" or "05-Jun-2026" -> "2026-10-19"
function isoDate(s) {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})/.exec(String(s || ""));
  if (!m) return null;
  return `${m[3]}-${String(MON[m[2].toLowerCase()]).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}
// "Power Mech Projects Limited has informed the Exchange about Bagging/..." -> the useful part.
function tidy(text, company) {
  let t = String(text || "").replace(/\s+/g, " ").trim();
  t = t.replace(new RegExp(`^${company.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+has\\s+(informed|submitted to) the Exchange (about|regarding|that)?\\s*`, "i"), "");
  t = t.charAt(0).toUpperCase() + t.slice(1);
  return t.length > 240 ? `${t.slice(0, 237)}…` : t;
}

export async function eventsFor(ticker) {
  if (OFFLINE || !ticker) return [];
  const sym = encodeURIComponent(ticker);
  const since = new Date(Date.now() - YEARS_BACK * 366 * 86400e3).toISOString().slice(0, 10);
  const [ann, actions, meetings] = await Promise.all([
    nse(`corporate-announcements?index=equities&symbol=${sym}`).catch(() => []),
    nse(`corporates-corporateActions?index=equities&symbol=${sym}`).catch(() => []),
    nse(`corporate-board-meetings?index=equities&symbol=${sym}`).catch(() => []),
  ]);
  const out = [];
  const add = (e) => e.date && e.date >= since && out.push(e);

  for (const a of Array.isArray(ann) ? ann : []) {
    const desc = a.desc || "";
    const text = `${desc} ${a.attchmntText || ""}`;
    const rule = ANNOUNCEMENT_RULES.find(([re]) => re.test(desc)) ||
      // "Outcome of Board Meeting" counts when it decides something that moves a stock.
      (/outcome of board meeting/i.test(desc) && /split|sub-division|bonus|demerger|buy ?back|fund raising|qip|preferential|merger|amalgamation/i.test(text)
        ? [null, /split|sub-division|bonus/i.test(text) ? "Split / Bonus" : /demerger/i.test(text) ? "Demerger" : /buy ?back/i.test(text) ? "Buyback" : /merger|amalgamation/i.test(text) ? "M&A / Restructuring" : "Fund raising"]
        : null);
    if (!rule) continue;
    const theme = rule[1];
    // ESOP allotments are routine, not fund raising; routine rating reaffirmations aren't news.
    if (theme === "Fund raising" && /esop|esos|esps|employee stock/i.test(text)) continue;
    if (theme === "Credit rating" && !/upgrad|downgrad|revis|outlook/i.test(text)) continue;
    add({
      date: isoDate(a.an_dt) || String(a.sort_date || "").slice(0, 10),
      stock: a.sm_name || ticker,
      category: desc,
      theme,
      sentiment: NEGATIVE.test(text) ? "Negative" : "",
      title: tidy(a.attchmntText || desc, a.sm_name || ""),
      url: a.attchmntFile || "",
      source: "NSE filing",
    });
  }

  for (const c of Array.isArray(actions) ? actions : []) {
    const s = c.subject || "";
    const theme = /split|sub-division/i.test(s) ? "Split / Bonus" : /bonus/i.test(s) ? "Split / Bonus" : /demerger/i.test(s) ? "Demerger" : /buy ?back/i.test(s) ? "Buyback" : /dividend/i.test(s) ? "Dividend" : /rights/i.test(s) ? "Fund raising" : null;
    if (!theme) continue;
    add({
      date: isoDate(c.exDate),
      stock: c.comp || ticker,
      category: "Corporate action (ex-date)",
      theme,
      sentiment: "",
      title: s,
      url: "",
      source: "NSE corporate action",
    });
  }

  for (const m of Array.isArray(meetings) ? meetings : []) {
    if (!/financial result/i.test(m.bm_purpose || "")) continue;
    add({
      date: isoDate(m.bm_date),
      stock: m.sm_name || ticker,
      category: "Board meeting",
      theme: "Results",
      sentiment: "",
      title: tidy(m.bm_desc || "Financial results", m.sm_name || "").replace(/^Board Meeting to be held on .*? to /i, ""),
      url: m.attachment || "",
      source: "NSE board meeting",
    });
  }

  // One marker per theme per day: NSE often files the same thing more than once.
  const seen = new Set();
  return out
    .sort((a, b) => a.date.localeCompare(b.date))
    .filter((e) => {
      const k = `${e.date}|${e.theme}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((e, i) => ({ ...e, id: `nse:${ticker}:${i}`, color: NSE_THEMES[e.theme] || "#9e9e9e", score: "", conviction: "" }));
}
