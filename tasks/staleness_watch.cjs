#!/usr/bin/env node
'use strict';
/**
 * WHICH WRITER HAS STOPPED WRITING?
 *
 * WHY THIS EXISTS. On 2026-09-08 the three M15 archives sat 215 HOURS - nine days - stale
 * while the bridge pushed 4,000 M15 bars per symbol into memory the whole time. Nothing
 * errored. persist_bars.cjs iterated the timeframes it had (d1/h4/h1), reported success on
 * all of them, and M15 was simply not in its table. Every check was green because every
 * check asked "did the job run", and the job did run.
 *
 * The same shape had already happened at least three times on this fleet: the confluence
 * alert that had never been deliverable, crash_forensics that was never scheduled, and
 * lab_shadow that computed forward evidence nobody read. A file that stops being written
 * produces NO error anywhere - it just gets older, and age is the only signal.
 *
 * SO THIS WATCHES AGE, NOT EXIT CODES. Each entry declares how fresh it should be, and
 * WHO writes it, so a stale line names its own culprit instead of starting a search.
 *
 * ABSENT IS NOT STALE, AND BOTH ARE REPORTED SEPARATELY. A file that has never existed is
 * a different fault from one that stopped updating - conflating them sends you looking for
 * a dead writer when the real answer is that nothing ever wrote it.
 *
 * MARKET-HOURS FILES ARE NOT EXPECTED TO MOVE AT THE WEEKEND. Anything marked
 * marketHours is judged against the last weekday, so a Sunday run does not produce five
 * red lines that train you to ignore the report.
 *
 * READ-ONLY. Stats files, prints. Writes nothing, fixes nothing.
 *
 *   node tasks/staleness_watch.cjs            table
 *   node tasks/staleness_watch.cjs --quiet    only problems (for scheduled runs)
 */

const fs = require('fs');
const path = require('path');

// ── ASCII OUT, ALWAYS ─────────────────────────────────────────────────────────
// The scheduled task redirects stdout to a file through cmd.exe, and cmd applies the
// CONSOLE CODEPAGE. Measured 2026-09-08: identical output, same script, both boxes -
// the laptop wrote correct UTF-8 while the VPS report read "STALENESS WATCH <?" age",
// because that box's console codepage is not 65001. A report a human is meant to read
// must not depend on which machine ran it, so the typographic characters are folded to
// ASCII at the output boundary rather than being banned from the source.
const ASCII_FOLD = new Map(Object.entries({
  '\u2014': '--', '\u2013': '-', '\u2500': '-', '\u2502': '|', '\u2508': '-',
  '\u2018': "'", '\u2019': "'", '\u201c': '"', '\u201d': '"',
  '\u2026': '...', '\u2265': '>=', '\u2264': '<=', '\u2192': '->', '\u00b7': '-',
  '\u2713': 'ok', '\u2717': 'x', '\u26a0': '!', '\u00a0': ' ',
}));
function toAscii(s) {
  return String(s).replace(/[^\x00-\x7F]/g, (ch) => ASCII_FOLD.get(ch) || '?');
}
const _rawLog = console.log.bind(console);
const _rawErr = console.error.bind(console);
console.log = (...a) => _rawLog(toAscii(a.join(' ')));
console.error = (...a) => _rawErr(toAscii(a.join(' ')));


const ROOT = path.join(__dirname, '..');
const QUIET = process.argv.includes('--quiet');

// maxAgeH is what "healthy" means for THIS file, not a global default. A number here is
// a claim about the writer's cadence, so each carries who writes it.
const WATCH = [
  // --- market data: the class that failed silently for nine days -------------------
  { f: 'tasks/history/XAUUSD_M15.csv', maxAgeH: 8, marketHours: true, writer: 'persist_bars.cjs (Bar Keeper)' },
  { f: 'tasks/history/BTCUSD_M15.csv', maxAgeH: 8, marketHours: false, writer: 'persist_bars.cjs (Bar Keeper)' },
  { f: 'tasks/history/SP500_M15.csv',  maxAgeH: 8, marketHours: true, writer: 'persist_bars.cjs (Bar Keeper)' },
  { f: 'tasks/history/XAUUSD_H1.csv',  maxAgeH: 8, marketHours: true, writer: 'persist_bars.cjs (Bar Keeper)' },
  { f: 'tasks/history/XAUUSD_H4.csv',  maxAgeH: 12, marketHours: true, writer: 'persist_bars.cjs (Bar Keeper)' },
  { f: 'tasks/history/XAUUSD_D1.csv',  maxAgeH: 48, marketHours: true, writer: 'persist_bars.cjs (Bar Keeper)' },

  // --- learning and evidence: these must never quietly stop --------------------------
  { f: 'server/learning.json',            maxAgeH: 48, writer: 'the engine, on a closed trade' },
  { f: 'server/journal.json',             maxAgeH: 72, writer: 'the engine, on a closed trade' },
  { f: 'tasks/rejections.jsonl',          maxAgeH: 24, writer: 'the engine, on a rejected setup' },
  { f: 'tasks/all_trades_ledger.jsonl',   maxAgeH: 24, writer: 'trade_ledger_reconcile' },
  { f: 'dashboard/lab-shadow.json',       maxAgeH: 3,  writer: 'lab_shadow.cjs (Lab Shadow)' },
  { f: 'tasks/jarvis_memory.json',        maxAgeH: 72, writer: '/learn and the session-stop hook' },

  // --- surfaces that a human reads and would otherwise trust ------------------------
  { f: 'dashboard/mt5-runtime-status.json', maxAgeH: 1, writer: 'pull_vps_status.ps1' },
  { f: 'tasks/analysis/lab-curator-latest.txt', maxAgeH: 30, writer: 'lab_curator.cjs (Lab Curator)' },
];

function lastWeekdayCutoffHours() {
  // On Sat/Sun, allow the age accrued since Friday close so weekend runs are not all red.
  const day = new Date().getUTCDay(); // 0 Sun .. 6 Sat
  if (day === 6) return 24;
  if (day === 0) return 48;
  return 0;
}

function main() {
  const weekendGrace = lastWeekdayCutoffHours();
  const rows = [];
  for (const w of WATCH) {
    const full = path.join(ROOT, w.f);
    if (!fs.existsSync(full)) {
      // `allowed` is set here too. Without it the ABSENT row printed "<= undefinedh",
      // which is the same shape of defect this tool exists to find: a report stating a
      // number it never computed. Seen on the VPS run 2026-09-08.
      rows.push({
        ...w, state: 'ABSENT', ageH: null,
        allowed: w.maxAgeH + (w.marketHours ? weekendGrace : 0),
        detail: 'never written on this box',
      });
      continue;
    }
    const ageH = (Date.now() - fs.statSync(full).mtimeMs) / 3600000;
    const allowed = w.maxAgeH + (w.marketHours ? weekendGrace : 0);
    rows.push({ ...w, state: ageH > allowed ? 'STALE' : 'ok', ageH, allowed });
  }

  const bad = rows.filter(r => r.state !== 'ok');
  if (QUIET && !bad.length) return;

  console.log('='.repeat(96));
  console.log('  STALENESS WATCH — age, not exit codes. ' + new Date().toISOString());
  if (weekendGrace) console.log('  Weekend: market-hours files get +' + weekendGrace + 'h grace.');
  console.log('  A writer that stops raises NO error anywhere. Age is the only signal.');
  console.log('='.repeat(96));

  const show = QUIET ? bad : rows;
  for (const r of show) {
    const age = r.ageH === null ? '   —   ' : (r.ageH < 100 ? r.ageH.toFixed(1) + 'h' : Math.round(r.ageH / 24) + 'd').padStart(7);
    console.log('  ' + r.state.padEnd(7) + age + '  ' + r.f.padEnd(42) +
      (r.state === 'ok' ? '' : '<= ' + r.allowed + 'h  writer: ' + r.writer));
    if (r.detail) console.log('           ' + r.detail);
  }

  console.log('');
  const stale = rows.filter(r => r.state === 'STALE').length;
  const absent = rows.filter(r => r.state === 'ABSENT').length;
  console.log('  ' + (rows.length - stale - absent) + ' fresh, ' + stale + ' STALE, ' + absent + ' ABSENT');
  if (absent) console.log('  ABSENT is not STALE: nothing ever wrote those, so there is no dead writer to restart.');
  if (stale || absent) process.exitCode = 1;
}

try { main(); } catch (err) {
  console.error('staleness_watch failed: ' + (err && err.message));
  process.exitCode = 1;
}
