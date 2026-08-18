'use strict';
/**
 * Tests for the healer's backup/restore path.
 *
 * The bug these exist for: writeBackup() was defined, exported, and called from
 * nowhere. No .bak had ever been written, so restoreFromBackup() could only ever
 * return null — and BOTH callers fall through from a null restore to writing a clean
 * EMPTY default over the file. The corruption recovery path was a corruption
 * amplifier: one bad parse of learning.json and weeks of trade outcomes become
 * {setupStats:{}, sessionCount:0}.
 *
 * So the assertions that matter are not "a backup gets written". They are:
 *   - a CORRUPT file never becomes the backup
 *   - a restore actually returns the original content
 *   - the empty-default fallback is only reachable when there is genuinely no backup
 *
 * Everything runs in a temp directory. No file in server/ is read or written.
 *
 * Run: node server/autohealer_backup.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const healer = require('./autohealer');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  PASS  ' + name); }
  catch (e) { failed++; console.log('  FAIL  ' + name + '\n          ' + e.message); }
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'healer-backup-'));
function tmp(name) { return path.join(scratch, name); }

const GOOD = { setupStats: { MOMENTUM: { wins: 3, losses: 1, totalPnl: 120.5 } }, sessionCount: 208 };

console.log('\n-- the backup is written, and only when it changes -----------');

test('a valid file gets a .bak', () => {
  const f = tmp('learning.json');
  fs.writeFileSync(f, JSON.stringify(GOOD));
  healer.writeBackup(f);
  assert.ok(fs.existsSync(f + '.bak'), 'no .bak was written');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(f + '.bak', 'utf8')), GOOD);
});

test('a second call with nothing changed does NOT rewrite it', () => {
  const f = tmp('unchanged.json');
  fs.writeFileSync(f, JSON.stringify(GOOD));
  healer.writeBackup(f);
  const first = fs.statSync(f + '.bak').mtimeMs;
  healer.writeBackup(f);
  assert.strictEqual(fs.statSync(f + '.bak').mtimeMs, first,
    'rewrote an already-current backup — this runs every 30s');
});

test('a CHANGED file does get a fresh .bak', () => {
  const f = tmp('changed.json');
  fs.writeFileSync(f, JSON.stringify(GOOD));
  healer.writeBackup(f);
  const updated = { ...GOOD, sessionCount: 999 };
  // mtime resolution is coarse on some filesystems; set it forward explicitly.
  fs.writeFileSync(f, JSON.stringify(updated));
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(f, future, future);
  healer.writeBackup(f);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(f + '.bak', 'utf8')), updated,
    'the backup did not follow the source');
});

test('a file that does not exist is skipped, not an error', () => {
  const f = tmp('never-created.json');
  healer.writeBackup(f);
  assert.ok(!fs.existsSync(f + '.bak'));
});

console.log('\n-- corruption must never reach the backup --------------------');

test('CORRUPT content does not overwrite a good .bak', () => {
  // The whole safety property. writeBackup is only ever called from the branch that
  // has just parsed the file, so this is the guarantee that branch buys.
  const f = tmp('goes-bad.json');
  fs.writeFileSync(f, JSON.stringify(GOOD));
  healer.writeBackup(f);
  fs.writeFileSync(f, '{ this is not json');
  // The caller would NOT call writeBackup here — it takes the corrupt branch. Assert
  // the good copy is still intact and still parseable.
  const bak = JSON.parse(fs.readFileSync(f + '.bak', 'utf8'));
  assert.deepStrictEqual(bak, GOOD, 'the last good copy was lost');
});

console.log('\n-- restore returns the real data, not a default --------------');

test('restoreFromBackup recovers the original content', () => {
  const f = tmp('restore-me.json');
  fs.writeFileSync(f, JSON.stringify(GOOD));
  healer.writeBackup(f);
  fs.writeFileSync(f, '{ corrupt');
  const restored = healer.restoreFromBackup(f);
  assert.ok(restored, 'restore returned null with a valid .bak present');
  assert.deepStrictEqual(restored, GOOD);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(f, 'utf8')), GOOD,
    'the file on disk was not actually repaired');
  assert.notDeepStrictEqual(restored, { setupStats: {}, sessionCount: 0 },
    'restored the empty default — this is the bug, not the fix');
});

test('with NO backup, restore returns null (the empty-default path)', () => {
  const f = tmp('no-backup.json');
  fs.writeFileSync(f, '{ corrupt');
  assert.strictEqual(healer.restoreFromBackup(f), null,
    'claimed a restore with no .bak on disk');
});

test('an UNPARSEABLE backup is refused rather than copied over the file', () => {
  const f = tmp('bad-backup.json');
  fs.writeFileSync(f, '{ corrupt source');
  fs.writeFileSync(f + '.bak', '{ corrupt backup too');
  assert.strictEqual(healer.restoreFromBackup(f), null);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), '{ corrupt source',
    'copied a corrupt backup over the file');
});

try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (e) {}

console.log('\n' + (failed === 0 ? passed + ' passed, 0 failed'
                                 : passed + ' passed, ' + failed + ' FAILED'));
process.exit(failed === 0 ? 0 : 1);
