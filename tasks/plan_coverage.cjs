#!/usr/bin/env node
//
// Does the DAILY PLAN and the WEEKLY REVIEW actually exist, day after day?
//
//   node tasks/plan_coverage.cjs [--days 14] [--weeks 6] [--json]
//
// Exit 0 = today's daily plan is on disk.  Exit 1 = it is not.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
//
// Every surface in this project reported the daily plan as healthy while 43% of it
// was missing. Measured 2026-08-29: six of the previous fourteen days had no
// tasks/daily_plan_*.json at all (2026-08-16, -17, -20, -21, -23, -27) and not one
// board said so.
//
// The reason is precise and worth keeping. `tasks/coverage_audit.ps1` checks the
// SCHEDULED TASK — it reads `SmartEntry TV Daily Plan`'s last exit code. An exit code
// describes the most recent run that HAPPENED. It is structurally incapable of saying
// anything about a day on which nothing ran at all, which is exactly what a sleeping
// laptop produces. The task said GREEN, and the days were gone.
//
// That is the same failure as a supervisor's exit code standing in for the service's
// health, and the same failure as a marker written where nobody reads it. The fix in
// both cases is to check the ARTIFACT, not the runner.
//
// ── WHAT IT WILL AND WILL NOT CALL A FAULT ───────────────────────────────────
//
// Only ONE condition exits non-zero: today's plan is missing. That is the one a
// reader can act on and the one the server's catch-up is supposed to have already
// fixed, so if it is still absent something is genuinely wrong right now.
//
// Historical gaps are reported as INFO and never as a fault. They are unrecoverable —
// you cannot generate a plan for a day whose market data has moved on — and an alarm
// that can never clear trains the reader to skim past the one that matters. They are
// printed because the trend is the point: gaps closing means the catch-up is working.
//
// ── SAFETY ───────────────────────────────────────────────────────────────────
//
// Read-only. It opens no socket, spawns nothing, and writes nothing anywhere. It
// stats files and prints. It cannot block a signal, cannot touch learning, and has no
// path to the journal or to any config.

const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = path.join(__dirname, "..");
const TASKS_DIR = path.join(PROJECT_ROOT, "tasks");
const LOGS_DIR = path.join(TASKS_DIR, "logs");

// A weekly job may run a day late without anything being wrong — a box that is off on
// the scheduled day picks it up on the next one. Late is not missing until it is more
// than a full extra week, at which point a whole cycle has been skipped.
const WEEKLY_PERIOD_DAYS = 7;
const WEEKLY_GRACE_DAYS = 3;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function parseArgs(argv) {
  const options = { days: 14, weeks: 6, json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--json") options.json = true;
    else if (argv[i] === "--days") options.days = Number(argv[++i]) || options.days;
    else if (argv[i] === "--weeks") options.weeks = Number(argv[++i]) || options.weeks;
  }
  return options;
}

// UTC, because that is what tv_daily_plan.py names its file with
// (datetime.now(timezone.utc).strftime("%Y-%m-%d")). Deriving this from local time
// would look for a file the generator never writes, and on a box west of UTC would
// report today as missing every evening.
function utcDateString(daysAgo) {
  const when = new Date(Date.now() - daysAgo * MS_PER_DAY);
  return when.toISOString().slice(0, 10);
}

function readDailyCoverage(days) {
  const entries = [];
  for (let daysAgo = 0; daysAgo < days; daysAgo++) {
    const date = utcDateString(daysAgo);
    const file = path.join(TASKS_DIR, `daily_plan_${date}.json`);
    let present = false;
    let bytes = 0;
    let warnings = null;
    try {
      const stat = fs.statSync(file);
      present = true;
      bytes = stat.size;
      // A plan that exists but holds no assets is a different failure from a plan that
      // is absent, and reporting them the same way hides it. Parsed defensively: a
      // corrupt file must be reported, never thrown on.
      try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        warnings = Array.isArray(parsed.warnings) ? parsed.warnings.length : null;
      } catch (_) {
        warnings = "unparseable";
      }
    } catch (_) {
      present = false;
    }
    entries.push({ date, present, bytes, warnings });
  }
  return entries;
}

function readWeeklyCoverage(weeks) {
  let files = [];
  try {
    files = fs.readdirSync(LOGS_DIR)
      .filter((name) => /^weekly_\d{8}\.txt$/.test(name))
      .map((name) => {
        const stamp = name.slice(7, 15);            // weekly_YYYYMMDD.txt
        const year = Number(stamp.slice(0, 4));
        const month = Number(stamp.slice(4, 6));
        const day = Number(stamp.slice(6, 8));
        // One historical file is named weekly_20262607.txt — month 26, which is not a
        // date. Kept on disk (nothing here deletes) but excluded from the freshness
        // reading, because a nonsense date must not be allowed to answer "when did
        // this last run".
        const valid = month >= 1 && month <= 12 && day >= 1 && day <= 31;
        return { name, stamp, valid, at: valid ? Date.UTC(year, month - 1, day) : null };
      })
      .filter((entry) => entry.valid)
      .sort((a, b) => b.at - a.at);
  } catch (_) {
    files = [];
  }

  const newest = files[0] || null;
  const ageDays = newest ? Math.floor((Date.now() - newest.at) / MS_PER_DAY) : null;
  return {
    newest: newest ? newest.name : null,
    ageDays,
    overdue: ageDays === null || ageDays > WEEKLY_PERIOD_DAYS + WEEKLY_GRACE_DAYS,
    recent: files.slice(0, weeks).map((entry) => entry.name),
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const daily = readDailyCoverage(options.days);
  const weekly = readWeeklyCoverage(options.weeks);

  const today = daily[0];
  const missing = daily.filter((entry) => !entry.present).map((entry) => entry.date);
  const presentCount = daily.length - missing.length;
  const coveragePct = Math.round((presentCount / daily.length) * 100);
  const todayPresent = Boolean(today && today.present);

  if (options.json) {
    console.log(JSON.stringify({
      todayPresent,
      todayDate: today ? today.date : null,
      coveragePct,
      windowDays: options.days,
      presentCount,
      missing,
      weekly,
      feedsTheGate: false,
    }, null, 2));
    return todayPresent ? 0 : 1;
  }

  console.log("=".repeat(74));
  console.log("  PLAN COVERAGE — does the plan actually exist, day after day?");
  console.log("=".repeat(74));
  console.log("");
  console.log(`  DAILY PLAN — last ${options.days} days (UTC)`);
  console.log(`    today (${today ? today.date : "?"}): ${todayPresent ? "PRESENT" : "** ABSENT **"}`);
  console.log(`    coverage: ${presentCount}/${daily.length} days (${coveragePct}%)`);
  if (missing.length) {
    console.log(`    missing : ${missing.join(", ")}`);
    console.log("              history only — a plan cannot be generated for a past day,");
    console.log("              so these are reported and never alarmed on.");
  } else {
    console.log("    missing : none");
  }
  console.log("");
  console.log(`  WEEKLY REVIEW — tasks/logs/weekly_YYYYMMDD.txt`);
  if (weekly.newest) {
    console.log(`    newest  : ${weekly.newest} (${weekly.ageDays} days ago)`);
    console.log(`    status  : ${weekly.overdue
      ? `OVERDUE — more than ${WEEKLY_PERIOD_DAYS + WEEKLY_GRACE_DAYS} days, a full cycle has been skipped`
      : "on cadence"}`);
  } else {
    console.log("    newest  : none found");
  }
  console.log("");
  console.log("-".repeat(74));
  if (todayPresent) {
    console.log("  VERDICT: today's plan is on disk.");
  } else {
    console.log("  VERDICT: TODAY'S PLAN IS MISSING.");
    console.log("           The server catches this up on boot and every 30 minutes, so if");
    console.log("           it is still absent the generator itself is failing. Read");
    console.log("           tasks/logs/server_log.txt for a line starting '[plan]'.");
  }
  console.log("=".repeat(74));
  return todayPresent ? 0 : 1;
}

process.exitCode = main();
