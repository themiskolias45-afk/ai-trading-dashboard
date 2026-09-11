#!/usr/bin/env node
'use strict';
/* ============================================================================
   coverage_publish.cjs — give the coverage audit a SURFACE

   WHY THIS EXISTS. Measured 2026-09-11: the server has 103 /api routes and not one
   of them mentions coverage. The 88-check audit — the most complete health check
   either box runs, and the thing that found today's three REDs — existed only as
   tasks/logs/coverage_audit.txt, a 663 KB append-only log somebody has to open in a
   text editor. Every other health surface is on the dashboard; this one was not, so
   "is the system healthy" could not be answered from the page.

   This is the same defect this repo already fixed for the audit's own neighbours.
   dashboard/index.html:8627 says of ea-build-watch.json and halt-coverage.json that
   they "were published every cycle and rendered by NO page - they spoke only inside
   the coverage audit, which someone has to run." Those two got a panel. The audit
   itself was left with exactly the problem it had diagnosed.

   IT IS A PUBLISHER, NOT A CHECKER. It runs nothing, judges nothing and decides
   nothing. It reads the log the audit already writes and re-states the LAST block as
   JSON. If the audit is wrong, this is wrong in the same way — deliberately, because
   a second implementation of the same checks is a second thing to disagree with.

   NO SERVER ROUTE, ON PURPOSE. dashboard/ is served by express.static
   (server/index.js:11280), so a JSON file dropped there is readable by the page with
   NO server restart. A restart on a box holding open positions is not free, and a
   reporting change does not justify one. Same pattern as halt-coverage.json and
   mt5-runtime-status.json, both of which the page already reads this way.

   IT NEVER THROWS AND NEVER EXITS NON-ZERO on a missing or unparseable log. A
   publisher that alarms because the thing it reports on has not run yet trains people
   to ignore the alarm. It writes a payload saying so instead, and the panel renders
   that.

     node tasks/coverage_publish.cjs            write dashboard/coverage-audit.json
     node tasks/coverage_publish.cjs --print    write it and print it
     node tasks/coverage_publish.cjs --selftest parse the checked-in log, assert shape
   ========================================================================== */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LOG = path.join(ROOT, 'tasks', 'logs', 'coverage_audit.txt');
const OUT = path.join(ROOT, 'dashboard', 'coverage-audit.json');

/* The audit prints one block per run, each opening with this line. Anchored to the
   literal the script writes, so a format change fails loudly here rather than
   silently publishing half a block. */
const BLOCK_HEADER = /^\s*SmartEntry COVERAGE AUDIT\s*-\s*(.+?)\s*$/;
const BOX_LINE = /^\s*box:\s*(\S+)/;
const SECTION_LINE = /^\s*\[([A-Z0-9 _-]+)\]\s*$/;
const CHECK_LINE = /^\s{2,}(RED|AMBER|GREEN|INFO|UNKNOWN)\s{2,}(\S.*?)\s{2,}(\S.*)$/;
const SUMMARY_LINE = /^\s*(\d+)\s+checks:\s*(\d+)\s+RED,\s*(\d+)\s+AMBER,\s*(\d+)\s+UNKNOWN,\s*(\d+)\s+GREEN\/INFO/;

/* A published report older than this is stated as stale rather than presented as
   current. The audit's own schedule is every 3.5 h on the laptop and 12 h on the VPS,
   so half a day covers both without crying wolf on the slower one. */
const STALE_AFTER_HOURS = 13;

/** The last complete block in the log, as an array of lines. Empty if there is none. */
function lastBlockLines(allLines) {
  let start = -1;
  for (let i = allLines.length - 1; i >= 0; i--) {
    if (BLOCK_HEADER.test(allLines[i])) { start = i; break; }
  }
  if (start === -1) return [];
  return allLines.slice(start);
}

/** Turn one block into the published shape. Never throws on odd input. */
function parseBlock(lines) {
  const checks = [];
  let ranAtText = null, box = null, section = null, summary = null;

  for (const line of lines) {
    const h = line.match(BLOCK_HEADER);
    if (h) { ranAtText = h[1]; continue; }

    const b = line.match(BOX_LINE);
    if (b) { box = b[1]; continue; }

    const s = line.match(SECTION_LINE);
    if (s) { section = s[1]; continue; }

    const sum = line.match(SUMMARY_LINE);
    if (sum) {
      summary = {
        total: Number(sum[1]), red: Number(sum[2]), amber: Number(sum[3]),
        unknown: Number(sum[4]), greenOrInfo: Number(sum[5]),
      };
      continue;
    }

    const c = line.match(CHECK_LINE);
    if (c) {
      checks.push({ status: c[1], name: c[2].trim(), detail: c[3].trim(), section });
    }
  }
  return { ranAtText, box, section, checks, summary };
}

/**
 * The audit stamps LOCAL time with no offset ("2026-09-11 15:46:44"). Parsing it as
 * UTC would misdate every report by the box's offset — the exact trap recorded when a
 * BST log read as a corrupt file. Interpreted as local, which is what it is.
 */
function toIso(text) {
  if (!text) return null;
  const m = String(text).match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]),
                     Number(m[4]), Number(m[5]), Number(m[6]));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function build() {
  if (!fs.existsSync(LOG)) {
    return {
      available: false,
      reason: 'tasks/logs/coverage_audit.txt does not exist — the audit has not run on this box',
      publishedAt: new Date().toISOString(),
      feedsTheGate: false,
    };
  }

  const lines = fs.readFileSync(LOG, 'utf8').split(/\r?\n/);
  const block = lastBlockLines(lines);
  if (!block.length) {
    return {
      available: false,
      reason: 'no COVERAGE AUDIT block found in the log — the format may have changed',
      publishedAt: new Date().toISOString(),
      feedsTheGate: false,
    };
  }

  const parsed = parseBlock(block);
  const ranAt = toIso(parsed.ranAtText);
  const ageHours = ranAt ? (Date.now() - Date.parse(ranAt)) / 3600000 : null;

  const bad = st => parsed.checks.filter(c => c.status === st)
    .map(c => ({ name: c.name, detail: c.detail, section: c.section }));

  const red = bad('RED'), amber = bad('AMBER'), unknown = bad('UNKNOWN');

  /* The summary line is the audit's own count and wins. The parsed lists are what the
     panel shows. Publishing BOTH means a parser that silently drops a line is visible
     as a disagreement rather than as a quietly shorter list. */
  const counted = { red: red.length, amber: amber.length, unknown: unknown.length };
  const agrees = !parsed.summary
    || (parsed.summary.red === counted.red
        && parsed.summary.amber === counted.amber
        && parsed.summary.unknown === counted.unknown);

  return {
    available: true,
    box: parsed.box,
    ranAt,
    ranAtText: parsed.ranAtText,
    ageHours: ageHours === null ? null : Number(ageHours.toFixed(2)),
    stale: ageHours === null ? true : ageHours > STALE_AFTER_HOURS,
    staleAfterHours: STALE_AFTER_HOURS,
    summary: parsed.summary,
    counted,
    parseAgreesWithSummary: agrees,
    verdict: red.length ? 'RED' : amber.length ? 'AMBER' : unknown.length ? 'UNKNOWN' : 'GREEN',
    red, amber, unknown,
    totalChecksParsed: parsed.checks.length,
    publishedBy: require('os').hostname(),
    source: 'tasks/logs/coverage_audit.txt',
    publishedAt: new Date().toISOString(),
    feedsTheGate: false,
  };
}

/* ── the medic ledger, as a count the page can read ──────────────────────────
   WHY FROM THE LEDGER AND NOT FROM /api/medic. That route re-runs the doctor across
   BOTH boxes on a cache miss (server/index.js:14634) and offers no cache-only read, so
   hanging it off a strip that loads with every page would fire 20-second fleet doctor
   runs on nothing more than a refresh. The ledger is already on disk and costs a file
   read.

   ESCALATED IS THE NUMBER THAT MATTERS. The medic's own vocabulary separates what it
   handled from what it refused to decide: `fixed` and `accepted` are closed, `watching`
   is deliberate, and `escalated` means it stopped and handed the call to a human —
   money decisions, signal-path changes, open positions. On 2026-09-11 the strip's
   "Needs You" cell read 0 from system-plan's actionItems while SEVEN findings sat
   escalated in here. */
const MEDIC_LEDGER = path.join(ROOT, 'tasks', 'medic_ledger.jsonl');
const MEDIC_OUT = path.join(ROOT, 'dashboard', 'medic-ledger.json');
const OPEN_ACTIONS = ['escalated'];          // handed to the user, nobody else can close it
const CLOSED_ACTIONS = ['fixed', 'accepted', 'wontfix'];

function buildMedic() {
  if (!fs.existsSync(MEDIC_LEDGER)) {
    return {
      available: false,
      reason: 'tasks/medic_ledger.jsonl does not exist — the medic has not recorded a decision on this box',
      publishedAt: new Date().toISOString(),
      feedsTheGate: false,
    };
  }

  const rows = [];
  for (const line of fs.readFileSync(MEDIC_LEDGER, 'utf8').split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try { rows.push(JSON.parse(s)); } catch (e) { /* a torn line must not kill the read */ }
  }

  /* The ledger is append-only and a finding is re-decided over time, so the LAST row
     for an id is its current disposition. Folding in file order gives that for free. */
  const latest = new Map();
  for (const r of rows) if (r && r.id) latest.set(r.id, r);

  const byAction = {};
  for (const r of latest.values()) {
    const a = r.action || 'undecided';
    byAction[a] = (byAction[a] || 0) + 1;
  }

  const open = [...latest.values()]
    .filter(r => OPEN_ACTIONS.includes(r.action))
    .map(r => ({
      id: r.id, box: r.box, severity: r.severity, what: r.what,
      note: r.note, ts: r.ts, reviewDays: r.reviewDays,
    }));

  let newestTs = null;
  for (const r of latest.values()) {
    if (r.ts && (!newestTs || String(r.ts) > String(newestTs))) newestTs = r.ts;
  }

  return {
    available: true,
    /* THE BOX IS STAMPED INSIDE, not just implied by which machine served the file.
       Both artefacts here are PER-BOX MUTABLE STATE, the exact shape that has cost this
       fleet four times — most quietly when a git-tracked sleep_baseline.json shipped the
       laptop's history to the VPS and every VPS doctor run reported it as its own. A
       filename survives exactly until someone copies it; a field inside does not. Both
       files are gitignored so neither can travel, and the page prints this name, so a
       payload from the wrong machine is visible rather than silent. */
    publishedBy: require('os').hostname(),
    ledgerRows: rows.length,
    distinctFindings: latest.size,
    byAction,
    openCount: open.length,
    closedCount: [...latest.values()].filter(r => CLOSED_ACTIONS.includes(r.action)).length,
    open,
    lastDecisionAt: newestTs,
    source: 'tasks/medic_ledger.jsonl',
    publishedAt: new Date().toISOString(),
    feedsTheGate: false,
  };
}

function selftest() {
  let failed = 0;
  const ok = (n, c, x) => { if (!c) { failed++; console.log('  FAIL  ' + n + (x ? '  ' + x : '')); } else console.log('  ok    ' + n); };

  const medic = buildMedic();
  ok('the medic ledger was found', medic.available === true, medic.reason || '');
  if (medic.available) {
    ok('findings were folded to one row each', medic.distinctFindings > 0
      && medic.distinctFindings <= medic.ledgerRows);
    ok('open count matches the open list', medic.openCount === medic.open.length);
    ok('every open finding names its box and severity',
      medic.open.every(f => f.box && f.severity));
    ok('the medic block cannot reach the gate', medic.feedsTheGate === false);
  }

  const payload = build();
  ok('the log was found and a block parsed', payload.available === true, payload.reason || '');
  if (payload.available) {
    ok('a run timestamp was read', !!payload.ranAt, String(payload.ranAtText));
    ok('the box is named', !!payload.box);
    ok('the audit summary line was read', !!payload.summary);
    ok('checks were parsed', payload.totalChecksParsed > 0, String(payload.totalChecksParsed));
    ok('the parse agrees with the audit own count', payload.parseAgreesWithSummary === true,
      JSON.stringify({ summary: payload.summary, counted: payload.counted }));
    ok('verdict matches the red list',
      (payload.red.length > 0) === (payload.verdict === 'RED'));
    ok('nothing here can reach the gate', payload.feedsTheGate === false);
  }

  console.log('');
  console.log(failed === 0 ? '  ALL CHECKS PASSED' : '  ' + failed + ' CHECK(S) FAILED');
  return failed;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) process.exit(selftest() === 0 ? 0 : 1);

  const payload = build();
  writeJsonAtomic(OUT, payload);

  const medic = buildMedic();
  writeJsonAtomic(MEDIC_OUT, medic);

  if (argv.includes('--print')) {
    console.log(JSON.stringify({ coverage: payload, medic }, null, 2));
  } else {
    console.log('wrote ' + path.relative(ROOT, OUT)
      + '  verdict=' + (payload.verdict || 'UNAVAILABLE')
      + '  red=' + ((payload.red || []).length)
      + '  amber=' + ((payload.amber || []).length)
      + '  checks=' + (payload.totalChecksParsed || 0));
    console.log('wrote ' + path.relative(ROOT, MEDIC_OUT)
      + '  open=' + (medic.openCount === undefined ? '?' : medic.openCount)
      + '  findings=' + (medic.distinctFindings === undefined ? '?' : medic.distinctFindings));
  }
  process.exit(0);
}

module.exports = {
  build, buildMedic, parseBlock, lastBlockLines, toIso, selftest,
  OUT, LOG, MEDIC_OUT, MEDIC_LEDGER,
};
