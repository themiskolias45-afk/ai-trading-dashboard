'use strict';
/**
 * Can this system know NEXT WEEK's regime — or next week's direction — in advance?
 *
 * Two different questions get mixed together whenever anyone asks this, and they have
 * opposite answers, so this measures them separately:
 *
 *   Q1  PERSISTENCE.  Given today's regime, what is the regime in 5 or 10 trading
 *       days? Compared against the base rate, because "TRENDING is still TRENDING
 *       60% of the time" means nothing if TRENDING is 60% of all days anyway. The
 *       number that matters is the LIFT over guessing the most common label.
 *
 *   Q2  DIRECTION.  Given today's regime, is price higher in 5 or 10 days? Again
 *       against the base rate — an instrument that rose on 54% of all 5-day windows
 *       makes a 54% conditional hit rate worth exactly zero.
 *
 * WHY THE ENGINE'S OWN REGIME AND NOT A NEW ONE. The label is lifted out of
 * server/index.js and computed by the engine's real generateSignal, so what this
 * measures is the thing the dashboard actually shows and the thing any future rule
 * would read. A regime re-derived here would answer a question nobody is asking.
 *
 *     TRENDING  trend is STRONG UPTREND or STRONG DOWNTREND
 *     SQUEEZE   Bollinger bandwidth < 8
 *     VOLATILE  Bollinger bandwidth > 25
 *     RANGING   everything else
 *
 * FOLDS, NOT ONE NUMBER. Persistence has nothing to fit, so folds are not guarding
 * against overfitting here — they are guarding against ONE LUCKY STRETCH. A market
 * that trended for eight months will show enormous persistence over a window that
 * contains those eight months and none either side. An effect that is real shows up
 * in most folds; an artifact shows up in one.
 *
 * NO LOOK-AHEAD. Every regime is computed from a trailing window ending at that bar,
 * exactly as the live engine sees it. The only forward-looking value is the outcome
 * being predicted, which is the point.
 *
 * READ-ONLY. Parses server/index.js as text, reads tasks/history/*_D1.csv, writes one
 * log. It starts nothing, changes no setting, and feeds no gate.
 *
 *   node tasks/regime_forecast.cjs [--folds 4] [--horizons 5,10]
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.join(__dirname, '..');

function numArg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  if (i === -1 || i + 1 >= process.argv.length) return fallback;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : fallback;
}
function listArg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  if (i === -1 || i + 1 >= process.argv.length) return fallback;
  const parsed = process.argv[i + 1].split(',').map(Number).filter(Number.isFinite);
  return parsed.length ? parsed : fallback;
}

const FOLDS     = Math.max(2, numArg('--folds', 4));
const HORIZONS  = listArg('--horizons', [5, 10]);

// generateSignal needs EMA200 plus headroom; _replay_mtf uses the same figure.
const WINDOW = 400;
// Below this many observations in a fold x regime cell, the percentage is noise
// dressed as a finding. 20 is the floor at which a single flip moves the number by
// less than 5 points.
const MIN_CELL = 20;

const ASSETS = ['XAUUSD', 'SP500', 'BTCUSD'];
const REGIMES = ['TRENDING', 'RANGING', 'SQUEEZE', 'VOLATILE'];

// ── lift the engine out of server/index.js ───────────────────────────────────
const serverSrc = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');

function extractBlock(startMarker) {
  const start = serverSrc.indexOf(startMarker);
  if (start === -1) return '';
  let depth = 0;
  for (let j = serverSrc.indexOf('{', start); j < serverSrc.length; j++) {
    if (serverSrc[j] === '{') depth++;
    else if (serverSrc[j] === '}' && --depth === 0) return serverSrc.slice(start, j + 1);
  }
  return '';
}

// Same list and same reasoning as tasks/_replay_mtf.cjs: a missing scalar throws
// inside the engine, the caller's catch swallows it, and the result looks exactly
// like "this cohort never occurred". Read from source, never hardcoded.
const SCALAR_CONSTS = [
  'SIZING_BOOST_MIN_CONFIDENCE', 'STRUCTURAL_STOP_MIN_ATR',
  'GOLD_SQUEEZE_MODERATE_CONFIDENCE', 'EMA_SMA_SEED_MIN_MULTIPLE',
  'SPX_H4_ONLY_BLOCKED_FLOOR',
  // ADDED 2026-09-03. These SIX were all missing at once and the harness was returning
  // essentially nothing to every caller: measured before the fix, the identical six were missing here too. Every one of them
  // is read on a branch of generateSignal, so a single absence throws on every bar the
  // branch can reach and the caller's catch turns it into 'that setup never fired' — a
  // silent wrong answer, not an error. SELL_BOUNCE_REQUIRE_DOWNTREND broke it first on
  // 2026-09-01 and nobody noticed for two days.
  //
  // THE LIST IS THE BUG. This file already carried a comment saying 'whenever
  // server/index.js gains a top-level const that generateSignal reads, it has to be added
  // here too' — and then it happened five more times. A rule enforced by remembering is
  // enforced by nothing; tasks/harness_consts_check.cjs now derives the required set from
  // the source and fails when a harness is short.
  'BUY_DIP_REQUIRE_MACD_BULLISH',
  'BUY_DIP_RSI_MAX',
  'MOMENTUM_REQUIRE_MACD_BULLISH',
  'MOMENTUM_MACD_EXEMPT_TICKERS',
  'SELL_BOUNCE_REQUIRE_DOWNTREND',
  'TREND_FOLLOW_REQUIRE_MACD_BULLISH',
];
const NEEDED = [
  'function emaSeries', 'function calcRSI', 'function calcBB', 'function calcMACD',
  'function atr(', 'function wilderSmooth', 'function calcADX',
  'function findSwingLow', 'function findSwingHigh',
  'function calcPivots', 'function getCurrentSession', 'function generateSignal(',
];

let code = '';
for (const name of SCALAR_CONSTS) {
  const m = serverSrc.match(new RegExp('^const\\s+' + name + '\\s*=\\s*([^;]+);', 'm'));
  if (!m) {
    console.error('could not extract const ' + name + ' from server/index.js — refusing to run, '
      + 'because a missing const throws inside the engine and the result silently looks '
      + 'like "this regime never occurred".');
    process.exit(1);
  }
  code += 'const ' + name + ' = ' + m[1].trim() + ';\n';
}
for (const marker of NEEDED) {
  const block = extractBlock(marker);
  if (!block) { console.error('could not extract ' + marker); process.exit(1); }
  code += block + '\n';
}

let settings = { confidenceThreshold: 70, minStrength: 'MODERATE', minEntryRsi: 0 };
try {
  const p = path.join(ROOT, 'server', 'strategy_settings.json');
  if (fs.existsSync(p)) Object.assign(settings, JSON.parse(fs.readFileSync(p, 'utf8')));
} catch (_) { /* defaults are fine — the regime label does not read the gate */ }

const sandbox = {
  strategySettings: settings,
  priceCache: {}, sentimentCache: {}, signalCache: {},
  getLearningBoost: () => 0,
  logGateRejection: () => false,
  noteGatePass: () => {},
  console,
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const generateSignal = sandbox.generateSignal;

// The engine computes `regime` inside generateSignalMTF, not inside generateSignal,
// so it is reproduced here from the SAME two inputs the engine uses. Kept beside a
// literal copy of the source lines so a drift is visible on sight.
//
//   const regime =
//     (daily.trend === "STRONG UPTREND" || daily.trend === "STRONG DOWNTREND") ? "TRENDING" :
//     (bbW && bbW < 8) ? "SQUEEZE" :
//     (bbW && bbW > 25) ? "VOLATILE" : "RANGING";
//
// Verified against server/index.js at load time below, so this cannot rot silently.
const SQUEEZE_MAX_BANDWIDTH  = 8;
const VOLATILE_MIN_BANDWIDTH = 25;

function regimeOf(signal) {
  if (!signal) return null;
  const bbW = signal.indicators && signal.indicators.bb ? signal.indicators.bb.bandwidth : null;
  if (signal.trend === 'STRONG UPTREND' || signal.trend === 'STRONG DOWNTREND') return 'TRENDING';
  if (bbW && bbW < SQUEEZE_MAX_BANDWIDTH) return 'SQUEEZE';
  if (bbW && bbW > VOLATILE_MIN_BANDWIDTH) return 'VOLATILE';
  return 'RANGING';
}

// A copy of a rule is a rule that drifts. This asserts the two thresholds still match
// the engine's source, and refuses rather than measuring a regime the system no longer
// uses.
{
  const live = serverSrc.match(/\(bbW && bbW < (\d+)\) \? "SQUEEZE" :\s*\r?\n\s*\(bbW && bbW > (\d+)\) \? "VOLATILE"/);
  if (!live) {
    console.error('could not find the regime rule in server/index.js — it has been rewritten. '
      + 'Re-read it and update regimeOf() before trusting any number from this harness.');
    process.exit(1);
  }
  if (Number(live[1]) !== SQUEEZE_MAX_BANDWIDTH || Number(live[2]) !== VOLATILE_MIN_BANDWIDTH) {
    console.error('regime thresholds have MOVED in server/index.js: squeeze<' + live[1]
      + ' volatile>' + live[2] + ', this harness has ' + SQUEEZE_MAX_BANDWIDTH + '/'
      + VOLATILE_MIN_BANDWIDTH + '. Refusing to measure a rule the system does not run.');
    process.exit(1);
  }
}

// ── bars ─────────────────────────────────────────────────────────────────────
function loadDaily(symbol) {
  const p = path.join(ROOT, 'tasks', 'history', symbol + '_D1.csv');
  if (!fs.existsSync(p)) return null;
  const lines = fs.readFileSync(p, 'utf8').trim().split(/\r?\n/);
  const head = lines[0].split(',').map(s => s.trim().toLowerCase());
  const iT = head.indexOf('time'), iH = head.indexOf('high'),
        iL = head.indexOf('low'),  iC = head.indexOf('close');
  const iV = head.findIndex(h => h.includes('volume'));
  const bars = [];
  for (const line of lines.slice(1)) {
    const f = line.split(',');
    const bar = { t: +f[iT], h: +f[iH], l: +f[iL], c: +f[iC], v: iV >= 0 ? +f[iV] : 0 };
    if ([bar.t, bar.h, bar.l, bar.c].every(Number.isFinite)) bars.push(bar);
  }
  return bars;
}

function pct(n, d) { return d > 0 ? (100 * n / d) : null; }
function fmtPct(v) { return v === null ? '   —  ' : (v >= 0 ? ' ' : '') + v.toFixed(1) + '%'; }
function fmtLift(v) { return v === null ? '   —  ' : (v >= 0 ? '+' : '') + v.toFixed(1) + 'pp'; }

const out = [];
function say(line = '') { out.push(line); console.log(line); }

say('CAN THE SYSTEM SEE NEXT WEEK COMING?');
say(FOLDS + ' sequential folds - horizons ' + HORIZONS.join(', ') + ' trading days');
say("Regime is the ENGINE'S own label, computed point-in-time from a trailing window.");
say('Every conditional figure is shown against the BASE RATE in the same fold, because');
say('a hit rate only means something as a LIFT over guessing the most common answer.');
say('Read-only - nothing here feeds a gate, a threshold, confidence or sizing.');
say();

for (const symbol of ASSETS) {
  const bars = loadDaily(symbol);
  if (!bars || bars.length < WINDOW + 60) {
    say('  ' + symbol + '  SKIPPED - ' + (bars ? bars.length + ' bars, need ' + (WINDOW + 60) : 'no history file'));
    say();
    continue;
  }

  // Point-in-time regime for every bar the window allows.
  const labels = new Array(bars.length).fill(null);
  let threw = 0;
  for (let i = WINDOW; i < bars.length; i++) {
    const from = i - WINDOW + 1;
    const w = bars.slice(from, i + 1);
    try {
      const sig = generateSignal(symbol, symbol, w.map(b => b.c), w.map(b => b.h),
        w.map(b => b.l), w.map(b => b.v), null, { timeframe: 'D1' });
      labels[i] = regimeOf(sig);
    } catch (e) { threw++; }
  }

  const usable = labels.map((r, i) => (r ? i : -1)).filter(i => i >= 0);
  say('  ' + symbol + '  -  ' + usable.length + ' labelled days'
    + (threw ? '   (' + threw + ' steps threw and are EXCLUDED, not counted as a regime)' : ''));

  // Overall regime mix, so the base rates below are interpretable.
  const mix = {};
  for (const i of usable) mix[labels[i]] = (mix[labels[i]] || 0) + 1;
  say('     mix: ' + REGIMES.map(r => r + ' ' + (pct(mix[r] || 0, usable.length) || 0).toFixed(0) + '%').join('   '));

  const foldSize = Math.floor(usable.length / FOLDS);

  for (const H of HORIZONS) {
    say();
    say('     ---- ' + H + ' trading days ahead ----');

    // Q1 PERSISTENCE
    say('     Q1  Is the regime the SAME in ' + H + ' days?');
    say('         regime        ' + Array.from({ length: FOLDS }, (_, f) => 'fold' + (f + 1)).join('  ').padEnd(FOLDS * 8)
      + '   lift vs base rate');
    for (const regime of REGIMES) {
      const perFold = [];
      for (let f = 0; f < FOLDS; f++) {
        const slice = usable.slice(f * foldSize, f === FOLDS - 1 ? usable.length : (f + 1) * foldSize);
        const pairs = slice.filter(i => i + H < bars.length && labels[i + H]);
        if (!pairs.length) { perFold.push(null); continue; }
        const inRegime = pairs.filter(i => labels[i] === regime);
        if (inRegime.length < MIN_CELL) { perFold.push(null); continue; }
        const stayed = inRegime.filter(i => labels[i + H] === regime).length;
        // Base rate for THIS fold: how often the label appears at t+H regardless of
        // what it was at t. Anything the base rate already explains is not knowledge.
        const base = pct(pairs.filter(i => labels[i + H] === regime).length, pairs.length);
        const cond = pct(stayed, inRegime.length);
        perFold.push(cond === null || base === null ? null : cond - base);
      }
      const judged = perFold.filter(v => v !== null);
      const positive = judged.filter(v => v > 0).length;
      say('         ' + regime.padEnd(12)
        + perFold.map(v => fmtLift(v).padStart(8)).join('')
        + '    ' + (judged.length
          ? positive + '/' + judged.length + ' folds positive'
          : 'too few observations'));
    }

    // Q2 DIRECTION
    say('     Q2  Is price HIGHER in ' + H + ' days, given today\'s regime?');
    say('         regime        ' + Array.from({ length: FOLDS }, (_, f) => 'fold' + (f + 1)).join('  ').padEnd(FOLDS * 8)
      + '   lift vs base rate');
    for (const regime of REGIMES) {
      const perFold = [];
      for (let f = 0; f < FOLDS; f++) {
        const slice = usable.slice(f * foldSize, f === FOLDS - 1 ? usable.length : (f + 1) * foldSize);
        const pairs = slice.filter(i => i + H < bars.length);
        if (!pairs.length) { perFold.push(null); continue; }
        const inRegime = pairs.filter(i => labels[i] === regime);
        if (inRegime.length < MIN_CELL) { perFold.push(null); continue; }
        const up = inRegime.filter(i => bars[i + H].c > bars[i].c).length;
        const base = pct(pairs.filter(i => bars[i + H].c > bars[i].c).length, pairs.length);
        const cond = pct(up, inRegime.length);
        perFold.push(cond === null || base === null ? null : cond - base);
      }
      const judged = perFold.filter(v => v !== null);
      const positive = judged.filter(v => v > 0).length;
      say('         ' + regime.padEnd(12)
        + perFold.map(v => fmtLift(v).padStart(8)).join('')
        + '    ' + (judged.length
          ? positive + '/' + judged.length + ' folds positive'
          : 'too few observations'));
    }
  }
  say();
}

say('  HOW TO READ THIS');
say('    A lift near zero means the regime label told you nothing you did not already');
say('    know from the base rate. A lift that is large in ONE fold and not the others is');
say('    one market episode, not a forecast. Only a lift positive in MOST folds, at a');
say('    size that survives costs, is a signal - and Q1 and Q2 are different claims:');
say('    persistence of a REGIME is not the same as knowing DIRECTION.');

const logPath = path.join(ROOT, 'tasks', 'logs', 'regime_forecast.txt');
try {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, out.join('\n') + '\n', 'utf8');
  console.log('\n  written: ' + path.relative(ROOT, logPath));
} catch (e) {
  console.error('could not write ' + logPath + ': ' + e.message);
}
