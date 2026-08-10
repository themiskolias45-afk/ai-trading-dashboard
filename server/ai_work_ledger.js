'use strict';
/**
 * The AI employee's timesheet and appraisal.
 *
 * Scheduled agents run every day and nobody can see whether they worked, whether
 * they succeeded, or whether anything they produced was ever read. Two facts
 * found on 2026-08-09 that this exists to make impossible:
 *
 *   - "SmartEntry - Weekly Algo Review" returned exit code 1 that morning and
 *     nothing surfaced it. The run produced zero output and looked identical to
 *     a quiet week.
 *   - tasks/auto_weekly.bat instructs the model to mark its recommendation
 *     "PROPOSED FIX: so it can be found later". Three of them are sitting in
 *     logs. Nothing has ever looked for them.
 *
 * This is the same pattern that turned the trading gates from opinion into
 * evidence: log the decision, score it, publish a verdict. An employee you
 * cannot appraise is not an employee.
 *
 * READ-ONLY over files that already exist. It runs no job, spawns no agent,
 * spends no tokens, and writes nothing. Decisions are recorded out-of-band by
 * tasks/ai_decide.cjs so the server keeps no write path.
 */

const fs   = require("fs");
const path = require("path");

const ROOT      = path.join(__dirname, "..");
const LOGS_DIR  = path.join(ROOT, "tasks", "logs");
const DECISIONS = path.join(ROOT, "tasks", "ai_decisions.jsonl");

// A run older than this is stale for a job that is supposed to be daily.
const DAILY_STALE_HOURS  = 36;
const WEEKLY_STALE_HOURS = 24 * 9;

// Declared rather than discovered: a job that stops producing files must show as
// MISSING, and you cannot notice the absence of something you never declared.
// `task` was a hardcoded NAME and nothing ever read it — the same decoration
// problem as a setting with no reader. The two boxes name the same job differently
// ("SmartEntry - Weekly Algo Review" here, "SmartEntryWeeklyReview" on the VPS) and
// run different scripts (auto_weekly.bat vs auto_weekly_vps.bat), so a name could
// never have matched both. `taskMatch` links a job to whichever scheduled task
// actually RUNS its script, which is true on either machine.
const JOBS = [
  {
    id: "daily",
    label: "Daily Check",
    task: "SmartEntry - Daily Check",
    script: "tasks/auto_daily.bat",
    taskMatch: /auto_daily(_vps)?\.bat/i,
    pattern: /^daily_(\d{8})\.txt$/,
    cadenceHours: DAILY_STALE_HOURS,
    markers: ["SIGNAL READY", "PROPOSED FIX:"],
  },
  {
    id: "weekly",
    label: "Weekly Algo Review",
    task: "SmartEntry - Weekly Algo Review",
    script: "tasks/auto_weekly.bat",
    taskMatch: /auto_weekly(_vps)?\.bat/i,
    pattern: /^weekly_(\d{8})(_review)?\.txt$/,
    cadenceHours: WEEKLY_STALE_HOURS,
    markers: ["PROPOSED FIX:"],
  },
  {
    id: "agentdrain",
    label: "Agent Queue Drain",
    task: "SmartEntryAgentDrain",
    script: "tasks/drain_agents.bat",
    taskMatch: /drain_agents\.bat/i,
    pattern: /^agent_drain\.txt$/,
    cadenceHours: DAILY_STALE_HOURS,
    markers: [],
  },
];

// Windows scheduler result codes worth naming. Anything else is shown raw rather
// than guessed at.
const TASK_RESULT_MEANING = {
  0:      "success",
  1:      "generic failure",
  267009: "currently running",
  267011: "has never run",
  267014: "terminated by user",
};

function describeTaskResult(code) {
  if (code === null || code === undefined) return "unknown";
  return TASK_RESULT_MEANING[code] ? `${code} (${TASK_RESULT_MEANING[code]})` : String(code);
}

/**
 * A result the scheduler itself considers a failure. Running and never-run are not.
 *
 * A DISABLED task is never failing, whatever its last result says. SmartEntryBridgeB
 * is disabled deliberately — that box holds one broker account and a second bridge
 * would double every trade — and its last recorded result is 267014, "terminated by
 * user", from the day it was switched off. Reporting that as FAILING would put a
 * permanent red row in a list whose whole purpose is that a red row means something.
 */
function taskResultIsFailure(code, state) {
  if (String(state || "").toLowerCase() === "disabled") return false;
  return code !== null && code !== undefined && code !== 0 && code !== 267009 && code !== 267011;
}

function safeRead(file) {
  try { return fs.readFileSync(file, "utf8"); } catch (e) { return null; }
}

function listLogs() {
  try { return fs.readdirSync(LOGS_DIR); } catch (e) { return []; }
}

/**
 * The bat files end with `echo [exit %CLAUDE_RC%]`, so the model's own exit code
 * is in the artifact. Absent means the run did not reach the end — killed, or
 * still going.
 */
function exitCodeFrom(text) {
  const matches = [...text.matchAll(/\[exit (\d+)\]/g)];
  if (!matches.length) return null;
  return Number(matches[matches.length - 1][1]);
}

/** Stable enough to survive re-reads: job + file + line + the text itself. */
function proposalId(jobId, file, line, text) {
  let hash = 0;
  const key = jobId + "|" + file + "|" + line + "|" + text.slice(0, 80);
  for (let i = 0; i < key.length; i++) { hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0; }
  return jobId + "-" + Math.abs(hash).toString(36);
}

function readDecisions() {
  const text = safeRead(DECISIONS);
  if (!text) return {};
  const out = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed);
      // Last write wins, so a decision can be revised by appending.
      if (row && row.id) out[row.id] = row;
    } catch (e) { /* skip malformed */ }
  }
  return out;
}

/**
 * Everything the scheduler runs that nobody appraises.
 *
 * The ledger declared three jobs and reported on their log files. The box that
 * trades runs seventeen SmartEntry tasks, so fourteen of them — including one
 * returning rc=1 at the time this was written — were outside the appraisal
 * entirely. A job you never declared is a job whose failure is invisible, which is
 * the same reasoning that put the declared list here in the first place.
 */
function summariseUnappraised(scheduledTasks, linkedTaskNames) {
  return (scheduledTasks || [])
    .filter(task => !linkedTaskNames.has(task.name))
    .map(task => ({
      name: task.name,
      state: task.status || null,
      lastRun: task.lastRun || null,
      lastResult: task.lastResult ?? null,
      resultMeaning: describeTaskResult(task.lastResult),
      failing: taskResultIsFailure(task.lastResult, task.status),
      disabled: String(task.status || "").toLowerCase() === "disabled",
      runs: task.taskToRun || null,
    }))
    // Failures first: this list exists to surface them, not to be scrolled past.
    .sort((a, b) => (b.failing ? 1 : 0) - (a.failing ? 1 : 0) || a.name.localeCompare(b.name));
}

function build(options = {}) {
  const scheduledTasks = Array.isArray(options.scheduledTasks) ? options.scheduledTasks : null;
  const files = listLogs();
  const decisions = readDecisions();
  const now = Date.now();
  const jobs = [];
  const proposals = [];
  const linkedTaskNames = new Set();

  // Job -> the scheduled task that actually runs its script. Held in a Map rather
  // than written onto JOBS, which is exported and must not accumulate per-call state.
  const schedulerByJob = new Map();
  for (const job of JOBS) {
    const linkedTask = scheduledTasks
      ? scheduledTasks.find(task => job.taskMatch && job.taskMatch.test(task.taskToRun || "")) || null
      : null;
    if (linkedTask) linkedTaskNames.add(linkedTask.name);
    schedulerByJob.set(job.id, scheduledTasks
      ? (linkedTask
          ? {
              known: true, found: true,
              taskName: linkedTask.name,
              declaredName: job.task,
              nameMatchesDeclared: linkedTask.name === job.task,
              state: linkedTask.status || null,
              lastRun: linkedTask.lastRun || null,
              nextRun: linkedTask.nextRun || null,
              lastResult: linkedTask.lastResult ?? null,
              resultMeaning: describeTaskResult(linkedTask.lastResult),
              failing: taskResultIsFailure(linkedTask.lastResult, linkedTask.status),
              runs: linkedTask.taskToRun || null,
            }
          : { known: true, found: false, declaredName: job.task })
      : { known: false });
  }

  for (const job of JOBS) {
    const scheduler = schedulerByJob.get(job.id);
    const matched = files.filter(f => job.pattern.test(f)).map(name => {
      const full = path.join(LOGS_DIR, name);
      let stat = null;
      try { stat = fs.statSync(full); } catch (e) { return null; }
      return { name, full, mtime: stat.mtimeMs, size: stat.size };
    }).filter(Boolean).sort((a, b) => b.mtime - a.mtime);

    if (!matched.length) {
      jobs.push({
        id: job.id, label: job.label, task: job.task, script: job.script, scheduler,
        runs: 0, lastRun: null, ageHours: null, lastExit: null,
        verdict: scheduler.known && !scheduler.found ? "NO SCHEDULED TASK" : "NEVER PRODUCED OUTPUT",
        detail: scheduler.known && !scheduler.found
          ? "nothing in the Windows scheduler runs this job's script, and no log file matches it either — this job cannot run on this machine"
          : "no file in tasks/logs matches this job's pattern",
        proposals: 0, proposalsDecided: 0,
      });
      continue;
    }

    const newest = matched[0];
    const text = safeRead(newest.full) || "";
    const exit = exitCodeFrom(text);
    const ageHours = (now - newest.mtime) / 3600000;

    // Markers the job itself was told to emit.
    const markerCounts = {};
    for (const marker of job.markers) {
      markerCounts[marker] = (text.match(new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
    }

    // Harvest proposals across ALL of this job's files, not just the newest —
    // an unread recommendation does not stop mattering because a week passed.
    let jobProposals = 0, jobDecided = 0, everWroteMarker = false;
    for (const file of matched.slice(0, 30)) {
      const body = safeRead(file.full);
      if (!body) continue;
      if (body.indexOf("[exit ") !== -1) everWroteMarker = true;
      const lines = body.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].indexOf("PROPOSED FIX:") === -1) continue;
        const raw = lines[i].trim();
        const id = proposalId(job.id, file.name, i + 1, raw);
        const decision = decisions[id] || null;
        jobProposals++;
        if (decision) jobDecided++;
        proposals.push({
          id, job: job.id, jobLabel: job.label,
          file: "tasks/logs/" + file.name, line: i + 1,
          text: raw.length > 300 ? raw.slice(0, 297) + "…" : raw,
          when: new Date(file.mtime).toISOString(),
          ageDays: Math.floor((now - file.mtime) / 86400000),
          status: decision ? decision.status : "UNREVIEWED",
          note: decision ? (decision.note || "") : "",
        });
      }
    }

    // Verdict, most consequential first. A job that runs and fails is worse than
    // one that is merely late; a job producing recommendations nobody reads is
    // the specific failure this ledger was built for.
    let verdict, detail;
    // The scheduler's own answer outranks anything inferred from a log file: it
    // knows whether the process finished and what it returned, and it is the only
    // source that can say the job has no task at all. Before this, a run that
    // returned rc=1 and a run that succeeded were indistinguishable here whenever
    // the marker was missing — and on the VPS the marker is ALWAYS missing, because
    // auto_weekly_vps.bat has no marker line and the ledger blamed auto_weekly.bat,
    // a script that box does not run.
    if (scheduler.known && !scheduler.found) {
      verdict = "NO SCHEDULED TASK";
      detail = `logs exist but nothing in the scheduler runs ${job.script} — the output below is from a job that can no longer fire`;
    } else if (scheduler.found && scheduler.failing) {
      verdict = "FAILING";
      detail = `the scheduler reports last result ${scheduler.resultMeaning} for task "${scheduler.taskName}"`
        + (scheduler.lastRun ? ` at ${scheduler.lastRun}` : "");
    } else if (exit !== null && exit !== 0) {
      verdict = "FAILING";
      detail = "last run exited " + exit + " — " + newest.name;
    } else if (ageHours > job.cadenceHours) {
      verdict = "STALE";
      detail = "last output " + Math.round(ageHours) + "h ago, expected within " + job.cadenceHours + "h";
    } else if (exit === null && everWroteMarker) {
      verdict = "INCOMPLETE";
      detail = "no [exit N] marker in " + newest.name + " — this run did not reach the end,"
        + " though earlier runs did";
    } else if (exit === null) {
      // Distinguish "this run was killed" from "this job has NEVER written a
      // marker". Until 2026-08-09 the bat files invoked claude (a .CMD) without
      // CALL, so control never returned and every line after it — including the
      // marker — was dead. Reporting those historical runs as INCOMPLETE would
      // blame the run for a script bug.
      verdict = "NO COMPLETION MARKER";
      // Name the script this machine ACTUALLY runs. Saying "auto_weekly.bat" on a
      // box whose task runs auto_weekly_vps.bat sends the reader to the wrong file,
      // and the wrong file already has the fix — which reads as the fix not working.
      const actualScript = scheduler.found && scheduler.runs ? scheduler.runs : job.script;
      detail = "no run of this job has ever written [exit N]"
        + (scheduler.found && scheduler.lastResult === 0
            ? ` — but the scheduler reports it succeeded (${scheduler.resultMeaning}), so the marker line is missing from ${actualScript}, not the run`
            : ` — completion cannot be confirmed; the runner is ${actualScript}`);
    } else if (jobProposals > 0 && jobDecided === 0) {
      verdict = "OUTPUT IGNORED";
      detail = jobProposals + " proposed fix(es) across " + matched.length
        + " run(s), none reviewed";
    } else {
      verdict = "HEALTHY";
      detail = "last run OK " + Math.round(ageHours) + "h ago"
        + (jobProposals ? ", " + jobDecided + "/" + jobProposals + " proposals reviewed" : "");
    }

    jobs.push({
      id: job.id, label: job.label, task: job.task, script: job.script, scheduler,
      runs: matched.length,
      lastRun: new Date(newest.mtime).toISOString(),
      ageHours: Number(ageHours.toFixed(1)),
      lastExit: exit,
      lastFile: "tasks/logs/" + newest.name,
      lastSizeBytes: newest.size,
      markers: markerCounts,
      proposals: jobProposals,
      proposalsDecided: jobDecided,
      verdict, detail,
    });
  }

  proposals.sort((a, b) => new Date(b.when) - new Date(a.when));

  const unreviewed = proposals.filter(p => p.status === "UNREVIEWED").length;
  const unappraised = scheduledTasks ? summariseUnappraised(scheduledTasks, linkedTaskNames) : [];
  return {
    available: true,
    jobs,
    proposals,
    // Every scheduled task this ledger does NOT appraise, failures first. Three
    // declared jobs against seventeen tasks on the box that trades meant fourteen
    // jobs whose failure nothing would ever have mentioned.
    unappraisedTasks: unappraised,
    schedulerRead: Boolean(scheduledTasks),
    totals: {
      jobs: jobs.length,
      failing: jobs.filter(j => j.verdict === "FAILING").length,
      stale: jobs.filter(j => j.verdict === "STALE").length,
      healthy: jobs.filter(j => j.verdict === "HEALTHY").length,
      noTask: jobs.filter(j => j.verdict === "NO SCHEDULED TASK").length,
      unappraisedTasks: unappraised.length,
      unappraisedFailing: unappraised.filter(t => t.failing).length,
      proposals: proposals.length,
      unreviewed,
      reviewed: proposals.length - unreviewed,
    },
    decisionsFile: "tasks/ai_decisions.jsonl",
    howToDecide: "node tasks/ai_decide.cjs <id> implemented|rejected|ignored [note]",
    feedsTheGate: false,
    note: "Read-only over files these jobs already write. Runs nothing, spawns "
      + "nothing, spends no tokens. A verdict of OUTPUT IGNORED means the agent is "
      + "working and nobody is reading it — which costs the same as it failing.",
    updatedAt: new Date().toISOString(),
  };
}

module.exports = { build, JOBS, proposalId, readDecisions, DECISIONS };
