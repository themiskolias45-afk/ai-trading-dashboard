#!/usr/bin/env node
'use strict';
/* ============================================================================
   montecarlo_report.cjs — the robustness report, on THIS system's own trades
   ============================================================================

   Builds the data behind /report: an equity curve, a Monte-Carlo fan around it,
   monthly returns by year, and the three distributions that say how much of the
   result is edge and how much is luck.

   WHAT A BOOTSTRAP DOES AND DOES NOT DO. It resamples the SAME trades. It answers
   "given this edge, how lucky or unlucky could the path have been" - the spread of
   outcomes around a fixed edge. It does NOT test whether the edge survives out of
   sample; that is what tasks/rsi_ceiling_walkforward.cjs and tasks/pbo.cjs are for.
   A report that says "100% chance of profit" is saying "IF this edge is real", and
   every surface built on this must carry that or it is selling a backtest as a
   promise. The page does carry it.

   THE TRADES ARE REPLAYED, NOT LIVE. This system has 8 closed live fills. Eight
   trades cannot produce an equity curve, a drawdown distribution or a monthly heat
   map that means anything, and drawing one from them would be theatre. The replay
   is the honest source and every figure here is labelled as such.

   Read-only. No setting, no gate, no threshold, no position. feedsTheGate false.

   Usage:
     node tasks/montecarlo_report.cjs                 write tasks/analysis/montecarlo-latest.json
     node tasks/montecarlo_report.cjs --sims 4000     bootstrap resamples
     node tasks/montecarlo_report.cjs --risk 1        percent of balance per trade
     node tasks/montecarlo_report.cjs --print         human-readable summary too
   ============================================================================ */

const path = require("path");
const fs   = require("fs");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");

// THE HORIZON IS DECIDED ONCE, HERE, AND EXPORTED BEFORE ANY REPLAY RUNS.
//
// The live system has NO max-hold: there is no time-based close in mt5_bridge.py and no
// maxHold in the engine. So a cap is a property of the harness, never of the strategy,
// and a short one does not make the result conservative - it DELETES trades. An EXPIRED
// trade is one still open at an artificial deadline; it is dropped rather than scored,
// and a trade still running is disproportionately a WINNER. Measured on the same data,
// same day, 40 -> 320: avgR 0.153 -> 0.341, return 90.6% -> 382%, drawdown 28.4% ->
// 12.3%, and 180 dropped trades -> 6. SP500 was losing 60% of its gated trades.
//
// IT IS SET IN process.env, NOT JUST RECORDED. An earlier version of this change wrote
// the number into the horizon block, which is built AFTER the replays have finished - so
// it relabelled the output without touching the measurement, and a plain run would have
// reported 320 over a run taken at 40. Overstating while claiming honesty is worse than
// the understatement it replaced. execFileSync spreads process.env into the child, so
// exporting it here is what actually reaches tasks/_replay_mtf.cjs.
const HONEST_MAX_HOLD = 320;
if (!process.env.MTF_MAX_HOLD) process.env.MTF_MAX_HOLD = String(HONEST_MAX_HOLD);
const MAX_HOLD_USED = Number(process.env.MTF_MAX_HOLD);
const { cappedRr } = require(path.join(ROOT, "tasks", "_rr_cap.cjs"));

function opt(name, def) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}
const flag = n => process.argv.includes(n);

// 10,000 PATHS, NOT 4,000. The published guidance is consistent: 5,000 is the floor
// for a stable central estimate and 10,000+ is needed before the TAIL quantiles mean
// anything - and the tails are the whole point here. p5 return and p95 drawdown are
// the numbers this page is read for, and they are exactly the ones a small path count
// leaves noisy. At 4,000 the p5 was being reported to four significant figures from a
// sample that does not support them.
//
// The cost is arithmetic, not risk: this is a read-only replay over cached bars, so
// 2.5x the paths is 2.5x the seconds and nothing else.
const SIMS      = Number(opt("--sims", "10000"));
const RISK_PCT  = Number(opt("--risk", "1")) / 100;
const START     = Number(opt("--start", "10000"));
const GATE      = Number(opt("--gate", "70"));
const COST_R    = Number(opt("--cost", "0.05"));
const CONF_FLOOR = 40;
const PRINT     = flag("--print");

const ASSETS = [["BTCUSD", "BTC-USD"], ["XAUUSD", "GC=F"], ["SP500", "^GSPC"]];

function replay(symbol, ticker) {
  const stdout = execFileSync(
    process.execPath,
    [path.join(ROOT, "tasks", "_replay_mtf.cjs"), ROOT, symbol, ticker, String(CONF_FLOOR)],
    { env: { ...process.env, MTF_CONF_FLOOR: String(CONF_FLOOR) },
      maxBuffer: 64 * 1024 * 1024, encoding: "utf8", timeout: 900000 }
  );
  return JSON.parse(stdout);
}

// The live closed-trade count, read from the journal at report time. Returns a word
// rather than a wrong number when the journal cannot be read: a caveat that overstates
// the live sample is worse than one that declines to name it.
function liveClosedTrades() {
  try {
    const jp = path.join(ROOT, "server", "journal.json");
    if (!fs.existsSync(jp)) return "very few";
    const j = JSON.parse(fs.readFileSync(jp, "utf8"));
    const rows = Array.isArray(j) ? j : (j.trades || j.journal || []);
    return rows.filter(t => t && t.status === "CLOSED").length;
  } catch (e) {
    return "very few";
  }
}

// ── collect the trades ──────────────────────────────────────────────────────
const trades = [];
const perAsset = {};
const horizonDrop = {};
for (const [symbol, ticker] of ASSETS) {
  let rows;
  try {
    rows = replay(symbol, ticker);
  } catch (err) {
    perAsset[symbol] = "REPLAY FAILED: " + String(err.message || err).slice(0, 160);
    continue;
  }
  let kept = 0;
  // TRADES THIS REPORT THREW AWAY, counted rather than silently dropped.
  //
  // The filter below excludes every outcome that is not WIN or LOSS - which means
  // EXPIRED, the replay's label for a trade still open when it hit MAX_HOLD (40 H4
  // bars by default). Those were removed from the population with no disclosure
  // anywhere, so the headline chance-of-profit was computed over a filtered sample
  // and nothing said so.
  //
  // It is a material share, not a rounding detail: SP500 returns 48 EXPIRED against
  // 37 LOSS and 3 WIN. _replay_mtf.cjs already warns about exactly this - "the live
  // system has NO max-hold, so these are unresolved, not flat - this result is biased
  // LOW" - but it writes that to STDERR to keep stdout clean JSON, and this script
  // reads only stdout, so the warning was discarded too.
  //
  // Counted from the DATA rather than by scraping that message: the rows carry
  // `outcome`, which cannot drift out of sync with a log string. Only rows that clear
  // the gate are counted, so this describes the population the report actually
  // considered rather than everything the replay produced.
  let expired = 0;
  for (const t of rows) {
    if (Number(t.conf) < GATE) continue;
    if (t.outcome === "EXPIRED") { expired++; continue; }
    if (t.outcome !== "WIN" && t.outcome !== "LOSS") continue;
    const secs = Number(t.t);
    if (!Number.isFinite(secs) || secs <= 0) continue;
    // _replay_mtf emits SECONDS. Read as ms every trade lands in January 1970 and
    // the monthly heat map collapses into one cell.
    const ms = secs < 1e11 ? secs * 1000 : secs;
    const r = t.outcome === "WIN" ? cappedRr(t.rr) - COST_R : -(1 + COST_R);
    trades.push({ ms, r, symbol, setup: t.setup || null });
    kept++;
  }
  perAsset[symbol] = kept;
  horizonDrop[symbol] = { resolved: kept, expired, ofGated: kept + expired };
}

if (trades.length < 30) {
  console.error("Only " + trades.length + " trades at gate " + GATE + " — too few for a robustness report.");
  console.error(JSON.stringify(perAsset, null, 2));
  process.exit(1);
}
trades.sort((a, b) => a.ms - b.ms);

// ── the actual path ─────────────────────────────────────────────────────────
// Fixed-fractional: each trade risks RISK_PCT of the running balance, so a trade
// worth +2R adds 2 * RISK_PCT * balance. This is the same convention the sizing
// walk-forward uses for its RISK regime.
function walk(seq) {
  let bal = START, peak = START, maxDD = 0;
  const curve = [bal];
  for (const r of seq) {
    bal += bal * RISK_PCT * r;
    if (bal <= 0) { bal = 0; curve.push(0); break; }
    curve.push(bal);
    if (bal > peak) peak = bal;
    const dd = (peak - bal) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  return { final: bal, maxDD, curve };
}

const actual = walk(trades.map(t => t.r));

// ── bootstrap ───────────────────────────────────────────────────────────────
// Deterministic PRNG so two runs on the same trades produce the same fan. A report
// whose numbers move when nothing changed cannot be checked by anyone.
const SEED = 20260825;
let seed = SEED;
// mulberry32. Deterministic, as the old generator was, but ACTUALLY RANDOM.
//
// WHAT WAS WRONG, measured 2026-08-30. The previous line was
//     seed = (seed * 1103515245 + 12345) & 0x7fffffff
// which is a textbook LCG written in a language that cannot hold it. JavaScript
// numbers are doubles: seed * 1103515245 exceeds 2^53 for any seed above ~8,162,279,
// and this file seeded it with 20,260,825. So the multiply LOST PRECISION before the
// mask ever truncated it, and the generator degenerated.
//
// MEASURED CONSEQUENCE, state period and output variety measured separately because a
// repeated VALUE is only a birthday collision while a repeated STATE is the real period:
//
//     old LCG      state period 10,466   distinct outputs 14,894  of 1,208,000 draws
//     mulberry32   period 2^32          distinct outputs 1,207,598 of 1,208,000
//
// This report draws SIMS * n = 4,000 * 302 = 1,208,000 values, so the old generator ran
// through its entire cycle about 115 times. The "4,000 independent bootstrap resamples"
// were roughly a dozen distinct sequences repeated, and every confidence interval on the
// page rested on that. What first exposed it: five different seeds produced BYTE-IDENTICAL
// p95 drawdowns. A bootstrap whose answer does not move with the seed is not sampling.
//
// Math.imul does the multiply in true 32-bit integer space, so no precision is lost.
// Period 2^32, passes the usual smoke tests, and stays fully reproducible - the same
// SEED still gives the same report, which is the property the original was reaching for.
function rnd() {
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const finals = [], dds = [];
const n = trades.length;
const rs = trades.map(t => t.r);
// Percentile bands of the fan, sampled at a bounded number of points so the JSON
// stays small enough to serve.
const FAN_POINTS = Math.min(n, 240);
const fanIdx = Array.from({ length: FAN_POINTS }, (_, i) => Math.floor(i * n / (FAN_POINTS - 1)));
const fanSamples = fanIdx.map(() => []);

for (let s = 0; s < SIMS; s++) {
  const seq = new Array(n);
  for (let i = 0; i < n; i++) seq[i] = rs[Math.floor(rnd() * n)];
  const w = walk(seq);
  finals.push(w.final);
  dds.push(w.maxDD);
  for (let k = 0; k < fanIdx.length; k++) {
    const idx = Math.min(fanIdx[k], w.curve.length - 1);
    fanSamples[k].push(w.curve[idx]);
  }
}

// ── stationary block bootstrap ──────────────────────────────────────────────
//
// WHY A SECOND BOOTSTRAP, AND WHY IT IS THE ONE TO READ FOR DRAWDOWN.
//
// The resample above is IID: every trade is drawn independently, so the ORDER of the
// original sequence is destroyed. The textbook worry is that this UNDERSTATES drawdown,
// because real losing streaks cluster and an independent shuffle breaks them apart.
//
// MEASURED ON THIS SERIES, THAT WORRY DOES NOT HOLD - and the comment that used to sit
// here asserted it as fact before anyone checked. At mean block 17 the block arm gives
// a SHALLOWER drawdown than IID, not a deeper one: median 13.8% against 14.8%, p95
// 24.1% against 31.0%. Losses in this sequence are spread more evenly than chance, so
// the IID arm manufactures streaks the real ordering never had.
//
// Two consequences worth stating plainly. FIRST, the IID figure is the CONSERVATIVE one
// here, so it is the one to size against - the opposite of the usual advice. SECOND,
// block resampling reuses contiguous runs, so its paths resemble the realised sequence
// and the distribution NARROWS; some of that apparent improvement is reduced variety,
// not reduced risk. The block arm is therefore a test of whether ordering matters, not
// a better forecast.
//
// The stationary bootstrap (Politis & Romano 1994) resamples contiguous BLOCKS whose
// lengths are geometric with mean EXPECTED_BLOCK. Local ordering survives inside a
// block, so streaks are preserved; block starts are uniform, so the series stays
// stationary and there is no end-effect bias. At EXPECTED_BLOCK = 1 it degenerates
// exactly to the IID case, which is a useful sanity property.
//
// Nothing is replaced. Both distributions are reported side by side, because they
// answer different questions and the gap between them IS the finding: if the block
// drawdown is materially worse, the IID number was optimistic and by how much.
// Floor of 1, not 2, ON PURPOSE: at 1 this degenerates to the IID draw, which makes
// the estimator checkable against the arm beside it. An estimator that cannot be
// reduced to a known case cannot be validated.
const EXPECTED_BLOCK = Math.max(1, Number(process.env.MC_BLOCK || Math.round(Math.sqrt(n))));
const pRestart = 1 / EXPECTED_BLOCK;   // geometric block length, mean EXPECTED_BLOCK

// Same stream start as the IID arm, so the two differ ONLY by resampling scheme.
// Without this the block arm continued from wherever the IID loop left the seed and
// the comparison mixed two effects.
seed = SEED;
const blockFinals = [], blockDds = [];
for (let s = 0; s < SIMS; s++) {
  const seq = new Array(n);
  let idx = Math.floor(rnd() * n);
  for (let i = 0; i < n; i++) {
    // Start a new block with probability pRestart, else walk forward one trade,
    // wrapping at the end so every position is equally likely to be sampled.
    if (i === 0 || rnd() < pRestart) idx = Math.floor(rnd() * n);
    else idx = (idx + 1) % n;
    seq[i] = rs[idx];
  }
  const w = walk(seq);
  blockFinals.push(w.final);
  blockDds.push(w.maxDD);
}

const pct = (arr, p) => {
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.max(0, Math.floor(p * (a.length - 1))))];
};

const fan = fanIdx.map((tradeNo, k) => {
  const col = fanSamples[k];
  return {
    trade: tradeNo,
    p5: pct(col, 0.05), p25: pct(col, 0.25), p50: pct(col, 0.50),
    p75: pct(col, 0.75), p95: pct(col, 0.95),
    actual: actual.curve[Math.min(tradeNo, actual.curve.length - 1)],
  };
});

// ── monthly returns, by year ────────────────────────────────────────────────
// Walked forward on the ACTUAL sequence so each month's figure is the return the
// balance really made that month, not an average of per-trade R.
const monthly = {};
{
  let bal = START;
  for (const t of trades) {
    const d = new Date(t.ms);
    const y = d.getUTCFullYear(), m = d.getUTCMonth();
    monthly[y] = monthly[y] || { months: new Array(12).fill(null), start: bal };
    if (monthly[y].months[m] === null) monthly[y].months[m] = { start: bal, end: bal };
    bal += bal * RISK_PCT * t.r;
    monthly[y].months[m].end = bal;
  }
}
const monthlyRows = Object.keys(monthly).sort().map(y => {
  const row = monthly[y];
  const months = row.months.map(mm => mm === null ? null
    : Math.round(((mm.end - mm.start) / mm.start) * 1000) / 10);
  const first = row.months.find(Boolean);
  const last = [...row.months].reverse().find(Boolean);
  return {
    year: Number(y), months,
    yearPct: first && last ? Math.round(((last.end - first.start) / first.start) * 1000) / 10 : null,
  };
});

// ── per-trade R histogram ───────────────────────────────────────────────────
function histogram(values, lo, hi, bins) {
  const out = new Array(bins).fill(0);
  const w = (hi - lo) / bins;
  for (const v of values) {
    let b = Math.floor((v - lo) / w);
    if (b < 0) b = 0;
    if (b >= bins) b = bins - 1;
    out[b]++;
  }
  return { lo, hi, bins, counts: out, width: w };
}

const result = {
  generatedAt: new Date().toISOString(),
  source: "REPLAY of the live engine over cached broker bars — NOT live fills",
  params: { gate: GATE, riskPct: RISK_PCT * 100, start: START, sims: SIMS, costR: COST_R },
  // THE CONFIG THIS RAN UNDER, not just the harness knobs.
  //
  // Two reports used to look directly comparable while having been produced by
  // materially different engines. Measured 2026-08-30: the 08-25 report held 227
  // trades with a 43.6% chance of profit; the very next run held 302 with 97.1%, on
  // IDENTICAL params - gate 70, risk 1%, 4,000 sims, 0.05R costs. Nothing in either
  // artifact explained the gap.
  //
  // The cause was config drift underneath the harness. momentumRsiMax had been raised
  // from its 72 default to 88 and trendFollowRsiMax from 68 to 84 by the automated
  // jarvis-daily-unblock-btc, which admitted 79% more BTCUSD trades (67 -> 120). The
  // report was right both times and comparing them was meaningless.
  //
  // So the settings that decide WHICH TRADES EXIST are stamped into the artifact. A
  // reader can now see that two reports are not comparable instead of assuming they
  // are, and settingsError says when the engine was running built-in defaults rather
  // than the saved file. Read-only: this records config, it never writes it.
  engineConfig: (() => {
    try {
      const sp = path.join(__dirname, "..", "server", "strategy_settings.json");
      if (!fs.existsSync(sp)) return { available: false, why: "strategy_settings.json not on this box (it is per-machine and untracked)" };
      const cfg = JSON.parse(fs.readFileSync(sp, "utf8"));
      return {
        available: true,
        confidenceThreshold: cfg.confidenceThreshold ?? null,
        momentumRsiMax: cfg.momentumRsiMax ?? null,
        trendFollowRsiMax: cfg.trendFollowRsiMax ?? null,
        // Defaults named beside the live values, so drift is visible without a lookup.
        defaults: { momentumRsiMax: 72, trendFollowRsiMax: 68 },
        arm: cfg.arm ?? null,
        lastWrittenBy: cfg.lastWrittenBy ?? null,
        lastWrittenAt: cfg.updatedAt ?? cfg.lastWrittenAt ?? null,
      };
    } catch (e) {
      // Never take the report down over its own provenance block.
      return { available: false, why: "unreadable: " + e.message };
    }
  })(),
  population: perAsset,
  trades: n,
  span: { from: new Date(trades[0].ms).toISOString().slice(0, 10),
          to: new Date(trades[n - 1].ms).toISOString().slice(0, 10) },
  avgR: rs.reduce((a, b) => a + b, 0) / n,
  winRate: (trades.filter(t => t.r > 0).length / n) * 100,
  actual: { final: actual.final, returnPct: ((actual.final - START) / START) * 100, maxDDPct: actual.maxDD * 100 },
  // THE SAME TRADES, RESAMPLED IN BLOCKS SO LOSING STREAKS SURVIVE.
  // Read THIS for drawdown; read `simulated` for how much of the result was draw luck.
  // The delta between the two is the cost of assuming trades are independent.
  blockSimulated: (() => {
    const bMedDD = pct(blockDds, 0.50) * 100;
    const bP95DD = pct(blockDds, 0.95) * 100;
    const iMedDD = pct(dds, 0.50) * 100;
    const iP95DD = pct(dds, 0.95) * 100;
    return {
      method: "stationary block bootstrap (Politis-Romano)",
      expectedBlockTrades: EXPECTED_BLOCK,
      chanceOfProfit: (blockFinals.filter(f => f > START).length / SIMS) * 100,
      p5ReturnPct:  ((pct(blockFinals, 0.05) - START) / START) * 100,
      p50ReturnPct: ((pct(blockFinals, 0.50) - START) / START) * 100,
      p95ReturnPct: ((pct(blockFinals, 0.95) - START) / START) * 100,
      medianMaxDDPct: bMedDD,
      p95MaxDDPct: bP95DD,
      // How much the IID run understated the drawdown, in percentage POINTS. Positive
      // means blocks are worse, which is the expected direction when losses cluster.
      medianDDWorseThanIidPts: parseFloat((bMedDD - iMedDD).toFixed(2)),
      p95DDWorseThanIidPts: parseFloat((bP95DD - iP95DD).toFixed(2)),
      note: "Resamples contiguous blocks (geometric length, mean " + EXPECTED_BLOCK
        + " trades) so losing streaks survive, where the IID arm shuffles trades "
        + "independently and destroys them. It tests whether ORDER matters. On this "
        + "series it does, in the unexpected direction: block drawdowns come out "
        + "SHALLOWER, so losses are spread more evenly than chance and the IID arm is "
        + "the conservative one. Size against IID. Note also that blocks reuse "
        + "contiguous runs, so paths resemble the realised sequence and the spread "
        + "narrows - part of the improvement is less variety, not less risk.",
    };
  })(),
  simulated: {
    chanceOfProfit: (finals.filter(f => f > START).length / SIMS) * 100,
    p5ReturnPct:  ((pct(finals, 0.05) - START) / START) * 100,
    p50ReturnPct: ((pct(finals, 0.50) - START) / START) * 100,
    p95ReturnPct: ((pct(finals, 0.95) - START) / START) * 100,
    medianMaxDDPct: pct(dds, 0.50) * 100,
    p95MaxDDPct:    pct(dds, 0.95) * 100,
  },
  fan,
  monthly: monthlyRows,
  histograms: {
    finalReturn: histogram(finals.map(f => ((f - START) / START) * 100), 0, Math.max(100, pct(finals, 0.99) / START * 100), 40),
    maxDrawdown: histogram(dds.map(d => d * 100), 0, Math.min(100, pct(dds, 0.99) * 100 * 1.4), 40),
    perTradeR:   histogram(rs, -1.6, 2.6, 42),
  },
  // WHAT THIS REPORT LEFT OUT, as a first-class field rather than a console line.
  // The page renders it; a reader can see the size of the exclusion instead of
  // taking the headline over a filtered sample at face value.
  horizon: (() => {
    // DEFAULT 320, NOT 40. The live system has NO max-hold - verified: there is no
    // time-based close anywhere in mt5_bridge.py and no maxHold in the engine - so 40 was
    // never a property of this strategy, it was a property of the harness. Every number
    // this report has ever published was computed on the resolved remainder after
    // throwing away trades that were merely still open, and that exclusion is not
    // neutral: an unresolved trade is disproportionately a WINNER still running.
    //
    // Measured on the same data, same day, 40 -> 320:
    //     avgR            0.1532  ->  0.3407
    //     win rate         35.8%  ->   42.7%
    //     actual return    90.6%  ->  382.0%
    //     max drawdown     28.4%  ->   12.3%
    //     chance of profit 96.0%  ->  100.0%
    //     expired dropped    180  ->       6
    // SP500 was the worst hit: 64 of 107 gated trades - SIXTY PERCENT - were discarded.
    //
    // The strategy did not change. The ruler did. This file already told the reader to
    // "re-run with MTF_MAX_HOLD=320" and the scheduled task never passed it, so the
    // instruction sat in the output of a report nobody re-ran by hand.
    // Reads the SAME value the replays were given, so the label cannot drift from the
    // measurement. This is the whole point of deciding it once at the top.
    const maxHoldBars = MAX_HOLD_USED;
    let expired = 0, resolved = 0;
    for (const v of Object.values(horizonDrop)) {
      if (!v || typeof v !== "object") continue;
      expired += v.expired; resolved += v.resolved;
    }
    const ofGated = expired + resolved;
    const sharePct = ofGated ? parseFloat(((expired / ofGated) * 100).toFixed(1)) : 0;
    return {
      maxHoldBars,
      perAsset: horizonDrop,
      expiredDropped: expired,
      resolvedKept: resolved,
      ofGated,
      sharePct,
      // 20% is the same floor _replay_mtf.cjs uses for its own stderr warning; kept
      // identical so the two cannot disagree about when this matters.
      material: sharePct > 20,
      // A REPORT MUST SAY WHETHER ITS RULER MATCHES THE LIVE SYSTEM. This is the single
      // parameter that moved every headline number by more than a factor of two, and the
      // page rendered none of it. Now the payload states it plainly and the page can too.
      matchesLiveBehaviour: maxHoldBars >= HONEST_MAX_HOLD,
      liveHasNoMaxHold: true,
      note: "EXPIRED means the trade was still open at MAX_HOLD and was DROPPED from this "
        + "report, not scored flat. The live system has NO max-hold - there is no "
        + "time-based close in the bridge - so these are unresolved rather than losses. "
        + (maxHoldBars >= HONEST_MAX_HOLD
            ? "This run used " + maxHoldBars + " bars, which lets trades resolve and "
              + "matches how the live system actually behaves."
            : "THIS RUN USED " + maxHoldBars + " BARS, WHICH DOES NOT MATCH LIVE. Numbers "
              + "below are biased DOWNWARD: at 40 bars this same data reported avgR 0.153 "
              + "against 0.341 at 320. Re-run with MTF_MAX_HOLD=320."),
    };
  })(),
  // The RAW R-multiple series in time order - distinct from histograms.perTradeR,
  // which is bucketed and lossy. Emitted so tasks/sharpe_robustness.cjs computes PSR,
  // Deflated Sharpe and MinTRL over the SAME population this report bootstraps rather
  // than re-running the replay and creating a second source of truth that can drift.
  // Moments cannot be recovered from a histogram, so the series is required.
  perTradeRSeries: rs,
  // THE SAME TRADES, WITH THEIR DATES. perTradeRSeries above is 469 bare numbers, and
  // flattening to numbers threw away a timestamp this file already holds -- `trades`
  // carries `ms` from the replay row's `t` (tasks/_replay_mtf.cjs:683). Nothing could
  // therefore ask WHEN of this population, so no consumer could compute concentration:
  // whether a result grinds, or rests on one quarter out of twenty-one. That question
  // is the difference between an equity curve and an assessment.
  //
  // PURELY ADDITIVE. perTradeRSeries is untouched and every existing reader of it,
  // including tasks/sharpe_robustness.cjs and /report, is unaffected. The watched
  // fields in tasks/page_parity.cjs are named individually, so a new key cannot
  // trip fleet parity.
  perTradeRows: trades.map(t => ({
    openTime: new Date(t.ms).toISOString(),
    r: t.r,
    symbol: t.symbol || null,
    setup: t.setup || null,
  })),
  caveats: [
    // The live count is read from the journal rather than baked in. It said "8" while
    // the journal held 7, and it moves with every fill - a figure hardcoded into a
    // caveat is correct only until the next trade closes.
    "REPLAYED trades, not live fills. This system has " + liveClosedTrades() + " closed "
      + "live trades, which cannot produce a drawdown distribution that means anything.",
    "A bootstrap resamples the SAME trades. It shows the range of LUCK around an edge — "
      + "it does NOT test whether the edge survives out of sample.",
    "Out-of-sample is a different question, answered by rsi_ceiling_walkforward.cjs "
      + "(sequential folds) and pbo.cjs (selection bias).",
    "Costs charged at " + COST_R + "R/trade. No slippage model, no margin model.",
  ],
  feedsTheGate: false,
};

const outDir = path.join(ROOT, "tasks", "analysis");
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, "montecarlo-latest.json");
fs.writeFileSync(outPath, JSON.stringify(result, null, 2));

if (PRINT) {
  const f1 = v => (v >= 0 ? "+" : "") + v.toFixed(1);
  console.log("");
  console.log("ROBUSTNESS — " + n + " replayed trades at gate " + GATE
            + ", " + result.span.from + " -> " + result.span.to);
  console.log("=".repeat(74));
  console.log("  avg " + result.avgR.toFixed(3) + "R/trade   win " + result.winRate.toFixed(1) + "%"
            + "   actual " + f1(result.actual.returnPct) + "%   maxDD " + result.actual.maxDDPct.toFixed(1) + "%");
  console.log("  " + SIMS + " bootstrap resamples:");
  console.log("    chance of profit  " + result.simulated.chanceOfProfit.toFixed(1) + "%");
  console.log("    90% band          " + f1(result.simulated.p5ReturnPct) + "% ... " + f1(result.simulated.p95ReturnPct) + "%");
  console.log("    median            " + f1(result.simulated.p50ReturnPct) + "%");
  console.log("    typical / worst DD " + result.simulated.medianMaxDDPct.toFixed(0) + "% / "
            + result.simulated.p95MaxDDPct.toFixed(0) + "%");
  console.log("");
  for (const c of result.caveats) console.log("  · " + c);
  console.log("");
}
console.log(outPath);
