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
 *   node tasks/strategy_search.cjs --axis gate         the confidence gate
 *   node tasks/strategy_search.cjs --axis rsi          the entry-RSI floor
 *   node tasks/strategy_search.cjs --axis minrr        the R:R floor
 *   node tasks/strategy_search.cjs --axis adx          the trending-ADX floor
 *   node tasks/strategy_search.cjs --axis minstrength  the strength floor
 *   node tasks/strategy_search.cjs --axis trail        the trailing give-back
 *   node tasks/strategy_search.cjs --axis all          every axis, sequentially
 *   node tasks/strategy_search.cjs --axis ceiling --dry-run    score, write no proposal
 *   node tasks/strategy_search.cjs --axis all --skip-if-bars-unchanged
 *
 * WHY FIVE MORE AXES, added 2026-08-23. It searched TWO — ceiling and gate — while six
 * more walk-forward harnesses sat built and unused, and every one of the five added here
 * scores a threshold the live engine actually reads. New hypotheses come from widening
 * the question set, not from asking the same five questions faster. Three harnesses were
 * looked at and deliberately NOT wired in: session and cohort walk-forwards slice
 * performance descriptively and have no incumbent to challenge, and the CRT pair measures
 * whether a FEATURE should exist rather than where a threshold should sit. An axis needs
 * an incumbent value and rival values, or the challenger/incumbent frame is meaningless.
 *
 * --skip-if-bars-unchanged exits 4 without running anything when the bar fingerprint
 * matches the previous run. It is OPT-IN, never the default: a human asking a question
 * deserves an answer even if it is the same answer. A nightly scheduler does not, because
 * re-testing identical data grows the candidate count without growing the sample, and
 * that count is what tells a reader whether a winner is "best of 12" or "best of 4,000".
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "tasks", "analysis");
const LEDGER = path.join(ROOT, "tasks", "strategy_search_ledger.jsonl");
const { deflatedBar, expectedMaxOfN } = require(path.join(ROOT, "tasks", "_deflated_bar.cjs"));

function flag(name, fallback = null) {
  const i = process.argv.indexOf("--" + name);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return (next && !next.startsWith("--")) ? next : true;
}

const AXIS = String(flag("axis", "all")).toLowerCase();
const DRY_RUN = flag("dry-run", false) === true;
const SKIP_IF_STALE = flag("skip-if-bars-unchanged", false) === true;

// Folds holding almost no trades are noise, not evidence: a fold with two closes can post
// a huge R-per-trade off one lucky fill, and it would then set BOTH the incumbent's worst
// fold and the noise bar derived from it. Five is the floor the gate axis already used;
// stated once here rather than re-picked per axis.
const MIN_FOLD_CLOSED = 5;

/**
 * Normalise one candidate row from a walk-forward report into the shape searchAxis wants.
 *
 * Only the rsi-ceiling report publishes a `worstFold`. The param and rsi reports publish
 * per-fold rows and nothing else, so the worst fold is DERIVED here rather than assumed
 * present — reading an absent field would have made every margin null and every candidate
 * silently unpromotable, which on this report looks identical to "found nothing".
 */
function foldRows(summary, isBaseline) {
  const scored = (summary.perFold || []).filter(f =>
    Number.isFinite(f.rpt) && (f.closed == null || f.closed >= MIN_FOLD_CLOSED));
  const perFold = scored.map(f => f.rpt);
  return {
    worst: perFold.length ? Math.min(...perFold) : null,
    closed: summary.overall ? summary.overall.closed : null,
    foldsPositive: summary.foldsPositive,
    foldsScored: summary.foldsScored,
    perFold,
    isBaseline: !!isBaseline,
  };
}

/**
 * The four sweeps param_walkforward.cjs already owns, each as its own axis.
 *
 * TWO ARGUMENT TRAPS, both load-bearing:
 *   - param_walkforward resolves its project root as the first argv entry that does not
 *     start with "--". Passing only ["--param","minRr"] makes the root the string "minRr".
 *     ROOT is therefore passed explicitly as the first argument, which is also what
 *     rsi_walkforward reads from argv[2], so the same convention serves both.
 *   - the CLI name and the report key differ: --param adx writes params.adxTrendingMin,
 *     and --param trail writes params.trailGiveback. Both are named here rather than
 *     guessed from the flag.
 *
 * The second cut re-runs at FOUR folds instead of five. That is not a cosmetic variation:
 * it moves every fold boundary, and param_walkforward's own header calls it the cheapest
 * available test of whether an edge is real or was one lucky window.
 */
function paramAxis(label, cliName, reportKey, incumbent) {
  return {
    label,
    incumbent,
    cuts: [
      { name: "5-fold", args: [ROOT, "--param", cliName], env: {}, report: "param-walkforward-latest.json" },
      { name: "4-fold", args: [ROOT, "--param", cliName], env: { PARAM_WF_FOLDS: "4" }, report: "param-walkforward-latest.json" },
    ],
    harness: ["tasks/param_walkforward.cjs"],
    extract: report => {
      const table = (report.params || {})[reportKey] || {};
      const out = {};
      for (const [value, summary] of Object.entries(table)) {
        // params.minStrength carries an `equivalence` object beside its candidates. It is
        // a finding ABOUT the parameter, not a value OF it, and scoring it would invent a
        // challenger that does not exist. Anything without per-fold rows is not a
        // candidate, which rejects it without naming it and survives a new sibling key.
        if (!summary || !Array.isArray(summary.perFold)) continue;
        out[value] = foldRows(summary, summary.isBaseline);
      }
      return out;
    },
  };
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

  // The entry-RSI floor. Its incumbent is 0 — the gate is DISARMED in the shipped
  // config — so every candidate here is a proposal to arm something that is currently
  // off, which is a bigger claim than moving a live number and is judged the same way.
  // The report carries no isBaseline flag on any row, so the incumbent is named.
  rsi: {
    label: "entry RSI floor (minEntryRsi)",
    incumbent: "0",
    cuts: [
      { name: "equal-count", args: [ROOT], env: {}, report: "rsi-walkforward-latest.json" },
    ],
    harness: ["tasks/rsi_walkforward.cjs"],
    extract: report => {
      const out = {};
      for (const [value, summary] of Object.entries(report.candidates || {})) {
        if (!summary || !Array.isArray(summary.perFold)) continue;
        out[value] = foldRows(summary, String(value) === "0");
      }
      return out;
    },
  },

  minrr:       paramAxis("R:R floor (minRr)",                 "minRr",       "minRr",          "1.5"),
  adx:         paramAxis("trending ADX floor (adxTrendingMin)", "adx",       "adxTrendingMin", "20"),
  minstrength: paramAxis("strength floor (minStrength)",      "minStrength", "minStrength",    "MODERATE"),
  trail:       paramAxis("trailing give-back",                "trail",       "trailGiveback",  "off"),
};

// Validated against the table itself rather than a hand-kept list, because the two drifted
// apart the moment an axis was added and a searcher that refuses a real axis is worse than
// one that never had it.
if (AXIS !== "all" && !Object.prototype.hasOwnProperty.call(AXES, AXIS)) {
  console.error("strategy_search: --axis must be 'all' or one of: "
    + Object.keys(AXES).join(", ") + ". Refusing to guess.");
  process.exit(2);
}

function runCut(axis, cut) {
  const [script] = axis.harness;
  // cut.args is spread AFTER the script path, so a cut that declares none behaves exactly
  // as before this existed — the two original axes pass no arguments and are untouched.
  execFileSync(process.execPath, [path.join(ROOT, script), ...(cut.args || [])], {
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

// ── Are we even looking at new data? ─────────────────────────────────────────
//
// Every replay in this project reads tasks/history/*.csv, and NOTHING SCHEDULES A
// REFRESH of those files — export_mt5_history.py does it and is named only in a comment.
// On 2026-08-22 the newest cached bar was 2026-07-24, 29 days old.
//
// That matters more for a daily searcher than for a one-off harness: re-testing the same
// bars every night produces the same answers while the ledger's candidate count climbs,
// which makes the multiplicity warning MORE alarming without any new evidence behind it.
// A searcher that cannot tell "I looked again" from "I looked at something new" is
// counting its own repetitions as work.
//
// Deliberately DETECT-ONLY. Refreshing means running export_mt5_history.py, which opens a
// second MT5 python client, and a duplicate can break the IPC port the live bridge needs.
// Risking the bridge on the box that trades, unattended at 05:00, to freshen a backtest
// is the wrong trade. Report it and let a human refresh at a safe moment.
function barsFingerprint() {
  const dir = path.join(ROOT, "tasks", "history");
  const perSymbol = {};
  let newest = null;
  for (const symbol of ["XAUUSD", "BTCUSD", "SP500"]) {
    const file = path.join(dir, symbol + "_D1.csv");
    if (!fs.existsSync(file)) { perSymbol[symbol] = null; continue; }
    const lines = fs.readFileSync(file, "utf8").trim()
      .replace(/\r/g, "")
      .split("\n");
    const last = lines[lines.length - 1];
    const stamp = Number(String(last).split(",")[0]);
    if (!Number.isFinite(stamp)) { perSymbol[symbol] = null; continue; }
    perSymbol[symbol] = stamp;
    if (newest === null || stamp > newest) newest = stamp;
  }
  return { newest, perSymbol };
}

/** The previous run's fingerprint, so "same bars as last time" is detectable. */
function previousFingerprint() {
  const prior = path.join(OUT_DIR, "strategy-search-latest.json");
  if (!fs.existsSync(prior)) return null;
  try {
    return (JSON.parse(fs.readFileSync(prior, "utf8")).bars || null);
  } catch (err) {
    return null;   // an unreadable prior report is not a reason to fail the run
  }
}

function appendLedger(rows) {
  const lines = rows.map(r => JSON.stringify(r)).join("\n") + "\n";
  fs.appendFileSync(LEDGER, lines);
}

function ledgerCount() {
  if (!fs.existsSync(LEDGER)) return 0;
  return fs.readFileSync(LEDGER, "utf8").split("\n").filter(Boolean).length;
}

/**
 * How many candidates have EVER been tested on one axis, from the ledger.
 *
 * Per axis, not the grand total, because the axis is the selection family: a gate
 * candidate is chosen from among other gate candidates, and charging it for every
 * trail candidate ever tried would inflate the bar with trials it never competed
 * against. The grand total is still reported separately - it is the right number
 * for "did this SEARCH find something", which is a different question from "did
 * this AXIS find something".
 *
 * A malformed ledger line is skipped rather than throwing: this feeds a safety
 * bar, and a bar that cannot be computed must fail SAFE (see deflatedBar, which
 * returns null and makes nothing promotable) rather than take the searcher down.
 */
function ledgerTrialsByAxis() {
  const byAxis = {};
  if (!fs.existsSync(LEDGER)) return byAxis;
  let raw;
  try {
    raw = fs.readFileSync(LEDGER, "utf8");
  } catch (e) {
    process.stderr.write("  ledger unreadable (" + e.message + ") - trial counts start at 0\n");
    return byAxis;
  }
  let skipped = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row.axis === "string") byAxis[row.axis] = (byAxis[row.axis] || 0) + 1;
      else skipped++;
    } catch (e) { skipped++; }
  }
  if (skipped) process.stderr.write("  ledger: " + skipped + " unparseable row(s) skipped\n");
  return byAxis;
}

// Read ONCE, before any axis runs, so every axis in an --axis all run is judged
// against the history that existed when the run started rather than against rows
// this same run appended a moment ago.
const PRIOR_TRIALS_BY_AXIS = ledgerTrialsByAxis();

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

  const standardError = noiseFloor(incumbent.perFold);
  const spread = foldSpread(incumbent.perFold);

  // MAKE THE TRIAL COUNT BIND. Until 2026-08-25 this searcher printed how many
  // candidates it had ever tested and then judged the next one against a fixed
  // one-standard-error bar. Disclosure without correction: search enough values
  // against the same bars and one beats the incumbent by a standard error through
  // luck alone, and the bar never noticed how many times you had asked.
  //
  // The candidates about to be scored are part of the same selection set as every
  // candidate tried on this axis before, so both count toward N.
  const candidateCount = Object.keys(firstCut).filter(k => k !== incumbentKey).length;
  const trials = (PRIOR_TRIALS_BY_AXIS[key] || 0) + candidateCount;
  const deflated = deflatedBar(standardError, trials);
  const floor = deflated ? deflated.bar : null;

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
    // What the bar was and WHY, recorded per row so a promotion can be audited
    // later against the trial count that applied at the moment it was made.
    standardError, trialsAtDecision: trials,
    deflationMultiple: deflated ? deflated.multiple : null,
    cuts: cutNames,
  })));

  return {
    axis: key, label: axis.label, incumbent: incumbentKey,
    standardError, trials, deflationMultiple: deflated ? deflated.multiple : null,
    incumbentWorst: incumbent.worst, noiseFloor: floor, foldSpread: spread,
    cuts: cutNames, candidates, promotable,
    // A single-cut axis is searched under a weaker standard, and every consumer of this
    // report is told so rather than having to notice the cuts array is short.
    standard: cutNames.length >= 3 ? "FULL — three independent cuts"
            : "WEAKER — only " + cutNames.length + " cut(s) available on this axis",
  };
}

const stamp = new Date().toISOString();
const bars = barsFingerprint();
const priorBars = previousFingerprint();
const barsUnchanged = !!(priorBars && priorBars.newest && bars.newest === priorBars.newest);
const barAgeDays = bars.newest
  ? Math.floor((Date.parse(stamp) / 1000 - bars.newest) / 86400) : null;
const keys = AXIS === "all" ? Object.keys(AXES) : [AXIS];

// Nothing has been run yet at this point, so this exits before spending any CPU.
// Exit 4 is its own code: 0 would read as "searched and found nothing", which is a
// different claim and the one that inflates the ledger.
if (SKIP_IF_STALE && barsUnchanged) {
  const age = barAgeDays === null ? "unknown" : barAgeDays + " days";
  console.log("STRATEGY SEARCH SKIPPED — " + stamp);
  console.log("  The newest cached D1 bar is unchanged since the last run (" + age + " old),");
  console.log("  so this round would re-test identical data and return identical answers");
  console.log("  while the candidate count climbed. Nothing was run and nothing was written.");
  console.log("  Bars refresh from tasks/refresh_bars_vps.bat, which runs hourly and acts on");
  console.log("  the first hour the book is flat. Re-run without --skip-if-bars-unchanged to");
  console.log("  force a round anyway.");
  process.exit(4);
}

const results = [];
const failures = {};

for (const key of keys) {
  try {
    results.push(searchAxis(key, stamp));
  } catch (err) {
    failures[key] = String(err.message || err).slice(0, 300);
    process.stderr.write("  " + key + ": FAILED — " + failures[key] + "\n");
  }
  // Persist what has finished. A kill at the ceiling now costs only the axes still
  // running, never the ones already done.
  //
  // Wrapped: a fault in rendering must never kill a search that is working.
  try {
    renderAndWriteReport({ partial: true });
  } catch (e) {
    process.stderr.write("  partial report failed, run continues: " + e.message + "\n");
  }
}

// Render and persist the report from whatever has completed so far.
//
// Called after EVERY axis, not just at the end. The report used to be written once,
// so a kill at the ExecutionTimeLimit discarded every axis that had already finished.
// The ledger survived - it is appended per axis - but the readable report did not,
// and PT2H runs were dying about three minutes from the end with nothing to show.
//
// A hoisted function declaration, so the axis loop above can call it despite sitting
// textually earlier. The body is the original end-of-run code, wrapped verbatim.
function renderAndWriteReport(opts) {
  const partial = !!(opts && opts.partial);
const testedToDate = ledgerCount();
const allPromotable = results.flatMap(r => r.promotable.map(c => ({ axis: r.axis, ...c })));

const lines = [];
lines.push("=".repeat(100));
lines.push("  STRATEGY SEARCH — " + stamp);
  if (partial) {
    lines.push("  PARTIAL - " + results.length + " of " + keys.length + " axes finished so far.");
    lines.push("  Rewritten after every axis, so a scheduler kill cannot throw away work");
    lines.push("  that was already done. A finished run replaces this with the full report.");
  }
lines.push("  proposes, never applies. A challenger must beat the incumbent under EVERY cut,");
lines.push("  by more than the incumbent's own fold-to-fold spread.");
lines.push("=".repeat(100));
for (const r of results) {
  lines.push("");
  lines.push("  AXIS: " + r.label + "   incumbent " + r.incumbent
    + "  worst " + (r.incumbentWorst == null ? "—" : r.incumbentWorst.toFixed(3))
    + "   bar " + (r.noiseFloor == null ? "unknown" : r.noiseFloor.toFixed(3)));
  // Show the correction rather than just its result. A reader who cannot see that
  // the bar moved cannot tell a tightened test from a lucky quiet axis.
  lines.push("    bar = " + (r.standardError == null ? "?" : r.standardError.toFixed(3))
    + " SE x " + (r.deflationMultiple == null ? "?" : r.deflationMultiple.toFixed(2))
    + "  (deflated for " + r.trials + " trial(s) on this axis; fold spread "
    + (r.foldSpread == null ? "—" : r.foldSpread.toFixed(3)) + ")");
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
lines.push("  bars: newest cached D1 " + (bars.newest
  ? new Date(bars.newest * 1000).toISOString().slice(0, 10) : "unknown")
  + (barAgeDays === null ? "" : "  (" + barAgeDays + " days old)")
  + (barsUnchanged ? "   << SAME BARS AS THE LAST RUN" : ""));
if (barsUnchanged) {
  lines.push("  This round re-tested IDENTICAL DATA. Its result carries no new evidence and");
  lines.push("  the candidate count below grew without the sample growing. Refresh with");
  lines.push("  python tasks/export_mt5_history.py on a box whose MT5 is logged in - and not");
  lines.push("  while a bridge is mid-trade, because it opens a second MT5 client.");
}
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

fs.mkdirSync(OUT_DIR, { recursive: true });
const report = {
  generatedAt: stamp, axes: keys, dryRun: DRY_RUN,
  // partial:true means the run was still going when this was written. Without it a
  // reader cannot tell an interrupted run from one that genuinely found nothing.
  partial,
  axesPlanned: keys,
  axesCompleted: results.map(r => r.axis),
  bars, barsUnchanged, barAgeDays,
  testedToDate, results, failures,
  promotable: allPromotable,
  changesNothing: "writes a report and a ledger row; never a setting, a gate or a threshold",
};
fs.writeFileSync(path.join(OUT_DIR, "strategy-search-latest.json"), JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(OUT_DIR, "strategy-search-latest.txt"), text + "\n");
  return { text, testedToDate };
}

const finalReport = renderAndWriteReport({ partial: false });
console.log(finalReport.text);
process.stderr.write("\n  written -> tasks/analysis/strategy-search-latest.{json,txt}\n");
process.stderr.write("  ledger   -> tasks/strategy_search_ledger.jsonl (" + finalReport.testedToDate + " rows)\n");

// Exit 0 whether or not anything was found: "no challenger" is a successful run, and a
// non-zero exit would train the scheduler's watcher to treat the normal case as a fault.
process.exit(Object.keys(failures).length ? 1 : 0);
