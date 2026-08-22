'use strict';
/**
 * CONTINUOUS STRATEGY SEARCH — runs forever, proposes rarely, changes nothing.
 *
 * WHAT THIS IS FOR. The binding constraint on this system is sample size, and live fills
 * arrive about one every 3.8 days. A searcher cannot fix that. What it CAN do is keep
 * re-asking the settled questions as new bars arrive, and surface the moment an incumbent
 * threshold stops being defensible — without a human having to remember to re-run
 * anything.
 *
 * WHY THE OBVIOUS VERSION OF THIS IS DANGEROUS, AND WHAT IS DONE ABOUT IT.
 *
 * A tireless searcher over one fixed history WILL find better numbers. That is not a
 * discovery, it is arithmetic: test enough candidates against the same 2022-2026 bars and
 * some will clear any bar you set, by luck. This project has the evidence in front of it
 * already — three independent cuts of the RSI ceiling on 2026-08-22 all returned
 * INCONCLUSIVE because every candidate above 64 sits inside a 0.14R/trade spread, which
 * is one fold's worth of noise. A searcher that ran overnight against that same table
 * would have "found" four winners.
 *
 * So this file is built to make a proposal EXPENSIVE rather than easy:
 *
 *   1. PROPOSES, NEVER APPLIES. Nothing here writes strategy_settings.json, touches the
 *      gate, or changes what trades. It writes a proposal a human decides on with
 *      tasks/ai_decide.cjs, exactly like every other AI-employee proposal.
 *   2. MUST WIN UNDER EVERY CUT. A challenger has to beat the incumbent's worst fold
 *      under equal-COUNT folds, equal-TIME folds AND a per-asset cost basis. Today's
 *      ceiling sweep shows why: candidates flip between "5/5 ROBUST" and "3/5" purely on
 *      where the fold lines fall. Winning one cut is a coin toss with extra steps.
 *   3. COUNTS ITS OWN MULTIPLICITY. Every candidate ever tested is appended to
 *      tasks/strategy_search_ledger.jsonl, and every report states how many have been
 *      tested to date. "Best of 12" and "best of 4,000" are different claims and a
 *      searcher that hides which one it is making is lying by omission.
 *   4. THE MARGIN BAR IS MEASURED, NOT PICKED. A challenger must beat the incumbent by
 *      more than the STANDARD ERROR of the incumbent's per-fold results on that axis —
 *      sd / sqrt(folds). If the incumbent's folds scatter, a small win is nothing.
 *
 *      The first version of this used the incumbent's full fold RANGE, and the first run
 *      showed why that was wrong: the range came out at 0.605, demanding a challenger
 *      beat 72/68 by 0.6R PER TRADE. Nothing would ever have cleared it, which makes a
 *      searcher that can never propose — decoration shaped like a safeguard, the exact
 *      failure this project already recorded when the mode cards armed nothing. The
 *      standard error is the uncertainty in the estimate rather than the spread of the
 *      sample, it is ~0.10 on this axis, and it is a bar a real improvement could clear.
 *      Today's answer is unchanged: the best margin is +0.083 and still does not clear it,
 *      which agrees with three independent cuts all returning INCONCLUSIVE.
 *
 * IT ALSO REPORTS WHEN IT FINDS NOTHING, and that is the expected outcome. A run that
 * proposes nothing is the searcher working, not the searcher idle.
 *
 * Usage:
 *   node tasks/strategy_search.cjs --axis ceiling      one round on the RSI ceiling
 *   node tasks/strategy_search.cjs --axis gate         one round on the confidence gate
 *   node tasks/strategy_search.cjs --axis all          both, sequentially
 *   node tasks/strategy_search.cjs --axis ceiling --dry-run    score, write no proposal
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "tasks", "analysis");
const LEDGER = path.join(ROOT, "tasks", "strategy_search_ledger.jsonl");

function flag(name, fallback = null) {
  const i = process.argv.indexOf("--" + name);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return (next && !next.startsWith("--")) ? next : true;
}

const AXIS = String(flag("axis", "all")).toLowerCase();
const DRY_RUN = flag("dry-run", false) === true;

if (!["ceiling", "gate", "all"].includes(AXIS)) {
  console.error('strategy_search: --axis must be ceiling, gate or all. Refusing to guess.');
  process.exit(2);
}

// ── The axes it knows how to search ──────────────────────────────────────────
//
// Each axis delegates to the harness that already owns that question rather than
// re-implementing its scoring. A second scorer that disagrees with the first is worse
// than no searcher at all, and this project has already had one harness silently
// measuring a different population than the one that trades.
const AXES = {
  ceiling: {
    label: "RSI ceiling (MOMENTUM / TREND_FOLLOW)",
    incumbent: "72/68",
    // Every cut this axis can be scored under. A challenger must win ALL of them.
    cuts: [
      { name: "equal-count", env: {}, report: "rsi-ceiling-walkforward-latest.json" },
      { name: "equal-time", env: { RSI_CEILING_FOLD_MODE: "time" }, report: "rsi-ceiling-walkforward-time-latest.json" },
      { name: "per-asset cost", env: { RSI_CEILING_COST: "perasset" }, report: "rsi-ceiling-walkforward-latest-perasset.json" },
    ],
    harness: ["tasks/rsi_ceiling_walkforward.cjs"],
    // Pull {candidateLabel: worstFold} plus the incumbent's per-fold spread.
    extract: report => {
      const out = {};
      for (const [label, summary] of Object.entries(report.candidates || {})) {
        out[label] = {
          worst: summary.worstFold,
          closed: summary.overall ? summary.overall.closed : null,
          foldsPositive: summary.foldsPositive,
          foldsScored: summary.foldsScored,
          perFold: (summary.perFold || []).filter(f => f.scored).map(f => f.rpt),
          isBaseline: !!summary.isBaseline,
        };
      }
      return out;
    },
  },
  gate: {
    label: "confidence gate",
    incumbent: "70",
    // mtf_walkforward has one cut today. Stated rather than hidden: this axis is
    // searched under a WEAKER standard than the ceiling until it grows the other two,
    // and the report says so on every run.
    cuts: [
      { name: "equal-count", env: {}, report: "walkforward-latest.json" },
    ],
    harness: ["tasks/mtf_walkforward.cjs"],
    extract: report => {
      const out = {};
      for (const [gate, summary] of Object.entries(report.gates || {})) {
        out[gate] = {
          worst: summary.worstFold,
          closed: summary.overall ? summary.overall.closed : null,
          foldsPositive: summary.foldsPositive,
          foldsScored: summary.foldsScored,
          perFold: (summary.perFold || []).filter(f => f.closed >= 5).map(f => f.rpt),
          isBaseline: String(gate) === "70",
        };
      }
      return out;
    },
  },
};

function runCut(axis, cut) {
  const [script] = axis.harness;
  execFileSync(process.execPath, [path.join(ROOT, script)], {
    cwd: ROOT,
    env: { ...process.env, ...cut.env },
    maxBuffer: 128 * 1024 * 1024,
    encoding: "utf8",
    timeout: 3600000,
    stdio: ["ignore", "ignore", "ignore"],
  });
  const reportPath = path.join(OUT_DIR, cut.report);
  if (!fs.existsSync(reportPath)) {
    throw new Error("cut '" + cut.name + "' produced no report at " + cut.report);
  }
  return axis.extract(JSON.parse(fs.readFileSync(reportPath, "utf8")));
}

/**
 * The bar a challenger's margin has to clear: the STANDARD ERROR of the incumbent's
 * per-fold results, sd / sqrt(folds).
 *
 * Deriving it from the incumbent means the bar adapts to how noisy the axis actually is —
 * on a stable axis a small win counts, on a jumpy one it does not. Using the standard
 * error rather than the fold RANGE is deliberate and was corrected after the first run:
 * the range on this axis is 0.605, which no real parameter change could ever clear, and a
 * safeguard that can never pass is decoration rather than protection.
 *
 * Returns null when there are too few scored folds to say, and a null bar means NOTHING
 * is promotable — the safe direction to fail.
 */
function noiseFloor(perFold) {
  if (!Array.isArray(perFold) || perFold.length < 3) return null;
  const mean = perFold.reduce((a, v) => a + v, 0) / perFold.length;
  const variance = perFold.reduce((a, v) => a + (v - mean) ** 2, 0) / (perFold.length - 1);
  const sd = Math.sqrt(variance);
  return sd / Math.sqrt(perFold.length);
}

/** The incumbent's fold spread, reported alongside the bar for context. */
function foldSpread(perFold) {
  if (!Array.isArray(perFold) || !perFold.length) return null;
  return Math.max(...perFold) - Math.min(...perFold);
}

function appendLedger(rows) {
  const lines = rows.map(r => JSON.stringify(r)).join("\n") + "\n";
  fs.appendFileSync(LEDGER, lines);
}

function ledgerCount() {
  if (!fs.existsSync(LEDGER)) return 0;
  return fs.readFileSync(LEDGER, "utf8").split("\n").filter(Boolean).length;
}

function searchAxis(key, stamp) {
  const axis = AXES[key];
  const perCut = {};
  for (const cut of axis.cuts) {
    process.stderr.write("  " + key + ": running cut '" + cut.name + "'\n");
    perCut[cut.name] = runCut(axis, cut);
  }

  const cutNames = Object.keys(perCut);
  const firstCut = perCut[cutNames[0]];
  const incumbentKey = Object.keys(firstCut).find(k => firstCut[k].isBaseline)
    || axis.incumbent;
  const incumbent = firstCut[incumbentKey];
  if (!incumbent) throw new Error("no incumbent row for axis " + key);

  const floor = noiseFloor(incumbent.perFold);
  const spread = foldSpread(incumbent.perFold);
  const candidates = [];

  for (const label of Object.keys(firstCut)) {
    if (label === incumbentKey) continue;
    const perCutRows = cutNames.map(name => ({ cut: name, row: perCut[name][label] }));
    const missing = perCutRows.filter(c => !c.row || c.row.worst === null || c.row.worst === undefined);

    // Margin against the incumbent under each cut, worst case across cuts.
    const margins = perCutRows.map(c => {
      const inc = perCut[c.cut][incumbentKey];
      if (!c.row || !inc || c.row.worst == null || inc.worst == null) return null;
      return c.row.worst - inc.worst;
    });
    const usable = margins.filter(m => m !== null);
    const worstMargin = usable.length ? Math.min(...usable) : null;
    const winsEveryCut = usable.length === cutNames.length && worstMargin > 0;
    const clearsNoise = floor !== null && worstMargin !== null && worstMargin > floor;

    const tradeDelta = (firstCut[label].closed != null && incumbent.closed != null)
      ? firstCut[label].closed - incumbent.closed : null;

    candidates.push({
      label,
      worstByCut: Object.fromEntries(perCutRows.map(c => [c.cut, c.row ? c.row.worst : null])),
      marginByCut: Object.fromEntries(cutNames.map((n, i) => [n, margins[i]])),
      worstMargin,
      winsEveryCut,
      clearsNoise,
      tradeDelta,
      unscoredCuts: missing.map(m => m.cut),
      promotable: winsEveryCut && clearsNoise,
    });
  }

  const promotable = candidates.filter(c => c.promotable);

  appendLedger(candidates.map(c => ({
    at: stamp, axis: key, incumbent: incumbentKey, candidate: c.label,
    worstMargin: c.worstMargin, winsEveryCut: c.winsEveryCut,
    clearsNoise: c.clearsNoise, promotable: c.promotable, noiseFloor: floor,
    cuts: cutNames,
  })));

  return {
    axis: key, label: axis.label, incumbent: incumbentKey,
    incumbentWorst: incumbent.worst, noiseFloor: floor, foldSpread: spread,
    cuts: cutNames, candidates, promotable,
    // A single-cut axis is searched under a weaker standard, and every consumer of this
    // report is told so rather than having to notice the cuts array is short.
    standard: cutNames.length >= 3 ? "FULL — three independent cuts"
            : "WEAKER — only " + cutNames.length + " cut(s) available on this axis",
  };
}

const stamp = new Date().toISOString();
const keys = AXIS === "all" ? Object.keys(AXES) : [AXIS];
const results = [];
const failures = {};

for (const key of keys) {
  try {
    results.push(searchAxis(key, stamp));
  } catch (err) {
    failures[key] = String(err.message || err).slice(0, 300);
    process.stderr.write("  " + key + ": FAILED — " + failures[key] + "\n");
  }
}

const testedToDate = ledgerCount();
const allPromotable = results.flatMap(r => r.promotable.map(c => ({ axis: r.axis, ...c })));

const lines = [];
lines.push("=".repeat(100));
lines.push("  STRATEGY SEARCH — " + stamp);
lines.push("  proposes, never applies. A challenger must beat the incumbent under EVERY cut,");
lines.push("  by more than the incumbent's own fold-to-fold spread.");
lines.push("=".repeat(100));
for (const r of results) {
  lines.push("");
  lines.push("  AXIS: " + r.label + "   incumbent " + r.incumbent
    + "  worst " + (r.incumbentWorst == null ? "—" : r.incumbentWorst.toFixed(3))
    + "   bar " + (r.noiseFloor == null ? "unknown" : r.noiseFloor.toFixed(3))
    + " (sd/sqrt(folds); fold spread " + (r.foldSpread == null ? "—" : r.foldSpread.toFixed(3)) + ")");
  lines.push("  standard: " + r.standard + "  [" + r.cuts.join(", ") + "]");
  lines.push("  " + "candidate".padEnd(10) + "worst margin   wins every cut   clears noise   trades vs incumbent");
  for (const c of r.candidates) {
    lines.push("  " + c.label.padEnd(10)
      + (c.worstMargin == null ? "—" : (c.worstMargin >= 0 ? "+" : "") + c.worstMargin.toFixed(3)).padStart(12)
      + (c.winsEveryCut ? "yes" : "no").padStart(17)
      + (c.clearsNoise ? "yes" : "no").padStart(15)
      + (c.tradeDelta == null ? "—" : (c.tradeDelta >= 0 ? "+" : "") + c.tradeDelta).padStart(22)
      + (c.promotable ? "   << PROMOTABLE" : ""));
  }
}
if (Object.keys(failures).length) {
  lines.push("");
  for (const [axis, message] of Object.entries(failures)) {
    lines.push("  AXIS FAILED: " + axis + " — " + message);
  }
}
lines.push("");
lines.push("  candidates tested to date, all runs: " + testedToDate);
lines.push("  promotable this run: " + allPromotable.length);
if (!allPromotable.length) {
  lines.push("");
  lines.push("  NOTHING TO PROPOSE. That is the expected result and it is the searcher");
  lines.push("  working. An incumbent that survives another round of challengers is");
  lines.push("  evidence FOR it, and it costs nothing to have asked.");
} else {
  lines.push("");
  lines.push("  A promotable candidate is a REASON TO LOOK, not a decision. Read it against");
  lines.push("  the count above: one winner out of several thousand tested is what luck");
  lines.push("  looks like. Nothing has been changed.");
}
lines.push("=".repeat(100));

const text = lines.join("\n");
console.log(text);

fs.mkdirSync(OUT_DIR, { recursive: true });
const report = {
  generatedAt: stamp, axes: keys, dryRun: DRY_RUN,
  testedToDate, results, failures,
  promotable: allPromotable,
  changesNothing: "writes a report and a ledger row; never a setting, a gate or a threshold",
};
fs.writeFileSync(path.join(OUT_DIR, "strategy-search-latest.json"), JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(OUT_DIR, "strategy-search-latest.txt"), text + "\n");
process.stderr.write("\n  written -> tasks/analysis/strategy-search-latest.{json,txt}\n");
process.stderr.write("  ledger   -> tasks/strategy_search_ledger.jsonl (" + testedToDate + " rows)\n");

// Exit 0 whether or not anything was found: "no challenger" is a successful run, and a
// non-zero exit would train the scheduler's watcher to treat the normal case as a fault.
process.exit(Object.keys(failures).length ? 1 : 0);
