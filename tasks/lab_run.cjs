#!/usr/bin/env node
'use strict';
/* ============================================================================
   lab_run.cjs — run ONE candidate: spec -> bars -> trades -> judgement
   ============================================================================

   The runner. It owns the pipeline and nothing else owns any part of it:

     validateSpec  ->  loadBars  ->  runStrategy  ->  buildReport  ->  register

   THE TRIAL COUNT IS NOT A FLAG HERE. tasks/lab_report.cjs accepts `--trials` as a
   number you type, which is honest but voluntary, and a voluntary penalty is one
   that gets quietly under-reported exactly when the honest value is embarrassing.
   This runner takes it from tasks/lab_registry.cjs instead, derived from what is
   already on disk. Search more, and the bar you must clear rises on its own.

   VALIDATION LIVES HERE, ONCE. The queue endpoint on the server hands untrusted
   input to `validateSpec` rather than doing its own checks, because validation
   implemented twice is validation that disagrees. Every parameter is clamped to
   the range its strategy declares, the strategy id and session are allowlisted,
   and nothing from the caller ever reaches a file path or a require.

   USAGE
     node tasks/lab_run.cjs --strategy ema_cross --symbol XAUUSD --timeframe M15 \
       --session london --fast 20 --slow 50 \
       --atr-mult 2.0 --target-r 2.0 --trail-start 2.0 --trail-give 4.0 --cost 0.05
     node tasks/lab_run.cjs --spec '<json>'
     node tasks/lab_run.cjs --selftest
   ========================================================================== */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { STRATEGIES, SESSIONS, TIMEFRAMES, loadBars, availableSymbols, runStrategy } =
  require(path.join(__dirname, 'lab_strategies.cjs'));
const { buildReport } = require(path.join(__dirname, 'lab_report.cjs'));
const registry = require(path.join(__dirname, 'lab_registry.cjs'));

const LAB_DIR = path.join(ROOT, 'tasks', 'analysis', 'lab');

// Execution settings, with the ranges they are clamped to. A caller cannot ask for
// a 500R target or a zero-width stop.
const EXEC_SPEC = {
  atrLen:      { def: 14,   min: 2,    max: 200 },
  atrMult:     { def: 2.0,  min: 0.25, max: 10 },
  targetR:     { def: 2.0,  min: 0,    max: 20 },   // 0 disables the target
  trailStartR: { def: 0,    min: 0,    max: 20 },   // 0 disables the trail
  trailGiveR:  { def: 1.0,  min: 0.1,  max: 20 },
  maxHoldBars: { def: 0,    min: 0,    max: 5000 }, // 0 = no limit
  costR:       { def: 0.05, min: 0,    max: 1 },
};

function clamp(v, lo, hi, def) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Turn arbitrary input into a spec that is safe to run, or throw with a reason.
 * THE ONLY validator. The HTTP queue calls this; the CLI calls this.
 */
function validateSpec(input) {
  if (!input || typeof input !== 'object') throw new Error('spec must be an object');

  const strategy = String(input.strategy || '');
  if (!Object.prototype.hasOwnProperty.call(STRATEGIES, strategy)) {
    throw new Error('unknown strategy: ' + strategy + ' (have: ' + Object.keys(STRATEGIES).join(', ') + ')');
  }
  const def = STRATEGIES[strategy];

  const symbol = String(input.symbol || '').toUpperCase();
  // Allowlisted against what is actually ON DISK, so a symbol string can never
  // reach a path join unless a matching CSV already exists.
  if (!availableSymbols().includes(symbol)) {
    throw new Error('unknown symbol: ' + symbol + ' (have: ' + availableSymbols().join(', ') + ')');
  }
  const timeframe = String(input.timeframe || 'M15').toUpperCase();
  if (!TIMEFRAMES.includes(timeframe)) throw new Error('unknown timeframe: ' + timeframe);

  const session = String(input.session || 'any').toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(SESSIONS, session)) {
    throw new Error('unknown session: ' + session + ' (have: ' + Object.keys(SESSIONS).join(', ') + ')');
  }

  // Parameters: only the ones this strategy declares, each clamped to its range.
  // An unknown key is dropped rather than passed through, so a caller cannot smuggle
  // a field into the spec hash and inflate the registry with fake distinct trials.
  const params = {};
  const inParams = (input.params && typeof input.params === 'object') ? input.params : {};
  for (const [k, d] of Object.entries(def.params)) {
    params[k] = clamp(inParams[k], d.min, d.max, d.def);
  }

  const exec = {};
  const inExec = (input.exec && typeof input.exec === 'object') ? input.exec : {};
  for (const [k, d] of Object.entries(EXEC_SPEC)) {
    exec[k] = clamp(inExec[k], d.min, d.max, d.def);
  }

  return { strategy, symbol, timeframe, session, params, exec };
}

/** A filesystem- and URL-safe name. Must satisfy the API's /^[A-Za-z0-9_-]+$/. */
function nameFor(spec) {
  const p = Object.entries(spec.params).map(([k, v]) => k + String(v)).join('-');
  const raw = [spec.strategy, spec.symbol, spec.timeframe, spec.session, p,
    registry.specHash(spec).slice(0, 6)].join('-');
  return raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 90);
}

/** A one-line human description, for the artifact label and the leaderboard. */
function labelFor(spec) {
  const p = Object.entries(spec.params).map(([k, v]) => k + ':' + v).join(' ');
  const trail = spec.exec.trailStartR > 0
    ? ' trail:' + spec.exec.trailStartR + ',' + spec.exec.trailGiveR : '';
  return [spec.strategy, p, spec.symbol + ' ' + spec.timeframe,
    'stop:' + spec.exec.atrMult + 'xATR',
    spec.exec.targetR > 0 ? 'target:' + spec.exec.targetR + 'R' : 'no target',
    trail.trim(), spec.session].filter(Boolean).join(' · ');
}

function runOne(input, opts) {
  const spec = validateSpec(input);
  const bars = loadBars(spec.symbol, spec.timeframe);
  if (!bars || bars.n < 200) {
    throw new Error('not enough bars for ' + spec.symbol + ' ' + spec.timeframe
      + ' (' + (bars ? bars.n : 0) + ')');
  }

  const trades = runStrategy(bars, STRATEGIES[spec.strategy], spec.params,
    { ...spec.exec, session: spec.session, symbol: spec.symbol });

  // AUTOMATIC, from the registry. Not a flag, on purpose.
  const trials = registry.trialsFor(spec);

  const report = buildReport(trades, {
    label: labelFor(spec),
    isFrac: 0.7,
    // The executor ALREADY charged spec.exec.costR per trade, so the report's own
    // cost increment is what the STRESS test adds on top. Passing the same figure
    // again here would double-charge the baseline.
    costR: spec.exec.costR > 0 ? spec.exec.costR : 0.05,
    trials,
    tradesFile: null,
  });
  report.spec = spec;
  report.specHash = registry.specHash(spec);
  report.trialsFrom = 'registry (automatic)';
  report.barsUsed = { n: bars.n,
    from: new Date(bars.t[0] * 1000).toISOString().slice(0, 10),
    to: new Date(bars.t[bars.n - 1] * 1000).toISOString().slice(0, 10) };

  const name = (opts && opts.name) || nameFor(spec);
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error('derived an unsafe name: ' + name);

  fs.mkdirSync(LAB_DIR, { recursive: true });
  fs.writeFileSync(path.join(LAB_DIR, name + '.json'), JSON.stringify(report, null, 2));

  registry.register({
    name, spec,
    summary: {
      verdict: report.assessment.verdict,
      trades: report.denominators.all,
      trials,
      expectancyR: report.all.expectancyR,
      oosExpectancyR: report.outOfSample ? report.outOfSample.expectancyR : null,
      profitFactor: report.all.profitFactor,
      oosProfitFactor: report.outOfSample ? report.outOfSample.profitFactor : null,
      deflatedSharpe: report.deflated.deflatedSharpe,
      totalR: report.all.totalR,
      maxDrawdownR: report.all.maxDrawdownR,
    },
  });

  return { name, spec, report, trials, trades: trades.length };
}

// ── self-test ───────────────────────────────────────────────────────────────
function selftest() {
  let failed = 0;
  const ok = (n, c, x) => { if (!c) { failed++; console.log('  FAIL  ' + n + (x ? '  ' + x : '')); } else console.log('  ok    ' + n); };

  ok('rejects an unknown strategy',
    (() => { try { validateSpec({ strategy: 'nope', symbol: 'XAUUSD' }); return false; } catch (e) { return true; } })());
  ok('rejects an unknown symbol',
    (() => { try { validateSpec({ strategy: 'ema_cross', symbol: 'HACK' }); return false; } catch (e) { return true; } })());
  ok('rejects a traversal symbol',
    (() => { try { validateSpec({ strategy: 'ema_cross', symbol: '../../SERVER' }); return false; } catch (e) { return true; } })());
  ok('rejects an unknown session',
    (() => { try { validateSpec({ strategy: 'ema_cross', symbol: 'XAUUSD', session: 'moon' }); return false; } catch (e) { return true; } })());

  const s = validateSpec({ strategy: 'ema_cross', symbol: 'XAUUSD', timeframe: 'M15',
    params: { fast: -999, slow: 99999, bogus: 5 }, exec: { atrMult: 1e9, costR: -3 } });
  ok('clamps a parameter below its minimum', s.params.fast === STRATEGIES.ema_cross.params.fast.min, 'got ' + s.params.fast);
  ok('clamps a parameter above its maximum', s.params.slow === STRATEGIES.ema_cross.params.slow.max, 'got ' + s.params.slow);
  ok('drops an undeclared parameter', !('bogus' in s.params));
  ok('clamps exec settings', s.exec.atrMult === EXEC_SPEC.atrMult.max && s.exec.costR === 0,
    'got ' + s.exec.atrMult + '/' + s.exec.costR);
  ok('defaults a missing parameter', validateSpec({ strategy: 'ema_cross', symbol: 'XAUUSD' }).params.fast
    === STRATEGIES.ema_cross.params.fast.def);

  const nm = nameFor(s);
  ok('derived name is API-safe', /^[A-Za-z0-9_-]+$/.test(nm), nm);

  console.log('');
  console.log(failed === 0 ? '  ALL CHECKS PASSED' : '  ' + failed + ' CHECK(S) FAILED');
  return failed;
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function main() {
  const argv = process.argv.slice(2);
  const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };

  if (argv.includes('--selftest')) process.exit(selftest() === 0 ? 0 : 1);

  if (argv.includes('--list')) {
    console.log('');
    for (const s of Object.values(STRATEGIES)) {
      console.log('  ' + s.id.padEnd(18) + s.label);
      console.log('  ' + ' '.repeat(18) + Object.entries(s.params)
        .map(([k, d]) => k + '=' + d.def + ' [' + d.min + '..' + d.max + ']').join('  '));
    }
    console.log('');
    console.log('  symbols:    ' + availableSymbols().join(', '));
    console.log('  timeframes: ' + TIMEFRAMES.join(', '));
    console.log('  sessions:   ' + Object.keys(SESSIONS).join(', '));
    console.log('');
    process.exit(0);
  }

  let input;
  const specJson = opt('--spec', null);
  if (specJson) {
    try { input = JSON.parse(specJson); }
    catch (e) { console.error('bad --spec json: ' + e.message); process.exit(2); }
  } else {
    const strategy = opt('--strategy', 'ema_cross');
    const def = STRATEGIES[strategy];
    const params = {};
    if (def) for (const k of Object.keys(def.params)) {
      const v = opt('--' + k, undefined);
      if (v !== undefined) params[k] = Number(v);
    }
    input = {
      strategy,
      symbol: opt('--symbol', 'XAUUSD'),
      timeframe: opt('--timeframe', 'M15'),
      session: opt('--session', 'any'),
      params,
      exec: {
        atrLen:      opt('--atr-len', undefined),
        atrMult:     opt('--atr-mult', undefined),
        targetR:     opt('--target-r', undefined),
        trailStartR: opt('--trail-start', undefined),
        trailGiveR:  opt('--trail-give', undefined),
        maxHoldBars: opt('--max-hold', undefined),
        costR:       opt('--cost', undefined),
      },
    };
  }

  let res;
  try { res = runOne(input, { name: opt('--name', null) }); }
  catch (e) { console.error('lab_run: ' + e.message); process.exit(1); }

  const r = res.report, a = r.assessment;
  console.log('');
  console.log('  ' + labelFor(res.spec));
  console.log('  bars ' + r.barsUsed.n + '  ' + r.barsUsed.from + ' .. ' + r.barsUsed.to
    + '   trades ' + res.trades);
  console.log('  TRIALS IN THIS FAMILY: ' + res.trials + '  (automatic, from the registry)');
  console.log('');
  console.log('  expectancy ' + (r.all.expectancyR || 0).toFixed(4) + 'R'
    + '   PF ' + (r.all.profitFactor || 0).toFixed(3)
    + '   OOS exp ' + (r.outOfSample.expectancyR || 0).toFixed(4) + 'R'
    + '   DSR ' + (r.deflated.deflatedSharpe === null ? 'n/a'
        : (r.deflated.deflatedSharpe * 100).toFixed(1) + '%'));
  console.log('  VERDICT: ' + a.verdict + '  (' + a.checksPassed + ' passed, '
    + (a.checksFailed || 0) + ' failed, ' + (a.checksUnknown || 0) + ' unresolved)');
  console.log('  artifact -> tasks/analysis/lab/' + res.name + '.json');
  console.log('');
  process.exit(0);
}

if (require.main === module) main();

module.exports = { validateSpec, runOne, nameFor, labelFor, EXEC_SPEC, selftest };
