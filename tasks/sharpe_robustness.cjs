#!/usr/bin/env node
'use strict';
/**
 * PSR, Deflated Sharpe Ratio and Minimum Track Record Length.
 *
 *   node tasks/sharpe_robustness.cjs                 read the montecarlo trades
 *   node tasks/sharpe_robustness.cjs --trials 40     declare how many configs were tried
 *   node tasks/sharpe_robustness.cjs --json          machine-readable
 *   node tasks/sharpe_robustness.cjs --selftest      verify the maths, touch nothing
 *
 * WHY THIS, ON THIS SYSTEM, AHEAD OF ANYTHING ELSE.
 *
 * The bootstrap already on the Robustness page answers "how much of my result was luck
 * in the DRAW". It cannot answer the two questions that actually bind here:
 *
 *   1. HOW MUCH OF THIS IS LUCK IN THE SEARCH? This project has swept the RSI ceiling
 *      (72/68 -> 80/76 -> 88/84), the confidence gate (55, 60, 65, 70, 75, 85), MIN_RR,
 *      stop variants, cohort floors and hold horizons. Every sweep is a trial, and the
 *      best of N trials is biased upward by construction - the more you look, the better
 *      the winner looks even when nothing is there. The Deflated Sharpe Ratio is the
 *      standard correction: it asks whether the observed Sharpe beats what the BEST of
 *      N random trials would have produced anyway.
 *
 *   2. HOW LONG UNTIL WE KNOW? Sample size is the stated binding constraint of this
 *      whole system - 7 closed live trades, every setup under its 5-trade floor.
 *      Minimum Track Record Length turns that from a feeling into a number: the count of
 *      observations required before this Sharpe is distinguishable from zero at a stated
 *      confidence. It is the single most decision-relevant statistic available here,
 *      because it says how long to wait before believing anything.
 *
 * Formulas are Bailey & Lopez de Prado (2012, 2014), implemented as published:
 *
 *   PSR(SR*)  = Phi[ (SR - SR*) * sqrt(T-1) / sqrt(1 - g3*SR + ((g4-1)/4)*SR^2) ]
 *   MinTRL    = 1 + [1 - g3*SR + ((g4-1)/4)*SR^2] * (Z_alpha / (SR - SR*))^2
 *   E[maxSR]  = sqrt(V[SR]) * [ (1-g)*Phi^-1(1 - 1/N) + g*Phi^-1(1 - 1/(N*e)) ]
 *   DSR       = PSR(E[maxSR])
 *
 * where g3 is skewness, g4 is RAW kurtosis (3 for a normal), T the number of
 * observations, g the Euler-Mascheroni constant, and V[SR] the variance of the trial
 * Sharpe ratios. Verified with --selftest against closed-form cases.
 *
 * READ-ONLY. Reads the montecarlo artifact, computes, prints. It writes no file unless
 * --out is given, touches no setting, and feeds no gate.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const EULER_GAMMA = 0.5772156649015329;

// ── normal CDF and its inverse ──────────────────────────────────────────────
// Abramowitz & Stegun 7.1.26 for erf; Acklam's rational approximation for the inverse.
// Both are accurate to ~1e-9 over the range this uses, and both are checked by
// --selftest against known quantiles rather than trusted.
function erf(x) {
  const s = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429;
  const poly = ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t;
  return s * (1 - poly * Math.exp(-x * x));
}
function normCdf(z) { return 0.5 * (1 + erf(z / Math.SQRT2)); }

function normInv(p) {
  if (!(p > 0 && p < 1)) return NaN;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
             1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
             6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
             -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pl = 0.02425, ph = 1 - pl;
  let q, r;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  }
  if (p > ph) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  }
  q = p - 0.5; r = q * q;
  return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5]) * q /
         (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
}

// ── moments ─────────────────────────────────────────────────────────────────
function moments(xs) {
  const n = xs.length;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  let m2 = 0, m3 = 0, m4 = 0;
  for (const x of xs) { const d = x - mean; m2 += d * d; m3 += d * d * d; m4 += d * d * d * d; }
  m2 /= n; m3 /= n; m4 /= n;
  const sd = Math.sqrt(m2);
  return {
    n, mean, sd,
    skew: sd > 0 ? m3 / Math.pow(sd, 3) : 0,
    // RAW kurtosis: 3 for a normal. The published PSR denominator uses (g4 - 1)/4,
    // which is only correct for the raw form - passing excess kurtosis here silently
    // understates the variance inflation.
    kurt: sd > 0 ? m4 / Math.pow(sd, 4) : 3,
  };
}

/** The variance-inflation term shared by PSR and MinTRL. */
function psrDenomSq(sr, skew, kurt) {
  return 1 - skew * sr + ((kurt - 1) / 4) * sr * sr;
}

function probabilisticSharpe(sr, srBenchmark, T, skew, kurt) {
  const v = psrDenomSq(sr, skew, kurt);
  if (!(v > 0) || T < 2) return null;
  return normCdf(((sr - srBenchmark) * Math.sqrt(T - 1)) / Math.sqrt(v));
}

function minTrackRecordLength(sr, srBenchmark, skew, kurt, confidence) {
  const diff = sr - srBenchmark;
  if (!(diff > 0)) return null;                    // no edge to detect
  const z = normInv(confidence);
  return 1 + psrDenomSq(sr, skew, kurt) * Math.pow(z / diff, 2);
}

/**
 * Expected MAXIMUM Sharpe across N independent trials, under the null that none has
 * an edge. This is the bar the observed Sharpe must clear to mean anything.
 */
function expectedMaxSharpe(nTrials, varTrialSharpe) {
  if (!(nTrials > 1)) return 0;
  const a = normInv(1 - 1 / nTrials);
  const b = normInv(1 - 1 / (nTrials * Math.E));
  return Math.sqrt(varTrialSharpe) * ((1 - EULER_GAMMA) * a + EULER_GAMMA * b);
}

// ── self-test: the maths, checked against closed forms ───────────────────────
function selftest() {
  let pass = 0, fail = 0;
  const chk = (name, got, want, tol) => {
    const ok = Number.isFinite(got) && Math.abs(got - want) <= tol;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(56)} got ${Number(got).toFixed(6)}  want ${want}`);
    ok ? pass++ : fail++;
  };
  // Normal CDF at known quantiles.
  chk('normCdf(0) = 0.5', normCdf(0), 0.5, 1e-9);
  chk('normCdf(1.959964) = 0.975', normCdf(1.959963985), 0.975, 1e-6);
  chk('normCdf(-1.644854) = 0.05', normCdf(-1.644853627), 0.05, 1e-6);
  // Inverse is the inverse.
  chk('normInv(0.975) = 1.959964', normInv(0.975), 1.959963985, 1e-6);
  chk('normInv(0.95) = 1.644854', normInv(0.95), 1.644853627, 1e-6);
  chk('normInv(normCdf(0.7)) = 0.7', normInv(normCdf(0.7)), 0.7, 1e-6);
  // PSR on NORMAL returns (skew 0, kurt 3) reduces to Phi(SR*sqrt(T-1)/sqrt(1+SR^2/2)).
  {
    const sr = 0.1, T = 100;
    const want = normCdf((sr * Math.sqrt(T - 1)) / Math.sqrt(1 + 0.5 * sr * sr));
    chk('PSR reduces to the normal case', probabilisticSharpe(sr, 0, T, 0, 3), want, 1e-12);
  }
  // Negative skew and fat tails must LOWER the PSR: both inflate the denominator.
  {
    const base = probabilisticSharpe(0.1, 0, 100, 0, 3);
    const skewed = probabilisticSharpe(0.1, 0, 100, -1.5, 3);
    const fat = probabilisticSharpe(0.1, 0, 100, 0, 9);
    chk('negative skew lowers PSR', skewed < base ? 1 : 0, 1, 0);
    chk('fat tails lower PSR', fat < base ? 1 : 0, 1, 0);
  }
  // MinTRL: with SR=0 there is nothing to detect.
  chk('MinTRL is null when SR <= benchmark', minTrackRecordLength(0, 0, 0, 3, 0.95) === null ? 1 : 0, 1, 0);
  // MinTRL closed form on normal returns.
  {
    const sr = 0.1, z = normInv(0.95);
    const want = 1 + (1 + 0.5 * sr * sr) * Math.pow(z / sr, 2);
    chk('MinTRL matches its closed form', minTrackRecordLength(sr, 0, 0, 3, 0.95), want, 1e-9);
  }
  // Expected max Sharpe grows with the number of trials - the whole point.
  {
    const v = 0.01;
    const a = expectedMaxSharpe(10, v), b = expectedMaxSharpe(1000, v);
    chk('E[maxSR] rises with more trials', b > a ? 1 : 0, 1, 0);
    chk('E[maxSR] is 0 for a single trial', expectedMaxSharpe(1, v), 0, 1e-12);
  }
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

if (has('--selftest')) selftest();

// ── the trades ──────────────────────────────────────────────────────────────
// Read from the montecarlo artifact so both surfaces describe the SAME population.
// Recomputing the replay here would create a second source of truth that could drift.
const artifactPath = path.join(ROOT, 'tasks', 'analysis', 'montecarlo-latest.json');
if (!fs.existsSync(artifactPath)) {
  console.error('No montecarlo-latest.json. Run: node tasks/montecarlo_report.cjs');
  process.exit(1);
}
const art = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
const rs = Array.isArray(art.perTradeRSeries) ? art.perTradeRSeries : null;
if (!rs || rs.length < 20) {
  console.error('The artifact carries no per-trade R series (perTradeRSeries). Re-run montecarlo_report.cjs '
    + 'with the version that emits it — this tool will not guess a distribution from summary stats.');
  process.exit(1);
}

const m = moments(rs);
const SR = m.sd > 0 ? m.mean / m.sd : 0;          // per-trade Sharpe, NOT annualised
const CONF = Number(opt('--confidence', '0.95'));
// How many DISTINCT configurations this project has evaluated. Declared, not guessed:
// the honest default is stated in the output so a reader can challenge it.
const TRIALS = Number(opt('--trials', '40'));
// Spread of Sharpe ratios ACROSS those trials. Without the real per-trial series the
// conservative stand-in is the sampling variance of a single Sharpe under the null,
// 1/(T-1); the output says which was used.
const varTrials = art.trialSharpeVariance != null ? Number(art.trialSharpeVariance) : 1 / (m.n - 1);
const varSource = art.trialSharpeVariance != null ? 'measured across recorded trials' : 'null-model 1/(T-1)';

const psr = probabilisticSharpe(SR, 0, m.n, m.skew, m.kurt);
const minTrl = minTrackRecordLength(SR, 0, m.skew, m.kurt, CONF);
const sr0 = expectedMaxSharpe(TRIALS, varTrials);
const dsr = probabilisticSharpe(SR, sr0, m.n, m.skew, m.kurt);

const result = {
  generatedAt: new Date().toISOString(),
  population: { trades: m.n, source: 'montecarlo-latest.json perTradeR', span: art.span || null },
  moments: { meanR: m.mean, sdR: m.sd, skew: m.skew, kurtosisRaw: m.kurt },
  sharpePerTrade: SR,
  psr,
  deflated: { trialsAssumed: TRIALS, varTrialSharpe: varTrials, varSource, expectedMaxSharpe: sr0, dsr },
  minTrackRecordLength: minTrl,
  confidence: CONF,
  verdict: (() => {
    if (dsr == null) return 'UNCOMPUTABLE';
    if (dsr >= 0.95) return 'SURVIVES deflation at 95%';
    if (dsr >= 0.90) return 'MARGINAL after deflation';
    return 'DOES NOT SURVIVE deflation — consistent with the best of ' + TRIALS + ' lucky trials';
  })(),
  caveats: [
    'These are REPLAYED trades, not live fills. The statistic is about the backtest, not the account.',
    'SR is per TRADE, not annualised, and is not comparable with a published annual Sharpe.',
    'trialsAssumed is DECLARED, not discovered. Under-declaring it flatters the DSR; the honest '
      + 'number is every configuration ever evaluated, not the ones that were kept.',
    'MinTRL assumes the future resembles the sample. It is a floor on how long to wait, not a promise.',
  ],
  feedsTheGate: false,
};

if (has('--json')) { console.log(JSON.stringify(result, null, 2)); }
else {
  const pc = x => x == null ? 'n/a' : (x * 100).toFixed(2) + '%';
  console.log('');
  console.log('  SHARPE ROBUSTNESS — PSR, Deflated Sharpe, Minimum Track Record Length');
  console.log('  ' + '-'.repeat(72));
  console.log(`  population           ${m.n} replayed trades` + (art.span ? `  ${art.span.from} -> ${art.span.to}` : ''));
  console.log(`  mean R / sd R        ${m.mean.toFixed(4)} / ${m.sd.toFixed(4)}`);
  console.log(`  skew / kurtosis      ${m.skew.toFixed(3)} / ${m.kurt.toFixed(3)}  (3 = normal)`);
  console.log(`  Sharpe per trade     ${SR.toFixed(4)}`);
  console.log('');
  console.log(`  PSR vs zero          ${pc(psr)}   probability the true Sharpe exceeds 0`);
  console.log(`  trials assumed       ${TRIALS}   (${varSource})`);
  console.log(`  E[max SR] of ${String(TRIALS).padEnd(4)}    ${sr0.toFixed(4)}   the bar luck alone would clear`);
  console.log(`  DEFLATED Sharpe      ${pc(dsr)}   probability it beats that bar`);
  console.log(`  MinTRL @ ${(CONF * 100).toFixed(0)}%         ${minTrl == null ? 'n/a — no positive edge to detect' : Math.ceil(minTrl) + ' trades'}`);
  console.log('');
  console.log(`  VERDICT              ${result.verdict}`);
  console.log('  ' + '-'.repeat(72));
  for (const c of result.caveats) console.log('   · ' + c);
  console.log('');
}

const out = opt('--out', null);
if (out) { fs.writeFileSync(out, JSON.stringify(result, null, 2)); console.log(out); }

module.exports = { normCdf, normInv, moments, probabilisticSharpe, minTrackRecordLength, expectedMaxSharpe };
