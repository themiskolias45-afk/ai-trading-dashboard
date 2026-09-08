#!/usr/bin/env node
'use strict';
/**
 * Alert when an ATOMIC_ANALYST_V84 symbol STOPS being written.
 *
 * WHY THIS EXISTS. On 2026-09-08 the indicator was attached to BTCUSD, SP500 and XAUUSD
 * on the laptop. At 14:32 local the charts reloaded and it came back on TWO of the three
 * - SP500 was silently dropped. Its file then sat unchanged for 112 minutes while
 * BTCUSD and XAUUSD updated every 60 seconds, and nothing said a word. The feed task kept
 * exiting 0, because it was shipping the file it found; the file was simply old.
 *
 * THAT IS THE FAILURE SHAPE THIS WATCHES FOR: not "the job errored" but "the job
 * succeeded at moving nothing". A component that only complains when it throws cannot
 * see a chart that was closed.
 *
 * IT READS THE FILES, NOT THE API, ON PURPOSE. /api/atomic holds an in-memory Map that
 * empties on every server restart, so a fresh server and a dead indicator look identical
 * there for the first few minutes. The files on disk are what the indicator actually
 * wrote, and they survive a restart of anything.
 *
 * THE ROSTER IS LEARNED, NEVER HARDCODED. A symbol is expected once it has been seen
 * writing; the roster persists, so removing a chart raises an alert instead of quietly
 * shrinking the expected set to match. That is the same mistake as a check that adjusts
 * its own baseline until everything passes.
 *
 * IT CHANGES NOTHING - reads files, writes its own state, sends one Telegram. No order,
 * no gate, no halt, and it never deletes a roster entry.
 *
 *   node tasks/atomic_staleness_watch.cjs           check, print verdict
 *   node tasks/atomic_staleness_watch.cjs --notify  and send Telegram on a new stall
 *   node tasks/atomic_staleness_watch.cjs --dry     print only, write nothing
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT  = path.join(__dirname, '..');
const STATE = path.join(ROOT, 'tasks', 'atomic_staleness_state.json');

// The indicator writes every 60s. 30 minutes is the same threshold the server applies in
// ATOMIC_STALE_MINUTES, so this agrees with what the dashboard already shows rather than
// inventing a second definition of "stale".
const STALE_MINUTES = 30;

const DRY    = process.argv.includes('--dry');
const NOTIFY = process.argv.includes('--notify');

function readEnv(key) {
  try {
    const env = fs.readFileSync(path.join(ROOT, 'keys.env'), 'utf8');
    const m = env.match(new RegExp('^\\s*' + key + '\\s*=\\s*(.+)$', 'm'));
    return m ? m[1].trim() : null;
  } catch { return null; }
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { roster: {} }; }
}

// Every terminal on this box, because the indicator may be attached in any of them and
// which terminal owns a symbol is not a thing this script should assume.
function scanFiles() {
  const found = {};
  const base = path.join(os.homedir(), 'AppData', 'Roaming', 'MetaQuotes', 'Terminal');
  let terminals = [];
  try { terminals = fs.readdirSync(base); } catch { return found; }
  for (const t of terminals) {
    const dir = path.join(base, t, 'MQL5', 'Files', 'atomic_analyst');
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.json')); } catch { continue; }
    for (const f of files) {
      const full = path.join(dir, f);
      let mtimeMs = null;
      try { mtimeMs = fs.statSync(full).mtimeMs; } catch { continue; }
      const symbol = f.replace(/\.json$/i, '').toUpperCase();
      const ageMin = (Date.now() - mtimeMs) / 60000;
      // If the same symbol exists under two terminals, the FRESHEST wins - one terminal
      // having it live is enough for the symbol to be feeding.
      if (!found[symbol] || ageMin < found[symbol].ageMinutes) {
        found[symbol] = { symbol, ageMinutes: ageMin, terminal: t.slice(0, 8), file: full };
      }
    }
  }
  return found;
}

function sendTelegram(text) {
  const py = readEnv('SMARTENTRY_PYTHON') || 'python';
  const r  = spawnSync(py, [path.join(ROOT, 'tasks', 'send_telegram.py')], {
    input: text, encoding: 'utf8', timeout: 30000,
  });
  const verdict = ((r.stdout || '') + (r.stderr || '')).trim().split(/\r?\n/)[0] || 'NO OUTPUT';
  return { ok: r.status === 0, verdict };
}

const box   = os.hostname();
const now   = new Date().toISOString();
const state = loadState();
const roster = state.roster && typeof state.roster === 'object' ? state.roster : {};
const found = scanFiles();

// A symbol seen writing is expected from then on. NEVER removed - a vanished file is the
// loudest case, not a reason to forget the symbol ever existed.
for (const sym of Object.keys(found)) {
  if (!roster[sym]) roster[sym] = { firstSeen: now, terminal: found[sym].terminal };
}

const report = [];
for (const sym of Object.keys(roster).sort()) {
  const hit = found[sym];
  const ageMinutes = hit ? hit.ageMinutes : null;
  const gone  = !hit;                                   // file disappeared entirely
  const stale = gone || ageMinutes > STALE_MINUTES;
  const wasStale = state.stalled && state.stalled[sym] === true;
  report.push({
    sym, ageMinutes, gone, stale, wasStale,
    // Rising edge only: alert when it STARTS stalling, and once more when it recovers.
    fired:     stale && !wasStale,
    recovered: !stale && wasStale,
  });
}

if (!report.length) {
  console.log(`${box}: no ATOMIC files have ever been seen on this box - nothing to watch yet`);
  process.exit(0);
}

console.log(`${box} ATOMIC feed (stale > ${STALE_MINUTES}m):`);
for (const r of report) {
  const age = r.gone ? 'FILE GONE' : `${r.ageMinutes.toFixed(1)}m`;
  console.log(`  ${r.sym.padEnd(8)} ${age.padEnd(12)} ${r.stale ? 'STALE' : 'ok'}`);
}

const stalled   = report.filter((r) => r.fired);
const recovered = report.filter((r) => r.recovered);

let sendOk = true;
if ((stalled.length || recovered.length) && NOTIFY && !DRY) {
  const lines = [`ATOMIC FEED - ${box}`, ''];
  if (stalled.length) {
    lines.push(`STOPPED WRITING: ${stalled.map((r) => r.sym).join(', ')}`);
    for (const r of stalled) {
      lines.push(`  ${r.sym}  ${r.gone ? 'file gone entirely' : 'last written ' + r.ageMinutes.toFixed(0) + ' min ago'}`);
    }
    lines.push('');
    lines.push('The indicator is almost certainly no longer attached to that chart.');
    lines.push('Open the symbol H1 chart in MT5 and drag ATOMIC_ANALYST_V84 onto it.');
    lines.push('The feed task keeps exiting 0 either way - it ships whatever file it finds.');
  }
  if (recovered.length) {
    lines.push('');
    lines.push(`WRITING AGAIN: ${recovered.map((r) => r.sym).join(', ')}`);
  }
  lines.push('');
  lines.push('Observation only. ATOMIC gates nothing - no order, no confidence, no stop.');
  const sent = sendTelegram(lines.join('\n'));
  console.log(`TELEGRAM ${sent.verdict}`);
  sendOk = sent.ok;
} else if (stalled.length || recovered.length) {
  console.log(`WOULD ALERT: ${[...stalled, ...recovered].map((r) => r.sym).join(', ')}${DRY ? ' (--dry)' : ' (no --notify)'}`);
}

// State is advanced only when nothing needed sending, or the send was confirmed. A
// refused Telegram must leave the stall still unreported rather than swallowing it.
if (!DRY && sendOk) {
  const nextStalled = {};
  for (const r of report) nextStalled[r.sym] = r.stale;
  const tmp = STATE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ roster, stalled: nextStalled, staleMinutes: STALE_MINUTES, box, at: now }, null, 2));
  fs.renameSync(tmp, STATE);
}
if (!sendOk) process.exit(3);
