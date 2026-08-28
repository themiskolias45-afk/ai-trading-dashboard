'use strict';
/**
 * Switch a box from fixed lots to risk-based sizing, safely.
 *
 *   node tasks/_set_risk_sizing.cjs --dry-run          # show what would change
 *   node tasks/_set_risk_sizing.cjs --risk-percent 0.1 # apply
 *
 * WHY A SCRIPT AND NOT AN EDITOR. strategy_settings.json must never be written with
 * PowerShell `Set-Content -Encoding utf8`: that emits a UTF-8 BOM, and on 2026-08-02 it
 * silently reset the VPS to built-in defaults, turning fixedLotSize 0.01 into full
 * risk-based sizing with nothing reporting it. Node writes UTF-8 without a BOM, and this
 * asserts the first byte is `{` afterwards rather than trusting that.
 *
 * SAFETY, in order:
 *   - refuses if the file already carries a BOM (that box is already broken; say so);
 *   - refuses if the JSON does not parse, rather than overwriting a file it cannot read;
 *   - takes a timestamped backup and VERIFIES it is non-empty before writing;
 *   - re-reads and re-parses afterwards, restoring the backup if anything is wrong;
 *   - leaves every other key exactly as found — this is not a rewrite, it is two fields.
 *
 * The change is INERT until the server restarts: loadStrategySettings() runs once at
 * startup, so file and memory diverge until then. Restart immediately after.
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const riskIdx = args.indexOf('--risk-percent');
const RISK_PERCENT = riskIdx >= 0 ? Number(args[riskIdx + 1]) : 0.1;

const SETTINGS_PATH = path.join(__dirname, '..', 'server', 'strategy_settings.json');

function fail(message) {
  console.error('ABORT: ' + message + ' — nothing was written.');
  process.exit(1);
}

if (!Number.isFinite(RISK_PERCENT) || RISK_PERCENT <= 0 || RISK_PERCENT > 3) {
  fail(`--risk-percent must be >0 and <=3 (percent units; 0.1 means one tenth of one percent), got ${args[riskIdx + 1]}`);
}
if (!fs.existsSync(SETTINGS_PATH)) fail('no strategy_settings.json at ' + SETTINGS_PATH);

const before = fs.readFileSync(SETTINGS_PATH, 'utf8');
if (before.charCodeAt(0) === 0xFEFF) {
  fail('this file already carries a UTF-8 BOM — the server is probably already running on built-in defaults. Fix that first');
}

let settings;
try {
  settings = JSON.parse(before);
} catch (e) {
  fail('strategy_settings.json does not parse (' + e.message + ')');
}

console.log('current: fixedLotSize=%s riskPercent=%s gate=%s momentumRsiMax=%s',
  settings.fixedLotSize, settings.riskPercent, settings.confidenceThreshold, settings.momentumRsiMax);
console.log('after  : fixedLotSize=0 riskPercent=%s   (everything else untouched)', RISK_PERCENT);

if (settings.fixedLotSize === 0 && settings.riskPercent === RISK_PERCENT) {
  console.log('ALREADY SET. Nothing to do.');
  process.exit(0);
}

settings.fixedLotSize = 0;
settings.riskPercent = RISK_PERCENT;
settings.updatedAt = new Date().toISOString();
settings.updatedBy = 'jarvis-risk-based-sizing';

const output = JSON.stringify(settings, null, 2) + '\n';

if (DRY_RUN) {
  console.log('DRY RUN — nothing written. Would write:');
  console.log(output);
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
const backup = `${SETTINGS_PATH}.bak-risksizing-${stamp}`;
fs.copyFileSync(SETTINGS_PATH, backup);
if (!fs.existsSync(backup) || fs.statSync(backup).size === 0) {
  fail('backup ' + path.basename(backup) + ' missing or empty');
}
console.log('backup verified: %s (%d bytes)', path.basename(backup), fs.statSync(backup).size);

fs.writeFileSync(SETTINGS_PATH, output, { encoding: 'utf8' });

// Read back from disk. A BOM or a parse failure here means restore, not "probably fine".
const readBack = fs.readFileSync(SETTINGS_PATH, 'utf8');
if (readBack.charCodeAt(0) !== 0x7B) {
  fs.copyFileSync(backup, SETTINGS_PATH);
  fail('first byte is not "{" — a BOM was introduced; original restored');
}
let verified;
try {
  verified = JSON.parse(readBack);
} catch (e) {
  fs.copyFileSync(backup, SETTINGS_PATH);
  fail('written file does not parse; original restored');
}
if (verified.fixedLotSize !== 0 || verified.riskPercent !== RISK_PERCENT) {
  fs.copyFileSync(backup, SETTINGS_PATH);
  fail('written values do not match what was asked; original restored');
}

console.log('WRITTEN. fixedLotSize=%s riskPercent=%s, first byte "{", parses clean.',
  verified.fixedLotSize, verified.riskPercent);
console.log('INERT UNTIL RESTART — loadStrategySettings() runs once at startup. Restart the server now.');
