// Walk-forward adjudication of the BREAKDOWN setup — the short mirror of MOMENTUM.
//
//   node tasks/breakdown_walkforward.cjs [projRoot]
//
// WHY THIS EXISTS
// Counted 2026-08-28, the setup chain in generateSignal has eight long branches and four
// short ones, and the gap is a whole CATEGORY rather than a count: DIVERGENCE and
// SQUEEZE_BREAKOUT are symmetric pairs, the long side additionally has three
// trend-continuation setups (BREAKOUT, MOMENTUM, TREND_FOLLOW), and the short side has
// NONE — SELL_BOUNCE and RANGE_TRADE_SHORT are both mean-reversion. A clean downtrend
// below all EMAs with bearish MACD matched no branch at all and fell out as WAIT. That is
// the mechanical reason the journal reads 6 BUY / 2 SELL.
//
// BREAKDOWN fills that hole and ships OFF (strategySettings.breakdownEnabled). This
// harness is what decides whether it is ever turned on.
//
// WHAT MAKES THIS DIFFERENT FROM A GATE SWEEP
// tasks/mtf_walkforward.cjs sweeps a threshold by FILTERING one replay. That is not
// available here. Arming a setup changes which multi-timeframe combinations form, and a
// BREAKDOWN that opens OCCUPIES the symbol through the replay's `openUntil` — so it can
// block a LONG the baseline took. So this runs the replay TWICE per asset, flag off and
// flag on, and compares the two worlds:
//
//   1. DISPLACEMENT — baseline trades that no longer exist under the candidate. This is
//      the "never block a good signal" question, and it is the reason the two runs cannot
//      be one run filtered. A non-zero count is not automatically fatal, but it must be
//      SEEN and priced, never assumed away.
//   2. THE COHORT — BREAKDOWN's own trades, scored on their worst fold. A setup whose
//      worst out-of-sample fold is negative does not ship, however good its mean.
//   3. THE SYSTEM — total R/trade per fold, baseline vs candidate. A cohort can be
//      positive on its own and still make the whole system worse via displacement.
//
// Folds are cut ONCE, on the baseline's timeline, and both worlds are bucketed into those
// same date ranges. Re-cutting folds per world would compare fold 3 of one against a
// different fold 3 of the other and call the difference an effect.
//
// Deterministic — no AI, no network, no live server, no writes outside tasks/analysis and
// tasks/logs. Reads no config and changes none. Nothing is deleted or overwritten in
// place: the stamped JSON is new each run and the log is APPENDED.

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
const FOLDS      = 5;      // sequential out-of-sample periods, same as mtf_walkforward
const COST_R     = 0.05;   // the cost basis the rest of the project uses
const CONF_FLOOR = 40;     // expose sub-gate cohorts, exactly as mtf_walkforward does
const CLOSED_FLOOR = 5;    // a fold under this is an ABSENCE, not a zero

// Gates reported beside the live one. The live gate is what the decision turns on; the
// others are here so a verdict that depends entirely on one threshold is visible as such.
const REPORT_GATES = [55, 60, 65, 70, 75];

// The gate actually in force, read rather than hardcoded. CLAUDE.md's own warning: this
// moved 65 -> 70 and the boot file was the last thing still claiming 65.
function liveGate() {
  try {
    const p = path.join(ROOT, "server", "strategy_settings.json");
    if (fs.existsSync(p)) {
      const s = JSON.parse(fs.readFileSync(p, "utf8"));
      if (Number.isFinite(s.confidenceThreshold)) return s.confidenceThreshold;
    }
  } catch (e) {
    console.error(`[breakdown-wf] strategy_settings.json unreadable (${e.message}) — ` +
                  `falling back to 70, the value CLAUDE.md records as live.`);
  }
  return 70;
}

const OUT_DIR = path.join(ROOT, "tasks", "analysis");
const LOG_DIR = path.join(ROOT, "tasks", "logs");
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

// One replay. `armed` decides only the env var; everything else is held constant so the
// two worlds differ in exactly one bit.
function replay(symbol, ticker, armed) {
  const stdout = execFileSync(
    process.execPath,
    [path.join(ROOT, "tasks", "_replay_mtf.cjs"), ROOT, symbol, ticker, String(CONF_FLOOR)],
    {
      // MTF_MAX_HOLD PINNED. This harness used to pass no horizon at all, so it silently
      // inherited _replay_mtf.cjs's default of 40 - the ruler identified on 2026-09-02 as
      // biasing DOWNWARD, because it scores a trade still open at bar 40 as EXPIRED. That
      // is not a small effect and it is not symmetric: re-running this exact harness at
      // 320 moved the BREAKDOWN cohort from -0.368R/trade to +0.063, a SIGN FLIP, and
      // took it from 22 closed trades over 2 scored folds to 55 over 4. The verdict
      // "BREAKDOWN loses money on its own" was an artifact of the measuring stick, and it
      // stood in the evidence register as fact for five days.
      //
      // An inherited default is the same failure shape as a setting with no reader: the
      // number was never chosen here, so nobody could see it was wrong. Pinned rather
      // than left to the caller, because the caller that got this wrong was this file.
      // Still overridable for a deliberate horizon sweep.
      env: {
        ...process.env,
        MTF_CONF_FLOOR: String(CONF_FLOOR),
        MTF_BREAKDOWN: armed ? "1" : "0",
        MTF_MAX_HOLD: process.env.MTF_MAX_HOLD || "320",
      },
      maxBuffer: 64 * 1024 * 1024, encoding: "utf8", timeout: 900000,
    }
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
    R: grossWin - grossLoss,
    rpt: closed.length ? (grossWin - grossLoss) / closed.length : 0,
  };
}

// The worst SCORED fold. A fold under the close floor is excluded rather than counted as
// a bad one — the same rule mtf_walkforward.cjs and the ceiling harness use. Returns null
// when nothing is scoreable, so an empty result reads as "no answer" and never as 0.
function worstScoredFold(perFold) {
  const scored = perFold.filter(s => s.closed >= CLOSED_FLOOR);
  if (!scored.length) return null;
  return scored.reduce((worst, s) => (s.rpt < worst.rpt ? s : worst), scored[0]).rpt;
}

// ── collect both worlds ──────────────────────────────────────────────────────
const perAsset = {};
const base = [], cand = [];
for (const [symbol, ticker] of ASSETS) {
  try {
    const b = replay(symbol, ticker, false);
    const c = replay(symbol, ticker, true);
    perAsset[symbol] = { baseline: b.length, candidate: c.length };
    for (const t of b) base.push({ ...t, sym: symbol });
    for (const t of c) cand.push({ ...t, sym: symbol });
  } catch (err) {
    // Recorded per asset and NOT swallowed. A missing asset reads exactly like "that
    // asset never traded", which is the failure mode that once dropped SP500 out of
    // every replay while the headline table still looked complete.
    perAsset[symbol] = { error: String(err.message || err).slice(0, 300) };
    console.error(`[breakdown-wf] ${symbol} FAILED: ${perAsset[symbol].error}`);
  }
}

const failedAssets = Object.entries(perAsset).filter(([, v]) => v.error).map(([k]) => k);
if (base.length === 0) {
  console.error("breakdown-wf: no baseline trades from any asset — nothing to compare");
  process.exit(1);
}

base.sort((a, b) => a.t - b.t);
cand.sort((a, b) => a.t - b.t);

// ── fold boundaries, cut ONCE on the baseline timeline ───────────────────────
// Equal-count on the baseline, then expressed as TIME ranges so the candidate — which has
// a different number of trades — can be bucketed into the same periods.
const foldSize = Math.floor(base.length / FOLDS);
const bounds = [];
for (let k = 0; k < FOLDS; k++) {
  const from = k * foldSize;
  const to = (k === FOLDS - 1) ? base.length : (k + 1) * foldSize;
  bounds.push({ tFrom: base[from].t, tTo: (k === FOLDS - 1) ? Infinity : base[to].t });
}
const bucket = (trades) => bounds.map(b => trades.filter(t => t.t >= b.tFrom && t.t < b.tTo));

// ── displacement: what the candidate world LOST ──────────────────────────────
// Keyed on symbol+timestamp: a baseline entry with no candidate entry at the same instant
// on the same asset is a trade the arming cost us. The only mechanism that can do this is
// occupancy — BREAKDOWN holds the symbol and a later signal cannot open — because the
// branch itself sits last in the else-if chain and can only convert a WAIT.
const candKeys = new Set(cand.map(t => `${t.sym}|${t.t}`));
const displaced = base.filter(t => !candKeys.has(`${t.sym}|${t.t}`));
const baseKeys = new Set(base.map(t => `${t.sym}|${t.t}`));
const added = cand.filter(t => !baseKeys.has(`${t.sym}|${t.t}`));

const GATE = liveGate();
const atGate = (trades, gate) => trades.filter(t => t.conf >= gate);

const report = {
  generatedAt: new Date().toISOString(),
  basis: {
    path: "generateSignalMTF, replayed twice per asset (MTF_BREAKDOWN=0 vs 1)",
    costR: COST_R, confFloor: CONF_FLOOR, folds: FOLDS, closedFloor: CLOSED_FLOOR,
    liveGate: GATE,
    baselineTrades: base.length,
    candidateTrades: cand.length,
    stubbed: ["priceCache.dxy", "priceCache.vix", "sentimentCache.fearGreed",
              "signalCache (cross-asset)", "getLearningBoost -> 0"],
    caveat: "Folds are equal-count on the BASELINE and equal-time for both worlds. "
          + "Macro and learning adjustments are NOT simulated, so a setup that would "
          + "live or die on those is not being measured here.",
  },
  perAsset,
  failedAssets,
  foldRanges: bounds.map((b, i) => ({
    fold: i + 1,
    from: new Date(b.tFrom * 1000).toISOString().slice(0, 10),
    to: b.tTo === Infinity
      ? new Date(base[base.length - 1].t * 1000).toISOString().slice(0, 10)
      : new Date(b.tTo * 1000).toISOString().slice(0, 10),
  })),
  gates: {},
};

for (const gate of REPORT_GATES) {
  const bFolds = bucket(atGate(base, gate)).map(stat);
  const cFolds = bucket(atGate(cand, gate)).map(stat);
  const kFolds = bucket(atGate(cand.filter(t => t.setup === "BREAKDOWN"), gate)).map(stat);
  report.gates[gate] = {
    baseline:  { perFold: bFolds.map(s => +s.rpt.toFixed(3)), worstFold: worstScoredFold(bFolds),
                 overall: stat(atGate(base, gate)) },
    candidate: { perFold: cFolds.map(s => +s.rpt.toFixed(3)), worstFold: worstScoredFold(cFolds),
                 overall: stat(atGate(cand, gate)) },
    breakdown: { perFold: kFolds.map(s => +s.rpt.toFixed(3)), worstFold: worstScoredFold(kFolds),
                 foldsScored: kFolds.filter(s => s.closed >= CLOSED_FLOOR).length,
                 overall: stat(atGate(cand.filter(t => t.setup === "BREAKDOWN"), gate)) },
    displaced: stat(atGate(displaced, gate)),
  };
}

// ── verdict, at the LIVE gate only ───────────────────────────────────────────
// Three conditions, ALL required. Stated as data so nothing downstream has to re-derive
// the rule from prose, and so a future run that flips one condition is legible.
const g = report.gates[GATE];
const checks = {
  cohortHasEnoughFolds: {
    pass: g.breakdown.foldsScored >= 3,
    detail: `${g.breakdown.foldsScored} of ${FOLDS} folds have >= ${CLOSED_FLOOR} closed BREAKDOWN trades`,
  },
  cohortWorstFoldPositive: {
    pass: g.breakdown.worstFold !== null && g.breakdown.worstFold > 0,
    detail: `BREAKDOWN worst scored fold = ${g.breakdown.worstFold === null ? "none" : g.breakdown.worstFold.toFixed(3)}R/trade`,
  },
  systemNotMadeWorse: {
    pass: g.candidate.worstFold !== null && g.baseline.worstFold !== null
       && g.candidate.worstFold >= g.baseline.worstFold,
    detail: `system worst fold ${g.baseline.worstFold === null ? "none" : g.baseline.worstFold.toFixed(3)}`
          + ` -> ${g.candidate.worstFold === null ? "none" : g.candidate.worstFold.toFixed(3)}`,
  },
};
const passed = Object.values(checks).every(c => c.pass);
// A failed asset means an unknown slice is missing, which reads exactly like "this setup
// does not trade". Never let that produce a SHIP.
const verdict = failedAssets.length ? "INCONCLUSIVE — an asset failed to replay"
              : passed ? "SHIP — set breakdownEnabled true on BOTH boxes"
              : "DO NOT SHIP — leave breakdownEnabled false";
report.verdict = verdict;
report.checks = checks;
report.displacement = {
  trades: displaced.length,
  atLiveGate: stat(atGate(displaced, GATE)),
  addedTrades: added.length,
  note: "Displaced = a baseline entry with no candidate entry at the same instant on the "
      + "same asset. The BREAKDOWN branch sits LAST in the else-if chain so it cannot "
      + "steal a setup; the only mechanism is position occupancy.",
};

// ── render ───────────────────────────────────────────────────────────────────
const L = [];
const W = 100;
L.push("=".repeat(W));
L.push(`  BREAKDOWN WALK-FORWARD — short mirror of MOMENTUM — ${report.generatedAt}`);
L.push(`  baseline ${base.length} trades vs candidate ${cand.length}, ${FOLDS} folds, cost ${COST_R}R, live gate ${GATE}`);
L.push("=".repeat(W));
if (failedAssets.length) L.push(`  !! ASSETS THAT FAILED TO REPLAY: ${failedAssets.join(", ")} — result is INCOMPLETE`);
L.push("  folds: " + report.foldRanges.map(f => `${f.from}..${f.to}`).join("  "));
L.push("");
L.push("  gate  world       " + Array.from({ length: FOLDS }, (_, i) => `fold${i + 1}`.padStart(9)).join("")
  + "     worst    closed      R/trade");
for (const gate of REPORT_GATES) {
  const row = report.gates[gate];
  for (const [name, d] of [["baseline", row.baseline], ["candidate", row.candidate], ["BREAKDOWN", row.breakdown]]) {
    const folds = (name === "baseline" ? bucket(atGate(base, gate))
                 : name === "candidate" ? bucket(atGate(cand, gate))
                 : bucket(atGate(cand.filter(t => t.setup === "BREAKDOWN"), gate))).map(stat);
    L.push(`  ${String(gate).padEnd(5)} ${name.padEnd(11)}`
      + folds.map(s => (s.closed < CLOSED_FLOOR ? "  n<5" : (s.rpt >= 0 ? "+" : "") + s.rpt.toFixed(3)).padStart(9)).join("")
      + (d.worstFold === null ? "        —" : ((d.worstFold >= 0 ? "+" : "") + d.worstFold.toFixed(3)).padStart(9))
      + String(d.overall.closed).padStart(10)
      + ((d.overall.rpt >= 0 ? "+" : "") + d.overall.rpt.toFixed(3)).padStart(13));
  }
  L.push("");
}
// The SIGN of this number decides whether displacement is a cost or a saving, and
// "forgone" states neither — a displaced LOSER is a trade you are glad to lose. Say which
// it is in words rather than leaving the reader to infer it from a minus sign.
const dispR = report.displacement.atLiveGate.R;
L.push(`  DISPLACEMENT: ${displaced.length} baseline trade(s) no longer taken, `
  + `${report.displacement.atLiveGate.closed} of them closed at gate ${GATE}, `
  + `worth ${dispR >= 0 ? "+" : ""}${dispR.toFixed(2)}R — `
  + `${dispR >= 0 ? "a real COST, this much edge was blocked out" : "a SAVING, those trades were net losers"}. `
  + `${added.length} new trade(s).`);
L.push("");
L.push("  VERDICT CHECKS (all must pass):");
for (const [name, c] of Object.entries(checks)) L.push(`    [${c.pass ? "PASS" : "FAIL"}] ${name} — ${c.detail}`);
L.push("");
L.push(`  ${verdict}`);
L.push("");
L.push("  A cohort positive on its own can still make the system worse through occupancy.");
L.push("  That is why the system worst-fold check is here and not optional.");
L.push("=".repeat(W));

const stamp = report.generatedAt.replace(/[-:]/g, "").slice(0, 15);
fs.writeFileSync(path.join(OUT_DIR, `breakdown-${stamp}.json`), JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(OUT_DIR, "breakdown-latest.json"), JSON.stringify(report, null, 2));
const text = L.join("\n") + "\n";
fs.appendFileSync(path.join(LOG_DIR, "breakdown_walkforward.txt"), text + "\n");
process.stdout.write(text);

// Non-zero when the measurement is incomplete, so a caller checking the exit code cannot
// read a partial run as a clean one. A DO NOT SHIP is exit 0 — that is a successful
// measurement with a negative answer, not a failure.
if (failedAssets.length) process.exitCode = 3;
