'use strict';
/**
 * Patch the configurable riskPercent into a box's server/index.js.
 * Same construction as tasks/_patch_shadow_shorts_route.cjs and for the same reason:
 * the VPS carries commits this repo has never seen, so index.js is patched, never copied.
 * Node, not PowerShell (PS 5.1 mangles the em dashes). CRLF-normalised for matching and
 * restored on write. Idempotent; verified backup; parses before it installs.
 */
const fs = require('fs'), path = require('path'), vm = require('vm');
const DRY = process.argv.includes('--dry-run');
const explicit = process.argv.slice(2).find(a => !a.startsWith('--'));
const TARGET = explicit ? path.resolve(explicit) : path.join(__dirname, '..', 'server', 'index.js');

const LIMITS_ANCHOR = `  fixedLotSize: { min: 0,    max: 100, def: 0,  decimals: 2 },
  maxLotSize:   { min: 0.01, max: 100, def: 10, decimals: 2 },`;
const LIMITS_NEW = LIMITS_ANCHOR + `
  // Per-trade risk budget in PERCENT of balance, used only when fixedLotSize is 0.
  // 1 means 1%, 0.1 means one tenth of one percent — the same units the account
  // config has always used. Default 1 reproduces the hardcoded BASE_RISK_PCT that
  // server/sizing.js used before this key existed, so a box without it is unchanged.
  //
  // It has to be listed HERE or it cannot be set by anything: loadStrategySettings
  // iterates Object.keys(STRATEGY_LIMITS), which is exactly why the RSI ceilings were
  // a reader with no writer until ec88075. 4 decimals because 0.1 must survive.
  //
  // max 3 mirrors MAX_SINGLE_TRADE_RISK in sizing.js, which clamps independently —
  // this bound is the UI's, that one is the engine's, and neither trusts the other.
  riskPercent:  { min: 0.01, max: 3,   def: 1,  decimals: 4 },`;

const CALL_ANCHOR = `    const validation = sizing.validateTrade(signal, accountBalance, openPositions || [], {
      minConfidence: strategySettings.confidenceThreshold,
      valuePerPointBySymbol,
    });`;
const CALL_NEW = `    const validation = sizing.validateTrade(signal, accountBalance, openPositions || [], {
      minConfidence: strategySettings.confidenceThreshold,
      valuePerPointBySymbol,
      // The configured per-trade budget. Absent or unparseable, sizing.js falls back to
      // its own 1% and this route behaves exactly as it did before the key existed.
      riskPercent: strategySettings.riskPercent,
    });`;

function fail(m){ console.error('ABORT: ' + m + ' — nothing was written.'); process.exit(1); }
if (!fs.existsSync(TARGET)) fail('no such file ' + TARGET);
const original = fs.readFileSync(TARGET, 'utf8');
const crlf = (original.match(/\r\n/g) || []).length;
const usesCrlf = crlf > 0;
const norm = usesCrlf ? original.replace(/\r\n/g, '\n') : original;
console.log('target: %s (%d chars, %s)', TARGET, original.length, usesCrlf ? 'CRLF x'+crlf : 'LF');
if (norm.includes('riskPercent:  { min: 0.01')) { console.log('ALREADY PATCHED. Nothing to do.'); process.exit(0); }

let out = norm;
for (const [label, a, b] of [['STRATEGY_LIMITS', LIMITS_ANCHOR, LIMITS_NEW], ['validateTrade call', CALL_ANCHOR, CALL_NEW]]) {
  const n = out.split(a).length - 1;
  if (n !== 1) fail(`anchor for "${label}" matched ${n} times, expected exactly 1`);
  out = out.replace(a, b);
  console.log('  applied: %s', label);
}
try { new vm.Script(out, { filename: TARGET }); } catch (e) { fail('patched source does not parse (' + e.message + ')'); }
console.log('  parses clean (+%d chars)', out.length - norm.length);
const final = usesCrlf ? out.replace(/\n/g, '\r\n') : out;
if (usesCrlf && (final.match(/\r\n/g)||[]).length <= crlf) fail('line-ending restore failed');
if (DRY) { console.log('DRY RUN — nothing written.'); process.exit(0); }
const stamp = new Date().toISOString().replace(/[^0-9]/g,'').slice(0,14);
const backup = `${TARGET}.bak-riskpct-${stamp}`;
const bytes = fs.statSync(TARGET).size;
fs.copyFileSync(TARGET, backup);
if (!fs.existsSync(backup) || fs.statSync(backup).size !== bytes) fail('backup missing or wrong size');
console.log('  backup verified: %s (%d bytes)', path.basename(backup), bytes);
fs.writeFileSync(TARGET, final, 'utf8');
if (!fs.readFileSync(TARGET,'utf8').includes('riskPercent:  { min: 0.01')) { fs.copyFileSync(backup, TARGET); fail('read-back failed; original restored'); }
console.log('PATCHED. Verify by grepping the target.');
