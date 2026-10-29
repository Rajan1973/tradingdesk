// Ready-made screener conditions for each indicator, worded the way TradingView's screener does
// ("Upper crosses down Price", "Crosses up EMA 200"), with a short meaning under each. A preset is
// one or more rules that must all hold on the last bar. Operands:
//   S("upper")        this indicator, with the settings chosen in the screener
//   I(id, params, o)  another indicator (a 200 EMA to compare with)
//   P("close")        a price field, V(70) a number
// Ops are the engine's: > < >= <= crossesAbove crossesBelow, plus abovePct / belowPct with
// min and max in % ("Upper above Price by 0% to 2%").

const S = (output = "value") => ({ kind: "self", output });
const I = (id, params, output = "value") => ({ kind: "ind", id, params, output });
const P = (field = "close") => ({ kind: "price", field });
const V = (v) => ({ kind: "value", v });
const r = (left, op, right, extra = {}) => ({ left, op, right, ...extra });
const preset = (label, hint, ...rules) => ({ label, hint, rules });

// Indicators grouped as the screener lists them. Anything not here is under "Other".
export const GROUPS = [
  ["Moving averages", ["sma", "ema", "wma", "vwma", "hma", "dema", "tema", "smma", "alma", "lsma", "mcginley", "vwap", "twap", "macross", "ribbon", "guppy", "alligator"]],
  ["Bands and channels", ["bb", "kc", "donchian", "envelope", "bbpb", "bbw"]],
  ["Oscillators", ["rsi", "stoch", "stochrsi", "macd", "cci", "willr", "mfi", "uo", "crsi", "cmo", "roc", "mom", "ao", "tsi", "ppo", "trix", "fisher", "smiergodic", "kst", "coppock", "dpo", "rvgi", "elder", "bop", "rci"]],
  ["Trend", ["supertrend", "psar", "ichimoku", "dmi", "adx", "aroon", "vortex", "vstop", "cks", "chop", "trendstrength", "markov", "bbtrend"]],
  ["Volume", ["volume", "obv", "cmf", "mfi", "chaikinosc", "efi", "kvo", "volosc", "eom", "netvol", "pvt", "ad"]],
  ["Levels", ["pivots", "pdhl"]],
];

const MA_IDS = new Set(["sma", "ema", "wma", "vwma", "hma", "dema", "tema", "smma", "alma", "lsma", "mcginley", "vwap", "twap"]);
const SHORT = { sma: "SMA", ema: "EMA", wma: "WMA", vwma: "VWMA", hma: "HMA", dema: "DEMA", tema: "TEMA", smma: "SMMA", alma: "ALMA", lsma: "LSMA", mcginley: "McGinley" };

// ---------- families ----------
function movingAverage(id, params) {
  const out = [
    preset("Below Price", "Bullish bias: price above the average", r(S(), "<", P())),
    preset("Above Price", "Bearish bias: price below the average", r(S(), ">", P())),
    preset("Crosses down Price", "Bullish crossover: price moves above the average", r(S(), "crossesBelow", P())),
    preset("Crosses up Price", "Bearish crossover: price moves below the average", r(S(), "crossesAbove", P())),
    preset("Below Price by 0% to 2%", "Pullback: price just above the average (support test)", r(S(), "belowPct", P(), { min: 0, max: 2 })),
    preset("Above Price by 0% to 2%", "Rally into the average from below (resistance test)", r(S(), "abovePct", P(), { min: 0, max: 2 })),
    preset("Below Price by 10% or more", "Extended: price well above the average", r(S(), "belowPct", P(), { min: 10 })),
    preset("Below Price by 20% or more", "Extreme bullish deviation", r(S(), "belowPct", P(), { min: 20 })),
    preset("Above Price by 20% or more", "Extreme bearish deviation", r(S(), "abovePct", P(), { min: 20 })),
  ];
  const len = Number(params.length);
  if (SHORT[id] && len) {
    const name = SHORT[id];
    // The usual partners: a short average against the 50 and 200, a 50 against the 100 and 200.
    const partners = len < 50 ? [200, 50] : len < 100 ? [200, 100] : len < 200 ? [200] : [];
    for (const longer of partners) {
      const other = I(id, { length: longer });
      const big = longer === 200;
      out.push(
        preset(`Crosses up ${name} ${longer}`, big ? "Golden cross" : "Bullish crossover of the longer average", r(S(), "crossesAbove", other)),
        preset(`Crosses down ${name} ${longer}`, big ? "Death cross" : "Bearish crossover of the longer average", r(S(), "crossesBelow", other)),
        preset(`Above ${name} ${longer}`, "Bullish alignment", r(S(), ">", other)),
        preset(`Below ${name} ${longer}`, "Bearish alignment", r(S(), "<", other)),
      );
    }
    if (len < 200)
      out.push(
        preset(`Below Price, Price above ${name} 200`, "Price above this average and the long-term trend", r(S(), "<", P()), r(P(), ">", I(id, { length: 200 }))),
      );
  }
  return out;
}

function bands(id) {
  const out = [
    preset("Upper below Price", "Breakout: price closed above the upper band", r(S("upper"), "<", P())),
    preset("Upper crosses down Price", "Fresh breakout above the upper band", r(S("upper"), "crossesBelow", P())),
    preset("Upper crosses up Price", "Overbought re-entry: price falls back inside the band", r(S("upper"), "crossesAbove", P())),
    preset("Upper above Price by 0% to 2%", "Upper band proximity", r(S("upper"), "abovePct", P(), { min: 0, max: 2 })),
    preset("Upper above Price by 0% to 5%", "Mild upper band proximity", r(S("upper"), "abovePct", P(), { min: 0, max: 5 })),
    preset("Basis below Price", "Bullish bias: price above the middle line", r(S("basis"), "<", P())),
    preset("Basis above Price", "Bearish bias: price below the middle line", r(S("basis"), ">", P())),
    preset("Basis crosses down Price", "Price crosses above the middle line", r(S("basis"), "crossesBelow", P())),
    preset("Basis crosses up Price", "Price crosses below the middle line", r(S("basis"), "crossesAbove", P())),
    preset("Lower below Price by 0% to 2%", "Lower band proximity", r(S("lower"), "belowPct", P(), { min: 0, max: 2 })),
    preset("Lower below Price by 0% to 5%", "Mild lower band proximity", r(S("lower"), "belowPct", P(), { min: 0, max: 5 })),
    preset("Lower above Price", "Lower band overextension: price closed below the band", r(S("lower"), ">", P())),
    preset("Lower crosses up Price", "Fresh breakdown below the lower band", r(S("lower"), "crossesAbove", P())),
    preset("Lower crosses down Price", "Oversold re-entry: price climbs back inside the band", r(S("lower"), "crossesBelow", P())),
  ];
  // Envelope bands are a fixed % apart, so only the others can squeeze or widen.
  if (id === "bb" || id === "kc")
    out.push(
      preset("Upper above Lower by 0% to 10%", "Squeeze: narrow bands, low volatility", r(S("upper"), "abovePct", S("lower"), { min: 0, max: 10 })),
      preset("Upper above Lower by 25% or more", "High volatility: wide bands", r(S("upper"), "abovePct", S("lower"), { min: 25 })),
    );
  if (id === "donchian")
    out.unshift(
      preset("Upper at or below High", "New high for the period (breakout)", r(S("upper"), "<=", P("high"))),
      preset("Lower at or above Low", "New low for the period (breakdown)", r(S("lower"), ">=", P("low"))),
    );
  return out;
}

// Oscillators with an oversold / overbought zone.
function zoned(lo, mid, hi, { signal, sigName = "Signal", out = "value" } = {}) {
  const x = S(out);
  const list = [
    preset(`Below ${lo}`, "Oversold", r(x, "<", V(lo))),
    preset(`Above ${hi}`, "Overbought", r(x, ">", V(hi))),
    preset(`Crosses up ${lo}`, "Leaving oversold: bullish", r(x, "crossesAbove", V(lo))),
    preset(`Crosses down ${hi}`, "Leaving overbought: bearish", r(x, "crossesBelow", V(hi))),
  ];
  if (mid != null)
    list.push(
      preset(`Above ${mid}`, "Bullish momentum", r(x, ">", V(mid))),
      preset(`Below ${mid}`, "Bearish momentum", r(x, "<", V(mid))),
      preset(`Crosses up ${mid}`, "Momentum turning bullish", r(x, "crossesAbove", V(mid))),
      preset(`Crosses down ${mid}`, "Momentum turning bearish", r(x, "crossesBelow", V(mid))),
      preset(`Between ${mid} and ${hi}`, "Strong but not overbought", r(x, ">", V(mid)), r(x, "<", V(hi))),
      preset(`Between ${lo} and ${mid}`, "Weak but not oversold", r(x, ">", V(lo)), r(x, "<", V(mid))),
    );
  if (signal)
    list.push(
      preset(`Crosses up ${sigName}`, "Bullish crossover", r(x, "crossesAbove", S(signal))),
      preset(`Crosses down ${sigName}`, "Bearish crossover", r(x, "crossesBelow", S(signal))),
      preset(`Crosses up ${sigName} below ${lo}`, "Bullish crossover in oversold zone", r(x, "crossesAbove", S(signal)), r(x, "<", V(lo))),
      preset(`Crosses down ${sigName} above ${hi}`, "Bearish crossover in overbought zone", r(x, "crossesBelow", S(signal)), r(x, ">", V(hi))),
    );
  return list;
}

// Oscillators around zero.
function zeroLine(out = "value", signal, sigName = "Signal") {
  const x = S(out);
  const list = [
    preset("Above 0", "Bullish", r(x, ">", V(0))),
    preset("Below 0", "Bearish", r(x, "<", V(0))),
    preset("Crosses up 0", "Turning bullish", r(x, "crossesAbove", V(0))),
    preset("Crosses down 0", "Turning bearish", r(x, "crossesBelow", V(0))),
  ];
  if (signal)
    list.push(
      preset(`Crosses up ${sigName}`, "Bullish crossover", r(x, "crossesAbove", S(signal))),
      preset(`Crosses down ${sigName}`, "Bearish crossover", r(x, "crossesBelow", S(signal))),
      preset(`Above ${sigName}`, "Bullish alignment", r(x, ">", S(signal))),
      preset(`Below ${sigName}`, "Bearish alignment", r(x, "<", S(signal))),
    );
  return list;
}

// Stop-and-reverse lines drawn as separate up / down outputs (Supertrend, Volatility Stop).
function trendStop(up = "up", down = "down") {
  return [
    preset("Up below Price", "Uptrend", r(S(up), "<", P())),
    preset("Down above Price", "Downtrend", r(S(down), ">", P())),
    preset("Up below Price by 0% to 3%", "Uptrend, price pulled back near the stop line", r(S(up), "belowPct", P(), { min: 0, max: 3 })),
    preset("Down above Price by 0% to 3%", "Downtrend, price rallied near the stop line", r(S(down), "abovePct", P(), { min: 0, max: 3 })),
  ];
}

// ---------- per indicator ----------
export function presetsFor(id, params = {}) {
  if (MA_IDS.has(id)) return movingAverage(id, params);
  switch (id) {
    case "bb":
    case "kc":
    case "donchian":
    case "envelope":
      return bands(id);
    case "bbpb":
      return [
        preset("Above 1", "Price above the upper band", r(S(), ">", V(1))),
        preset("Below 0", "Price below the lower band", r(S(), "<", V(0))),
        preset("Crosses up 0", "Oversold re-entry", r(S(), "crossesAbove", V(0))),
        preset("Crosses down 1", "Overbought re-entry", r(S(), "crossesBelow", V(1))),
        preset("Above 0.5", "Upper half of the bands: bullish", r(S(), ">", V(0.5))),
        preset("Below 0.5", "Lower half of the bands: bearish", r(S(), "<", V(0.5))),
      ];
    case "bbw":
      // BandWidth is in % of the middle band: about 3 to 30 on daily stock charts.
      return [
        preset("Below 5", "Tight squeeze: bands within 5% of the middle", r(S(), "<", V(5))),
        preset("Below 10", "Squeeze: low volatility", r(S(), "<", V(10))),
        preset("Above 20", "Wide bands: high volatility", r(S(), ">", V(20))),
        preset("Crosses up 10", "Volatility expanding out of a squeeze", r(S(), "crossesAbove", V(10))),
      ];
    case "rsi":
      return [
        ...zoned(30, 50, 70),
        preset("Crosses up its MA", "Bullish crossover of the RSI average", r(S(), "crossesAbove", S("ma"))),
        preset("Crosses down its MA", "Bearish crossover of the RSI average", r(S(), "crossesBelow", S("ma"))),
        preset("Below 20", "Deeply oversold", r(S(), "<", V(20))),
        preset("Above 80", "Strongly overbought", r(S(), ">", V(80))),
      ];
    case "stoch":
    case "stochrsi":
      return zoned(20, 50, 80, { out: "k", signal: "d", sigName: "%D" }).map((p) => ({ ...p, label: `%K ${p.label}` }));
    case "mfi":
      return zoned(20, 50, 80);
    case "cci":
      return zoned(-100, 0, 100);
    case "willr":
      return zoned(-80, -50, -20);
    case "uo":
      return zoned(30, 50, 70);
    case "crsi":
      return zoned(10, null, 90).concat(zoned(30, null, 70).slice(0, 2));
    case "cmo":
      return zoned(-50, 0, 50);
    case "fisher":
      return zoned(-1.5, 0, 1.5, { out: "fisher", signal: "trigger", sigName: "Trigger" });
    case "macd":
      return [
        preset("MACD crosses up Signal", "Bullish crossover", r(S("macd"), "crossesAbove", S("signal"))),
        preset("MACD crosses down Signal", "Bearish crossover", r(S("macd"), "crossesBelow", S("signal"))),
        preset("MACD crosses up Signal below 0", "Bullish crossover from below zero (early reversal)", r(S("macd"), "crossesAbove", S("signal")), r(S("macd"), "<", V(0))),
        preset("MACD crosses down Signal above 0", "Bearish crossover from above zero", r(S("macd"), "crossesBelow", S("signal")), r(S("macd"), ">", V(0))),
        preset("MACD above Signal", "Bullish alignment", r(S("macd"), ">", S("signal"))),
        preset("MACD below Signal", "Bearish alignment", r(S("macd"), "<", S("signal"))),
        preset("MACD crosses up 0", "Momentum turns bullish", r(S("macd"), "crossesAbove", V(0))),
        preset("MACD crosses down 0", "Momentum turns bearish", r(S("macd"), "crossesBelow", V(0))),
        preset("MACD above 0", "Bullish trend", r(S("macd"), ">", V(0))),
        preset("MACD below 0", "Bearish trend", r(S("macd"), "<", V(0))),
        preset("Histogram crosses up 0", "Same as MACD crossing above Signal", r(S("hist"), "crossesAbove", V(0))),
        preset("Histogram above 0 and MACD above 0", "Strong bullish momentum", r(S("hist"), ">", V(0)), r(S("macd"), ">", V(0))),
      ];
    case "roc":
    case "mom":
    case "ao":
    case "trix":
    case "coppock":
    case "dpo":
    case "bop":
    case "rci":
    case "cmf":
    case "chaikinosc":
    case "efi":
    case "eom":
    case "volosc":
    case "netvol":
    case "bbtrend":
    case "trendstrength":
      return zeroLine();
    case "tsi":
    case "ppo":
    case "rvgi":
      return zeroLine("value", "signal");
    case "kst":
      return zeroLine("kst", "signal");
    case "kvo":
      return zeroLine("kvo", "signal");
    case "smiergodic":
      return zeroLine("smi", "signal");
    case "elder":
      return [
        preset("Bull power above 0", "Buyers pushing highs above the average", r(S("bull"), ">", V(0))),
        preset("Bear power below 0", "Sellers pushing lows below the average", r(S("bear"), "<", V(0))),
        preset("Bear power crosses up 0", "Selling pressure fading", r(S("bear"), "crossesAbove", V(0))),
        preset("Bull power crosses down 0", "Buying pressure fading", r(S("bull"), "crossesBelow", V(0))),
      ];
    case "supertrend":
    case "vstop":
      return trendStop();
    case "cks":
      return [
        preset("Stop long below Price", "Long stop holding: bullish", r(S("stopLong"), "<", P())),
        preset("Stop short above Price", "Short stop holding: bearish", r(S("stopShort"), ">", P())),
        preset("Stop short crosses down Price", "Price breaks above the short stop", r(S("stopShort"), "crossesBelow", P())),
        preset("Stop long crosses up Price", "Price breaks below the long stop", r(S("stopLong"), "crossesAbove", P())),
      ];
    case "psar":
      return [
        preset("Below Price", "Uptrend", r(S(), "<", P())),
        preset("Above Price", "Downtrend", r(S(), ">", P())),
        preset("Crosses down Price", "Flip to uptrend", r(S(), "crossesBelow", P())),
        preset("Crosses up Price", "Flip to downtrend", r(S(), "crossesAbove", P())),
      ];
    case "ichimoku":
      return [
        preset("Price above the cloud", "Bullish: close above both cloud lines", r(P(), ">", S("spanA")), r(P(), ">", S("spanB"))),
        preset("Price below the cloud", "Bearish: close below both cloud lines", r(P(), "<", S("spanA")), r(P(), "<", S("spanB"))),
        preset("Conversion crosses up Base", "TK bullish cross", r(S("conversion"), "crossesAbove", S("base"))),
        preset("Conversion crosses down Base", "TK bearish cross", r(S("conversion"), "crossesBelow", S("base"))),
        preset("Price above cloud, Conversion above Base", "Strong uptrend", r(P(), ">", S("spanA")), r(P(), ">", S("spanB")), r(S("conversion"), ">", S("base"))),
        preset("Span A above Span B", "Green cloud: bullish", r(S("spanA"), ">", S("spanB"))),
        preset("Price crosses up Base", "Price reclaims the base line", r(P(), "crossesAbove", S("base"))),
      ];
    case "dmi":
      return [
        preset("+DI crosses up -DI", "Bullish directional crossover", r(S("plus"), "crossesAbove", S("minus"))),
        preset("+DI crosses down -DI", "Bearish directional crossover", r(S("plus"), "crossesBelow", S("minus"))),
        preset("+DI above -DI, ADX above 25", "Strong uptrend", r(S("plus"), ">", S("minus")), r(S("adx"), ">", V(25))),
        preset("-DI above +DI, ADX above 25", "Strong downtrend", r(S("minus"), ">", S("plus")), r(S("adx"), ">", V(25))),
        preset("ADX above 25", "Trending market", r(S("adx"), ">", V(25))),
        preset("ADX below 20", "No clear trend", r(S("adx"), "<", V(20))),
      ];
    case "adx":
      return [
        preset("Above 25", "Trending market", r(S("adx"), ">", V(25))),
        preset("Above 40", "Very strong trend", r(S("adx"), ">", V(40))),
        preset("Below 20", "Weak trend or range", r(S("adx"), "<", V(20))),
        preset("Crosses up 25", "A trend is starting", r(S("adx"), "crossesAbove", V(25))),
        preset("Crosses down 20", "The trend is fading", r(S("adx"), "crossesBelow", V(20))),
      ];
    case "aroon":
      return [
        preset("Up crosses up Down", "Bullish crossover", r(S("up"), "crossesAbove", S("down"))),
        preset("Up crosses down Down", "Bearish crossover", r(S("up"), "crossesBelow", S("down"))),
        preset("Up above 70, Down below 30", "Strong uptrend", r(S("up"), ">", V(70)), r(S("down"), "<", V(30))),
        preset("Down above 70, Up below 30", "Strong downtrend", r(S("down"), ">", V(70)), r(S("up"), "<", V(30))),
        preset("Up at 100", "New high for the period", r(S("up"), ">=", V(100))),
      ];
    case "vortex":
      return [
        preset("VI+ crosses up VI-", "Bullish crossover", r(S("plus"), "crossesAbove", S("minus"))),
        preset("VI+ crosses down VI-", "Bearish crossover", r(S("plus"), "crossesBelow", S("minus"))),
        preset("VI+ above VI-", "Uptrend", r(S("plus"), ">", S("minus"))),
        preset("VI+ below VI-", "Downtrend", r(S("plus"), "<", S("minus"))),
      ];
    case "chop":
      return [
        preset("Below 38.2", "Trending market", r(S(), "<", V(38.2))),
        preset("Above 61.8", "Choppy, sideways market", r(S(), ">", V(61.8))),
        preset("Crosses down 61.8", "Coming out of a range", r(S(), "crossesBelow", V(61.8))),
      ];
    case "markov":
      return [
        preset("Signal above 0", "Bull regime", r(S("signal"), ">", V(0))),
        preset("Signal below 0", "Bear regime", r(S("signal"), "<", V(0))),
        preset("Bull probability above 0.6", "Likely bull regime", r(S("pbull"), ">", V(0.6))),
      ];
    case "macross":
      return [
        preset("Fast crosses up Slow", "Bullish crossover", r(S("fast"), "crossesAbove", S("slow"))),
        preset("Fast crosses down Slow", "Bearish crossover", r(S("fast"), "crossesBelow", S("slow"))),
        preset("Fast above Slow", "Bullish alignment", r(S("fast"), ">", S("slow"))),
        preset("Fast below Slow", "Bearish alignment", r(S("fast"), "<", S("slow"))),
        preset("Fast above Slow, Price above Fast", "Uptrend with price leading", r(S("fast"), ">", S("slow")), r(P(), ">", S("fast"))),
      ];
    case "ribbon":
      return [
        preset("20 above 50 above 100 above 200", "Perfect bullish alignment", r(S("m20"), ">", S("m50")), r(S("m50"), ">", S("m100")), r(S("m100"), ">", S("m200"))),
        preset("20 below 50 below 100 below 200", "Perfect bearish alignment", r(S("m20"), "<", S("m50")), r(S("m50"), "<", S("m100")), r(S("m100"), "<", S("m200"))),
        preset("Price above all four", "Price above every average", r(P(), ">", S("m20")), r(P(), ">", S("m50")), r(P(), ">", S("m100")), r(P(), ">", S("m200"))),
        preset("50 crosses up 200", "Golden cross", r(S("m50"), "crossesAbove", S("m200"))),
        preset("50 crosses down 200", "Death cross", r(S("m50"), "crossesBelow", S("m200"))),
      ];
    case "guppy":
      return [
        preset("Short-term group above long-term group", "Traders and investors both bullish", r(S("ema15"), ">", S("ema30")), r(S("ema3"), ">", S("ema15"))),
        preset("Short-term group below long-term group", "Traders and investors both bearish", r(S("ema15"), "<", S("ema30")), r(S("ema3"), "<", S("ema15"))),
        preset("EMA 3 crosses up EMA 30", "Short-term trend turns up", r(S("ema3"), "crossesAbove", S("ema30"))),
      ];
    case "alligator":
      return [
        preset("Lips above Teeth above Jaw", "Alligator eating upwards: uptrend", r(S("lips"), ">", S("teeth")), r(S("teeth"), ">", S("jaw"))),
        preset("Lips below Teeth below Jaw", "Alligator eating downwards: downtrend", r(S("lips"), "<", S("teeth")), r(S("teeth"), "<", S("jaw"))),
        preset("Jaw below Price", "Price above the jaw", r(S("jaw"), "<", P())),
      ];
    case "volume":
      return [
        preset("Above its MA by 100% or more", "Volume spike: at least 2× average", r(S(), "abovePct", S("ma"), { min: 100 })),
        preset("Above its MA by 50% or more", "Heavy volume: 1.5× average", r(S(), "abovePct", S("ma"), { min: 50 })),
        preset("Above its MA", "Above-average volume", r(S(), ">", S("ma"))),
        preset("Below its MA by 50% or more", "Very quiet: half the average or less", r(S(), "belowPct", S("ma"), { min: 50 })),
        preset("Above its MA by 100% or more, Price up", "Volume spike on an up day", r(S(), "abovePct", S("ma"), { min: 100 }), r(P("close"), ">", P("open"))),
      ];
    case "pivots":
      return [
        preset("Price above P", "Bullish: above the pivot", r(P(), ">", S("p"))),
        preset("Price below P", "Bearish: below the pivot", r(P(), "<", S("p"))),
        preset("Price crosses up R1", "Breakout through first resistance", r(P(), "crossesAbove", S("r1"))),
        preset("Price crosses down S1", "Breakdown through first support", r(P(), "crossesBelow", S("s1"))),
        preset("R1 above Price by 0% to 1%", "Just under first resistance", r(S("r1"), "abovePct", P(), { min: 0, max: 1 })),
        preset("S1 below Price by 0% to 1%", "Just above first support", r(S("s1"), "belowPct", P(), { min: 0, max: 1 })),
        preset("Price above R2", "Strong breakout", r(P(), ">", S("r2"))),
      ];
    case "pdhl":
      return [
        preset("Price crosses up High", "Breaks the previous period's high", r(P(), "crossesAbove", S("high"))),
        preset("Price crosses down Low", "Breaks the previous period's low", r(P(), "crossesBelow", S("low"))),
        preset("Price above High", "Trading above the previous high", r(P(), ">", S("high"))),
        preset("Price below Low", "Trading below the previous low", r(P(), "<", S("low"))),
        preset("High above Price by 0% to 1%", "Just under the previous high", r(S("high"), "abovePct", P(), { min: 0, max: 1 })),
      ];
    default:
      return [];
  }
}

// A preset's rules as the screener's rule format, with "self" filled in from the chosen settings.
export function presetRules(p, id, params) {
  const fill = (o) => (o.kind === "self" ? { kind: "ind", id, params: { ...params }, output: o.output } : o);
  return p.rules.map((x) => ({ ...x, left: fill(x.left), right: fill(x.right) }));
}
