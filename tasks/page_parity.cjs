#!/usr/bin/env node
'use strict';
/**
 * Do the two boxes' PAGES show the same thing?
 *
 *   node tasks/page_parity.cjs            compare, print, exit 1 on drift
 *   node tasks/page_parity.cjs --json     machine-readable
 *
 * WHY THIS IS NOT vps_parity.cjs, AND WHY BOTH ARE NEEDED.
 *
 * vps_parity.cjs compares FILES: 45 tracked files, 11 engine functions, 7 constants,
 * 111 routes. It reported "all 45 tracked files identical - ENGINES AGREE" on
 * 2026-08-30 while the Robustness page on the two boxes showed COMPLETELY DIFFERENT
 * ANSWERS:
 *
 *     laptop   469 trades, 2019-08-29 .. 2026-08-21, Deflated Sharpe 35.99%
 *     VPS      227 trades, 2022-04-26 .. 2026-08-11, Deflated Sharpe 59.79%
 *
 * Both were correct. dashboard/report.html was byte-identical on both. The DATA behind
 * it was five days apart and covered a window 2.7 years shorter, because the artifact
 * the page renders is generated per box and had not been regenerated there.
 *
 * A page is not "the same" because its markup matches. It is the same when it SAYS the
 * same thing, and nothing in this project checked that. A reader comparing the two
 * dashboards would have drawn opposite conclusions about whether the system has an edge,
 * with every existing parity check green.
 *
 * So this compares the ARTIFACTS the pages actually render, field by field, and names
 * which box is behind. It reads them over ssh, which is reliable and needs no session.
 *
 * BUT ARTIFACTS ALONE ARE NOT ENOUGH, and this file learned that the hard way on
 * 2026-08-31: it printed "BOTH BOXES SHOW THE SAME THING" while the VPS /report served
 * NO Deflated Sharpe section at all. Both boxes held an identical sharpe-robustness.json,
 * so every artifact field matched - but the VPS process had started four hours before the
 * commit that added the route block which READS that file. File present, code absent,
 * page blank, parity green. That is this file's own founding bug one level down: it was
 * written because vps_parity compares files and cannot see the page, and then it compared
 * files too.
 *
 * Hence the SERVED CHECK near the end, which does one authenticated GET per box and asks
 * whether the RUNNING code exposes the section. The old note here claimed the gated routes
 * "answer 401 to a CLI on the peer" and that is what stopped anyone trying: it is FALSE.
 * Each box's cookie value IS its session_secret.txt (index.js compares them with
 * timingSafeStringEqual), and curl with that cookie answers 200 from the laptop against
 * the peer. What actually 401s is PowerShell's Invoke-RestMethod passing the cookie via
 * -Headers - a client bug that was nearly recorded as a VPS auth fault.
 *
 * READ-ONLY. It fetches, compares and prints. It regenerates nothing, copies nothing and
 * changes nothing: the remedy is named and left for a human or the weekly job.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const KEY = process.env.VPS_KEY || 'C:/Users/User/.ssh/contabo_smartentry';
const PEER = process.env.VPS_HOST || 'administrator@169.58.74.133';
const PEER_ROOT = 'C:/ai-trading-dashboard';

// A field marked CONTEXT is printed for orientation and never counted as drift, because
// it differs BY DESIGN. Anything not marked is a parity claim that must hold.
const CONTEXT = 'context';

// The artifacts each page renders, and the fields that carry its MEANING. Timestamps
// are deliberately excluded from the comparison: two boxes generating the same answer
// at different minutes are in agreement, and flagging that would be noise that trains
// people to ignore the check.
const WATCHED = [
  {
    page: '/report  (Robustness)',
    file: 'tasks/analysis/montecarlo-latest.json',
    remedy: 'node tasks/montecarlo_report.cjs        (weekly: SmartEntry Robustness Report)',
    fields: [
      ['trades', d => d.trades],
      ['span from', d => d.span && d.span.from],
      ['span to', d => d.span && d.span.to],
      ['gate', d => d.params && d.params.gate],
      ['sims', d => d.params && d.params.sims],
      ['momentumRsiMax', d => d.engineConfig && d.engineConfig.momentumRsiMax],
      ['trendFollowRsiMax', d => d.engineConfig && d.engineConfig.trendFollowRsiMax],
      ['expired dropped', d => d.horizon && d.horizon.expiredDropped],
    ],
  },
  {
    page: '/report  (Deflated Sharpe)',
    file: 'tasks/analysis/sharpe-robustness.json',
    remedy: 'node tasks/sharpe_robustness.cjs --out tasks/analysis/sharpe-robustness.json   (weekly: Sharpe Robustness)',
    fields: [
      ['trades', d => d.population && d.population.trades],
      ['Sharpe/trade', d => round(d.sharpePerTrade, 4)],
      ['PSR', d => round(d.psr, 4)],
      ['DSR', d => round(d.deflated && d.deflated.dsr, 4)],
      ['MinTRL', d => d.minTrackRecordLength == null ? null : Math.ceil(d.minTrackRecordLength)],
      ['verdict', d => d.verdict],
    ],
  },
  {
    page: '/strategy  (search)',
    file: 'tasks/analysis/strategy-search-latest.json',
    remedy: 'the nightly search re-runs on its own axis schedule, so a bars-only difference\n' +
      '      clears at the next run. Force it with: tasks\\strategy_search_vps.bat  (read-only)',
    // Paths verified against the artifact's ACTUAL schema, not guessed. The first cut of
    // this used incumbent / candidatesTested / promotable at the top level; all three
    // resolved to null on BOTH boxes, so every row "matched" and the section could never
    // fail. A check that cannot fire reads as clean, which is worse than no check.
    //
    // Then the corrected paths flagged six fields as drift - and they were WRONG TOO, in
    // the opposite direction. strategy_search_vps.bat rotates one axis per weekday (Sun
    // ceiling, Mon gate, Tue rsi, Wed minrr, Thu adx, Fri minstrength, Sat trail), so the
    // two boxes are almost never mid-search on the same axis and results[0] is a different
    // QUESTION on each. Comparing those as drift would fire on six of seven days for a
    // system working exactly as designed, which is the alarm fatigue this file's own header
    // warns about. Each box also keeps its OWN multiplicity ledger, by design: independent
    // trials, independently deflated.
    //
    // So the split is: what must match is the INPUT (the bars both boxes search over, and
    // that they agree on today's answer when they happen to be on the same axis). Axis
    // state is printed as context and never counted as drift.
    fields: [
      ['newest bar', d => pick(d, ['bars.newest'])],
      ['bars XAUUSD', d => pick(d, ['bars.perSymbol.XAUUSD'])],
      ['bars BTCUSD', d => pick(d, ['bars.perSymbol.BTCUSD'])],
      ['bars SP500', d => pick(d, ['bars.perSymbol.SP500'])],
      // Compared only when both boxes are on the same axis; otherwise not a question.
      ['incumbent (same axis)', (d, other) => {
        const axis = pick(d, ['results.0.axis']);
        if (!axis || axis !== pick(other, ['results.0.axis'])) return 'n/a (axes differ)';
        return pick(d, ['results.0.incumbent']);
      }],
      ['axis today', d => pick(d, ['results.0.axis']), CONTEXT],
      ['incumbent on it', d => pick(d, ['results.0.incumbent']), CONTEXT],
      ['trials on axis', d => pick(d, ['results.0.trials']), CONTEXT],
      ['tested to date', d => pick(d, ['testedToDate']), CONTEXT],
      ['candidates', d => len(pick(d, ['results.0.candidates'])), CONTEXT],
      ['promotable', d => len(pick(d, ['results.0.promotable'])), CONTEXT],
    ],
  },
];

function round(x, n) {
  return typeof x === 'number' && Number.isFinite(x) ? Number(x.toFixed(n)) : null;
}
/** Length of an array field, or null when the artifact does not carry it. */
function len(x) { return Array.isArray(x) ? x.length : null; }
/** First path that resolves, so a schema change in one artifact degrades to null. */
function pick(obj, paths) {
  for (const p of paths) {
    let cur = obj, ok = true;
    for (const part of p.split('.')) {
      if (cur == null) { ok = false; break; }
      cur = Array.isArray(cur) && /^\d+$/.test(part) ? cur[Number(part)] : cur[part];
    }
    if (ok && cur !== undefined) return cur;
  }
  return null;
}

function readLocal(rel) {
  const p = path.join(ROOT, rel.replace(/\//g, path.sep));
  if (!fs.existsSync(p)) return { missing: true };
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { return { unreadable: e.message }; }
}

/**
 * Read one JSON artifact from the peer.
 *
 * Base64 -EncodedCommand, because a nested-quote ssh command silently returns LOCAL
 * results on this fleet - a probe of that shape once reported the laptop's own HEAD as
 * the VPS's. A parity check that reads the wrong box is worse than none.
 */
function readPeer(rel) {
  const ps = `$p = Join-Path '${PEER_ROOT}' '${rel.replace(/\//g, '\\')}'; ` +
    `if (Test-Path $p) { [Convert]::ToBase64String([IO.File]::ReadAllBytes($p)) } ` +
    `else { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('{"missing":true}')) }`;
  const b64 = Buffer.from(ps, 'utf16le').toString('base64');
  try {
    const out = execFileSync('ssh', ['-i', KEY, '-o', 'StrictHostKeyChecking=no', PEER,
      `powershell -NoProfile -NonInteractive -EncodedCommand ${b64}`],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120000,
        stdio: ['ignore', 'pipe', 'ignore'] });
    // BASE64 THE BYTES, never Get-Content -Raw. PowerShell 5.1 decodes -Raw with the
    // system ANSI codepage, so every em-dash in these artifacts' notes and caveats came
    // back mangled: all three reported UNREADABLE with a JSON parse error at a byte
    // offset while all three were perfectly valid on disk. Base64 over the raw bytes
    // has no encoding surface at all.
    const payload = out.replace(/\s+/g, '');
    if (!payload) return { unreadable: 'empty reply' };
    return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  } catch (e) {
    return { unreadable: String(e.message || e).slice(0, 120) };
  }
}

/**
 * --selftest: prove the comparator can BOTH fire and stay quiet, without touching ssh.
 *
 * This file has now been wrong in both directions on the same section. First its paths
 * missed the schema, every value resolved to null, and /strategy silently "passed" while
 * proving nothing. Then the corrected paths counted the weekday axis rotation as drift and
 * would have cried wolf six days in seven. Both bugs are invisible to a run whose output
 * you are pleased with, so the canary asserts the behaviour instead of the appearance.
 */
if (argv.includes('--selftest')) {
  let pass = 0, fail = 0;
  const check = (label, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    ok ? pass++ : fail++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}` + (ok ? '' : `   got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
  };

  // Every watched field must actually resolve against a real artifact. This is the check
  // that would have caught the null-path bug on the day it was written.
  for (const w of WATCHED) {
    const doc = readLocal(w.file);
    if (doc.missing || doc.unreadable) { console.log(`  skip  ${w.file} not present locally`); continue; }
    for (const [name, get] of w.fields) {
      let v = null;
      try { v = get(doc, doc); } catch (e) { v = null; }
      check(`${w.file} :: ${name} resolves`, v !== null && v !== undefined, true);
    }
  }

  // The axis guard: same axis compares, different axis declines.
  const axisField = WATCHED.find(w => w.page.includes('/strategy')).fields
    .find(f => f[0] === 'incumbent (same axis)')[1];
  const gateA = { results: [{ axis: 'gate', incumbent: '70' }] };
  const gateB = { results: [{ axis: 'gate', incumbent: '65' }] };
  const ceil = { results: [{ axis: 'ceiling', incumbent: '88/84' }] };
  check('same axis exposes the incumbent', axisField(gateA, gateB), '70');
  check('same axis, different incumbent IS drift',
    axisField(gateA, gateB) !== axisField(gateB, gateA), true);
  check('different axis declines to compare', axisField(gateA, ceil), 'n/a (axes differ)');
  check('different axis is equal on both sides, so never drift',
    axisField(gateA, ceil) === axisField(ceil, gateA), true);

  // CONTEXT rows must not be counted, non-context rows must be.
  check('CONTEXT marker is what the fields use',
    WATCHED.some(w => w.fields.some(f => f[2] === CONTEXT)), true);
  check('len() of a non-array is null', len('nope'), null);
  check('len() counts an array', len([1, 2, 3]), 3);
  check('round() rejects a non-number', round(null, 4), null);
  // Every watched section must carry a remedy, or a drift report names no way to fix it.
  check('every section has a remedy', WATCHED.every(w => typeof w.remedy === 'string' && w.remedy), true);

  console.log('');
  console.log(`  ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

const report = [];
let drifted = 0, unreadable = 0;

for (const w of WATCHED) {
  const a = readLocal(w.file);
  const b = readPeer(w.file);
  const rows = [];
  if (a.missing || b.missing || a.unreadable || b.unreadable) {
    unreadable++;
    rows.push({
      field: '(artifact)',
      local: a.missing ? 'MISSING' : a.unreadable ? 'UNREADABLE' : 'ok',
      peer: b.missing ? 'MISSING' : b.unreadable ? ('UNREADABLE: ' + b.unreadable) : 'ok',
      same: false,
    });
  } else {
    for (const [name, get, kind] of w.fields) {
      // Each getter is handed the OTHER box's artifact too, so a field can decline to be
      // a parity claim when the two boxes are not answering the same question.
      let la = null, lb = null;
      try { la = get(a, b); } catch (e) { la = null; }
      try { lb = get(b, a); } catch (e) { lb = null; }
      const same = JSON.stringify(la) === JSON.stringify(lb);
      const isContext = kind === CONTEXT;
      if (!same && !isContext) drifted++;
      rows.push({ field: name, local: la, peer: lb, same, context: isContext });
    }
  }
  report.push({ page: w.page, file: w.file, remedy: w.remedy, rows });
}

if (JSON_OUT) {
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), drifted, unreadable, report, feedsTheGate: false }, null, 2));
} else {
  console.log('');
  console.log('  PAGE PARITY — do both boxes SHOW the same thing?');
  console.log('  ' + '-'.repeat(76));
  for (const sec of report) {
    console.log('');
    console.log('  ' + sec.page + '   <- ' + sec.file);
    for (const r of sec.rows) {
      // '*' is drift and only drift. Context rows carry a dot so a difference there reads
      // as information rather than as a fault to go and fix.
      const mark = r.context ? '  .' : (r.same ? '   ' : '  *');
      const tail = r.context && !r.same ? '   (by design)' : '';
      console.log(`${mark} ${String(r.field).padEnd(22)} local ${String(r.local).padEnd(22)} peer ${String(r.peer)}${tail}`);
    }
  }
// ─────────────────────────────────────────────────────────────────────────────
// IS THE SECTION ACTUALLY *SERVED*? — added 2026-08-31, because this tool MISSED a
// real divergence and reported BOTH BOXES SHOW THE SAME THING while they did not.
//
// Everything above compares ARTIFACTS ON DISK, read over ssh, because the header said
// the gated routes need a session. That is a blind spot exactly the size of this bug:
// on 2026-08-31 both boxes held an identical `sharpe-robustness.json`, so every field
// above matched — while the VPS SERVED NO DEFLATED SHARPE SECTION AT ALL. Its running
// process started 2026-08-30T17:15:07Z, four hours before commit 08ce9c5 added the
// route block that reads that file. File present, code absent, page blank, parity green.
//
// That is the SAME failure this file was written for, one level down: vps_parity compares
// files and cannot see the rendered page, so page_parity was built — and then page_parity
// compared files too. A parity check that reads what is on disk cannot answer "do both
// boxes SHOW the same thing", because serving needs the CODE to be running, not merely
// deployed. See [[the_vps_has_the_ai_brain_fix_on_disk_but_runs_old_code]].
//
// The session objection is solvable and was simply never tried: each box's cookie value
// IS its session_secret.txt (index.js compares them with timingSafeStringEqual), so the
// secret is read the same way every other peer artifact is and used for one GET. The
// secret is never printed, never logged and never written anywhere.
//
// READ-ONLY, like the rest of this file: one GET per box, nothing regenerated.
const SERVED = [
  {
    page: '/report  (served)',
    route: '/api/robustness-report',
    // EVERY top-level key present on EITHER box, enumerated from the responses — never a
    // hand-written list. The first cut of this check named three keys by hand
    // ('sharpeRobustness', 'report', 'status') and therefore reported ONE missing section
    // when SEVEN were missing: blockSimulated, engineConfig, generatedAt, horizon,
    // liveClosedTrades, sharpeRobustness and stale/staleAfterHours were all absent from
    // the VPS response. A curated list can only find what its author already suspected,
    // which is the same defect as the /strategy paths that resolved to null on both boxes
    // and made every row "match". Enumerate, then compare.
    keys: null,
    remedy: 'restart the server on the box that is missing it — the code is deployed but ' +
            'not loaded:\n        tasks/safe_server_restart.ps1 -Execute   ' +
            '(proof is startedAt moving, never a file hash)',
  },
];

function secretLocal() {
  try { return fs.readFileSync(path.join(ROOT, 'server', 'session_secret.txt'), 'utf8').trim(); }
  catch (e) { return null; }
}
function secretPeer() {
  const ps = `[Convert]::ToBase64String([IO.File]::ReadAllBytes('${PEER_ROOT}/server/session_secret.txt'))`;
  const b64 = Buffer.from(ps, 'utf16le').toString('base64');
  try {
    const out = execFileSync('ssh', ['-i', KEY, '-o', 'StrictHostKeyChecking=no', PEER,
      `powershell -NoProfile -NonInteractive -EncodedCommand ${b64}`],
      { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] });
    return Buffer.from(out.replace(/\s+/g, ''), 'base64').toString('utf8').trim() || null;
  } catch (e) { return null; }
}

// curl rather than a node http client, to keep this file synchronous like the rest of it.
// PowerShell's Invoke-RestMethod is deliberately NOT used from here: passing the cookie
// through -Headers returned 401 against a route that answers 200 to the identical cookie
// via curl, which cost an hour and nearly got logged as a VPS auth fault.
function fetchServed(base, secret) {
  if (!secret) return { unreadable: 'no session secret' };
  try {
    const out = execFileSync('curl', ['-s', '-m', '25', '-H', `Cookie: smartentry_session=${secret}`,
      base + SERVED[0].route], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    if (!out || !out.trim()) return { unreadable: 'empty reply' };
    const j = JSON.parse(out);
    // An auth failure parses cleanly and would otherwise read as "section absent" —
    // which would report drift on every run and train you to ignore it.
    if (j && j.error) return { unreadable: String(j.error).slice(0, 60) };
    return j;
  } catch (e) { return { unreadable: String(e.message || e).slice(0, 80) }; }
}

console.log('  SERVED CHECK — does the running code expose the section, not just hold the file?');
{
  const lSec = secretLocal(), pSec = secretPeer();
  const lRes = fetchServed('http://localhost:3001', lSec);
  const peerHost = (process.env.VPS_HOST || PEER).replace(/^.*@/, '');
  const pRes = fetchServed(`http://${peerHost}:3001`, pSec);
  const servedRows = [];
  if (lRes.unreadable || pRes.unreadable) {
    // Unreadable is an unanswered question, never agreement — same rule as above.
    unreadable++;
    console.log(`    could not compare: local=${lRes.unreadable || 'ok'}  peer=${pRes.unreadable || 'ok'}`);
    servedRows.push({ field: SERVED[0].route, local: lRes.unreadable || 'ok', peer: pRes.unreadable || 'ok', same: true, context: true });
  } else {
    // The union of what BOTH boxes serve, so a section either side is missing shows up.
    // Sorted for a stable diff between runs; a set built from one box could only ever
    // report that box's own sections.
    const keys = SERVED[0].keys ||
      Array.from(new Set([...Object.keys(lRes), ...Object.keys(pRes)])).sort();
    let missing = 0;
    for (const k of keys) {
      const lHas = Object.prototype.hasOwnProperty.call(lRes, k);
      const pHas = Object.prototype.hasOwnProperty.call(pRes, k);
      const same = lHas === pHas;
      if (!same) { drifted++; missing++; }
      console.log(`  ${same ? ' ' : '*'} ${String(k).padEnd(22)} local ${lHas ? 'SERVED' : 'ABSENT'}      peer ${pHas ? 'SERVED' : 'ABSENT'}`);
      servedRows.push({ field: k, local: lHas ? 'SERVED' : 'ABSENT', peer: pHas ? 'SERVED' : 'ABSENT', same, context: false });
    }
    // Say the COUNT out loud. Seven absent sections scrolling past as seven separate
    // starred rows reads like seven small problems; it is one problem — a process running
    // code older than the routes it is meant to serve — and the count is what makes that
    // legible at a glance.
    if (missing) {
      console.log(`    => ${missing} of ${keys.length} section(s) differ in PRESENCE, not value.`);
      console.log('       One box is running code older than the routes it should expose.');
    }
  }
  report.push({ page: SERVED[0].page, file: SERVED[0].route, remedy: SERVED[0].remedy, rows: servedRows });
}
console.log('');

  console.log('');
  console.log('  ' + '-'.repeat(76));
  console.log('  legend:  * = drift, must be reconciled   . = differs by design, context only');
  if (drifted === 0 && unreadable === 0) {
    console.log('  BOTH BOXES SHOW THE SAME THING.');
  } else {
    console.log(`  ${drifted} field(s) DIFFER` + (unreadable ? `, ${unreadable} artifact(s) unreadable` : '') + '.');
    console.log('  The pages are identical files rendering different data. Regenerate on the box');
    console.log('  that is behind — only the sections that actually drifted:');
    // Name the command for the section that drifted, not a fixed pair. A remedy that
    // tells you to re-run the robustness report when the STRATEGY search is what is stale
    // is a remedy that does not work, and one that does not work gets stopped being read.
    for (const sec of report) {
      if (!sec.rows.some(r => !r.same && !r.context)) continue;
      console.log(`    ${sec.page.trim()}`);
      console.log('      ' + (sec.remedy || 'no remedy recorded for this artifact'));
    }
  }
  console.log('  Read-only: nothing was regenerated, copied or changed.');
  console.log('');
}


// A scheduled run's stdout goes nowhere. Without this the nightly task would leave only
// an exit code behind, and an exit code cannot tell you WHICH field moved - which is the
// whole reason this exists. Append, never truncate: the history of when the boxes drifted
// apart is the evidence, and rule 6 says nothing here gets deleted.
try {
  const logDir = path.join(ROOT, 'tasks', 'logs');
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  const stamp = new Date().toISOString();
  const lines = report.map(sec => {
    const rows = sec.rows.map(r =>
      `    ${r.context ? '.' : (r.same ? ' ' : '*')} ${String(r.field).padEnd(22)} local ${String(r.local).padEnd(22)} peer ${r.peer}`);
    return `  ${sec.page}   <- ${sec.file}\n` + rows.join('\n');
  });
  fs.appendFileSync(path.join(logDir, 'page_parity.txt'),
    `\n========== ${stamp}  drifted=${drifted} unreadable=${unreadable} ==========\n` +
    lines.join('\n') + '\n', 'utf8');
} catch (e) {
  // A log that cannot be written must not take the check down with it. Say so and carry
  // the real verdict out through the exit code regardless.
  console.error('  (could not append tasks/logs/page_parity.txt: ' + e.message + ')');
}

// Exit 1 on drift so a scheduled run can act on it. Unreadable is NOT drift - it is an
// unanswered question, and reporting it as agreement would be the worse error.
process.exit(drifted > 0 ? 1 : 0);
