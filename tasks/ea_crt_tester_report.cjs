#!/usr/bin/env node
'use strict';
/**
 * Read every MT5 Strategy Tester report for EA_CRT_AMD_Dashboard and print one table.
 *
 * WHY THIS EXISTS. On 2026-09-08 the EA's entire backtest campaign - 37 runs on XAUUSD
 * M15 real ticks, including the trail-on/trail-off measurement that set the LIVE config -
 * was found sitting in a Windows TEMP directory from an earlier session, uncommitted.
 * Nothing in the repo could read it, nothing referenced it, and Storage Sense is entitled
 * to delete it. The numbers that decide how this EA trades were folklore backed by files
 * one cleanup away from gone. They are now in tasks/analysis/ea_crt_tester/ and this
 * reads them.
 *
 * TWO TRAPS, both of which returned an empty table before they were found:
 *
 *   1. MT5 writes its reports as UTF-16LE. Read as UTF-8 the labels never match and every
 *      metric comes back null - a clean, plausible, entirely blank result.
 *   2. The value is not adjacent to its label. The label ends a <td>, and the number sits
 *      in the NEXT cell inside <b>...</b>. A regex that scans forward for the first number
 *      after the label finds whitespace and gives up.
 *
 * IT READS ONLY. No tester is launched, no terminal is touched, no EA input is changed.
 *
 * Usage:
 *   node tasks/ea_crt_tester_report.cjs            table, sorted by net profit
 *   node tasks/ea_crt_tester_report.cjs --json     machine-readable, for a ledger
 *   node tasks/ea_crt_tester_report.cjs --dir <d>  read reports from somewhere else
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const DEFAULT_DIR = path.join(PROJECT_ROOT, 'tasks', 'analysis', 'ea_crt_tester');

function strArg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return (i === -1 || i + 1 >= process.argv.length) ? fallback : process.argv[i + 1];
}

const REPORT_DIR = strArg('--dir', DEFAULT_DIR);
const AS_JSON = process.argv.includes('--json');

// Exactly as they appear in an MT5 report, each followed by ':' then a <b> cell.
const METRICS = [
  'Total Net Profit',
  'Profit Factor',
  'Expected Payoff',
  'Balance Drawdown Maximal',
  'Total Trades',
  'Sharpe Ratio',
  'Recovery Factor',
];

// Inputs worth carrying beside the result. Anything else is noise in a comparison table.
const INPUTS = [
  'InpUseTrailingStop',
  'InpUsePartialTP',
  'InpUseBreakEven',
  'InpTradeOnlyAB',
  'InpRiskPercent',
  'InpRiskReward',
  'InpUsePortfolioMode',
];

/** MT5 writes UTF-16LE. Reading it as UTF-8 yields a blank table, not an error. */
function readUtf16(file) {
  try {
    return fs.readFileSync(file).toString('utf16le');
  } catch (err) {
    console.error(`  ! could not read ${path.basename(file)}: ${err.message}`);
    return null;
  }
}

/**
 * The number for `label`. It lives in the NEXT table cell, inside <b>, not next to the
 * label - scanning forward for "the first number" finds whitespace and returns null.
 */
function metric(html, label) {
  const at = html.indexOf(label + ':');
  if (at === -1) return null;
  const cell = html.slice(at, at + 400).match(/<b>([^<]+)<\/b>/);
  return cell ? cell[1].replace(/\s+/g, ' ').trim() : null;
}

/** An .ini value, stripped of the tester's `value||start||step||stop||optimise` suffix. */
function iniValue(text, key) {
  const line = text.split(/\r?\n/).find(l => l.toLowerCase().startsWith(key.toLowerCase() + '='));
  if (!line) return null;
  return line.slice(key.length + 1).split('||')[0].trim();
}

function toNumber(value) {
  if (value === null || value === undefined) return null;
  const n = parseFloat(String(value).replace(/ /g, '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function collect(dir) {
  let names;
  try {
    names = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.htm'));
  } catch (err) {
    // Reports may live in raw/ beside the .ini files.
    return null;
  }
  return names;
}

function main() {
  // Reports were preserved into raw/ to keep 32MB of HTML out of the directory listing,
  // while the .ini files - which are the reproducible part - sit at the top level.
  const rawDir = path.join(REPORT_DIR, 'raw');
  const htmDir = fs.existsSync(rawDir) && collect(rawDir) && collect(rawDir).length ? rawDir : REPORT_DIR;

  const names = collect(htmDir);
  if (!names || !names.length) {
    console.error(`No .htm tester reports under ${htmDir}`);
    console.error('This does NOT mean none were run - check the path before concluding that.');
    process.exitCode = 1;
    return;
  }

  const rows = [];
  for (const name of names.sort()) {
    const html = readUtf16(path.join(htmDir, name));
    if (html === null) continue;
    const run = name.replace(/\.htm$/i, '');

    const row = { run };
    for (const m of METRICS) row[m] = metric(html, m);

    // The .ini says what was actually tested. Without it a row is a number with no claim.
    const iniPath = path.join(REPORT_DIR, run + '.ini');
    row.config = {};
    if (fs.existsSync(iniPath)) {
      const ini = readUtf16(iniPath);
      if (ini) {
        for (const k of ['Symbol', 'Period', 'Model', 'FromDate', 'ToDate', 'Deposit']) {
          row.config[k] = iniValue(ini, k);
        }
        for (const k of INPUTS) {
          const v = iniValue(ini, k);
          if (v !== null) row.config[k] = v;
        }
      }
    } else {
      row.config.MISSING_INI = true;
    }
    rows.push(row);
  }

  rows.sort((a, b) => (toNumber(b['Total Net Profit']) ?? -1e9) - (toNumber(a['Total Net Profit']) ?? -1e9));

  if (AS_JSON) {
    console.log(JSON.stringify({
      generatedAt: new Date().toISOString(),
      reportDir: htmDir,
      runs: rows.length,
      rows,
    }, null, 2));
    return;
  }

  const pad = (v, w) => String(v === null || v === undefined ? '-' : v).padEnd(w);
  const padS = (v, w) => String(v === null || v === undefined ? '-' : v).padStart(w);

  console.log('='.repeat(126));
  console.log(`  EA_CRT_AMD_Dashboard - MT5 Strategy Tester reports   ${new Date().toISOString()}`);
  console.log(`  ${rows.length} run(s) from ${htmDir}`);
  console.log('  Sorted by net profit. Net profit ALONE ranks leverage, not edge - read PF, MaxDD and');
  console.log('  the date range together, and never compare two rows on different FromDate/ToDate.');
  console.log('='.repeat(126));
  console.log('  ' + pad('run', 24) + padS('Net', 10) + padS('PF', 8) + padS('MaxDD', 19) +
    padS('Trades', 8) + padS('Sharpe', 8) + '   ' + pad('trail', 7) + pad('ptp', 7) +
    pad('be', 7) + pad('AB', 7) + pad('risk%', 7) + 'period');

  for (const r of rows) {
    const c = r.config || {};
    const period = (c.FromDate && c.ToDate) ? `${c.FromDate}->${c.ToDate}` : (c.MISSING_INI ? 'NO INI' : '-');
    console.log('  ' + pad(r.run, 24) +
      padS(r['Total Net Profit'], 10) + padS(r['Profit Factor'], 8) +
      padS(r['Balance Drawdown Maximal'], 19) + padS(r['Total Trades'], 8) +
      padS(r['Sharpe Ratio'], 8) + '   ' +
      pad(c.InpUseTrailingStop, 7) + pad(c.InpUsePartialTP, 7) +
      pad(c.InpUseBreakEven, 7) + pad(c.InpTradeOnlyAB ?? (c.MISSING_INI ? null : 'false'), 7) +
      pad(c.InpRiskPercent, 7) + period);
  }

  console.log('='.repeat(126));
  console.log('  trail/ptp/be/AB = InpUseTrailingStop / InpUsePartialTP / InpUseBreakEven / InpTradeOnlyAB');
  console.log('  A row with NO INI cannot be interpreted - its symbol, period and inputs are unknown.');
  console.log('='.repeat(126));
}

try {
  main();
} catch (err) {
  console.error(`ea_crt_tester_report failed: ${err && err.stack ? err.stack : err}`);
  process.exitCode = 1;
}
