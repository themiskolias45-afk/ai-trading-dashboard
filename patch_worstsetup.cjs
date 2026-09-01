'use strict';
// Anchored, line-based, idempotent patch for the Sunday worst-setup floor.
// Never copies a file between boxes: the two index.js differ by 22 lines outside
// the engine functions, so a wholesale copy would silently clobber that.
const fs = require('fs');
const { execFileSync } = require('child_process');

const target = process.argv[2];
if (!target) { console.error('usage: node patch_worstsetup.cjs <path to index.js>'); process.exit(2); }

const raw = fs.readFileSync(target, 'utf8');
if (raw.indexOf('WORST_SETUP_MAX_WR') !== -1) { console.log('ALREADY PATCHED - no change'); process.exit(0); }

const eol = raw.indexOf('\r\n') !== -1 ? '\r\n' : '\n';
const lines = raw.split(/\r?\n/);

const ANCHOR = 'let worstSetup = null, worstWR = 1;';
const GUARD  = 'if (!worstSetup) return;';

const anchorAt = lines.reduce((acc, l, i) => (l.trim() === ANCHOR ? acc.concat(i) : acc), []);
if (anchorAt.length !== 1) { console.error(`REFUSING: anchor found ${anchorAt.length} time(s), expected exactly 1`); process.exit(1); }
const i = anchorAt[0];

const guardAt = lines.reduce((acc, l, k) => (l.trim() === GUARD && k > i && k - i <= 10 ? acc.concat(k) : acc), []);
if (guardAt.length !== 1) { console.error(`REFUSING: guard found ${guardAt.length} time(s) within 10 lines of the anchor, expected exactly 1`); process.exit(1); }
const j = guardAt[0];

const indent = (lines[i].match(/^\s*/) || [''])[0];
const before = [
  '// A setup is only worth a "tighten or disable" recommendation if it is actually',
  '// LOSING. The loop below is an argmin over whatever cleared the sample gate, and an',
  '// argmin of one element is that element - so when exactly one setup has >= 3 closed',
  '// trades it is nominated as "worst" no matter how well it did, beating the sentinel',
  '// worstWR = 1 trivially.',
  '//',
  '// Not hypothetical: tasks/improvement_proposal.json generated 2026-08-30T20:00:00Z',
  '// read "MOMENTUM has 66.7% WR - review and tighten entry criteria or disable" while',
  '// MOMENTUM was the only bucket with a POSITIVE win rate. BB_SQUEEZE_WATCH (0%,',
  '// -449.72), RANGE_TRADE_SHORT (0%, -99.10) and SQUEEZE_BREAKOUT (0%, -6.64) each',
  '// held one closed trade, so all three `continue` and went unmentioned. The system',
  '// recommended disabling its best setup and stayed silent about its three worst, on',
  '// /api/checksystem, which is the operator\'s main status surface.',
  '//',
  '// 0.5 and not higher: at exactly 2W/2L the proposal is still written. This floor',
  '// suppresses a recommendation against a WINNING setup, not against a mediocre one.',
  'const WORST_SETUP_MAX_WR = 0.5;',
  '',
].map(s => (s ? indent + s : ''));

const after = [
  'if (worstWR > WORST_SETUP_MAX_WR) {',
  '  console.log(`[agent] No proposal: lowest-WR eligible setup ${worstSetup} is at `',
  '    + `${(worstWR * 100).toFixed(1)}% WR - nothing is underperforming.`);',
  '  return;',
  '}',
].map(s => indent + s);

const out = [].concat(lines.slice(0, i), before, lines.slice(i, j + 1), after, lines.slice(j + 1));

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
const bak = `${target}.bak-worstsetupfloor-${stamp}`;
fs.copyFileSync(target, bak);
if (!fs.existsSync(bak)) { console.error('REFUSING: backup did not land'); process.exit(1); }
console.log(`backup: ${bak} (${fs.statSync(bak).size} bytes)`);

fs.writeFileSync(target, out.join(eol), 'utf8');
try {
  execFileSync(process.execPath, ['--check', target], { stdio: 'pipe' });
  console.log('node --check PASS');
} catch (e) {
  fs.copyFileSync(bak, target);
  console.error('node --check FAILED - ROLLED BACK from backup');
  console.error(String(e.stderr || e.message));
  process.exit(1);
}
console.log(`patched: ${lines.length} -> ${out.length} lines, eol=${eol === '\r\n' ? 'CRLF' : 'LF'}`);
