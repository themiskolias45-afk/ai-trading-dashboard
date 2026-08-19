'use strict';
/**
 * Is a regime worth MONEY, or only predictable?
 *
 * tasks/regime_forecast.cjs settled the first half: regime PERSISTS — 12 of 12
 * judgeable cells positive in every fold at 5 days — while 5 and 10-day DIRECTION
 * clears nothing. That is a genuine finding and it is also, on its own, worth zero.
 * Knowing next week is likely to be a squeeze tells you what KIND of week is coming;
 * it pays only if the engine's expectancy actually DIFFERS between those weeks.
 *
 * This measures that, and it is deliberately the harder question to pass.
 *
 * WHAT IT COMPARES. Every trade the engine takes, grouped by the regime it was taken
 * in, scored in realised R after costs, against THE SAME ASSET'S OWN ALL-TRADE MEAN in
 * the same fold. Not against zero: an asset with a +0.2R edge makes every one of its
 * regimes look profitable, and "TRENDING makes money" would then be a statement about
 * the asset, not about TRENDING.
 *
 * WHY THE BAR IS THE WORST FOLD. Same standard that keeps the gate at 70 and that
 * retired 65 as DEGRADED. A regime that beats the baseline on average but collapses in
 * one fold is one market episode wearing a rule's clothing, and the record here is
 * already littered with those: the RANGE_TRADE_SHORT-in-RANGING veto failed its own
 * year-split, and the session and setup folds cleared nothing at all.
 *
 * REPLAY ONLY, READ-ONLY. Shells out to tasks/_replay_mtf.cjs against the real project
 * root. server/index.js is never modified, no live setting is read for writing, and
 * nothing here feeds a gate, a threshold, confidence or sizing.
 *
 *   node tasks/regime_edge.cjs [--folds 4] [--gate 70] [--cost 0.05]
 */

const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function numArg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  if (i === -1 || i + 1 >= process.argv.length) return fallback;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : fallback;
}

function liveGate() {
  try {
    const p = path.join(ROOT, 'server', 'strategy_settings.json');
    if (fs.existsSync(p)) {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (Number.isFinite(parsed.confidenceThreshold)) return parsed.confidenceThreshold;
    }
  } catch (_) { /* fall through */ }
  return 70;
}

const FOLDS  = Math.max(2, numArg('--folds', 4));
const GATE   = numArg('--gate', liveGate());
const COST_R = numArg('--cost', 0.05);

// Below this many trades in a regime cell the mean is noise with a decimal point on
// it. Same floor the rejection ledger and the CRT confluence harness use.
const MIN_CELL = 30;

const ASSETS = [
  { symbol: 'XAUUSD', ticker: 'GC=F' },
  { symbol: 'SP500',  ticker: '^GSPC' },
  { symbol: 'BTCUSD', ticker: 'BTC-USD' },
];

function replayTrades(symbol, ticker) {
  const stdout = execFileSync(
    process.execPath,
    [path.join(ROOT, 'tasks', '_replay_mtf.cjs'), ROOT, symbol, ticker, String(GATE)],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, MTF_EMIT_R: '1' } }
  );
  const trades = JSON.parse(stdout);
  if (!Array.isArray(trades)) throw new Error('replay did not return an array');
  // regime is computed in generateSignalMTF and carried on every trade row. A trade
  // without one is not assigned to a bucket — it is reported as unlabelled, because
  // silently dropping it would make the cells disagree with the total.
  return trades.filter(t => Number.isFinite(t.realisedR) && Number.isFinite(t.t));
}

function mean(values) {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : null;
}

function splitIntoFolds(trades, foldCount) {
  const ordered = trades.slice().sort((a, b) => a.t - b.t);
  const per = Math.floor(ordered.length / foldCount);
  if (per === 0) return [];
  const folds = [];
  for (let f = 0; f < foldCount; f++) {
    folds.push(ordered.slice(f * per, f === foldCount - 1 ? ordered.length : (f + 1) * per));
  }
  return folds;
}

function fmt(v) {
  if (v === null || v === undefined) return '     — ';
  return ((v >= 0 ? '+' : '') + v.toFixed(3)).padStart(7);
}

const out = [];
function say(line = '') { out.push(line); console.log(line); }

say('IS A REGIME WORTH MONEY, OR ONLY PREDICTABLE?');
say(FOLDS + ' folds · gate ' + GATE + ' · cost ' + COST_R + 'R/trade');
say("Each regime's R/trade against THE SAME ASSET'S own all-trade mean in the same fold,");
say('never against zero - otherwise a profitable asset makes all of its regimes look good.');
say('Bar is the WORST FOLD, the same standard that keeps the gate at 70.');
say('Read-only - nothing here changed a live setting.');
say();

let anyPassed = false;
const failures = [];

for (const asset of ASSETS) {
  let trades;
  try {
    trades = replayTrades(asset.symbol, asset.ticker);
  } catch (err) {
    const detail = (err.stderr && String(err.stderr).trim().split('\n').pop()) || err.message;
    say('  ' + asset.symbol.padEnd(7) + ' FAILED - replay error: ' + detail);
    failures.push(asset.symbol + ': ' + detail);
    say();
    continue;
  }

  const unlabelled = trades.filter(t => !t.regime).length;
  say('  ' + asset.symbol + ' (' + asset.ticker + ')  ' + trades.length + ' trades'
    + (unlabelled ? '   ' + unlabelled + ' carry NO regime and are excluded from cells' : ''));

  const folds = splitIntoFolds(trades, FOLDS);
  const regimes = [...new Set(trades.map(t => t.regime).filter(Boolean))].sort();

  // The baseline, per fold: every trade this asset took in that fold.
  const baseline = folds.map(f => mean(f.map(t => t.realisedR - COST_R)));
  say('     baseline (all trades) ' + baseline.map(fmt).join('') + '   n=' + trades.length);

  for (const regime of regimes) {
    const perFold = folds.map((f, i) => {
      const cell = f.filter(t => t.regime === regime).map(t => t.realisedR - COST_R);
      if (cell.length < Math.max(5, Math.floor(MIN_CELL / FOLDS))) return null;
      const m = mean(cell);
      return m === null || baseline[i] === null ? null : m - baseline[i];
    });

    const total = trades.filter(t => t.regime === regime).length;
    const judged = perFold.filter(v => v !== null);
    const better = judged.filter(v => v > 0).length;
    const worst = judged.length ? Math.min(...judged) : null;

    let verdict;
    if (total < MIN_CELL) {
      verdict = 'TOO FEW (' + total + ' < ' + MIN_CELL + ')';
    } else if (judged.length === 0) {
      verdict = 'TOO FEW per fold to judge';
    } else if (better > judged.length / 2 && worst > 0) {
      verdict = 'PASS - better in ' + better + '/' + judged.length + ' folds, worst fold still ahead';
      anyPassed = true;
    } else if (better > judged.length / 2) {
      verdict = 'REJECT - ' + better + '/' + judged.length + ' folds but worst fold ' + fmt(worst).trim();
    } else {
      verdict = 'REJECT - better in only ' + better + '/' + judged.length + ' folds';
    }

    say('     ' + regime.padEnd(10) + ' vs base ' + perFold.map(fmt).join('')
      + '   n=' + String(total).padStart(4) + '  ' + verdict);
  }
  say();
}

say('  VERDICT');
if (failures.length) {
  say('    INCOMPLETE - ' + failures.length + ' asset(s) did not measure:');
  failures.forEach(f => say('      ' + f));
}
say(anyPassed
  ? '    At least one regime beats its own asset baseline on the worst fold. That is the'
  + '\n    first thing measured here that could justify conditioning on regime.'
  : '    NO regime beats its own asset baseline on the worst-fold standard. Regime is'
  + '\n    PREDICTABLE (regime_forecast.cjs, 12/12 cells) and NOT PROFITABLE - knowing what'
  + '\n    kind of week is coming does not tell you how to trade it. Nothing to wire.');
say();
say('  Nothing here changed a live setting.');

const logPath = path.join(ROOT, 'tasks', 'logs', 'regime_edge.txt');
try {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, out.join('\n') + '\n', 'utf8');
  console.log('\n  written: ' + path.relative(ROOT, logPath));
} catch (e) {
  console.error('could not write ' + logPath + ': ' + e.message);
}

process.exit(failures.length ? 1 : 0);
