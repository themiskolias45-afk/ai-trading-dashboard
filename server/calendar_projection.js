// PROJECTED high-impact releases, so the system can see past the end of the weekly feed.
//
// WHY THIS EXISTS. ff_calendar_thisweek.json is the only calendar feed available - nextweek,
// lastweek and thismonth all 404 - so the real horizon is one week and it SHRINKS as the
// week runs. On a Thursday the system sees under a day ahead; from Friday evening through
// the weekend it sees nothing. That is not enough to answer "what is coming next week".
//
// The releases that actually create blackouts are not random: they are published on fixed
// calendar rules. Those rules are encoded here and projected forward.
//
// ── THE SAFETY PROPERTY, AND IT IS THE WHOLE DESIGN ──────────────────────────────────
// A PROJECTED EVENT MUST NEVER STOP A TRADE. These rows are never merged into newsCache,
// which is what isNewsBlackout() reads, so nothing here can gate an entry, move a
// threshold or suppress a setup. They are planning information and nothing else.
//
// The reason is simple: a projection is a guess about a date. A guess that blocks trading
// is a guess that costs money, silently, on a day nobody checks. A guess that only informs
// a plan costs nothing when it is wrong. Every row is stamped `projected: true` so no
// downstream reader can mistake one for an observation.
//
// ── HOW THEY CHECK THEMSELVES ────────────────────────────────────────────────────────
// Every projection that falls inside the period the accumulated store already covers is
// compared against it. If the real event is there, the projection is marked confirmed. If
// the store covers that date and the event is ABSENT, it is marked contradicted - which is
// how a rule that has drifted announces itself instead of quietly going wrong.
//
// Validated on real data before shipping (tasks/calendar_store.json, September 2026):
//   Non-Farm Employment Change, Average Hourly Earnings, Unemployment Rate
//     -> all three 2026-09-04 12:30 UTC, and 2026-09-04 is the first Friday. Rule holds.
//   ISM Manufacturing PMI
//     -> 2026-09-01 14:00 UTC, and 2026-09-01 is the first business day. Rule holds.

"use strict";

// A rule states WHEN, not WHETHER. Times are UTC and are the release times these series
// have used consistently; a change in the schedule shows up as `contradicted` rather than
// as a wrong answer nobody notices.
const RULES = [
  { titles: ["Non-Farm Employment Change", "Average Hourly Earnings m/m", "Unemployment Rate"],
    country: "USD", impact: "High", utcHour: 12, utcMinute: 30,
    when: "first-friday",
    rule: "US employment report: first Friday of the month, 12:30 UTC" },
  { titles: ["ISM Manufacturing PMI"],
    country: "USD", impact: "High", utcHour: 14, utcMinute: 0,
    when: "first-business-day",
    rule: "ISM Manufacturing PMI: first business day of the month, 14:00 UTC" },
];

function firstFridayUTC(year, monthIndex) {
  const d = new Date(Date.UTC(year, monthIndex, 1));
  while (d.getUTCDay() !== 5) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

function firstBusinessDayUTC(year, monthIndex) {
  const d = new Date(Date.UTC(year, monthIndex, 1));
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

// The window the observed store actually covers. A projection outside it cannot be checked,
// and saying so is the point - "unchecked" is a different claim from "confirmed".
function observedRange(storeEvents) {
  let min = null, max = null;
  for (const ev of storeEvents || []) {
    const t = Date.parse(ev.date);
    if (!Number.isFinite(t)) continue;
    if (min === null || t < min) min = t;
    if (max === null || t > max) max = t;
  }
  return { min, max };
}

/**
 * Project high-impact releases forward.
 *
 * @param {Array}  storeEvents  the accumulated real calendar, used ONLY to verify
 * @param {number} months       how many months ahead to project (default 3)
 * @returns {{projected: Array, horizonDays: number, confirmed: number, contradicted: number, unchecked: number, rules: Array}}
 */
function projectReleases(storeEvents, months) {
  const monthsAhead = Number.isFinite(months) ? months : 3;
  const now = new Date();
  const { min, max } = observedRange(storeEvents);
  const out = [];

  for (let m = 0; m <= monthsAhead; m++) {
    const cursor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + m, 1));
    const year = cursor.getUTCFullYear(), monthIndex = cursor.getUTCMonth();

    for (const spec of RULES) {
      const day = spec.when === "first-friday"
        ? firstFridayUTC(year, monthIndex)
        : firstBusinessDayUTC(year, monthIndex);
      const at = new Date(Date.UTC(year, monthIndex, day.getUTCDate(), spec.utcHour, spec.utcMinute));
      if (at.getTime() <= now.getTime()) continue;      // only ever forward-looking

      for (const title of spec.titles) {
        // Checked against what has actually been observed, where that is possible.
        let status = "unchecked";
        if (min !== null && at.getTime() >= min && at.getTime() <= max) {
          const seen = (storeEvents || []).some(ev =>
            String(ev.title || "").trim() === title &&
            Math.abs(Date.parse(ev.date) - at.getTime()) <= 60 * 60 * 1000);
          status = seen ? "confirmed" : "contradicted";
        }
        out.push({
          at: at.toISOString(), title, country: spec.country, impact: spec.impact,
          high: true, watched: true,
          // THE FLAG THAT KEEPS THIS SAFE. Never merged into newsCache; nothing that gates
          // a trade reads this array.
          projected: true,
          gatesNothing: true,
          rule: spec.rule,
          status,
        });
      }
    }
  }

  out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const furthest = out.length ? Date.parse(out[out.length - 1].at) : null;
  return {
    projected: out,
    horizonDays: furthest === null ? 0 : Math.round((furthest - now.getTime()) / 86400000 * 10) / 10,
    confirmed: out.filter(e => e.status === "confirmed").length,
    contradicted: out.filter(e => e.status === "contradicted").length,
    unchecked: out.filter(e => e.status === "unchecked").length,
    rules: RULES.map(r => r.rule),
  };
}

module.exports = { projectReleases, firstFridayUTC, firstBusinessDayUTC };
