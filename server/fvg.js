'use strict';
/**
 * Fair Value Gap (FVG) detection.
 *
 * An FVG is a three-candle imbalance: price moved far enough in one candle that
 * the wicks either side never overlap, leaving a band of prices that was skipped
 * rather than traded through.
 *
 *   Bullish FVG   lows[i] > highs[i-2]      gap = highs[i-2] .. lows[i]
 *   Bearish FVG   highs[i] < lows[i-2]      gap = highs[i]   .. lows[i-2]
 *
 * Candle i-1 is the displacement candle; the gap belongs to the range between
 * candle i-2 and candle i, which is why only highs and lows are needed and opens
 * and closes are irrelevant here.
 *
 * BAR ORDER IS OLDEST-FIRST. mt5_bridge.py builds these from
 * copy_rates_from_pos(), which returns ascending time, and server/index.js reads
 * the live price as closes[closes.length - 1]. Reversed input would invert every
 * zone and silently mislabel bullish as bearish, so the order is asserted by the
 * test suite rather than assumed.
 *
 * Pure functions only — no I/O, no clock, no globals. Everything needed to judge
 * a zone is derived from the bars passed in.
 */

// A gap smaller than a fraction of normal bar range is noise, not an imbalance.
// Scaled off the instrument's own recent range rather than a price percentage,
// because BTC, Gold and SPX have wildly different absolute ranges.
const DEFAULT_MIN_GAP_RANGE_FRACTION = 0.25;
const RANGE_SAMPLE_BARS = 20;
const DEFAULT_MAX_ZONES = 6;

const STATUS_FRESH   = "FRESH";
const STATUS_PARTIAL = "PARTIAL";
const STATUS_FILLED  = "FILLED";

/** Mean high-low range over the last `sampleSize` bars. The noise floor. */
function averageBarRange(highs, lows, sampleSize) {
  const start = Math.max(0, highs.length - sampleSize);
  let total = 0;
  let count = 0;
  for (let i = start; i < highs.length; i++) {
    const range = highs[i] - lows[i];
    if (Number.isFinite(range) && range >= 0) { total += range; count++; }
  }
  return count > 0 ? total / count : 0;
}

/**
 * suffixMinLow[i]  = lowest low  across bars i..end  (+Infinity past the end)
 * suffixMaxHigh[i] = highest high across bars i..end (-Infinity past the end)
 *
 * Lets each zone be tested for fill in O(1). The obvious implementation walks
 * forward from every gap, which is O(n^2) — 400 bars x 3 timeframes x 3 assets on
 * every poll is enough to notice.
 */
function buildSuffixExtremes(highs, lows) {
  const barCount = highs.length;
  const suffixMinLow  = new Array(barCount + 1);
  const suffixMaxHigh = new Array(barCount + 1);
  suffixMinLow[barCount]  = Infinity;
  suffixMaxHigh[barCount] = -Infinity;
  for (let i = barCount - 1; i >= 0; i--) {
    suffixMinLow[i]  = Math.min(lows[i],  suffixMinLow[i + 1]);
    suffixMaxHigh[i] = Math.max(highs[i], suffixMaxHigh[i + 1]);
  }
  return { suffixMinLow, suffixMaxHigh };
}

/**
 * How far price has eaten into a zone since it formed.
 * Returns { status, fillPercent } with fillPercent 0..1.
 */
function judgeFill(direction, gapBottom, gapTop, deepestLowAfter, highestHighAfter) {
  const height = gapTop - gapBottom;
  if (!(height > 0)) return { status: STATUS_FILLED, fillPercent: 1 };

  if (direction === "bullish") {
    // A bullish gap sits below price and is filled by trading back DOWN into it.
    if (deepestLowAfter <= gapBottom) return { status: STATUS_FILLED, fillPercent: 1 };
    if (deepestLowAfter <  gapTop) {
      return { status: STATUS_PARTIAL, fillPercent: (gapTop - deepestLowAfter) / height };
    }
    return { status: STATUS_FRESH, fillPercent: 0 };
  }
  // A bearish gap sits above price and is filled by trading back UP into it.
  if (highestHighAfter >= gapTop) return { status: STATUS_FILLED, fillPercent: 1 };
  if (highestHighAfter >  gapBottom) {
    return { status: STATUS_PARTIAL, fillPercent: (highestHighAfter - gapBottom) / height };
  }
  return { status: STATUS_FRESH, fillPercent: 0 };
}

/**
 * Detect unfilled and partially filled FVGs in one bar series.
 *
 * @param {{highs:number[], lows:number[], closes:number[]}} bars oldest-first
 * @param {object} [options]
 * @param {number} [options.minGapRangeFraction] gap must exceed this x average bar range
 * @param {number} [options.maxZones] cap on returned zones, most recent first
 * @param {boolean} [options.includeFilled] keep fully mitigated zones (default false)
 * @returns {{zones:Array, averageRange:number, minGapSize:number, barsScanned:number, error?:string}}
 */
function detectFVGs(bars, options) {
  const settings = options || {};
  const minGapRangeFraction = Number.isFinite(settings.minGapRangeFraction)
    ? settings.minGapRangeFraction : DEFAULT_MIN_GAP_RANGE_FRACTION;
  const maxZones = Number.isFinite(settings.maxZones) ? settings.maxZones : DEFAULT_MAX_ZONES;
  const includeFilled = settings.includeFilled === true;

  const empty = { zones: [], averageRange: 0, minGapSize: 0, barsScanned: 0 };

  if (!bars || typeof bars !== "object") return Object.assign({}, empty, { error: "no bars" });
  const { highs, lows, closes } = bars;
  const seriesOk = series => Array.isArray(series) && series.every(v => typeof v === "number" && Number.isFinite(v));
  if (!seriesOk(highs) || !seriesOk(lows)) return Object.assign({}, empty, { error: "highs/lows unusable" });
  if (highs.length !== lows.length)        return Object.assign({}, empty, { error: "highs/lows length mismatch" });
  // Three candles are the minimum that can define a gap.
  if (highs.length < 3)                    return Object.assign({}, empty, { error: "need at least 3 bars" });

  const barCount    = highs.length;
  const lastIndex   = barCount - 1;
  const averageRange = averageBarRange(highs, lows, RANGE_SAMPLE_BARS);
  const minGapSize   = averageRange * minGapRangeFraction;
  const currentPrice = seriesOk(closes) && closes.length === barCount ? closes[lastIndex] : null;
  const { suffixMinLow, suffixMaxHigh } = buildSuffixExtremes(highs, lows);

  const zones = [];
  for (let i = 2; i < barCount; i++) {
    let direction = null;
    let gapBottom = 0;
    let gapTop    = 0;

    if (lows[i] > highs[i - 2])       { direction = "bullish"; gapBottom = highs[i - 2]; gapTop = lows[i]; }
    else if (highs[i] < lows[i - 2])  { direction = "bearish"; gapBottom = highs[i];     gapTop = lows[i - 2]; }
    else continue;

    const height = gapTop - gapBottom;
    // Noise floor. Without it a quiet series yields dozens of one-tick "gaps".
    if (!(height > minGapSize)) continue;

    const fill = judgeFill(direction, gapBottom, gapTop, suffixMinLow[i + 1], suffixMaxHigh[i + 1]);
    if (fill.status === STATUS_FILLED && !includeFilled) continue;

    const midpoint = (gapTop + gapBottom) / 2;
    zones.push({
      direction,
      bottom: gapBottom,
      top: gapTop,
      midpoint,
      height,
      // Multiples of a normal bar's range — comparable across instruments.
      heightInRanges: averageRange > 0 ? height / averageRange : null,
      status: fill.status,
      fillPercent: fill.fillPercent,
      barIndex: i,
      barsAgo: lastIndex - i,
      // Where price stands relative to the zone right now.
      distancePct: currentPrice != null && currentPrice !== 0
        ? ((midpoint - currentPrice) / currentPrice) * 100 : null,
      priceInside: currentPrice != null && currentPrice >= gapBottom && currentPrice <= gapTop,
    });
  }

  // Most recent first: a fresh gap three bars back matters more than one from 200.
  zones.sort((a, b) => a.barsAgo - b.barsAgo);

  return {
    zones: zones.slice(0, maxZones),
    totalFound: zones.length,
    averageRange,
    minGapSize,
    barsScanned: barCount,
  };
}

module.exports = {
  detectFVGs,
  averageBarRange,
  buildSuffixExtremes,
  judgeFill,
  STATUS_FRESH,
  STATUS_PARTIAL,
  STATUS_FILLED,
  DEFAULT_MIN_GAP_RANGE_FRACTION,
};
