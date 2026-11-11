// NSE trading-session guard for the Entry Timer: holidays plus a configurable no-entries-before /
// no-entries-after window (IST). Consulted only when an entry alert is armed — the generic alert
// engine (alerts.js) is never touched, so this has zero effect on existing alerts.

// NSE trading holidays. Update yearly from nseindia.com/resources/exchange-communication-holidays.
const HOLIDAYS = new Set([
  // 2026
  "2026-01-26", "2026-02-17", "2026-03-04", "2026-03-21", "2026-04-03", "2026-04-14",
  "2026-05-01", "2026-08-15", "2026-08-27", "2026-10-02", "2026-10-21", "2026-11-09",
  "2026-12-25",
]);

function istParts(t) {
  const ist = new Date(t + 5.5 * 3600e3);
  return {
    date: ist.toISOString().slice(0, 10),
    day: ist.getUTCDay(),
    mins: ist.getUTCHours() * 60 + ist.getUTCMinutes(),
  };
}

export function isTradingDay(t = Date.now()) {
  const { date, day } = istParts(t);
  return day >= 1 && day <= 5 && !HOLIDAYS.has(date);
}

// Default window: no entries in the first 15 minutes (noisy) or after 3:00 PM (too close to
// square-off). `config` can override with { no_entries_before: "09:45", no_entries_after: "15:00" }.
export function isEntryWindowOpen(t = Date.now(), config = {}) {
  if (!isTradingDay(t)) return { open: false, reason: "Not a trading day (weekend or NSE holiday)." };
  const { mins } = istParts(t);
  const toMins = (hhmm, fallback) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || "");
    return m ? Number(m[1]) * 60 + Number(m[2]) : fallback;
  };
  const before = toMins(config.no_entries_before, 9 * 60 + 45);
  const after = toMins(config.no_entries_after, 15 * 60);
  if (mins < before) return { open: false, reason: `No entries before ${config.no_entries_before || "09:45"} IST.` };
  if (mins > after) return { open: false, reason: `No entries after ${config.no_entries_after || "15:00"} IST.` };
  return { open: true };
}
