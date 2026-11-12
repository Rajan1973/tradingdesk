// Stock check: everything material about one company over the last 7 to 90 days, for the pop-up
// window (public/stockcheck.html). Three sources, no AI model:
//   NSE filings      orders, QIP / preferential / rights, JVs, M&A, credit ratings, auditors,
//                    regulatory actions, corporate actions, results (nse-events.js)
//   news headlines   Google News for the same kinds of event, sorted by keyword rules
//   analyst calls    broker ratings and targets read from headlines (analyst-events.js)
// Every item gets one group, which is what the window's filter boxes switch on and off.

import { eventsFor as nseEventsFor } from "./nse-events.js";
import { eventsFor as analystEventsFor, searchName, BROKER_RE } from "./analyst-events.js";
import { companyInfo, resolveName, nseNames } from "./catalysts.js";
import { parseRss } from "./market-info.js";

export const GROUPS = [
  "Order book",
  "QIP",
  "Preferential issue",
  "Rights / other fund raising",
  "JV / Agreement",
  "M&A / Restructuring",
  "Credit rating",
  "Compliance / Audit / Legal",
  "Corporate action",
  "Results",
  "Capacity / Commissioning",
  "Analyst / brokerage report",
  "Other news",
];

// A brokerage report in a headline: a named brokerage with a call or target, or the words brokerages use.
const BROKERAGE = {
  test: (t) =>
    (BROKER_RE.test(t) && /\b(buy|sell|hold|neutral|accumulate|add|reduce|overweight|underweight|outperform|underperform|target|rating|coverage|bullish|bearish|upgrade|downgrade)\b/i.test(t)) ||
    /brokerages?|initiates? coverage|target price|price target|analysts? (say|see|bullish|bearish|upbeat)/i.test(t),
};

const fundGroup = (text) =>
  /\bQIP\b|qualified institution/i.test(text) ? "QIP" : /preferential/i.test(text) ? "Preferential issue" : "Rights / other fund raising";

// A filing's theme (nse-events.js) and text -> its group.
export function filingGroup(theme, text) {
  return (
    {
      "Order win": "Order book",
      "JV / Agreement": "JV / Agreement",
      "M&A / Restructuring": "M&A / Restructuring",
      Demerger: "M&A / Restructuring",
      "Credit rating": "Credit rating",
      "Regulatory / Legal": "Compliance / Audit / Legal",
      "Compliance / Audit": "Compliance / Audit / Legal",
      "Split / Bonus": "Corporate action",
      Dividend: "Corporate action",
      Buyback: "Corporate action",
      Results: "Results",
      "Capacity / Commissioning": "Capacity / Commissioning",
    }[theme] || (theme === "Fund raising" ? fundGroup(text) : newsGroup(text))
  );
}

// A headline -> its group. The first rule that matches wins, so the narrow ones come first.
const NEWS_RULES = [
  [/\bQIP\b|qualified institution/i, "QIP"],
  [/preferential/i, "Preferential issue"],
  [/rights issue|fund ?rais|raises? (rs|₹|inr)[^a-z]*\d[\d,.]*\s*(cr|crore)/i, "Rights / other fund raising"],
  [/\b(CRISIL|ICRA|CARE Ratings|India Ratings|Acuite|Brickwork|Moody'?s|Fitch|S&P)\b|credit rating/i, "Credit rating"],
  [/auditor|\baudit\b|\bSEBI\b|show[- ]cause|penalt|\bfined\b|\bfine of\b|tax (demand|notice)|GST (notice|demand)|income tax|\braids?\b|\bprobe\b|investigation|forensic|non[- ]compliance|\bNCLT\b|insolvency|default|arbitra|tribunal|\bcourt\b|litigation/i, "Compliance / Audit / Legal"],
  [/acqui|merger|amalgamat|demerg|stake (sale|buy)|buys? .*stake|sells? .*stake/i, "M&A / Restructuring"],
  [BROKERAGE, "Analyst / brokerage report"],
  [/\b(bags?|bagged|wins?|won|secures?|secured|receives?|received|gets?|bagging|winning)\b[^.]*\b(orders?|contracts?|projects?|deals?|LoA|LoI)\b|letter of (award|intent)|order (inflow|book|win)|\bL1\b/i, "Order book"],
  [/joint venture|\bJV\b|\bMoU\b|partnership|partners with|ties? up|tie-up|collaborat|agreement/i, "JV / Agreement"],
  [/dividend|bonus|stock split|\bsplit\b|buyback|buy-back|record date|ex-date/i, "Corporate action"],
  [/\bQ[1-4]\s?FY|\bQ[1-4]\b|results?\b|net profit|\bPAT\b|quarter|financial performance|earnings/i, "Results"],
  [/commission|capacity|new plant|plant (launch|start)|production start/i, "Capacity / Commissioning"],
];
export const newsGroup = (title) => NEWS_RULES.find(([re]) => re.test(title))?.[1] || "Other news";

// Upgrade / downgrade / outlook, for credit-rating items.
export function ratingMove(text) {
  if (/downgrad/i.test(text)) return "Downgrade";
  if (/upgrad/i.test(text)) return "Upgrade";
  if (/outlook/i.test(text)) return "Outlook revised";
  if (/reaffirm/i.test(text)) return "Reaffirmed";
  return "";
}

const istDate = (t) => new Date(t + 5.5 * 3600e3).toISOString().slice(0, 10);

async function googleNews(query) {
  const res = await fetch(`https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-IN&gl=IN&ceid=IN:en`, {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return [];
  // Google puts the publisher at the end of the title ("Headline - Reuters").
  return parseRss(await res.text(), "Google News").map((n) => {
    const at = n.title.lastIndexOf(" - ");
    return at > 0 ? { ...n, title: n.title.slice(0, at), source: n.title.slice(at + 3) } : n;
  });
}

const cache = new Map();

// input: an NSE code ("HFCL") or a company name ("Tata Power"). days: 7 to 90.
export async function check(input, days = 7) {
  days = Math.min(90, Math.max(1, Math.round(Number(days) || 7)));
  const typed = String(input || "").trim().replace(/^YAHOO:/i, "").replace(/\.(NS|BO)$/i, "");
  if (!typed) throw Object.assign(new Error("Enter a stock name or NSE code."), { status: 400 });
  const key = `${typed.toUpperCase()}|${days}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60e3) return hit.data;

  const { syms } = await nseNames();
  let sym = syms.has(typed.toUpperCase()) ? typed.toUpperCase() : null;
  if (!sym) {
    const found = await resolveName(typed).catch(() => null);
    sym = /^YAHOO:(.+)\.NS$/.exec(found || "")?.[1] || null;
  }
  if (!sym) throw Object.assign(new Error(`Couldn't find "${typed}" among NSE-listed companies. Try its NSE code, like HFCL.`), { status: 404 });
  const info = (await companyInfo(sym).catch(() => null)) || { name: sym, others: [] };
  const since = istDate(Date.now() - days * 86400e3);
  const name = searchName(info.name);

  const words = 'order OR contract OR "joint venture" OR MoU OR QIP OR preferential OR "rights issue" OR rating OR auditor OR SEBI OR penalty OR tax OR dividend OR bonus OR split OR buyback OR acquisition OR results';
  const [filings, analyst, news] = await Promise.all([
    nseEventsFor(sym).catch(() => []),
    analystEventsFor(sym, info.name, info.others).catch(() => []),
    googleNews(`"${name}" (${words}) when:${days}d`).catch(() => []),
  ]);

  const items = [];
  for (const e of filings) {
    if (e.date < since) continue;
    const text = `${e.category} ${e.title}`;
    const group = filingGroup(e.theme, text);
    items.push({
      date: e.date,
      group,
      detail: group === "Credit rating" ? ratingMove(text) : e.category,
      title: e.title,
      url: e.url,
      source: e.source,
      negative: e.sentiment === "Negative",
    });
  }
  // A call already read from a headline (broker, rating, target) isn't listed again as plain news.
  const seen = new Set();
  for (const e of analyst) {
    if (e.date < since) continue;
    seen.add(String(e.headline || "").toLowerCase());
    items.push({ date: e.date, group: "Analyst / brokerage report", detail: [e.rating, e.target ? `target ₹${e.target.toLocaleString("en-IN")}` : ""].filter(Boolean).join(", "), title: e.title, headline: e.headline, url: e.url, source: e.source, negative: e.sentiment === "Negative" });
  }
  // Headlines about other companies with a similar name are dropped, as in analyst-events.js.
  const first = name.split(" ")[0].toLowerCase();
  for (const n of news) {
    const lower = n.title.toLowerCase();
    // Google's when:Nd also returns old pages it found again recently, so the date is checked here too.
    if (!n.time || istDate(n.time) < since || (!lower.includes(first) && !lower.includes(sym.toLowerCase()))) continue;
    if (info.others.some((o) => o && lower.includes(o.toLowerCase()) && o.toLowerCase() !== name.toLowerCase())) continue;
    if (seen.has(lower)) continue;
    seen.add(lower);
    const group = newsGroup(n.title);
    items.push({
      date: istDate(n.time),
      time: n.time,
      group,
      detail: group === "Credit rating" ? ratingMove(n.title) : "",
      title: n.title,
      url: n.url,
      source: `${n.source} (news)`,
      negative: /downgrad|penalt|default|raid|probe|fraud|show[- ]cause/i.test(n.title),
    });
  }
  items.sort((a, b) => b.date.localeCompare(a.date) || (b.time || 0) - (a.time || 0));
  const counts = Object.fromEntries(GROUPS.map((g) => [g, items.filter((i) => i.group === g).length]));
  const data = { symbol: sym, name: info.name, days, since, groups: GROUPS, counts, items };
  cache.set(key, { at: Date.now(), data });
  if (cache.size > 100) cache.delete(cache.keys().next().value);
  return data;
}
