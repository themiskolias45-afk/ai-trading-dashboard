#!/usr/bin/env node
'use strict';
/**
 * WHAT IS BEING CAUGHT AND THROWN AWAY?
 *
 * WHY THIS EXISTS. On 2026-09-08 the `tester` agent found mt5_bridge.py:3332 unpacking a
 * 4-tuple into 3 names. It raised ValueError EVERY TIME a close was recovered after an
 * outage - and every caller of reconcile_open_trades() wraps it in `except Exception`, so
 * the error was swallowed and logged as a generic reconciliation failure. The line that
 * would have counted that close toward the circuit breaker never ran. The breaker
 * under-counted precisely when the bridge had been offline.
 *
 * That bug was invisible for as long as it existed, because a broad handler converts a
 * crash into a log line nobody reads. mt5_bridge.py has 41 `except Exception` blocks and
 * server/index.js has 139 catch blocks. Most are correct - an observability path must not
 * take the caller down - but each one is a place where a real defect can hide forever.
 *
 * SO THIS READS THE LOGS FOR WHAT THE HANDLERS WROTE. Not the source. A broad handler is
 * not a bug; a broad handler that is FIRING is a bug that has already happened.
 *
 * IT RANKS BY REPETITION, NOT SEVERITY. A stack trace once, on the day someone restarted a
 * box, is noise. The same exception 400 times is a defect running in production - and
 * that is exactly the shape the ValueError had: silent, repeated, every single recovery.
 *
 * IT NAMES THE EXCEPTION TYPE where the log carries one, because "reconciliation failed"
 * is not actionable and "ValueError: too many values to unpack" is.
 *
 * READ-ONLY. Reads log files, prints. Writes nothing.
 *
 *   node tasks/swallowed_errors.cjs             last 7 days
 *   node tasks/swallowed_errors.cjs --days 30
 *   node tasks/swallowed_errors.cjs --min 5     only patterns seen 5+ times
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LOGS = path.join(ROOT, 'tasks', 'logs');

function numArg(f, d) { const i = process.argv.indexOf(f); if (i === -1) return d; const v = Number(process.argv[i + 1]); return Number.isFinite(v) ? v : d; }
const DAYS = numArg('--days', 7);
const MIN_HITS = numArg('--min', 2);

// Signatures that mean "something threw and was handled". Deliberately not matching the
// word "error" alone: half the log lines in this repo contain it in prose, and a check
// that floods is a check that gets ignored.
const PATTERNS = [
  { re: /\b([A-Z][a-zA-Z]*(?:Error|Exception))\b\s*:?\s*([^\n]{0,90})/g, kind: 'exception' },
  { re: /\b(Traceback \(most recent call last\))/g, kind: 'python-traceback' },
  { re: /\b(ECONNREFUSED|ETIMEDOUT|ENOENT|EPERM|EACCES|EADDRINUSE)\b/g, kind: 'syscall' },
  // CAPTURE GROUP REQUIRED. The first version of this line was /\bfailed\b[^\n]{0,70}/gi
  // with NO group, so m[1] was undefined and 617 distinct log lines collapsed into one
  // row reading "failed undefined" - a confident count attached to no information. The
  // tool's own output has to name the thing it counted, or it is the same defect it
  // exists to find.
  { re: /\b(failed[^\n]{0,70})/gi, kind: 'failed' },
];

// A ZERO COUNT IS A SUCCESS LINE. First run of this tool ranked "132x failed #" at the
// TOP of the report; every one of those was `shipped 3, skipped 0, failed 0` from
// atomic_feed.txt - the healthiest line in the file. Digits are normalised to # so a
// defect collapses to one row, and that normalisation is exactly what made "failed 0"
// indistinguishable from "failed 12". Check the RAW text, before normalisation.
function isZeroCount(raw) { return /^failed\s*[:=]?\s*0\b/i.test(raw); }

// The `failed` pattern is a KEYWORD scan over prose, not evidence that anything threw:
// 37 of its hits were the sentence "failed, so the rest is determined." A thrown
// exception must never be buried underneath a report's own commentary, so the two are
// counted together and REPORTED SEPARATELY.
const THROWN_KINDS = new Set(['exception', 'python-traceback', 'syscall']);

// ── A RECENT FILE IS NOT A RECENT LINE ──────────────────────────────────────────
// This tool selected FILES by mtime and then counted every match inside them, so an
// append-only log contributed months of history to a "last 7 days" report. Measured
// 2026-09-08: it reported 70 JSON SyntaxErrors as current. All 70 stopped on
// 2026-09-01 and 25,000 lines had been appended since - the file was recent, the
// evidence was not. A count with the wrong window attached is worse than no count,
// because it sends someone hunting a defect that already stopped.
//
// So each line carries the most recent timestamp seen ABOVE it. Most lines here have
// no timestamp of their own (`[prices] BTC $78724 ...`), but the server's own start
// banners and the bracketed PowerShell stamps do, and a match inherits the last one.
const STAMP_PATTERNS = [
  /(20\d\d-\d\d-\d\d)T(\d\d:\d\d)/,                       // ISO, e.g. server start banners
  /\[(\d\d)\/(\d\d)\/(20\d\d) (\d\d:\d\d)/,               // [dd/MM/yyyy HH:mm  - the PS wrappers
  /^(20\d\d-\d\d-\d\d) (\d\d:\d\d)/,                      // plain leading date
];
function stampOf(line) {
  let m = STAMP_PATTERNS[0].exec(line);
  if (m) return Date.parse(m[1] + 'T' + m[2] + ':00Z');
  m = STAMP_PATTERNS[1].exec(line);
  if (m) return Date.parse(m[3] + '-' + m[2] + '-' + m[1] + 'T' + m[4] + ':00Z');
  m = STAMP_PATTERNS[2].exec(line);
  if (m) return Date.parse(m[1] + 'T' + m[2] + ':00Z');
  return null;
}

function main() {
  if (!fs.existsSync(LOGS)) { console.error('no tasks/logs directory'); process.exitCode = 1; return; }
  const cutoff = Date.now() - DAYS * 86400000;

  const files = fs.readdirSync(LOGS)
    .filter(f => /\.(txt|log)$/i.test(f) && !/\.bak/i.test(f))
    .map(f => ({ f, p: path.join(LOGS, f) }))
    .filter(x => { try { return fs.statSync(x.p).mtimeMs > cutoff; } catch (e) { return false; } });

  const tally = new Map();   // signature -> {count, files:Set, sample}
  let scanned = 0;

  for (const { f, p } of files) {
    let text = '';
    try {
      const st = fs.statSync(p);
      const fd = fs.openSync(p, 'r');
      // Only the tail of a large log: these reach megabytes and the recent end is what
      // the window is about.
      const len = Math.min(st.size, 2 * 1024 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, Math.max(0, st.size - len));
      fs.closeSync(fd);
      text = buf.toString('utf8');
    } catch (e) { continue; }
    scanned++;

    // Line by line, carrying the last timestamp seen, so a match can be dated.
    let lastStamp = null;
    for (const line of text.split('\n')) {
      const s = stampOf(line);
      if (s !== null && !Number.isNaN(s)) lastStamp = s;

      for (const { re, kind } of PATTERNS) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(line)) !== null) {
          // Normalise: strip digits/paths so the same defect collapses to one row
          // instead of one row per ticket number.
          const raw = (m[1] + (m[2] ? ' ' + m[2] : '')).trim();
          if (kind === 'failed' && isZeroCount(raw)) continue;
          const sig = raw
            .replace(/\d+/g, '#')
            .replace(/[A-Za-z]:\\[^\s"']+/g, '<path>')
            .replace(/\s+/g, ' ')
            .slice(0, 110);
          const key = kind + '|' + sig;
          const cur = tally.get(key) ||
            { kind, sig, inWindow: 0, older: 0, undated: 0, newest: null, files: new Set(), sample: raw.slice(0, 130) };
          if (lastStamp === null) cur.undated++;
          else if (lastStamp >= cutoff) { cur.inWindow++; if (cur.newest === null || lastStamp > cur.newest) cur.newest = lastStamp; }
          else { cur.older++; if (cur.newest === null || lastStamp > cur.newest) cur.newest = lastStamp; }
          cur.files.add(f);
          tally.set(key, cur);
        }
      }
    }
  }

  const all = [...tally.values()];
  // "Live" = seen inside the window, or seen in a log that carries no dates at all.
  // Undated is NOT assumed old: dropping it would hide every timestamp-free log.
  const live = (r) => r.inWindow + r.undated;
  const rows = all.filter(r => live(r) >= MIN_HITS).sort((a, b) => live(b) - live(a));
  const stopped = all.filter(r => live(r) === 0 && r.older >= MIN_HITS).sort((a, b) => b.older - a.older);

  console.log('='.repeat(100));
  console.log('  SWALLOWED ERRORS — what the broad handlers actually wrote. ' + new Date().toISOString());
  console.log('  window ' + DAYS + ' day(s) | ' + scanned + ' log file(s) | showing patterns seen >= ' + MIN_HITS + ' times');
  console.log('  A broad handler is not a bug. A broad handler that is FIRING is a bug that already happened.');
  console.log('='.repeat(100));

  const day = (ms) => ms === null ? 'no date' : new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
  const show = (r, useOlder) => {
    const n = useOlder ? r.older : live(r);
    console.log('');
    console.log('  ' + String(n).padStart(5) + 'x  [' + r.kind + ']  ' + r.sig);
    const notes = [];
    if (r.undated) notes.push(r.undated + ' undated');
    if (!useOlder && r.older) notes.push(r.older + ' older than the window');
    console.log('         last seen ' + day(r.newest) + (notes.length ? '   (' + notes.join(', ') + ')' : ''));
    console.log('         in: ' + [...r.files].slice(0, 4).join(', ') + ([...r.files].length > 4 ? ' (+' + ([...r.files].length - 4) + ')' : ''));
  };

  if (!rows.length && !stopped.length) { console.log('  nothing repeated in this window'); return; }

  const thrown = rows.filter(r => THROWN_KINDS.has(r.kind));
  const keyword = rows.filter(r => !THROWN_KINDS.has(r.kind));

  console.log('');
  console.log('  ── THROWN ' + '─'.repeat(78));
  console.log('  Something raised and a handler caught it. This is the section to act on.');
  if (!thrown.length) console.log('\n  nothing thrown repeatedly in this window');
  thrown.slice(0, 20).forEach(r => show(r, false));

  console.log('');
  console.log('  ── KEYWORD ' + '─'.repeat(77));
  console.log('  A text scan for "failed". Includes prose - 37 hits were once the sentence');
  console.log('  "failed, so the rest is determined." Read these, do not act on the count alone.');
  if (!keyword.length) console.log('\n  none');
  keyword.slice(0, 12).forEach(show);

  console.log('');
  console.log('  ' + thrown.length + ' thrown pattern(s), ' + keyword.length + ' keyword pattern(s).');
  console.log('  Ranked by REPETITION: once is noise, 400 times is production.');
}

try { main(); } catch (err) {
  console.error('swallowed_errors failed: ' + (err && err.message));
  process.exitCode = 1;
}
