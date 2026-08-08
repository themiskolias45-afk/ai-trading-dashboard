'use strict';

// Which signal cohorts can mathematically reach the confidence gate.
//
// This system encodes "this cohort has poor edge" as a LOW CONFIDENCE NUMBER rather
// than as an explicit block. That works right up until the gate moves. On 2026-08-02
// confidenceThreshold went 65 -> 70 and every per-asset base tuned against 65 was
// left untouched, so cohorts silently became unreachable and nothing said so.
//
// It has happened three times:
//   * Gold's neutral-H4 cohort capped at 74 under a floor of 75 — 1131 steps, 0 fires
//   * SPX H4-only, base 45, ceiling 60, against a 65 and then a 70 gate. The comment
//     beside it still reads "needs exceptional quality boosts to clear 65 gate" — it
//     could not clear 65 either.
//   * BTC H4-only MODERATE, base 50, ceiling 65: alive at gate 65, dead at gate 70.
//
// A dead cohort produces no trades, so it adds nothing to the journal, nothing to
// the learning table, and raises no error. It is indistinguishable from a quiet
// market, which is exactly how it was read for weeks.
//
// This file exists so the table has ONE home. It was briefly duplicated between
// tasks/cohort_reachability.cjs and the server, which is the same
// copy-then-drift bug that put the bridge-tag parser in two places and let one of
// them go stale — see tasks/bridge_tags.ps1.

// ── The boost stack, mirrored from server/index.js:1505-1527 ──────────────────
// A signal has exactly ONE setup, so only ONE setup bonus can ever apply. The best
// available is SQUEEZE_BREAKOUT at +10, and it requires confirmed volume, which is
// the same condition the +5 volume boost needs. Best case is therefore +15, and it
// requires a SQUEEZE_BREAKOUT on confirmed volume.
const VOLUME_BOOST     = 5;
const BEST_SETUP_BOOST = 10;

// Deliberately 0, not 15.
//
// getLearningBoost (server/index.js:460) returns 0 until a setup has 5 CLOSED trades
// and can then add at most +/-15. So the learning engine can only ever amplify a
// cohort that is ALREADY firing — it cannot rescue a dead one, because the cohort
// needs trades to earn the boost and needs the boost to make trades. Any reachability
// maths that counts on the learning boost is wrong.
const LEARNING_BOOST_WHEN_COLD = 0;

const MAX_BOOST = VOLUME_BOOST + BEST_SETUP_BOOST + LEARNING_BOOST_WHEN_COLD;

// ── The cohort table, mirrored from server/index.js:1404-1484 ─────────────────
// `guard` is a literal that MUST still be present in server/index.js. If someone
// retunes a base confidence and forgets this table, the drift check reports it
// rather than letting the audit quietly describe a system that no longer exists.
const COHORTS = [
  { name: 'Daily+H4 agree, both STRONG',          base: 95, guard: 'confidence = 95' },
  { name: 'Triple alignment, all STRONG',         base: 97, guard: 'allStrong ? 97 : 88' },
  { name: 'Daily+H4 agree, one STRONG',           base: 88, guard: '? 88 : 72' },
  { name: 'Daily+H4 agree, both MODERATE',        base: 72, guard: '? 88 : 72' },
  { name: 'Gold daily-neutral-H4, MODERATE',      base: 72, guard: 'daily.strength === "MODERATE" ? 72' },
  { name: 'Gold daily-neutral-H4, STRONG',        base: 70, guard: 'daily.strength === "STRONG"   ? 70' },
  { name: 'Gold H4-only, STRONG',                 base: 68, guard: 'h4.strength === "STRONG" ? 68' },
  { name: 'Gold H4-only, MODERATE + squeeze',     base: 70, guard: 'GOLD_SQUEEZE_MODERATE_CONFIDENCE' },
  { name: 'Gold H4-only, MODERATE non-squeeze',   base: 55, guard: ': 55;' },
  { name: 'BTC H4-only, STRONG',                  base: 63, guard: 'h4.strength === "STRONG" ? 63' },
  { name: 'BTC H4-only, MODERATE',                base: 50, guard: 'h4.strength === "MODERATE" ? 50' },
  { name: 'SPX H4-only (any strength)',           base: 45, guard: 'confidence = 45' },
  { name: 'Daily fires, H4 disagrees (non-Gold)', base: 40, guard: 'daily.signal === "WAIT" ? 0 : 40' },
];

// Rows sorted lowest base first, each labelled against the supplied gate.
//   FIRES AT BASE — clears the gate with no help at all
//   NEEDS BOOST   — reachable, but only with volume and/or setup quality
//   DEAD          — cannot reach the gate even at maximum boost
function computeReachability(gate) {
  const threshold = Number(gate);
  if (!Number.isFinite(threshold)) {
    throw new TypeError(`computeReachability needs a finite gate, got ${gate}`);
  }
  return COHORTS
    .map(cohort => {
      const ceiling = Math.min(100, cohort.base + MAX_BOOST);
      return {
        ...cohort,
        ceiling,
        status: cohort.base >= threshold ? 'FIRES AT BASE'
              : ceiling >= threshold ? 'NEEDS BOOST'
              : 'DEAD',
        // How far the ceiling falls short. Only meaningful when DEAD.
        short: threshold - ceiling,
        // How much boost is required to clear the gate. Only meaningful when
        // NEEDS BOOST. Above BEST_SETUP_BOOST means it needs the setup bonus AND
        // confirmed volume together, i.e. a perfect storm.
        boostNeeded: threshold - cohort.base,
      };
    })
    .sort((a, b) => a.base - b.base);
}

// Cohorts named in this table whose guard literal is no longer in server/index.js.
function findTableDrift(indexSource) {
  if (typeof indexSource !== 'string') return [];
  return COHORTS.filter(cohort => !indexSource.includes(cohort.guard));
}

module.exports = {
  VOLUME_BOOST,
  BEST_SETUP_BOOST,
  LEARNING_BOOST_WHEN_COLD,
  MAX_BOOST,
  COHORTS,
  computeReachability,
  findTableDrift,
};
