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
const { cappedRr } = require(path.join(ROOT, "tasks", "_rr_cap.cjs"));

function opt(name, def) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}
const flag = n => process.argv.includes(n);

const SIMS      = Number(opt("--sims", "4000"));
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

// ── collect the trades ──────────────────────────────────────────────────────
const trades = [];
const perAsset = {};
for (const [symbol, ticker] of ASSETS) {
  let rows;
  try {
    rows = replay(symbol, ticker);
  } catch (err) {
    perAsset[symbol] = "REPLAY FAILED: " + String(err.message || err).slice(0, 160);
    continue;
  }
  let kept = 0;
  for (const t of rows) {
    if (t.outcome !== "WIN" && t.outcome !== "LOSS") continue;
    if (Number(t.conf) < GATE) continue;
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
let seed = 20260825;
function rnd() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
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
  caveats: [
    "REPLAYED trades, not live fills. This system has 8 closed live trades; eight cannot "
      + "produce a drawdown distribution that means anything.",
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
