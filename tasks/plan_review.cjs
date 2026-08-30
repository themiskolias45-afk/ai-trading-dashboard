#!/usr/bin/env node
'use strict';
/**
 * Plan review — grade yesterday's plan against what the day actually did.
 *
 * THE GAP THIS CLOSES. The system publishes levels every morning and has never once
 * checked whether they were any good. "Where price reacts" was an assumption wearing
 * the clothes of a measurement. This turns it into a number.
 *
 * THE QUESTION IT EXISTS TO ANSWER: does confluence predict reaction? The clustering
 * in server/market_context.js scores a zone by how many INDEPENDENT methods agree on
 * it, and the whole design rests on the claim that a x5 zone holds more often than a
 * x2 one. That claim is currently UNTESTED. This accumulates the evidence to settle
 * it — hold rate bucketed by confluence score, with sample sizes on every row.
 *
 * IT SEGMENTS BY LEVEL SOURCE, ON PURPOSE. Plans written before 2026-08-30 carry
 * round-number levels (`_key_levels` was arithmetic on spot); plans after it carry
 * confluence zones. Pooling those two would let the new system inherit the old one's
 * record, or be blamed for it. Every row carries `levelsSource` and the summary
 * keeps them apart. That is the same rule the fleet pages follow: numbers that pool
 * two different things are unattributable.
 *
 * WHAT IT WILL NOT DO:
 *   - It writes no signal, no setting and no order. It has no path to the engine.
 *     Rule 3 holds trivially: nothing here can suppress a setup.
 *   - It never rewrites a graded day. Rows append; a date already in the scorecard is
 *     skipped, not recomputed, so a later change to the grading cannot silently
 *     rewrite history. Rule 6.
 *   - It never grades an incomplete day. A bar still forming has no final close, and
 *     grading against one would score a level against half a session.
 *
 * Usage:
 *   node tasks/plan_review.cjs                # grade every ungraded complete day
 *   node tasks/plan_review.cjs --date 2026-08-29
 *   node tasks/plan_review.cjs --dry-run      # grade and print, write nothing
 *   node tasks/plan_review.cjs --summary      # print the scorecard, grade nothing
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const PROJECT_ROOT = path.join(__dirname, '..');
const TASKS_DIR = path.join(PROJECT_ROOT, 'tasks');
const ANALYSIS_DIR = path.join(TASKS_DIR, 'analysis');
const SCORECARD = path.join(ANALYSIS_DIR, 'plan-scorecard.json');

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const SUMMARY_ONLY = argv.includes('--summary');
const ONLY_DATE = (() => {
  const at = argv.indexOf('--date');
  return at >= 0 && argv[at + 1] ? argv[at + 1] : null;
})();

// Below this many observations a rate is not a rate. The rejection ledger uses the
// same idea and the same word: TOO FEW TO JUDGE, printed rather than implied. A
// percentage over three samples is noise with a decimal point on it.
const MIN_SAMPLES_FOR_VERDICT = 8;

const ASSET_KEYS = ['btc', 'gold', 'spx'];

let SESSION_COOKIE = null;
try {
  const secret = fs.readFileSync(path.join(PROJECT_ROOT, 'server', 'session_secret.txt'), 'utf8').trim();
  if (secret) SESSION_COOKIE = 'smartentry_session=' + secret;
} catch (e) { /* gated legs will 401 and say so */ }

function get(routePath) {
  return new Promise((resolve, reject) => {
    const headers = SESSION_COOKIE ? { Cookie: SESSION_COOKIE } : {};
    const req = http.get({ host: '127.0.0.1', port: 3001, path: routePath, headers, timeout: 15000 }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('unparseable JSON: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

function utcDateOf(unixSeconds) {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

/**
 * The completed daily bar for `date`, per asset, from the bars the bridge already
 * pushed. 600 D1 bars reach back roughly two years, which is far more history than
 * there are plans to grade.
 *
 * Returns null for a date with no bar — a weekend, a holiday, or a day the feed did
 * not cover. A missing bar is NOT a failed plan and must not be graded as one.
 */
function barsForDate(rawAssets, date) {
  const out = {};
  for (const assetKey of ASSET_KEYS) {
    const entry = rawAssets[assetKey];
    const daily = entry && entry.bars && entry.bars.d1;
    if (!daily || !Array.isArray(daily.times) || !Array.isArray(daily.opens)) continue;
    const index = daily.times.findIndex(t => utcDateOf(t) === date);
    if (index < 0) continue;
    out[assetKey] = {
      symbol: entry.symbol,
      open: daily.opens[index],
      high: daily.highs[index],
      low: daily.lows[index],
      close: daily.closes[index],
    };
  }
  return out;
}

/**
 * Did the plan's directional call match the session?
 *
 * WAIT is not graded. A plan that correctly declined to trade is not a wrong bias,
 * and scoring it as one would reward the system for guessing on days it should stand
 * aside — which is the opposite of what the gate is for.
 */
function gradeBias(planAsset, actual) {
  const tradePlan = planAsset && planAsset.trade_plan;
  if (!tradePlan || !tradePlan.direction) return { bias: 'WAIT', graded: false };
  const wanted = tradePlan.direction === 'BUY' ? 'LONG'
    : tradePlan.direction === 'SELL' ? 'SHORT' : null;
  if (!wanted) return { bias: tradePlan.direction, graded: false };
  const movedUp = actual.close > actual.open;
  return {
    bias: wanted,
    graded: true,
    correct: wanted === 'LONG' ? movedUp : !movedUp,
    changePct: Number((((actual.close - actual.open) / actual.open) * 100).toFixed(3)),
    confidence: tradePlan.confidence,
  };
}

/**
 * Did the day stay inside the projected ATR band?
 *
 * Containment is a calibration statistic, not a scorecard: a band contained 100% of
 * the time is too wide to be useful and one contained 20% of the time is too narrow.
 * It is recorded so the width can eventually be judged, not so a day can pass or fail.
 */
function gradeProjection(planAsset, actual) {
  const projection = ((planAsset || {}).context || {}).projection;
  if (!projection || !projection.available) return { graded: false, why: 'no projection on this plan' };
  const contained = actual.high <= projection.expectedHigh && actual.low >= projection.expectedLow;
  const atr = Number(projection.atr) || null;
  const overshootHigh = Math.max(0, actual.high - projection.expectedHigh);
  const overshootLow = Math.max(0, projection.expectedLow - actual.low);
  return {
    graded: true,
    contained,
    expectedLow: projection.expectedLow,
    expectedHigh: projection.expectedHigh,
    overshootAtr: atr ? Number(((overshootHigh + overshootLow) / atr).toFixed(3)) : null,
  };
}

/**
 * For one price band: was it touched, and did it hold?
 *
 * HELD means price reached the band and the session CLOSED back on the side it came
 * from. Using the close rather than the extreme is deliberate — an intraday spike
 * through a level that closes back inside is exactly what a level holding looks
 * like, and scoring it as a break would call every real rejection a failure.
 *
 * A band that price never reached is `touched: false` and is not scored either way.
 * Counting an untouched level as "held" is the single easiest way to manufacture a
 * 95% hold rate that means nothing.
 */
function gradeBand(low, high, side, actual) {
  const touched = actual.low <= high && actual.high >= low;
  if (!touched) return { touched: false };
  if (side === 'above') return { touched: true, held: actual.close <= high };
  if (side === 'below') return { touched: true, held: actual.close >= low };
  // Price started inside the band. "Held" has no meaning here — there is no side it
  // came from — so it is recorded as touched and left ungraded rather than guessed.
  return { touched: true, held: null, why: 'price opened inside this band' };
}

/** Every zone and every published level on one plan, graded. */
function gradeLevels(planAsset, actual) {
  const tests = [];
  const zones = ((planAsset || {}).context || {}).zones || [];
  for (const zone of zones) {
    const result = gradeBand(zone.low, zone.high, zone.side, actual);
    tests.push(Object.assign({
      kind: 'confluence-zone',
      confluence: zone.confluence,
      side: zone.side,
      low: zone.low,
      high: zone.high,
      methods: zone.methods || [],
    }, result));
  }

  // The four published levels, whatever their source. On a pre-2026-08-30 plan these
  // are the round-number band, which is exactly the comparison worth having.
  const levels = (planAsset || {}).levels || {};
  for (const [name, side] of [['R1', 'above'], ['R2', 'above'], ['S1', 'below'], ['S2', 'below']]) {
    const price = Number(levels[name]);
    if (!Number.isFinite(price)) continue;
    const detail = levels[name + '_detail'];
    // A published level is a POINT, so its band is degenerate. gradeBand handles that
    // correctly: touched when the day's range spans the price.
    const result = gradeBand(price, price, side, actual);
    tests.push(Object.assign({
      kind: 'published-level',
      name,
      side,
      price,
      confluence: detail ? detail.confluence : null,
      source: levels.source || 'unknown',
    }, result));
  }
  return tests;
}

function gradeDay(date, plan, bars) {
  const assets = {};
  for (const assetKey of ASSET_KEYS) {
    const planAsset = (plan.assets || {})[assetKey];
    const actual = bars[assetKey];
    if (!planAsset || !actual) continue;
    assets[assetKey] = {
      actual,
      bias: gradeBias(planAsset, actual),
      projection: gradeProjection(planAsset, actual),
      levels: gradeLevels(planAsset, actual),
    };
  }
  return {
    date,
    // Segments the summary. Pooling round-number days with confluence days would let
    // one system inherit the other's record.
    levelsSource: plan.levelsSource
      || ((plan.assets || {}).btc || {}).levels && ((plan.assets || {}).btc || {}).levels.source
      || 'legacy-round-numbers',
    generatedAt: plan.generatedAt || null,
    gradedAt: new Date().toISOString(),
    assets,
  };
}

/** Rate with an explicit sample size and a refusal below the floor. */
function rate(hits, total) {
  if (!total) return { pct: null, n: 0, verdict: 'NO DATA' };
  const pct = Number(((hits / total) * 100).toFixed(1));
  return {
    pct, n: total,
    verdict: total < MIN_SAMPLES_FOR_VERDICT ? 'TOO FEW TO JUDGE' : 'measured',
  };
}

function summarise(days) {
  const bySource = {};
  const byConfluence = {};
  const biasBySource = {};
  const containment = {};
  // COVERAGE IS NOT OPTIONAL HERE, and the first run of this tool is why.
  //
  // It graded 17 days and reported 4 touched levels, which reads as "the levels were
  // so far from price that price never reached them". That is NOT what happened. 12
  // of those 17 plans carry price:null — the documented 22-day daily-plan outage —
  // so `levels` is an empty object and there was never a level to touch. A hold rate
  // whose denominator is silently made of missing data is the exact trap that let a
  // 43% plan-history miss rate hide behind a green task exit code.
  //
  // So the denominator is published here, in the open, beside every rate.
  const coverage = { assetDays: 0, withPrice: 0, withLevels: 0, withContext: 0, levelsPublished: 0 };

  for (const day of days) {
    const source = day.levelsSource || 'unknown';
    for (const [assetKey, block] of Object.entries(day.assets || {})) {
      coverage.assetDays++;
      if (block.actual && Number.isFinite(block.actual.close)) coverage.withPrice++;
      const levelTests = block.levels || [];
      const published = levelTests.filter(t => t.kind === 'published-level').length;
      coverage.levelsPublished += published;
      if (published) coverage.withLevels++;
      if (levelTests.some(t => t.kind === 'confluence-zone')) coverage.withContext++;
      if (block.bias && block.bias.graded) {
        biasBySource[source] = biasBySource[source] || { hits: 0, total: 0 };
        biasBySource[source].total++;
        if (block.bias.correct) biasBySource[source].hits++;
      }
      if (block.projection && block.projection.graded) {
        containment[assetKey] = containment[assetKey] || { hits: 0, total: 0 };
        containment[assetKey].total++;
        if (block.projection.contained) containment[assetKey].hits++;
      }
      for (const test of block.levels || []) {
        // Only TOUCHED bands with a definite verdict count. Untouched levels and
        // opened-inside bands are excluded — including them is how a meaningless
        // 95% hold rate gets manufactured.
        if (!test.touched || test.held === null || test.held === undefined) continue;
        const bucket = test.kind === 'confluence-zone'
          ? `x${test.confluence}` : `published:${test.source || 'unknown'}`;
        bySource[source] = bySource[source] || { hits: 0, total: 0 };
        bySource[source].total++;
        if (test.held) bySource[source].hits++;

        byConfluence[bucket] = byConfluence[bucket] || { hits: 0, total: 0 };
        byConfluence[bucket].total++;
        if (test.held) byConfluence[bucket].hits++;
      }
    }
  }

  const mapRates = obj => Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [k, rate(v.hits, v.total)]));

  return {
    days: days.length,
    // Read this BEFORE any rate below it. `withLevels` far under `assetDays` means
    // the rates are computed over a handful of asset-days and the rest published no
    // level at all — an absence, not a miss.
    coverage,
    holdRateByLevelSource: mapRates(bySource),
    holdRateByConfluence: mapRates(byConfluence),
    biasHitRateByLevelSource: mapRates(biasBySource),
    atrBandContainmentByAsset: mapRates(containment),
    minSamplesForVerdict: MIN_SAMPLES_FOR_VERDICT,
    // The claim this whole scorecard exists to settle, stated so a reader knows what
    // they are looking at rather than having to infer it.
    theQuestion: 'Does a higher confluence score hold more often? Compare the x2..xN '
      + 'rows in holdRateByConfluence. Rows marked TOO FEW TO JUDGE are not evidence.',
    feedsTheGate: false,
  };
}

function printSummary(summary) {
  console.log(`\nPLAN SCORECARD — ${summary.days} graded day(s)`);
  console.log('-'.repeat(72));
  const coverage = summary.coverage;
  if (coverage) {
    console.log('\nCOVERAGE  (read this first — it is the denominator)');
    console.log(`  asset-days graded            ${String(coverage.assetDays).padStart(6)}`);
    console.log(`  ...with a completed bar      ${String(coverage.withPrice).padStart(6)}`);
    console.log(`  ...that PUBLISHED a level    ${String(coverage.withLevels).padStart(6)}`
      + (coverage.withLevels < coverage.assetDays
        ? `   <- ${coverage.assetDays - coverage.withLevels} published NONE (plan had price:null)` : ''));
    console.log(`  ...with confluence context   ${String(coverage.withContext).padStart(6)}`);
    console.log(`  individual levels published  ${String(coverage.levelsPublished).padStart(6)}`);
  }
  const table = (title, rates) => {
    console.log(`\n${title}`);
    const entries = Object.entries(rates);
    if (!entries.length) { console.log('  (nothing yet)'); return; }
    for (const [key, value] of entries.sort((a, b) => a[0].localeCompare(b[0]))) {
      const pct = value.pct === null ? '   —' : `${String(value.pct).padStart(5)}%`;
      const flag = value.verdict === 'measured' ? '' : `  ${value.verdict}`;
      console.log(`  ${key.padEnd(28)} ${pct}  n=${String(value.n).padStart(4)}${flag}`);
    }
  };
  table('HOLD RATE BY CONFLUENCE SCORE  (the question this exists to answer)',
    summary.holdRateByConfluence);
  table('HOLD RATE BY LEVEL SOURCE', summary.holdRateByLevelSource);
  table('BIAS HIT RATE BY LEVEL SOURCE', summary.biasHitRateByLevelSource);
  table('ATR BAND CONTAINMENT BY ASSET  (calibration, not a score)',
    summary.atrBandContainmentByAsset);
  console.log(`\n  A rate under n=${summary.minSamplesForVerdict} is printed but is NOT evidence.`);
  console.log('-'.repeat(72));
}

async function main() {
  fs.mkdirSync(ANALYSIS_DIR, { recursive: true });
  const scorecard = readJson(SCORECARD, { days: [], summary: null });
  const gradedDates = new Set(scorecard.days.map(d => d.date));

  if (SUMMARY_ONLY) {
    printSummary(scorecard.summary || summarise(scorecard.days));
    process.exit(0);
  }

  let raw;
  try {
    raw = await get('/api/mt5/candles/raw');
  } catch (e) {
    console.error(`[review] cannot read the bars (${e.message}) — nothing was graded`);
    process.exit(1);
  }
  const rawAssets = (raw && raw.assets) || {};
  if (!Object.keys(rawAssets).length) {
    console.error('[review] the bar cache is empty — no MT5 push has landed yet. Nothing graded.');
    process.exit(1);
  }

  const today = new Date().toISOString().slice(0, 10);
  const planFiles = fs.readdirSync(TASKS_DIR)
    .filter(name => /^daily_plan_\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .sort();

  const newlyGraded = [];
  for (const name of planFiles) {
    const date = name.slice('daily_plan_'.length, -'.json'.length);
    if (ONLY_DATE && date !== ONLY_DATE) continue;
    if (gradedDates.has(date)) continue;
    // Today's bar is still forming. Grading a level against half a session is not a
    // grade, and once written the row would never be recomputed.
    if (date >= today) continue;

    const plan = readJson(path.join(TASKS_DIR, name), null);
    if (!plan) { console.error(`[review] ${name}: unreadable, skipped`); continue; }

    const bars = barsForDate(rawAssets, date);
    if (!Object.keys(bars).length) {
      // A weekend or a holiday. Not a failed plan — say so and move on rather than
      // recording a day of zeros.
      console.log(`[review] ${date}: no completed daily bar for any asset (weekend/holiday?) — skipped`);
      continue;
    }
    const graded = gradeDay(date, plan, bars);
    newlyGraded.push(graded);
    const touched = Object.values(graded.assets)
      .reduce((sum, a) => sum + (a.levels || []).filter(t => t.touched).length, 0);
    console.log(`[review] ${date} [${graded.levelsSource}]: `
      + `${Object.keys(graded.assets).length} asset(s), ${touched} level(s) touched`);
  }

  if (!newlyGraded.length) {
    console.log('[review] nothing new to grade');
    printSummary(scorecard.summary || summarise(scorecard.days));
    process.exit(0);
  }

  // APPEND. A date already present is never recomputed — a later change to the
  // grading must not silently rewrite the record it is going to be judged against.
  const allDays = scorecard.days.concat(newlyGraded).sort((a, b) => a.date.localeCompare(b.date));
  const summary = summarise(allDays);

  if (DRY_RUN) {
    console.log('\n[review] --dry-run: nothing written');
  } else {
    fs.writeFileSync(SCORECARD, JSON.stringify({
      updatedAt: new Date().toISOString(),
      minSamplesForVerdict: MIN_SAMPLES_FOR_VERDICT,
      summary,
      days: allDays,
    }, null, 2), 'utf8');
    console.log(`\n[review] ${newlyGraded.length} day(s) added — ${path.relative(PROJECT_ROOT, SCORECARD)}`);
  }
  printSummary(summary);
  process.exit(0);
}

if (require.main === module) {
  main().catch(e => {
    console.error(`[review] unhandled: ${e.stack || e.message}`);
    process.exit(1);
  });
}

module.exports = { gradeBias, gradeProjection, gradeBand, gradeLevels, gradeDay, summarise, rate, barsForDate, MIN_SAMPLES_FOR_VERDICT };
