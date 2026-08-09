'use strict';
/**
 * Candle Range Theory (CRT) and Accumulation / Manipulation / Distribution (AMD).
 *
 * Both describe the same underlying claim at different scales: price builds a
 * range, pushes beyond one edge to take the orders resting there, fails to hold
 * outside, then travels the other way. CRT is that story in three candles; AMD is
 * it across a window.
 *
 * BAR CONTRACT — identical to fvg.js: arrays are OLDEST-FIRST, and only
 * `highs`, `lows` and `closes` are available. The bridge sends no `opens` and no
 * timestamps (mt5_bridge.py `_rates_to_bars`), which shapes both detectors:
 *
 *   - CRT is defined here on close position rather than candle body colour,
 *     because body direction needs an open. Close-relative-to-range is the part
 *     of the model that carries the meaning anyway: the sweep must CLOSE back
 *     inside the range it violated.
 *
 *   - AMD is detected on a rolling BAR WINDOW, not a trading session. Without
 *     timestamps there is no way to know that an accumulation happened during
 *     Asia. The geometry is real; the session attribution is NOT, and every
 *     result carries sessionAligned:false so nothing downstream can quietly
 *     assume otherwise.
 *
 * Nothing here is measured on our own data. Same rule as FVG: no gate, no
 * confidence, no sizing until walk-forward says it earns a vote.
 */

const DEFAULT_MIN_SWEEP_RANGE_FRACTION = 0.05;  // sweep must clear the edge by this x avg range
const DEFAULT_MAX_CRT = 6;
const RANGE_SAMPLE_BARS = 20;

// AMD window defaults. 12 bars of build, then a sweep, then expansion.
const DEFAULT_AMD_WINDOW = 12;
const DEFAULT_AMD_MAX_RANGE_FRACTION = 0.8;  // accumulation must be TIGHT vs recent range
const DEFAULT_MAX_AMD = 4;

function averageBarRange(highs, lows, sampleSize) {
  const start = Math.max(0, highs.length - sampleSize);
  let total = 0, count = 0;
  for (let i = start; i < highs.length; i++) {
    const range = highs[i] - lows[i];
    if (Number.isFinite(range) && range >= 0) { total += range; count++; }
  }
  return count > 0 ? total / count : 0;
}

function seriesUsable(series, length) {
  return Array.isArray(series) && series.length === length
    && series.every(v => typeof v === "number" && Number.isFinite(v));
}

function validate(bars, minBars) {
  if (!bars || typeof bars !== "object") return "no bars";
  const { highs, lows, closes } = bars;
  if (!Array.isArray(highs) || !Array.isArray(lows) || !Array.isArray(closes)) return "highs/lows/closes required";
  const n = highs.length;
  if (!seriesUsable(highs, n) || !seriesUsable(lows, n) || !seriesUsable(closes, n)) return "series unusable or ragged";
  if (n < minBars) return "need at least " + minBars + " bars";
  return null;
}

/* ── CRT ──────────────────────────────────────────────────────
 * Three candles:
 *   c1 (i-2)  the RANGE. Its high and low are the liquidity edges.
 *   c2 (i-1)  the MANIPULATION. Trades beyond one edge of c1 and CLOSES back
 *             inside c1's range — the push failed to hold.
 *   c3 (i)    the DISTRIBUTION. Closes beyond c2's close, away from the swept
 *             side, confirming the reversal.
 *
 * Sweeping the HIGH and failing is bearish; sweeping the LOW and failing is
 * bullish. A candle that closes outside the range it violated is a breakout, not
 * a CRT, and is deliberately excluded.
 * ───────────────────────────────────────────────────────────── */
function detectCRT(bars, options) {
  const settings = options || {};
  const minSweep = Number.isFinite(settings.minSweepRangeFraction)
    ? settings.minSweepRangeFraction : DEFAULT_MIN_SWEEP_RANGE_FRACTION;
  const maxPatterns = Number.isFinite(settings.maxPatterns) ? settings.maxPatterns : DEFAULT_MAX_CRT;
  const requireConfirmation = settings.requireConfirmation !== false;

  const error = validate(bars, 3);
  if (error) return { patterns: [], totalFound: 0, error, averageRange: 0 };

  const { highs, lows, closes } = bars;
  const barCount = highs.length;
  const lastIndex = barCount - 1;
  const averageRange = averageBarRange(highs, lows, RANGE_SAMPLE_BARS);
  const minSweepDistance = averageRange * minSweep;

  const patterns = [];
  for (let i = 2; i < barCount; i++) {
    const rangeHigh = highs[i - 2];
    const rangeLow  = lows[i - 2];
    const rangeSize = rangeHigh - rangeLow;
    if (!(rangeSize > 0)) continue;

    const sweptHigh = highs[i - 1] > rangeHigh + minSweepDistance && closes[i - 1] < rangeHigh;
    const sweptLow  = lows[i - 1]  < rangeLow  - minSweepDistance && closes[i - 1] > rangeLow;
    // A candle cannot sweep both edges and still be a clean CRT — that is a
    // volatility expansion engulfing the range, a different animal entirely.
    if (sweptHigh === sweptLow) continue;

    const direction = sweptHigh ? "bearish" : "bullish";
    const confirmed = sweptHigh ? closes[i] < closes[i - 1] : closes[i] > closes[i - 1];
    if (requireConfirmation && !confirmed) continue;

    const sweepDistance = sweptHigh ? highs[i - 1] - rangeHigh : rangeLow - lows[i - 1];

    patterns.push({
      direction,
      sweptSide: sweptHigh ? "high" : "low",
      rangeHigh, rangeLow, rangeSize,
      rangeSizeInRanges: averageRange > 0 ? rangeSize / averageRange : null,
      sweepExtreme: sweptHigh ? highs[i - 1] : lows[i - 1],
      sweepDistance,
      sweepDistanceInRanges: averageRange > 0 ? sweepDistance / averageRange : null,
      confirmed,
      // The level the model says should now be traded toward.
      objective: sweptHigh ? rangeLow : rangeHigh,
      // Invalidation: back beyond the sweep extreme means the push did not fail.
      invalidation: sweptHigh ? highs[i - 1] : lows[i - 1],
      barIndex: i,
      barsAgo: lastIndex - i,
    });
  }

  patterns.sort((a, b) => a.barsAgo - b.barsAgo);
  return {
    patterns: patterns.slice(0, maxPatterns),
    totalFound: patterns.length,
    averageRange,
    barsScanned: barCount,
  };
}

/* ── AMD ──────────────────────────────────────────────────────
 * Across a window rather than three candles:
 *   ACCUMULATION  `window` bars whose whole span is TIGHT relative to the
 *                 instrument's recent average range
 *   MANIPULATION  the next bar takes out one side of that span and closes back
 *                 inside it
 *   DISTRIBUTION  the bar after closes beyond the opposite side of the span
 *
 * sessionAligned is ALWAYS false. Without bar timestamps this is a bar-window
 * pattern that has AMD's shape, not a verified Asia-accumulation / London-sweep /
 * NY-expansion sequence. Treating the two as the same thing would be the kind of
 * quiet substitution that makes a number untrustworthy.
 * ───────────────────────────────────────────────────────────── */
function detectAMD(bars, options) {
  const settings = options || {};
  const window = Number.isFinite(settings.window) && settings.window >= 3
    ? Math.floor(settings.window) : DEFAULT_AMD_WINDOW;
  const maxRangeFraction = Number.isFinite(settings.maxAccumulationRangeFraction)
    ? settings.maxAccumulationRangeFraction : DEFAULT_AMD_MAX_RANGE_FRACTION;
  const maxPatterns = Number.isFinite(settings.maxPatterns) ? settings.maxPatterns : DEFAULT_MAX_AMD;

  const error = validate(bars, window + 2);
  if (error) return { patterns: [], totalFound: 0, error, sessionAligned: false, averageRange: 0 };

  const { highs, lows, closes } = bars;
  const barCount = highs.length;
  const lastIndex = barCount - 1;
  const averageRange = averageBarRange(highs, lows, RANGE_SAMPLE_BARS);

  const patterns = [];
  // i indexes the DISTRIBUTION bar; the manipulation is i-1; accumulation is the
  // `window` bars ending at i-2.
  for (let i = window + 1; i < barCount; i++) {
    const accStart = i - 1 - window;
    const accEnd   = i - 2;
    let accHigh = -Infinity, accLow = Infinity;
    for (let k = accStart; k <= accEnd; k++) {
      if (highs[k] > accHigh) accHigh = highs[k];
      if (lows[k]  < accLow)  accLow  = lows[k];
    }
    const accRange = accHigh - accLow;
    if (!(accRange > 0)) continue;
    // Accumulation must actually be a consolidation. Without this any trending
    // stretch of bars qualifies and AMD "finds" a pattern everywhere.
    if (accRange > averageRange * window * maxRangeFraction) continue;

    const m = i - 1;
    const sweptHigh = highs[m] > accHigh && closes[m] < accHigh;
    const sweptLow  = lows[m]  < accLow  && closes[m] > accLow;
    if (sweptHigh === sweptLow) continue;

    const distributed = sweptHigh ? closes[i] < accLow : closes[i] > accHigh;
    if (!distributed) continue;

    patterns.push({
      direction: sweptHigh ? "bearish" : "bullish",
      sweptSide: sweptHigh ? "high" : "low",
      accumulationHigh: accHigh,
      accumulationLow: accLow,
      accumulationRange: accRange,
      accumulationBars: window,
      manipulationExtreme: sweptHigh ? highs[m] : lows[m],
      distributionClose: closes[i],
      objective: sweptHigh ? accLow - accRange : accHigh + accRange,
      invalidation: sweptHigh ? highs[m] : lows[m],
      barIndex: i,
      barsAgo: lastIndex - i,
      sessionAligned: false,
    });
  }

  patterns.sort((a, b) => a.barsAgo - b.barsAgo);
  return {
    patterns: patterns.slice(0, maxPatterns),
    totalFound: patterns.length,
    averageRange,
    barsScanned: barCount,
    // Surfaced at the top level too, so a consumer cannot miss it.
    sessionAligned: false,
    sessionNote: "Bar-window pattern. The bridge sends no timestamps, so this is "
      + "not verified against real trading sessions.",
  };
}

module.exports = {
  detectCRT,
  detectAMD,
  averageBarRange,
  DEFAULT_MIN_SWEEP_RANGE_FRACTION,
  DEFAULT_AMD_WINDOW,
};
