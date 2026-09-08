#!/usr/bin/env node
'use strict';
/**
 * REPEATABLE MT5 STRATEGY TESTER RUNS for EA_CRT_AMD_Dashboard.
 *
 * WHY THIS EXISTS. Until 2026-09-08 this EA had no automated backtest at all. The 37 runs
 * that set its live configuration were driven by hand through the GUI, their .ini files
 * left in a Windows TEMP directory, and the one run that would confirm the best config
 * out-of-sample was never done. A strategy whose settings cannot be re-derived is a
 * strategy running on folklore.
 *
 * WHAT IT DOES. Generates a tester .ini from a known-good template, launches the ISOLATED
 * portable MT5 instance headless, waits for it to shut itself down, parses the report and
 * appends one row to tasks/analysis/ea-crt-backtest-ledger.jsonl.
 *
 * ── SAFETY, AND WHY IT CANNOT TOUCH LIVE TRADING ──────────────────────────────────
 *
 * It runs ONLY the tester install passed as --mt5 (default: the isolated instance built
 * for this purpose, which has its own MetaQuotes data directory). It never enumerates,
 * signals or shuts down a running terminal. The two live terminals - "C:\Program Files\
 * MetaTrader 5" and "%APPDATA%\MetaTrader 5" - are refused outright by assertIsolated(),
 * because ShutdownTerminal=1 in a tester ini would CLOSE a terminal that is trading.
 *
 * It places no order. The Strategy Tester is a simulator; the EA inside it trades a
 * synthetic account and cannot reach a broker.
 *
 * ── THE FILE-FORMAT TRAPS ─────────────────────────────────────────────────────────
 *
 * MT5 reads and writes these files as UTF-16LE WITH A BOM. An ini written as UTF-8 is
 * not rejected - the terminal starts, ignores the config, and either tests nothing or
 * tests the wrong thing, with no error anywhere. Reports have the same encoding.
 *
 * Usage:
 *   node tasks/ea_crt_backtest.cjs --list
 *   node tasks/ea_crt_backtest.cjs --scenario oos_notrail_noptp
 *   node tasks/ea_crt_backtest.cjs --walkforward notrail_noptp
 *   node tasks/ea_crt_backtest.cjs --scenario X --dry     print the ini, run nothing
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const PROJECT_ROOT = path.join(__dirname, '..');
const ANALYSIS_DIR = path.join(PROJECT_ROOT, 'tasks', 'analysis');
const EVIDENCE_DIR = path.join(ANALYSIS_DIR, 'ea_crt_tester');
const LEDGER = path.join(ANALYSIS_DIR, 'ea-crt-backtest-ledger.jsonl');

// A template that is KNOWN to have produced a valid report. Every generated ini is this
// file with a handful of keys replaced, so the ~80 EA inputs it carries stay exactly as
// they were when the campaign was run. Rebuilding the input block by hand is how a run
// silently tests different settings than the one it is being compared against.
const TEMPLATE_INI = path.join(EVIDENCE_DIR, 'notrail_noptp.ini');

// Live terminals. Never a valid --mt5 target: ShutdownTerminal=1 would close one mid-trade.
const FORBIDDEN_INSTALLS = [
  'c:\\program files\\metatrader 5',
  path.join(os.homedir(), 'AppData', 'Roaming', 'MetaTrader 5').toLowerCase(),
];

function strArg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return (i === -1 || i + 1 >= process.argv.length) ? fallback : process.argv[i + 1];
}

const DRY = process.argv.includes('--dry');
const TIMEOUT_MS = Number(strArg('--timeout', '3600')) * 1000;

/**
 * Where the isolated tester lives. It was built in a session scratchpad, which is
 * volatile - so this searches rather than hardcoding one dead path, and says plainly when
 * it finds nothing instead of falling back to a live install.
 */
function findTesterInstall() {
  const explicit = strArg('--mt5', null);
  if (explicit) return explicit;

  const tempRoot = path.join(os.homedir(), 'AppData', 'Local', 'Temp', 'claude',
    'C--Users-User-ai-trading-dashboard');
  const candidates = [];
  try {
    for (const session of fs.readdirSync(tempRoot)) {
      const guess = path.join(tempRoot, session, 'scratchpad', 'mt5test');
      if (fs.existsSync(path.join(guess, 'terminal64.exe'))) candidates.push(guess);
    }
  } catch (err) { /* temp root may not exist; handled by the empty return */ }

  if (!candidates.length) return null;
  // Newest first: a later session's instance is the one with current tick history.
  candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return candidates[0];
}

/**
 * The tester loads the EA from the terminal's DATA directory, not its install directory.
 *
 * Measured 2026-09-08: this instance runs NON-portable (portable.txt sits in the data dir,
 * where it does nothing - it is only honoured in the install dir), so its MQL5 root is
 * %APPDATA%\MetaQuotes\Terminal\<hash>\MQL5 while the compiled EA had only ever been put
 * in <install>\MQL5. The terminal started, authorised, logged
 *   "Experts\EA_CRT_AMD_Dashboard\EA_CRT_AMD_Dashboard.ex5 not found"
 *   "tester didn't start"
 * and exited -1000012355 in 10 seconds having written nothing. From outside, a failed run
 * and a run with no trades look identical, so this is checked BEFORE launching.
 *
 * Returns the resolved data directory, or throws naming the exact missing path.
 */
function assertExpertPresent(install, expertRelative) {
  const logLine = (() => {
    // The data dir is whatever the terminal last logged; derive it from origin.txt files
    // rather than guessing a hash.
    const termRoot = path.join(os.homedir(), 'AppData', 'Roaming', 'MetaQuotes', 'Terminal');
    let dirs = [];
    try { dirs = fs.readdirSync(termRoot); } catch (err) { return null; }
    for (const d of dirs) {
      const origin = path.join(termRoot, d, 'origin.txt');
      try {
        if (!fs.existsSync(origin)) continue;
        // origin.txt is UTF-16LE with a BOM, like every other file MT5 writes. Read as
        // UTF-8 it becomes "C\0:\0\\\0U\0s\0..." which matches nothing, and this function
        // then reports "could not resolve the data directory" for a directory that is
        // sitting right there. Third UTF-16 trap in this toolchain; assume it, don't hope.
        const text = fs.readFileSync(origin).toString('utf16le').replace(/^﻿/, '');
        if (text.trim().toLowerCase() === path.resolve(install).toLowerCase()) {
          return path.join(termRoot, d);
        }
      } catch (err) { /* unreadable origin.txt - keep looking */ }
    }
    return null;
  })();

  // Portable mode keeps everything in the install dir; otherwise it is the data dir.
  const dataDir = fs.existsSync(path.join(install, 'portable.txt')) ? install : logLine;
  if (!dataDir) {
    throw new Error(`Could not resolve the data directory for ${install}\n` +
      `  No %APPDATA%\\MetaQuotes\\Terminal\\<hash>\\origin.txt points at it, and there is ` +
      `no portable.txt in the install.`);
  }

  const expertPath = path.join(dataDir, 'MQL5', 'Experts', expertRelative);
  if (!fs.existsSync(expertPath)) {
    throw new Error(
      `Expert not found where the tester will look:\n  ${expertPath}\n` +
      `  The tester resolves Expert= against the DATA directory, not the install.\n` +
      `  A missing .ex5 makes the terminal exit in ~10s having written no report, which is ` +
      `indistinguishable from a run that simply took no trades.\n` +
      `  Copy the compiled EA there - and copy the SAME binary the other runs used, or the ` +
      `comparison is confounded.`);
  }
  return { dataDir, expertPath };
}

/** Refuse to drive a terminal that might be trading. */
function assertIsolated(install) {
  const norm = path.resolve(install).toLowerCase().replace(/[\\/]+$/, '');
  for (const forbidden of FORBIDDEN_INSTALLS) {
    if (norm === forbidden.replace(/[\\/]+$/, '')) {
      throw new Error(
        `REFUSING to run the tester in ${install}\n` +
        `  That is a LIVE terminal. A tester ini carries ShutdownTerminal=1, which would ` +
        `close it while it may hold positions.\n` +
        `  Point --mt5 at an isolated install.`);
    }
  }
}

function readUtf16(file) { return fs.readFileSync(file).toString('utf16le'); }

/** MT5 requires UTF-16LE with a BOM. UTF-8 is accepted silently and then ignored. */
function writeUtf16(file, text) {
  const withBom = text.charCodeAt(0) === 0xFEFF ? text : '\uFEFF' + text;
  fs.writeFileSync(file, Buffer.from(withBom, 'utf16le'));
}

/**
 * Replace `key=` lines inside one ini section, preserving every other line.
 * EA inputs carry a `value||start||step||stop||optimise` suffix which must be kept, or
 * the tester reads the field as an optimisation range rather than a fixed value.
 */
function patchIni(text, testerKeys, inputKeys) {
  const lines = text.split(/\r?\n/);
  let section = '';
  const seenTester = new Set();

  const out = lines.map((line) => {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) { section = header[1].toLowerCase(); return line; }

    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!kv) return line;
    const key = kv[1];

    if (section === 'tester' && Object.prototype.hasOwnProperty.call(testerKeys, key)) {
      seenTester.add(key);
      return `${key}=${testerKeys[key]}`;
    }
    if (section === 'testerinputs' && Object.prototype.hasOwnProperty.call(inputKeys, key)) {
      const parts = kv[2].split('||');
      parts[0] = String(inputKeys[key]);
      return `${key}=${parts.join('||')}`;
    }
    return line;
  });

  // A Tester key that did not exist in the template would otherwise be dropped in silence.
  const missing = Object.keys(testerKeys).filter(k => !seenTester.has(k));
  if (missing.length) {
    throw new Error(`template has no [Tester] key(s): ${missing.join(', ')} - refusing to ` +
      `run a config that differs from what was asked for`);
  }
  return out.join('\r\n');
}

/**
 * Read the terminal's own verdict on the last pass out of today's log.
 *
 * The tester reports failure in the LOG, not in the report file - the report is written
 * either way. Returns the offending line, or null if the log says nothing damning.
 */
function testerFailureInLog(dataDir) {
  try {
    const logDir = path.join(dataDir, 'logs');
    const logs = fs.readdirSync(logDir).filter(f => f.endsWith('.log'))
      .map(f => ({ f, m: fs.statSync(path.join(logDir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    if (!logs.length) return null;
    const text = fs.readFileSync(path.join(logDir, logs[0].f)).toString('utf16le');
    const lines = text.split(/\r?\n/).slice(-400);
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i];
      if (/some error after pass finished|tester didn't start|not found|no history data|testing error/i.test(l)) {
        return l.replace(/\s+/g, ' ').trim().slice(0, 220);
      }
      if (/last test passed with result/i.test(l)) return null; // a clean pass ends the search
    }
    return null;
  } catch (err) {
    // Cannot read the log. Say nothing rather than assert success - the trade-count
    // check below is the second gate.
    return null;
  }
}

/** Headline metrics out of an MT5 report. Value sits in the NEXT cell, inside <b>. */
function parseReport(file) {
  const html = readUtf16(file);
  const metric = (label) => {
    const at = html.indexOf(label + ':');
    if (at === -1) return null;
    const m = html.slice(at, at + 400).match(/<b>([^<]+)<\/b>/);
    return m ? m[1].replace(/\s+/g, ' ').trim() : null;
  };
  return {
    netProfit: metric('Total Net Profit'),
    profitFactor: metric('Profit Factor'),
    expectedPayoff: metric('Expected Payoff'),
    maxDrawdown: metric('Balance Drawdown Maximal'),
    totalTrades: metric('Total Trades'),
    sharpe: metric('Sharpe Ratio'),
    recoveryFactor: metric('Recovery Factor'),
  };
}

// ── Scenarios ─────────────────────────────────────────────────────────────────────
//
// `inputs` are EA inputs; anything omitted keeps the template's value. The template is
// notrail_noptp: trail OFF, partial TP OFF, break-even ON, AB OFF, risk 0.5, RR 2.0.
//
// FULL/IS/OOS boundaries match the original campaign exactly, so a new run is comparable
// with the 37 already on record. Changing a boundary makes every prior row incomparable.
const FULL = { from: '2025.04.01', to: '2026.04.28' };
const IS   = { from: '2025.04.01', to: '2025.12.19' };
const OOS  = { from: '2025.12.19', to: '2026.04.28' };

const SCENARIOS = {
  // THE MISSING RUN. notrail_noptp scored best over the FULL period (+562.38, PF 1.19,
  // MaxDD 6.70%) but was never tested out-of-sample, so its margin over notrail
  // (+536.27) is unvalidated. This is the single run that decides whether partial TP
  // should be turned off on the live EA.
  oos_notrail_noptp: { period: OOS, inputs: { InpUsePartialTP: 'false' } },
  is_notrail_noptp:  { period: IS,  inputs: { InpUsePartialTP: 'false' } },

  // Controls, re-run so the comparison is same-harness rather than same-memory.
  oos_notrail:       { period: OOS, inputs: { InpUsePartialTP: 'true' } },
  is_notrail:        { period: IS,  inputs: { InpUsePartialTP: 'true' } },
  full_notrail_noptp:{ period: FULL, inputs: { InpUsePartialTP: 'false' } },
  full_notrail:      { period: FULL, inputs: { InpUsePartialTP: 'true' } },
};

// Quarterly folds, the honest view. The full-period figure hides that one quarter carried
// 75% of the profit; a config that only survives on the mean is a config that loses money
// in the year that matters.
const FOLDS = [
  { name: 'q1', from: '2025.04.01', to: '2025.07.01' },
  { name: 'q2', from: '2025.07.01', to: '2025.10.01' },
  { name: 'q3', from: '2025.10.01', to: '2026.01.01' },
  { name: 'q4', from: '2026.01.01', to: '2026.04.28' },
];

function runOne(install, reportName, period, inputs, dataDirForRun) {
  let template = readUtf16(TEMPLATE_INI);

  // THE [Common] LOGIN IS REQUIRED. Keep it.
  //
  // I removed it on 2026-09-08 reasoning that the Strategy Tester simulates against local
  // history and needs no live session. MEASURED, AND WRONG: the terminal refused with
  //   "tester not started because the account is not specified"  (exit -1000012353)
  // in 5 seconds. The tester takes symbol specification and trade-server context from the
  // account, so there is no accountless mode to fall back to.
  //
  // WHAT REMAINS TRUE, AND IS A REAL CAVEAT: that account (11581419, VantageMarkets-Demo)
  // is the one the VPS trades. On the run that did connect, the log showed
  //   'connection to VantageMarkets-Demo lost'  then  're-authorized'  then
  //   'previous successful authorization performed from 80.42.47.168'  (the VPS)
  // which is consistent with two terminals contending for one demo login. The original
  // 37-run campaign used this same account, so this is the status quo rather than a new
  // risk - but it is a shared account, and a tester run here may disturb the VPS session.
  // Point --login at a separate demo account to remove the contention properly.
  const loginOverride = strArg('--login', null);
  if (loginOverride) {
    template = template.replace(/^Login=.*$/mi, `Login=${loginOverride}`);
  }

  const ini = patchIni(template, {
    FromDate: period.from,
    ToDate: period.to,
    Report: reportName,
    ReplaceReport: '1',
    ShutdownTerminal: '1',
    Visual: '0',
    Optimization: '0',
  }, inputs || {});

  // Report= resolves against the DATA directory, not the install directory. Measured
  // 2026-09-08: the run wrote to %APPDATA%\MetaQuotes\Terminal\<hash>\ while this looked
  // in the install dir and declared "no report produced" over a report that existed.
  // Both are checked, data dir first.
  const iniPath = path.join(install, `${reportName}.ini`);
  const reportCandidates = [
    path.join(dataDirForRun, `${reportName}.htm`),
    path.join(install, `${reportName}.htm`),
  ];
  const findReport = () => reportCandidates.find(p => fs.existsSync(p)) || null;

  if (DRY) {
    console.log(`--- ${reportName}.ini (DRY, not written) ---`);
    console.log(ini.split(/\r?\n/).slice(0, 24).join('\n'));
    console.log(`... [TesterInputs] preserved from ${path.basename(TEMPLATE_INI)}`);
    return { run: reportName, dryRun: true };
  }

  writeUtf16(iniPath, ini);
  // Never silently reuse a stale report if the tester fails to produce a new one.
  for (const p of reportCandidates) {
    try { if (fs.existsSync(p)) fs.renameSync(p, p + '.prev'); } catch (e) { /* keep going */ }
  }

  const exe = path.join(install, 'terminal64.exe');

  // /portable is REQUIRED, not implied by portable.txt. Measured 2026-09-08 on build
  // 6182: with portable.txt sitting in the install directory the terminal STILL logged
  // its data path as %APPDATA%\MetaQuotes\Terminal\<hash> and still found no tick history,
  // because the 864MB cache and the EA are in the install tree. Passing the switch is what
  // actually moves it. Everything the campaign used - EA, ticks, its own reports - lives
  // in the install directory, so portable is the mode this instance was built for.
  const args = [];
  if (fs.existsSync(path.join(install, 'portable.txt'))) args.push('/portable');
  args.push(`/config:${iniPath}`);

  console.log(`  running ${reportName}  ${period.from} -> ${period.to}  [${args[0] === '/portable' ? 'portable' : 'non-portable'}] ...`);
  const started = Date.now();
  const res = spawnSync(exe, args, { timeout: TIMEOUT_MS, encoding: 'utf8' });
  const secs = Math.round((Date.now() - started) / 1000);

  if (res.error) {
    console.error(`  ! ${reportName}: ${res.error.message}`);
    return { run: reportName, ok: false, error: res.error.message, seconds: secs };
  }

  const reportPath = findReport();
  if (!reportPath) {
    console.error(`  ! ${reportName}: terminal exited after ${secs}s but wrote NO report.`);
    console.error(`    Looked in:\n      ${reportCandidates.join('\n      ')}`);
    console.error(`    That is a failed run, not a zero result - do not record it as one.`);
    return { run: reportName, ok: false, error: 'no report produced', seconds: secs };
  }

  // A FAILED PASS STILL WRITES A REPORT, and it reads as a clean zero.
  // Measured 2026-09-08: the terminal logged
  //   'last test passed with result "some error after pass finished" in 0:00:00.000'
  // and wrote a report whose Total Net Profit was 0. Recording that as a result would put
  // a fabricated zero into the ledger beside 37 real runs. A pass that traded nothing over
  // four months of gold is a broken run, not a finding, so it is refused here.
  const failure = testerFailureInLog(dataDirForRun);
  const metrics = parseReport(reportPath);
  const tradeCount = Number(String(metrics.totalTrades ?? '').replace(/[^\d-]/g, ''));
  if (failure || !(tradeCount > 0)) {
    console.error(`  ! ${reportName}: report written but the pass did not produce trades.`);
    if (failure) console.error(`    terminal log: ${failure}`);
    console.error(`    Refusing to record a zero that came from a failed pass.`);
    return {
      run: reportName, ok: false, seconds: secs,
      error: failure || `report parsed but totalTrades=${metrics.totalTrades}`,
      reportPath,
    };
  }
  const row = {
    run: reportName,
    ok: true,
    seconds: secs,
    from: period.from, to: period.to,
    inputs: inputs || {},
    ...metrics,
    reportPath,
    recordedAt: new Date().toISOString(),
  };
  console.log(`    net ${metrics.netProfit}  PF ${metrics.profitFactor}  ` +
    `DD ${metrics.maxDrawdown}  trades ${metrics.totalTrades}  (${secs}s)`);
  return row;
}

/**
 * Sweep one EA input across values, on ONE period.
 *
 * TUNE ON IN-SAMPLE, CONFIRM ON OUT-OF-SAMPLE - never the reverse. The partial-TP result
 * on 2026-09-08 is exactly why: it won by +26 over the FULL period, which includes the
 * held-out window, and then LOST by -30 on the held-out window alone. A sweep run against
 * OOS data picks the value that best fits the only data left to check it with, and there
 * is then nothing honest left to validate against.
 *
 * `--period is` is therefore the default, and a sweep on oos prints a warning.
 */
function parseSweep(spec) {
  const eq = spec.indexOf('=');
  if (eq === -1) throw new Error(`--sweep needs Input=v1,v2,v3 (got "${spec}")`);
  const input = spec.slice(0, eq).trim();
  const values = spec.slice(eq + 1).split(',').map(v => v.trim()).filter(Boolean);
  if (!input || !values.length) throw new Error(`--sweep needs an input and at least one value`);
  return { input, values };
}

function appendLedger(rows) {
  try {
    fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
    fs.appendFileSync(LEDGER, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    console.log(`\nappended ${rows.length} row(s) -> ${LEDGER}`);
  } catch (err) {
    console.error(`could not append ledger: ${err.message}`);
  }
}

function main() {
  if (process.argv.includes('--list')) {
    console.log('Scenarios:');
    for (const [name, s] of Object.entries(SCENARIOS)) {
      console.log(`  ${name.padEnd(22)} ${s.period.from} -> ${s.period.to}  ${JSON.stringify(s.inputs)}`);
    }
    console.log('\nWalk-forward folds:');
    for (const f of FOLDS) console.log(`  ${f.name.padEnd(22)} ${f.from} -> ${f.to}`);
    return;
  }

  if (!fs.existsSync(TEMPLATE_INI)) {
    console.error(`Template ini missing: ${TEMPLATE_INI}`);
    console.error('It is one of the 37 preserved runs - restore tasks/analysis/ea_crt_tester/ first.');
    process.exitCode = 1;
    return;
  }

  const install = findTesterInstall();
  if (!install) {
    console.error('No isolated MT5 tester install found.');
    console.error('It lived in a session scratchpad (volatile) and may have been cleaned.');
    console.error('Pass --mt5 <dir>, or rebuild it - note that re-downloading tick history');
    console.error('is the expensive part (~3.4GB was already fetched).');
    process.exitCode = 1;
    return;
  }
  assertIsolated(install);

  // The Expert= line the template will actually use, checked before anything is launched.
  const expertRel = (() => {
    const m = readUtf16(TEMPLATE_INI).match(/^Expert=(.+)$/m);
    return m ? m[1].trim() : null;
  })();
  if (!expertRel) throw new Error(`template ${TEMPLATE_INI} has no Expert= line`);
  const { dataDir, expertPath } = assertExpertPresent(install, expertRel);

  console.log(`tester install: ${install}`);
  console.log(`data dir      : ${dataDir}`);
  console.log(`expert        : ${expertPath}`);
  console.log(`template      : ${path.basename(TEMPLATE_INI)}\n`);

  const wf = strArg('--walkforward', null);
  const scenario = strArg('--scenario', null);
  const sweep = strArg('--sweep', null);
  const rows = [];

  if (sweep) {
    const { input, values } = parseSweep(sweep);
    const which = String(strArg('--period', 'is')).toLowerCase();
    const period = which === 'oos' ? OOS : which === 'full' ? FULL : IS;
    if (which === 'oos') {
      console.log('  *** SWEEPING ON OUT-OF-SAMPLE DATA. The winner cannot then be validated ***');
      console.log('  *** against anything - you are choosing the value that best fits the    ***');
      console.log('  *** only held-out window you have. Prefer --period is.                  ***\n');
    }
    console.log(`sweeping ${input} over [${values.join(', ')}] on ${which.toUpperCase()} ` +
      `(${period.from} -> ${period.to})\n`);
    // Every sweep sits on the LIVE configuration, not on the template's own inputs. The
    // template is notrail_noptp (partial TP OFF), and partial TP OFF was measured on
    // 2026-09-08 to be WORSE out of sample - 403.06 vs 432.82. Sweeping on top of it would
    // tune a variant we have already rejected and quietly compare it against the live one.
    for (const v of values) {
      const safe = String(v).replace(/[^A-Za-z0-9.-]/g, '_');
      rows.push(runOne(install, `sweep_${input}_${safe}`, period,
        { ...LIVE_BASE, [input]: v }, dataDir));
    }
  } else if (wf) {
    const base = SCENARIOS[wf];
    if (!base) { console.error(`Unknown scenario for --walkforward: ${wf}`); process.exitCode = 1; return; }
    for (const f of FOLDS) {
      rows.push(runOne(install, `${wf}_${f.name}`, { from: f.from, to: f.to }, base.inputs, dataDir));
    }
  } else if (scenario) {
    const s = SCENARIOS[scenario];
    if (!s) { console.error(`Unknown scenario: ${scenario}. Try --list.`); process.exitCode = 1; return; }
    rows.push(runOne(install, scenario, s.period, s.inputs, dataDir));
  } else {
    console.error('Nothing to do. Pass --scenario <name>, --walkforward <name>, or --list.');
    process.exitCode = 1;
    return;
  }

  if (!DRY && rows.length) appendLedger(rows);
  if (rows.some(r => r.ok === false)) process.exitCode = 1;
}

try {
  main();
} catch (err) {
  console.error(`ea_crt_backtest failed: ${err && err.message ? err.message : err}`);
  process.exitCode = 1;
}
