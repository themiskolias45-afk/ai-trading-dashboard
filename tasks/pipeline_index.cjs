/* ============================================================================
   PIPELINE INDEX — every stage, and whether anything reads what it writes
   ============================================================================

   WHY THIS EXISTS

   This system's recurring failure is not a crash. It is a WRITER WITH NO READER:
   something produces evidence every day and nothing consumes it, so the gap is
   invisible for weeks. Four separate instances were found on 2026-08-29 alone:

     - the weekly review wrote deep analysis to a log nothing opened
     - parallel_analysis.py wrote a 542 KB report no page fetched
     - the VPS wrote near_misses.jsonl and stop_variants.jsonl and scored NEITHER
     - the deep plan's alignment and record sat in the payload, rendered nowhere

   Each was found by hand. This finds them by construction: every pipeline is
   declared as ordered stages, each stage names its artifact, and the check that
   matters is whether a READER is older than the WRITER it depends on.

   THE DISTINCTION THAT STOPS FALSE ALARMS

   Some stages are CONTINUOUS (a cron writes them on a fixed cadence) and some are
   EVENT-DRIVEN (a row appears only when a setup dies on one condition, or a trade
   fills). This system takes about one fill every four days, so an event-driven
   artifact sitting still for 40 hours is the ordinary case, not a fault. Judging
   those two the same way produces an alarm that cries wolf — the thing this file
   is meant to prevent, not cause.

   Read-only over artifacts that already exist. Runs nothing, spawns nothing,
   writes one JSON. Touches no gate, no threshold, no signal and no order.

   Usage: node tasks/pipeline_index.cjs [--out <path>] [--json] [--quiet]
   ============================================================================ */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");

function opt(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const OUT = opt("--out", path.join(ROOT, "dashboard", "pipeline-latest.json"));
const QUIET = process.argv.includes("--quiet");
const AS_JSON = process.argv.includes("--json");

const HOUR = 3600000;

/* Every pipeline, as ordered stages.
     file        the artifact this stage produces
     by          what writes it
     cadence     expected hours between writes; null = event-driven
     event       true when rows appear only on a real trading event
     consumedBy  the next stage, named so a dead end is visible as a dead end
   Stage order is dependency order: stage N+1 reads what stage N wrote. */
const PIPELINES = [
  {
    id: "rejection", label: "Rejection ledger",
    what: "Every gate kill, walked forward on real broker bars to ask whether the gate SHOULD have fired.",
    stages: [
      { name: "rejections written",  file: "tasks/rejections.jsonl",        by: "server/rejection_log.js", cadence: 6,  consumedBy: "score_rr_rejections.py" },
      { name: "forward-scored",      file: "tasks/rejections_scored.jsonl", by: "tasks/score_rr_rejections.py", cadence: 24, consumedBy: "learning_from_rejections.py" },
      { name: "shadow book",         file: "server/learning_shadow.json",   by: "tasks/learning_from_rejections.py", cadence: 24, consumedBy: "/api/learning, the deep plan" },
    ],
  },
  {
    id: "nearmiss", label: "Near-miss census",
    what: "Setups that died on exactly ONE condition, with the margin. Prices the RSI ceiling, the only blocker with no rejection-ledger row.",
    stages: [
      { name: "near-misses written", file: "tasks/near_misses.jsonl",        by: "server/near_miss.js", cadence: null, event: true, consumedBy: "score_near_misses.cjs" },
      { name: "forward-scored",      file: "tasks/logs/near_miss_scores.txt", by: "tasks/score_near_misses.cjs", cadence: 24, consumedBy: "read by a human" },
    ],
  },
  {
    id: "stopvar", label: "Stop variants",
    what: "Prices the stop TIMEFRAME against the baseline the engine actually traded. The BB_SQUEEZE_WATCH loss came from a 0.63 ATR stop; this is how that question gets settled.",
    stages: [
      { name: "variants written",  file: "tasks/stop_variants.jsonl",         by: "the engine, on a fill", cadence: null, event: true, consumedBy: "score_stop_variants.cjs" },
      { name: "forward-scored",    file: "tasks/logs/stop_variant_scores.txt", by: "tasks/score_stop_variants.cjs", cadence: 24, consumedBy: "read by a human" },
    ],
  },
  {
    id: "learning", label: "Learning table",
    what: "Closed fills attributed to their setup. The calibration record — and the only one built from real money.",
    stages: [
      { name: "journal",       file: "server/journal.json",  by: "the bridge, on a fill", cadence: null, event: true, consumedBy: "updateLearning()" },
      { name: "learning table", file: "server/learning.json", by: "server updateLearning()", cadence: 24, consumedBy: "/api/learning, the gate boost" },
    ],
  },
  {
    id: "deepplan", label: "Pre-open & deep plan",
    what: "The trading document for the day ahead: the clock with blackouts, the level ladder, the cohort each setup lands in.",
    stages: [
      { name: "next-candle read", file: "tasks/analysis/candle-today.json",    by: "tasks/candle_probability.cjs", cadence: 24, consumedBy: "the deep plan" },
      { name: "deep plan",        file: "tasks/analysis/deep-plan-latest.json", by: "tasks/deep_plan.cjs", cadence: 24, consumedBy: "/api/deep-plan, the overview panel" },
    ],
  },
  {
    id: "analysis", label: "Deep analysis",
    what: "Six replays feed one fact pack, five analysts read it in parallel, a synthesiser merges them.",
    stages: [
      { name: "fact pack + analysts", file: "tasks/analysis/latest.json",       by: "parallel_analysis.py (VPS, 01:00)", cadence: 24, consumedBy: "analysis_index.cjs" },
      { name: "page index",           file: "dashboard/analysis-latest.json",   by: "tasks/analysis_index.cjs", cadence: 24, consumedBy: "/dashboard/analysis.html" },
    ],
  },
  {
    id: "weekly", label: "Weekly review",
    what: "The deepest analysis this system produces: it scores its own past calls and ranks assets in R rather than lot-weighted dollars.",
    stages: [
      { name: "review written", file: "tasks/logs/weekly_latest_marker",   by: "auto_weekly{,_vps}.bat (Sunday)", cadence: 24 * 8, glob: /^weekly_\d{8}(_review)?\.txt$/, globDir: "tasks/logs", consumedBy: "weekly_report_index.cjs" },
      { name: "page index",     file: "dashboard/weekly-latest.json",       by: "tasks/weekly_report_index.cjs", cadence: 24 * 8, consumedBy: "/dashboard/weekly.html" },
    ],
  },
  {
    id: "auth", label: "Agent auth",
    what: "Whether the CLI agents can still sign in. The subscription OAuth expired once and nothing watched for it.",
    stages: [
      { name: "auth state", file: "dashboard/agent-auth.json", by: "tasks/agent_auth_check.cjs", cadence: 24, consumedBy: "/dashboard/fleet.html, the work ledger" },
    ],
  },
  {
    id: "drift", label: "Config drift",
    what: "Places that state a live setting as a number and are now wrong.",
    stages: [
      { name: "drift report", file: "tasks/analysis/config-drift-latest.txt", by: "tasks/config_drift.cjs", cadence: 24, consumedBy: "read by a human" },
    ],
  },
];

/** Newest file matching a pattern, for stages whose artifact is dated. */
function newestMatching(dir, re) {
  try {
    const full = path.join(ROOT, dir);
    const hits = fs.readdirSync(full).filter(n => re.test(n))
      .map(n => ({ n, at: fs.statSync(path.join(full, n)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    return hits.length ? path.join(dir, hits[0].n).replace(/\\/g, "/") : null;
  } catch (e) { return null; }
}

/** Rows in a .jsonl, so "growing" can be distinguished from "rewritten". */
function countRows(fullPath) {
  try {
    if (!/\.jsonl$/.test(fullPath)) return null;
    const raw = fs.readFileSync(fullPath, "utf8");
    return raw.split(/\r?\n/).filter(l => l.trim()).length;
  } catch (e) { return null; }
}

function inspect(stage) {
  let rel = stage.file;
  if (stage.glob) {
    const found = newestMatching(stage.globDir, stage.glob);
    rel = found || stage.file;
  }
  const full = path.join(ROOT, rel);
  const out = {
    name: stage.name, file: rel, by: stage.by, consumedBy: stage.consumedBy,
    cadenceHours: stage.cadence, eventDriven: !!stage.event,
    present: false, bytes: null, rows: null, modified: null, ageHours: null,
  };
  try {
    const st = fs.statSync(full);
    out.present = true;
    out.bytes = st.size;
    out.rows = countRows(full);
    out.modified = st.mtime.toISOString();
    out.ageHours = +(((Date.now() - st.mtimeMs) / HOUR).toFixed(1));
  } catch (e) { /* absent — reported as such, never guessed */ }
  return out;
}

function build() {
  const pipelines = PIPELINES.map(p => {
    const stages = p.stages.map(inspect);
    const findings = [];

    stages.forEach((s, i) => {
      if (!s.present) {
        findings.push({ level: "RED", stage: s.name,
          detail: `${s.file} does not exist. ${s.by} has never produced it on this box, `
                + `so ${s.consumedBy} has nothing to read.` });
        return;
      }
      /* THE CHECK THIS FILE EXISTS FOR: a reader older than the writer it depends on.
       *
       * BUT ONLY WHEN THE READER HAS ALSO MISSED ITS OWN CADENCE. A nightly scorer
       * sitting behind a continuously-growing ledger is the NORMAL state for the
       * other 23 hours of the day — flagging that would fire every single day and
       * train you to skim past it, which is precisely the failure this file was
       * written to prevent rather than reproduce. Caught on the first run: it
       * raised AMBER on the rejection ledger for 38 unscored intra-day rows, which
       * is the pipeline working exactly as designed.
       *
       * A reader that is behind AND overdue is the real signal, and that is what
       * this now reports. */
      const prev = stages[i - 1];
      const overdue = !s.eventDriven && s.cadenceHours && s.ageHours > s.cadenceHours;
      if (prev && prev.present && s.ageHours !== null && prev.ageHours !== null
          && s.ageHours > prev.ageHours + 1 && overdue) {
        findings.push({ level: "AMBER", stage: s.name,
          detail: `Written ${s.ageHours}h ago from input last changed ${prev.ageHours}h ago, `
                + `and past its own ${s.cadenceHours}h cadence — it has not consumed the newest `
                + `"${prev.name}" and is overdue, so ${s.by} has missed a run.` });
      }
      // Recorded either way, so the lag is VISIBLE on the page without being an alarm.
      if (prev && prev.present && s.present && s.ageHours !== null && prev.ageHours !== null) {
        s.behindInputHours = +(s.ageHours - prev.ageHours).toFixed(1);
        s.behindInput = s.behindInputHours > 1;
      }
      // Cadence, and ONLY for continuous stages. An event-driven artifact sitting
      // still is the ordinary state of a system that fills once every four days.
      if (!s.eventDriven && s.cadenceHours && s.ageHours > s.cadenceHours * 1.5) {
        findings.push({ level: "AMBER", stage: s.name,
          detail: `${s.ageHours}h old against a ${s.cadenceHours}h cadence — ${s.by} has missed a run.` });
      }
    });

    const level = findings.some(f => f.level === "RED") ? "RED"
                : findings.length ? "AMBER" : "OK";
    return Object.assign({}, p, { stages, findings, level });
  });

  const totals = pipelines.reduce((acc, p) => {
    acc[p.level] = (acc[p.level] || 0) + 1;
    acc.stages += p.stages.length;
    acc.missing += p.stages.filter(s => !s.present).length;
    return acc;
  }, { OK: 0, AMBER: 0, RED: 0, stages: 0, missing: 0 });

  return {
    generatedAt: new Date().toISOString(),
    box: os.hostname(),
    pipelines,
    totals,
    note: "A stage marked EVENT-DRIVEN is written only when a real trading event occurs. "
        + "This system fills about once every four days, so a still artifact there is the "
        + "ordinary case and is NOT aged against a cadence. Only continuous stages are.",
    feedsTheGate: false,
  };
}

const index = build();
try {
  fs.writeFileSync(OUT, JSON.stringify(index, null, 2));
} catch (e) {
  if (!QUIET) console.error(`[pipeline-index] could not write: ${e.message}`);
  process.exit(1);
}

if (AS_JSON) {
  console.log(JSON.stringify(index, null, 2));
} else if (!QUIET) {
  console.log(`[pipeline-index] ${index.pipelines.length} pipeline(s), ${index.totals.stages} stage(s) — `
    + `${index.totals.OK} ok, ${index.totals.AMBER} amber, ${index.totals.RED} red`
    + (index.totals.missing ? `, ${index.totals.missing} artifact(s) absent` : ""));
  for (const p of index.pipelines) {
    if (p.level === "OK") continue;
    console.log(`  [${p.level}] ${p.label}`);
    p.findings.forEach(f => console.log(`      ${f.level} ${f.stage}: ${f.detail}`));
  }
  console.log(`[pipeline-index] wrote ${path.relative(ROOT, OUT)}`);
}
process.exit(0);
