#!/usr/bin/env node
'use strict';
/* ============================================================================
   lab_vs_random.cjs — is this strategy better than chance under identical rules?
   ============================================================================

   THE QUESTION THE LAB COULD NOT ANSWER. Our bar already has a deflated Sharpe
   against the family trial count, plateau evidence over neighbours, an
   out-of-sample split and a 2x cost stress. All four ask "is this result good,
   and is it stable?" None of them asks the question the commercial strategy
   generators put first:

       Not "is the backtest profitable?" but
       "is it better than what CHANCE would produce under identical conditions?"

   Sourced 2026-09-07 from the validation workflow the leading generators
   (Build Alpha, StrategyQuant X, Adaptrade Builder) all converge on. It is the
   one test of theirs this lab genuinely lacked.

   HOW. The candidate is run normally. Then K strategies are built from RANDOM
   entries - same instrument, same bars, same session, the SAME EXECUTION MODEL
   (ATR stop, target, trail, cost) and matched to the candidate's own trade count.
   The only thing removed is the strategy's reason for entering. If the candidate
   cannot beat that distribution, its rules contributed nothing that random timing
   would not have produced.

   WHY THIS CATCHES WHAT THE OTHER FOUR MISS. Today a breakout_zone cell reported
   SURVIVES at DSR 97.0%, then 63.7%, then 51.7% as trials accumulated - the
   deflation caught it, but only AFTER enough searching. A random baseline is
   absolute rather than relative to how much you happen to have searched, so it
   does not need the search to catch up.

   DETERMINISTIC. The RNG is seeded from the spec, so the same candidate gets the
   same baseline every time and a percentile cannot drift between runs.

   READ-ONLY on everything that matters: it loads CSV bars, runs the same
   runStrategy the lab uses, and prints. It writes no file, registers no trial,
   touches no gate, setting or order path.

   USAGE
     node tasks/lab_vs_random.cjs --strategy breakout_zone --symbol XAUUSD \
       --timeframe H4 --session any --zoneBars 7 --maxZoneAtr 1.5
     node tasks/lab_vs_random.cjs ... --runs 500
     node tasks/lab_vs_random.cjs --selftest
   ========================================================================== */

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const { STRATEGIES, loadBars, runStrategy } = require(path.join(__dirname, 'lab_strategies.cjs'));
const { validateSpec } = require(path.join(__dirname, 'lab_run.cjs'));

const DEFAULT_RUNS = 200;

/* A seeded generator, so a percentile is a property of the candidate rather than of
   when it happened to be run. mulberry32 - small, fast, good enough for shuffling
   entry bars; nothing here is cryptographic. */
function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFromSpec(spec) {
  const text = JSON.stringify(spec);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/* A strategy whose entries carry no information: random bars, random direction.
   It is deliberately NOT registered in STRATEGIES - it must never reach the
   generator, the queue or the registry. */
function randomSignalStrategy(rng, wantSignals, longFraction) {
  return {
    id: 'random_baseline',
    label: 'random entries (baseline)',
    describe: 'internal baseline only',
    params: {},
    generate(bars) {
      const out = [];
      // Uniform over the usable range, skipping the warmup the real strategies need.
      const first = 200, last = bars.n - 2;
      if (last <= first) return out;
      const picks = new Set();
      // Draw a few more than needed: duplicates and blocked bars thin the list out.
      const target = Math.min(wantSignals * 3, last - first);
      let guard = 0;
      while (picks.size < target && guard++ < target * 20) {
        picks.add(first + Math.floor(rng() * (last - first)));
      }
      for (const i of Array.from(picks).sort(function (a, b) { return a - b; })) {
        out.push({ i: i, dir: rng() < longFraction ? 'BUY' : 'SELL' });
      }
      return out;
    },
  };
}

function stats(trades) {
  const n = trades.length;
  if (!n) return { trades: 0, expectancyR: 0, netR: 0 };
  const net = trades.reduce(function (a, t) { return a + (Number(t.r) || 0); }, 0);
  return { trades: n, expectancyR: net / n, netR: net };
}

function vsRandom(spec, runs) {
  const bars = loadBars(spec.symbol, spec.timeframe);
  if (!bars || bars.n < 300) throw new Error('not enough bars for ' + spec.symbol + ' ' + spec.timeframe);

  const exec = Object.assign({}, spec.exec, { session: spec.session, symbol: spec.symbol });
  const real = stats(runStrategy(bars, STRATEGIES[spec.strategy], spec.params, exec));
  if (!real.trades) throw new Error('the candidate produced no trades - nothing to compare');

  // MATCH THE DIRECTIONAL MIX, not just the count. A long-only strategy measured in a
  // rising market against a 50/50 random baseline would look brilliant for a reason
  // that has nothing to do with its rules.
  const realTrades = runStrategy(bars, STRATEGIES[spec.strategy], spec.params, exec);
  const longs = realTrades.filter(function (t) { return t.direction === 'BUY'; }).length;
  const longFraction = realTrades.length ? longs / realTrades.length : 0.5;

  const rng = makeRng(seedFromSpec(spec));
  const sample = [];
  for (let k = 0; k < runs; k++) {
    const strat = randomSignalStrategy(rng, real.trades, longFraction);
    sample.push(stats(runStrategy(bars, strat, {}, exec)).expectancyR);
  }
  sample.sort(function (a, b) { return a - b; });

  const beaten = sample.filter(function (v) { return v < real.expectancyR; }).length;
  const percentile = 100 * beaten / sample.length;
  const q = function (p) { return sample[Math.min(sample.length - 1, Math.floor(p * sample.length))]; };

  return {
    real: real,
    longFraction: longFraction,
    runs: sample.length,
    percentile: percentile,
    randomMedian: q(0.50),
    randomP95: q(0.95),
    randomMax: sample[sample.length - 1],
    // The bar the commercial tools use: clear the BEST random result, not the median.
    // Beating the median only says the strategy is better than average nonsense.
    beatsBestRandom: real.expectancyR > sample[sample.length - 1],
    beatsP95: real.expectancyR > q(0.95),
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].indexOf('--') !== 0) continue;
    const key = argv[i].slice(2);
    const val = (i + 1 < argv.length && argv[i + 1].indexOf('--') !== 0) ? argv[++i] : true;
    out[key] = val;
  }
  return out;
}

function main(argv) {
  if (argv.indexOf('--selftest') >= 0) return selftest();
  const a = parseArgs(argv);
  if (!a.strategy || !a.symbol) {
    console.log('usage: node tasks/lab_vs_random.cjs --strategy <id> --symbol <SYM> '
      + '--timeframe H4 --session any [strategy params] [--runs N]');
    return 2;
  }
  const runs = Number(a.runs) > 0 ? Number(a.runs) : DEFAULT_RUNS;

  const params = {};
  const def = (STRATEGIES[a.strategy] || {}).params || {};
  for (const key of Object.keys(def)) if (a[key] !== undefined) params[key] = Number(a[key]);

  const spec = validateSpec({
    strategy: a.strategy, symbol: a.symbol,
    timeframe: a.timeframe || 'H4', session: a.session || 'any',
    params: params,
    exec: { atrLen: 14, atrMult: Number(a['atr-mult']) || 2, targetR: Number(a['target-r']) || 4,
            trailStartR: Number(a['trail-start']) || 2, trailGiveR: Number(a['trail-give']) || 4,
            maxHoldBars: 0, costR: Number(a.cost) || 0.05 },
  });

  const r = vsRandom(spec, runs);
  console.log('VS RANDOM   ' + spec.strategy + '  ' + spec.symbol + ' ' + spec.timeframe + ' ' + spec.session);
  console.log('  candidate      ' + r.real.trades + ' trades   expectancy '
    + (r.real.expectancyR >= 0 ? '+' : '') + r.real.expectancyR.toFixed(4) + 'R'
    + '   net ' + (r.real.netR >= 0 ? '+' : '') + r.real.netR.toFixed(2) + 'R');
  console.log('  random x' + r.runs + '     median '
    + (r.randomMedian >= 0 ? '+' : '') + r.randomMedian.toFixed(4)
    + '   p95 ' + (r.randomP95 >= 0 ? '+' : '') + r.randomP95.toFixed(4)
    + '   best ' + (r.randomMax >= 0 ? '+' : '') + r.randomMax.toFixed(4)
    + '   (same count, same exec, ' + Math.round(r.longFraction * 100) + '% long)');
  console.log('  percentile     ' + r.percentile.toFixed(1) + '%');
  console.log('  VERDICT        ' + (r.beatsBestRandom
    ? 'BEATS EVERY random baseline'
    : r.beatsP95
      ? 'beats the 95th percentile but NOT the best random run'
      : 'INDISTINGUISHABLE FROM CHANCE - random entries did this well or better'));
  return 0;
}

function selftest() {
  let failed = 0;
  const ok = function (n, c, x) {
    if (!c) { failed++; console.log('  FAIL  ' + n + (x ? '  ' + x : '')); }
    else console.log('  ok    ' + n);
  };

  // Determinism: the same seed must give the same stream, or a percentile is noise.
  const a = makeRng(42), b = makeRng(42);
  ok('the seeded rng is deterministic', a() === b() && a() === b());
  ok('different seeds differ', makeRng(1)() !== makeRng(2)());
  ok('the spec hash is stable', seedFromSpec({ x: 1 }) === seedFromSpec({ x: 1 })
     && seedFromSpec({ x: 1 }) !== seedFromSpec({ x: 2 }));

  // The rng must stay in [0,1) or the direction split and bar picks are wrong.
  const r = makeRng(7);
  let inRange = true;
  for (let i = 0; i < 5000; i++) { const v = r(); if (!(v >= 0 && v < 1)) inRange = false; }
  ok('rng stays within [0,1)', inRange);

  // The random baseline must never be registered - it must not reach the generator,
  // the queue or the registry.
  ok('random_baseline is NOT a registered strategy',
     !Object.prototype.hasOwnProperty.call(STRATEGIES, 'random_baseline'));

  // A directional mix must be honoured, or a long-only candidate in a bull market is
  // compared against something it should beat for the wrong reason.
  const rng = makeRng(3);
  const strat = randomSignalStrategy(rng, 50, 1.0);
  const bars = loadBars('XAUUSD', 'H4');
  if (bars) {
    const sigs = strat.generate(bars);
    ok('longFraction 1.0 produces only BUY signals',
       sigs.length > 0 && sigs.every(function (s) { return s.dir === 'BUY'; }));
  } else {
    console.log('  skip  longFraction check (no XAUUSD H4 bars)');
  }

  // This file must not write anything or reach an order path.
  // Scan CODE ONLY, with every comment stripped first. Two earlier versions failed on
  // the word "registry" appearing in a sentence that explains this file must never
  // touch the registry - a guard tripping over its own documentation gets deleted
  // rather than fixed, and then nothing guards anything.
  const whole = fs.readFileSync(__filename, 'utf8');
  const body = whole.slice(0, whole.indexOf('function selftest'));
  const code = body.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  const operational = code.split('\n');
  const banned = ['writeFileSync', 'appendFileSync', 'mt5', 'order_send', 'strategy_settings', 'registry'];
  const hit = banned.filter(function (bn) {
    return operational.some(function (l) {
      const t = l.trim();
      if (t.indexOf('//') === 0 || t.indexOf('*') === 0) return false;
      return l.indexOf(bn) >= 0;
    });
  });
  ok('writes nothing and reaches no order path', hit.length === 0, hit.join(','));

  console.log(failed ? '\nSELFTEST FAILED (' + failed + ')' : '\nselftest passed');
  return failed ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { vsRandom: vsRandom, makeRng: makeRng, seedFromSpec: seedFromSpec };
