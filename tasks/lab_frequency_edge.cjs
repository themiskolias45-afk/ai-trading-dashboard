#!/usr/bin/env node
'use strict';
/* ============================================================================
   lab_frequency_edge.cjs — does a strategy's edge survive taking more trades?
   ============================================================================

   WHY THIS EXISTS. Every sample-size problem in this project ends at the same
   wish: take more trades and the evidence arrives sooner. That is only true if
   the extra trades are as good as the ones already there, and whether they are
   is a measurable property of each strategy rather than a thing to assume.

   THE MISTAKE IT PREVENTS, WHICH I MADE FIRST. Measuring breakout_zone by hand
   on XAUUSD, expectancy fell steadily as trade count rose - 55 trades at
   +0.53R, 673 at -0.05R - and the obvious conclusion was that frequency and
   edge trade off. Run across all 4,997 registry trials the correlation between
   log(trade count) and expectancy is not consistent at all:

       opening_range_breakout  -0.350   (n=320)    real, and worth knowing
       breakout_zone           -0.430   (n= 22)    matches the hand result, tiny n
       rsi_reversion           +0.152   (n=1536)   the OPPOSITE sign
       ema_cross               -0.076   (n=1051)
       tsmom                   -0.000   (n=384)

   So it is a property of SOME strategies. Two hand-picked cells and a plausible
   story would have shipped it as a law.

   IT READS THE REGISTRY AND NOTHING ELSE. No bars, no broker, no settings, no
   order path - it re-reads trials already run and computes a correlation over
   them. Cheap enough to run any time and it changes nothing.

   USAGE
     node tasks/lab_frequency_edge.cjs
     node tasks/lab_frequency_edge.cjs --min-trades 50
     node tasks/lab_frequency_edge.cjs --selftest
   ========================================================================== */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REGISTRY = path.join(ROOT, 'tasks', 'analysis', 'lab', '_registry.jsonl');

// Below this a "trial" is mostly noise and its expectancy says little about the
// strategy. 20 is deliberately lower than any promotion floor: the question here is
// the SHAPE of the relationship, and cutting hard would throw away the low-frequency
// end that the question is about.
const DEFAULT_MIN_TRADES = 20;

// Correlation on fewer than this many trials is not reported as a number, because a
// coefficient from 5 points reads as a finding and is not one.
const MIN_TRIALS_TO_REPORT = 8;

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce(function (a, b) { return a + b; }, 0) / n;
  const my = ys.reduce(function (a, b) { return a + b; }, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;   // no variation on an axis - undefined, not zero
  return sxy / Math.sqrt(sxx * syy);
}

function readTrials(minTrades) {
  if (!fs.existsSync(REGISTRY)) return [];
  const out = [];
  for (const line of fs.readFileSync(REGISTRY, 'utf8').split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    let r;
    try { r = JSON.parse(s); } catch (err) { continue; }
    const sum = r.summary || {};
    const spec = r.spec || {};
    const n = sum.trades, e = sum.expectancyR;
    if (typeof n !== 'number' || typeof e !== 'number') continue;
    if (!(n >= minTrades)) continue;
    out.push({
      strategy: spec.strategy || String(r.family || '?').split('|')[0],
      symbol: spec.symbol || '?', timeframe: spec.timeframe || '?',
      trades: n, expectancyR: e, oosExpectancyR: sum.oosExpectancyR,
    });
  }
  return out;
}

function analyse(trials) {
  const byStrategy = new Map();
  for (const t of trials) {
    if (!byStrategy.has(t.strategy)) byStrategy.set(t.strategy, []);
    byStrategy.get(t.strategy).push(t);
  }
  const rows = [];
  for (const [strategy, list] of byStrategy) {
    // log, because trade counts span two orders of magnitude and a raw correlation
    // would be dominated by the handful of very high-frequency cells.
    const xs = list.map(function (t) { return Math.log(t.trades); });
    const ys = list.map(function (t) { return t.expectancyR; });
    rows.push({
      strategy: strategy,
      trials: list.length,
      corr: list.length >= MIN_TRIALS_TO_REPORT ? pearson(xs, ys) : null,
      medianTrades: median(list.map(function (t) { return t.trades; })),
      bestExpectancyR: Math.max.apply(null, ys),
    });
  }
  rows.sort(function (a, b) { return b.trials - a.trials; });
  return rows;
}

function median(values) {
  if (!values.length) return null;
  const v = values.slice().sort(function (a, b) { return a - b; });
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2);
}

function verdictFor(row) {
  if (row.corr === null) return 'too few trials to say (need ' + MIN_TRIALS_TO_REPORT + ')';
  if (row.trials < 50) return 'suggestive only, ' + row.trials + ' trials';
  if (row.corr <= -0.25) return 'EDGE DILUTES with frequency';
  if (row.corr >= 0.25) return 'edge HOLDS or improves with frequency';
  return 'no clear relationship';
}

function main(argv) {
  if (argv.indexOf('--selftest') >= 0) return selftest();
  const i = argv.indexOf('--min-trades');
  const minTrades = i >= 0 ? Number(argv[i + 1]) || DEFAULT_MIN_TRADES : DEFAULT_MIN_TRADES;

  const trials = readTrials(minTrades);
  const rows = analyse(trials);

  console.log('LAB FREQUENCY vs EDGE   (trials with >= ' + minTrades + ' trades: ' + trials.length + ')');
  console.log('  Does taking MORE trades cost expectancy? Per strategy, correlation of');
  console.log('  log(trade count) against expectancy across every trial already run.');
  console.log('');
  for (const r of rows) {
    console.log('  ' + r.strategy.padEnd(24)
      + 'trials ' + String(r.trials).padStart(5)
      + '   corr ' + (r.corr === null ? '  n/a ' : (r.corr >= 0 ? '+' : '') + r.corr.toFixed(3))
      + '   median trades ' + String(r.medianTrades).padStart(5)
      + '   ' + verdictFor(r));
  }
  console.log('');
  console.log('  A negative number means the extra trades are WORSE than the ones already');
  console.log('  there, so "run it more often to get evidence sooner" does not hold for that');
  console.log('  strategy. Signs differ BETWEEN strategies - this is not a general law, and');
  console.log('  reading it as one is the specific error this file was written after making.');
  return 0;
}

function selftest() {
  let failed = 0;
  const ok = function (n, c, x) {
    if (!c) { failed++; console.log('  FAIL  ' + n + (x ? '  ' + x : '')); }
    else console.log('  ok    ' + n);
  };

  // A perfect straight line must come back as +/-1, or the maths is wrong before any
  // data reaches it.
  const up = pearson([1, 2, 3, 4], [2, 4, 6, 8]);
  const down = pearson([1, 2, 3, 4], [8, 6, 4, 2]);
  ok('correlation of a rising line is +1', up !== null && Math.abs(up - 1) < 1e-9, String(up));
  ok('correlation of a falling line is -1', down !== null && Math.abs(down + 1) < 1e-9, String(down));

  // No variation is UNDEFINED, not zero. Returning 0 would read as "no relationship"
  // when the truth is "this cannot be computed".
  ok('flat input returns null rather than 0', pearson([1, 1, 1, 1], [2, 4, 6, 8]) === null);
  ok('too few points returns null', pearson([1, 2], [2, 4]) === null);

  // A correlation from a handful of trials must not be printed as a number.
  const rows = analyse([
    { strategy: 'x', trades: 30, expectancyR: 0.1 },
    { strategy: 'x', trades: 60, expectancyR: 0.2 },
    { strategy: 'x', trades: 90, expectancyR: 0.3 },
  ]);
  ok('a 3-trial strategy reports no correlation', rows.length === 1 && rows[0].corr === null);
  ok('and says so in words', verdictFor(rows[0]).indexOf('too few trials') === 0);

  // Real registry, if present: every reported correlation must be in range.
  const real = analyse(readTrials(DEFAULT_MIN_TRADES));
  const bad = real.filter(function (r) { return r.corr !== null && !(r.corr >= -1 && r.corr <= 1); });
  ok('every correlation from the real registry is within [-1, 1]', bad.length === 0,
     bad.map(function (r) { return r.strategy; }).join(','));

  // This file must not be able to reach bars, the broker or any setting.
  const whole = fs.readFileSync(__filename, 'utf8');
  const operational = whole.slice(0, whole.indexOf('function selftest')).split('\n');
  const banned = ['mt5', 'order_send', 'execute_trade', 'strategy_settings', 'loadBars', 'http'];
  const hit = banned.filter(function (b) {
    return operational.some(function (l) {
      const t = l.trim();
      if (t.indexOf('//') === 0 || t.indexOf('*') === 0) return false;
      return l.indexOf(b) >= 0;
    });
  });
  ok('reads the registry only - no bars, broker or settings', hit.length === 0, hit.join(','));

  console.log(failed ? '\nSELFTEST FAILED (' + failed + ')' : '\nselftest passed');
  return failed ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { pearson: pearson, analyse: analyse, readTrials: readTrials, verdictFor: verdictFor };
