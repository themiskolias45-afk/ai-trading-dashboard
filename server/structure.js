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

// How many bars the DISTRIBUTION leg may take to close beyond the far side of the
// accumulation range.
//
// This was hardcoded to 1 and that is why AMD "did not exist" in this market. Measured
// 2026-08-28 over the full broker archive, the funnel on GOLD H4 reads:
//
//     7,844 windows -> 7,838 tight enough -> 1,092 clean SWEEPS -> 9 patterns
//
// The tightness filter discards 0.08%. The sweep test does real work at 14%. Requiring
// the markdown to complete inside ONE bar then threw away 99.2% of genuine sweeps —
// 1,092 down to 9 across five years. A pattern found nine times cannot be learned from,
// measured, or argued about; it is absent by construction rather than by market.
//
// Distribution is a PHASE, not a bar. Allowing it a few bars is what the pattern
// actually describes. Counts at this default: GOLD H4 9 -> 70, BTC 18 -> 108,
// SPX 13 -> 76 — enough to finally put a number on whether AMD predicts anything.
//
// 5 is a JUDGEMENT, not a measurement: under half the 12-bar accumulation window, so the
// markdown still has to be decisive rather than a slow drift. It is an option precisely
// so the sweep can be re-run at other values once there is an edge test to run.
//
// SAFE BY CONSTRUCTION: detectAMD has no production caller — only structure.test.js —
// and CLAUDE.md records AMD as observability that feeds no gate, no confidence and no
// sizing. Loosening detection cannot admit, suppress or alter a single trade.
const DEFAULT_AMD_DISTRIBUTION_BARS = 5;

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
 * SESSION ALIGNMENT. This used to be impossible: the note here said the bridge sent
 * no timestamps, so every pattern was a bar-window shape rather than a verified
 * Asia-accumulation / London-sweep / NY-expansion sequence. That stopped being true on
 * 2026-08-09, when mt5_bridge.py started sending bar OPEN times, and nothing here was
 * updated to use them — so the block outlived its cause by three days and the evidence
 * register still described it as unmeasurable.
 *
 * When `bars.times` is present each phase is now tagged with the session it actually
 * happened in, and `classicAMD` marks the textbook sequence: accumulation in ASIA,
 * the sweep in LONDON, distribution in NEW YORK. Without times the behaviour is
 * exactly as before — sessionAligned:false and no session fields — because a pattern
 * that quietly claims a session it cannot know is worse than one that admits it.
 * ───────────────────────────────────────────────────────────── */

// The system's own UTC session boundaries, matching get_time_context, so a session
// named here means the same thing as a session named anywhere else in the project.
const SESSION_BOUNDS = [
  ["ASIAN",       22, 7],
  ["PRE-LONDON",   7, 9],
  ["LONDON",       9, 12],
  ["OVERLAP",     12, 13],
  ["NEW YORK",    13, 17],
  ["AFTER HOURS", 17, 22],
];

// The coarse three the AMD narrative is actually told in. LONDON here spans
// pre-London through the overlap, and NEW YORK runs to the Asian open, because the
// classic sequence is about which desk is active, not about the finer labels above.
const MACRO_BOUNDS = [
  ["ASIA",     22, 7],
  ["LONDON",    7, 13],
  ["NEW YORK", 13, 22],
];

// Bar times arrive as UNIX SECONDS from the bridge. Read as milliseconds they land in
// 1970 and every session tag would be wrong but plausible. Any real ms epoch after
// 1973 exceeds 1e11; a seconds epoch does not reach it until the year 5138.
const MS_EPOCH_FLOOR = 1e11;

function hourOf(t) {
  if (!Number.isFinite(t)) return null;
  const date = new Date(t < MS_EPOCH_FLOOR ? t * 1000 : t);
  const year = date.getUTCFullYear();
  if (year < 2000 || year > 2100) return null;
  return date.getUTCHours();
}

function inBand(hour, from, to) {
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}

function sessionOf(t, bands) {
  const hour = hourOf(t);
  if (hour === null) return null;
  const found = bands.find(([, from, to]) => inBand(hour, from, to));
  return found ? found[0] : null;
}

/**
 * Are these timestamps usable? One per bar, all readable, or none of it is trusted.
 * A partially-valid array is refused rather than half-used: a pattern tagged from a
 * gap in the series would be confidently mislabelled, which is the failure this whole
 * block exists to avoid.
 */
function usableTimes(bars) {
  const times = bars && bars.times;
  if (!Array.isArray(times) || times.length !== bars.highs.length) return null;
  for (const t of times) if (hourOf(t) === null) return null;
  return times;
}
function detectAMD(bars, options) {
  const settings = options || {};
  const window = Number.isFinite(settings.window) && settings.window >= 3
    ? Math.floor(settings.window) : DEFAULT_AMD_WINDOW;
  const maxRangeFraction = Number.isFinite(settings.maxAccumulationRangeFraction)
    ? settings.maxAccumulationRangeFraction : DEFAULT_AMD_MAX_RANGE_FRACTION;
  const maxPatterns = Number.isFinite(settings.maxPatterns) ? settings.maxPatterns : DEFAULT_MAX_AMD;
  // >= 1 keeps the old single-bar behaviour reachable by passing 1 explicitly.
  const distributionBars = Number.isFinite(settings.distributionBars) && settings.distributionBars >= 1
    ? Math.floor(settings.distributionBars) : DEFAULT_AMD_DISTRIBUTION_BARS;

  const error = validate(bars, window + 2);
  if (error) return { patterns: [], totalFound: 0, error, sessionAligned: false, averageRange: 0 };

  const { highs, lows, closes } = bars;
  const barCount = highs.length;
  const lastIndex = barCount - 1;
  const averageRange = averageBarRange(highs, lows, RANGE_SAMPLE_BARS);
  const times = usableTimes(bars);

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

    // The markdown may take up to `distributionBars` bars to close beyond the far edge.
    // `distIndex` is the bar that actually completed it, so barsAgo and distributionClose
    // below describe the real completion rather than the first candidate bar.
    let distIndex = -1;
    for (let d = i; d < Math.min(i + distributionBars, barCount); d++) {
      if (sweptHigh ? closes[d] < accLow : closes[d] > accHigh) { distIndex = d; break; }
    }
    if (distIndex < 0) continue;

    const pattern = {
      direction: sweptHigh ? "bearish" : "bullish",
      sweptSide: sweptHigh ? "high" : "low",
      accumulationHigh: accHigh,
      accumulationLow: accLow,
      accumulationRange: accRange,
      accumulationBars: window,
      manipulationExtreme: sweptHigh ? highs[m] : lows[m],
      // The bar that actually completed the markdown, not the first one that could have.
      distributionClose: closes[distIndex],
      // How long the markdown took. 1 is the old hardcoded behaviour; anything above it
      // is a pattern this detector could not previously see at all, so it is worth
      // carrying rather than hiding — a later edge test may well find the fast ones
      // behave differently from the slow ones.
      distributionBarsTaken: distIndex - i + 1,
      objective: sweptHigh ? accLow - accRange : accHigh + accRange,
      invalidation: sweptHigh ? highs[m] : lows[m],
      barIndex: distIndex,
      barsAgo: lastIndex - distIndex,
      sessionAligned: Boolean(times),
    };

    if (times) {
      // Which desk was actually active for each phase. The accumulation window can
      // straddle sessions, so it reports the session it STARTED in plus whether it
      // stayed there — a window labelled "ASIA" that spent half its bars in London is
      // the sort of quiet half-truth that makes a pattern library untrustworthy.
      const accSessions = new Set();
      for (let k = accStart; k <= accEnd; k++) accSessions.add(sessionOf(times[k], MACRO_BOUNDS));
      const accMacro = sessionOf(times[accStart], MACRO_BOUNDS);
      const manipMacro = sessionOf(times[m], MACRO_BOUNDS);
      const distMacro = sessionOf(times[i], MACRO_BOUNDS);

      pattern.accumulationSession   = sessionOf(times[accStart], SESSION_BOUNDS);
      pattern.manipulationSession   = sessionOf(times[m], SESSION_BOUNDS);
      pattern.distributionSession   = sessionOf(times[i], SESSION_BOUNDS);
      pattern.accumulationMacro     = accMacro;
      pattern.manipulationMacro     = manipMacro;
      pattern.distributionMacro     = distMacro;
      pattern.accumulationSpansSessions = accSessions.size > 1;
      pattern.manipulationTimeUtc   = new Date(
        times[m] < MS_EPOCH_FLOOR ? times[m] * 1000 : times[m]).toISOString();
      // The textbook sequence, and the only one that earns the name: the range builds
      // in Asia, London sweeps a side of it, New York expands away. Anything else is a
      // real AMD shape that simply did not happen on that schedule.
      pattern.classicAMD = accMacro === "ASIA" && manipMacro === "LONDON" && distMacro === "NEW YORK";
    }

    patterns.push(pattern);
  }

  patterns.sort((a, b) => a.barsAgo - b.barsAgo);
  const kept = patterns.slice(0, maxPatterns);
  return {
    patterns: kept,
    totalFound: patterns.length,
    averageRange,
    barsScanned: barCount,
    // Surfaced at the top level too, so a consumer cannot miss it.
    sessionAligned: Boolean(times),
    // Counted over EVERY pattern found, not just the ones returned: maxPatterns is a
    // display cap, and a ratio computed off a truncated list would drift with it.
    classicCount: times ? patterns.filter(p => p.classicAMD).length : 0,
    sessionNote: times
      ? "Session-aligned against bar open times. classicAMD marks accumulation in "
        + "ASIA, the sweep in LONDON and distribution in NEW YORK; the rest are real "
        + "AMD shapes that did not happen on that schedule."
      : "Bar-window pattern. No usable bar times were supplied, so this is NOT "
        + "verified against real trading sessions.",
  };
}

module.exports = {
  detectCRT,
  detectAMD,
  averageBarRange,
  DEFAULT_MIN_SWEEP_RANGE_FRACTION,
  DEFAULT_AMD_WINDOW,
};
