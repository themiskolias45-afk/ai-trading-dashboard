// Walk-forward validation of the trading constraints that are NOT the confidence
// gate — minRr, adxTrendingMin, minStrength — on the LIVE path.
//
//   node tasks/param_walkforward.cjs [projRoot] [--param minRr|adx|minStrength|all]
//
// WHY THIS EXISTS
// Every out-of-sample fold this project has ever run measured one number: the
// confidence gate. tasks/mtf_walkforward.cjs sweeps gates, tasks/rsi_walkforward.cjs
// sweeps the entry-RSI floor, and that is the whole of it. Meanwhile MIN_RR = 1.5
// has been rejecting live setups for weeks on nothing but a round number, and it is
// currently the single constraint keeping one of three assets untradeable for days
// at a time. A constraint that has never been measured is not a decision, it is an
// inheritance.
//
// HOW EACH PARAMETER IS SWEPT, AND WHY THEY DIFFER
//
//   minRr           re-replay. Lowering the bar ADMITS setups that do not exist in
//                   the baseline trade list at all, so no filter over that list can
//                   reconstruct them. It also frees the occupancy window: a trade
//                   the lower bar opens blocks a later one, so the two runs are not
//                   derivable from each other in either direction.
//
//   adxTrendingMin  re-replay. It does not delete rows — it decides which setups may
//                   form and whether one is STRONG or MODERATE, and strength feeds
//                   confidence, which feeds the gate. Nothing on the emitted trade
//                   lets a filter reconstruct that.
//
//   minStrength     post-hoc filter, and reported with the finding that it is not an
//                   independent lever at all — see the note printed with its table.
//
// SCORED AT THE LIVE GATE, NOT THE EXPOSURE FLOOR. The replay runs with
// MTF_CONF_FLOOR low so sub-gate cohorts exist at all, then trades are filtered to
// conf >= GATE before scoring, because that is the population that actually trades.
// GATE defaults to 70 — the value with 5/5 folds behind it — and is printed in the
// header and stored in the report. Override with PARAM_WF_GATE. It is deliberately
// NOT read from strategy_settings.json: that file is per-machine and untracked, so
// reading it would make the same command produce different verdicts on the laptop
// and the VPS with nothing in the output saying so.
//
// Fold boundaries come from the BASELINE run and are reused for every candidate —
// folding each candidate's own list separately would move the cut dates and make
// the columns incomparable.
//
// RUNTIME is minutes, not seconds: up to 24 full replays. --param narrows it.
//
// Deterministic — no AI, no network, no writes outside tasks/analysis/ and
// tasks/logs/. Reads nothing from the live server and changes no config. It cannot
// alter live behaviour: MTF_MIN_RR and MTF_ADX_TRENDING_MIN are read only by the
// replay sandbox.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ARGS = process.argv.slice(2);
const ROOT = ARGS.find(a => !a.startsWith("--")) || path.join(__dirname, "..");
const paramArgIdx = ARGS.indexOf("--param");
const WHICH = paramArgIdx >= 0 ? (ARGS[paramArgIdx + 1] || "all") : "all";

const ASSETS = [
  ["XAUUSD", "GC=F"],
  ["BTCUSD", "BTC-USD"],
  ["SP500",  "^GSPC"],
];

// Baseline values are the engine exactly as it ships today. Everything else is a
// delta against them, so they must stay in step with server/index.js.
const BASE_MIN_RR = 1.5;
const BASE_ADX    = 20;
const BASE_STRENGTH = "MODERATE";

// 1.35-1.49 is the band the R:R shadow log was built to answer for, so it gets two
// points either side of the live bar rather than a coarse sweep.
const MIN_RR_CANDIDATES = [1.2, 1.35, BASE_MIN_RR, 1.75, 2.0];
const ADX_CANDIDATES    = [15, BASE_ADX, 25, 30];
const STRENGTH_CANDIDATES = [BASE_STRENGTH, "STRONG"];

// The trailing ladder. "off" is the shipped exit logic — a fixed stop held to target
// or stop — and is the baseline here, because that is what these folds were built to
// judge everything else against. The candidates are give-back distances: how far
// behind price the ratchet sits once it arms at 1R.
//
// It went live on both boxes on 2026-08-07 on ONE in-sample run, which is not the
// bar this project promotes on. This is that measurement.
const BASE_TRAIL = "off";
const TRAIL_CANDIDATES = [BASE_TRAIL, 0.5, 1.0, 1.5];

// 5 by default — the number every previous verdict in this project was reached with,
// so changing the default would silently make old and new tables incomparable.
//
// Overridable because a candidate that wins under ONE set of fold boundaries has not
// been shown to win: it may simply have had a good cut. The trailing give-back of 0.5
// is exactly that case — 5/5 positive, but folds 1/3/4/5 are +0.021/+0.132/+0.008/
// +0.033 and fold 2 alone is +0.797. Re-running at a different fold count moves every
// boundary, which is the cheapest available test of whether the edge is real or is one
// lucky window. Measurement-only: nothing here can reach the live engine.
const FOLDS = (() => {
  const raw = Number(process.env.PARAM_WF_FOLDS);
  if (!Number.isFinite(raw)) return 5;
  if (!Number.isInteger(raw) || raw < 3 || raw > 12) {
    console.error(`PARAM_WF_FOLDS=${process.env.PARAM_WF_FOLDS} must be an integer 3-12 — using 5`);
    return 5;
  }
  return raw;
})();
const COST_R     = 0.05;   // same cost basis the rest of the project uses
const CONF_FLOOR = 40;     // expose sub-gate cohorts so the replay emits them
const GATE       = Number(process.env.PARAM_WF_GATE) > 0 ? Number(process.env.PARAM_WF_GATE) : 70;
const MIN_CLOSED_PER_FOLD = 5;   // the project's own floor for drawing any conclusion

const OUT_DIR = path.join(ROOT, "tasks", "analysis");
fs.mkdirSync(OUT_DIR, { recursive: true });

const replayErrors = {};
const replayCache = new Map();

// One replay per (symbol, override) pair, memoised. minRr=1.5 and adx=20 are the
// baseline for BOTH sweeps, so without the cache the shipped engine would be
// replayed twice per asset for no reason.
function replay(symbol, ticker, overrides) {
  // MTF_EMIT_R on every run, including the baseline, so both sides of every
  // comparison are scored by the same measured field. Deriving one side from
  // `outcome` and measuring the other is how a trailing backtest flatters itself.
  const env = { ...process.env, MTF_CONF_FLOOR: String(CONF_FLOOR), MTF_EMIT_R: "1" };
  if (overrides.minRr !== undefined && overrides.minRr !== BASE_MIN_RR) {
    env.MTF_MIN_RR = String(overrides.minRr);
  }
  if (overrides.adx !== undefined && overrides.adx !== BASE_ADX) {
    env.MTF_ADX_TRENDING_MIN = String(overrides.adx);
  }
  if (overrides.trail !== undefined && overrides.trail !== BASE_TRAIL) {
    env.MTF_TRAIL_LADDER   = "1";
    env.MTF_TRAIL_GIVEBACK_R = String(overrides.trail);
  }
  const key = `${symbol}|${env.MTF_MIN_RR ?? "-"}|${env.MTF_ADX_TRENDING_MIN ?? "-"}` +
              `|${env.MTF_TRAIL_GIVEBACK_R ?? "-"}`;
  if (replayCache.has(key)) return replayCache.get(key);

  let trades = [];
  try {
    const stdout = execFileSync(
      process.execPath,
      [path.join(ROOT, "tasks", "_replay_mtf.cjs"), ROOT, symbol, ticker, String(CONF_FLOOR)],
      { env, maxBuffer: 64 * 1024 * 1024, encoding: "utf8", timeout: 900000 }
    );
    trades = JSON.parse(stdout);
  } catch (err) {
    // A non-zero exit means the replay itself reported DEGRADED — the engine threw
    // on some steps and they are missing. That is not a thin result, it is a result
    // with an unknown slice deleted, so it is recorded as an error and the affected
    // candidate is reported as such rather than quietly scored short.
    replayErrors[key] = String(err.message || err).slice(0, 300);
  }
  replayCache.set(key, trades);
  return trades;
}

function replayAll(overrides) {
  const trades = [];
  for (const [symbol, ticker] of ASSETS) {
    for (const t of replay(symbol, ticker, overrides)) trades.push({ ...t, sym: symbol });
  }
  trades.sort((a, b) => a.t - b.t);
  return trades;
}

// Scored off realisedR, which the replay emits for every trade under MTF_EMIT_R.
//
// This is arithmetically IDENTICAL to the old WIN/LOSS formula on a fixed-stop run —
// realisedR is exactly `rr` for a WIN and exactly -1 for a LOSS, so
// sum(realisedR - cost) equals sum(rr - cost) - sum(1 + cost). Nothing about the
// existing minRr/adx/minStrength tables moves.
//
// It exists because the trailing ladder produces a third outcome. A TRAILED exit
// lands anywhere between -1 and +rr, and the old formula counted it in `closed`
// while adding it to neither grossWin nor grossLoss — every trailed trade would have
// diluted the per-trade figure toward zero and the ladder would have looked
// worthless for a reason that was purely an accounting gap.
function stat(trades) {
  const closed = trades.filter(t => t.outcome !== "EXPIRED");
  if (!closed.length) return { closed: 0, wr: 0, pf: 0, R: 0, rpt: 0 };

  const realised = t => (typeof t.realisedR === "number"
    ? t.realisedR
    : (t.outcome === "WIN" ? t.rr : -1));          // fallback for a pre-MTF_EMIT_R run

  let grossWin = 0, grossLoss = 0, wins = 0;
  for (const t of closed) {
    const net = realised(t) - COST_R;
    if (net > 0) { grossWin += net; wins++; } else { grossLoss += -net; }
  }
  return {
    closed: closed.length,
    wr: (wins / closed.length) * 100,
    pf: grossLoss ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
    R: grossWin - grossLoss,
    rpt: (grossWin - grossLoss) / closed.length,
  };
}

function verdictFor(perFold) {
  const scored = perFold.filter(s => s.closed >= MIN_CLOSED_PER_FOLD);
  const positive = scored.filter(s => s.rpt > 0).length;
  const negative = scored.filter(s => s.rpt < 0).length;
  let label;
  if (scored.length < 3) label = "TOO FEW TRADES";
  else if (positive === scored.length) label = "ROBUST";
  // The court's own standard: positive in at least 4 of 5 AND never negative in one.
  else if (positive >= 4 && negative === 0) label = "ROBUST";
  else if (positive >= Math.ceil(scored.length * 0.6)) label = "MOSTLY POSITIVE";
  else if (positive === 0) label = "CONSISTENTLY NEGATIVE";
  else label = "UNSTABLE";
  return { scored: scored.length, positive, negative, label };
}

// ── baseline, and the fold boundaries every candidate is measured inside ──────
process.stderr.write(`  baseline replay (minRr ${BASE_MIN_RR}, adx ${BASE_ADX})…\n`);
const baseline = replayAll({ minRr: BASE_MIN_RR, adx: BASE_ADX });
const baseAtGate = baseline.filter(t => t.conf >= GATE);

if (baseAtGate.length < FOLDS * MIN_CLOSED_PER_FOLD) {
  console.error(`param_walkforward: only ${baseAtGate.length} baseline trades at gate ${GATE} — ` +
                `too few to split into ${FOLDS} folds worth trusting. That is a finding, not a ` +
                `crash: at this gate the system does not produce enough history to judge these ` +
                `parameters on. Lower PARAM_WF_GATE only to explore, never to decide.`);
  if (Object.keys(replayErrors).length) console.error(JSON.stringify(replayErrors, null, 2));
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

const baselineOverall = stat(baseAtGate);

const report = {
  generatedAt: new Date().toISOString(),
  basis: {
    path: "generateSignalMTF",
    settings: ["minRr", "adxTrendingMin", "minStrength", "trailGiveback"],
    costR: COST_R,
    confFloor: CONF_FLOOR,
    scoredAtGate: GATE,
    gateSource: process.env.PARAM_WF_GATE ? "PARAM_WF_GATE env" : "default 70 (5/5 folds)",
    folds: FOLDS,
    foldsFrom: "baseline (shipped engine) population at the live gate",
    baselineClosed: baselineOverall.closed,
    stubbed: ["priceCache.dxy", "priceCache.vix", "sentimentCache.fearGreed",
              "signalCache (cross-asset)", "getLearningBoost -> 0", "logRrRejection -> no-op"],
    caveat: "rr artifacts are NOT capped here; folds are equal-count on the baseline, not equal-time",
  },
  replayErrors,
  foldRanges: bounds.map(b => ({
    from: new Date(b.from * 1000).toISOString().slice(0, 10),
    to:   new Date(b.to * 1000).toISOString().slice(0, 10),
  })),
  params: {},
};

const lines = [];
lines.push("=".repeat(104));
lines.push(`  PARAMETER WALK-FORWARD — generateSignalMTF — ${report.generatedAt}`);
lines.push(`  scored at confidence gate ${GATE} (${report.basis.gateSource}), ${FOLDS} folds, cost ${COST_R}R/trade`);
lines.push(`  baseline: ${baselineOverall.closed} closed, ${baselineOverall.R >= 0 ? "+" : ""}${baselineOverall.R.toFixed(1)}R, ${baselineOverall.rpt.toFixed(3)}R/trade`);
lines.push("=".repeat(104));
lines.push("  fold ranges: " + report.foldRanges.map(f => `${f.from}..${f.to}`).join("  "));

function renderTable(title, label, rows, footer) {
  lines.push("");
  lines.push("  " + title);
  lines.push("  " + label.padEnd(8) + bounds.map((_, i) => `fold${i + 1}`.padStart(10)).join("") +
             "   closed      totalR     pos/scored   verdict");
  for (const row of rows) {
    lines.push(`  ${String(row.value).padEnd(7)} ` +
      row.perFold.map(s => (s.closed < MIN_CLOSED_PER_FOLD ? "  n<5"
        : (s.rpt >= 0 ? "+" : "") + s.rpt.toFixed(3)).padStart(10)).join("") +
      `   ${String(row.overall.closed).padStart(6)}  ${(row.overall.R >= 0 ? "+" : "") + row.overall.R.toFixed(1)}`.padStart(20) +
      `   ${row.verdict.positive}/${row.verdict.scored}`.padStart(13) +
      `   ${row.verdict.label}${row.isBaseline ? "  <- baseline" : ""}`);
  }
  for (const line of footer) lines.push("  " + line);
}

function sweep(name, candidates, baseValue, tradesFor) {
  const rows = [];
  for (const value of candidates) {
    const atGate = tradesFor(value).filter(t => t.conf >= GATE);
    const perFold = bounds.map(b => stat(atGate.filter(t => inFold(t, b))));
    const overall = stat(atGate);
    const verdict = verdictFor(perFold);
    rows.push({ value, perFold, overall, verdict, isBaseline: value === baseValue });
    report.params[name] = report.params[name] || {};
    report.params[name][value] = {
      perFold: perFold.map((s, i) => ({
        fold: i + 1, closed: s.closed, wr: +s.wr.toFixed(1),
        pf: s.pf === Infinity ? "inf" : +s.pf.toFixed(2),
        R: +s.R.toFixed(1), rpt: +s.rpt.toFixed(3),
      })),
      foldsScored: verdict.scored,
      foldsPositive: verdict.positive,
      foldsNegative: verdict.negative,
      overall: {
        closed: overall.closed, wr: +overall.wr.toFixed(1),
        pf: overall.pf === Infinity ? "inf" : +overall.pf.toFixed(2),
        R: +overall.R.toFixed(1), rpt: +overall.rpt.toFixed(3),
      },
      tradesVsBaseline: overall.closed - baselineOverall.closed,
      isBaseline: value === baseValue,
      verdict: verdict.label,
    };
  }
  return rows;
}

const runMinRr    = WHICH === "all" || WHICH === "minRr";
const runAdx      = WHICH === "all" || WHICH === "adx";
const runStrength = WHICH === "all" || WHICH === "minStrength";
const runTrail    = WHICH === "all" || WHICH === "trail";

if (runTrail) {
  process.stderr.write(`  sweeping trailing ladder across ${TRAIL_CANDIDATES.length} values…\n`);
  const rows = sweep("trailGiveback", TRAIL_CANDIDATES, BASE_TRAIL,
    value => replayAll({ minRr: BASE_MIN_RR, adx: BASE_ADX, trail: value }));
  renderTable("TRAILING LADDER (give-back R)", "trail", rows, [
    "'off' is the shipped fixed stop. Numbers are how far behind price the ratchet",
    "sits once it arms at 1R - smaller is tighter, banking sooner and capping runners.",
    "This is LIVE on both boxes already, promoted on one in-sample run. If 'off' beats",
    "every candidate here, the honest move is to turn it off, not to keep it because",
    "it is already deployed.",
    "Trade counts move: a trailed exit lands earlier, frees the occupancy window and",
    "lets through signals an open position used to block. Read closed, not only R.",
  ]);
}

if (runMinRr) {
  process.stderr.write(`  sweeping minRr across ${MIN_RR_CANDIDATES.length} values…\n`);
  const rows = sweep("minRr", MIN_RR_CANDIDATES, BASE_MIN_RR,
    value => replayAll({ minRr: value, adx: BASE_ADX }));
  renderTable("MINIMUM R:R", "minRr", rows, [
    "A lower bar admits setups that do not exist in the baseline at all, so the trade",
    "counts move in both directions - a lower bar can also LOSE a later trade by",
    "occupying the asset with an earlier one. Read the closed column, not only the R.",
    "server/index.js holds this number twice (generateSignal and the pivot refine in",
    "generateSignalMTF); sizing.js holds a third and the AI-filter prompt a fourth.",
    "Both engine copies are moved together here. Any promotion must move all four.",
  ]);
}

if (runAdx) {
  process.stderr.write(`  sweeping adxTrendingMin across ${ADX_CANDIDATES.length} values…\n`);
  const rows = sweep("adxTrendingMin", ADX_CANDIDATES, BASE_ADX,
    value => replayAll({ minRr: BASE_MIN_RR, adx: value }));
  renderTable("ADX TRENDING FLOOR", "adxMin", rows, [
    "This floor mostly decides STRONG vs MODERATE rather than fire vs no-fire, and",
    "strength feeds confidence, which feeds the gate - so its effect reaches the table",
    "through the confidence column, not as a row count. A flat table here means the",
    "floor is not doing work at this gate, which is itself the answer.",
  ]);
}

if (runStrength) {
  const rows = sweep("minStrength", STRENGTH_CANDIDATES, BASE_STRENGTH,
    value => baseline.filter(t => value === "STRONG" ? t.strength === "STRONG" : true));

  // Checked rather than asserted: generateSignalMTF derives strength from confidence
  // alone (>= 90 STRONG, else MODERATE, NONE when the signal does not fire). If that
  // holds in the data, minStrength is not an independent constraint - it is the
  // confidence gate wearing a different name, and sweeping it as though it were a
  // separate lever would double-count the same evidence.
  const strong = baseline.filter(t => t.strength === "STRONG");
  const strongBelow90 = strong.filter(t => t.conf < 90).length;
  const at90OrAbove = baseline.filter(t => t.conf >= 90).length;
  report.params.minStrength.equivalence = {
    strongTrades: strong.length,
    strongBelowConf90: strongBelow90,
    tradesAtConf90OrAbove: at90OrAbove,
    isPureConfidenceProxy: strongBelow90 === 0 && strong.length === at90OrAbove,
  };

  renderTable("MINIMUM STRENGTH", "minStr", rows, [
    `minStrength=STRONG selected ${strong.length} trades; conf >= 90 selected ${at90OrAbove};`,
    `${strongBelow90} STRONG trades sat below confidence 90.`,
    report.params.minStrength.equivalence.isPureConfidenceProxy
      ? "These match exactly, which confirms minStrength is NOT an independent lever -"
      : "These do NOT match, so strength is carrying information confidence does not -",
    report.params.minStrength.equivalence.isPureConfidenceProxy
      ? "it is the confidence gate at 90 under another name. Promoting it would be the"
      : "which contradicts the engine's own derivation and should be investigated before"
    ,
    report.params.minStrength.equivalence.isPureConfidenceProxy
      ? "same change as raising the gate to 90, and must not be counted as new evidence."
      : "either number is trusted.",
    "Filtered post-hoc, not re-replayed: minStrength is enforced by mt5_bridge.py on an",
    "already-emitted signal, so it only ever removes rows.",
  ]);
}

lines.push("");
if (Object.keys(replayErrors).length) {
  lines.push("  REPLAY ERRORS — the numbers above are INCOMPLETE for these runs:");
  for (const [key, err] of Object.entries(replayErrors)) lines.push(`    ${key}: ${err}`);
  lines.push("");
}
lines.push("  Burden of proof is on the challenger. A candidate beats the baseline only if it");
lines.push("  is positive in at least 4 of 5 scored folds AND negative in none, and improves on");
lines.push("  the baseline's R/trade. Ties go to the shipped value. A candidate that wins on");
lines.push("  expectancy while halving the sample buys a thinner, slower system - and sample");
lines.push("  size is already this project's binding constraint.");
lines.push("=".repeat(104));

const stamp = report.generatedAt.replace(/[-:]/g, "").slice(0, 15);
fs.writeFileSync(path.join(OUT_DIR, `param-walkforward-${stamp}.json`), JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(OUT_DIR, "param-walkforward-latest.json"), JSON.stringify(report, null, 2));
const text = lines.join("\n") + "\n";
fs.mkdirSync(path.join(ROOT, "tasks", "logs"), { recursive: true });
fs.appendFileSync(path.join(ROOT, "tasks", "logs", "param_walkforward.txt"), text + "\n");
console.log(text);

// A run with replay errors is not a measurement. Exit non-zero so an automated
// caller cannot file its table as evidence.
if (Object.keys(replayErrors).length) process.exitCode = 3;
