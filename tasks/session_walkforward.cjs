// Would EXCLUDING a slice have improved the book, out of sample?
//
//   node tasks/session_walkforward.cjs [projRoot]                 fold by SESSION
//   node tasks/session_walkforward.cjs [projRoot] --by setup      fold by SETUP
//
// The slice differs; the question does not, which is why this is one tool and not two.
// "Is BUY_OVERSOLD worth keeping" and "is OVERLAP worth excluding" are the same
// arithmetic over a different grouping, and duplicating the harness would let the two
// answers drift apart while both kept printing R/trade as if they meant the same thing.
//
// WHY THIS AND NOT THE HEAT MAP
// tasks/time_heatmap.cjs says OVERLAP is -0.641R/trade and PRE-LONDON +1.399 at the
// live gate. Those are POOLED numbers over 22 and 15 trades, and a pooled number is
// how a single good fold gets mistaken for an edge — the per-direction MIN_RR
// candidate looked like +0.158R/trade until the folds showed 109% of the gain sat in
// one of them. So this asks the decision-relevant question instead: for each session,
// does REMOVING it improve R/trade, and does it do so in most folds rather than one.
//
// Read the DELTA column, never the session's own sign. A session can be negative and
// still not be worth excluding — if its trades are few, removing them barely moves the
// book, and "barely moves the book" is not an edge, it is a rounding difference with a
// story attached.
//
// WHAT A RESULT HERE DOES AND DOES NOT LICENCE
// Nothing here changes what trades. A session filter would be a new gate, and this
// system's bar for that is 5 of 5 folds — the same bar gate 70 cleared and the MIN_RR
// candidate did not. Anything short of that is a reason to keep measuring, not to ship.
// Sessions at the live gate are thin: with 5 folds needing 5 closed trades each, only
// the largest survive folding at all, and the report says which are unfoldable rather
// than quietly folding them anyway.
//
// Deterministic — no AI, no network, no live-server reads, no config changes.
// Writes only tasks/analysis/ and appends tasks/logs/session_walkforward.txt.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { writeArtifactSync } = require("./write_artifact.cjs");

const ROOT = process.argv[2] && !process.argv[2].startsWith("--")
  ? process.argv[2] : path.join(__dirname, "..");

// What to slice by. Anything other than "setup" folds by session, so a typo degrades
// to the default rather than silently measuring nothing.
const BY_INDEX = process.argv.indexOf("--by");
const SLICE_BY = BY_INDEX !== -1 && process.argv[BY_INDEX + 1] === "setup" ? "setup" : "session";

const ASSETS = [
  ["XAUUSD", "GC=F"],
  ["BTCUSD", "BTC-USD"],
  ["SP500",  "^GSPC"],
];

// Same basis as every other harness here, so R/trade means one thing project-wide.
const COST_R     = 0.05;
const CONF_FLOOR = 40;

const FOLDS_FULL = 5;
const FOLDS_THIN = 3;   // used only when a slice cannot support 5, and always labelled
const MIN_CLOSED_PER_FOLD = 5;

const MS_EPOCH_FLOOR = 1e11;

const SESSIONS = [
  ["ASIAN",       22, 7],
  ["PRE-LONDON",   7, 9],
  ["LONDON",       9, 12],
  ["OVERLAP",     12, 13],
  ["NEW YORK",    13, 17],
  ["AFTER HOURS", 17, 22],
];

const OUT_DIR = path.join(ROOT, "tasks", "analysis");
fs.mkdirSync(OUT_DIR, { recursive: true });

function readGate() {
  const file = path.join(ROOT, "server", "strategy_settings.json");
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")).confidenceThreshold;
    if (Number.isFinite(value)) return { gate: value, source: "server/strategy_settings.json" };
    return { gate: null, source: `confidenceThreshold missing or not a number in ${file}` };
  } catch (err) { return { gate: null, source: `unreadable: ${file} (${err.message})` }; }
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

function sessionOf(t) {
  if (!Number.isFinite(t)) return null;
  const date = new Date(t < MS_EPOCH_FLOOR ? t * 1000 : t);
  const year = date.getUTCFullYear();
  if (year < 2000 || year > 2100) return null;
  const hour = date.getUTCHours();
  const found = SESSIONS.find(([, from, to]) =>
    from < to ? hour >= from && hour < to : hour >= from || hour < to);
  return found ? found[0] : null;
}

// Equal-COUNT sequential folds, matching every other harness here. Equal time would
// hand a quiet stretch a fold of almost nothing and let it swing the verdict.
function foldsOf(trades, count) {
  const size = Math.floor(trades.length / count);
  const out = [];
  for (let k = 0; k < count; k++) {
    out.push(trades.slice(k * size, k === count - 1 ? trades.length : (k + 1) * size));
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
  console.error(`session-walkforward: cannot read the live gate — ${gateSource}`);
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
    perAsset[symbol] = { error: String(err.message || err).slice(0, 300) };
    console.error(`session-walkforward: ${symbol} replay FAILED — ${perAsset[symbol].error}`);
  }
}
if (!all.length) {
  console.error("session-walkforward: no trades from any asset — nothing to measure");
  process.exit(1);
}

const failedAssets = Object.entries(perAsset).filter(([, v]) => v && v.error).map(([k]) => k);
const incompleteBanner = failedAssets.length ? [
  "!".repeat(104),
  `  INCOMPLETE: ${failedAssets.join(", ")} produced NO trades — ${failedAssets.length} of ${ASSETS.length} assets missing.`,
  "  Every number below describes the remaining assets only. Fix the replay first.",
  "!".repeat(104),
].join("\n") : null;
if (incompleteBanner) console.error(incompleteBanner);

all.sort((a, b) => a.t - b.t);
// `slice` is whichever dimension is being folded. Folding by session still requires a
// readable timestamp; folding by setup does not, so a trade with no setup name is
// dropped instead of being pooled into a phantom bucket.
const dated = SLICE_BY === "setup"
  ? all.filter(t => t.setup).map(t => ({ ...t, slice: t.setup }))
  : all.map(t => ({ ...t, slice: sessionOf(t.t) })).filter(t => t.slice);
if (!dated.length) {
  console.error(`session-walkforward: no trade carried a readable ${SLICE_BY} — refusing to report`);
  process.exit(3);
}
// Fold by every slice actually present, in a stable order. For sessions that is the
// declared list; for setups it is whatever the engine produced.
const SLICE_NAMES = SLICE_BY === "setup"
  ? [...new Set(dated.map(t => t.slice))].sort()
  : SESSIONS.map(([name]) => name);

/**
 * For one population, fold it and ask of each session: what happens to R/trade if
 * these trades are removed? Reported as a DELTA per fold, because the sign of the
 * excluded session on its own says nothing about whether excluding it helps.
 */
function analyse(rows, label) {
  const foldCount = rows.length >= FOLDS_FULL * MIN_CLOSED_PER_FOLD ? FOLDS_FULL
                  : rows.length >= FOLDS_THIN * MIN_CLOSED_PER_FOLD ? FOLDS_THIN : 0;
  const baseline = stat(rows);
  const out = { label, trades: rows.length, foldCount, baseline, slices: [] };
  if (!foldCount) return out;

  const folds = foldsOf(rows, foldCount);
  for (const name of SLICE_NAMES) {
    const own = rows.filter(t => t.slice === name);
    if (!own.length) continue;

    const perFold = folds.map(fold => {
      const withAll = stat(fold);
      const without = stat(fold.filter(t => t.slice !== name));
      return {
        closed: withAll.closed,
        removed: withAll.closed - without.closed,
        rptAll: withAll.rpt,
        rptWithout: without.rpt,
        // Positive delta = removing this session IMPROVED that fold.
        delta: without.closed ? without.rpt - withAll.rpt : null,
      };
    });
    const scored = perFold.filter(f => f.delta !== null && f.closed >= MIN_CLOSED_PER_FOLD && f.removed > 0);
    const improved = scored.filter(f => f.delta > 0).length;
    const withoutAll = stat(rows.filter(t => t.slice !== name));

    out.slices.push({
      slice: name,
      own: { closed: own.length, wr: +stat(own).wr.toFixed(1), rpt: +stat(own).rpt.toFixed(3) },
      pooledDelta: +(withoutAll.rpt - baseline.rpt).toFixed(4),
      perFold: perFold.map((f, i) => ({
        fold: i + 1, closed: f.closed, removed: f.removed,
        delta: f.delta === null ? null : +f.delta.toFixed(4),
      })),
      foldsScored: scored.length,
      foldsImproved: improved,
      verdict: verdictOf(scored.length, improved),
    });
  }
  out.slices.sort((a, b) => b.pooledDelta - a.pooledDelta);
  return out;
}

const atFloor = analyse(dated, `conf >= ${CONF_FLOOR}`);
const atGate  = analyse(dated.filter(t => Number.isFinite(t.conf) && t.conf >= gate), `conf >= ${gate}`);

const lines = [];
const W = 104;
const generatedAt = new Date().toISOString();
if (incompleteBanner) lines.push(incompleteBanner);
lines.push("=".repeat(W));
lines.push(`  ${SLICE_BY.toUpperCase()} WALK-FORWARD — would excluding a ${SLICE_BY} have helped? — ${generatedAt}`);
lines.push(`  ${dated.length} trades, cost ${COST_R}R, conf floor ${CONF_FLOOR}, gate ${gate} (${gateSource})`);
lines.push("=".repeat(W));

for (const view of [atFloor, atGate]) {
  lines.push("");
  lines.push("-".repeat(W));
  lines.push(`  POPULATION: ${view.label} — ${view.trades} trades, baseline ` +
             `${(view.baseline.rpt >= 0 ? "+" : "") + view.baseline.rpt.toFixed(3)}R/trade`);
  lines.push("-".repeat(W));
  if (!view.foldCount) {
    lines.push("");
    lines.push(`  NOT FOLDABLE: ${view.trades} trades cannot support ${FOLDS_THIN} folds of ` +
               `${MIN_CLOSED_PER_FOLD}. No verdict is possible on this population.`);
    continue;
  }
  if (view.foldCount === FOLDS_THIN) {
    lines.push("");
    lines.push(`  NOTE: only ${FOLDS_THIN} folds — this population is too thin for ${FOLDS_FULL}.`);
    lines.push("  Three folds is weak evidence and cannot clear this project's 5-of-5 bar.");
  }
  lines.push("");
  lines.push("  " + SLICE_BY.toUpperCase().padEnd(20) + "own n   own R/t   pooled delta   folds improved   verdict");
  lines.push("  " + "-".repeat(W - 4));
  for (const s of view.slices) {
    lines.push(
      "  " + String(s.slice).padEnd(20) +
      String(s.own.closed).padStart(6) +
      ((s.own.rpt >= 0 ? "+" : "") + s.own.rpt.toFixed(3)).padStart(10) +
      ((s.pooledDelta >= 0 ? "+" : "") + s.pooledDelta.toFixed(4)).padStart(15) +
      `${s.foldsImproved}/${s.foldsScored}`.padStart(17) + "   " + s.verdict);
  }
}

lines.push("");
lines.push("  HOW TO READ THIS");
lines.push("  'pooled delta' is what R/trade does when that session is REMOVED: positive means");
lines.push("  removing it helped. Read the folds column, not the delta: a big pooled delta with");
lines.push("  1/5 folds improving is one good fold wearing a costume, which is exactly how the");
lines.push("  per-direction MIN_RR candidate looked before its folds were examined.");
lines.push("  A session filter is a NEW GATE. This project's bar is 5 of 5 folds. Nothing here");
lines.push("  changes what trades, and nothing short of that bar should.");
lines.push("=".repeat(W));

const report = {
  generatedAt,
  basis: {
    path: "generateSignalMTF via tasks/_replay_mtf.cjs",
    gate, gateSource, costR: COST_R, confFloor: CONF_FLOOR,
    foldsFull: FOLDS_FULL, foldsThin: FOLDS_THIN, minClosedPerFold: MIN_CLOSED_PER_FOLD,
    totalTrades: dated.length,
    caveat: "Sessions at the live gate are thin. A 3-fold result is reported when 5 is "
          + "impossible and is explicitly weak evidence. Delta is the effect of REMOVING "
          + "the session, not the session's own performance.",
  },
  perAsset,
  atConfFloor: atFloor,
  atLiveGate: atGate,
  feedsTheGate: false,
};

const stamp = generatedAt.replace(/[-:]/g, "").slice(0, 15);
// The slice dimension is IN the filename. Both modes used to write
// session-walkforward-latest.json, so running --by setup silently destroyed the
// session run's latest and anything reading that file got setup rows under a session
// name. One tool with two outputs must name them separately or it is two tools sharing
// a bug.
// Retried on a transient Windows lock — see tasks/write_artifact.cjs.
writeArtifactSync(path.join(OUT_DIR, `${SLICE_BY}-walkforward-${stamp}.json`), JSON.stringify(report, null, 2));
writeArtifactSync(path.join(OUT_DIR, `${SLICE_BY}-walkforward-latest.json`), JSON.stringify(report, null, 2));
const text = lines.join("\n") + "\n";
fs.appendFileSync(path.join(ROOT, "tasks", "logs", SLICE_BY + "_walkforward.txt"), text + "\n");
process.stdout.write(text);
