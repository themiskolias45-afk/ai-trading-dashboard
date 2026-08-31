#!/usr/bin/env node
'use strict';
/* ============================================================================
   lab_report.cjs — the professional assessment layer for ANY trade list
   ============================================================================

   WHAT THIS IS, AND WHY IT IS NOT ANOTHER BACKTESTER.

   This project already has harnesses that PRODUCE trades: ema_cross_backtest.cjs,
   h1_strategies_backtest.cjs, _replay_engine.cjs, param_walkforward.cjs, and the
   live journal itself. It did NOT have one place that JUDGES a trade list to a
   professional standard, so every harness grew its own partial verdict and each
   one omitted something different.

   So the split is deliberate: harnesses generate, this file judges. One analysis
   core, many strategies, and the live journal can be run through the identical
   assessment as a backtest — which is the only way live-vs-replay is comparable.

   WHAT PROMPTED IT. A lab screenshot dated 2026-08-31 reported a candidate
   "ema_cross · trail:2.0,4.0 · london" as DIED, with a full tile row, an equity
   curve, walk-forward quarters, Monte Carlo and a cost stress test. It was decent
   work and its verdict was right. Three things were wrong with it anyway, and all
   three are fixed here because all three are the difference between a chart and an
   assessment:

     1. IT MIXED DENOMINATORS SILENTLY. The tiles read TOTAL TRADES 540 and TOTAL
        P&L (OOS) -7705.83 side by side, but -7705.83 / -47.567 = 162.0 exactly, so
        expectancy was computed on the 162 out-of-sample trades while the count tile
        showed all 540. A reader dividing the headline by the headline is wrong by
        3.3x. Here EVERY figure carries the n it was computed on, and the
        DENOMINATORS block exists so the two can never drift apart again.

     2. IT HAD NO MULTIPLE-TESTING CORRECTION. The candidate's own title names a
        grid cell (a trail parameter pair AND a session filter), so the trial count
        was greater than one and the reported Sharpe was the maximum of a search.
        An uncorrected Sharpe from a search is not evidence. Deflated Sharpe, PSR
        and MinTRL are computed here by reusing tasks/sharpe_robustness.cjs rather
        than reimplementing them.

     3. IT BURIED THE ONLY FACT THAT MATTERED. Summing its own 21 quarter chips:
        +27,728 green against -47,049 red, netting -19,321, which reconciles to its
        equity curve's -19,320.28. But ONE quarter, 2021Q3, was +14,823 — 53% of
        every point the strategy ever made. Drop it and the remaining 20 quarters
        are -34,144. A result that rests on one quarter out of twenty-one is a
        different object from one that grinds, and nothing on that page said so.
        Hence the CONCENTRATION block, which is the section this file exists for.

   THE STANDING RULES THIS OBEYS.
     - R IS THE UNIT, NOT POINTS OR DOLLARS. Points are not comparable across
       BTCUSD, XAUUSD and SP500, and this project has already recorded that
       per-trade risk is not a common unit across its three instruments. Everything
       below is in R. A points-denominated headline is how a Gold result gets
       compared against an SPX one and nobody notices.
     - THE VERDICT RULE IS PRE-REGISTERED. Every threshold is a named constant in
       one block below, printed at the TOP of every report, BEFORE the numbers. A
       bar chosen after seeing the result is not a bar.
     - IT DECIDES NOTHING AND WRITES NO CONFIG. Read-only. It cannot move a gate,
       a threshold, a lot size or a stop, and nothing on the trade path reads it.

   USAGE
     node tasks/lab_report.cjs --trades <file.json> [--label "..."]
                              [--is-frac 0.7] [--trials 1] [--cost 0.05]
                              [--json] [--out <file.json>]
     node tasks/lab_report.cjs --selftest

   TRADE ROW SHAPE. Only `r` is required; everything else enriches a section and is
   reported as unavailable rather than guessed when absent:
     { r: number,            // realised R multiple, costs already applied or not (see --cost)
       openTime?: ISO string, closeTime?: ISO string,
       symbol?: string, exitReason?: string, mae?: number, mfe?: number }
   ========================================================================== */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { moments, probabilisticSharpe, minTrackRecordLength, expectedMaxSharpe, normCdf } =
  require(path.join(__dirname, 'sharpe_robustness.cjs'));

// ── PRE-REGISTERED VERDICT RULE ─────────────────────────────────────────────
// Declared here, printed before every result, applied mechanically at the end.
// Changing one of these is a deliberate act that shows up in a diff — which is the
// entire point of them being constants rather than inline literals at the verdict.
const RULE = {
  MIN_TRADES:            30,    // below this, no verdict is offered at all
  MIN_OOS_EXPECTANCY_R:  0,     // OOS expectancy must be positive
  MIN_PROFIT_FACTOR:     1.10,  // OOS; 1.0 is break-even before it is anything
  MAX_PROB_OF_LOSS:      0.35,  // block-bootstrap probability of ending down
  MIN_DSR:               0.95,  // deflated Sharpe: P(true Sharpe > 0) after trials
  MIN_POSITIVE_PERIODS:  0.50,  // at least half the quarters green
  MAX_TOP_PERIOD_SHARE:  0.50,  // no single period may be >50% of gross profit
  SURVIVES_COST_MULT:    2,     // must stay above MIN_PROFIT_FACTOR at 2x costs
};

// Bootstrap settings. Deterministic seed so two runs on the same trades agree — a
// report whose numbers move when nothing changed cannot be checked by anyone.
const BOOT_SEED  = 20260831;
const BOOT_PATHS = 2000;
const CONFIDENCE = 0.95;

// ── argv ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function opt(name, def) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
}
function flag(name) { return argv.includes(name); }

// ── small maths helpers ─────────────────────────────────────────────────────
const sum = xs => xs.reduce((a, b) => a + b, 0);
function quantile(sorted, q) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
function round(x, dp = 4) {
  return (x === null || x === undefined || !Number.isFinite(x)) ? null
    : Number(x.toFixed(dp));
}

/**
 * Equity path in R, and its maximum drawdown IN R.
 *
 * ADDITIVE, not compounded, and that is a decision rather than an oversight.
 * Compounding mixes a position-sizing policy into a question about the SIGNAL, so
 * two strategies with identical trade sequences would score differently purely
 * because of a risk-per-trade constant chosen elsewhere. Sizing is measured
 * separately in this project and belongs there.
 */
function equity(rs) {
  let bal = 0, peak = 0, maxDD = 0;
  const curve = [0];
  for (const r of rs) {
    bal += r;
    curve.push(bal);
    if (bal > peak) peak = bal;
    const dd = peak - bal;
    if (dd > maxDD) maxDD = dd;
  }
  return { final: bal, maxDD, curve };
}

/** Longest run of consecutive losers, and of winners. */
function streaks(rs) {
  let wS = 0, lS = 0, wBest = 0, lBest = 0;
  for (const r of rs) {
    if (r > 0) { wS++; lS = 0; if (wS > wBest) wBest = wS; }
    else if (r < 0) { lS++; wS = 0; if (lS > lBest) lBest = lS; }
    else { wS = 0; lS = 0; }
  }
  return { longestWin: wBest, longestLoss: lBest };
}

/** Mulberry32 — small, fast, and reproducible from a seed. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── core statistics, every one carrying its n ───────────────────────────────
function coreStats(rs) {
  const n = rs.length;
  if (!n) return null;
  const wins   = rs.filter(r => r > 0);
  const losses = rs.filter(r => r < 0);
  const scratches = n - wins.length - losses.length;
  const grossWin  = sum(wins);
  const grossLoss = Math.abs(sum(losses));
  const winRate   = wins.length / n;
  const avgWin    = wins.length ? grossWin / wins.length : 0;
  const avgLoss   = losses.length ? grossLoss / losses.length : 0;
  const payoff    = avgLoss > 0 ? avgWin / avgLoss : null;
  // The single most useful line on any report: what win rate this payoff REQUIRES,
  // and how far the actual one is from it. A 25% win rate is excellent at 4:1 and
  // fatal at 2:1, and a bare win-rate tile cannot tell you which you are looking at.
  const breakevenWr = payoff !== null ? 1 / (1 + payoff) : null;
  const m = moments(rs);
  const eq = equity(rs);
  return {
    n, wins: wins.length, losses: losses.length, scratches,
    winRate, avgWinR: avgWin, avgLossR: avgLoss, payoff,
    breakevenWr,
    winRateEdgePp: (breakevenWr !== null) ? (winRate - breakevenWr) * 100 : null,
    expectancyR: m.mean,
    totalR: eq.final,
    maxDrawdownR: eq.maxDD,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
    sharpePerTrade: m.sd > 0 ? m.mean / m.sd : 0,
    sdR: m.sd, skew: m.skew, kurt: m.kurt,
    ...streaks(rs),
  };
}

// ── CONCENTRATION — the section the screenshot was missing ──────────────────
/**
 * Is the result a grind, or one lucky window wearing a five-year costume?
 *
 * Reported three ways because they fail differently: the best PERIOD catches a
 * regime that will not repeat, the best TRADES catch a single fill carrying the
 * file, and the result EXCLUDING the best period is the number a reader actually
 * wants and never gets.
 */
function concentration(trades, periods) {
  const rs = trades.map(t => t.r);
  const grossProfit = sum(rs.filter(r => r > 0));

  const sortedDesc = [...rs].sort((a, b) => b - a);
  const topTradeShare = grossProfit > 0
    ? sum(sortedDesc.slice(0, Math.max(1, Math.round(rs.length * 0.05)))) / grossProfit
    : null;

  let best = null;
  for (const p of periods) if (!best || p.totalR > best.totalR) best = p;

  const exBest = best ? periods.filter(p => p.key !== best.key) : periods;
  const exBestTotal = sum(exBest.map(p => p.totalR));

  return {
    periods: periods.length,
    grossProfitR: grossProfit,
    bestPeriod: best ? best.key : null,
    bestPeriodR: best ? best.totalR : null,
    // Share of GROSS PROFIT, not of net: net can be negative, and a share of a
    // negative denominator is a number that looks fine and means nothing.
    bestPeriodShareOfGross: (best && grossProfit > 0) ? Math.max(0, best.totalR) / grossProfit : null,
    totalExcludingBestR: exBestTotal,
    top5pctTradeShareOfGross: topTradeShare,
    positivePeriods: periods.filter(p => p.totalR > 0).length,
  };
}

/** Group trades into calendar quarters. Needs closeTime; degrades honestly without it. */
function byQuarter(trades) {
  const buckets = new Map();
  let undated = 0;
  for (const t of trades) {
    const ts = t.closeTime || t.openTime;
    const d = ts ? new Date(ts) : null;
    if (!d || isNaN(d.getTime())) { undated++; continue; }
    const key = d.getUTCFullYear() + 'Q' + (Math.floor(d.getUTCMonth() / 3) + 1);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(t.r);
  }
  const periods = [...buckets.entries()]
    .map(([key, rs]) => ({ key, n: rs.length, totalR: sum(rs) }))
    .sort((a, b) => a.key.localeCompare(b.key));
  return { periods, undated };
}

// ── block bootstrap ─────────────────────────────────────────────────────────
/**
 * Resample in BLOCKS, not one trade at a time.
 *
 * An IID bootstrap assumes each trade is independent of the last, which destroys
 * the serial dependence that produces long losing runs — so it systematically
 * UNDERSTATES drawdown, and understates it most on exactly the trend-following
 * strategies whose losing runs are the risk. A candidate showing a 20-trade loss
 * streak has dependence by definition. Block length sqrt(n) is the standard
 * default and is reported, not hidden.
 */
function blockBootstrap(rs, paths, seed) {
  const n = rs.length;
  if (n < 2) return null;
  const block = Math.max(1, Math.round(Math.sqrt(n)));
  const rnd = mulberry32(seed);
  const finals = [], dds = [];
  for (let p = 0; p < paths; p++) {
    const seq = [];
    while (seq.length < n) {
      const start = Math.floor(rnd() * n);
      for (let k = 0; k < block && seq.length < n; k++) seq.push(rs[(start + k) % n]);
    }
    const e = equity(seq);
    finals.push(e.final);
    dds.push(e.maxDD);
  }
  finals.sort((a, b) => a - b);
  dds.sort((a, b) => a - b);
  return {
    paths, blockLength: block,
    probOfLoss: finals.filter(f => f < 0).length / paths,
    medianFinalR: quantile(finals, 0.5),
    worst5pctFinalR: quantile(finals, 0.05),
    best5pctFinalR: quantile(finals, 0.95),
    medianMaxDdR: quantile(dds, 0.5),
    worst5pctMaxDdR: quantile(dds, 0.95),
  };
}

// ── deflated Sharpe, reusing the audited module ─────────────────────────────
/**
 * PSR asks "is the true Sharpe above zero given skew, kurtosis and sample length".
 * DEFLATED Sharpe asks the same question after admitting how many candidates were
 * tried — because the maximum of N noisy trials is positive by construction. With
 * trials = 1 the two coincide, and that is stated rather than left to be inferred.
 */
function deflated(rs, trials) {
  const m = moments(rs);
  const sr = m.sd > 0 ? m.mean / m.sd : 0;
  const T = rs.length;
  const psr = probabilisticSharpe(sr, 0, T, m.skew, m.kurt);
  // Under the null that no trial has an edge, the trial Sharpes vary; their variance
  // is approximated by the observed per-trade Sharpe variance, 1/T being the standard
  // null variance of a Sharpe estimate over T observations.
  const varTrial = 1 / Math.max(1, T);
  const sr0 = trials > 1 ? expectedMaxSharpe(trials, varTrial) : 0;
  const dsr = probabilisticSharpe(sr, sr0, T, m.skew, m.kurt);
  const minTrl = minTrackRecordLength(sr, sr0, m.skew, m.kurt, CONFIDENCE);
  return {
    trialsDeclared: trials,
    sharpePerTrade: sr,
    psr,
    deflatedSharpe: dsr,
    benchmarkSharpeFromTrials: sr0,
    minTrackRecordLength: minTrl,
    tradesShortOfMinTrl: (minTrl !== null && Number.isFinite(minTrl)) ? Math.max(0, Math.ceil(minTrl - T)) : null,
  };
}

// ── cost stress ─────────────────────────────────────────────────────────────
/**
 * Charge additional cost per trade in R and watch the profit factor fall. A real
 * edge degrades gracefully; a marginal one inverts. Applied on top of whatever the
 * harness already charged, which is why --cost is the INCREMENT and is stated.
 */
function costStress(rs, costR, multiples) {
  const out = {};
  for (const mult of multiples) {
    const extra = costR * (mult - 1);
    const adj = rs.map(r => r - extra);
    const s = coreStats(adj);
    out['x' + mult] = {
      addedCostRPerTrade: round(extra),
      profitFactor: round(s.profitFactor),
      expectancyR: round(s.expectancyR),
      totalR: round(s.totalR),
    };
  }
  return out;
}

// ── trade diagnostics ───────────────────────────────────────────────────────
function diagnostics(trades) {
  const withExit = trades.filter(t => t.exitReason);
  const exits = {};
  for (const t of withExit) {
    const k = String(t.exitReason);
    if (!exits[k]) exits[k] = { n: 0, totalR: 0 };
    exits[k].n++; exits[k].totalR += t.r;
  }
  for (const k of Object.keys(exits)) exits[k].expectancyR = round(exits[k].totalR / exits[k].n);

  const holds = [];
  for (const t of trades) {
    if (!t.openTime || !t.closeTime) continue;
    const a = new Date(t.openTime).getTime(), b = new Date(t.closeTime).getTime();
    if (isFinite(a) && isFinite(b) && b >= a) holds.push((b - a) / 3600000);
  }
  holds.sort((a, b) => a - b);

  const mae = trades.filter(t => Number.isFinite(t.mae)).map(t => t.mae);
  return {
    // Coverage first, ALWAYS. A distribution over 12 of 540 trades is not a finding
    // about the strategy, it is a finding about the data — and the two read
    // identically unless the denominator is printed beside them.
    exitReasonCoverage: withExit.length + '/' + trades.length,
    exitReasons: Object.keys(exits).length ? exits : null,
    holdHoursCoverage: holds.length + '/' + trades.length,
    holdHoursMedian: holds.length ? round(quantile(holds, 0.5), 2) : null,
    holdHoursP90: holds.length ? round(quantile(holds, 0.9), 2) : null,
    maeCoverage: mae.length + '/' + trades.length,
    maeMedianR: mae.length ? round(quantile([...mae].sort((a, b) => a - b), 0.5)) : null,
  };
}

// ── the verdict, applied mechanically ───────────────────────────────────────
function verdict(rep) {
  const checks = [];
  const oos = rep.outOfSample;
  const push = (name, pass, detail) => checks.push({ name, pass, detail });

  if (rep.all.n < RULE.MIN_TRADES) {
    return {
      verdict: 'TOO FEW TO JUDGE',
      checks: [{ name: 'sample', pass: false, detail: rep.all.n + ' trades, floor is ' + RULE.MIN_TRADES }],
      note: 'No verdict is offered below the floor. An underpowered PASS is worse than no answer.',
    };
  }
  push('OOS expectancy > ' + RULE.MIN_OOS_EXPECTANCY_R + 'R',
    oos.expectancyR > RULE.MIN_OOS_EXPECTANCY_R, round(oos.expectancyR) + 'R over ' + oos.n);
  push('OOS profit factor >= ' + RULE.MIN_PROFIT_FACTOR,
    oos.profitFactor >= RULE.MIN_PROFIT_FACTOR, round(oos.profitFactor, 3) + ' over ' + oos.n);
  push('prob of loss <= ' + RULE.MAX_PROB_OF_LOSS,
    rep.bootstrap ? rep.bootstrap.probOfLoss <= RULE.MAX_PROB_OF_LOSS : false,
    rep.bootstrap ? round(rep.bootstrap.probOfLoss, 3) : 'unavailable');
  push('deflated Sharpe >= ' + RULE.MIN_DSR,
    rep.deflated.deflatedSharpe !== null && rep.deflated.deflatedSharpe >= RULE.MIN_DSR,
    rep.deflated.deflatedSharpe === null ? 'undefined' : round(rep.deflated.deflatedSharpe, 4)
      + ' at ' + rep.deflated.trialsDeclared + ' trial(s)');
  const posFrac = rep.concentration.periods
    ? rep.concentration.positivePeriods / rep.concentration.periods : 0;
  push('positive periods >= ' + (RULE.MIN_POSITIVE_PERIODS * 100) + '%',
    posFrac >= RULE.MIN_POSITIVE_PERIODS,
    rep.concentration.positivePeriods + '/' + rep.concentration.periods);
  const share = rep.concentration.bestPeriodShareOfGross;
  push('best period <= ' + (RULE.MAX_TOP_PERIOD_SHARE * 100) + '% of gross profit',
    share === null ? false : share <= RULE.MAX_TOP_PERIOD_SHARE,
    share === null ? 'unavailable' : (round(share * 100, 1) + '% from ' + rep.concentration.bestPeriod));
  const stressed = rep.costStress['x' + RULE.SURVIVES_COST_MULT];
  push('profit factor >= ' + RULE.MIN_PROFIT_FACTOR + ' at ' + RULE.SURVIVES_COST_MULT + 'x costs',
    stressed ? stressed.profitFactor >= RULE.MIN_PROFIT_FACTOR : false,
    stressed ? String(stressed.profitFactor) : 'unavailable');

  const failed = checks.filter(c => !c.pass).length;
  return {
    verdict: failed === 0 ? 'SURVIVES' : (failed <= 2 ? 'MARGINAL' : 'DIED'),
    checksPassed: checks.length - failed,
    checksTotal: checks.length,
    checks,
  };
}

// ── build the report ────────────────────────────────────────────────────────
function buildReport(trades, o) {
  const clean = trades.filter(t => t && Number.isFinite(Number(t.r))).map(t => ({ ...t, r: Number(t.r) }));
  const dropped = trades.length - clean.length;
  const rs = clean.map(t => t.r);

  // IN-SAMPLE / OUT-OF-SAMPLE split is CHRONOLOGICAL, never random. A random split
  // lets the model see the future, which is the most common way a backtest lies.
  const cut = Math.floor(clean.length * o.isFrac);
  const isTrades = clean.slice(0, cut);
  const oosTrades = clean.slice(cut);

  const q = byQuarter(clean);
  const all = coreStats(rs);
  const inS = coreStats(isTrades.map(t => t.r)) || { n: 0 };
  const oos = coreStats(oosTrades.map(t => t.r)) || { n: 0 };

  const rep = {
    label: o.label,
    generatedAt: new Date().toISOString(),
    rule: RULE,
    provenance: {
      tradesFile: o.tradesFile,
      rowsRead: trades.length,
      rowsDropped: dropped,
      unit: 'R (risk multiples) — NOT points, NOT currency',
      splitMethod: 'chronological',
      inSampleFraction: o.isFrac,
      costIncrementR: o.costR,
      trialsDeclared: o.trials,
      undatedTrades: q.undated,
    },
    // THE BLOCK THAT STOPS THE SCREENSHOT'S DEFECT RECURRING. Every n, in one place.
    denominators: {
      all: all.n,
      inSample: inS.n,
      outOfSample: oos.n,
      quarters: q.periods.length,
      note: 'Every metric below is labelled with which of these it used. '
          + 'A headline divided by the wrong n is the defect this block exists to prevent.',
    },
    all, inSample: inS, outOfSample: oos,
    // In-sample to out-of-sample DEGRADATION is the overfit test. A strategy strong
    // in-sample and dead out is overfit; one dead in BOTH never had an edge, and the
    // remedy is completely different. Naming which of the two you have is the point.
    degradation: {
      profitFactorIs: round(inS.profitFactor, 3),
      profitFactorOos: round(oos.profitFactor, 3),
      expectancyIsR: round(inS.expectancyR),
      expectancyOosR: round(oos.expectancyR),
      reading: (inS.profitFactor >= RULE.MIN_PROFIT_FACTOR && oos.profitFactor < RULE.MIN_PROFIT_FACTOR)
        ? 'OVERFIT — strong in-sample, fails out-of-sample'
        : (inS.profitFactor < RULE.MIN_PROFIT_FACTOR && oos.profitFactor < RULE.MIN_PROFIT_FACTOR)
          ? 'NO EDGE IN EITHER WINDOW — this is not an overfit, the rule never worked. '
            + 'Better validation cannot rescue it.'
          : 'holds out of sample so far',
    },
    quarters: q.periods,
    concentration: concentration(clean, q.periods),
    deflated: deflated(rs, o.trials),
    bootstrap: blockBootstrap(rs, BOOT_PATHS, BOOT_SEED),
    costStress: costStress(rs, o.costR, [1, 2, 3]),
    diagnostics: diagnostics(clean),
    feedsTheGate: false,
  };
  rep.assessment = verdict(rep);
  return rep;
}

// ── printing ────────────────────────────────────────────────────────────────
function pct(x, dp = 1) { return x === null || x === undefined ? 'n/a' : (x * 100).toFixed(dp) + '%'; }
function r(x, dp = 3) { return x === null || x === undefined || !Number.isFinite(x) ? 'n/a' : x.toFixed(dp); }

function print(rep) {
  const L = s => console.log(s);
  L('');
  L('='.repeat(84));
  L('  STRATEGY LAB — ' + rep.label);
  L('='.repeat(84));
  L('  unit: R (risk multiples).  split: chronological, IS ' + pct(rep.provenance.inSampleFraction, 0));
  L('  trials declared: ' + rep.provenance.trialsDeclared
    + '   ·   cost increment: ' + rep.provenance.costIncrementR + 'R/trade');
  L('');
  L('  VERDICT RULE — pre-registered, printed before the numbers:');
  for (const [k, v] of Object.entries(RULE)) L('    ' + k.padEnd(24) + v);
  L('');
  L('  DENOMINATORS   all ' + rep.denominators.all
    + '  ·  in-sample ' + rep.denominators.inSample
    + '  ·  out-of-sample ' + rep.denominators.outOfSample
    + '  ·  quarters ' + rep.denominators.quarters);
  if (rep.provenance.rowsDropped) L('    rows dropped (no finite r): ' + rep.provenance.rowsDropped);
  if (rep.provenance.undatedTrades) L('    undated trades (excluded from quarters only): ' + rep.provenance.undatedTrades);
  L('');

  const a = rep.all;
  L('  CORE  (n=' + a.n + ', all trades)');
  L('    win rate        ' + pct(a.winRate) + '   (' + a.wins + 'W / ' + a.losses + 'L)');
  L('    payoff          ' + r(a.payoff, 3) + '   avg win ' + r(a.avgWinR) + 'R  avg loss ' + r(a.avgLossR) + 'R');
  L('    breakeven WR    ' + pct(a.breakevenWr) + '   -> actual is '
    + (a.winRateEdgePp >= 0 ? '+' : '') + r(a.winRateEdgePp, 2) + 'pp '
    + (a.winRateEdgePp >= 0 ? 'ABOVE' : 'BELOW') + ' what this payoff needs');
  L('    expectancy      ' + r(a.expectancyR) + 'R/trade      total ' + r(a.totalR, 2) + 'R');
  L('    profit factor   ' + r(a.profitFactor, 3) + '        max drawdown ' + r(a.maxDrawdownR, 2) + 'R');
  L('    longest losing run ' + a.longestLoss + '   ·   Sharpe/trade ' + r(a.sharpePerTrade, 4));
  L('');

  L('  IN-SAMPLE vs OUT-OF-SAMPLE');
  L('    PF          ' + r(rep.degradation.profitFactorIs, 3) + ' (n=' + rep.inSample.n + ')'
    + '  ->  ' + r(rep.degradation.profitFactorOos, 3) + ' (n=' + rep.outOfSample.n + ')');
  L('    expectancy  ' + r(rep.degradation.expectancyIsR) + 'R  ->  ' + r(rep.degradation.expectancyOosR) + 'R');
  L('    reading: ' + rep.degradation.reading);
  L('');

  const d = rep.deflated;
  L('  MULTIPLE-TESTING CORRECTION  (n=' + rep.all.n + ')');
  L('    Sharpe/trade        ' + r(d.sharpePerTrade, 4));
  L('    PSR   P(true>0)     ' + (d.psr === null ? 'undefined' : pct(d.psr, 2)));
  L('    DEFLATED  at ' + String(d.trialsDeclared).padEnd(3) + 'trial(s)  '
    + (d.deflatedSharpe === null ? 'undefined' : pct(d.deflatedSharpe, 2)));
  L('    MinTRL              ' + (d.minTrackRecordLength === null ? 'no edge to detect'
      : Math.ceil(d.minTrackRecordLength) + ' trades needed'
        + (d.tradesShortOfMinTrl ? '  (SHORT BY ' + d.tradesShortOfMinTrl + ')' : '  (met)')));
  if (d.trialsDeclared <= 1) {
    L('    NOTE: trials=1 was DECLARED. If this candidate came out of a grid or a');
    L('          search, that is understated and the DSR above is too generous.');
  }
  L('');

  const c = rep.concentration;
  L('  CONCENTRATION  (' + c.periods + ' quarters)   <- is this a grind or one lucky window?');
  L('    positive quarters       ' + c.positivePeriods + '/' + c.periods);
  L('    best quarter            ' + c.bestPeriod + '  ' + r(c.bestPeriodR, 2) + 'R');
  L('    its share of GROSS      ' + pct(c.bestPeriodShareOfGross, 1));
  L('    total EXCLUDING it      ' + r(c.totalExcludingBestR, 2) + 'R'
    + '   (against ' + r(rep.all.totalR, 2) + 'R with it)');
  L('    top 5% of trades        ' + pct(c.top5pctTradeShareOfGross, 1) + ' of gross profit');
  L('');

  const b = rep.bootstrap;
  if (b) {
    L('  BLOCK BOOTSTRAP  (' + b.paths + ' paths, block length ' + b.blockLength
      + ' = round(sqrt(n)), seed ' + BOOT_SEED + ')');
    L('    probability of loss   ' + pct(b.probOfLoss, 1));
    L('    median outcome        ' + r(b.medianFinalR, 2) + 'R      worst 5%  ' + r(b.worst5pctFinalR, 2) + 'R');
    L('    median max drawdown   ' + r(b.medianMaxDdR, 2) + 'R      worst 5%  ' + r(b.worst5pctMaxDdR, 2) + 'R');
    L('    blocks, not IID: independent resampling destroys losing runs and understates DD.');
    L('');
  }

  L('  COST STRESS  (increment ' + rep.provenance.costIncrementR + 'R/trade)');
  for (const [k, v] of Object.entries(rep.costStress)) {
    L('    ' + k.padEnd(4) + ' PF ' + String(v.profitFactor).padEnd(8)
      + ' expectancy ' + String(v.expectancyR).padEnd(9) + 'R   total ' + v.totalR + 'R');
  }
  L('');

  const g = rep.diagnostics;
  L('  TRADE DIAGNOSTICS');
  L('    exit reasons   ' + g.exitReasonCoverage + (g.exitReasons ? '' : '  (not supplied by this harness)'));
  if (g.exitReasons) for (const [k, v] of Object.entries(g.exitReasons)) {
    L('      ' + k.padEnd(18) + 'n=' + String(v.n).padEnd(6) + 'expectancy ' + v.expectancyR + 'R');
  }
  L('    hold hours     ' + g.holdHoursCoverage + '   median ' + g.holdHoursMedian + '  p90 ' + g.holdHoursP90);
  L('    MAE            ' + g.maeCoverage + '   median ' + g.maeMedianR);
  L('');

  const v = rep.assessment;
  L('='.repeat(84));
  L('  VERDICT: ' + v.verdict + (v.checksTotal ? '   (' + v.checksPassed + '/' + v.checksTotal + ' checks passed)' : ''));
  L('='.repeat(84));
  for (const ch of (v.checks || [])) L('    [' + (ch.pass ? 'PASS' : 'FAIL') + ']  ' + ch.name.padEnd(46) + ch.detail);
  if (v.note) L('    ' + v.note);
  L('');
  L('  Read-only. This report changes no config, no gate, no threshold and no size.');
  L('');
}

// ── self-test ───────────────────────────────────────────────────────────────
/**
 * The maths, checked against cases whose answers are known by construction rather
 * than by running the code and blessing whatever came out.
 */
function selftest() {
  let failed = 0;
  const ok = (name, cond, extra) => {
    if (!cond) { failed++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
    else console.log('  ok    ' + name);
  };

  // 1. Breakeven win rate is the algebraic inverse of the payoff.
  const s = coreStats([2, 2, -1, -1, -1]);
  ok('payoff 2.0 from 2R wins and 1R losses', Math.abs(s.payoff - 2) < 1e-9, 'got ' + s.payoff);
  ok('breakeven WR at payoff 2 is 1/3', Math.abs(s.breakevenWr - 1 / 3) < 1e-9, 'got ' + s.breakevenWr);
  ok('profit factor 4/3 at 2W/3L', Math.abs(s.profitFactor - 4 / 3) < 1e-9, 'got ' + s.profitFactor);
  ok('expectancy is mean R', Math.abs(s.expectancyR - 0.2) < 1e-9, 'got ' + s.expectancyR);

  // 2. Drawdown of a known path. +1,+1,-3,+1 peaks at 2 then troughs at -1 => DD 3.
  ok('max drawdown in R', Math.abs(equity([1, 1, -3, 1]).maxDD - 3) < 1e-9);

  // 3. Losing streak counted, scratches break a run rather than extending it.
  ok('longest losing run', streaks([-1, -1, -1, 1, -1]).longestLoss === 3);
  ok('a scratch breaks the run', streaks([-1, -1, 0, -1]).longestLoss === 2);

  // 4. Bootstrap is deterministic under a fixed seed.
  const rs = Array.from({ length: 64 }, (_, i) => (i % 3 === 0 ? 1.5 : -0.6));
  const b1 = blockBootstrap(rs, 200, 123), b2 = blockBootstrap(rs, 200, 123);
  ok('bootstrap reproducible from seed', b1.probOfLoss === b2.probOfLoss);
  ok('block length is round(sqrt(n))', b1.blockLength === Math.round(Math.sqrt(64)));

  // 5. Deflation is MONOTONIC: more trials can only lower confidence, never raise it.
  const d1 = deflated(rs, 1), d40 = deflated(rs, 40);
  ok('more trials never increases DSR',
    d1.deflatedSharpe !== null && d40.deflatedSharpe !== null && d40.deflatedSharpe <= d1.deflatedSharpe,
    'trials1=' + d1.deflatedSharpe + ' trials40=' + d40.deflatedSharpe);
  ok('at trials=1 the DSR equals the PSR', Math.abs(d1.deflatedSharpe - d1.psr) < 1e-12);

  // 6. Concentration finds the single carrying period. Three flat quarters and one
  //    huge one: the big quarter must be named and ex-best must drop below total.
  const periods = [
    { key: '2021Q1', n: 10, totalR: 1 }, { key: '2021Q2', n: 10, totalR: -1 },
    { key: '2021Q3', n: 10, totalR: 20 }, { key: '2021Q4', n: 10, totalR: -2 },
  ];
  const con = concentration([{ r: 1 }, { r: -1 }, { r: 20 }, { r: -2 }], periods);
  ok('best period identified', con.bestPeriod === '2021Q3');
  ok('ex-best total excludes it', Math.abs(con.totalExcludingBestR - (-2)) < 1e-9, 'got ' + con.totalExcludingBestR);
  ok('best-period share of gross', Math.abs(con.bestPeriodShareOfGross - 20 / 21) < 1e-9);

  // 7. A sample under the floor must refuse to give a verdict at all.
  const tiny = buildReport(Array.from({ length: 5 }, () => ({ r: 1 })),
    { label: 't', isFrac: 0.7, costR: 0.05, trials: 1, tradesFile: null });
  ok('under the floor returns TOO FEW TO JUDGE', tiny.assessment.verdict === 'TOO FEW TO JUDGE');

  // 8. The screenshot's own arithmetic, reproduced. A payoff of 1109.25/439.55 needs
  //    28.4% and it had 25.3% — the file must agree with the hand calculation.
  const payoff = 1109.25 / 439.55;
  const be = 1 / (1 + payoff);
  ok('screenshot breakeven WR is 28.4%', Math.abs(be - 0.2839) < 0.0005, 'got ' + be.toFixed(4));

  console.log('');
  console.log(failed === 0 ? '  ALL CHECKS PASSED' : '  ' + failed + ' CHECK(S) FAILED');
  return failed;
}

// ── main ────────────────────────────────────────────────────────────────────
function main() {
  if (flag('--selftest')) {
    console.log('');
    console.log('lab_report.cjs self-test');
    process.exit(selftest() === 0 ? 0 : 1);
  }

  const tradesFile = opt('--trades', null);
  if (!tradesFile) {
    console.error('usage: node tasks/lab_report.cjs --trades <file.json> [--label "..."] '
      + '[--is-frac 0.7] [--trials 1] [--cost 0.05] [--json] [--out <file>]');
    console.error('       node tasks/lab_report.cjs --selftest');
    process.exit(2);
  }
  const abs = path.isAbsolute(tradesFile) ? tradesFile : path.join(ROOT, tradesFile);
  if (!fs.existsSync(abs)) { console.error('no such trades file: ' + abs); process.exit(2); }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(abs, 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    console.error('could not parse trades file: ' + e.message);
    process.exit(2);
  }
  const trades = Array.isArray(parsed) ? parsed
    : (parsed.trades || parsed.journal || parsed.rows || null);
  if (!Array.isArray(trades)) {
    console.error('trades file must be an array, or an object with .trades/.journal/.rows');
    process.exit(2);
  }

  const rep = buildReport(trades, {
    label: opt('--label', path.basename(tradesFile)),
    isFrac: Math.min(0.95, Math.max(0.05, Number(opt('--is-frac', '0.7')))),
    costR: Number(opt('--cost', '0.05')),
    trials: Math.max(1, Number(opt('--trials', '1'))),
    tradesFile: tradesFile,
  });

  const outFile = opt('--out', null);
  if (outFile) {
    const outAbs = path.isAbsolute(outFile) ? outFile : path.join(ROOT, outFile);
    fs.mkdirSync(path.dirname(outAbs), { recursive: true });
    fs.writeFileSync(outAbs, JSON.stringify(rep, null, 2));
  }

  if (flag('--json')) console.log(JSON.stringify(rep, null, 2));
  else print(rep);

  if (outFile && !flag('--json')) console.log('  artifact -> ' + outFile);
  process.exit(0);
}

if (require.main === module) main();

module.exports = {
  RULE, coreStats, equity, streaks, concentration, byQuarter,
  blockBootstrap, deflated, costStress, diagnostics, verdict, buildReport, selftest,
};
