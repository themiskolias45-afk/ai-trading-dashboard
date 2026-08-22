// IS THE EDGE BROAD-BASED, OR CARRIED BY ONE INSTRUMENT?
//
// The pooled walk-forward says +0.119R/trade at gate 70, positive in 4 of 5 folds.
// But BTCUSD supplies 387 of the 769 replayed trades. If the edge is really BTC's and
// the other two are flat or negative, then "add more instruments" is a much weaker
// proposal than it looks — you would be multiplying a thing that only works in one
// place. This is the prerequisite question, and it is answerable from history already
// on disk with no MT5 connection and no risk to the live bridge.
//
// READ-ONLY. Shells out to tasks/_replay_mtf.cjs, which patches its own in-memory copy
// of the engine and never writes to server/index.js. Writes only into <outDir>.
// Nothing here touches a signal, a gate, a position or the learning file.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { cappedRr } = require("./_rr_cap.cjs");

const ROOT   = process.argv[2] || path.join(__dirname, "..");
const OUTDIR = process.argv[3] || __dirname;

const ASSETS = [["XAUUSD", "GC=F"], ["BTCUSD", "BTC-USD"], ["SP500", "^GSPC"]];
const GATE       = 70;     // the live gate; the only one with 5/5 folds behind it
const FOLDS      = 5;
const COST_R     = 0.05;   // same cost basis as every other harness here
const CONF_FLOOR = 40;     // expose sub-gate cohorts so the replay is comparable

function replay(symbol, ticker) {
  const env = { ...process.env, MTF_CONF_FLOOR: String(CONF_FLOOR), MTF_EMIT_R: "1" };
  delete env.MTF_PIVOT_MIN_ATR;   // baseline engine, no experimental knobs
  delete env.MTF_MIN_RR;
  delete env.MTF_TRAIL_LADDER;
  const res = spawnSync(process.execPath,
    [path.join(ROOT, "tasks", "_replay_mtf.cjs"), ROOT, symbol, ticker, String(CONF_FLOOR)],
    { env, maxBuffer: 128 * 1024 * 1024, encoding: "utf8", timeout: 900000 });
  // Exit 3 means the engine threw on some steps, so the result has an unknown slice
  // missing — which reads exactly like "this instrument does not trade".
  if (res.status !== 0) throw new Error(`exit ${res.status}: ${String(res.stderr || "").slice(-300)}`);
  return JSON.parse(res.stdout);
}

// Same scoring convention as tasks/session_walkforward.cjs so these numbers can be
// read against the existing tables: EXPIRED excluded, wins pay rr-cost, losses 1+cost.
function stat(trades) {
  const closed = trades.filter(t => t.outcome !== "EXPIRED");
  const wins   = closed.filter(t => t.outcome === "WIN");
  const losses = closed.filter(t => t.outcome === "LOSS");
  const grossWin  = wins.reduce((a, t) => a + cappedRr(t.rr) - COST_R, 0);
  const grossLoss = losses.reduce(a => a + 1 + COST_R, 0);
  return {
    closed: closed.length,
    wr: closed.length ? (wins.length / closed.length) * 100 : 0,
    R: grossWin - grossLoss,
    rpt: closed.length ? (grossWin - grossLoss) / closed.length : 0,
  };
}

function foldsOf(trades, n) {
  const sorted = [...trades].sort((a, b) => a.t - b.t);
  const size = Math.floor(sorted.length / n);
  if (size < 1) return null;
  const out = [];
  for (let k = 0; k < n; k++) {
    out.push(sorted.slice(k * size, k === n - 1 ? sorted.length : (k + 1) * size));
  }
  return out;
}

const perAsset = {};
const pooled = [];
for (const [symbol, ticker] of ASSETS) {
  try {
    const trades = replay(symbol, ticker);
    const gated = trades.filter(t => (t.conf ?? 0) >= GATE);
    perAsset[symbol] = { all: trades.length, atGate: gated.length, trades: gated };
    for (const t of gated) pooled.push({ ...t, sym: symbol });
    process.stderr.write(`${symbol}: ${trades.length} replayed, ${gated.length} at gate ${GATE}\n`);
  } catch (e) {
    perAsset[symbol] = { error: String(e.message || e).slice(0, 300) };
    process.stderr.write(`${symbol}: ERROR ${perAsset[symbol].error}\n`);
  }
}

const lines = [];
lines.push("=".repeat(94));
lines.push(`  PER-INSTRUMENT EDGE AT THE LIVE GATE — ${new Date().toISOString()}`);
lines.push(`  gate ${GATE}, ${FOLDS} equal-count folds per instrument, cost ${COST_R}R/trade`);
lines.push("=".repeat(94));
lines.push("");
lines.push("  instrument   " + Array.from({length: FOLDS}, (_, i) => `fold${i+1}`.padStart(9)).join("") +
           "    closed      WR      netR    R/trade   pos/scored   verdict");

const report = { generatedAt: new Date().toISOString(), gate: GATE, costR: COST_R, folds: FOLDS, instruments: {} };

for (const [symbol] of ASSETS) {
  const a = perAsset[symbol];
  if (!a || a.error) { lines.push(`  ${symbol.padEnd(12)} ERROR: ${a ? a.error : "no data"}`); continue; }
  const f = foldsOf(a.trades, FOLDS);
  const overall = stat(a.trades);
  if (!f) { lines.push(`  ${symbol.padEnd(12)} too few trades to fold (${a.atGate})`); continue; }
  const perFold = f.map(stat);
  const scored  = perFold.filter(s => s.closed >= 5);
  const positive = scored.filter(s => s.rpt > 0).length;
  const verdict = scored.length < 3 ? "TOO FEW TO JUDGE"
    : positive === scored.length ? "ROBUST"
    : positive >= Math.ceil(scored.length * 0.6) ? "MOSTLY POSITIVE"
    : positive === 0 ? "CONSISTENTLY NEGATIVE" : "UNSTABLE";
  report.instruments[symbol] = {
    replayed: a.all, atGate: a.atGate,
    overall: { closed: overall.closed, wr: +overall.wr.toFixed(1), R: +overall.R.toFixed(2), rpt: +overall.rpt.toFixed(3) },
    perFold: perFold.map((s, i) => ({ fold: i+1, closed: s.closed, wr: +s.wr.toFixed(1), rpt: +s.rpt.toFixed(3) })),
    foldsScored: scored.length, foldsPositive: positive, verdict,
  };
  lines.push("  " + symbol.padEnd(12) +
    perFold.map(s => (s.closed < 5 ? "n<5" : (s.rpt >= 0 ? "+" : "") + s.rpt.toFixed(3)).padStart(9)).join("") +
    String(overall.closed).padStart(10) +
    (overall.wr.toFixed(1) + "%").padStart(8) +
    ((overall.R >= 0 ? "+" : "") + overall.R.toFixed(2)).padStart(10) +
    ((overall.rpt >= 0 ? "+" : "") + overall.rpt.toFixed(3)).padStart(11) +
    `${positive}/${scored.length}`.padStart(13) + "   " + verdict);
}

// Pooled, for reference against the existing setup-walkforward baseline.
const pf = foldsOf(pooled, FOLDS);
const po = stat(pooled);
if (pf) {
  const perFold = pf.map(stat);
  const scored = perFold.filter(s => s.closed >= 5);
  const positive = scored.filter(s => s.rpt > 0).length;
  lines.push("  " + "-".repeat(90));
  lines.push("  " + "POOLED".padEnd(12) +
    perFold.map(s => (s.closed < 5 ? "n<5" : (s.rpt >= 0 ? "+" : "") + s.rpt.toFixed(3)).padStart(9)).join("") +
    String(po.closed).padStart(10) +
    (po.wr.toFixed(1) + "%").padStart(8) +
    ((po.R >= 0 ? "+" : "") + po.R.toFixed(2)).padStart(10) +
    ((po.rpt >= 0 ? "+" : "") + po.rpt.toFixed(3)).padStart(11) +
    `${positive}/${scored.length}`.padStart(13));
  report.pooled = { closed: po.closed, wr: +po.wr.toFixed(1), R: +po.R.toFixed(2), rpt: +po.rpt.toFixed(3), foldsPositive: positive, foldsScored: scored.length };
}

// Contribution: how much of the pooled R does each instrument supply? An edge that is
// one instrument wearing a portfolio's clothes is the thing this exists to catch.
lines.push("");
lines.push("  CONTRIBUTION TO POOLED R");
for (const [symbol] of ASSETS) {
  const r = report.instruments[symbol];
  if (!r) continue;
  const share = po.R !== 0 ? (r.overall.R / po.R) * 100 : 0;
  lines.push(`    ${symbol.padEnd(10)} ${(r.overall.R >= 0 ? "+" : "") + r.overall.R.toFixed(2)}R of ${po.R.toFixed(2)}R pooled` +
             `   = ${share.toFixed(0)}%   (${r.overall.closed} of ${po.closed} trades)`);
}
lines.push("");
lines.push("  If one instrument supplies most of the R AND the others are flat or negative,");
lines.push("  adding instruments multiplies something that works in one place. If all three");
lines.push("  are independently positive, the edge is a property of the ENGINE and more");
lines.push("  instruments should carry it.");
lines.push("=".repeat(94));

fs.mkdirSync(OUTDIR, { recursive: true });
fs.writeFileSync(path.join(OUTDIR, "per_instrument_edge.json"), JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(OUTDIR, "per_instrument_edge.txt"), lines.join("\n") + "\n");
process.stdout.write(lines.join("\n") + "\n");
