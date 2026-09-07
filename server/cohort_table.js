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
// tasks/cohort_reachability.cjs and the server, which is the same copy-then-drift bug
// that put the bridge-tag parser in two places — see tasks/bridge_tags.ps1.

// ── The boost stack, mirrored from server/index.js:1545-1555 ──────────────────
// A signal has exactly ONE setup, so only ONE setup bonus can ever apply: those are
// six independent `if`s on distinct string values of signalTf.setup. The best is
// SQUEEZE_BREAKOUT at +10 and it requires confirmed volume, which is the same
// condition the +5 volume boost needs, so +15 is jointly attainable.
const VOLUME_BOOST     = 5;
const BEST_SETUP_BOOST = 10;

// Deliberately 0, not 15.
//
// getLearningBoost (server/index.js:463) returns 0 until a setup has 5 CLOSED trades
// and can then add at most +/-15. So the learning engine can only ever amplify a
// cohort that is ALREADY firing — it cannot rescue a dead one, because the cohort
// needs trades to earn the boost and needs the boost to make trades.
const LEARNING_BOOST_WHEN_COLD = 0;

const MAX_BOOST = VOLUME_BOOST + BEST_SETUP_BOOST + LEARNING_BOOST_WHEN_COLD;

// Gold's daily-neutral-H4 cohorts are HARD CAPPED after every boost is applied and
// before the gate is tested (server/index.js:1710):
//
//   if (isDailyNeutralH4 && ticker === "GC=F" && confidence >= SIZING_BOOST_MIN_CONFIDENCE)
//     confidence = SIZING_BOOST_MIN_CONFIDENCE - 1;
//
// SIZING_BOOST_MIN_CONFIDENCE is 75 (index.js:1894), so their true ceiling is 74 no
// matter what the boost stack computes. Omitting this cap is how the first incident
// happened at all — capped at 74, floored at 75, 1131 steps and zero fires — and a
// reachability model that ignores it would print a false ALIVE on the exact case it
// exists to catch.
const GOLD_NEUTRAL_H4_CEILING = 74;

// Mirrors SPX_H4_ONLY_BLOCKED_FLOOR in server/index.js. A floor above the maximum
// attainable confidence, so a cohort held under it cannot fire at any legal gate —
// as opposed to one that merely falls short of the gate currently configured.
const BLOCKED_BY_DESIGN_FLOOR = 101;

// ── The cohort table, mirrored from server/index.js:1449-1523 ─────────────────
//
// `guards` are literals that MUST all still be present in server/index.js. They pin
// VALUES, not just identifiers: guarding on a bare `GOLD_SQUEEZE_MODERATE_CONFIDENCE`
// would still match after someone changed that constant from 70 to 75, and the table
// would report clean while being wrong.
//
// `ceilingCap` is an absolute post-boost ceiling where the engine imposes one.
// `usesDailyOnlyFloor` marks cohorts whose gate is raised by dailyOnlyMinConfidence
// (index.js:1718) rather than being confidenceThreshold alone.
const COHORTS = [
  { name: 'Daily+H4 agree, both STRONG',          base: 95, guards: ['confidence = 95'] },
  { name: 'Triple alignment, all STRONG',         base: 97, guards: ['allStrong ? 97 : 88'] },
  { name: 'Daily+H4 agree, one STRONG',           base: 88, guards: ['? 88 : 72'] },
  { name: 'Daily+H4 agree, both MODERATE',        base: 72, guards: ['? 88 : 72'] },
  {
    name: 'Gold daily-neutral-H4, MODERATE', base: 72,
    guards: ['daily.strength === "MODERATE" ? 72', 'const SIZING_BOOST_MIN_CONFIDENCE = 75'],
    ceilingCap: GOLD_NEUTRAL_H4_CEILING, usesDailyOnlyFloor: true,
  },
  {
    name: 'Gold daily-neutral-H4, STRONG', base: 70,
    guards: ['daily.strength === "STRONG"   ? 70', 'const SIZING_BOOST_MIN_CONFIDENCE = 75'],
    ceilingCap: GOLD_NEUTRAL_H4_CEILING, usesDailyOnlyFloor: true,
  },
  { name: 'Gold H4-only, STRONG',                 base: 68, guards: ['h4.strength === "STRONG" ? 68'] },
  {
    name: 'Gold H4-only, MODERATE + squeeze', base: 70,
    guards: ['const GOLD_SQUEEZE_MODERATE_CONFIDENCE = 70', 'daily.setup === "BB_SQUEEZE_WATCH"'],
  },
  { name: 'Gold H4-only, MODERATE non-squeeze',   base: 55, guards: ['const goldSqueezeModerate', ': 55;'] },
  { name: 'BTC H4-only, STRONG',                  base: 63, guards: ['h4.strength === "STRONG" ? 63'] },
  // Raised 50 -> 55 on 2026-08-28 to match Gold H4-only MODERATE non-squeeze above.
  // At 50 this was DEAD: 50 + the maximum +15 boost is 65 against gate 70. At 55 it
  // reaches exactly 70 at full boost. Evidence: cohort_walkforward 2026-08-28, 132
  // closed (largest slice in the table), +0.103 R/trade, 4/5 folds MOSTLY POSITIVE.
  { name: 'BTC H4-only, MODERATE',                base: 55, guards: ['h4.strength === "MODERATE" ? 55'] },
  // The `: 40` tails of the two H4-only ternaries. These were folded into the
  // "Daily fires, H4 disagrees" row until 2026-08-08, which hid them: they are
  // separate populations reached by a different branch. A table that does not name
  // a cohort cannot report it dead.
  //
  // CORRECTED 2026-08-28. This comment used to call BTC H4-only NONE "the
  // best-performing dead slice in the system" at +0.294 R/trade over n=38, 4/5 folds.
  // Re-measured on a grown sample it is +0.129 over 53 closed at 2 of 5 folds,
  // verdict UNSTABLE. The result DEGRADED as the sample grew, which is the normal
  // direction of travel and exactly why a measurement pasted into a comment goes
  // stale. It stays dead on purpose; re-read the harness output, never this line.
  // Guard string tracks the LIVE ternary tail, which became `? 55 : 40` when the
  // MODERATE base was raised on 2026-08-28. Left as `? 50 : 40` it silently failed
  // its own presence check and cohort_reachability printed
  // "(missing: h4.strength === "MODERATE" ? 50 : 40)" — the table quietly losing the
  // ability to verify itself against the engine, which is its only real job.
  { name: 'BTC H4-only, NONE',                    base: 40, guards: ['h4.strength === "MODERATE" ? 55 : 40'] },
  { name: 'Gold H4-only, NONE',                   base: 40, guards: ['h4.strength === "STRONG" ? 68'] },
  // BLOCKED BY MEASUREMENT, not by arithmetic — the distinction this table exists to
  // make. Every SPX H4-only slice is negative out of sample (tasks/cohort_walkforward.cjs,
  // 2026-08-11: STRONG -0.196 over 47, NONE -0.065 over 28, MODERATE -0.039 over 91).
  // The engine holds it under a floor of 101, above the maximum attainable confidence,
  // so it cannot fire at ANY legal gate rather than merely failing to reach 70.
  // Reported separately from DEAD so a deliberate block never lands in a findings
  // count that someone then learns to skim past.
  {
    name: 'SPX H4-only (any strength)', base: 45, blockedByDesign: true,
    guards: ['confidence = 45', 'const SPX_H4_ONLY_BLOCKED_FLOOR = 101',
             'isSpxH4Only ? SPX_H4_ONLY_BLOCKED_FLOOR'],
  },
  // Named for what it COVERS, not for one case of it. This is the fall-through: any
  // non-WAIT daily that matches no branch of the confidence chain keeps the
  // initialiser, base 40. Two distinct shapes land here, and the old label
  // 'Daily fires, H4 disagrees (non-Gold)' only mentioned the first:
  //   * daily fires and H4 DISAGREES
  //   * daily fires and H4 is NEUTRAL on a non-Gold instrument — the Gold-only
  //     branch above does not take it, and isH4Only does not either
  // The second is 48% of SP500's non-WAIT steps (1,363 of 2,811) and 1,054 of BTC's.
  // Reading the old name, it looked like that population had no row at all and the
  // tool was blind to it. It is not: the row was always here and always said DEAD.
  // A label narrower than its own coverage is how a correct table gets misread.
  { name: 'Daily fires, H4 neutral/disagrees (non-Gold)', base: 40, guards: ['daily.signal === "WAIT" ? 0 : 40'] },
];

// Rows sorted lowest base first, each labelled against the gate it actually faces.
//
//   FIRES AT BASE — clears its gate before any boost. NOT a promise that it fires:
//                   macro penalties are applied after this point and can total -30
//                   (DXY -10, VIX -8, Fear&Greed -7, cross-asset -12), so a base-72
//                   cohort can still finish below a gate of 70. Penalties only ever
//                   SUBTRACT, so they cannot rescue a DEAD row — the DEAD verdict is
//                   sound, the ALIVE labels are optimistic.
//   NEEDS BOOST   — reachable only with volume and/or setup quality.
//   DEAD          — cannot reach its gate even at maximum boost.
//
// `dailyOnlyMinConfidence` is the dashboard-settable floor that applies to the
// neutral-H4 cohorts only. Passing it matters: it is 0 today, but setting it to 80
// kills both Gold neutral-H4 cohorts, and a model measuring against
// confidenceThreshold alone would call them alive.
function computeReachability(gate, dailyOnlyMinConfidence = 0) {
  const threshold = Number(gate);
  if (!Number.isFinite(threshold)) {
    throw new TypeError(`computeReachability needs a finite gate, got ${gate}`);
  }
  const floor = Number(dailyOnlyMinConfidence);
  const dailyFloor = Number.isFinite(floor) && floor > 0 ? floor : 0;

  return COHORTS
    .map(cohort => {
      const effectiveGate = cohort.blockedByDesign
        // The engine holds these under a floor no confidence can reach, so the gate
        // they actually face is that floor and not the global threshold. Modelling
        // them against the threshold would report them DEAD-by-5-points and invite
        // exactly the base raise the measurement says not to make.
        ? BLOCKED_BY_DESIGN_FLOOR
        : cohort.usesDailyOnlyFloor
          ? Math.max(threshold, dailyFloor)
          : threshold;
      const uncapped = cohort.base + MAX_BOOST;
      const ceiling = Math.min(100, uncapped, cohort.ceilingCap ?? Infinity);
      return {
        ...cohort,
        effectiveGate,
        ceiling,
        // True when the engine's own post-boost cap, not the boost stack, is what
        // limits this cohort. Worth surfacing: it is invisible in the base number.
        cappedByEngine: cohort.ceilingCap !== undefined && cohort.ceilingCap < uncapped,
        // BLOCKED BY DESIGN is not a milder DEAD, it is a different fact. DEAD means
        // nobody chose this and the arithmetic did it; BLOCKED means it was measured
        // and refused. Collapsing them is what let a deliberate refusal sit in a
        // "5 cohorts cannot fire" list and read as four accidents plus one more.
        status: cohort.blockedByDesign ? 'BLOCKED (MEASURED)'
              : cohort.base >= effectiveGate ? 'FIRES AT BASE'
              : ceiling >= effectiveGate ? 'NEEDS BOOST'
              : 'DEAD',
        short: effectiveGate - ceiling,
        boostNeeded: effectiveGate - cohort.base,
      };
    })
    .sort((a, b) => a.base - b.base);
}

// Cohorts with a guard literal no longer present in server/index.js. Each returned
// row carries `missing` so the caller can say WHICH literal went stale.
function findTableDrift(indexSource) {
  if (typeof indexSource !== 'string') return [];
  return COHORTS
    .map(cohort => ({ cohort, missing: cohort.guards.filter(g => !indexSource.includes(g)) }))
    .filter(entry => entry.missing.length > 0)
    .map(entry => ({ ...entry.cohort, missing: entry.missing }));
}

module.exports = {
  VOLUME_BOOST,
  BEST_SETUP_BOOST,
  LEARNING_BOOST_WHEN_COLD,
  MAX_BOOST,
  GOLD_NEUTRAL_H4_CEILING,
  BLOCKED_BY_DESIGN_FLOOR,
  COHORTS,
  computeReachability,
  findTableDrift,
};
