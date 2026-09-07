#!/usr/bin/env node
'use strict';
/* ============================================================================
   pbo.cjs — Probability of Backtest Overfitting, by CSCV
   ============================================================================

   WHAT QUESTION THIS ANSWERS, AND WHY IT IS A DIFFERENT ONE.

   tasks/_deflated_bar.cjs asks: given that I tried N candidates, how big a win
   would luck alone have produced? It corrects ONE selection, on ONE axis.

   This asks something the deflated bar cannot: is the SELECTION PROCEDURE itself
   sound? If I pick the best candidate on half the history, does it stay good on
   the other half - and does it keep doing that however I cut the history?

   That distinction matters before any generator starts emitting candidates in
   volume. A tighter bar stops a lucky winner clearing it. It does not tell you
   that "pick the best in-sample" is a procedure worth running at all.

   THE METHOD: Combinatorially Symmetric Cross-Validation (Bailey, Borwein,
   Lopez de Prado & Zhu). Build a matrix of performance, T periods x N candidates.
   Chop T into S equal blocks. For every one of the C(S, S/2) ways to split those
   blocks into an in-sample half and an out-of-sample half:

     1. find the candidate that wins IN-SAMPLE
     2. look up where that same candidate RANKS out-of-sample, among all N
     3. record its relative rank w = rank/(N+1), and the logit l = log(w/(1-w))

   PBO is the share of splits where l <= 0 - where the in-sample winner lands in
   the bottom half out-of-sample. It is symmetric by construction: every split is
   also used with its halves swapped, so a trend in the data cannot masquerade as
   skill.

   HOW TO READ IT.
     PBO near 0.0   the in-sample winner keeps winning. Selection is informative.
     PBO near 0.5   the in-sample winner is a coin flip out of sample. The
                    procedure is selecting noise and a "winner" means nothing.
     PBO above 0.5  worse than a coin flip - in-sample rank is ANTI-predictive,
                    the classic signature of an overfit search.

   WHAT IT IS NOT. It is a verdict on the SEARCH, not on any single candidate. A
   low PBO does not make the incumbent good; it means that when this procedure
   picks a winner, the pick tends to survive. A high PBO does not prove the
   incumbent is bad; it means you cannot learn which one is best THIS WAY.

   SCOPE, STATED RATHER THAN IMPLIED. Today this covers axes that are a pure
   FILTER over one replay - the confidence gate is the main one, and it is also
   the axis with the most trials behind it. Axes like rsi or adx change the engine
   itself, so each candidate needs its own replay and cannot be derived by
   filtering a shared population. Those are NOT covered here and the tool says so
   rather than quietly reporting a number for something it did not measure.

   Reads a replay and does arithmetic. Touches no setting, no gate, no position.
   feedsTheGate is false and there is no write path to anything live.

   Usage:
     node tasks/pbo.cjs                          gate axis, default candidates
     node tasks/pbo.cjs --blocks 12              fewer blocks (needs T >= blocks)
     node tasks/pbo.cjs --period month|quarter   coarser buckets on a short history
     node tasks/pbo.cjs --json
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

// The same candidate set the gate axis searches, incumbent included: PBO asks
// about the SELECTION over this set, so leaving the incumbent out would measure a
// different procedure than the one that actually runs.
// Which axis to test. Two SHAPES of axis, and the difference is not cosmetic:
//
//   FILTER axes (gate) are one replay sliced N ways. Every candidate sees exactly
//   the same underlying trades, which is cheap and also the cleanest possible
//   comparison.
//
//   ENGINE axes (rsi, adx) change what the engine DOES, so they need a replay per
//   candidate. _replay_mtf.cjs says why in its own words: the entry-RSI floor runs
//   inside generateSignal on the daily AND 4H signals independently, so raising it
//   does not merely delete rows - a suppressed daily signal turns an agreeing pair
//   into an H4-only entry with different levels. There is no field on the emitted
//   trade a filter could reconstruct that from.
const AXIS = String(opt("--axis", "gate"));

// The gate a non-gate axis is measured AT. An rsi floor has to be judged on the
// trades that would actually have been taken, which means at the live gate, not
// at the conf floor the replay runs on.
const LIVE_GATE = Number(opt("--live-gate", "70"));

const AXES = {
  gate: { kind: "filter", label: "confidence gate",
          values: [45, 50, 55, 60, 65, 70, 75, 80, 85], incumbent: 70 },
  // The same five values tasks/rsi_walkforward.cjs sweeps. 0 is the incumbent and
  // means the floor is OFF.
  rsi:  { kind: "engine", label: "entry RSI floor (minEntryRsi)", env: "MTF_MIN_ENTRY_RSI",
          values: [0, 40, 45, 50, 55], incumbent: 0 },
  adx:  { kind: "engine", label: "ADX trending floor", env: "MTF_ADX_TRENDING_MIN",
          values: [15, 18, 20, 22, 25], incumbent: 20 },
  // The RSI CEILING, which is the constraint actually stopping trades: 82 of 82
  // near-misses on 2026-08-25 were RSI_ABOVE_CEILING, with BTC 21.9 points over.
  //
  // Swept as a BAND, exactly as tasks/rsi_ceiling_walkforward.cjs does it - MOMENTUM
  // and TREND_FOLLOW move together with TREND_FOLLOW four points lower. With five
  // closed live fills there is nowhere near the evidence to decouple them, and
  // sweeping two dials independently would multiply the trial count for a freedom
  // nothing has earned. 100 is "no ceiling at all", the honest upper bound: if the
  // ceiling is pure cost that candidate wins, and if it does real work it loses badly.
  ceiling: { kind: "engine", label: "RSI ceiling band (MOMENTUM / TREND_FOLLOW)",
             values: [56, 64, 72, 80, 88, 100], incumbent: 72,
             envFor: v => ({
               MTF_MOMENTUM_RSI_MAX:     String(v),
               MTF_TREND_FOLLOW_RSI_MAX: String(v === 100 ? 100 : v - 4),
             }),
             labelFor: v => v === 100 ? "none" : v + "/" + (v - 4) },
};

if (!AXES[AXIS]) {
  console.error("Unknown axis \"" + AXIS + "\". Known: " + Object.keys(AXES).join(", "));
  process.exit(1);
}
const AXIS_DEF = AXES[AXIS];

// --gates still overrides the candidate list for any axis, so a narrower or wider
// sweep can be measured without editing this file.
const GATES  = process.argv.includes("--gates")
  ? String(opt("--gates", "")).split(",").map(Number)
  : AXIS_DEF.values;
const BLOCKS = Number(opt("--blocks", "16"));
const PERIOD = String(opt("--period", "month"));
const COST_R = Number(opt("--cost", "0.05"));
// sum: the period RETURN of the configuration - what CSCV is normally run on.
// mean: R PER TRADE, which is the statistic strategy_search.cjs actually selects on.
// Both are reported because they can disagree: sum rewards taking more trades, so a
// low gate can win a good period on volume and lose a bad one the same way, and a
// conclusion that only holds under one metric is a conclusion about the metric.
const METRIC = String(opt("--metric", "sum"));
const CONF_FLOOR = 40;
const AS_JSON = flag("--json");

const ASSETS = [["BTCUSD", "BTC-USD"], ["XAUUSD", "GC=F"], ["SP500", "^GSPC"]];

// ── replay once, filter many ────────────────────────────────────────────────
function replay(symbol, ticker, extraEnv) {
  const stdout = execFileSync(
    process.execPath,
    [path.join(ROOT, "tasks", "_replay_mtf.cjs"), ROOT, symbol, ticker, String(CONF_FLOOR)],
    { env: { ...process.env, MTF_CONF_FLOOR: String(CONF_FLOOR), ...(extraEnv || {}) },
      maxBuffer: 64 * 1024 * 1024, encoding: "utf8", timeout: 900000 }
  );
  return JSON.parse(stdout);
}

// One replay -> the resolved trades it produced, in the shape CSCV needs. Shared by
// both axis shapes so a filter axis and an engine axis cannot drift in how they
// score a trade.
function resolvedTrades(trades, symbol) {
  const out = [];
  for (const t of trades) {
    if (t.outcome !== "WIN" && t.outcome !== "LOSS") continue;   // EXPIRED never resolved
    const secs = Number(t.t);
    if (!Number.isFinite(secs) || secs <= 0) continue;
    // _replay_mtf emits SECONDS. Read as ms it buckets everything into 1970 and
    // every period key collapses to one - which would look like a clean result.
    const ms = secs < 1e11 ? secs * 1000 : secs;
    const r = t.outcome === "WIN" ? cappedRr(t.rr) - COST_R : -(1 + COST_R);
    out.push({ ms, conf: Number(t.conf), r, symbol });
  }
  return out;
}

function periodKey(ms) {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  if (PERIOD === "quarter") return y + "Q" + (Math.floor(d.getUTCMonth() / 3) + 1);
  return y + "-" + String(d.getUTCMonth() + 1).padStart(2, "0");
}

// ── combinatorics ───────────────────────────────────────────────────────────
// All C(S, S/2) ways to choose the in-sample half. S=16 gives 12,870 splits,
// which is the value the CSCV paper uses and is cheap here.
function combinations(n, k) {
  const out = [];
  const cur = [];
  (function walk(start) {
    if (cur.length === k) { out.push(cur.slice()); return; }
    // Prune: not enough elements left to finish a combination.
    for (let i = start; i <= n - (k - cur.length); i++) { cur.push(i); walk(i + 1); cur.pop(); }
  })(0);
  return out;
}

// ── main ────────────────────────────────────────────────────────────────────
// byCandidate[value] = the resolved trades that candidate would have taken.
// Built two different ways depending on the axis shape, and NOTHING downstream
// knows which - so a filter axis and an engine axis are scored identically.
const byCandidate = {};
const perAsset = {};
let replays = 0;

if (AXIS_DEF.kind === "filter") {
  // One replay, sliced N ways. Every candidate sees the same underlying trades.
  const all = [];
  for (const [symbol, ticker] of ASSETS) {
    try {
      const kept = resolvedTrades(replay(symbol, ticker), symbol);
      replays++;
      all.push(...kept);
      perAsset[symbol] = kept.length + " resolved trades";
    } catch (err) {
      perAsset[symbol] = "REPLAY FAILED: " + String(err.message || err).slice(0, 160);
    }
  }
  for (const v of GATES) byCandidate[v] = all.filter(t => t.conf >= v);
} else {
  // A replay PER CANDIDATE, because the override changes which setups form at all.
  // Measured at the LIVE gate: an entry floor has to be judged on the trades that
  // would really have been taken, not on everything above the replay conf floor.
  for (const v of GATES) {
    const kept = [];
    for (const [symbol, ticker] of ASSETS) {
      try {
        // envFor lets one candidate move SEVERAL dials at once (the ceiling band).
        // A single-dial axis keeps the simple form and is untouched by this.
        const env = AXIS_DEF.envFor
          ? AXIS_DEF.envFor(v)
          : (() => { const e = {}; e[AXIS_DEF.env] = String(v); return e; })();
        const rows = resolvedTrades(replay(symbol, ticker, env), symbol);
        replays++;
        kept.push(...rows.filter(t => t.conf >= LIVE_GATE));
      } catch (err) {
        perAsset[symbol + " @" + v] = "REPLAY FAILED: " + String(err.message || err).slice(0, 120);
      }
    }
    byCandidate[v] = kept;
    perAsset[(AXIS_DEF.labelFor ? AXIS_DEF.labelFor(v) : AXIS_DEF.env + "=" + v) + " "] = kept.length + " trades at gate " + LIVE_GATE;
    process.stderr.write("  replayed " + AXIS_DEF.env + "=" + v + " -> "
      + kept.length + " trades\n");
  }
}

const allTrades = Object.values(byCandidate).flat();
// DISTINCT trades that any candidate actually took - the real sample the matrix is
// built from. Two things make it smaller than the replay's total, and both are
// correct: the union double-counts a trade admitted by several candidates, and any
// trade below the LOWEST candidate belongs to no candidate at all. On the gate axis
// the replay resolves 642 at conf>=40 while the lowest candidate is 45, so 519 is
// the honest sample size and 642 would overstate it.
// allTrades is the union of the candidate
// slices, so on a filter axis a trade admitted by six gates appears six times in it.
// That is correct for building the matrix and wrong to print as "trades": it read
// 2463 where the replay produced 642, which overstates the sample nearly 4x.
const distinctTrades = new Set(allTrades.map(t => t.symbol + ":" + t.ms + ":" + t.conf + ":" + t.r)).size;
if (!allTrades.length) {
  console.error("No resolved trades on axis \"" + AXIS + "\". Nothing to measure.");
  console.error(JSON.stringify(perAsset, null, 2));
  process.exit(1);
}

// A candidate that produced NOTHING cannot be ranked, and leaving it in would let it
// win every out-of-sample split with a flat zero while others took real losses.
// Dropped loudly rather than silently scored.
const empties = GATES.filter(v => !byCandidate[v] || byCandidate[v].length === 0);
const CANDS = GATES.filter(v => byCandidate[v] && byCandidate[v].length > 0);
if (CANDS.length < 2) {
  console.error("Only " + CANDS.length + " candidate(s) produced trades - CSCV needs at least 2.");
  process.exit(1);
}

// Periods come from the UNION across candidates, so a candidate that is quiet in a
// month is scored 0 for it rather than having the month disappear from the matrix.
const periods = [...new Set(allTrades.map(t => periodKey(t.ms)))].sort();
const matrix = periods.map(pk =>
  CANDS.map(v => {
    const rows = byCandidate[v].filter(t => periodKey(t.ms) === pk);
    if (!rows.length) return 0;
    const total = rows.reduce((a, t) => a + t.r, 0);
    return METRIC === "mean" ? total / rows.length : total;
  }));

const T = periods.length;
const N = CANDS.length;

// S must be even (the halves must be equal) and no larger than T.
let S = Math.min(BLOCKS, T);
if (S % 2 === 1) S -= 1;
if (S < 4) {
  console.error("Only " + T + " " + PERIOD + " period(s) of history — CSCV needs at least 4 blocks.");
  console.error("Try --period month, or a longer replay window.");
  process.exit(1);
}

// Equal-size blocks over the period index. The remainder is spread across the
// first blocks rather than dumped in the last one, which would make one block
// systematically longer and break the symmetry the method depends on.
const base = Math.floor(T / S);
const extra = T % S;
const blocks = [];
let cursor = 0;
for (let i = 0; i < S; i++) {
  const size = base + (i < extra ? 1 : 0);
  blocks.push(Array.from({ length: size }, (_, k) => cursor + k));
  cursor += size;
}

const sumOver = (rows, n) => rows.reduce((a, rowIdx) => a + matrix[rowIdx][n], 0);

const splits = combinations(S, S / 2);
const logits = [];
let overfitCount = 0;
const winnerTally = {};

for (const isBlocks of splits) {
  const isSet = new Set(isBlocks);
  const isRows = [];
  const oosRows = [];
  for (let b = 0; b < S; b++) (isSet.has(b) ? isRows : oosRows).push(...blocks[b]);

  // In-sample winner.
  let best = 0;
  let bestVal = -Infinity;
  for (let n = 0; n < N; n++) {
    const v = sumOver(isRows, n);
    if (v > bestVal) { bestVal = v; best = n; }
  }
  winnerTally[CANDS[best]] = (winnerTally[CANDS[best]] || 0) + 1;

  // Its out-of-sample rank, 1 = worst .. N = best. Ties share the lower rank,
  // which is the conservative direction: a winner tied with others is not
  // credited with beating them.
  const oosVals = CANDS.map((_, n) => sumOver(oosRows, n));
  const target = oosVals[best];
  const rank = 1 + oosVals.filter(v => v < target).length;

  const omega = rank / (N + 1);
  const lambda = Math.log(omega / (1 - omega));
  logits.push(lambda);
  if (lambda <= 0) overfitCount++;
}

const pbo = overfitCount / splits.length;
const meanLambda = logits.reduce((a, v) => a + v, 0) / logits.length;

const verdict =
  pbo <= 0.10 ? "SELECTION IS INFORMATIVE — the in-sample winner usually survives" :
  pbo <= 0.35 ? "SELECTION IS WEAK BUT NOT NOISE" :
  pbo <= 0.55 ? "SELECTION IS A COIN FLIP — an in-sample winner means nothing here" :
                "IN-SAMPLE RANK IS ANTI-PREDICTIVE — the signature of an overfit search";

const result = {
  measuredAt: new Date().toISOString(),
  method: "CSCV (Bailey, Borwein, Lopez de Prado & Zhu)",
  axis: "confidence gate",
  candidates: CANDS,
  candidatesRequested: GATES,
  candidatesDropped: empties,
  population: perAsset,
  trades: distinctTrades,
  periods: T, periodType: PERIOD, blocks: S, splits: splits.length,
  span: { from: periods[0], to: periods[T - 1] },
  metric: METRIC,
  pbo, meanLogit: meanLambda,
  winnerTally,
  verdict,
  caveats: [
    "A verdict on the SEARCH PROCEDURE, not on any single candidate.",
    AXIS_DEF.kind === "filter"
      ? "This axis is a pure FILTER over one replay: every candidate saw the same trades."
      : "This axis CHANGES THE ENGINE, so each candidate got its own replay (" + replays
        + " replays) and is measured at the live gate " + LIVE_GATE + ".",
    "An axis not run here is not measured here - a number for one axis says nothing "
      + "about another.",
    "A period with no trades for a candidate scores 0 - earned nothing, not missing.",
    "Costs charged at " + COST_R + "R/trade, the same basis the rest of the project uses.",
  ],
  feedsTheGate: false,
};

if (AS_JSON) {
  const outDir = path.join(ROOT, "tasks", "analysis");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "pbo-latest.json");
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(outPath);
  process.exit(0);
}

console.log("");
console.log("PROBABILITY OF BACKTEST OVERFITTING — CSCV on " + AXIS_DEF.label);
console.log("=".repeat(78));
console.log("  " + distinctTrades + " distinct trades IN THE MATRIX, " + T + " " + PERIOD + " periods "
          + periods[0] + " -> " + periods[T - 1]);
for (const [sym, note] of Object.entries(perAsset)) console.log("    " + sym.padEnd(8) + note);
console.log("  " + N + " candidates: " + CANDS.map(v => AXIS_DEF.labelFor ? AXIS_DEF.labelFor(v) : v).join(", "));
if (empties.length) {
  // A candidate that took no trade at all is not a quiet candidate, it is an
  // absent one. Named rather than dropped in silence.
  console.log("  DROPPED (no trades at all): " + empties.join(", "));
}
console.log("  " + S + " blocks, C(" + S + "," + (S / 2) + ") = " + splits.length + " symmetric splits");
console.log("");
console.log("  metric: " + (METRIC === "mean" ? "R per trade (what the searcher selects on)"
                                        : "period R total (the configuration's return)"));
console.log("  PBO = " + (pbo * 100).toFixed(1) + "%     mean logit = " + meanLambda.toFixed(3));
console.log("  " + verdict);
console.log("");
console.log("  WHICH CANDIDATE WON IN-SAMPLE, and how often:");
for (const g of CANDS) {
  const n = winnerTally[g] || 0;
  const pct = (n / splits.length) * 100;
  const bar = "#".repeat(Math.round(pct / 2));
  console.log("    " + AXIS.padEnd(7) + " " + String(AXIS_DEF.labelFor ? AXIS_DEF.labelFor(g) : g).padEnd(8) + String(n).padStart(6) + "  "
            + pct.toFixed(1).padStart(5) + "%  " + bar);
}
console.log("");
console.log("  HOW TO READ IT");
console.log("    <=10%   the in-sample winner usually survives out of sample");
console.log("    ~50%    picking the in-sample best is a coin flip - a winner means nothing");
console.log("    >50%    in-sample rank is ANTI-predictive: an overfit search");
console.log("");
for (const c of result.caveats) console.log("  · " + c);
console.log("");
