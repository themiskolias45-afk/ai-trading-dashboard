'use strict';
/**
 * Is the R:R bar wrong in ONE DIRECTION only?
 *
 * A global MIN_RR move has already been measured and rejected: lowering it to
 * 1.35 buys 3 trades in 4 years and costs 6.6R. That looked like the end of the
 * question. Then the rejection ledger answered a different one — on the VPS's 86
 * resolved episodes, the setups MIN_RR threw away split hard by direction:
 *
 *     RANGE_TRADE_LONG   59W / 11L    rejecting these COST money
 *     BUY_OVERSOLD        8W /  0L    cost money
 *     RANGE_TRADE_SHORT   0W /  8L    rejecting these SAVED money
 *
 * If that holds, a blanket change takes the winning longs and the losing shorts
 * together, which would net out to roughly nothing — exactly what the global
 * sweep found. A SPLIT bar has never been measured.
 *
 * This runs the real engine over real bars, out-of-sample, in sequential folds,
 * and asks whether any (long, short) pair beats the 1.5/1.5 baseline in MOST
 * folds rather than on the total. A strong overall number carried by one fold is
 * the failure mode folds exist to catch.
 *
 * MEASUREMENT ONLY. It shells out to tasks/_replay_mtf.cjs with
 * MTF_MIN_RR_LONG/SHORT, which patch the extracted engine inside the sandbox.
 * server/index.js is never touched and no live setting changes.
 *
 * Usage: node tasks/minrr_direction_walkforward.cjs [projRoot] [--folds 5] [--gate 70]
 */

const fs   = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = process.argv[2] && !process.argv[2].startsWith("--")
  ? process.argv[2] : path.join(__dirname, "..");

function numArg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  if (i === -1 || i + 1 >= process.argv.length) return fallback;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : fallback;
}
const FOLDS = Math.max(3, numArg("--folds", 5));
// The gate with 5/5 folds behind it. Deliberately NOT read from
// strategy_settings.json — that file is per-machine and untracked, so reading it
// would make the same command produce different verdicts on the two boxes with
// nothing in the output saying so.
const GATE       = numArg("--gate", 70);
const CONF_FLOOR = 40;
const COST_R     = 0.05;

const ASSETS = [["XAUUSD", "GC=F"], ["BTCUSD", "BTC-USD"], ["SP500", "^GSPC"]];

// Baseline first, then candidates. Shorts are only ever RAISED or held: the
// ledger says short rejections were correct, so loosening them has no motive.
const CANDIDATES = [
  { long: 1.5,  short: 1.5,  label: "1.50 / 1.50  (baseline)" },
  { long: 1.35, short: 1.5,  label: "1.35 / 1.50" },
  { long: 1.25, short: 1.5,  label: "1.25 / 1.50" },
  { long: 1.35, short: 1.75, label: "1.35 / 1.75" },
  { long: 1.25, short: 1.75, label: "1.25 / 1.75" },
  { long: 1.5,  short: 1.75, label: "1.50 / 1.75  (shorts only)" },
  { long: 1.5,  short: 2.0,  label: "1.50 / 2.00  (shorts only)" },
];

const cache = new Map();
function replay(symbol, ticker, cand) {
  const key = symbol + "|" + cand.long + "|" + cand.short;
  if (cache.has(key)) return cache.get(key);
  const env = { ...process.env, MTF_CONF_FLOOR: String(CONF_FLOOR), MTF_EMIT_R: "1" };
  // Baseline runs with NO override so it exercises the untouched engine — the
  // control has to be the real thing, not a substitution that happens to equal it.
  if (!(cand.long === 1.5 && cand.short === 1.5)) {
    env.MTF_MIN_RR_LONG  = String(cand.long);
    env.MTF_MIN_RR_SHORT = String(cand.short);
  }
  let trades = [];
  try {
    const stdout = execFileSync(process.execPath,
      [path.join(ROOT, "tasks", "_replay_mtf.cjs"), ROOT, symbol, ticker, String(CONF_FLOOR)],
      { env, maxBuffer: 64 * 1024 * 1024, encoding: "utf8", timeout: 900000 });
    trades = JSON.parse(stdout);
  } catch (e) {
    const out = (e.stdout || "") + (e.stderr || "");
    console.error("  replay failed " + symbol + " " + cand.label + ": " + out.slice(-300));
    return [];
  }
  cache.set(key, trades);
  return trades;
}

// The replay emits: t (unix seconds), conf, dir, realisedR. Not openedAt/confidence/r
// — assuming those names silently produced 0 trades at every gate, which reads as
// "the parameter makes no difference" rather than as a bug in the reader.
function score(trades) {
  const closed = trades.filter(t => Number.isFinite(t.realisedR));
  if (!closed.length) return { n: 0, rpt: 0, wr: 0 };
  const net = closed.reduce((s, t) => s + t.realisedR - COST_R, 0);
  const wins = closed.filter(t => t.realisedR > 0).length;
  return { n: closed.length, rpt: net / closed.length, wr: (wins / closed.length) * 100 };
}

(async () => {
  console.log("MIN_RR PER-DIRECTION WALK-FORWARD");
  console.log(FOLDS + " sequential out-of-sample folds · scored at gate " + GATE
    + " · cost " + COST_R + "R/trade");
  console.log("Shorts are only raised or held — the ledger says short rejections were correct.");
  console.log("Replay-only: server/index.js is untouched.\n");

  // Gather every candidate's trades, filtered to the population that actually trades.
  const byCand = new Map();
  for (const cand of CANDIDATES) {
    let all = [];
    for (const [symbol, ticker] of ASSETS) {
      const t = replay(symbol, ticker, cand).filter(x => (x.conf ?? 0) >= GATE);
      all = all.concat(t);
    }
    all.sort((a, b) => (a.t || 0) - (b.t || 0));
    byCand.set(cand.label, all);
    process.stdout.write("  replayed " + cand.label.padEnd(28) + all.length + " trades at gate " + GATE + "\n");
  }

  // Fold boundaries come from the BASELINE so every candidate is judged on the
  // same calendar windows. Deriving them per-candidate would compare different
  // periods and call it a difference in the parameter.
  const base = byCand.get(CANDIDATES[0].label);
  if (!base.length) { console.error("\nbaseline produced no trades — nothing to compare"); process.exit(1); }
  const size = Math.floor(base.length / FOLDS);
  const bounds = [];
  for (let i = 0; i < FOLDS; i++) {
    const from = base[i * size];
    const to   = (i === FOLDS - 1) ? base[base.length - 1] : base[(i + 1) * size - 1];
    bounds.push([from.t || 0, to.t || 0]);
  }

  console.log("\n  candidate                      " + bounds.map((_, i) => ("fold" + (i + 1)).padStart(8)).join("")
    + "   positive   total");
  const rows = [];
  let baseFolds = null;
  for (const cand of CANDIDATES) {
    const trades = byCand.get(cand.label);
    const cells = [], perFold = [];
    for (const [from, to] of bounds) {
      const slice = trades.filter(x => (x.t || 0) >= from && (x.t || 0) <= to);
      const s = score(slice);
      perFold.push(s);
      cells.push((s.n < 5 ? "  n<5" : (s.rpt >= 0 ? "+" : "") + s.rpt.toFixed(3)).padStart(8));
    }
    if (!baseFolds) baseFolds = perFold;
    const judged = perFold.filter(s => s.n >= 5);
    const positive = judged.filter(s => s.rpt > 0).length;
    const overall = score(trades);

    // Folds IMPROVED vs baseline, not folds merely positive. Counting the sign
    // measures whether the strategy makes money — which the baseline already does
    // in 5/5 — and says nothing about whether the CHANGE helped. Aggregate gain
    // concentrated in one fold is the exact failure this harness exists to catch.
    const deltas = perFold.map((s, i) =>
      (s.n >= 5 && baseFolds[i].n >= 5) ? s.rpt - baseFolds[i].rpt : null);
    const comparable = deltas.filter(d => d !== null);
    const improved = comparable.filter(d => d > 0).length;
    rows.push({ cand, positive, judged: judged.length, overall, deltas, improved, comparable: comparable.length });

    console.log("  " + cand.label.padEnd(30) + cells.join("")
      + ("   " + positive + "/" + judged.length).padStart(11)
      + ("   " + (overall.rpt >= 0 ? "+" : "") + overall.rpt.toFixed(3) + "R  n=" + overall.n).padStart(22));
    if (cand !== CANDIDATES[0]) {
      console.log("    vs baseline".padEnd(32)
        + deltas.map(d => (d === null ? "    -" : (d >= 0 ? "+" : "") + d.toFixed(3))).map(x => x.padStart(8)).join("")
        + ("   " + improved + "/" + comparable.length + " better").padStart(18));
    }
  }

  const baseRow = rows[0];
  console.log("\n  VERDICT");
  for (const r of rows.slice(1)) {
    const dR = r.overall.rpt - baseRow.overall.rpt;
    const dN = r.overall.n - baseRow.overall.n;
    let call;
    const maxDelta = Math.max(...r.deltas.filter(d => d !== null).map(Math.abs), 0);
    const totalDelta = r.deltas.filter(d => d !== null).reduce((a, b) => a + b, 0);
    // If one fold supplies most of the movement, the aggregate is that fold wearing
    // a disguise. 0.6 is a judgement call, stated rather than hidden.
    const concentrated = totalDelta !== 0 && (maxDelta / Math.abs(totalDelta)) > 0.6;
    if (r.judged === 0) call = "no judgeable folds";
    else if (dR <= 0.02) call = "no improvement (" + (dR >= 0 ? "+" : "") + dR.toFixed(3) + "R, " + (dN >= 0 ? "+" : "") + dN + " trades)";
    else if (r.improved < Math.ceil(r.comparable / 2))
      call = "REJECT — better in only " + r.improved + "/" + r.comparable + " folds despite "
        + (dR >= 0 ? "+" : "") + dR.toFixed(3) + "R overall";
    else if (concentrated)
      call = "NOT PROVEN — " + (dR >= 0 ? "+" : "") + dR.toFixed(3) + "R overall but "
        + Math.round(maxDelta / Math.abs(totalDelta) * 100) + "% of it is ONE fold ("
        + r.improved + "/" + r.comparable + " better)";
    else if (dN > 0) call = "CANDIDATE — better in " + r.improved + "/" + r.comparable + " folds, "
      + (dR >= 0 ? "+" : "") + dR.toFixed(3) + "R/trade and +" + dN + " trades";
    else call = "better per trade but no extra flow (" + dN + " trades)";
    console.log("    " + r.cand.label.padEnd(30) + call);
  }
  console.log("\n  Baseline: " + (baseRow.overall.rpt >= 0 ? "+" : "") + baseRow.overall.rpt.toFixed(3)
    + "R/trade over " + baseRow.overall.n + " trades, positive in "
    + baseRow.positive + "/" + baseRow.judged + " folds.");
  console.log("\n  Nothing here changes a live setting. A candidate that wins in most folds AND");
  console.log("  adds trade flow has earned a discussion, not an edit — the binding constraint");
  console.log("  on this system is sample, so extra flow is worth real R.");
})().catch(e => { console.error("FAILED: " + e.message); process.exit(1); });
