'use strict';
/**
 * BACKTEST HEALTH — a heatmap of what each measurement harness in this project
 * protects itself against, and what it does not.
 *
 * WHY THIS EXISTS. Every threshold this system ships was set by one of these harnesses,
 * so a defect in a harness is a defect in the live engine one step removed. Two have
 * already produced wrong answers here and both were caught by accident rather than by a
 * check: an uncapped R:R of 298.6 inverted the sign of a 498-episode rejection ledger,
 * and the first RSI-ceiling sweep reported 64/60 as a +63.5R challenger when one row
 * with rr 49.71 supplied +39.7R of it. Nothing in this repo asked "which OTHER harness
 * has the same hole?" — this does.
 *
 * IT IS STATIC ANALYSIS, AND THAT IS A LIMIT. It reads source and looks for the
 * safeguard, so it answers "is the guard present", never "is the guard correct". A
 * harness can pass every column here and still be wrong. It cannot fail a column and be
 * safe, which is what makes it worth running.
 *
 * IT CHANGES NOTHING. Reads source files, writes one report. No harness is executed, no
 * setting is read, nothing on the signal path is touched.
 *
 * Usage: node tasks/backtest_health.cjs [proj-root]
 */

const fs = require("fs");
const path = require("path");

const ROOT = process.argv[2] || path.join(__dirname, "..");
const TASKS = path.join(ROOT, "tasks");
const OUT_DIR = path.join(ROOT, "tasks", "analysis");

// The harnesses that produce a NUMBER a decision could rest on. A file that only
// replays (_replay_mtf, _replay_engine) is a dependency of these, not a judge, so it is
// deliberately not scored against columns written for judges.
const HARNESSES = [
  "mtf_walkforward.cjs",
  "rsi_ceiling_walkforward.cjs",
  "rsi_walkforward.cjs",
  "param_walkforward.cjs",
  "cohort_walkforward.cjs",
  "session_walkforward.cjs",
  "minrr_direction_walkforward.cjs",
  "crt_walkforward.cjs",
  "crt_as_setup_walkforward.cjs",
  "regime_xtab.cjs",
  "time_heatmap.cjs",
  "per_instrument_edge.cjs",
  "go_live_readiness.cjs",
];

// Each column is a safeguard THIS PROJECT has been burned by the absence of. The `why`
// is the incident, not a principle — a column with no incident behind it is a style
// preference and does not belong on a heatmap that ranks work.
const COLUMNS = [
  {
    key: "rrCap",
    label: "R:R cap",
    why: "An uncapped R:R lets one collapsed-stop row set the sign of a whole table. It "
       + "inverted the rejection ledger (+260.8R to -40.9R) and faked the first ceiling "
       + "sweep (64/60 at +63.5R, of which one row supplied +39.7R).",
    fix: "Cap the winning leg at the engine's own MAX_PLAUSIBLE_RR = 10, the same number "
       + "realizedRFromPrices refuses past.",
    // Recognises the shared guard (_rr_cap.cjs) as well as an inline one. A harness that
    // imports cappedRr is capped; requiring the literal constant name would mark the
    // shared fix as missing, which is how this column read right after it was applied.
    test: src => /MAX_PLAUSIBLE_RR|cappedRr|Math\.min\(\s*\w+\.rr\s*,/.test(src),
    appliesIf: src => /\.rr\b/.test(src),
  },
  {
    key: "worstFold",
    label: "worst-fold",
    why: "A mean rewards a candidate that is spectacular in one window and ruinous in "
       + "another. CLAUDE.md's argument for gate 70 is its worst fold, not its average.",
    fix: "Rank candidates on the worst SCORED fold and say so in the report.",
    test: src => /worstFold|worst fold|WORST FOLD/.test(src),
    appliesIf: src => /fold/i.test(src),
  },
  {
    key: "foldFloor",
    label: "thin-fold",
    why: "A fold with two closes is an absence, not a zero. Averaging it in either "
       + "direction invents evidence.",
    fix: "Declare a MIN_FOLD_CLOSES floor and exclude thin folds from the verdict rather "
       + "than scoring them.",
    // Tests the BEHAVIOUR, not the name. mtf_walkforward.cjs:133 filters on
    // `s.closed >= 5` with no named constant, and an earlier version of this column
    // looked only for the constant and marked the guard absent — a false RED on the
    // harness the live gate rests on. A magic number is a readability problem; calling
    // a present guard missing is a wrong answer, which is worse.
    test: src => /MIN_FOLD_CLOSES|minFoldCloses|MIN_CLOSED_PER_FOLD|closed\s*>=\s*\d+/.test(src),
    appliesIf: src => /fold/i.test(src),
  },
  {
    key: "foldGeometry",
    label: "2nd geom",
    why: "Equal-count folds can put a quiet year and a busy quarter in one window. The "
       + "ceiling sweep's three ROBUST 5/5 labels did not survive equal-TIME folds — they "
       + "described where the cuts fell, not the thresholds.",
    fix: "Offer equal-TIME as well as equal-count and compare the two before believing a "
       + "stability label.",
    test: src => /FOLD_MODE|equal-TIME|equalTime/.test(src),
    appliesIf: src => /fold/i.test(src),
  },
  {
    key: "spx",
    label: "SPX",
    why: "SP500 was silently absent from every replay until bf388ad — the harness reported "
       + "a clean table over two assets while claiming three.",
    fix: "Include SP500/^GSPC and assert its row count is non-zero before reporting.",
    test: src => /SP500|\^GSPC/.test(src),
    appliesIf: src => /XAUUSD|BTCUSD|GC=F/.test(src),
  },
  {
    key: "costDeclared",
    label: "cost",
    why: "A backtest with no cost is a screen, not a jury, and every verdict here is "
       + "quoted as if it were net.",
    fix: "Declare a cost per trade and carry it into the report's basis block.",
    test: src => /COST_R|costR/.test(src),
    appliesIf: () => true,
  },
  {
    key: "costPerAsset",
    label: "cost/asset",
    why: "Every harness uses a flat 0.05R for all three instruments. Risk distance spans "
       + "roughly 24x across them and BTC's live spread has been measured near 1700 points "
       + "against a 50-point cap, so one flat number cannot be right for all three.",
    fix: "Derive cost per trade from the instrument's spread over that trade's risk "
       + "distance, and report the range actually applied.",
    test: src => /costFor\(|perAssetCost|COST_BY_ASSET|spreadFor\(/.test(src),
    appliesIf: src => /COST_R|costR/.test(src),
  },
  {
    key: "stubs",
    label: "stubs",
    why: "The replay sandbox stubs DXY, VIX, Fear&Greed, the cross-asset cache and the "
       + "learning boost. A report that does not name them reads as a full-fidelity result.",
    fix: "Carry the stub list into the report's basis block.",
    test: src => /stubbed|stubs/.test(src),
    appliesIf: () => true,
  },
  {
    key: "baselineGuard",
    label: "empty guard",
    why: "A harness failure that prints an empty table reads exactly like a real result of "
       + "zero.",
    fix: "Exit non-zero with the per-asset errors when the baseline population is empty.",
    // Behaviour, not vocabulary — same lesson as the thin-fold column. mtf_walkforward
    // :83 and cohort_walkforward:158 both stop on an empty population without ever using
    // the word "refuse", and the first version of this column marked both as missing it.
    test: src => /refusing to report|REFUSING|refuses/i.test(src)
              || /length === 0|!\w+\.length|length\s*<\s*(FOLDS|\d+)/.test(src),
    appliesIf: () => true,
  },
  {
    key: "report",
    label: "report",
    why: "A number that exists only in a terminal cannot be compared against the next run.",
    fix: "Write {json,txt} to tasks/analysis and name the file in the run's output.",
    test: src => /writeFileSync/.test(src),
    appliesIf: () => true,
  },
];

function readHarness(file) {
  const full = path.join(TASKS, file);
  if (!fs.existsSync(full)) return null;
  return { file, src: fs.readFileSync(full, "utf8") };
}

const rows = [];
const missingFiles = [];
for (const file of HARNESSES) {
  const harness = readHarness(file);
  if (!harness) { missingFiles.push(file); continue; }
  const cells = {};
  for (const col of COLUMNS) {
    if (!col.appliesIf(harness.src)) { cells[col.key] = "n/a"; continue; }
    cells[col.key] = col.test(harness.src) ? "pass" : "fail";
  }
  const applicable = COLUMNS.filter(c => cells[c.key] !== "n/a");
  const failed = applicable.filter(c => cells[c.key] === "fail");
  rows.push({
    file,
    cells,
    passed: applicable.length - failed.length,
    applicable: applicable.length,
    failedKeys: failed.map(c => c.key),
    // A harness missing the R:R cap can report a wrong SIGN, which is a different class
    // of wrong from missing a nice-to-have. Severity follows the incident record.
    severity: failed.some(c => c.key === "rrCap") ? "HIGH"
            : failed.some(c => c.key === "worstFold" || c.key === "foldFloor") ? "MEDIUM"
            : failed.length ? "LOW" : "NONE",
  });
}

const columnTotals = {};
for (const col of COLUMNS) {
  const scored = rows.filter(r => r.cells[col.key] !== "n/a");
  columnTotals[col.key] = {
    label: col.label,
    pass: scored.filter(r => r.cells[col.key] === "pass").length,
    fail: scored.filter(r => r.cells[col.key] === "fail").length,
    why: col.why,
    fix: col.fix,
  };
}

const report = {
  generatedAt: new Date().toISOString(),
  method: "STATIC ANALYSIS — presence of a safeguard, never its correctness. A harness "
        + "can pass every column and still be wrong; it cannot fail one and be safe.",
  changesNothing: "reads source, writes one report, runs no harness and touches no setting",
  harnessCount: rows.length,
  missingFiles,
  columns: COLUMNS.map(c => ({ key: c.key, label: c.label, why: c.why, fix: c.fix })),
  columnTotals,
  harnesses: rows,
  worstFirst: [...rows].sort((a, b) =>
    (b.applicable - b.passed) - (a.applicable - a.passed) || a.file.localeCompare(b.file)),
};

const MARK = { pass: "+", fail: "X", "n/a": "." };
const lines = [];
lines.push("=".repeat(118));
lines.push("  BACKTEST HEALTH — " + rows.length + " harnesses x " + COLUMNS.length
  + " safeguards — " + report.generatedAt);
lines.push("  + present    X absent    . not applicable      STATIC: presence, not correctness");
lines.push("=".repeat(118));
lines.push("  " + "harness".padEnd(30) + COLUMNS.map(c => c.label.slice(0, 10).padStart(11)).join("") + "    score");
for (const r of report.worstFirst) {
  lines.push("  " + r.file.replace(".cjs", "").padEnd(30)
    + COLUMNS.map(c => MARK[r.cells[c.key]].padStart(11)).join("")
    + "    " + r.passed + "/" + r.applicable + (r.severity === "NONE" ? "" : "  [" + r.severity + "]"));
}
lines.push("");
lines.push("  WHERE THE HOLES ARE, worst column first:");
for (const [, total] of Object.entries(columnTotals).sort((a, b) => b[1].fail - a[1].fail)) {
  if (!total.fail) continue;
  lines.push("  " + total.fail + " of " + (total.fail + total.pass) + " missing  " + total.label);
  lines.push("      why: " + total.why);
  lines.push("      fix: " + total.fix);
}
if (missingFiles.length) lines.push("\n  NOT FOUND: " + missingFiles.join(", "));
lines.push("");
lines.push("  Static analysis. A passing column means the guard is present, not that it is");
lines.push("  right. Nothing here ran a harness, read a setting or touched the signal path.");
lines.push("=".repeat(118));

const text = lines.join("\n");
console.log(text);

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, "backtest-health-latest.json"), JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(OUT_DIR, "backtest-health-latest.txt"), text + "\n");
process.stderr.write("\n  written -> tasks/analysis/backtest-health-latest.{json,txt}\n");
