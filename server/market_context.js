'use strict';
/**
 * Market context — the levels and the cross-asset read a daily plan needs.
 *
 * WHY THIS EXISTS. The daily plan shipped its "key levels" from
 * tv_daily_plan.py::_key_levels(), which was round numbers at +/-2% of spot. On
 * 2026-08-30 that wrote BTC "R1 80000 / S1 76000" while the engine's own pivots
 * said r1 78544 / s1 77465. Two level systems existed and the one the JSON
 * artifact, the daily note and /api/daily-plan all consumed was the invented one.
 * Meanwhile /api/signals already carried structure (swing high/low), pivots,
 * session, volume, m15 and atr, and /api/fvg carried full zone geometry — and the
 * plan read none of it.
 *
 * WHAT IT IS NOT. Nothing here feeds the gate, confidence, sizing, stops or any
 * order. Every composed object carries `feedsTheGate: false` and it is asserted by
 * the test suite, not merely intended. This is observability, on the same footing
 * as the FVG landscape and the shadow ledger: it describes the board, it never
 * moves a piece. See CLAUDE.md — FVG has no measured edge and CRT is CLOSED as an
 * engine input after six negatives; both appear here as CONTEXT and may not be
 * promoted out of it.
 *
 * THE ONE IDEA WORTH THE FILE: CONFLUENCE. A level that four independent methods
 * agree on and a level that only pivot arithmetic invented render identically on a
 * chart, and that is the whole problem with a list of levels. So levels are
 * collected from every method available, clustered by proximity scaled to the
 * instrument's own ATR, and scored by how many DISTINCT method FAMILIES land in
 * the cluster — not by how many raw levels do, or three pivots sitting near each
 * other would outrank a genuine confluence of prior-day high, a swing and an EMA.
 *
 * PURE. No I/O, no globals, no clock reads except the ones the caller passes in.
 * Bar order is OLDEST-FIRST, matching fvg.js and structure.js, and the LAST bar of
 * a daily series is TODAY'S FORMING BAR — every "prior" period here is indexed off
 * that fact rather than off the end of the array.
 */

// Two levels belong to the same zone when they sit within this fraction of ATR of
// each other. Scaled off the instrument's own volatility because BTC moves 3000
// points in a day and SPX moves 40; a fixed price or percentage tolerance would
// cluster everything on one asset and nothing on another.
const CLUSTER_ATR_FRACTION = 0.20;

// A zone may not grow wider than this many ATR, however tightly its members chain.
//
// THIS CAP IS NOT A TUNING KNOB, IT IS A CORRECTNESS FIX, and it was found by
// running the thing on live data rather than by reasoning about it. Single-linkage
// clustering chains: each level need only be within tolerance of the PREVIOUS one,
// so a dense enough field links end to end. On 2026-08-30 BTC's h1 FVG levels did
// exactly that — 62 levels collapsed into one band from 71,485 to 80,425, nearly
// 9,000 points and 3 ATR wide. Price sat "inside" it, so BTC's plan published no
// support at all. Gold and SPX were unaffected only because their level fields are
// sparser, which is the worst kind of bug: correct-looking on two of three assets.
//
// 0.6 is three link-tolerances. Wide enough that a genuine confluence of six
// methods within half an ATR stays one zone; narrow enough that a zone is still a
// level rather than a region.
const MAX_ZONE_ATR_WIDTH = 0.60;

// A fractal swing needs this many bars either side that do not exceed it. Two is
// the shortest arm that is not simply "the highest of three bars".
const SWING_ARM_BARS = 2;
// How far back to scan for swings. 120 daily bars is about six months; further back
// and the levels are archaeology rather than context.
const SWING_SCAN_BARS = 120;
const MAX_SWINGS_PER_SIDE = 4;

// Rolling window for the cross-asset correlation read, in daily bars.
const CORRELATION_WINDOW = 30;
// Below this absolute Pearson r the two series are reported as UNCOUPLED rather
// than as a weak relationship, because a weak r on 30 samples is noise with a
// decimal point on it.
const CORRELATION_NOISE_FLOOR = 0.3;

// A zone further than this many ATR from spot is not context for today.
const RELEVANT_ZONE_ATR = 2.5;

// VIX buckets. Not thresholds anything trades off — they name the regime in words
// so a plan does not print a bare number and call it context.
const VIX_CALM = 15;
const VIX_NORMAL = 20;
const VIX_ELEVATED = 25;

// Method families. The confluence score counts DISTINCT families, so every level
// must declare which one it belongs to and no family may be split across names.
const FAMILY_PRIOR  = 'prior-period';
const FAMILY_PIVOT  = 'pivot';
const FAMILY_SWING  = 'swing';
const FAMILY_MA     = 'moving-average';
const FAMILY_BAND   = 'bollinger';
const FAMILY_ROUND  = 'round-number';
const FAMILY_FVG    = 'fair-value-gap';
const FAMILY_ATR    = 'atr-projection';

const ALL_FAMILIES = [
  FAMILY_PRIOR, FAMILY_PIVOT, FAMILY_SWING, FAMILY_MA,
  FAMILY_BAND, FAMILY_ROUND, FAMILY_FVG, FAMILY_ATR,
];

/** Every element finite and numeric. The same guard fvg.js applies to its series. */
function isUsableSeries(series, minLength) {
  return Array.isArray(series)
    && series.length >= minLength
    && series.every(value => typeof value === 'number' && Number.isFinite(value));
}

/** A bar set is usable when its three price series exist, align, and are finite. */
function barsUsable(bars, minLength) {
  if (!bars || typeof bars !== 'object') return false;
  const { highs, lows, closes } = bars;
  if (!isUsableSeries(highs, minLength)) return false;
  if (!isUsableSeries(lows, minLength)) return false;
  if (!isUsableSeries(closes, minLength)) return false;
  return highs.length === lows.length && lows.length === closes.length;
}

function roundTo(value, decimals) {
  if (!Number.isFinite(value)) return null;
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

/** Decimals appropriate to the instrument's price scale, for display only. */
function decimalsFor(price) {
  if (!Number.isFinite(price)) return 2;
  if (price >= 10000) return 0;
  if (price >= 1000) return 1;
  if (price >= 10) return 2;
  return 4;
}

/**
 * Prior-period levels, indexed off the fact that the LAST daily bar is today and
 * is still forming.
 *
 * prevDay  = the last COMPLETED bar (index length-2)
 * prevWeek = the five completed bars before today (indices length-6 .. length-2)
 * today    = the forming bar, so the plan can say how much of the expected range
 *            has already been used
 *
 * Returns { available:false, why } rather than throwing or inventing a level: a
 * series too short for a prior week must say so, not report the prior day twice.
 */
function priorPeriods(daily) {
  if (!barsUsable(daily, 3)) {
    return { available: false, why: 'daily series unusable or under 3 bars' };
  }
  const { highs, lows, closes } = daily;
  const formingIndex = closes.length - 1;
  const prevIndex = formingIndex - 1;

  const prevDay = {
    high: highs[prevIndex],
    low: lows[prevIndex],
    close: closes[prevIndex],
    mid: (highs[prevIndex] + lows[prevIndex]) / 2,
    range: highs[prevIndex] - lows[prevIndex],
  };

  // Five completed sessions. Fewer than five available means no week, and the
  // field says so instead of quietly shrinking the window — a "prior week" built
  // from two bars is a different statistic wearing the same label.
  let prevWeek = { available: false, why: 'need 6 daily bars for a completed week' };
  if (closes.length >= 6) {
    const weekStart = formingIndex - 5;
    let weekHigh = -Infinity;
    let weekLow = Infinity;
    for (let i = weekStart; i <= prevIndex; i++) {
      if (highs[i] > weekHigh) weekHigh = highs[i];
      if (lows[i] < weekLow) weekLow = lows[i];
    }
    prevWeek = {
      available: true,
      high: weekHigh,
      low: weekLow,
      close: closes[prevIndex],
      mid: (weekHigh + weekLow) / 2,
      bars: 5,
    };
  }

  const today = {
    high: highs[formingIndex],
    low: lows[formingIndex],
    close: closes[formingIndex],
    rangeSoFar: highs[formingIndex] - lows[formingIndex],
  };

  return { available: true, prevDay, prevWeek, today };
}

/**
 * Where a normal day reaches from the prior close, and how much of that a forming
 * day has already spent.
 *
 * `rangeUsedPct` is the number worth having: a day that has already travelled 140%
 * of its average true range is not a day to be chasing a breakout in, and a day at
 * 20% by the New York open still has room. Reported as a measurement with no
 * recommendation attached — nothing here decides anything.
 */
function atrProjection(periods, atrValue) {
  if (!periods.available || !Number.isFinite(atrValue) || atrValue <= 0) {
    return { available: false, why: 'no ATR or no prior period' };
  }
  const anchor = periods.prevDay.close;
  const rangeUsedPct = roundTo((periods.today.rangeSoFar / atrValue) * 100, 1);
  return {
    available: true,
    atr: atrValue,
    anchor,
    expectedHigh: anchor + atrValue,
    expectedLow: anchor - atrValue,
    rangeSoFar: periods.today.rangeSoFar,
    rangeUsedPct,
    // Words, not a bare percentage. The three buckets are descriptive labels for
    // the reader; nothing branches on them.
    reading: rangeUsedPct >= 100 ? 'RANGE SPENT — a normal day is already done'
      : rangeUsedPct >= 60 ? 'MOST OF THE RANGE USED'
      : rangeUsedPct >= 25 ? 'RANGE IN PROGRESS'
      : 'RANGE BARELY STARTED',
  };
}

/**
 * Confirmed fractal swings: a high with SWING_ARM_BARS bars either side that do
 * not exceed it, and the mirror for lows.
 *
 * The right arm is why the newest bars are excluded — a swing cannot be confirmed
 * until the bars after it exist, and reporting an unconfirmed one as a level is
 * how a "support" appears that price has not yet finished making.
 */
function findSwings(bars, currentPrice) {
  if (!barsUsable(bars, SWING_ARM_BARS * 2 + 1)) {
    return { available: false, why: 'series too short for a confirmed swing', highs: [], lows: [] };
  }
  const { highs, lows } = bars;
  const lastConfirmable = highs.length - 1 - SWING_ARM_BARS;
  const scanFrom = Math.max(SWING_ARM_BARS, highs.length - SWING_SCAN_BARS);

  const swingHighs = [];
  const swingLows = [];
  for (let i = scanFrom; i <= lastConfirmable; i++) {
    let isHigh = true;
    let isLow = true;
    for (let offset = 1; offset <= SWING_ARM_BARS; offset++) {
      if (highs[i - offset] >= highs[i] || highs[i + offset] >= highs[i]) isHigh = false;
      if (lows[i - offset] <= lows[i] || lows[i + offset] <= lows[i]) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) swingHighs.push({ price: highs[i], barsAgo: highs.length - 1 - i });
    if (isLow) swingLows.push({ price: lows[i], barsAgo: lows.length - 1 - i });
  }

  // Nearest to spot first — those are the ones price has to deal with next.
  const byDistance = (a, b) => Math.abs(a.price - currentPrice) - Math.abs(b.price - currentPrice);
  return {
    available: true,
    highs: swingHighs.sort(byDistance).slice(0, MAX_SWINGS_PER_SIDE),
    lows: swingLows.sort(byDistance).slice(0, MAX_SWINGS_PER_SIDE),
    scanned: lastConfirmable - scanFrom + 1,
  };
}

/**
 * A "nice" increment near half the ATR — the spacing at which round numbers act as
 * magnets on THIS instrument. 1000 on BTC, 50 on Gold, 25 on SPX, derived rather
 * than tabulated so a new instrument needs no new constant.
 */
function niceStep(atrValue) {
  if (!Number.isFinite(atrValue) || atrValue <= 0) return null;
  const target = atrValue / 2;
  const magnitude = Math.pow(10, Math.floor(Math.log10(target)));
  for (const multiple of [1, 2, 2.5, 5]) {
    if (magnitude * multiple >= target) return magnitude * multiple;
  }
  return magnitude * 10;
}

/** The round-number magnets immediately above and below spot. */
function roundMagnets(currentPrice, atrValue) {
  const step = niceStep(atrValue);
  if (!step || !Number.isFinite(currentPrice)) {
    return { available: false, why: 'no ATR to scale the step from', step: null, levels: [] };
  }
  const below = Math.floor(currentPrice / step) * step;
  const above = Math.ceil(currentPrice / step) * step;
  const levels = [below];
  // A price sitting exactly on the step yields one magnet, not two identical ones.
  if (above !== below) levels.push(above);
  return { available: true, step, levels };
}

/**
 * Every level this asset has, flattened into one list with its family attached.
 *
 * `weight` is confidence in the LEVEL, not in the trade: a prior-day high that
 * every participant can see is heavier than the outer band of a Bollinger. It
 * breaks ties between clusters that score the same number of families; it never
 * creates a cluster on its own.
 */
function collectLevels(input) {
  const { periods, pivots, swingsDaily, swingsH4, indicators, magnets, fvgLevels, projection } = input;
  const levels = [];
  const add = (price, family, label, weight) => {
    if (!Number.isFinite(price) || price <= 0) return;
    levels.push({ price, family, label, weight });
  };

  if (periods.available) {
    add(periods.prevDay.high, FAMILY_PRIOR, 'Prior day high', 1.0);
    add(periods.prevDay.low, FAMILY_PRIOR, 'Prior day low', 1.0);
    add(periods.prevDay.close, FAMILY_PRIOR, 'Prior day close', 0.9);
    add(periods.prevDay.mid, FAMILY_PRIOR, 'Prior day mid', 0.6);
    if (periods.prevWeek.available) {
      add(periods.prevWeek.high, FAMILY_PRIOR, 'Prior week high', 1.0);
      add(periods.prevWeek.low, FAMILY_PRIOR, 'Prior week low', 1.0);
    }
  }

  if (pivots && typeof pivots === 'object') {
    add(pivots.pp, FAMILY_PIVOT, 'Pivot PP', 0.8);
    add(pivots.r1, FAMILY_PIVOT, 'Pivot R1', 0.7);
    add(pivots.r2, FAMILY_PIVOT, 'Pivot R2', 0.6);
    add(pivots.s1, FAMILY_PIVOT, 'Pivot S1', 0.7);
    add(pivots.s2, FAMILY_PIVOT, 'Pivot S2', 0.6);
  }

  for (const swing of (swingsDaily.highs || [])) add(swing.price, FAMILY_SWING, `Swing high D1 (${swing.barsAgo}b ago)`, 1.0);
  for (const swing of (swingsDaily.lows || [])) add(swing.price, FAMILY_SWING, `Swing low D1 (${swing.barsAgo}b ago)`, 1.0);
  for (const swing of (swingsH4.highs || [])) add(swing.price, FAMILY_SWING, `Swing high H4 (${swing.barsAgo}b ago)`, 0.7);
  for (const swing of (swingsH4.lows || [])) add(swing.price, FAMILY_SWING, `Swing low H4 (${swing.barsAgo}b ago)`, 0.7);

  if (indicators && typeof indicators === 'object') {
    add(indicators.ema20, FAMILY_MA, 'EMA20', 0.7);
    add(indicators.ema50, FAMILY_MA, 'EMA50', 0.8);
    add(indicators.ema200, FAMILY_MA, 'EMA200', 0.9);
    const bands = indicators.bb;
    if (bands && typeof bands === 'object') {
      add(bands.upper, FAMILY_BAND, 'BB upper', 0.6);
      add(bands.lower, FAMILY_BAND, 'BB lower', 0.6);
      add(bands.middle, FAMILY_BAND, 'BB middle', 0.5);
    }
  }

  for (const level of (magnets.levels || [])) add(level, FAMILY_ROUND, 'Round number', 0.5);

  for (const zone of fvgLevels) {
    // The EDGES of a gap are where price reacts, so both are levels; the midpoint
    // is not one and is deliberately not added.
    add(zone.bottom, FAMILY_FVG, `FVG ${zone.direction} ${zone.timeframe} bottom (${zone.status})`, 0.6);
    add(zone.top, FAMILY_FVG, `FVG ${zone.direction} ${zone.timeframe} top (${zone.status})`, 0.6);
  }

  if (projection.available) {
    add(projection.expectedHigh, FAMILY_ATR, 'ATR day high', 0.5);
    add(projection.expectedLow, FAMILY_ATR, 'ATR day low', 0.5);
  }

  return levels;
}

/**
 * Single-linkage clustering by price, tolerance scaled to ATR.
 *
 * Score is the count of DISTINCT families, never the count of members. Three
 * pivots within a tolerance of each other are pivot arithmetic agreeing with
 * itself and score 1; a prior-day high sitting on an EMA200 sitting on a swing
 * high scores 3. That distinction is the entire reason this function exists.
 *
 * `maxWidth` bounds the chaining. Omit it and the clustering is pure single-linkage,
 * which is what produced the 3-ATR BTC mega-zone described at MAX_ZONE_ATR_WIDTH.
 */
function clusterLevels(levels, tolerance, maxWidth) {
  if (!levels.length || !(tolerance > 0)) return [];
  const widthLimit = Number.isFinite(maxWidth) && maxWidth > 0 ? maxWidth : Infinity;
  const sorted = levels.slice().sort((a, b) => a.price - b.price);

  const clusters = [];
  let current = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    // Two conditions, and BOTH must hold. The first is single-linkage: this level
    // is within tolerance of the cluster's current top edge. The second is the
    // width bound, measured from the cluster's FIRST member — without it a chain
    // of in-tolerance steps grows without limit.
    const linked = sorted[i].price - current[current.length - 1].price <= tolerance;
    const fits = sorted[i].price - current[0].price <= widthLimit;
    if (linked && fits) {
      current.push(sorted[i]);
    } else {
      clusters.push(current);
      current = [sorted[i]];
    }
  }
  clusters.push(current);

  return clusters.map(members => {
    const families = [];
    for (const member of members) {
      if (!families.includes(member.family)) families.push(member.family);
    }
    const prices = members.map(m => m.price);
    const low = Math.min(...prices);
    const high = Math.max(...prices);
    const totalWeight = members.reduce((sum, m) => sum + m.weight, 0);
    // Weighted centre, so the zone's midpoint sits on its heaviest evidence rather
    // than halfway between its two outermost members.
    const centre = members.reduce((sum, m) => sum + m.price * m.weight, 0) / totalWeight;
    return {
      low,
      high,
      mid: centre,
      width: high - low,
      score: families.length,
      families,
      weight: roundTo(totalWeight, 2),
      members: members.map(m => ({ price: m.price, label: m.label, family: m.family })),
    };
  });
}

/**
 * The zones price has to deal with next, above and below, plus everything within
 * RELEVANT_ZONE_ATR sorted by confluence.
 *
 * A zone containing spot is reported as `at`, not forced onto one side: price
 * inside a confluence band is a materially different situation from price
 * approaching one, and putting it in `above` or `below` would erase that.
 */
function rankZones(zones, currentPrice, atrValue) {
  const scored = zones.map(zone => {
    const inside = currentPrice >= zone.low && currentPrice <= zone.high;
    const distance = inside ? 0
      : currentPrice < zone.low ? zone.low - currentPrice
        : currentPrice - zone.high;
    return Object.assign({}, zone, {
      inside,
      distance,
      distanceAtr: atrValue > 0 ? roundTo(distance / atrValue, 2) : null,
      side: inside ? 'at' : (zone.mid > currentPrice ? 'above' : 'below'),
    });
  });

  const relevant = scored.filter(z => atrValue > 0
    ? z.distanceAtr !== null && z.distanceAtr <= RELEVANT_ZONE_ATR
    : true);

  // Nearest first for the two headline zones; a nearer wall matters more than a
  // stronger one you reach second.
  const above = relevant.filter(z => z.side === 'above').sort((a, b) => a.distance - b.distance);
  const below = relevant.filter(z => z.side === 'below').sort((a, b) => a.distance - b.distance);
  const at = relevant.filter(z => z.side === 'at');

  return {
    nearestAbove: above[0] || null,
    nearestBelow: below[0] || null,
    priceInside: at[0] || null,
    // Strongest first, for the chart: these are the ones worth shading.
    byConfluence: relevant.slice()
      .sort((a, b) => (b.score - a.score) || (b.weight - a.weight) || (a.distance - b.distance)),
    relevantCount: relevant.length,
    totalCount: scored.length,
  };
}

/** Pearson correlation of the last `window` daily RETURNS, not of the prices. */
function correlation(closesA, closesB, window) {
  if (!isUsableSeries(closesA, window + 1) || !isUsableSeries(closesB, window + 1)) return null;
  const returnsOf = (closes) => {
    const out = [];
    for (let i = closes.length - window; i < closes.length; i++) {
      const previous = closes[i - 1];
      if (!(previous > 0)) return null;
      out.push((closes[i] - previous) / previous);
    }
    return out;
  };
  const a = returnsOf(closesA);
  const b = returnsOf(closesB);
  if (!a || !b || a.length !== b.length || a.length < 2) return null;

  const meanA = a.reduce((s, v) => s + v, 0) / a.length;
  const meanB = b.reduce((s, v) => s + v, 0) / b.length;
  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (let i = 0; i < a.length; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    covariance += da * db;
    varianceA += da * da;
    varianceB += db * db;
  }
  if (varianceA <= 0 || varianceB <= 0) return null;
  return covariance / Math.sqrt(varianceA * varianceB);
}

function describeCorrelation(r, labelA, labelB) {
  if (r === null) return `${labelA}/${labelB}: not enough aligned history`;
  const rounded = roundTo(r, 2);
  if (Math.abs(r) < CORRELATION_NOISE_FLOOR) {
    return `${labelA}/${labelB} r=${rounded} — UNCOUPLED (inside noise on ${CORRELATION_WINDOW} days)`;
  }
  return `${labelA}/${labelB} r=${rounded} — ${r > 0 ? 'moving together' : 'moving opposite'}`;
}

/**
 * The macro read. DXY and VIX are fetched by the server every cycle and have never
 * been interpreted anywhere — a Gold plan that does not know the dollar's direction
 * is missing the other half of its own instrument.
 *
 * Every line is a description. None of it is advice and none of it is a filter.
 */
function macroRead(macro, dailyCloses) {
  const notes = [];
  const vix = Number(macro && macro.vix);
  const dxy = Number(macro && macro.dxy);

  let vixRegime = null;
  if (Number.isFinite(vix)) {
    vixRegime = vix < VIX_CALM ? 'CALM'
      : vix < VIX_NORMAL ? 'NORMAL'
        : vix < VIX_ELEVATED ? 'ELEVATED'
          : 'STRESSED';
    notes.push(`VIX ${roundTo(vix, 2)} — ${vixRegime}`);
  } else {
    notes.push('VIX unavailable — volatility regime unknown');
  }

  // DXY needs history to have a direction. The server fetches DXY daily closes for
  // the Gold DIVERGENCE setup already; when they are passed through, the dollar
  // gets a direction instead of a bare number.
  let dxyTrend = null;
  const dxyCloses = macro && macro.dxyCloses;
  if (isUsableSeries(dxyCloses, 6)) {
    const latest = dxyCloses[dxyCloses.length - 1];
    const fiveAgo = dxyCloses[dxyCloses.length - 6];
    const changePct = ((latest - fiveAgo) / fiveAgo) * 100;
    dxyTrend = {
      changePct5d: roundTo(changePct, 2),
      direction: changePct > 0.3 ? 'RISING' : changePct < -0.3 ? 'FALLING' : 'FLAT',
    };
    notes.push(`DXY ${Number.isFinite(dxy) ? roundTo(dxy, 2) : '?'} `
      + `${dxyTrend.direction} (${dxyTrend.changePct5d > 0 ? '+' : ''}${dxyTrend.changePct5d}% 5d)`
      + ` — a rising dollar is a headwind for Gold, a falling one a tailwind`);
  } else if (Number.isFinite(dxy)) {
    notes.push(`DXY ${roundTo(dxy, 2)} — level only, no history passed so no direction`);
  } else {
    notes.push('DXY unavailable — no dollar context');
  }

  const correlations = [];
  if (dailyCloses && dailyCloses.btc && dailyCloses.spx) {
    const r = correlation(dailyCloses.btc, dailyCloses.spx, CORRELATION_WINDOW);
    correlations.push({ pair: 'BTC/SPX', r: r === null ? null : roundTo(r, 2), note: describeCorrelation(r, 'BTC', 'SPX') });
  }
  if (dailyCloses && dailyCloses.gold && dailyCloses.spx) {
    const r = correlation(dailyCloses.gold, dailyCloses.spx, CORRELATION_WINDOW);
    correlations.push({ pair: 'GOLD/SPX', r: r === null ? null : roundTo(r, 2), note: describeCorrelation(r, 'GOLD', 'SPX') });
  }

  return { vix: Number.isFinite(vix) ? vix : null, vixRegime, dxy: Number.isFinite(dxy) ? dxy : null, dxyTrend, correlations, notes };
}

/**
 * FVG zones flattened across timeframes into level candidates.
 *
 * Takes the shape /api/fvg already produces so nothing has to be re-detected, and
 * keeps only zones that are not fully filled — a filled gap is a level price has
 * already dealt with.
 */
function fvgLevelsFrom(fvgAsset) {
  if (!fvgAsset || !fvgAsset.timeframes) return [];
  const out = [];
  for (const [timeframe, block] of Object.entries(fvgAsset.timeframes)) {
    if (!block || !Array.isArray(block.zones)) continue;
    for (const zone of block.zones) {
      if (!Number.isFinite(zone.bottom) || !Number.isFinite(zone.top)) continue;
      if (zone.status === 'FILLED') continue;
      out.push({
        timeframe,
        direction: zone.direction,
        status: zone.status,
        bottom: zone.bottom,
        top: zone.top,
        fillPercent: zone.fillPercent,
      });
    }
  }
  return out;
}

/**
 * Compose the whole context for one asset.
 *
 * Every leg degrades on its own: a missing H4 series costs the H4 swings and
 * nothing else, an absent ATR costs the projection and the round-number step and
 * nothing else. `warnings` names every leg that came back empty, because a thin
 * context that does not say why it is thin reads exactly like a quiet market —
 * the same defect that let 22 days of daily plans ship with price:null.
 */
function buildAssetContext(input) {
  const {
    assetKey, symbol, bars, signal, fvgAsset,
  } = input;

  const warnings = [];
  const daily = bars && bars.daily;
  const h4 = bars && bars.h4;

  const currentPrice = Number(signal && signal.price);
  const atrValue = Number(signal && signal.atr);
  const decimals = decimalsFor(currentPrice);

  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    return {
      assetKey, symbol: symbol || null, available: false,
      why: 'no live price on the signal — nothing can be measured against spot',
      feedsTheGate: false,
    };
  }
  if (!Number.isFinite(atrValue) || atrValue <= 0) {
    warnings.push('no ATR — zone tolerance, the round-number step and the day projection are all unavailable');
  }

  const periods = priorPeriods(daily);
  if (!periods.available) warnings.push(`prior periods: ${periods.why}`);
  else if (!periods.prevWeek.available) warnings.push(`prior week: ${periods.prevWeek.why}`);

  const projection = atrProjection(periods, atrValue);
  if (!projection.available) warnings.push(`ATR projection: ${projection.why}`);

  const swingsDaily = findSwings(daily, currentPrice);
  if (!swingsDaily.available) warnings.push(`daily swings: ${swingsDaily.why}`);
  const swingsH4 = findSwings(h4, currentPrice);
  if (!swingsH4.available) warnings.push(`H4 swings: ${swingsH4.why}`);

  const magnets = roundMagnets(currentPrice, atrValue);
  if (!magnets.available) warnings.push(`round numbers: ${magnets.why}`);

  const fvgLevels = fvgLevelsFrom(fvgAsset);
  if (!fvgLevels.length) warnings.push('no unfilled FVG zones — none available as context');

  const levels = collectLevels({
    periods, pivots: signal.pivots, swingsDaily, swingsH4,
    indicators: signal.indicators, magnets, fvgLevels, projection,
  });

  // With no ATR there is no scale to cluster on. Falling back to a price
  // percentage would produce zones on a different definition from every other
  // asset, so the clustering is skipped and said to be skipped.
  const tolerance = atrValue > 0 ? atrValue * CLUSTER_ATR_FRACTION : 0;
  const maxZoneWidth = atrValue > 0 ? atrValue * MAX_ZONE_ATR_WIDTH : Infinity;
  const zones = clusterLevels(levels, tolerance, maxZoneWidth);
  const ranked = tolerance > 0
    ? rankZones(zones, currentPrice, atrValue)
    : { nearestAbove: null, nearestBelow: null, priceInside: null, byConfluence: [], relevantCount: 0, totalCount: 0 };
  if (tolerance <= 0) warnings.push('confluence clustering skipped — no ATR to scale the tolerance from');

  return {
    assetKey,
    symbol: symbol || null,
    available: true,
    price: currentPrice,
    atr: Number.isFinite(atrValue) ? atrValue : null,
    decimals,
    clusterToleranceAtr: CLUSTER_ATR_FRACTION,
    clusterTolerance: roundTo(tolerance, decimals + 2),
    maxZoneWidthAtr: MAX_ZONE_ATR_WIDTH,
    maxZoneWidth: Number.isFinite(maxZoneWidth) ? roundTo(maxZoneWidth, decimals + 2) : null,
    periods,
    projection,
    swings: { daily: swingsDaily, h4: swingsH4 },
    roundNumbers: magnets,
    fvgLevels,
    levelCount: levels.length,
    zones: ranked,
    warnings,
    // Asserted by the test suite. This describes the board; it never moves a piece.
    feedsTheGate: false,
  };
}

/**
 * The whole context payload: every asset, plus the macro read that spans them.
 *
 * `assets` is keyed the way /api/signals is keyed, so a caller that already walks
 * btc/gold/spx needs no new iteration order.
 */
function buildMarketContext(input) {
  const { signals, barsByAsset, fvgAssets, macro } = input;
  const assetKeys = ['btc', 'gold', 'spx'];

  const assets = {};
  const dailyCloses = {};
  for (const assetKey of assetKeys) {
    const signal = (signals || {})[assetKey];
    const bars = (barsByAsset || {})[assetKey];
    if (!signal) {
      assets[assetKey] = { assetKey, available: false, why: 'no cached signal for this asset', feedsTheGate: false };
      continue;
    }
    if (bars && barsUsable(bars.daily, 2)) dailyCloses[assetKey] = bars.daily.closes;
    assets[assetKey] = buildAssetContext({
      assetKey,
      symbol: bars ? bars.symbol : (signal.sourceSymbol || null),
      bars,
      signal,
      fvgAsset: (fvgAssets || {})[assetKey],
    });
  }

  return {
    assets,
    macro: macroRead(macro, dailyCloses),
    families: ALL_FAMILIES,
    correlationWindow: CORRELATION_WINDOW,
    relevantZoneAtr: RELEVANT_ZONE_ATR,
    feedsTheGate: false,
  };
}

module.exports = {
  buildMarketContext,
  buildAssetContext,
  priorPeriods,
  atrProjection,
  findSwings,
  niceStep,
  roundMagnets,
  collectLevels,
  clusterLevels,
  rankZones,
  correlation,
  macroRead,
  fvgLevelsFrom,
  decimalsFor,
  CLUSTER_ATR_FRACTION,
  MAX_ZONE_ATR_WIDTH,
  SWING_ARM_BARS,
  CORRELATION_WINDOW,
  CORRELATION_NOISE_FLOOR,
  RELEVANT_ZONE_ATR,
  ALL_FAMILIES,
  FAMILY_PRIOR,
  FAMILY_PIVOT,
  FAMILY_SWING,
  FAMILY_MA,
  FAMILY_BAND,
  FAMILY_ROUND,
  FAMILY_FVG,
  FAMILY_ATR,
};
