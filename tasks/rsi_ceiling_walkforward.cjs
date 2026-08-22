'use strict';
/**
 * Walk-forward sweep of the two RSI CEILINGS — the bars MOMENTUM and TREND_FOLLOW must
 * sit UNDER before they are allowed to fire.
 *
 * WHY THIS EXISTS. Measured 2026-08-22 on the live near-miss census: 24 of 24 setups
 * that got close enough to fail exactly one check failed on RSI_ABOVE_CEILING, the
 * closest by 1.5 points. That makes the ceiling the binding constraint on how often this
 * system trades — well ahead of the confidence gate everyone actually looks at. And
 * until the constants became readable from strategySettings, NO harness in this project
 * could move them: tasks/rsi_walkforward.cjs sweeps only the FLOOR (minEntryRsi), and
 * _replay_mtf.cjs plumbed only the floor. The top blocker was the one number in the
 * engine defended by opinion rather than evidence.
 *
 * IT CHANGES NOTHING. Nothing on disk is written but the report. The overrides reach the
 * engine through the replay sandbox's private copy of the settings object; the live
 * strategy_settings.json carries neither key, so the running system keeps 72 and 68.
 *
 * SCORED ON THE WORST FOLD, NOT THE MEAN. This is the standard CLAUDE.md already applies
 * to the confidence gate: 70 survives as the gate because its one negative fold is
 * -0.016 against -0.165 at 55 and -0.204 at 75, not because its average is best. A mean
 * rewards a candidate that is spectacular in one window and ruinous in another, which is
 * exactly the shape that does not survive contact with a new market. A challenger has to
 * beat the baseline's WORST fold.
 *
 * MORE TRADES IS NOT THE GOAL. Loosening the ceiling will always admit more setups; the
 * question this answers is whether the ones it admits pay. A candidate that trades twice
 * as often for a worse worst-fold is a worse system, not a busier one.
 *
 * Usage:
 *   node tasks/rsi_ceiling_walkforward.cjs [proj-root]
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = process.argv[2] || path.join(__dirname, "..");
const ASSETS = [
  ["XAUUSD", "GC=F"],
  ["BTCUSD", "BTC-USD"],
  ["SP500",  "^GSPC"],
];

// The two ceilings move together and always have: 72 for MOMENTUM, 68 for TREND_FOLLOW,
// a 4-point gap. The sweep preserves that gap and slides the pair, so this measures the
// BAND rather than two independent dials — with 5 closed live fills there is nowhere
// near the evidence to justify decoupling them.
//
// 100/100 is "no ceiling at all", included as the honest upper bound: if the ceiling is
// pure cost, that candidate wins, and if it is doing real work it should lose badly.
const CANDIDATES = [
  { label: "56/52",  momentum: 56, trendFollow: 52 },
  { label: "64/60",  momentum: 64, trendFollow: 60 },
  { label: "72/68",  momentum: 72, trendFollow: 68, baseline: true },
  { label: "80/76",  momentum: 80, trendFollow: 76 },
  { label: "88/84",  momentum: 88, trendFollow: 84 },
  { label: "none",   momentum: 100, trendFollow: 100 },
];

const FOLDS      = 5;
const COST_R     = 0.05;   // the house cost basis, same as every other MTF harness here
const CONF_FLOOR = 40;     // expose sub-gate cohorts so the replay emits them
const LIVE_GATE  = 70;     // score only what would actually have traded
const MIN_FOLD_CLOSES = 5; // a fold under this is not scored, never scored as zero

const OUT_DIR = path.join(ROOT, "tasks", "analysis");
fs.mkdirSync(OUT_DIR, { recursive: true });

function replay(symbol, ticker, candidate) {
  const stdout = execFileSync(
    process.execPath,
    [path.join(ROOT, "tasks", "_replay_mtf.cjs"), ROOT, symbol, ticker, String(CONF_FLOOR)],
    {
      env: {
        ...process.env,
        MTF_CONF_FLOOR: String(CONF_FLOOR),
        MTF_MOMENTUM_RSI_MAX: String(candidate.momentum),
        MTF_TREND_FOLLOW_RSI_MAX: String(candidate.trendFollow),
      },
      maxBuffer: 64 * 1024 * 1024,
      encoding: "utf8",
      timeout: 900000,
    }
  );
  return JSON.parse(stdout);
}

function stat(trades) {
  const closed = trades.filter(t => t.outcome !== "EXPIRED");
  const wins   = closed.filter(t => t.outcome === "WIN");
  const losses = closed.filter(t => t.outcome === "LOSS");
  const grossWin  = wins.reduce((a, t) => a + t.rr - COST_R, 0);
  const grossLoss = losses.reduce(a => a + 1 + COST_R, 0);
  return {
    closed: closed.length,
    wr: closed.length ? (wins.length / closed.length) * 100 : 0,
    pf: grossLoss ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
    R: grossWin - grossLoss,
    rpt: closed.length ? (grossWin - grossLoss) / closed.length : 0,
  };
}

// Collect every candidate's trades before printing anything, so a replay failure
// surfaces as a failure rather than half a table.
const byCandidate = {};
const perAssetErrors = {};
for (const candidate of CANDIDATES) {
  const trades = [];
  for (const [symbol, ticker] of ASSETS) {
    try {
      for (const t of replay(symbol, ticker, candidate)) trades.push({ ...t, sym: symbol });
    } catch (err) {
      perAssetErrors[`${symbol}@${candidate.label}`] = String(err.message || err).slice(0, 300);
    }
  }
  trades.sort((a, b) => a.t - b.t);
  byCandidate[candidate.label] = trades;
  process.stderr.write(`  ceiling ${candidate.label.padEnd(6)} ${trades.length} raw trades\n`);
}

const baselineCandidate = CANDIDATES.find(c => c.baseline);
const baseline = byCandidate[baselineCandidate.label] || [];
if (baseline.length === 0) {
  console.error("rsi_ceiling_walkforward: the baseline produced no trades — refusing to "
    + "report. That is a harness failure, not a result.");
  console.error(JSON.stringify(perAssetErrors, null, 2));
  process.exit(1);
}

// Fold boundaries come from the BASELINE population at the live gate; every candidate is
// then bucketed into those same date ranges. Cutting folds per-candidate would compare
// different windows against each other.
const baseAtGate = baseline.filter(t => t.conf >= LIVE_GATE);
if (baseAtGate.length < FOLDS * MIN_FOLD_CLOSES) {
  console.error(`rsi_ceiling_walkforward: only ${baseAtGate.length} baseline trades at gate `
    + `${LIVE_GATE} — too few to split into ${FOLDS} folds worth trusting.`);
  process.exit(1);
}
const foldSize = Math.floor(baseAtGate.length / FOLDS);
const bounds = [];
for (let k = 0; k < FOLDS; k++) {
  const from = baseAtGate[k * foldSize].t;
  const to = (k === FOLDS - 1)
    ? baseAtGate[baseAtGate.length - 1].t
    : baseAtGate[(k + 1) * foldSize].t;
  bounds.push({ from, to, last: k === FOLDS - 1 });
}
const inFold = (t, b) => t.t >= b.from && (b.last ? t.t <= b.to : t.t < b.to);

// The worst SCORED fold. A fold with too few closes is not a zero and not a win — it is
// an absence, and averaging it in either direction would be inventing evidence.
function worstFold(perFold) {
  const scored = perFold.filter(s => s.closed >= MIN_FOLD_CLOSES);
  if (!scored.length) return null;
  return scored.reduce((worst, s) => (s.rpt < worst.rpt ? s : worst), scored[0]).rpt;
}

const summaries = {};
for (const candidate of CANDIDATES) {
  const atGate = (byCandidate[candidate.label] || []).filter(t => t.conf >= LIVE_GATE);
  const perFold = bounds.map(b => stat(atGate.filter(t => inFold(t, b))));
  const scored = perFold.filter(s => s.closed >= MIN_FOLD_CLOSES);
  const positive = scored.filter(s => s.rpt > 0).length;
  summaries[candidate.label] = {
    label: candidate.label,
    momentumRsiMax: candidate.momentum,
    trendFollowRsiMax: candidate.trendFollow,
    isBaseline: !!candidate.baseline,
    perFold: perFold.map((s, i) => ({
      fold: i + 1, closed: s.closed, wr: +s.wr.toFixed(1),
      R: +s.R.toFixed(1), rpt: +s.rpt.toFixed(3),
      scored: s.closed >= MIN_FOLD_CLOSES,
    })),
    foldsScored: scored.length,
    foldsPositive: positive,
    worstFold: worstFold(perFold),
    overall: (() => { const o = stat(atGate); return {
      closed: o.closed, wr: +o.wr.toFixed(1),
      pf: o.pf === Infinity ? "inf" : +o.pf.toFixed(2),
      R: +o.R.toFixed(1), rpt: +o.rpt.toFixed(3) }; })(),
    stability: scored.length < 3 ? "TOO FEW TRADES"
      : positive === scored.length ? "ROBUST"
      : positive >= Math.ceil(scored.length * 0.6) ? "MOSTLY POSITIVE"
      : positive === 0 ? "CONSISTENTLY NEGATIVE"
      : "UNSTABLE",
  };
}

const base = summaries[baselineCandidate.label];
// The verdict every candidate is actually judged on. Beating the baseline's mean is not
// enough and is not reported as if it were.
for (const summary of Object.values(summaries)) {
  if (summary.isBaseline) { summary.verdict = "BASELINE — what ships today"; continue; }
  if (summary.worstFold === null || base.worstFold === null) {
    summary.verdict = "UNJUDGEABLE — no fold reached the close floor";
    continue;
  }
  summary.beatsBaselineWorstFold = summary.worstFold > base.worstFold;
  summary.tradesVsBaseline = summary.overall.closed - base.overall.closed;
  summary.verdict = summary.beatsBaselineWorstFold
    ? (summary.stability === "ROBUST" || summary.stability === "MOSTLY POSITIVE"
        ? "CHALLENGER — beats the baseline's worst fold"
        : "BEATS WORST FOLD BUT UNSTABLE — not a challenger")
    : "REJECTED — does not beat the baseline's worst fold";
}

const report = {
  generatedAt: new Date().toISOString(),
  basis: {
    path: "generateSignalMTF",
    settings: ["momentumRsiMax", "trendFollowRsiMax"],
    baseline: baselineCandidate.label,
    costR: COST_R,
    confFloor: CONF_FLOOR,
    scoredAtGate: LIVE_GATE,
    folds: FOLDS,
    minFoldCloses: MIN_FOLD_CLOSES,
    scoredOn: "WORST FOLD — a challenger must beat the baseline's worst fold, not its mean",
    foldsFrom: `baseline (${baselineCandidate.label}) population at the live gate`,
    stubbed: ["priceCache.dxy", "priceCache.vix", "sentimentCache.fearGreed",
              "signalCache (cross-asset)", "getLearningBoost -> 0"],
    caveat: "rr artifacts are NOT capped here; folds are equal-count on the baseline, not equal-time",
    changesNothing: "measurement only — the live engine keeps 72/68 unless a human edits strategy_settings.json",
  },
  replayErrors: perAssetErrors,
  foldRanges: bounds.map(b => ({
    from: new Date(b.from * 1000).toISOString().slice(0, 10),
    to:   new Date(b.to * 1000).toISOString().slice(0, 10),
  })),
  candidates: summaries,
};

const lines = [];
lines.push("=".repeat(104));
lines.push(`  RSI CEILING WALK-FORWARD — generateSignalMTF — ${report.generatedAt}`);
lines.push(`  scored at gate ${LIVE_GATE}, ${FOLDS} folds, cost ${COST_R}R/trade, judged on WORST FOLD`);
lines.push("=".repeat(104));
lines.push("  fold ranges: " + report.foldRanges.map(f => `${f.from}..${f.to}`).join("  "));
lines.push("");
lines.push("  ceiling " + bounds.map((_, i) => `fold${i + 1}`.padStart(9)).join("")
  + "     worst   closed    totalR   pos/scored  verdict");

for (const candidate of CANDIDATES) {
  const s = summaries[candidate.label];
  lines.push("  " + s.label.padEnd(7)
    + s.perFold.map(f => (f.scored ? (f.rpt >= 0 ? "+" : "") + f.rpt.toFixed(3) : "n<5").padStart(9)).join("")
    + "  " + (s.worstFold === null ? "     —" : ((s.worstFold >= 0 ? "+" : "") + s.worstFold.toFixed(3))).padStart(8)
    + String(s.overall.closed).padStart(9)
    + ((s.overall.R >= 0 ? "+" : "") + s.overall.R.toFixed(1)).padStart(10)
    + `${s.foldsPositive}/${s.foldsScored}`.padStart(13)
    + "  " + s.verdict);
}

lines.push("");
lines.push("  WORST FOLD is the number that decides. A candidate that is spectacular in one");
lines.push("  window and ruinous in another has a fine mean and does not survive a new market.");
lines.push("  More trades is not the goal: loosening a ceiling always admits more setups, and");
lines.push("  the only question is whether the ones it admits pay.");
lines.push("");
const challengers = Object.values(summaries).filter(s => s.verdict && s.verdict.startsWith("CHALLENGER"));
lines.push(challengers.length
  ? "  CHALLENGER(S): " + challengers.map(c => `${c.label} (worst ${c.worstFold.toFixed(3)} vs baseline ${base.worstFold.toFixed(3)})`).join(", ")
  : `  NO CHALLENGER. Nothing beat the baseline's worst fold (${base.worstFold === null ? "—" : base.worstFold.toFixed(3)}). The ceiling stays at ${baselineCandidate.label}.`);
lines.push("");
lines.push("  This changes nothing by itself. strategy_settings.json carries neither key, so the");
lines.push("  live engine keeps 72/68 until a human edits it.");
lines.push("=".repeat(104));

const text = lines.join("\n");
console.log(text);

fs.writeFileSync(path.join(OUT_DIR, "rsi-ceiling-walkforward-latest.json"),
  JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(OUT_DIR, "rsi-ceiling-walkforward-latest.txt"), text + "\n");
process.stderr.write(`\n  written -> tasks/analysis/rsi-ceiling-walkforward-latest.{json,txt}\n`);
