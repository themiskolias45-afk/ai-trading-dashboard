// Walk-forward validation of ONE COHORT at a time, out of sample.
//
//   node tasks/cohort_walkforward.cjs [projRoot]
//
// WHY THIS EXISTS
// tasks/cohort_reachability.cjs answers "can this cohort reach the gate", which is
// arithmetic. It cannot answer "should it". Those are different questions and only
// the second one justifies moving a base confidence, because a base is the number
// that decides whether a population of trades is admitted at all.
//
// tasks/mtf_walkforward.cjs folds by GATE across every cohort pooled together. A
// cohort worth 5% of the trades is invisible in that number no matter how good or
// bad it is. This folds each cohort SEPARATELY so a dead slice can be judged on its
// own record rather than on the average of the slices around it.
//
// WHAT A RESULT HERE DOES AND DOES NOT LICENCE
// A positive verdict is evidence that a cohort's population made money in the
// replay. It is NOT permission to raise a base by itself: bases are also coupled
// (Gold's squeeze cohort is pinned to exactly the live gate) and macro penalties of
// up to -30 apply after the base, which this harness inherits from the engine but a
// reader should not forget. Treat this as the measurement that must PRECEDE a
// proposal, never as the proposal.
//
// Deterministic - no AI, no network, no live-server reads, no config changes.
// Writes only tasks/analysis/ and appends tasks/logs/cohort_walkforward.txt.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = process.argv[2] || path.join(__dirname, "..");

const ASSETS = [
  ["XAUUSD", "GC=F"],
  ["BTCUSD", "BTC-USD"],
  ["SP500",  "^GSPC"],
];

// Same basis as tasks/mtf_walkforward.cjs so numbers from the two are comparable.
// Changing either without the other silently makes them incomparable while both
// keep printing R/trade as if they meant the same thing.
const FOLDS      = 5;
const COST_R     = 0.05;
const CONF_FLOOR = 40;   // expose sub-gate cohorts; without it they replay as WAIT

// A fold with fewer closed trades than this says nothing, and averaging it in is
// how one thin stretch swings a verdict. Same floor the gate harness uses.
const MIN_CLOSED_PER_FOLD = 5;
// Below this a slice is not foldable at all and is reported as a single pooled
// number, clearly labelled, rather than being silently dropped.
const MIN_CLOSED_TO_FOLD = FOLDS * MIN_CLOSED_PER_FOLD;

// The live base confidence per slice, mirrored from server/index.js so the report
// can say how far a slice is from the gate. Kept beside the numbers deliberately:
// a measurement that does not name the base it is arguing about is unactionable.
const LIVE_BASE = {
  "BTCUSD/H4_ONLY/STRONG":   63,
  "BTCUSD/H4_ONLY/MODERATE": 50,
  "BTCUSD/H4_ONLY/NONE":     40,
  "XAUUSD/H4_ONLY/STRONG":   68,
  "XAUUSD/H4_ONLY/MODERATE": 55,   // 70 when the daily setup is BB_SQUEEZE_WATCH
  "XAUUSD/H4_ONLY/NONE":     40,
  "SP500/H4_ONLY/STRONG":    45,   // SPX is one flat 45 regardless of H4 strength
  "SP500/H4_ONLY/MODERATE":  45,
  "SP500/H4_ONLY/NONE":      45,
};

const MAX_BOOST = 15;    // volume +5, best setup +10, learning 0 while cold

const OUT_DIR = path.join(ROOT, "tasks", "analysis");
fs.mkdirSync(OUT_DIR, { recursive: true });

function readGate() {
  // The gate a proposal would have to clear. Read from the saved config rather than
  // hardcoded: this file existing to argue about thresholds is exactly the wrong
  // place to bake one in. Falls back to the documented live value, and says so.
  // It lives in server/, NOT the project root. The first version of this function
  // looked in the root, silently fell back, and printed "gate 70 (fallback)" — which
  // happened to be right and would have been wrong the moment the gate moved. A
  // reachability verdict computed against a guessed gate is worse than none.
  const file = path.join(ROOT, "server", "strategy_settings.json");
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")).confidenceThreshold;
    if (Number.isFinite(value)) return { gate: value, source: "server/strategy_settings.json" };
    return { gate: null, source: `confidenceThreshold missing or not a number in ${file}` };
  } catch (err) {
    return { gate: null, source: `unreadable: ${file} (${err.message})` };
  }
}

function replay(symbol, ticker) {
  const stdout = execFileSync(
    process.execPath,
    [path.join(ROOT, "tasks", "_replay_mtf.cjs"), ROOT, symbol, ticker, String(CONF_FLOOR)],
    { env: { ...process.env, MTF_CONF_FLOOR: String(CONF_FLOOR) },
      maxBuffer: 64 * 1024 * 1024, encoding: "utf8", timeout: 900000 }
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
    R: grossWin - grossLoss,
    rpt: closed.length ? (grossWin - grossLoss) / closed.length : 0,
  };
}

// Equal-COUNT sequential folds, matching the gate harness. Equal time would hand a
// quiet year a fold of almost nothing and let it swing the verdict.
function foldsOf(trades) {
  const size = Math.floor(trades.length / FOLDS);
  const out = [];
  for (let k = 0; k < FOLDS; k++) {
    out.push(trades.slice(k * size, k === FOLDS - 1 ? trades.length : (k + 1) * size));
  }
  return out;
}

function verdictOf(scored, positive) {
  if (scored < 3) return "TOO FEW FOLDS";
  if (positive === scored) return "ROBUST";
  if (positive === 0) return "CONSISTENTLY NEGATIVE";
  if (positive >= Math.ceil(scored * 0.6)) return "MOSTLY POSITIVE";
  return "UNSTABLE";
}

const { gate, source: gateSource } = readGate();
if (gate === null) {
  // Refuse rather than assume. Every "reach?" verdict below is a comparison against
  // this number; guessing it would let the report state a confident falsehood.
  console.error(`cohort-walkforward: cannot read the live gate — ${gateSource}`);
  process.exit(2);
}

const all = [];
const perAsset = {};
for (const [symbol, ticker] of ASSETS) {
  try {
    const trades = replay(symbol, ticker);
    perAsset[symbol] = { trades: trades.length };
    for (const t of trades) all.push({ ...t, sym: symbol });
  } catch (err) {
    // A replay that throws must be loud. A silently missing asset reads exactly
    // like "that asset has no tradeable cohorts", which is the failure this whole
    // family of tools exists to stop.
    perAsset[symbol] = { error: String(err.message || err).slice(0, 300) };
    console.error(`cohort-walkforward: ${symbol} replay FAILED — ${perAsset[symbol].error}`);
  }
}

if (all.length === 0) {
  console.error("cohort-walkforward: no trades from any asset — nothing to measure");
  process.exit(1);
}

all.sort((a, b) => a.t - b.t);

// Slice key: symbol / cohort / H4 strength. H4 strength only distinguishes anything
// inside H4_ONLY — it is the dimension the engine branches on there — so every other
// cohort collapses to one slice per symbol rather than being shattered into three.
function sliceKey(t) {
  return t.cohort === "H4_ONLY"
    ? `${t.sym}/H4_ONLY/${t.h4Strength ?? "NONE"}`
    : `${t.sym}/${t.cohort}`;
}

const slices = new Map();
for (const t of all) {
  const key = sliceKey(t);
  if (!slices.has(key)) slices.set(key, []);
  slices.get(key).push(t);
}

const results = [];
for (const [key, trades] of slices) {
  const pooled = stat(trades);
  const base = LIVE_BASE[key] ?? null;
  const row = {
    slice: key,
    trades: trades.length,
    pooled: { closed: pooled.closed, wr: +pooled.wr.toFixed(1), R: +pooled.R.toFixed(1), rpt: +pooled.rpt.toFixed(3) },
    base,
    // What the base would have to become for this slice to be reachable at all.
    // Null where the slice is not one of the branch points listed in LIVE_BASE.
    baseNeededForReach: base === null ? null : Math.max(base, gate - MAX_BOOST),
    reachableToday: base === null ? null : base + MAX_BOOST >= gate,
    foldable: pooled.closed >= MIN_CLOSED_TO_FOLD,
    perFold: null, foldsScored: 0, foldsPositive: 0,
    verdict: "NOT FOLDABLE",
  };

  if (row.foldable) {
    const perFold = foldsOf(trades).map(stat);
    const scored = perFold.filter(s => s.closed >= MIN_CLOSED_PER_FOLD);
    const positive = scored.filter(s => s.rpt > 0).length;
    row.perFold = perFold.map((s, i) => ({
      fold: i + 1, closed: s.closed, wr: +s.wr.toFixed(1),
      R: +s.R.toFixed(1), rpt: +s.rpt.toFixed(3),
    }));
    row.foldsScored = scored.length;
    row.foldsPositive = positive;
    row.verdict = verdictOf(scored.length, positive);
  }
  results.push(row);
}

// Worst first: the point of the report is to find slices being carried, and a list
// sorted best-first buries them.
results.sort((a, b) => a.pooled.rpt - b.pooled.rpt);

const generatedAt = new Date().toISOString();
const report = {
  generatedAt,
  basis: {
    path: "generateSignalMTF via tasks/_replay_mtf.cjs",
    gate, gateSource, costR: COST_R, confFloor: CONF_FLOOR, folds: FOLDS,
    minClosedPerFold: MIN_CLOSED_PER_FOLD, maxBoost: MAX_BOOST,
    totalTrades: all.length,
    caveat: "rr artifacts are NOT capped; folds are equal-count, not equal-time; "
          + "macro penalties of up to -30 apply after the base and are inherited from the engine",
  },
  perAsset,
  slices: results,
};

const lines = [];
lines.push("=".repeat(104));
lines.push(`  COHORT WALK-FORWARD — each cohort folded on its OWN record — ${generatedAt}`);
lines.push(`  ${all.length} trades, ${FOLDS} equal-count folds, cost ${COST_R}R, conf floor ${CONF_FLOOR}, gate ${gate} (${gateSource})`);
lines.push("=".repeat(104));
lines.push("");
lines.push("  slice                              closed    R/trade    folds+   verdict                 base  reach?");
lines.push("  " + "-".repeat(100));
for (const r of results) {
  const reach = r.reachableToday === null ? "  -"
              : r.reachableToday ? " yes" : "  NO";
  const baseTxt = r.base === null ? "   -" : String(r.base).padStart(4);
  const folds = r.foldable ? `${r.foldsPositive}/${r.foldsScored}` : " - ";
  lines.push(
    "  " + r.slice.padEnd(34) +
    String(r.pooled.closed).padStart(6) +
    ((r.pooled.rpt >= 0 ? "+" : "") + r.pooled.rpt.toFixed(3)).padStart(11) +
    folds.padStart(9) + "   " + r.verdict.padEnd(22) + baseTxt + reach
  );
}
lines.push("");
lines.push("  base   = live base confidence for that branch in server/index.js");
lines.push("  reach? = whether base + max boost (+15) can clear the gate at all today");
lines.push("");
lines.push("  A slice that is NOT reachable and CONSISTENTLY NEGATIVE is correctly blocked —");
lines.push("  raising its base would buy losing trades. A slice that is not reachable and");
lines.push("  ROBUST is the only kind worth a base proposal, and even then the base is coupled");
lines.push("  to other cohorts and macro penalties still apply after it.");
lines.push("=".repeat(104));

const stamp = generatedAt.replace(/[-:]/g, "").slice(0, 15);
fs.writeFileSync(path.join(OUT_DIR, `cohort-walkforward-${stamp}.json`), JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(OUT_DIR, "cohort-walkforward-latest.json"), JSON.stringify(report, null, 2));
const text = lines.join("\n") + "\n";
fs.appendFileSync(path.join(ROOT, "tasks", "logs", "cohort_walkforward.txt"), text + "\n");
process.stdout.write(text);
