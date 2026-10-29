// Earnings and dividend calendars, news, financial statements and key stats. Nasdaq's public API
// for US stocks; Cointelegraph's and Decrypt's RSS feeds for crypto headlines; Google News for India.
import { getJson, cached, NQ, resolve, nifty500List, yahooTimeseries } from "./providers.js";

const OFFLINE = process.env.QT_OFFLINE === "1";
const num = (s) => {
  const v = parseFloat(String(s ?? "").replace(/[$,%\s]/g, ""));
  return Number.isFinite(v) ? v : null;
};
const ymd = (d) => d.toISOString().slice(0, 10);

// The next n weekdays starting today (UTC).
function weekdays(n) {
  const out = [];
  const d = new Date();
  while (out.length < n) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(ymd(d));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

export async function earnings(days = 5) {
  if (OFFLINE) return [];
  const dates = weekdays(Math.min(10, Math.max(1, days)));
  const perDay = await Promise.all(
    dates.map((date) =>
      cached(`earnings:${date}`, 30 * 60e3, async () => {
        const j = await getJson(
          `https://api.nasdaq.com/api/calendar/earnings?date=${date}`,
          NQ,
        );
        return (j?.data?.rows || []).map((r) => ({
          date,
          symbol: `US:${r.symbol}`,
          ticker: r.symbol,
          name: r.name,
          when:
            r.time === "time-pre-market"
              ? "Before the open"
              : r.time === "time-after-hours"
                ? "After the close"
                : "Time not given",
          marketCap: num(r.marketCap),
          epsForecast: r.epsForecast || "",
          quarter: r.fiscalQuarterEnding || "",
          lastYearEps: r.lastYearEPS || "",
        }));
      }).catch(() => []),
    ),
  );
  return perDay.flat();
}

export async function dividends(days = 5) {
  if (OFFLINE) return [];
  const dates = weekdays(Math.min(10, Math.max(1, days)));
  const perDay = await Promise.all(
    dates.map((date) =>
      cached(`dividends:${date}`, 30 * 60e3, async () => {
        const j = await getJson(
          `https://api.nasdaq.com/api/calendar/dividends?date=${date}`,
          NQ,
        );
        return (j?.data?.calendar?.rows || []).map((r) => ({
          date,
          symbol: `US:${r.symbol}`,
          ticker: r.symbol,
          name: r.companyName,
          exDate: r.dividend_Ex_Date,
          payDate: r.payment_Date,
          recordDate: r.record_Date,
          amount: r.dividend_Rate,
          annual: r.indicated_Annual_Dividend,
        }));
      }).catch(() => []),
    ),
  );
  return perDay.flat();
}

// ---------- news ----------
const COIN_NAMES = {
  BTC: ["bitcoin", "btc"],
  ETH: ["ethereum", "ether", "eth"],
  SOL: ["solana", "sol"],
  XRP: ["xrp", "ripple"],
  BNB: ["bnb", "binance coin"],
  DOGE: ["dogecoin", "doge"],
  ADA: ["cardano", "ada"],
  AVAX: ["avalanche", "avax"],
  LINK: ["chainlink", "link"],
  DOT: ["polkadot"],
  LTC: ["litecoin", "ltc"],
  TRX: ["tron", "trx"],
  TON: ["toncoin", "ton"],
  SHIB: ["shiba inu", "shib"],
  PEPE: ["pepe"],
  SUI: ["sui"],
  NEAR: ["near protocol", "near"],
  ZEC: ["zcash", "zec"],
};
const decode = (s) =>
  s
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/<[^>]+>/g, "")
    .trim();

export function parseRss(xml, source) {
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1];
    const pick = (tag) =>
      decode(
        (new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`).exec(block) ||
          [])[1] || "",
      );
    const title = pick("title");
    if (!title) continue;
    items.push({
      title,
      url: pick("link"),
      source,
      time: Date.parse(pick("pubDate")) || null,
      summary: pick("description").slice(0, 280),
    });
  }
  return items;
}

async function cryptoNews() {
  return cached("news:crypto", 10 * 60e3, async () => {
    const feeds = [
      ["https://cointelegraph.com/rss", "Cointelegraph"],
      ["https://decrypt.co/feed", "Decrypt"],
    ];
    const lists = await Promise.all(
      feeds.map(async ([url, name]) => {
        try {
          const res = await fetch(url, {
            headers: { "User-Agent": "Mozilla/5.0 QuantTerminal" },
            signal: AbortSignal.timeout(10000),
          });
          return res.ok ? parseRss(await res.text(), name) : [];
        } catch {
          return [];
        }
      }),
    );
    return lists.flat().sort((a, b) => (b.time || 0) - (a.time || 0));
  });
}

export async function news(symbol) {
  if (OFFLINE) return { items: [], note: "" };
  const sym = await resolve(symbol);
  if (["BINANCE", "COINBASE", "KRAKEN"].includes(sym.exchange)) {
    const base =
      sym.ticker
        .replace(/-/g, "")
        .replace(/(USDT|USDC|FDUSD|USD|BTC|ETH|EUR)$/, "")
        .replace(/^XBT$/, "BTC") || "BTC";
    const all = await cryptoNews();
    const words = COIN_NAMES[base] || [base.toLowerCase()];
    const re = new RegExp(
      `\\b(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
      "i",
    );
    const hits = all.filter((n) => re.test(`${n.title} ${n.summary}`));
    return hits.length >= 3
      ? { items: hits.slice(0, 30), note: `Headlines mentioning ${base}` }
      : {
          items: all.slice(0, 30),
          note: `Few headlines mention ${base} right now, so these are the latest crypto headlines`,
        };
  }
  if (sym.exchange === "US") {
    const items = await cached(`news:${sym.ticker}`, 10 * 60e3, async () => {
      for (const cls of ["stocks", "etf", "index"]) {
        const j = await getJson(
          `https://api.nasdaq.com/api/news/topic/articlebysymbol?q=${encodeURIComponent(`${sym.ticker.toLowerCase()}|${cls}`)}&offset=0&limit=30&fallback=true`,
          NQ,
        ).catch(() => null);
        const rows = j?.data?.rows || [];
        if (rows.length)
          return rows.map((r) => ({
            title: r.title,
            url: r.url?.startsWith("http")
              ? r.url
              : `https://www.nasdaq.com${r.url}`,
            source: r.publisher,
            time: Date.parse(r.created) || null,
            ago: r.ago,
            summary: r.description || "",
          }));
      }
      return [];
    });
    return {
      items,
      note: items.length
        ? `Headlines for ${sym.ticker} from Nasdaq`
        : `No headlines found for ${sym.ticker}`,
    };
  }
  if (sym.exchange === "YAHOO" && INDIA.test(sym.ticker)) return indiaNews(sym.ticker);
  return {
    items: [],
    note: "Headlines are available for crypto, US and Indian stocks.",
  };
}

// ---------- India ----------
// NSE/BSE stocks (RELIANCE.NS, 500325.BO) and Indian indices (^NSEI, ^NSEBANK, ^BSESN, ^CNXIT...).
const INDIA = /\.(NS|BO)$|^\^(NSE|BSE|CNX)/;
const INDEX_NAMES = {
  "^NSEI": "Nifty 50",
  "^NSEBANK": "Bank Nifty",
  "^BSESN": "Sensex",
  "^CNXIT": "Nifty IT",
};

async function googleNews(query) {
  const res = await fetch(
    `https://news.google.com/rss/search?q=${encodeURIComponent(query)}+when:7d&hl=en-IN&gl=IN&ceid=IN:en`,
    {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(10000),
    },
  );
  if (!res.ok) return [];
  // Google puts the publisher at the end of the title ("Headline - Reuters").
  return parseRss(await res.text(), "Google News").map((n) => {
    const at = n.title.lastIndexOf(" - ");
    return at > 0
      ? { ...n, title: n.title.slice(0, at), source: n.title.slice(at + 3), summary: "" }
      : { ...n, summary: "" };
  });
}

async function indiaNews(ticker) {
  let label = INDEX_NAMES[ticker];
  let query;
  if (ticker.startsWith("^")) {
    label ||= ticker.slice(1);
    query = `${label} stock market India`;
  } else {
    const base = ticker.replace(/\.(NS|BO)$/, "");
    const row = (await nifty500List().catch(() => [])).find((r) => r.ticker === base);
    label = row ? row.name.replace(/\s+(Ltd|Limited)\.?$/i, "") : base;
    query = `"${label}" share OR stock`;
  }
  const items = await cached(`news:in:${ticker}`, 10 * 60e3, async () =>
    (await googleNews(query).catch(() => []))
      .sort((a, b) => (b.time || 0) - (a.time || 0))
      .slice(0, 30),
  );
  return {
    items,
    note: items.length
      ? `Headlines for ${label} from Indian and global news sites (via Google News, last 7 days)`
      : `No headlines found for ${label} in the last 7 days`,
  };
}

// ---------- fundamentals ----------
function table(t) {
  if (!t?.headers || !t?.rows) return null;
  const keys = Object.keys(t.headers).filter((k) => k !== "value1");
  return {
    periods: keys.map((k) => t.headers[k]),
    rows: t.rows.map((r) => ({
      label: r.value1,
      values: keys.map((k) => r[k] ?? ""),
    })),
  };
}

// Indian companies: Yahoo's fundamentals timeseries, shown in ₹ crore (1 crore = 10 million).
const IN_ROWS = {
  income: [
    ["TotalRevenue", "Total revenue"],
    ["CostOfRevenue", "Cost of revenue"],
    ["GrossProfit", "Gross profit"],
    ["OperatingExpense", "Operating expenses"],
    ["OperatingIncome", "Operating income"],
    ["EBITDA", "EBITDA"],
    ["InterestExpense", "Interest expense"],
    ["PretaxIncome", "Pre-tax income"],
    ["TaxProvision", "Tax"],
    ["NetIncome", "Net income"],
    ["DilutedEPS", "Diluted EPS (₹)"],
  ],
  balance: [
    ["TotalAssets", "Total assets"],
    ["CurrentAssets", "Current assets"],
    ["CashAndCashEquivalents", "Cash and equivalents"],
    ["TotalLiabilitiesNetMinorityInterest", "Total liabilities"],
    ["CurrentLiabilities", "Current liabilities"],
    ["TotalDebt", "Total debt"],
    ["StockholdersEquity", "Shareholders' equity"],
    ["OrdinarySharesNumber", "Shares outstanding (crore)"],
  ],
  cashflow: [
    ["OperatingCashFlow", "Operating cash flow"],
    ["CapitalExpenditure", "Capital expenditure"],
    ["FreeCashFlow", "Free cash flow"],
    ["InvestingCashFlow", "Investing cash flow"],
    ["FinancingCashFlow", "Financing cash flow"],
    ["CashDividendsPaid", "Dividends paid"],
  ],
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const crore = (v) => {
  if (v == null) return "";
  const s = Math.round(Math.abs(v) / 1e7).toLocaleString("en-IN");
  return v < 0 ? `(${s})` : s;
};

async function indiaFinancials(sym, frequency) {
  const prefix = frequency === "quarterly" ? "quarterly" : "annual";
  return cached(`fin:in:${sym.ticker}:${prefix}`, 6 * 3600e3, async () => {
    const all = Object.values(IN_ROWS).flat().map(([k]) => k);
    const [ts, spark] = await Promise.all([
      // P/E always uses the last full year: Yahoo's quarterly EPS often has gaps.
      yahooTimeseries(sym.ticker, [...all.map((k) => prefix + k), "annualDilutedEPS"]),
      getJson(
        `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${encodeURIComponent(sym.ticker)}&range=1d&interval=1d`,
        { "User-Agent": "Mozilla/5.0" },
      ).catch(() => null),
    ]);
    const series = (k) => ts[prefix + k] || [];
    // Newest period first, like the Nasdaq tables.
    const dates = [...new Set(all.flatMap((k) => series(k).map((x) => x.date)))]
      .sort()
      .reverse()
      .slice(0, prefix === "annual" ? 5 : 6);
    if (!dates.length)
      throw Object.assign(
        new Error(`Yahoo has no financials for ${sym.ticker}.`),
        { status: 404 },
      );
    const valueAt = (k, d) => series(k).find((x) => x.date === d)?.value ?? null;
    const label = (d) => {
      const [y, m] = d.split("-").map(Number);
      // Indian companies mostly close their year in March: FY26 = April 2025 to March 2026.
      return prefix === "annual"
        ? m <= 3
          ? `FY${String(y).slice(2)}`
          : `FY${String(y + 1).slice(2)} (${MONTHS[m - 1]})`
        : `${MONTHS[m - 1]} ${y}`;
    };
    const build = (rows) => {
      const out = rows
        .map(([k, name]) => ({
          label: name,
          values: dates.map((d) => {
            const v = valueAt(k, d);
            return k === "DilutedEPS" ? (v == null ? "" : v.toFixed(2)) : crore(v);
          }),
        }))
        .filter((r) => r.values.some((v) => v !== ""));
      return out.length ? { periods: dates.map(label), rows: out } : null;
    };
    const pct = (a, b) => (a == null || !b ? "" : `${((a / b) * 100).toFixed(1)}%`);
    const ratios = {
      periods: dates.map(label),
      rows: [
        ["Net margin", (d) => pct(valueAt("NetIncome", d), valueAt("TotalRevenue", d))],
        ["Operating margin", (d) => pct(valueAt("OperatingIncome", d), valueAt("TotalRevenue", d))],
        ["Return on equity", (d) => pct(valueAt("NetIncome", d), valueAt("StockholdersEquity", d))],
        ["Debt to equity", (d) => {
          const debt = valueAt("TotalDebt", d), eq = valueAt("StockholdersEquity", d);
          return debt == null || !eq ? "" : (debt / eq).toFixed(2);
        }],
      ]
        .map(([name, f]) => ({ label: name, values: dates.map(f) }))
        .filter((r) => r.values.some((v) => v !== "")),
    };

    // Key stats from the live price and the latest reported figures.
    const m = spark?.spark?.result?.[0]?.response?.[0]?.meta || {};
    const price = m.regularMarketPrice;
    const latest = (k) => series(k).at(-1)?.value ?? null;
    const shares = latest("OrdinarySharesNumber");
    const equity = latest("StockholdersEquity");
    const eps = (ts.annualDilutedEPS || []).at(-1)?.value ?? null;
    const inr = (v, dp = 2) => (v == null ? null : `₹${v.toLocaleString("en-IN", { maximumFractionDigits: dp })}`);
    const stats = [
      ["Price", inr(price)],
      ["Market cap", price && shares ? `₹${crore(price * shares)} Cr` : null],
      ["52-week high", inr(m.fiftyTwoWeekHigh)],
      ["52-week low", inr(m.fiftyTwoWeekLow)],
      ["P/E (last full year)", price && eps > 0 ? (price / eps).toFixed(1) : null],
      ["Book value / share", equity && shares ? inr(equity / shares) : null],
      ["Price / book", price && equity > 0 && shares ? (price / (equity / shares)).toFixed(2) : null],
    ]
      .filter(([, v]) => v)
      .map(([label, value]) => ({ label, value }));

    return {
      symbol: sym.id,
      frequency,
      currency: "INR",
      stats,
      nextEarnings: "",
      income: build(IN_ROWS.income),
      balance: build(IN_ROWS.balance),
      cashflow: build(IN_ROWS.cashflow),
      ratios: ratios.rows.length ? ratios : null,
      note: "Figures are in ₹ crore (1 crore = 10 million) unless marked, as reported to Yahoo Finance; brackets mean negative. Banks and insurers don't report every line.",
      source: "Yahoo Finance",
    };
  });
}

export async function financials(symbol, frequency = "annual") {
  if (OFFLINE) return null;
  const sym = await resolve(symbol);
  if (sym.exchange === "YAHOO" && /\.(NS|BO)$/.test(sym.ticker))
    return indiaFinancials(sym, frequency);
  if (sym.exchange !== "US")
    throw Object.assign(
      new Error("Financial statements are for US-listed and Indian (.NS / .BO) stocks."),
      { status: 422 },
    );
  const f = frequency === "quarterly" ? 2 : 1;
  return cached(`fin:${sym.ticker}:${f}`, 6 * 3600e3, async () => {
    const [fin, sum, ed] = await Promise.all([
      getJson(
        `https://api.nasdaq.com/api/company/${sym.ticker}/financials?frequency=${f}`,
        NQ,
      ).catch(() => null),
      getJson(
        `https://api.nasdaq.com/api/quote/${sym.ticker}/summary?assetclass=stocks`,
        NQ,
      ).catch(() => null),
      getJson(
        `https://api.nasdaq.com/api/analyst/${sym.ticker}/earnings-date`,
        NQ,
      ).catch(() => null),
    ]);
    const d = fin?.data || {};
    const stats = Object.values(sum?.data?.summaryData || {})
      .map((x) => ({ label: x.label, value: x.value }))
      .filter((x) => x.value && x.value !== "N/A");
    const out = {
      symbol: sym.id,
      frequency,
      stats,
      nextEarnings: (ed?.data?.reportText || "").replace(/\s+/g, " ").trim(),
      income: table(d.incomeStatementTable),
      balance: table(d.balanceSheetTable),
      cashflow: table(d.cashFlowTable),
      ratios: table(d.financialRatiosTable),
      note: "Statement figures are in thousands of US dollars, as Nasdaq reports them.",
    };
    if (!out.income && !stats.length)
      throw Object.assign(
        new Error(
          `Nasdaq has no financials for ${sym.ticker} (ETFs and funds don't file them).`,
        ),
        { status: 404 },
      );
    return out;
  });
}
