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

/* ─────────────────────────────────────────────────────────────
 * INTERPRETATION — what a zone actually means for the trade on the table.
 *
 * Detection alone is decoration. A list of price bands changes no decision
 * unless something states how it bears on the entry, the stop and the target
 * that the engine has already published. This section is that statement.
 *
 * Two established and genuinely competing behaviours are modelled, and neither
 * is treated as settled fact:
 *
 *   MAGNET     an unfilled gap is skipped price. Markets tend to revisit it, so
 *              an unfilled zone is a plausible destination.
 *   BARRIER    when price arrives back at a gap it often reacts, because the
 *              gap marks where one side moved with force. A bullish gap below
 *              price reads as support; a bearish gap above reads as resistance.
 *
 * They pull in opposite directions on purpose — a zone ahead of your target is
 * both a reason price might travel there and a reason it might stall on the way.
 * The reading reports both rather than pretending one wins.
 *
 * NOTHING HERE IS MEASURED on our own data yet. Every verdict is advisory and
 * carries `measured:false`. It must not feed confidence, the gate or sizing
 * until walk-forward says it earns a vote.
 * ───────────────────────────────────────────────────────────── */

// A stop sitting inside an unfilled gap is the one structural warning here that
// costs money rather than opportunity: the reaction that the zone predicts is
// exactly what takes the stop out before the trade can work.
const VERDICT_NO_SIGNAL   = "NO SIGNAL";
const VERDICT_STOP_IN_GAP = "STOP INSIDE A GAP";
const VERDICT_ENTRY_INTO  = "ENTRY INTO OPPOSING ZONE";
const VERDICT_OBSTRUCTED  = "PATH OBSTRUCTED";
const VERDICT_CLEAR       = "PATH CLEAR";

function zoneContains(zone, price) {
  return price >= zone.bottom && price <= zone.top;
}

/** Zones ordered by how close they sit to `price`, nearest first. */
function byProximity(zones, price) {
  return zones.slice().sort((a, b) =>
    Math.abs(a.midpoint - price) - Math.abs(b.midpoint - price));
}

/**
 * Describe the landscape when there is no live trade — which is most of the
 * time. "12 unfilled zones" says nothing; "3 unfilled bearish zones overhead,
 * nearest +1.09%" is something you can act on.
 */
function describeLandscape(zones, price) {
  const above = zones.filter(z => z.bottom > price);
  const below = zones.filter(z => z.top < price);
  const nearestAbove = byProximity(above, price)[0] || null;
  const nearestBelow = byProximity(below, price)[0] || null;
  const inside = zones.filter(z => zoneContains(z, price));
  return {
    countAbove: above.length,
    countBelow: below.length,
    nearestAbove,
    nearestBelow,
    inside,
    // Which side holds more unfilled space. Not a forecast — a description of
    // where the skipped price sits.
    lean: above.length === below.length ? "BALANCED"
        : above.length > below.length ? "MORE UNFILLED ABOVE" : "MORE UNFILLED BELOW",
  };
}

/**
 * Read the zones against the engine's current signal.
 *
 * @param {object|null} signal a /api/signals entry: needs signal, entry, stop, target, price
 * @param {Array} zones        detectFVGs() output for the timeframe being read
 * @returns {object} reading — always safe to render, never throws on partial input
 */
function interpretZones(signal, zones) {
  const usable = Array.isArray(zones) ? zones : [];
  const price = signal && Number.isFinite(signal.price) ? signal.price : null;

  const base = {
    measured: false,
    verdict: VERDICT_NO_SIGNAL,
    headline: "",
    notes: [],
    obstructions: [],
    support: [],
    entryZone: null,
    stopZone: null,
    magnet: null,
    landscape: price != null ? describeLandscape(usable, price) : null,
  };

  if (price == null) {
    base.headline = "No price available.";
    return base;
  }

  const direction = signal.signal;
  const isBuy  = direction === "BUY";
  const isSell = direction === "SELL";

  // ── No live trade: describe where the skipped price sits ────────────────
  if (!isBuy && !isSell) {
    const land = base.landscape;
    const parts = [];
    if (land.inside.length) {
      parts.push("price is inside " + land.inside.length + " unfilled zone"
        + (land.inside.length > 1 ? "s" : ""));
    }
    if (land.nearestAbove) {
      parts.push("nearest overhead " + land.nearestAbove.direction + " "
        + land.nearestAbove.distancePct.toFixed(2) + "%");
    }
    if (land.nearestBelow) {
      parts.push("nearest below " + land.nearestBelow.direction + " "
        + land.nearestBelow.distancePct.toFixed(2) + "%");
    }
    base.headline = parts.length
      ? (land.countAbove + " unfilled above / " + land.countBelow + " below — " + parts.join(", "))
      : "No unfilled zones near price.";
    base.magnet = byProximity(usable, price)[0] || null;
    if (land.inside.length) {
      base.notes.push("Price is trading inside an unfilled gap — the zone is being "
        + "mitigated right now, so treat its edges as live, not as a level to lean on.");
    }
    return base;
  }

  // ── Live trade: read entry, stop and target against the zones ───────────
  const entry  = Number.isFinite(signal.entry)  ? signal.entry  : null;
  const stop   = Number.isFinite(signal.stop)   ? signal.stop   : null;
  const target = Number.isFinite(signal.target) ? signal.target : null;

  // "Opposing" means the zone would push back against this trade: overhead
  // supply for a BUY, underlying demand for a SELL.
  const opposingDirection = isBuy ? "bearish" : "bullish";
  const sameDirection     = isBuy ? "bullish" : "bearish";

  if (entry != null) {
    base.entryZone = usable.find(z => z.direction === opposingDirection && zoneContains(z, entry)) || null;
  }
  if (stop != null) {
    base.stopZone = usable.find(z => zoneContains(z, stop)) || null;
  }

  // Anything opposing that lies between entry and target is a place the move can
  // stall before it pays.
  if (entry != null && target != null) {
    const low  = Math.min(entry, target);
    const high = Math.max(entry, target);
    base.obstructions = usable
      .filter(z => z.direction === opposingDirection && z.top > low && z.bottom < high)
      .sort((a, b) => isBuy ? a.bottom - b.bottom : b.top - a.top);
  }

  // Same-direction zones behind the entry are the structure the trade is
  // leaning on: below for a BUY, above for a SELL.
  if (entry != null) {
    base.support = usable
      .filter(z => z.direction === sameDirection && (isBuy ? z.top <= entry : z.bottom >= entry))
      .sort((a, b) => Math.abs(a.midpoint - entry) - Math.abs(b.midpoint - entry))
      .slice(0, 2);
  }

  base.magnet = byProximity(usable.filter(z => isBuy ? z.bottom > price : z.top < price), price)[0] || null;

  // Verdict, most consequential first.
  if (base.stopZone) {
    base.verdict = VERDICT_STOP_IN_GAP;
    base.notes.push("The stop at " + stop + " sits inside an unfilled "
      + base.stopZone.direction + " gap (" + base.stopZone.bottom + "–" + base.stopZone.top
      + "). Price reacting in that zone is the expected behaviour, and the reaction "
      + "would take the stop out. Consider placing it beyond the far edge.");
  } else if (base.entryZone) {
    base.verdict = VERDICT_ENTRY_INTO;
    base.notes.push("Entry is inside an unfilled " + base.entryZone.direction
      + " gap that opposes this " + direction + ". That zone is where the other side "
      + "last moved with force.");
  } else if (base.obstructions.length) {
    base.verdict = VERDICT_OBSTRUCTED;
    base.notes.push(base.obstructions.length + " unfilled " + opposingDirection
      + " zone" + (base.obstructions.length > 1 ? "s" : "") + " between entry and target"
      + " — first at " + base.obstructions[0].bottom + "–" + base.obstructions[0].top + ".");
  } else {
    base.verdict = VERDICT_CLEAR;
    base.notes.push("No unfilled opposing zone between entry and target.");
  }

  if (base.support.length) {
    base.notes.push("Leaning on " + base.support.length + " same-direction zone"
      + (base.support.length > 1 ? "s" : "") + " behind entry, nearest "
      + base.support[0].bottom + "–" + base.support[0].top + ".");
  }

  base.headline = base.verdict + (base.obstructions.length
    ? " · " + base.obstructions.length + " in the way" : "")
    + (base.support.length ? " · " + base.support.length + " behind" : "");
  return base;
}

module.exports = {
  detectFVGs,
  interpretZones,
  describeLandscape,
  averageBarRange,
  buildSuffixExtremes,
  judgeFill,
  zoneContains,
  STATUS_FRESH,
  STATUS_PARTIAL,
  STATUS_FILLED,
  DEFAULT_MIN_GAP_RANGE_FRACTION,
  VERDICT_NO_SIGNAL,
  VERDICT_STOP_IN_GAP,
  VERDICT_ENTRY_INTO,
  VERDICT_OBSTRUCTED,
  VERDICT_CLEAR,
};
