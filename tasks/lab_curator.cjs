#!/usr/bin/env node
'use strict';
/**
 * THE LEARNING WORKER — read the forward evidence and say which staged candidates are
 * still worth carrying.
 *
 * WHY THIS EXISTS. lab_shadow.cjs computes everything needed to judge a staged candidate
 * — forward trades, realised expectancy, drift z-score, firing rate against expectation,
 * and how many more trades are needed to separate the edge from zero. It computes all of
 * it and then nobody reads it. Measured 2026-09-08: 4,094 trials had produced 8
 * survivors, every one carrying ZERO forward trades because lab_shadow had never been
 * scheduled. Scheduling it (that day) started the evidence flowing. This closes the other
 * half: something has to ACT on it.
 *
 * WHY IT IS A SCRIPT AND NOT AN LLM AGENT. Every input is a number and every rule is a
 * comparison. An agent would cost subscription quota to do arithmetic, and would do it
 * differently each run. Determinism is the point: the same evidence must always produce
 * the same verdict, or "we retired it because it drifted" is not a reason.
 *
 * ── IT NEVER DELETES, NEVER DEMOTES, NEVER EDITS A CONFIG ────────────────────────
 *
 * It writes ONE report and appends to ONE ledger. Retiring a candidate is a human
 * decision; this only ever says which ones the evidence no longer supports and why.
 * That is the standing rule in this project and the reason lab_promote.cjs stages rather
 * than promotes: a robot that searches thousands of configurations and acts on the best
 * of them is a machine for finding overfit and then trading it.
 *
 * ── THE VERDICTS, pre-registered here so they cannot be invented per-run ──────────
 *
 *   RETIRE-UNPROVABLE  days-to-proof > 365. Rule 7 in lab_promote.cjs refuses to STAGE
 *                      these, but it was added 2026-09-08 and every candidate staged
 *                      before it was never re-judged. donchian_break needs 2,394 forward
 *                      trades at 0.356/day = 6,709 DAYS. Carrying it costs attention and
 *                      can never return an answer.
 *   RETIRE-DRIFTED     forward expectancy is negative AND the drift check has enough
 *                      trades to see it. Not "it had a losing streak" — the z-score must
 *                      say the change is real at the current sample.
 *   RETIRE-SILENT      staged > 30 days and fired FEWER THAN 10% of expected trades. A
 *                      candidate that does not fire cannot be evidence either way, and
 *                      its backtest rate was measured on the same bars, so a large
 *                      shortfall means the live detector disagrees with the backtest.
 *   WATCH              accumulating, on track, nothing yet decidable.
 *   KEEP               forward evidence positive and drift consistent.
 *
 * A candidate with NO forward trades is never RETIRE-DRIFTED. Absence of evidence is not
 * evidence of failure, and conflating them is how a working model gets thrown away.
 *
 *   node tasks/lab_curator.cjs            print the verdicts
 *   node tasks/lab_curator.cjs --emit     also write the report and append the ledger
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
const PANEL = path.join(ROOT, 'dashboard', 'lab-shadow.json');
const REPORT = path.join(ROOT, 'tasks', 'analysis', 'lab-curator-latest.txt');
const LEDGER = path.join(ROOT, 'tasks', 'lab_curator_ledger.jsonl');
const EMIT = process.argv.includes('--emit');

// Pre-registered. Printed with every run so the bar is never inferred from the output.
const BAR = {
  MAX_DAYS_TO_PROOF: 365,
  SILENT_AFTER_DAYS: 30,
  SILENT_FIRING_FRACTION: 0.10,
  // A negative forward expectancy is only actionable when the drift test can actually
  // see a change of that size. Below this the sample cannot distinguish it from noise.
  MIN_TRADES_FOR_DRIFT_VERDICT: 10,
};

function readPanel() {
  if (!fs.existsSync(PANEL)) return null;
  try { return JSON.parse(fs.readFileSync(PANEL, 'utf8')); }
  catch (err) { console.error('  ! lab-shadow.json is unreadable: ' + err.message); return null; }
}

/**
 * One candidate -> one verdict. Order matters: unprovable is checked FIRST, because a
 * candidate that can never be settled should not be kept alive by a promising-looking
 * early sample.
 */
function judge(c) {
  const days = typeof c.daysToRequired === 'number' ? c.daysToRequired : null;
  const fwd = c.forwardTrades || 0;
  const exp = typeof c.forwardExpectancyR === 'number' ? c.forwardExpectancyR : null;
  const since = typeof c.daysSinceStaged === 'number' ? c.daysSinceStaged : 0;
  const expected = typeof c.expectedForwardTrades === 'number' ? c.expectedForwardTrades : null;

  if (days === null) {
    return { verdict: 'WATCH', why: 'days-to-proof unknown — cannot judge, and unknown is not a failure' };
  }
  if (days > BAR.MAX_DAYS_TO_PROOF) {
    return {
      verdict: 'RETIRE-UNPROVABLE',
      why: 'needs ' + (c.requiredForwardTrades ?? '?') + ' forward trades at ' +
           (c.backtestTradesPerDay ?? '?') + '/day = ' + Math.round(days) +
           ' days. Cannot be settled inside a year, so carrying it returns nothing.',
    };
  }
  if (since > BAR.SILENT_AFTER_DAYS && expected !== null && expected > 0 &&
      fwd < expected * BAR.SILENT_FIRING_FRACTION) {
    return {
      verdict: 'RETIRE-SILENT',
      why: 'staged ' + since.toFixed(1) + ' days, expected ~' + expected.toFixed(1) +
           ' trades, fired ' + fwd + '. The live detector disagrees with the backtest that ' +
           'measured this rate on the same bars.',
    };
  }
  if (fwd >= BAR.MIN_TRADES_FOR_DRIFT_VERDICT && exp !== null && exp < 0) {
    return {
      verdict: 'RETIRE-DRIFTED',
      why: 'forward expectancy ' + exp.toFixed(4) + 'R over ' + fwd +
           ' trades, and the sample is large enough for the drift check to see it (' +
           (c.driftStatus || 'no status') + ').',
    };
  }
  if (fwd === 0) {
    return { verdict: 'WATCH', why: 'no forward trades yet — absence of evidence, not evidence of failure' };
  }
  if (exp !== null && exp > 0) {
    return { verdict: 'KEEP', why: 'forward +' + exp.toFixed(4) + 'R over ' + fwd + ' trades, ' + (c.driftStatus || '') };
  }
  return { verdict: 'WATCH', why: fwd + ' forward trade(s), not yet decidable' };
}

function main() {
  const panel = readPanel();
  if (!panel) {
    console.log('No dashboard/lab-shadow.json. The writer is tasks/lab_shadow.cjs');
    console.log('(task: SmartEntry Lab Shadow). Absent is not the same as empty — say so.');
    process.exitCode = 1;
    return;
  }
  const rows = panel.candidates || [];
  const out = [];
  const say = (l) => { out.push(l); console.log(l); };

  say('='.repeat(100));
  say('  LAB CURATOR — which staged candidates does the forward evidence still support?');
  say('  ' + new Date().toISOString() + '   panel written ' + (panel.generatedAt || '?'));
  say('  THE BAR (pre-registered): provable <= ' + BAR.MAX_DAYS_TO_PROOF + ' days | silent = >' +
      BAR.SILENT_AFTER_DAYS + 'd and <' + (BAR.SILENT_FIRING_FRACTION * 100) + '% of expected' +
      ' | drift verdict needs >= ' + BAR.MIN_TRADES_FOR_DRIFT_VERDICT + ' trades');
  say('  IT RETIRES NOTHING. It recommends; removing a candidate stays a human decision.');
  say('='.repeat(100));

  if (!rows.length) { say('  Nothing staged.'); if (EMIT) write(out, []); return; }

  const judged = rows.map(c => ({ c, ...judge(c) }));
  const order = { 'RETIRE-UNPROVABLE': 0, 'RETIRE-DRIFTED': 1, 'RETIRE-SILENT': 2, 'WATCH': 3, 'KEEP': 4 };
  judged.sort((a, b) => (order[a.verdict] - order[b.verdict]));

  for (const j of judged) {
    say('');
    say('  ' + j.verdict.padEnd(19) + (j.c.symbol || '?') + ' ' + (j.c.timeframe || '') + '  ' +
        String(j.c.name || '').split('-')[0]);
    say('      ' + (j.c.label || ''));
    say('      ' + j.why);
  }

  const counts = {};
  for (const j of judged) counts[j.verdict] = (counts[j.verdict] || 0) + 1;
  say('');
  say('  ' + Object.entries(counts).map(([k, v]) => v + ' ' + k).join('  |  '));
  const retire = judged.filter(j => j.verdict.startsWith('RETIRE'));
  if (retire.length) {
    say('');
    say('  ' + retire.length + ' candidate(s) the evidence no longer supports. Nothing was removed.');
    say('  To act on one, that is a decision to take deliberately — see tasks/lab_registry.cjs.');
  }
  if (EMIT) write(out, judged);
}

function write(lines, judged) {
  try {
    fs.mkdirSync(path.dirname(REPORT), { recursive: true });
    fs.writeFileSync(REPORT, lines.join('\n') + '\n', 'utf8');
    const at = new Date().toISOString();
    const rows = judged.map(j => JSON.stringify({
      at, specHash: j.c.specHash, name: j.c.name, symbol: j.c.symbol,
      timeframe: j.c.timeframe, verdict: j.verdict, why: j.why,
      forwardTrades: j.c.forwardTrades, forwardExpectancyR: j.c.forwardExpectancyR,
      daysToRequired: j.c.daysToRequired,
    }));
    if (rows.length) fs.appendFileSync(LEDGER, rows.join('\n') + '\n', 'utf8');
    console.log('\nwritten -> ' + REPORT);
    if (rows.length) console.log('appended ' + rows.length + ' row(s) -> ' + LEDGER);
  } catch (err) { console.error('could not write: ' + err.message); }
}

try { main(); } catch (err) {
  console.error('lab_curator failed: ' + (err && err.stack ? err.stack : err));
  process.exitCode = 1;
}
