#!/usr/bin/env node
'use strict';
/* ============================================================================
   param_sensitivity.cjs — PLATEAU OR SPIKE, on the settings actually in force
   ============================================================================
   THE QUESTION NOTHING ELSE ON THE ROBUSTNESS PAGE ASKS.

   The Monte-Carlo bootstrap resamples the SAME trades: it shows the range of luck
   around an edge and cannot tell you whether the edge exists. CPCV asks whether it
   survives being split differently. PBO asks whether "pick the best in-sample" is a
   sound procedure at all. Deflated Sharpe corrects for how many candidates were tried.

   None of them asks the question a curve-fit strategy fails: IS THIS PARAMETER VALUE
   SITTING ON A PLATEAU, OR ON A SPIKE?

   A robust setting degrades gracefully when nudged. A curve-fit one collapses, because
   it was chosen for a peak that history happened to contain. The published guidance is
   consistent: perturb by 10-20%, and a strategy is robust when the large majority of
   perturbations stay profitable, fragile when about half do.

   WHY IT IS THE LIVE SETTINGS AND NOT THE LAB'S.
   tasks/lab_promote.cjs already gates lab candidates on plateau evidence, and that is
   good. But the values ACTUALLY IN FORCE - the confidence gate, MIN_RR, the ADX floor,
   the RSI ceilings - have never been put through it. They were inherited, tuned by hand,
   or settled by a single walk-forward, and nothing has ever asked whether the number
   beside them is a plateau or a lucky peak.

   WHAT IT DOES NOT DO.
   It changes nothing. It runs the replay with overridden parameters, in a child process,
   and prints. No setting is written, no gate moves, no order is placed. It is a
   measurement of the settings, not a tuner for them - deliberately, because a tool that
   both measures and adjusts is how a system tunes itself onto a spike.

   USAGE
     node tasks/param_sensitivity.cjs                 # every axis, default grid
     node tasks/param_sensitivity.cjs --axis gate     # one axis
     node tasks/param_sensitivity.cjs --assets XAUUSD
     node tasks/param_sensitivity.cjs --selftest
     node tasks/param_sensitivity.cjs --json
   ========================================================================== */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'tasks', 'analysis', 'param-sensitivity.json');

// The live system has NO max-hold, so a short cap deletes trades rather than being
// conservative. Every run here uses the honest horizon; a sensitivity study on a
// truncated sample would be measuring the truncation.
const MAX_HOLD = String(process.env.MTF_MAX_HOLD || 320);
const COST_R = 0.05;

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const has = n => argv.includes(n);

const ASSETS = String(opt('--assets', 'XAUUSD,BTCUSD,SP500')).split(',').map(s => s.trim());
const TICKERS = { XAUUSD: 'GC=F', BTCUSD: 'BTC-USD', SP500: '^GSPC' };

/* ── the axes, with the LIVE value marked ────────────────────────────────────
   Each axis names the env override the replay reads, the value in force, and the
   neighbourhood to test. The neighbours are not arbitrary: they are roughly +/-10%
   and +/-20% of the live value, which is the perturbation band the literature uses. */
function liveSettings() {
  const p = path.join(ROOT, 'server', 'strategy_settings.json');
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { /* defaults below */ }
  return {
    gate: Number(saved.confidenceThreshold ?? 70),
    adx: Number(saved.adxTrendingMin ?? 20),
    momentumRsiMax: Number(saved.momentumRsiMax ?? 80),
    trendFollowRsiMax: Number(saved.trendFollowRsiMax ?? 76),
  };
}

function buildAxes() {
  const live = liveSettings();
  return {
    gate: {
      env: 'MTF_CONF_FLOOR', live: live.gate, label: 'confidence gate',
      values: [live.gate - 10, live.gate - 5, live.gate, live.gate + 5, live.gate + 10],
      note: 'the fire/no-fire threshold',
    },
    minrr: {
      env: 'MTF_MIN_RR', live: 1.5, label: 'MIN_RR',
      values: [1.2, 1.35, 1.5, 1.65, 1.8],
      note: 'hardcoded 1.5 in three places, not in strategy_settings.json',
    },
    adx: {
      env: 'MTF_ADX_TRENDING_MIN', live: live.adx, label: 'ADX trending floor',
      values: [live.adx - 4, live.adx - 2, live.adx, live.adx + 2, live.adx + 4],
      note: 'what counts as a trending regime',
    },
    momentumRsi: {
      env: 'MTF_MOMENTUM_RSI_MAX', live: live.momentumRsiMax, label: 'MOMENTUM RSI ceiling',
      values: [live.momentumRsiMax - 8, live.momentumRsiMax - 4, live.momentumRsiMax,
               live.momentumRsiMax + 4, live.momentumRsiMax + 8],
      note: 'the ceiling that decides how extended is too extended',
    },
  };
}

/* ── replay ──────────────────────────────────────────────────────────────── */
const cache = new Map();
function replay(symbol, envOverrides) {
  const key = symbol + '|' + JSON.stringify(envOverrides);
  if (cache.has(key)) return cache.get(key);
  const env = { ...process.env, MTF_EMIT_R: '1', MTF_MAX_HOLD: MAX_HOLD, ...envOverrides };
  let trades = [];
  try {
    const stdout = execFileSync(process.execPath,
      [path.join(ROOT, 'tasks', '_replay_mtf.cjs'), ROOT, symbol, TICKERS[symbol] || symbol, '40'],
      { env, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8', timeout: 900000 });
    trades = JSON.parse(stdout);
  } catch (e) {
    const out = (e.stdout || '') + (e.stderr || '');
    console.error(`  replay failed ${symbol}: ${out.slice(-160)}`);
    return null;
  }
  cache.set(key, trades);
  return trades;
}

function score(trades, gate) {
  if (!Array.isArray(trades)) return null;
  const closed = trades.filter(t => Number.isFinite(t.realisedR) && (t.conf ?? 0) >= gate);
  if (closed.length < 10) return { n: closed.length, rpt: null };
  const net = closed.reduce((s, t) => s + t.realisedR - COST_R, 0);
  return { n: closed.length, rpt: net / closed.length };
}

/* ── verdict ─────────────────────────────────────────────────────────────── */
/**
 * PLATEAU or SPIKE.
 *
 * The live cell is compared with its neighbours. A plateau is not "the live value is
 * best" - it is "the neighbours are close to it". A value that is dramatically better
 * than everything around it is the signature of a peak that history happened to
 * contain, and it is the one to distrust.
 */
function verdict(cells, liveValue) {
  const usable = cells.filter(c => c.rpt !== null && c.rpt !== undefined);
  if (usable.length < 3) return { verdict: 'TOO FEW CELLS', detail: `${usable.length} scored` };

  const liveCell = usable.find(c => c.value === liveValue);
  if (!liveCell) return { verdict: 'LIVE VALUE NOT SCORED', detail: '' };

  const others = usable.filter(c => c.value !== liveValue);
  const positive = usable.filter(c => c.rpt > 0).length;
  const positivePct = (positive / usable.length) * 100;
  const neighbourMean = others.reduce((a, c) => a + c.rpt, 0) / others.length;
  const best = usable.reduce((a, b) => (a.rpt >= b.rpt ? a : b));
  // How far above its neighbourhood does the live cell sit? A spike is a live cell far
  // above the mean of everything around it.
  const lift = liveCell.rpt - neighbourMean;

  // IDENTICAL CELLS MEAN THE PARAMETER DID NOTHING - a different fact from "robust",
  // and the more important one. A ceiling of 100 on a 0-100 indicator cannot bind; a
  // threshold outside the range the data reaches cannot either. Reporting that as
  // PLATEAU tells a reader the value is well-chosen when the run in fact measured
  // nothing about it, and it invites someone later to "restore" a setting whose
  // disabling was a measured decision.
  const spread = Math.max(...usable.map(c => c.rpt)) - Math.min(...usable.map(c => c.rpt));
  if (spread < 1e-6) {
    return {
      verdict: 'INERT',
      detail: `every value from ${usable[0].value} to ${usable[usable.length - 1].value} `
        + `gives an identical ${liveCell.rpt.toFixed(4)}R over ${liveCell.n} trades — this `
        + `parameter had NO EFFECT, so nothing here says whether it is well-chosen. `
        + `Check whether it is disabled ON PURPOSE before changing it.`,
      positiveCells: positive, totalCells: usable.length,
      positivePct: parseFloat(positivePct.toFixed(1)),
      liveRpt: liveCell.rpt, neighbourMeanRpt: neighbourMean, lift: 0,
      bestValue: liveValue, bestRpt: liveCell.rpt, liveIsBest: true,
      inert: true,
    };
  }

  let v, detail;
  if (positivePct >= 80 && Math.abs(lift) <= 0.10) {
    v = 'PLATEAU';
    detail = `${positive}/${usable.length} cells profitable and the live value sits within `
      + `${lift.toFixed(3)}R of its neighbourhood mean — nudging it does not break it`;
  } else if (positivePct < 50) {
    v = 'FRAGILE';
    detail = `only ${positive}/${usable.length} cells profitable — most of this `
      + `neighbourhood loses money, so the live value is a narrow survivor`;
  } else if (lift > 0.10) {
    v = 'SPIKE';
    detail = `the live value beats its neighbourhood mean by ${lift.toFixed(3)}R — that is `
      + `a peak, and a peak is what a curve-fit parameter looks like`;
  } else {
    v = 'MIXED';
    detail = `${positive}/${usable.length} profitable, live value ${lift >= 0 ? '+' : ''}`
      + `${lift.toFixed(3)}R vs neighbours — neither clearly a plateau nor a spike`;
  }
  return {
    verdict: v, detail,
    positiveCells: positive, totalCells: usable.length,
    positivePct: parseFloat(positivePct.toFixed(1)),
    liveRpt: liveCell.rpt, neighbourMeanRpt: neighbourMean, lift,
    bestValue: best.value, bestRpt: best.rpt,
    // Stated because it is the thing a reader will want to act on and should not:
    // a better cell here is ONE in-sample number, not a promotion.
    liveIsBest: best.value === liveValue,
  };
}

/* ── selftest ────────────────────────────────────────────────────────────── */
function selftest() {
  let fails = 0;
  const check = (l, ok) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${l}`); if (!ok) fails++; };

  const flat = [{ value: 60, rpt: 0.30 }, { value: 65, rpt: 0.32 }, { value: 70, rpt: 0.33 },
                { value: 75, rpt: 0.31 }, { value: 80, rpt: 0.29 }];
  check('a flat neighbourhood reads PLATEAU', verdict(flat, 70).verdict === 'PLATEAU');

  const spike = [{ value: 60, rpt: 0.02 }, { value: 65, rpt: 0.03 }, { value: 70, rpt: 0.60 },
                 { value: 75, rpt: 0.04 }, { value: 80, rpt: 0.01 }];
  check('a lone peak reads SPIKE', verdict(spike, 70).verdict === 'SPIKE');

  const bad = [{ value: 60, rpt: -0.10 }, { value: 65, rpt: -0.08 }, { value: 70, rpt: 0.05 },
               { value: 75, rpt: -0.12 }, { value: 80, rpt: -0.09 }];
  check('a mostly-losing neighbourhood reads FRAGILE', verdict(bad, 70).verdict === 'FRAGILE');

  check('too few scored cells refuses a verdict',
        verdict([{ value: 70, rpt: 0.3 }, { value: 75, rpt: null }], 70).verdict === 'TOO FEW CELLS');

  // The distinction that makes this worth running: BEST is not the same as ROBUST.
  const bestElsewhere = [{ value: 60, rpt: 0.30 }, { value: 65, rpt: 0.31 }, { value: 70, rpt: 0.32 },
                         { value: 75, rpt: 0.40 }, { value: 80, rpt: 0.30 }];
  const r = verdict(bestElsewhere, 70);
  check('a plateau can hold even when the live value is not the best cell',
        r.verdict === 'PLATEAU' && r.liveIsBest === false);

  const inert = [{ value: 92, rpt: 0.2837 }, { value: 96, rpt: 0.2837 }, { value: 100, rpt: 0.2837 },
                 { value: 104, rpt: 0.2837 }, { value: 108, rpt: 0.2837 }];
  const ir = verdict(inert, 100);
  check('identical cells read INERT, not PLATEAU', ir.verdict === 'INERT' && ir.inert === true);

  console.log(fails ? `\n  ${fails} FAILURE(S)` : '\n  all checks passed');
  return fails ? 1 : 0;
}

/* ── main ────────────────────────────────────────────────────────────────── */
function main() {
  if (has('--selftest')) return selftest();

  const axes = buildAxes();
  const wanted = opt('--axis', null);
  const names = wanted ? [wanted] : Object.keys(axes);
  const results = {};

  for (const name of names) {
    const axis = axes[name];
    if (!axis) { console.error(`unknown axis: ${name}`); return 2; }
    if (!has('--json')) console.log(`\n${axis.label}  (live ${axis.live}) — ${axis.note}`);

    const cells = [];
    for (const value of axis.values) {
      // Pooled across assets on purpose: this asks whether the SETTING is robust, and a
      // per-asset answer is a different (also useful) question that the walk-forwards
      // already answer per asset.
      let n = 0, net = 0;
      for (const symbol of ASSETS) {
        const overrides = { [axis.env]: String(value) };
        // The gate axis filters at scoring time; every other axis changes the replay.
        const gate = name === 'gate' ? value : axes.gate.live;
        const trades = replay(symbol, name === 'gate' ? {} : overrides);
        const s = score(trades, gate);
        if (s && s.rpt !== null) { n += s.n; net += s.rpt * s.n; }
      }
      const rpt = n >= 10 ? net / n : null;
      cells.push({ value, n, rpt });
      if (!has('--json')) {
        console.log(`  ${String(value).padStart(6)}  ${String(n).padStart(5)} trades  `
          + (rpt === null ? '   (too few)' : `${rpt >= 0 ? '+' : ''}${rpt.toFixed(4)}R/trade`)
          + (value === axis.live ? '   <- LIVE' : ''));
      }
    }
    results[name] = { ...axis, cells, ...verdict(cells, axis.live) };
    if (!has('--json')) {
      const r = results[name];
      console.log(`  => ${r.verdict}: ${r.detail}`);
    }
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    maxHoldBars: Number(MAX_HOLD),
    assets: ASSETS,
    costR: COST_R,
    axes: results,
    whatThisIs: 'Plateau-or-spike on the settings ACTUALLY IN FORCE. A robust parameter '
      + 'degrades gracefully when nudged; a curve-fit one collapses, because it was chosen '
      + 'for a peak history happened to contain. Nothing here is a tuner: a better cell is '
      + 'ONE in-sample number, not a promotion.',
    feedsTheGate: false,
  };

  // MERGE, NEVER OVERWRITE. Running one axis used to erase every other axis already on
  // disk, so `--axis momentumRsi` silently destroyed the gate, minrr and adx results
  // measured minutes earlier. That is data loss in a tool whose whole job is preserving
  // evidence. Axes from this run replace their own entries; everything else is kept,
  // carrying the timestamp it was measured at so a stale axis is visible as stale.
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  let merged = payload;
  try {
    if (fs.existsSync(OUT)) {
      const previous = JSON.parse(fs.readFileSync(OUT, 'utf8'));
      const keptAxes = { ...(previous.axes || {}) };
      for (const [k, v] of Object.entries(payload.axes)) keptAxes[k] = { ...v, measuredAt: payload.generatedAt };
      for (const [k, v] of Object.entries(keptAxes)) {
        if (!v.measuredAt) keptAxes[k] = { ...v, measuredAt: previous.generatedAt || null };
      }
      merged = { ...payload, axes: keptAxes };
    } else {
      for (const k of Object.keys(merged.axes)) merged.axes[k].measuredAt = payload.generatedAt;
    }
  } catch (mergeError) {
    // An unreadable previous artifact must not lose THIS run. Write what we have.
    console.error(`  could not merge the previous report (${mergeError.message}) — writing this run only`);
  }
  fs.writeFileSync(OUT, JSON.stringify(merged, null, 2));
  if (has('--json')) console.log(JSON.stringify(payload, null, 2));
  else console.log(`\n  written: ${path.relative(ROOT, OUT)}\n`);
  return 0;
}

process.exit(main());
