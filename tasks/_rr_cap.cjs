'use strict';
/**
 * THE IMPLAUSIBLE-R CAP — one number, one place, for every harness that scores an R.
 *
 * WHY IT EXISTS. A collapsed stop distance produces an arithmetically enormous R that no
 * trade could ever have realised, and a single such row can set the SIGN of a whole
 * table. It has happened three times in this project and each time it was caught by
 * someone squinting at an outlier rather than by a check:
 *
 *   - the rejection ledger read +260.80R across 476 resolved episodes; capped, it reads
 *     -40.91R. The worst row was a $4.21 stop on Bitcoin — inside the spread — carrying
 *     +298.56R on its own.
 *   - the first RSI-ceiling sweep reported 64/60 as a +63.5R challenger. One row with
 *     rr 49.71 supplied +39.7R of that; capped, the same candidate scores +23.8R, BELOW
 *     the baseline it appeared to beat.
 *   - `realizedRFromPrices` in server/index.js already refuses anything past this number,
 *     which is the point: a harness that scores what the live engine would never record
 *     is not measuring the live engine.
 *
 * MEASURED BLAST RADIUS, 2026-08-22. Across the full 769-row MTF replay population there
 * is exactly ONE winning row above the cap (SP500, conf 40, rr 23.85, MOMENTUM). At every
 * gate the system actually uses — 50 through 85 — applying this cap changes nothing at
 * all. It only bites at the conf-40 exposure floor, where it trims 13.85R, 3.02% of gross
 * win. So this is a guard against the NEXT sweep, not a correction to the current one:
 * the ceiling sweep proved a candidate that admits different rows can surface exactly
 * such a row, and by then the wrong answer is already in a report.
 *
 * A LOSS IS NEVER CAPPED. Math.min leaves -1 as -1. The cap is a ceiling on implausible
 * GAIN, and clamping the downside would flatter every result it touched.
 */

// The engine's own number. If server/index.js ever changes MAX_PLAUSIBLE_RR, this must
// move with it or the harnesses start scoring trades the engine would refuse to record.
const MAX_PLAUSIBLE_RR = 10;

/**
 * Clamp one R to what the live engine would accept.
 * Non-finite input returns 0 rather than propagating NaN through a sum — a single
 * undefined rr would otherwise turn an entire table into NaN, which reads as a broken
 * harness rather than as one bad row.
 */
function cappedRr(rr) {
  const value = Number(rr);
  if (!Number.isFinite(value)) return 0;
  return Math.min(value, MAX_PLAUSIBLE_RR);
}

module.exports = { MAX_PLAUSIBLE_RR, cappedRr };
