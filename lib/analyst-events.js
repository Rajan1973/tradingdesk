// Analyst calls (broker, rating, target price) for Indian stocks, read from news headlines on
// Google News: "Buy Tata Power; target of Rs 488: Motilal Oswal", "… Equal Weight rating from
// Morgan Stanley with target price of Rs 399". A headline counts only when it names a known
// brokerage and gives a rating, a target or a target change; the headline is kept with it so
// you can check what was read. Shown as diamonds: green buy, amber hold, red sell.

const OFFLINE = process.env.QT_OFFLINE === "1";

// Brokerages that publish on Indian stocks. Longer names first so "Kotak Institutional" wins over "Kotak".
const BROKERS = [
  "Motilal Oswal", "ICICI Securities", "ICICIdirect", "ICICI Direct", "Kotak Institutional Equities", "Kotak Securities", "Kotak Equities", "Kotak",
  "HDFC Securities", "Axis Securities", "Axis Capital", "SBI Securities", "SBICAPS", "JM Financial", "Nuvama", "Edelweiss", "Emkay", "Prabhudas Lilladher",
  "Anand Rathi", "Sharekhan", "Antique", "Elara", "Ambit", "Centrum", "Choice Broking", "Geojit", "Religare", "IIFL", "Systematix", "YES Securities",
  "PhillipCapital", "Phillip Capital", "Equirus", "Dolat", "Arihant", "Ventura", "Mirae Asset", "Bajaj Broking", "Monarch", "Asit C Mehta", "BP Equities",
  "InCred", "Investec", "Nirmal Bang", "Batlivala", "B&K", "Jefferies", "Morgan Stanley", "Goldman Sachs", "JP Morgan", "JPMorgan", "J.P. Morgan",
  "CLSA", "Citi", "Citigroup", "Nomura", "Macquarie", "Bernstein", "BofA", "Bank of America", "BofA Securities", "UBS", "HSBC", "Morningstar",
  "Deutsche", "Barclays", "Credit Suisse", "Daiwa", "Mizuho", "Avendus", "Spark Capital", "DAM Capital", "Ashika", "Stoxbox", "Marwadi",
].sort((a, b) => b.length - a.length);
const BROKER_RE = new RegExp(`\\b(${BROKERS.map((b) => b.replace(/[.*+?^${}()|[\]\\&]/g, "\\$&")).join("|")})\\b`, "i");

// Rating words, strongest signal first.
const RATINGS = [
  [/\bdowngrade[sd]?\b/i, "Downgrade", "sell"],
  [/\bupgrade[sd]?\b/i, "Upgrade", "buy"],
  [/\b(strong buy)\b/i, "Strong Buy", "buy"],
  [/\b(sell|reduce|underperform|underweight|bearish)\b/i, null, "sell"],
  [/\b(hold|neutral|equal[- ]weight|market[- ]perform|in[- ]line)\b/i, null, "hold"],
  [/\b(buy|accumulate|add|outperform|overweight|bullish|positive)\b/i, null, "buy"],
];
import { ANALYST_COLORS as COLORS } from "../public/lib/marker-types.js";

const cache = new Map();

function decode(s) {
  return String(s)
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/<[^>]+>/g, "")
    .trim();
}

// "₹2,950", "Rs 2950", "Rs. 1,150", "INR 488" next to the word target.
function targetOf(title) {
  const money = String.raw`(?:₹|Rs\.?|INR)\s?([\d,]+(?:\.\d+)?)`;
  const m =
    new RegExp(`target(?: price)?(?: of| at| to)?\\s*${money}`, "i").exec(title) ||
    new RegExp(`${money}\\s*(?:target|price target|TP)`, "i").exec(title) ||
    new RegExp(`TP(?: of| to| at)?\\s*${money}`, "i").exec(title);
  const v = m ? Number(m[1].replace(/,/g, "")) : null;
  return v && v > 0 ? v : null;
}

function ratingOf(title) {
  for (const [re, label, side] of RATINGS) {
    const m = re.exec(title);
    if (m) return { label: label || m[1].replace(/\b\w/g, (c) => c.toUpperCase()), side };
  }
  return null;
}

// The words to search for: the company name without "Limited", trimmed to what headlines use.
export function searchName(fullName) {
  let words = String(fullName)
    .replace(/\b(limited|ltd\.?)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ");
  if (words.length > 2) words = /^(of|and|&)$/i.test(words[1]) ? words.slice(0, 3) : words.slice(0, 2);
  return words.join(" ");
}

// others: longer company names that contain this one (skip headlines about them).
export async function eventsFor(ticker, fullName, others = []) {
  if (OFFLINE || !fullName) return [];
  const name = searchName(fullName);
  const key = `${ticker}|${name}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 6 * 3600e3) return hit.data;
  const q = `"${name}" (target OR rating OR brokerage OR upgrade OR downgrade) when:1y`;
  let xml = "";
  try {
    const res = await fetch(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-IN&gl=IN&ceid=IN:en`, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) xml = await res.text();
  } catch {
    return [];
  }
  const first = name.split(" ")[0].toLowerCase();
  const nameRe = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  const out = [];
  const seen = new Set();
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const pick = (tag) => decode((new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`).exec(m[1]) || [])[1] || "");
    let title = pick("title");
    const at = title.lastIndexOf(" - ");
    const publisher = at > 0 ? title.slice(at + 3) : "";
    if (at > 0) title = title.slice(0, at);
    const lower = title.toLowerCase();
    // About this company, from a named brokerage, and saying something.
    if (!lower.includes(first) && !lower.includes(ticker.toLowerCase())) continue;
    if (others.some((o) => o && o.toLowerCase() !== name.toLowerCase() && lower.includes(o.toLowerCase()))) continue;
    // Lists of several stocks ("Kotak, BoB, PB Fintech: Macquarie upgrades nine stocks") aren't a call on this one.
    if (/\b(stocks|shares to|full list|top picks|picks|among|pack|these \w+ stocks)\b/i.test(title) || (title.split(":")[0].match(/,/g) || []).length >= 2) continue;
    // Look for the broker with the company's own name taken out (Kotak Bank isn't Kotak Securities).
    // The company's own name (and its first word: "Kotak", "ICICI", "HDFC") isn't the broker.
    const firstWord = new RegExp(`\\b${name.split(" ")[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b(?!\\s+(securities|institutional|equities|direct|capital|global))`, "gi");
    const broker = BROKER_RE.exec(title.replace(nameRe, " ").replace(firstWord, " "))?.[1];
    if (!broker) continue;
    const target = targetOf(title);
    const rating = ratingOf(title);
    const move = /\b(raises?|hikes?|ups|lifts?|increases?)\b[^.]*\btarget/i.test(title)
      ? "raises target"
      : /\b(cuts?|lowers?|slashes|trims?|reduces?)\b[^.]*\btarget/i.test(title)
        ? "cuts target"
        : "";
    if (!target && !rating && !move) continue;
    const t = Date.parse(pick("pubDate"));
    if (!t) continue;
    const date = new Date(t + 5.5 * 3600e3).toISOString().slice(0, 10); // IST date
    const side = rating?.side || (move === "raises target" ? "buy" : move === "cuts target" ? "sell" : "none");
    const k = `${date}|${broker.toLowerCase()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const call = [rating?.label, move, target ? `target ₹${target.toLocaleString("en-IN")}` : ""].filter(Boolean).join(", ");
    out.push({
      date,
      stock: fullName,
      category: "Analyst call",
      theme: `Analyst: ${rating?.label || (move ? move[0].toUpperCase() + move.slice(1) : "Call")}`,
      kind: "analyst",
      broker,
      rating: rating?.label || "",
      target,
      sentiment: side === "buy" ? "Positive" : side === "sell" ? "Negative" : "",
      title: `${broker}: ${call}`,
      headline: title,
      url: pick("link"),
      source: publisher ? `${publisher} (news headline)` : "News headline",
      color: COLORS[side],
      score: "",
      conviction: "",
    });
  }
  // The same broker and target repeated within 30 days is one call (news sites republish).
  const last = new Map();
  const data = out
    .sort((a, b) => a.date.localeCompare(b.date))
    .filter((e) => {
      const k = `${e.broker.toLowerCase()}|${e.target || e.rating}`;
      const prev = last.get(k);
      last.set(k, e.date);
      return !prev || Date.parse(e.date) - Date.parse(prev) > 30 * 86400e3;
    })
    .map((e, i) => ({ ...e, id: `analyst:${ticker}:${i}` }));
  cache.set(key, { at: Date.now(), data });
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return data;
}
