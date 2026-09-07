// Walk-forward validation of the minimum-entry-RSI gate on the LIVE path.
//
//   node tasks/rsi_walkforward.cjs [projRoot]
//
// WHY THIS IS NOT PART OF mtf_walkforward.cjs
// That script runs the replay ONCE and sweeps the confidence gate by filtering the
// resulting trade list, which is valid because the confidence gate only ever
// deletes rows. minEntryRsi cannot be swept that way. It lives inside
// generateSignal, so it runs on the daily AND the 4H signal independently: raising
// it does not merely remove trades, it changes which multi-timeframe combinations
// form at all. A daily signal suppressed by the floor turns an agreeing pair into
// an H4-only entry with different levels and a different confidence. So each
// candidate value gets its own full replay.
//
// WHAT IT ANSWERS
// The 2026-08-03 analysis found entries below RSI 50 accounted for -78.4R across
// 459 closed trades while the rest made +159.9R. That was one pass over the whole
// history. This asks the harder question the confidence-gate work already taught
// us to ask: is a given floor positive in MOST sequential out-of-sample periods, or
// did one stretch carry it?
//
// Scored at the LIVE confidence gate, not at the exposure floor. The replay is run
// with MTF_CONF_FLOOR low so sub-gate cohorts exist, then trades are filtered to
// conf >= LIVE_GATE before scoring, because that is the population that actually
// trades. Fold boundaries are taken from the BASELINE run and reused for every
// candidate — folding each candidate's own list separately would move the cut
// dates and make the columns incomparable.
//
// Deterministic — no AI, no network, no writes outside tasks/analysis/. Reads
// nothing from the live server and changes no config. It cannot turn the gate on:
// MTF_MIN_ENTRY_RSI is read only by the replay sandbox.

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
// 0 is the baseline — the engine exactly as it ships today. Everything else is
// measured as a delta against it.
const CANDIDATES = [0, 40, 45, 50, 55];
const FOLDS      = 5;
const COST_R     = 0.05;   // same cost basis the rest of the project uses
const CONF_FLOOR = 40;     // expose sub-gate cohorts so the replay emits them
const LIVE_GATE  = 70;     // score only what would actually have traded

const OUT_DIR = path.join(ROOT, "tasks", "analysis");
fs.mkdirSync(OUT_DIR, { recursive: true });

function replay(symbol, ticker, minEntryRsi) {
  const stdout = execFileSync(
    process.execPath,
    [path.join(ROOT, "tasks", "_replay_mtf.cjs"), ROOT, symbol, ticker, String(CONF_FLOOR)],
    {
      env: {
        ...process.env,
        MTF_CONF_FLOOR: String(CONF_FLOOR),
        MTF_MIN_ENTRY_RSI: String(minEntryRsi),
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
  const grossWin  = wins.reduce((a, t) => a + cappedRr(t.rr) - COST_R, 0);
  const grossLoss = losses.reduce(a => a + 1 + COST_R, 0);
  return {
    closed: closed.length,
    wr: closed.length ? (wins.length / closed.length) * 100 : 0,
    pf: grossLoss ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
    R: grossWin - grossLoss,
    rpt: closed.length ? (grossWin - grossLoss) / closed.length : 0,
  };
}

// Collect every candidate's trade list first, so a failure surfaces before any
// verdict is printed rather than half way down a table.
const byCandidate = {};
const perAssetErrors = {};
for (const value of CANDIDATES) {
  const trades = [];
  for (const [symbol, ticker] of ASSETS) {
    try {
      for (const t of replay(symbol, ticker, value)) trades.push({ ...t, sym: symbol });
    } catch (err) {
      perAssetErrors[`${symbol}@${value}`] = String(err.message || err).slice(0, 300);
    }
  }
  trades.sort((a, b) => a.t - b.t);
  byCandidate[value] = trades;
  process.stderr.write(`  minEntryRsi=${String(value).padStart(2)}  ${trades.length} raw trades\n`);
}

const baseline = byCandidate[0] || [];
if (baseline.length === 0) {
  console.error("rsi_walkforward: baseline produced no trades — refusing to report. " +
                "That is a harness failure, not a result.");
  console.error(JSON.stringify(perAssetErrors, null, 2));
  process.exit(1);
}

// Fold boundaries come from the BASELINE population at the live gate, then every
// candidate is bucketed into those same date ranges.
const baseAtGate = baseline.filter(t => t.conf >= LIVE_GATE);
if (baseAtGate.length < FOLDS * 5) {
  console.error(`rsi_walkforward: only ${baseAtGate.length} baseline trades at gate ${LIVE_GATE} — ` +
                `too few to split into ${FOLDS} folds worth trusting.`);
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

const report = {
  generatedAt: new Date().toISOString(),
  basis: {
    path: "generateSignalMTF",
    setting: "minEntryRsi",
    costR: COST_R,
    confFloor: CONF_FLOOR,
    scoredAtGate: LIVE_GATE,
    folds: FOLDS,
    foldsFrom: "baseline (minEntryRsi=0) population at the live gate",
    stubbed: ["priceCache.dxy", "priceCache.vix", "sentimentCache.fearGreed",
              "signalCache (cross-asset)", "getLearningBoost -> 0"],
    caveat: "rr artifacts are NOT capped here; folds are equal-count on the baseline, not equal-time",
  },
  replayErrors: perAssetErrors,
  foldRanges: bounds.map(b => ({
    from: new Date(b.from * 1000).toISOString().slice(0, 10),
    to:   new Date(b.to * 1000).toISOString().slice(0, 10),
  })),
  candidates: {},
};

const lines = [];
lines.push("=".repeat(100));
lines.push(`  MIN-ENTRY-RSI WALK-FORWARD — generateSignalMTF — ${report.generatedAt}`);
lines.push(`  scored at confidence gate ${LIVE_GATE}, ${FOLDS} sequential folds, cost ${COST_R}R/trade`);
lines.push("=".repeat(100));
lines.push("  fold ranges: " + report.foldRanges.map(f => `${f.from}..${f.to}`).join("  "));
lines.push("");
lines.push("  minRsi  " + bounds.map((_, i) => `fold${i + 1}`.padStart(10)).join("") +
           "   closed      totalR     pos/scored   verdict");

const baselineOverall = stat(baseAtGate);
for (const value of CANDIDATES) {
  const atGate = (byCandidate[value] || []).filter(t => t.conf >= LIVE_GATE);
  const perFold = bounds.map(b => stat(atGate.filter(t => inFold(t, b))));
  const scored = perFold.filter(s => s.closed >= 5);
  const positive = scored.filter(s => s.rpt > 0).length;
  const verdict = scored.length < 3 ? "TOO FEW TRADES"
                : positive === scored.length ? "ROBUST"
                : positive >= Math.ceil(scored.length * 0.6) ? "MOSTLY POSITIVE"
                : positive === 0 ? "CONSISTENTLY NEGATIVE"
                : "UNSTABLE";
  const overall = stat(atGate);

  report.candidates[value] = {
    perFold: perFold.map((s, i) => ({
      fold: i + 1, closed: s.closed, wr: +s.wr.toFixed(1),
      pf: s.pf === Infinity ? "inf" : +s.pf.toFixed(2),
      R: +s.R.toFixed(1), rpt: +s.rpt.toFixed(3),
    })),
    foldsScored: scored.length,
    foldsPositive: positive,
    overall: {
      closed: overall.closed, wr: +overall.wr.toFixed(1),
      pf: overall.pf === Infinity ? "inf" : +overall.pf.toFixed(2),
      R: +overall.R.toFixed(1), rpt: +overall.rpt.toFixed(3),
    },
    tradesGivenUpVsBaseline: baselineOverall.closed - overall.closed,
    verdict,
  };

  lines.push(`  ${String(value).padEnd(7)} ` +
    perFold.map(s => (s.closed < 5 ? "  n<5" : (s.rpt >= 0 ? "+" : "") + s.rpt.toFixed(3)).padStart(10)).join("") +
    `   ${String(overall.closed).padStart(6)}  ${(overall.R >= 0 ? "+" : "") + overall.R.toFixed(1)}`.padStart(20) +
    `   ${positive}/${scored.length}`.padStart(13) + `   ${verdict}`);
}

lines.push("");
lines.push(`  Baseline is minRsi=0 — the engine as it ships today (${baselineOverall.closed} closed at gate ${LIVE_GATE},`);
lines.push(`  ${baselineOverall.R >= 0 ? "+" : ""}${baselineOverall.R.toFixed(1)}R, ${baselineOverall.rpt.toFixed(3)}R/trade).`);
lines.push("  A floor is only worth shipping if it beats that baseline AND is positive in most");
lines.push("  folds. A strong total carried by one fold is the failure mode this exists to catch.");
lines.push("  Trades given up matters too: a higher floor that wins on expectancy while halving");
lines.push("  the sample buys a thinner, slower system.");
lines.push("=".repeat(100));

const stamp = report.generatedAt.replace(/[-:]/g, "").slice(0, 15);
fs.writeFileSync(path.join(OUT_DIR, `rsi-walkforward-${stamp}.json`), JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(OUT_DIR, "rsi-walkforward-latest.json"), JSON.stringify(report, null, 2));
const text = lines.join("\n") + "\n";
fs.mkdirSync(path.join(ROOT, "tasks", "logs"), { recursive: true });
fs.appendFileSync(path.join(ROOT, "tasks", "logs", "rsi_walkforward.txt"), text + "\n");
console.log(text);
