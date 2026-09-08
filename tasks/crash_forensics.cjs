#!/usr/bin/env node
'use strict';
/**
 * Preserve the evidence of every unexpected shutdown, before Windows deletes it.
 *
 * WHY THIS EXISTS. On 2026-09-08 this laptop died three times - 14:27 with bugcheck
 * 0x00020001 (HYPERVISOR_ERROR), then 16:36 and 17:59 with no bugcheck at all. Event 1001
 * named a dump at C:\WINDOWS\Minidump\090826-28500-01.dmp, and MinidumpsCount is 5, so
 * Windows is allowed to roll the only record of why the machine stopped off the end.
 *
 * CORRECTED 2026-09-08. This header used to state that the Minidump directory "is EMPTY"
 * and blame Storage Sense. That was never measured. The directory returns EPERM /
 * "Access is denied" to an unelevated caller - whether it holds dumps is UNKNOWN from
 * here. Storage Sense may also delete them; that remains plausible and unproven. The
 * claim was corrected rather than kept, because a wrong cause in a header is read as
 * fact by the next session.
 *
 * THE FAILURE SHAPE: the crash is logged, the log points at a file, and nobody can say
 * whether the file is there. Nothing errors loudly. The evidence expires, or was never
 * reachable, and both look identical in a report that only counts what it found.
 *
 * SO THIS COPIES, IT NEVER MOVES. Windows keeps its own dumps and does whatever it likes
 * with them; we keep a second copy in tasks/crash_dumps/ where no cleaner is pointed. An
 * archived dump is never overwritten and never deleted - if a name already exists it is
 * left exactly as it is.
 *
 * IT CANNOT BLOCK ANYTHING. It reads the Windows event log, appends to its own ledger,
 * and copies files. No server call, no gate, no halt, no lock on anything a bridge or an
 * executor touches, no network. Every path is wrapped and it ALWAYS exits 0, because it
 * runs at boot alongside Ensure Running and a forensics tool that delays the trading
 * stack coming back is worse than no forensics tool.
 *
 *   node tasks/crash_forensics.cjs            record the last 30 days, rescue dumps
 *   node tasks/crash_forensics.cjs --backfill scan the last 365 days instead
 *   node tasks/crash_forensics.cjs --dry      print what it would do, write nothing
 *   node tasks/crash_forensics.cjs --report   print the ledger, newest first
 */

const fs   = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT       = path.join(__dirname, '..');
const LEDGER     = path.join(ROOT, 'tasks', 'crash_ledger.jsonl');
const DUMP_STORE = path.join(ROOT, 'tasks', 'crash_dumps');

const WINDOWS_ROOT         = process.env.SystemRoot || 'C:\\Windows';
const WINDOWS_MINIDUMP_DIR = path.join(WINDOWS_ROOT, 'Minidump');
const WINDOWS_MEMORY_DUMP  = path.join(WINDOWS_ROOT, 'MEMORY.DMP');

// A kernel dump can be as large as physical RAM. Copying one at boot would stall the
// startup this tool shares with the trading stack, so anything above this is RECORDED as
// skipped rather than copied - the ledger still says the dump existed and how big it was.
const MAX_DUMP_COPY_BYTES = 2 * 1024 * 1024 * 1024;

const DEFAULT_LOOKBACK_DAYS  = 30;
const BACKFILL_LOOKBACK_DAYS = 365;

// The events that together describe a death. 41 is the kernel saying the last shutdown
// was not clean; 1001 carries the bugcheck and the dump path; 6008 carries the wall-clock
// time it actually stopped; 1074 is the opposite - a shutdown someone or something ASKED
// for, kept so a planned reboot is never mistaken for a crash.
const EVENT_IDS = [41, 1001, 6008, 1074];

// Only the codes this machine has actually produced, plus the handful that are their
// usual neighbours. An unknown code is reported as its hex, never guessed at.
const BUGCHECK_NAMES = {
  0x00000000: 'NO BUGCHECK - hard freeze or power cut, nothing was written',
  0x00020001: 'HYPERVISOR_ERROR',
  0x0000001A: 'MEMORY_MANAGEMENT',
  0x0000003B: 'SYSTEM_SERVICE_EXCEPTION',
  0x00000050: 'PAGE_FAULT_IN_NONPAGED_AREA',
  0x0000007E: 'SYSTEM_THREAD_EXCEPTION_NOT_HANDLED',
  0x0000009F: 'DRIVER_POWER_STATE_FAILURE',
  0x00000101: 'CLOCK_WATCHDOG_TIMEOUT',
  0x00000124: 'WHEA_UNCORRECTABLE_ERROR',
  0x00000133: 'DPC_WATCHDOG_VIOLATION',
  0x000000EF: 'CRITICAL_PROCESS_DIED',
};

function bugcheckLabel(code) {
  const hex  = '0x' + Number(code).toString(16).toUpperCase().padStart(8, '0');
  const name = BUGCHECK_NAMES[Number(code)];
  return name ? hex + ' ' + name : hex + ' (unrecognised - look it up, do not guess)';
}

/**
 * Ask Windows for the shutdown events. Returns [] on any failure - a forensics tool that
 * throws at boot is a forensics tool that gets disabled.
 */
function readShutdownEvents(lookbackDays) {
  const ps = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$events = Get-WinEvent -FilterHashtable @{ LogName='System'; Id=" + EVENT_IDS.join(',') +
      "; StartTime=(Get-Date).AddDays(-" + lookbackDays + ") }",
    '$out = foreach ($e in $events) {',
    '  $bc = $null',
    '  if ($e.Id -eq 41 -and $e.Properties.Count -gt 0) { $bc = [int64]$e.Properties[0].Value }',
    '  [pscustomobject]@{',
    "    time     = $e.TimeCreated.ToString('o')",
    '    id       = $e.Id',
    '    provider = $e.ProviderName',
    '    level    = $e.LevelDisplayName',
    '    bugcheck = $bc',
    "    message  = ($e.Message -replace '\\s+', ' ')",
    '  }',
    '}',
    "if ($null -eq $out) { '[]' } else { ,@($out) | ConvertTo-Json -Depth 3 -Compress }",
  ].join('\n');

  const res = spawnSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
    { encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024 });

  if (res.error) {
    console.error('  ! event log query failed: ' + res.error.message);
    return [];
  }
  if (res.status !== 0) {
    console.error('  ! event log query exited ' + res.status + ': ' + String(res.stderr || '').trim().slice(0, 300));
    return [];
  }

  const raw = String(res.stdout || '').trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    // Windows PowerShell 5.1 renders an explicitly-wrapped array as
    // {"value":[...],"Count":n} rather than a bare JSON array. Measured 2026-09-08: the
    // first version of this read that object as ONE event with every field undefined,
    // and reported "1 shutdown-related event" over a log holding 69. Both shapes are
    // handled here because the wrapper depends on the PowerShell edition, not on us.
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.value)) return parsed.value;
    return [parsed];
  } catch (err) {
    console.error('  ! event log output was not JSON: ' + err.message);
    return [];
  }
}

/** Every key already in the ledger, so a re-run appends nothing it has already recorded. */
function existingLedgerKeys() {
  const keys = new Set();
  if (!fs.existsSync(LEDGER)) return keys;

  let text = '';
  try {
    text = fs.readFileSync(LEDGER, 'utf8');
  } catch (err) {
    console.error('  ! could not read ledger: ' + err.message);
    return keys;
  }

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed);
      if (row.key) keys.add(row.key);
    } catch (err) {
      // A torn last line from a crash mid-write is expected. Skip it, keep the rest -
      // never rewrite the file to "clean" it, that is how a ledger loses rows.
    }
  }
  return keys;
}

/** True when a filesystem error means "you were not allowed to look", not "nothing there". */
function isAccessDenied(err) {
  return !!err && (err.code === 'EPERM' || err.code === 'EACCES');
}

/**
 * Copy any dump Windows still has into our own store. Never moves, never overwrites,
 * never deletes.
 *
 * Returns { rescued, blocked }. The `blocked` half is the whole point of the split:
 * C:\Windows\Minidump is unreadable to an unelevated caller, and the first version of
 * this function let that failure fall through to an empty candidate list, so main()
 * announced "no dump files present in Windows to rescue" over a directory it had just
 * been refused. A check that cannot see must say so - reporting clean while blind is
 * the same defect this tool was built to catch in Windows.
 */
function rescueDumps(dryRun) {
  const rescued = [];
  const blocked = [];
  const candidates = [];

  try {
    // readdirSync directly: existsSync also returns false on access-denied, which would
    // silently collapse "blocked" back into "absent" before the catch can tell them apart.
    for (const name of fs.readdirSync(WINDOWS_MINIDUMP_DIR)) {
      if (name.toLowerCase().endsWith('.dmp')) candidates.push(path.join(WINDOWS_MINIDUMP_DIR, name));
    }
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      // Genuinely absent. Windows has written no minidump since this directory last went.
    } else if (isAccessDenied(err)) {
      blocked.push({ path: WINDOWS_MINIDUMP_DIR, reason: 'access denied (' + err.code + ') - run elevated' });
      console.error('  ! BLOCKED: cannot read ' + WINDOWS_MINIDUMP_DIR + ' (' + err.code +
        '). Dumps may exist and are NOT being rescued. Run tasks\\crash_forensics_install.ps1 elevated.');
    } else {
      blocked.push({ path: WINDOWS_MINIDUMP_DIR, reason: String(err && err.message) });
      console.error('  ! could not list ' + WINDOWS_MINIDUMP_DIR + ': ' + err.message);
    }
  }

  try {
    if (fs.existsSync(WINDOWS_MEMORY_DUMP)) candidates.push(WINDOWS_MEMORY_DUMP);
  } catch (err) {
    if (isAccessDenied(err)) {
      blocked.push({ path: WINDOWS_MEMORY_DUMP, reason: 'access denied (' + err.code + ') - run elevated' });
    } else {
      blocked.push({ path: WINDOWS_MEMORY_DUMP, reason: String(err && err.message) });
    }
    console.error('  ! could not stat MEMORY.DMP: ' + err.message);
  }

  if (!candidates.length) return { rescued: rescued, blocked: blocked };

  if (!dryRun) {
    try {
      fs.mkdirSync(DUMP_STORE, { recursive: true });
    } catch (err) {
      console.error('  ! could not create ' + DUMP_STORE + ': ' + err.message);
      return { rescued: rescued, blocked: blocked };
    }
  }

  for (const source of candidates) {
    let size = 0;
    try {
      size = fs.statSync(source).size;
    } catch (err) {
      console.error('  ! could not stat ' + source + ': ' + err.message);
      continue;
    }

    const target = path.join(DUMP_STORE, path.basename(source));

    if (fs.existsSync(target)) {
      rescued.push({ source: source, status: 'already archived', size: size });
      continue;
    }
    if (size > MAX_DUMP_COPY_BYTES) {
      rescued.push({
        source: source,
        status: 'too large to copy at boot (' + (size / 1e9).toFixed(2) + ' GB) - left where Windows put it',
        size: size,
      });
      continue;
    }
    if (dryRun) {
      rescued.push({ source: source, status: 'would copy', size: size });
      continue;
    }

    try {
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      rescued.push({ source: source, target: target, status: 'copied', size: size });
    } catch (err) {
      rescued.push({ source: source, status: 'copy failed: ' + err.message, size: size });
      console.error('  ! copy failed for ' + source + ': ' + err.message);
    }
  }
  return { rescued: rescued, blocked: blocked };
}

function appendRows(rows) {
  const payload = rows.map(function (r) { return JSON.stringify(r); }).join('\n') + '\n';
  try {
    fs.appendFileSync(LEDGER, payload, 'utf8');
    return true;
  } catch (err) {
    console.error('  ! could not append to ledger: ' + err.message);
    return false;
  }
}

function printReport() {
  if (!fs.existsSync(LEDGER)) {
    console.log('No crash ledger yet - run without --report first.');
    return;
  }
  const rows = [];
  for (const line of fs.readFileSync(LEDGER, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { rows.push(JSON.parse(trimmed)); } catch (err) { /* torn line */ }
  }
  rows.sort(function (a, b) { return String(b.time).localeCompare(String(a.time)); });

  console.log('CRASH LEDGER - ' + rows.length + ' record(s), newest first\n');
  for (const row of rows) {
    const tag = row.id === 1074 ? 'PLANNED' : 'UNEXPECTED';
    console.log('  ' + row.time + '  [' + tag + '] id=' + row.id + ' ' + (row.bugcheckLabel || ''));
    if (row.dumps && row.dumps.length) {
      for (const d of row.dumps) console.log('      dump: ' + d.status + ' - ' + d.source);
    }
  }
}

function main() {
  const args     = process.argv.slice(2);
  const dryRun   = args.includes('--dry');
  const backfill = args.includes('--backfill');

  if (args.includes('--report')) { printReport(); return; }

  const lookbackDays = backfill ? BACKFILL_LOOKBACK_DAYS : DEFAULT_LOOKBACK_DAYS;
  console.log('Crash forensics - scanning the last ' + lookbackDays + ' day(s)' +
    (dryRun ? ' (DRY RUN, writes nothing)' : ''));

  const events = readShutdownEvents(lookbackDays);
  console.log('  ' + events.length + ' shutdown-related event(s) in the Windows System log');

  const scan   = rescueDumps(dryRun);
  const dumps  = scan.rescued;
  const blocked = scan.blocked;

  for (const d of dumps) console.log('  dump: ' + d.status + ' - ' + d.source);
  for (const b of blocked) console.log('  COULD NOT READ ' + b.path + ' - ' + b.reason);

  if (!dumps.length && !blocked.length) {
    console.log('  no dump files present in Windows to rescue');
  } else if (!dumps.length && blocked.length) {
    // Never "no dumps" here: we were refused, so whether any exist is unknown.
    console.log('  0 dump(s) rescued, and ' + blocked.length +
      ' location(s) unreadable - this is NOT evidence that no dump exists');
  }

  const known = existingLedgerKeys();
  const fresh = [];

  for (const e of events) {
    const key = e.time + '|' + e.id + '|' + e.provider;
    if (known.has(key)) continue;
    const hasBugcheck = e.bugcheck !== null && e.bugcheck !== undefined;
    fresh.push({
      key: key,
      time: e.time,
      id: e.id,
      provider: e.provider,
      level: e.level || null,
      bugcheck: hasBugcheck ? Number(e.bugcheck) : null,
      bugcheckLabel: (e.id === 41 && hasBugcheck) ? bugcheckLabel(e.bugcheck) : null,
      message: String(e.message || '').slice(0, 500),
      dumps: e.id === 41 ? dumps : [],
      // Additive, and load-bearing: an empty `dumps` with dumpScanBlocked set means
      // "could not look", not "nothing was there". Rows written before 2026-09-08 lack
      // this field, so a reader must treat absent as unknown rather than as false.
      dumpScanBlocked: (e.id === 41 && blocked.length) ? blocked : null,
      recordedAt: new Date().toISOString(),
    });
  }

  if (!fresh.length) {
    console.log('  nothing new to record - ledger already holds every event found');
    return;
  }

  console.log('  ' + fresh.length + ' new event(s) to record');
  for (const row of fresh) {
    const tag = row.id === 1074 ? 'PLANNED' : 'UNEXPECTED';
    console.log('    ' + row.time + ' [' + tag + '] id=' + row.id + ' ' + (row.bugcheckLabel || ''));
  }

  if (dryRun) { console.log('  DRY RUN - nothing written'); return; }
  if (appendRows(fresh)) console.log('  appended to ' + LEDGER);
}

try {
  main();
} catch (err) {
  console.error('crash_forensics failed, and is exiting 0 on purpose: ' + (err && err.message));
}
process.exit(0);
