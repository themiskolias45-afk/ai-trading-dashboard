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
const JOBS = [
  {
    id: "daily",
    label: "Daily Check",
    task: "SmartEntry - Daily Check",
    script: "tasks/auto_daily.bat",
    pattern: /^daily_(\d{8})\.txt$/,
    cadenceHours: DAILY_STALE_HOURS,
    markers: ["SIGNAL READY", "PROPOSED FIX:"],
  },
  {
    id: "weekly",
    label: "Weekly Algo Review",
    task: "SmartEntry - Weekly Algo Review",
    script: "tasks/auto_weekly.bat",
    pattern: /^weekly_(\d{8})(_review)?\.txt$/,
    cadenceHours: WEEKLY_STALE_HOURS,
    markers: ["PROPOSED FIX:"],
  },
  {
    id: "agentdrain",
    label: "Agent Queue Drain",
    task: "SmartEntryAgentDrain",
    script: "tasks/drain_agents.bat",
    pattern: /^agent_drain\.txt$/,
    cadenceHours: DAILY_STALE_HOURS,
    markers: [],
  },
];

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

function build() {
  const files = listLogs();
  const decisions = readDecisions();
  const now = Date.now();
  const jobs = [];
  const proposals = [];

  for (const job of JOBS) {
    const matched = files.filter(f => job.pattern.test(f)).map(name => {
      const full = path.join(LOGS_DIR, name);
      let stat = null;
      try { stat = fs.statSync(full); } catch (e) { return null; }
      return { name, full, mtime: stat.mtimeMs, size: stat.size };
    }).filter(Boolean).sort((a, b) => b.mtime - a.mtime);

    if (!matched.length) {
      jobs.push({
        id: job.id, label: job.label, task: job.task, script: job.script,
        runs: 0, lastRun: null, ageHours: null, lastExit: null,
        verdict: "NEVER PRODUCED OUTPUT",
        detail: "no file in tasks/logs matches this job's pattern",
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
    if (exit !== null && exit !== 0) {
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
      detail = "no run of this job has ever written [exit N] — pre-dates the CALL fix"
        + " in " + job.script + ", so completion cannot be confirmed for past runs";
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
      id: job.id, label: job.label, task: job.task, script: job.script,
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
  return {
    available: true,
    jobs,
    proposals,
    totals: {
      jobs: jobs.length,
      failing: jobs.filter(j => j.verdict === "FAILING").length,
      stale: jobs.filter(j => j.verdict === "STALE").length,
      healthy: jobs.filter(j => j.verdict === "HEALTHY").length,
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
