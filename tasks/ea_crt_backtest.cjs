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

function runOne(install, reportName, period, inputs) {
  const template = readUtf16(TEMPLATE_INI);
  const ini = patchIni(template, {
    FromDate: period.from,
    ToDate: period.to,
    Report: reportName,
    ReplaceReport: '1',
    ShutdownTerminal: '1',
    Visual: '0',
    Optimization: '0',
  }, inputs || {});

  const iniPath = path.join(install, `${reportName}.ini`);
  const reportPath = path.join(install, `${reportName}.htm`);

  if (DRY) {
    console.log(`--- ${reportName}.ini (DRY, not written) ---`);
    console.log(ini.split(/\r?\n/).slice(0, 24).join('\n'));
    console.log(`... [TesterInputs] preserved from ${path.basename(TEMPLATE_INI)}`);
    return { run: reportName, dryRun: true };
  }

  writeUtf16(iniPath, ini);
  // Never silently reuse a stale report if the tester fails to produce a new one.
  try { if (fs.existsSync(reportPath)) fs.renameSync(reportPath, reportPath + '.prev'); } catch (e) { /* keep going */ }

  const exe = path.join(install, 'terminal64.exe');
  console.log(`  running ${reportName}  ${period.from} -> ${period.to} ...`);
  const started = Date.now();
  const res = spawnSync(exe, [`/config:${iniPath}`], { timeout: TIMEOUT_MS, encoding: 'utf8' });
  const secs = Math.round((Date.now() - started) / 1000);

  if (res.error) {
    console.error(`  ! ${reportName}: ${res.error.message}`);
    return { run: reportName, ok: false, error: res.error.message, seconds: secs };
  }
  if (!fs.existsSync(reportPath)) {
    console.error(`  ! ${reportName}: terminal exited after ${secs}s but wrote NO report.`);
    console.error(`    That is a failed run, not a zero result - do not record it as one.`);
    return { run: reportName, ok: false, error: 'no report produced', seconds: secs };
  }

  const metrics = parseReport(reportPath);
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
  console.log(`tester install: ${install}`);
  console.log(`template      : ${path.basename(TEMPLATE_INI)}\n`);

  const wf = strArg('--walkforward', null);
  const scenario = strArg('--scenario', null);
  const rows = [];

  if (wf) {
    const base = SCENARIOS[wf];
    if (!base) { console.error(`Unknown scenario for --walkforward: ${wf}`); process.exitCode = 1; return; }
    for (const f of FOLDS) {
      rows.push(runOne(install, `${wf}_${f.name}`, { from: f.from, to: f.to }, base.inputs));
    }
  } else if (scenario) {
    const s = SCENARIOS[scenario];
    if (!s) { console.error(`Unknown scenario: ${scenario}. Try --list.`); process.exitCode = 1; return; }
    rows.push(runOne(install, scenario, s.period, s.inputs));
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
