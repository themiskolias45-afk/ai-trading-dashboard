#!/usr/bin/env node
'use strict';
/* ============================================================================
   lab_queue.cjs — the workbench asks; a scheduled drain answers
   ============================================================================

   WHY A QUEUE AT ALL, when a single run takes 0.3 seconds.

   Because the box this runs on is the box that trades, continuously, with real
   positions open. /api/robustness-report already carries the rule in a comment:
   a page request must never start CPU work on it. A single ema_cross run is
   cheap, but a grid is a hundred of them and a deeper strategy is not cheap at
   all, and the boundary between "fine" and "not fine" is exactly the kind of
   thing that gets crossed by accident six months from now when someone adds a
   slower strategy and nobody re-reads this comment.

   So the server NEVER runs a backtest. It appends a validated spec to a queue and
   returns. A scheduled drain does the work out of band. The rule is structural
   rather than a matter of judgement, which is the only kind that survives.

   THE QUEUE IS APPEND-ONLY, and entries are never removed — completion is a new
   line, not a deletion. A queue you can rewrite is a queue that loses the record
   of what was asked, and this project does not delete things.

   USAGE
     node tasks/lab_queue.cjs --drain            run everything pending
     node tasks/lab_queue.cjs --drain --max 20   bounded drain
     node tasks/lab_queue.cjs --status
     node tasks/lab_queue.cjs --enqueue '<spec json>'
     node tasks/lab_queue.cjs --selftest
   ========================================================================== */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const LAB_DIR = path.join(ROOT, 'tasks', 'analysis', 'lab');
const QUEUE = path.join(LAB_DIR, '_queue.jsonl');

// A drain of the whole queue must not run forever if someone enqueues a thousand
// cells. Bounded by default; the bound is stated in the output, never silent.
const DEFAULT_MAX = 200;

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch (e) { /* a torn line must not kill the read */ }
  }
  return out;
}

/**
 * Current state of every job, folded from the append-only log. The LAST record for
 * an id wins, so a DONE line supersedes its QUEUED line without either being erased.
 */
function state() {
  const byId = new Map();
  for (const row of readLines(QUEUE)) {
    if (row && row.id) byId.set(row.id, { ...(byId.get(row.id) || {}), ...row });
  }
  return [...byId.values()].sort((a, b) => String(a.queuedAt).localeCompare(String(b.queuedAt)));
}

function enqueue(spec, requestedBy) {
  fs.mkdirSync(LAB_DIR, { recursive: true });
  const row = {
    id: crypto.randomBytes(8).toString('hex'),
    status: 'QUEUED',
    queuedAt: new Date().toISOString(),
    requestedBy: requestedBy || 'unknown',
    spec,
  };
  fs.appendFileSync(QUEUE, JSON.stringify(row) + '\n');
  return row;
}

function append(update) {
  fs.appendFileSync(QUEUE, JSON.stringify(update) + '\n');
}

function drain(max) {
  // Required lazily and INSIDE the drain, never at module scope: the server requires
  // this file to enqueue, and it must not pull the whole strategy/бars stack into the
  // trading process just to append one line.
  const { runOne } = require(path.join(__dirname, 'lab_run.cjs'));
  const pending = state().filter(j => j.status === 'QUEUED');
  const limit = Math.min(pending.length, max || DEFAULT_MAX);
  const results = [];
  for (let i = 0; i < limit; i++) {
    const job = pending[i];
    const started = new Date().toISOString();
    try {
      const res = runOne(job.spec, {});
      append({ id: job.id, status: 'DONE', startedAt: started,
        finishedAt: new Date().toISOString(), name: res.name,
        verdict: res.report.assessment.verdict, trades: res.trades, trials: res.trials });
      results.push({ id: job.id, ok: true, name: res.name, verdict: res.report.assessment.verdict });
    } catch (e) {
      // A failed job is RECORDED, never dropped. A queue that silently loses a job
      // is indistinguishable from one that never received it.
      append({ id: job.id, status: 'FAILED', startedAt: started,
        finishedAt: new Date().toISOString(), error: String(e && e.message ? e.message : e) });
      results.push({ id: job.id, ok: false, error: String(e && e.message ? e.message : e) });
    }
  }
  return { ran: results.length, pendingBefore: pending.length, limit, results };
}

function selftest() {
  let failed = 0;
  const ok = (n, c, x) => { if (!c) { failed++; console.log('  FAIL  ' + n + (x ? '  ' + x : '')); } else console.log('  ok    ' + n); };
  // Folding is last-write-wins per id, and nothing is lost.
  const rows = [
    { id: 'a', status: 'QUEUED', queuedAt: '2026-01-01T00:00:00Z' },
    { id: 'b', status: 'QUEUED', queuedAt: '2026-01-02T00:00:00Z' },
    { id: 'a', status: 'DONE', name: 'x' },
  ];
  const byId = new Map();
  for (const row of rows) byId.set(row.id, { ...(byId.get(row.id) || {}), ...row });
  ok('a DONE line supersedes its QUEUED line', byId.get('a').status === 'DONE');
  ok('and keeps the original queuedAt', byId.get('a').queuedAt === '2026-01-01T00:00:00Z');
  ok('an untouched job stays QUEUED', byId.get('b').status === 'QUEUED');
  console.log('');
  console.log(failed === 0 ? '  ALL CHECKS PASSED' : '  ' + failed + ' CHECK(S) FAILED');
  return failed;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };

  if (argv.includes('--selftest')) process.exit(selftest() === 0 ? 0 : 1);

  if (argv.includes('--enqueue')) {
    const { validateSpec } = require(path.join(__dirname, 'lab_run.cjs'));
    let spec;
    try { spec = validateSpec(JSON.parse(opt('--enqueue', '{}'))); }
    catch (e) { console.error('rejected: ' + e.message); process.exit(2); }
    const row = enqueue(spec, 'cli');
    console.log('queued ' + row.id);
    process.exit(0);
  }

  if (argv.includes('--drain')) {
    const res = drain(Number(opt('--max', DEFAULT_MAX)));
    console.log('');
    console.log('  pending before: ' + res.pendingBefore + '   ran: ' + res.ran
      + (res.pendingBefore > res.limit ? '   (bounded at ' + res.limit + ')' : ''));
    for (const r of res.results) {
      console.log('  ' + (r.ok ? 'DONE   ' + r.verdict.padEnd(16) + r.name : 'FAILED  ' + r.error));
    }
    console.log('');
    process.exit(0);
  }

  const jobs = state();
  const counts = jobs.reduce((a, j) => { a[j.status] = (a[j.status] || 0) + 1; return a; }, {});
  console.log('');
  console.log('  queue: ' + (jobs.length ? JSON.stringify(counts) : 'empty'));
  for (const j of jobs.slice(-15)) {
    console.log('  ' + String(j.status).padEnd(8) + String(j.queuedAt).slice(0, 19)
      + '  ' + (j.name || (j.spec ? j.spec.strategy + ' ' + j.spec.symbol + ' ' + j.spec.timeframe : ''))
      + (j.error ? '  ' + j.error : ''));
  }
  console.log('');
}

module.exports = { QUEUE, enqueue, drain, state, selftest };
