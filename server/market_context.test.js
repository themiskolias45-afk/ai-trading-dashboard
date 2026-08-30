'use strict';

/**
 * Standalone test runner for server/market_context.js — no external framework.
 * Run: node server/market_context.test.js
 * Exit code 0 = all passed, 1 = one or more failures.
 *
 * The assertions that matter most and why:
 *
 *   feedsTheGate is false EVERYWHERE. Asserted rather than intended, because the
 *   whole licence for putting FVG and CRT geometry on the daily plan is that none
 *   of it reaches the gate. CLAUDE.md records six negative measurements on CRT as
 *   an engine input; a test is what stops a later edit quietly promoting it.
 *
 *   The confluence score counts FAMILIES, not members. Three pivots stacked inside
 *   one tolerance must score 1, or pivot arithmetic agreeing with itself would
 *   outrank a real confluence and the whole ranking would be backwards.
 *
 *   The LAST daily bar is TODAY and is still forming. Every prior-period level is
 *   indexed off that. A regression here would silently report the forming bar's
 *   incomplete high as yesterday's high.
 */

const context = require('./market_context.js');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) { passed++; return; }
  failed++;
  failures.push(`${name}${detail ? ' — ' + detail : ''}`);
}

function near(actual, expected, tolerance) {
  return Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
}

// ── Fixtures ────────────────────────────────────────────────────────────
// Oldest-first, matching fvg.js and the MT5 bridge. Eight bars: indices 0..7,
// index 7 is TODAY and still forming, index 6 is the prior completed day.
const dailyBars = {
  highs:  [100, 104, 103, 108, 112, 110, 115, 113],
  lows:   [ 96,  99,  98, 101, 106, 104, 109, 111],
  closes: [ 99, 102, 100, 107, 110, 106, 114, 112],
  volumes: [],
  times: null,
  opens: null,
};

// ── priorPeriods ────────────────────────────────────────────────────────
// Value A (normal): a full 8-bar series.
const periods = context.priorPeriods(dailyBars);
check('priorPeriods available', periods.available === true, JSON.stringify(periods.why));
check('prevDay.high is index 6, NOT the forming bar', periods.prevDay.high === 115,
  `got ${periods.prevDay.high}, forming bar high is 113`);
check('prevDay.low is index 6', periods.prevDay.low === 109, `got ${periods.prevDay.low}`);
check('prevDay.close is index 6', periods.prevDay.close === 114, `got ${periods.prevDay.close}`);
check('prevDay.mid halfway', periods.prevDay.mid === 112, `got ${periods.prevDay.mid}`);
check('today is the forming bar', periods.today.high === 113 && periods.today.low === 111,
  JSON.stringify(periods.today));
// Prior week = indices 2..6 → highs max 115, lows min 98
check('prevWeek spans the 5 completed bars', periods.prevWeek.available === true
  && periods.prevWeek.high === 115 && periods.prevWeek.low === 98,
  JSON.stringify(periods.prevWeek));

// Value B (edge): exactly 3 bars — a prior day exists, a prior week cannot.
const threeBars = { highs: [10, 11, 12], lows: [8, 9, 10], closes: [9, 10, 11] };
const shortPeriods = context.priorPeriods(threeBars);
check('3 bars still gives a prior day', shortPeriods.available === true && shortPeriods.prevDay.high === 11,
  JSON.stringify(shortPeriods.prevDay));
check('3 bars refuses to invent a prior week', shortPeriods.prevWeek.available === false,
  JSON.stringify(shortPeriods.prevWeek));

// Value C (failure): unusable series.
check('null bars degrade, never throw', context.priorPeriods(null).available === false);
check('NaN in the series is rejected',
  context.priorPeriods({ highs: [1, NaN, 3], lows: [1, 2, 3], closes: [1, 2, 3] }).available === false);
check('length mismatch is rejected',
  context.priorPeriods({ highs: [1, 2, 3], lows: [1, 2], closes: [1, 2, 3] }).available === false);

// ── atrProjection ───────────────────────────────────────────────────────
// prevDay.close 114, ATR 4 → expected 110..118. Forming bar range 113-111 = 2.
const projection = context.atrProjection(periods, 4);
check('projection anchors on the prior CLOSE', projection.anchor === 114, `got ${projection.anchor}`);
check('expectedHigh = close + ATR', projection.expectedHigh === 118, `got ${projection.expectedHigh}`);
check('expectedLow = close - ATR', projection.expectedLow === 110, `got ${projection.expectedLow}`);
check('rangeUsedPct = 2/4 = 50%', projection.rangeUsedPct === 50, `got ${projection.rangeUsedPct}`);
check('50% reads as RANGE IN PROGRESS', projection.reading === 'RANGE IN PROGRESS', projection.reading);
check('no ATR means no projection', context.atrProjection(periods, 0).available === false);
check('negative ATR is refused', context.atrProjection(periods, -3).available === false);

// ── findSwings ──────────────────────────────────────────────────────────
// Purpose-built series, indices 0..8. Worked by hand:
//   i=2 high 20 — arms 12,10 left and 12,11 right, none reach it  → SWING HIGH
//   i=4 low  5  — arms 9,15 left and 9,10 right, none reach it    → SWING LOW
//   i=6 high 14 — arms 13,11 left and 13,12 right                 → SWING HIGH
//   i=7 and i=8 are never scanned: a fractal needs SWING_ARM_BARS bars AFTER it,
//   and reporting one before those exist invents a level price has not finished
//   making. That exclusion is the assertion below.
const swingBars = {
  highs:  [10, 12, 20, 12, 11, 13, 14, 13, 12],
  lows:   [ 8,  9, 15,  9,  5,  9, 10,  9,  8],
  closes: [ 9, 11, 18, 10,  7, 11, 12, 11,  9],
};
const swings = context.findSwings(swingBars, 12);
check('swings available', swings.available === true, JSON.stringify(swings.why));
const swingHighPrices = swings.highs.map(s => s.price);
const swingLowPrices = swings.lows.map(s => s.price);
check('confirmed swing high 20 found', swingHighPrices.includes(20), JSON.stringify(swingHighPrices));
check('confirmed swing high 14 found', swingHighPrices.includes(14), JSON.stringify(swingHighPrices));
check('confirmed swing low 5 found', swingLowPrices.includes(5), JSON.stringify(swingLowPrices));
check('no swing is reported before its right arm exists',
  swings.highs.concat(swings.lows).every(s => s.barsAgo >= context.SWING_ARM_BARS),
  JSON.stringify(swings.highs.concat(swings.lows).map(s => s.barsAgo)));
// A bar exceeded within its own arm is not a swing, however extreme it looks. In
// dailyBars the 112 at index 4 is beaten by the 115 at index 6, two bars later.
const noSwings = context.findSwings(dailyBars, 112);
check('a high beaten inside its right arm is NOT a swing',
  !noSwings.highs.map(s => s.price).includes(112),
  `112 is exceeded by 115 two bars later; got ${JSON.stringify(noSwings.highs)}`);
check('nearest-to-spot ordering', swings.highs.length < 2
  || Math.abs(swings.highs[0].price - 12) <= Math.abs(swings.highs[1].price - 12),
  JSON.stringify(swingHighPrices));
check('series too short degrades cleanly',
  context.findSwings({ highs: [1, 2], lows: [1, 2], closes: [1, 2] }, 2).available === false);
check('null series degrades cleanly', context.findSwings(null, 100).available === false);

// ── niceStep / roundMagnets ─────────────────────────────────────────────
// BTC-scale: ATR 3000 → target 1500 → magnitude 1000 → first multiple >= 1500 is 2000.
check('niceStep on a BTC-scale ATR', context.niceStep(3000) === 2000, `got ${context.niceStep(3000)}`);
// SPX-scale: ATR 40 → target 20 → magnitude 10 → 10*2 = 20.
check('niceStep on an SPX-scale ATR', context.niceStep(40) === 20, `got ${context.niceStep(40)}`);
check('niceStep refuses a zero ATR', context.niceStep(0) === null);
const magnets = context.roundMagnets(78159, 3000);
check('magnets bracket spot', magnets.available === true
  && magnets.levels.some(l => l <= 78159) && magnets.levels.some(l => l >= 78159),
  JSON.stringify(magnets));
const onTheStep = context.roundMagnets(78000, 3000);
check('a price exactly on the step yields ONE magnet, not two identical',
  onTheStep.levels.length === 1, JSON.stringify(onTheStep.levels));

// ── clusterLevels: the family-vs-member rule ────────────────────────────
const pivotsOnly = [
  { price: 100.0, family: context.FAMILY_PIVOT, label: 'Pivot R1', weight: 0.7 },
  { price: 100.2, family: context.FAMILY_PIVOT, label: 'Pivot PP', weight: 0.8 },
  { price: 100.4, family: context.FAMILY_PIVOT, label: 'Pivot S1', weight: 0.7 },
];
const pivotClusters = context.clusterLevels(pivotsOnly, 1);
check('three near pivots form ONE zone', pivotClusters.length === 1, `got ${pivotClusters.length}`);
check('three pivots score 1, not 3', pivotClusters[0].score === 1,
  `score ${pivotClusters[0].score} families ${JSON.stringify(pivotClusters[0].families)}`);
check('the zone still records all 3 members', pivotClusters[0].members.length === 3);

const realConfluence = [
  { price: 100.0, family: context.FAMILY_PRIOR, label: 'Prior day high', weight: 1.0 },
  { price: 100.2, family: context.FAMILY_MA, label: 'EMA200', weight: 0.9 },
  { price: 100.4, family: context.FAMILY_SWING, label: 'Swing high D1', weight: 1.0 },
];
const realClusters = context.clusterLevels(realConfluence, 1);
check('three families in one band score 3', realClusters[0].score === 3,
  `score ${realClusters[0].score}`);
check('real confluence outranks stacked pivots',
  realClusters[0].score > pivotClusters[0].score);

// Single-linkage: a chain of steps each inside tolerance is ONE zone.
const chain = [
  { price: 10, family: context.FAMILY_PRIOR, label: 'a', weight: 1 },
  { price: 11, family: context.FAMILY_MA, label: 'b', weight: 1 },
  { price: 12, family: context.FAMILY_SWING, label: 'c', weight: 1 },
  { price: 20, family: context.FAMILY_ROUND, label: 'far', weight: 1 },
];
const chained = context.clusterLevels(chain, 1.5);
check('single-linkage chains 10-11-12 into one zone', chained.length === 2, `got ${chained.length}`);
check('the far level stays its own zone', chained[1].members[0].label === 'far');
check('zero tolerance yields no zones', context.clusterLevels(chain, 0).length === 0);
check('empty input yields no zones', context.clusterLevels([], 1).length === 0);

// THE WIDTH CAP. Regression test for the live failure of 2026-08-30: BTC's h1 FVG
// field chained 62 levels into one 8,939-point band, 3 ATR wide, so price read as
// "inside" it and the plan published no support at all. Ten levels one unit apart
// are each inside a tolerance of 1 and would chain end to end without the bound.
const dense = Array.from({ length: 10 }, (_, i) => ({
  price: 100 + i, family: context.ALL_FAMILIES[i % context.ALL_FAMILIES.length],
  label: `l${i}`, weight: 1,
}));
const unbounded = context.clusterLevels(dense, 1);
check('single-linkage alone chains the whole dense field into one zone',
  unbounded.length === 1 && unbounded[0].width === 9,
  `got ${unbounded.length} zones, width ${unbounded[0] && unbounded[0].width}`);
const bounded = context.clusterLevels(dense, 1, 3);
check('the width cap breaks the chain', bounded.length > 1, `got ${bounded.length} zones`);
check('no zone exceeds the width cap',
  bounded.every(z => z.width <= 3), JSON.stringify(bounded.map(z => z.width)));
check('every level survives the cap — none dropped',
  bounded.reduce((sum, z) => sum + z.members.length, 0) === dense.length,
  `${bounded.reduce((sum, z) => sum + z.members.length, 0)} of ${dense.length}`);
// A genuine tight confluence must NOT be split by the cap.
const tight = context.clusterLevels([
  { price: 100.0, family: context.FAMILY_PRIOR, label: 'a', weight: 1 },
  { price: 100.1, family: context.FAMILY_MA, label: 'b', weight: 1 },
  { price: 100.2, family: context.FAMILY_SWING, label: 'c', weight: 1 },
], 1, 3);
check('a tight 3-family confluence stays one zone under the cap',
  tight.length === 1 && tight[0].score === 3, `${tight.length} zones`);

// The weighted centre sits on the heaviest evidence, not the arithmetic middle.
const lopsided = context.clusterLevels([
  { price: 100, family: context.FAMILY_PRIOR, label: 'heavy', weight: 3 },
  { price: 104, family: context.FAMILY_ROUND, label: 'light', weight: 1 },
], 10)[0];
check('zone mid is weight-biased toward the heavy level', near(lopsided.mid, 101, 1e-9),
  `got ${lopsided.mid}, arithmetic middle would be 102`);

// ── rankZones ───────────────────────────────────────────────────────────
const zonesForRanking = context.clusterLevels([
  { price: 90, family: context.FAMILY_PRIOR, label: 'below', weight: 1 },
  { price: 100, family: context.FAMILY_MA, label: 'at', weight: 1 },
  { price: 110, family: context.FAMILY_SWING, label: 'above', weight: 1 },
], 1);
const ranked = context.rankZones(zonesForRanking, 100, 10);
check('price inside a zone is reported as `at`, not forced to a side',
  ranked.priceInside !== null && ranked.priceInside.members[0].label === 'at',
  JSON.stringify(ranked.priceInside));
check('nearestAbove found', ranked.nearestAbove && ranked.nearestAbove.members[0].label === 'above');
check('nearestBelow found', ranked.nearestBelow && ranked.nearestBelow.members[0].label === 'below');
check('distanceAtr is in ATR units', ranked.nearestAbove.distanceAtr === 1,
  `got ${ranked.nearestAbove.distanceAtr}`);
// RELEVANT_ZONE_ATR is 2.5, so a zone 4 ATR away is dropped from the relevant set.
const farRanked = context.rankZones(context.clusterLevels([
  { price: 100, family: context.FAMILY_PRIOR, label: 'near', weight: 1 },
  { price: 200, family: context.FAMILY_SWING, label: 'far', weight: 1 },
], 1), 100, 10);
check('a zone beyond RELEVANT_ZONE_ATR is excluded from the relevant set',
  farRanked.relevantCount === 1 && farRanked.totalCount === 2,
  `relevant ${farRanked.relevantCount} of ${farRanked.totalCount}`);

// ── correlation ─────────────────────────────────────────────────────────
// Correlation is on RETURNS, not on prices, and that distinction is the trap this
// fixture exists to hold. `100+i` and `200-i` look like mirror images but their
// RETURNS are both monotonically decreasing, so they correlate at +0.99 — which is
// the correct answer and not the one a price-shaped intuition expects. To get a
// genuine -1 the returns themselves have to be negated, so they are, exactly.
const stepReturns = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 0.01 : -0.015));
const upSeries = [100];
const mirrorSeries = [100];
for (const r of stepReturns) {
  upSeries.push(upSeries[upSeries.length - 1] * (1 + r));
  mirrorSeries.push(mirrorSeries[mirrorSeries.length - 1] * (1 - r));
}
const rSame = context.correlation(upSeries, upSeries.map(v => v * 3), 30);
check('a series against a scaled copy of itself correlates at +1',
  rSame !== null && rSame > 0.999, `r=${rSame}`);
const rOpposite = context.correlation(upSeries, mirrorSeries, 30);
check('exactly negated returns correlate at -1',
  rOpposite !== null && rOpposite < -0.999, `r=${rOpposite}`);
const rPriceShaped = context.correlation(
  Array.from({ length: 40 }, (_, i) => 100 + i),
  Array.from({ length: 40 }, (_, i) => 200 - i), 30);
check('mirrored PRICES are positively correlated in returns — the documented trap',
  rPriceShaped !== null && rPriceShaped > 0.9, `r=${rPriceShaped}`);
check('too little history returns null, never 0',
  context.correlation([1, 2, 3], [1, 2, 3], 30) === null);
check('a flat series has no variance and returns null',
  context.correlation(new Array(40).fill(100), upSeries, 30) === null);

// ── macroRead ───────────────────────────────────────────────────────────
const macro = context.macroRead({ vix: 14.43, dxy: 99.68, dxyCloses: [98, 98.2, 98.5, 99, 99.4, 99.68] }, {});
check('VIX 14.43 is CALM', macro.vixRegime === 'CALM', macro.vixRegime);
check('DXY gets a direction when history is passed', macro.dxyTrend !== null
  && macro.dxyTrend.direction === 'RISING', JSON.stringify(macro.dxyTrend));
const macroNoHistory = context.macroRead({ vix: 30, dxy: 99.68 }, {});
check('VIX 30 is STRESSED', macroNoHistory.vixRegime === 'STRESSED', macroNoHistory.vixRegime);
check('DXY with no history has no direction and says so',
  macroNoHistory.dxyTrend === null
  && macroNoHistory.notes.some(n => n.includes('no direction')),
  JSON.stringify(macroNoHistory.notes));
const macroEmpty = context.macroRead({}, {});
check('absent macro degrades to named unknowns, never to zeros',
  macroEmpty.vix === null && macroEmpty.dxy === null
  && macroEmpty.notes.some(n => n.includes('unavailable')),
  JSON.stringify(macroEmpty.notes));

// ── fvgLevelsFrom ───────────────────────────────────────────────────────
const fvgLevels = context.fvgLevelsFrom({
  timeframes: {
    daily: { zones: [
      { direction: 'bullish', bottom: 73065, top: 76491, status: 'PARTIAL', fillPercent: 0.27 },
      { direction: 'bearish', bottom: 80000, top: 81000, status: 'FILLED', fillPercent: 1 },
    ] },
    h4: { zones: [{ direction: 'bullish', bottom: 77000, top: 77500, status: 'FRESH', fillPercent: 0 }] },
  },
});
check('FILLED zones are dropped — price already dealt with them',
  fvgLevels.length === 2, `got ${fvgLevels.length}: ${JSON.stringify(fvgLevels.map(z => z.status))}`);
check('the timeframe travels with the zone',
  fvgLevels.some(z => z.timeframe === 'h4'), JSON.stringify(fvgLevels));
check('a missing fvg block yields no levels, never throws',
  context.fvgLevelsFrom(null).length === 0 && context.fvgLevelsFrom({}).length === 0);

// ── buildAssetContext: the full compose ─────────────────────────────────
const signal = {
  price: 112,
  atr: 4,
  pivots: { pp: 112, r1: 114, r2: 116, s1: 110, s2: 108 },
  indicators: { rsi: 60, ema20: 111.8, ema50: 108, ema200: 104,
    bb: { upper: 120, middle: 110, lower: 100, bandwidth: 18 } },
};
const built = context.buildAssetContext({
  assetKey: 'btc', symbol: 'BTCUSD',
  bars: { daily: dailyBars, h4: dailyBars, symbol: 'BTCUSD' },
  signal,
  fvgAsset: null,
});
check('context builds', built.available === true, JSON.stringify(built.why));
check('feedsTheGate is FALSE on the asset context', built.feedsTheGate === false);
check('tolerance is ATR * CLUSTER_ATR_FRACTION',
  near(built.clusterTolerance, 4 * context.CLUSTER_ATR_FRACTION, 1e-6),
  `got ${built.clusterTolerance}`);
check('levels were collected', built.levelCount > 5, `only ${built.levelCount}`);
check('zones were ranked', built.zones.totalCount > 0, JSON.stringify(built.zones.totalCount));
check('a missing FVG block is named in warnings, not silently dropped',
  built.warnings.some(w => w.includes('FVG')), JSON.stringify(built.warnings));

// No price at all → refuse, and say why.
const noPrice = context.buildAssetContext({
  assetKey: 'btc', bars: { daily: dailyBars }, signal: { atr: 4 }, fvgAsset: null,
});
check('no live price refuses and names the reason',
  noPrice.available === false && typeof noPrice.why === 'string' && noPrice.why.length > 0,
  JSON.stringify(noPrice));
check('even a refusal carries feedsTheGate false', noPrice.feedsTheGate === false);

// No ATR → still builds, with three named warnings and no clustering.
const noAtr = context.buildAssetContext({
  assetKey: 'btc', bars: { daily: dailyBars }, signal: { price: 112, pivots: signal.pivots },
  fvgAsset: null,
});
check('no ATR still produces a context', noAtr.available === true);
check('no ATR skips clustering and SAYS so',
  noAtr.zones.totalCount === 0 && noAtr.warnings.some(w => w.includes('clustering skipped')),
  JSON.stringify(noAtr.warnings));

// ── buildMarketContext: the payload ─────────────────────────────────────
const payload = context.buildMarketContext({
  signals: { btc: signal, gold: null, spx: signal },
  barsByAsset: {
    btc: { daily: dailyBars, h4: dailyBars, symbol: 'BTCUSD' },
    spx: { daily: dailyBars, h4: dailyBars, symbol: 'SP500' },
  },
  fvgAssets: {},
  macro: { vix: 14.43, dxy: 99.68 },
});
check('payload carries all three asset keys',
  ['btc', 'gold', 'spx'].every(k => k in payload.assets), JSON.stringify(Object.keys(payload.assets)));
check('an asset with no signal is marked unavailable with a reason',
  payload.assets.gold.available === false && typeof payload.assets.gold.why === 'string');
check('feedsTheGate is FALSE on the payload', payload.feedsTheGate === false);
check('feedsTheGate is FALSE on EVERY asset block',
  Object.values(payload.assets).every(a => a.feedsTheGate === false),
  JSON.stringify(Object.entries(payload.assets).map(([k, a]) => [k, a.feedsTheGate])));
check('the family list is published so a consumer can name a score',
  Array.isArray(payload.families) && payload.families.length === 8, JSON.stringify(payload.families));

// The whole payload must be JSON-serialisable — it is an HTTP response.
let serialised = null;
try { serialised = JSON.stringify(payload); } catch (e) { serialised = null; }
check('payload serialises to JSON', typeof serialised === 'string' && serialised.length > 100);
// JSON.stringify turns Infinity into null silently, so a sentinel that escaped the
// clustering would arrive on the page as a level with no price rather than as an
// error. Every zone edge is checked for finiteness on the object, before encoding.
const everyZone = Object.values(payload.assets)
  .filter(a => a.available)
  .flatMap(a => a.zones.byConfluence);
check('every ranked zone has finite low/high/mid — no Infinity sentinel escaped',
  everyZone.length > 0 && everyZone.every(z =>
    Number.isFinite(z.low) && Number.isFinite(z.high) && Number.isFinite(z.mid)),
  `${everyZone.length} zones checked`);
check('every ranked zone scores at least one family',
  everyZone.every(z => z.score >= 1 && z.families.length === z.score));

// ── Report ──────────────────────────────────────────────────────────────
console.log(`\nmarket_context.js — ${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFAILURES:');
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  process.exit(1);
}
console.log('All assertions passed.\n');
process.exit(0);
