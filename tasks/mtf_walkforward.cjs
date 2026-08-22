// Walk-forward validation of the confidence gate on the LIVE path.
//
//   node tasks/mtf_walkforward.cjs [projRoot]
//
// WHY
// The 2026-08-01 measurement that put the edge above conf 75 rested on ONE
// 60/40 chronological split. A single split is weak evidence: pick a different
// cut date and the verdict can move. This re-runs the same measurement across
// several sequential out-of-sample periods and asks a harder question - is a
// given gate positive in MOST periods, or did one lucky stretch carry it?
//
// It shells out to tasks/_replay_mtf.cjs rather than reimplementing the replay,
// so both stay on the same engine. MTF_CONF_FLOOR is lowered so the sub-65
// cohorts are visible; without it generateSignalMTF returns WAIT below the live
// gate and every lower threshold yields an identical list.
//
// Deterministic - no AI, no network, no writes outside tasks/analysis/. Safe to
// run unattended. Reads nothing from the live server and changes no config.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { cappedRr } = require("./_rr_cap.cjs");

const ROOT = process.argv[2] || path.join(__dirname, "..");
const ASSETS = [
  ["XAUUSD", "GC=F"],
  ["BTCUSD", "BTC-USD"],
  ["SP500",  "^GSPC"],
];
// Extended below 65 on 2026-08-03. The question changed: with one closed trade
// in the journal and the learning engine needing five per setup, trade FLOW is
// the binding constraint, not per-trade edge. The MTF fact pack showed conf50-64
// is net positive (195 closed, PF 1.06, +8.2R), so the sub-65 range had to be
// measured per-fold rather than assumed bad.
const GATES = [45, 50, 55, 60, 65, 70, 75, 80, 85];
const FOLDS = 5;         // sequential out-of-sample periods
const COST_R = 0.05;     // same cost basis the rest of the project uses
const CONF_FLOOR = 40;   // expose sub-65 cohorts

const OUT_DIR = path.join(ROOT, "tasks", "analysis");
fs.mkdirSync(OUT_DIR, { recursive: true });

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
  const grossWin  = wins.reduce((a, t) => a + cappedRr(t.rr) - COST_R, 0);
  const grossLoss = losses.reduce(a => a + 1 + COST_R, 0);
  return {
    n: trades.length,
    closed: closed.length,
    wr: closed.length ? (wins.length / closed.length) * 100 : 0,
    pf: grossLoss ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
    R: grossWin - grossLoss,
    rpt: closed.length ? (grossWin - grossLoss) / closed.length : 0,
  };
}

const all = [];
const perAsset = {};
for (const [symbol, ticker] of ASSETS) {
  let trades;
  try {
    trades = replay(symbol, ticker);
  } catch (err) {
    perAsset[symbol] = { error: String(err.message || err).slice(0, 300) };
    continue;
  }
  perAsset[symbol] = { trades: trades.length };
  for (const t of trades) all.push({ ...t, sym: symbol });
}

if (all.length === 0) {
  console.error("walkforward: no trades produced by any asset — nothing to validate");
  process.exit(1);
}

all.sort((a, b) => a.t - b.t);

// Equal-count sequential folds. Equal COUNT rather than equal TIME keeps every
// fold statistically comparable; equal time would hand quiet years a fold of
// almost nothing and let it swing the verdict.
const foldSize = Math.floor(all.length / FOLDS);
const folds = [];
for (let k = 0; k < FOLDS; k++) {
  const from = k * foldSize;
  const to = (k === FOLDS - 1) ? all.length : (k + 1) * foldSize;
  folds.push(all.slice(from, to));
}

const report = {
  generatedAt: new Date().toISOString(),
  basis: {
    path: "generateSignalMTF",
    costR: COST_R,
    confFloor: CONF_FLOOR,
    folds: FOLDS,
    totalTrades: all.length,
    stubbed: ["priceCache.dxy", "priceCache.vix", "sentimentCache.fearGreed",
              "signalCache (cross-asset)", "getLearningBoost -> 0"],
    caveat: "rr artifacts are NOT capped here; folds are equal-count, not equal-time",
  },
  perAsset,
  foldRanges: folds.map(f => ({
    from: new Date(f[0].t * 1000).toISOString().slice(0, 10),
    to:   new Date(f[f.length - 1].t * 1000).toISOString().slice(0, 10),
    trades: f.length,
  })),
  gates: {},
};

const lines = [];
lines.push("=".repeat(96));
lines.push(`  MTF WALK-FORWARD — generateSignalMTF — ${report.generatedAt}`);
lines.push(`  ${all.length} trades, ${FOLDS} sequential folds, cost ${COST_R}R/trade`);
lines.push("=".repeat(96));
lines.push("  fold ranges: " + report.foldRanges.map(f => `${f.from}..${f.to}(${f.trades})`).join("  "));
lines.push("");
lines.push("  gate   " + report.foldRanges.map((_, i) => `fold${i + 1}`.padStart(10)).join("")
  + "     worst   positive/total   verdict");

// The WORST SCORED fold, computed rather than read off the table by eye.
//
// CLAUDE.md's argument for gate 70 has always been a worst-fold argument — "its one
// negative is -0.016 against -0.165 at 55 and -0.204 at 75" — while this harness only
// ever printed a positive-fold COUNT, so those numbers were transcribed by hand from the
// grid below. A hand-transcribed number cannot be re-checked by anything, and the gate
// that decides what this system trades should not rest on one.
//
// A fold under the close floor is an ABSENCE, not a zero: it is excluded rather than
// counted as a bad fold, which is the same rule the ceiling harness uses. Returns null
// when nothing is scoreable, so an empty result reads as "no answer" instead of 0.
function worstScoredFold(perFold) {
  const scored = perFold.filter(s => s.closed >= 5);
  if (!scored.length) return null;
  return scored.reduce((worst, s) => (s.rpt < worst.rpt ? s : worst), scored[0]).rpt;
}

for (const gate of GATES) {
  const perFold = folds.map(f => stat(f.filter(t => t.conf >= gate)));
  const scored = perFold.filter(s => s.closed >= 5);   // ignore folds too thin to mean anything
  const worstFold = worstScoredFold(perFold);
  const positive = scored.filter(s => s.rpt > 0).length;
  const verdict = scored.length < 3 ? "TOO FEW TRADES"
                : positive === scored.length ? "ROBUST"
                : positive >= Math.ceil(scored.length * 0.6) ? "MOSTLY POSITIVE"
                : positive === 0 ? "CONSISTENTLY NEGATIVE"
                : "UNSTABLE";
  report.gates[gate] = {
    perFold: perFold.map((s, i) => ({
      fold: i + 1, closed: s.closed, wr: +s.wr.toFixed(1),
      pf: s.pf === Infinity ? "inf" : +s.pf.toFixed(2),
      R: +s.R.toFixed(1), rpt: +s.rpt.toFixed(3),
    })),
    foldsScored: scored.length,
    foldsPositive: positive,
    // Rounded to match the grid it comes FROM: worstFold is always one of the perFold
    // rpt values, and storing it at full precision beside those 3dp values reads as a
    // disagreement between two numbers that are the same number.
    worstFold: worstFold === null ? null : +worstFold.toFixed(3),
    overall: (() => { const s = stat(all.filter(t => t.conf >= gate));
      return { closed: s.closed, wr: +s.wr.toFixed(1),
               pf: s.pf === Infinity ? "inf" : +s.pf.toFixed(2),
               R: +s.R.toFixed(1), rpt: +s.rpt.toFixed(3) }; })(),
    verdict,
  };
  lines.push(`  ${String(gate).padEnd(6)} ` +
    perFold.map(s => (s.closed < 5 ? "  n<5" : (s.rpt >= 0 ? "+" : "") + s.rpt.toFixed(3)).padStart(10)).join("") +
    (worstFold === null ? "        —" : ((worstFold >= 0 ? "+" : "") + worstFold.toFixed(3)).padStart(10)) +
    `   ${positive}/${scored.length}`.padStart(17) + `   ${verdict}`);
}

lines.push("");
lines.push("  A gate is only worth acting on if it is positive in most folds. A strong");
lines.push("  overall number carried by one fold is the failure mode this exists to catch.");
lines.push("");
lines.push("  WORST is the worst SCORED fold, computed here rather than read off the grid by");
lines.push("  hand. It does not change the verdict column, which still ranks on the positive");
lines.push("  fold count — it makes the number CLAUDE.md's gate-70 argument rests on checkable.");
lines.push("=".repeat(96));

const stamp = report.generatedAt.replace(/[-:]/g, "").slice(0, 15);
fs.writeFileSync(path.join(OUT_DIR, `walkforward-${stamp}.json`), JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(OUT_DIR, "walkforward-latest.json"), JSON.stringify(report, null, 2));
const text = lines.join("\n") + "\n";
fs.appendFileSync(path.join(ROOT, "tasks", "logs", "mtf_walkforward.txt"), text + "\n");
process.stdout.write(text);
