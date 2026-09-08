#!/usr/bin/env node
'use strict';
/**
 * DID ANY APPEND-ONLY LEDGER EVER SHRINK ACROSS THE ARCHIVES?
 *
 * WHY THIS EXISTS, and why bucket_audit.cjs is not enough. bucket_audit opens the NEWEST
 * archive and confirms the important files are inside it. That proves the backup job
 * works. It cannot prove nothing was LOST, because a backup taken after a deletion
 * faithfully preserves the deletion — every archive from that day on contains the smaller
 * file and every check passes. Asked on 2026-09-08 whether data was safe, bucket_audit
 * said BOTH BUCKETS PRESENT AND FRESH while answering a different question.
 *
 * These ledgers only ever grow: learning.json, journal.json, all_trades_ledger.jsonl,
 * jarvis_memory.json, decision_register.jsonl, rejections.jsonl. A byte count that goes
 * DOWN between two consecutive archives is either a deletion, a truncation, or a rewrite
 * that dropped rows — all three are the thing the "never lose data" rule exists to catch,
 * and none of them raise an error anywhere else.
 *
 * IT ALSO REPORTS RETENTION, because that bounds what this check can see at all. Measured
 * 2026-09-08: 21 archives spanning 3.5 days. A loss older than the oldest archive is
 * invisible here and unrecoverable from here — saying so is the point.
 *
 * READ-ONLY. Opens archives, counts bytes, prints. Writes nothing, deletes nothing.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIRS = ['vps-backups', 'backups', 'data-backups'];

// Append-only by design. Any decrease is a finding, not noise.
const MONOTONIC = [
  'all_trades_ledger.jsonl',
  'jarvis_memory.json',
  'decision_register.jsonl',
  'rejections.jsonl',
  'journal.json',
];

// learning.json and smartentry.db are REWRITTEN rather than appended, so a small
// decrease is normal and a large one is not. Reported separately so a routine rewrite is
// never presented as data loss — a check that cries wolf gets ignored, which is the same
// as not having it.
const REWRITTEN = ['learning.json', 'smartentry.db'];

function entriesOf(zipPath) {
  const ps = 'Add-Type -A System.IO.Compression.FileSystem; ' +
    '$z=[IO.Compression.ZipFile]::OpenRead(' + JSON.stringify(zipPath) + '); ' +
    '$z.Entries | ForEach-Object { $_.Length.ToString() + " " + $_.Name }; $z.Dispose()';
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: 120000 });
    // KEYED ON FULL PATH, NEVER ON BASENAME.
    //
    // These archives contain BACKUPS INSIDE BACKUPS. backup_20260908_190002.zip holds
    // SEVENTEEN files called learning.json: the live one at 1,429 bytes, plus snapshots
    // under logs\prebridge_*, server\_prerestart_*, and vps-livestate-backup\20260730_*
    // at 1,138 / 456 / 87 bytes.
    //
    // The first version of this file keyed on basename with last-wins, so it compared a
    // JULY 30 snapshot against today's live file and reported a 93% loss of learning.json
    // and an emptied smartentry.db. Both were false. That is the exact failure this tool
    // exists to catch, committed by the tool itself - a confident number measured against
    // the wrong object. Full paths are the only way to compare like with like.
    const map = new Map();
    for (const line of out.split(/\r?\n/)) {
      const m = line.trim().match(/^(\d+)\s+(.+)$/);
      if (!m) continue;
      const full = m[2].replace(/\\/g, '/');
      map.set(full, Number(m[1]));
    }
    return map;
  } catch (err) {
    return null;
  }
}

function main() {
  let found = 0;
  for (const d of DIRS) {
    const dir = path.join(ROOT, d);
    if (!fs.existsSync(dir)) continue;
    const zips = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.zip')).sort();
    if (!zips.length) continue;
    found++;

    console.log('='.repeat(92));
    console.log('  ' + d + ' — ' + zips.length + ' archive(s)');
    const first = zips[0].replace(/^backup_|\.zip$/g, '');
    const last = zips[zips.length - 1].replace(/^backup_|\.zip$/g, '');
    console.log('  retention: ' + first + '  ->  ' + last);
    console.log('  A LOSS OLDER THAN THE FIRST ARCHIVE IS INVISIBLE HERE AND UNRECOVERABLE FROM HERE.');
    console.log('='.repeat(92));

    const series = {};
    let unreadable = 0;
    for (const z of zips) {
      const map = entriesOf(path.join(dir, z));
      if (!map) { unreadable++; console.log('  ! UNREADABLE ARCHIVE: ' + z); continue; }
      const tag = z.replace(/^backup_|\.zip$/g, '');
      for (const name of [...MONOTONIC, ...REWRITTEN]) {
        // The LIVE copy only. A path containing a nested backup folder is a historical
        // snapshot that is SUPPOSED to be smaller and older; including it manufactures a
        // shrink that never happened.
        const candidates = [...map.keys()].filter(k => {
          if (k.split('/').pop() !== name) return false;
          return !/(^|\/)(logs|vps-livestate-backup|task_backups|backups)\//i.test(k)
              && !/_prerestart_|prebridge_|\.bak-/i.test(k);
        });
        if (!candidates.length) continue;
        // Prefer the canonical location (server/x or tasks/x) over a loose root copy.
        candidates.sort((a, b) => (a.split('/').length - b.split('/').length) || a.localeCompare(b));
        const chosen = candidates.find(c => c.includes('/')) || candidates[0];
        (series[name] = series[name] || []).push({ tag, size: map.get(chosen), path: chosen });
      }
    }

    console.log('');
    console.log('  ' + 'file'.padEnd(30) + 'seen'.padEnd(7) + 'first -> last'.padEnd(26) + 'verdict');
    for (const name of [...MONOTONIC, ...REWRITTEN]) {
      const h = series[name] || [];
      if (!h.length) { console.log('  ' + name.padEnd(30) + 'ABSENT FROM EVERY ARCHIVE'); continue; }
      const drops = [];
      for (let i = 1; i < h.length; i++) if (h[i].size < h[i - 1].size) drops.push(h[i - 1], h[i]);
      const monotone = MONOTONIC.includes(name);
      let verdict;
      if (!drops.length) verdict = 'never shrank';
      else if (monotone) verdict = 'SHRANK x' + (drops.length / 2) + '  <-- APPEND-ONLY FILE GOT SMALLER';
      else verdict = 'shrank x' + (drops.length / 2) + ' (rewritten file; check size of drop)';
      console.log('  ' + name.padEnd(30) + String(h.length).padEnd(7) +
        (h[0].size + ' -> ' + h[h.length - 1].size).padEnd(26) + verdict);
      for (let i = 0; i < drops.length; i += 2) {
        const a = drops[i], b = drops[i + 1];
        console.log('      ' + a.tag + ' (' + a.size + ')  ->  ' + b.tag + ' (' + b.size +
          ')   lost ' + (a.size - b.size) + ' bytes');
      }
    }
    if (unreadable) console.log('\n  ' + unreadable + ' archive(s) could not be opened — a corrupt archive is not a passing check.');
    console.log('');
  }
  if (!found) {
    console.log('No backup directories found. That is itself the finding.');
    process.exitCode = 1;
  }
}

try { main(); } catch (err) {
  console.error('backup_history_check failed: ' + (err && err.message));
  process.exitCode = 1;
}
