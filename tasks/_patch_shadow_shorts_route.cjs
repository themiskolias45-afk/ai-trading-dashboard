'use strict';
/**
 * Patch /api/shadow-shorts into a box's server/index.js.
 *
 * WHY A PATCHER AND NOT A COPY. The VPS carries commits this repo has never seen, so
 * index.js is hand-patched there and a whole-file copy would silently revert them.
 * See [[vps_git_history_has_diverged]].
 *
 * WHY NODE AND NOT POWERSHELL. PS 5.1 reads a .ps1 without a BOM as ANSI, so an em dash
 * inside a match string arrives mangled and the comparison fails against a correct file.
 * The strings below contain em dashes. Node reads UTF-8 and does not have that failure.
 *
 * SAFE BY CONSTRUCTION:
 *   - idempotent: if the route is already present it reports so and writes nothing;
 *   - each anchor must match EXACTLY ONCE, or it aborts having written nothing;
 *   - a timestamped backup is taken and VERIFIED non-empty before the original moves;
 *   - the result is syntax-checked with the same parser node itself uses, and the backup
 *     is restored if that check fails, so a bad patch cannot be left in place;
 *   - nothing is deleted, ever. The backup stays on disk.
 *
 * Verify by GREPPING THE TARGET afterwards, never by trusting this script's own output --
 * a patcher that asserts before it writes prints green lines while changing nothing.
 *
 * Usage:  node tasks/_patch_shadow_shorts_route.cjs [--dry-run] [path/to/index.js]
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DRY_RUN = process.argv.includes('--dry-run');
const explicit = process.argv.slice(2).find(a => !a.startsWith('--'));
const TARGET = explicit
  ? path.resolve(explicit)
  : path.join(__dirname, '..', 'server', 'index.js');

const REQUIRE_ANCHOR = `if (typeof stopVariantSummary !== "function") {
  stopVariantSummary = () => ({ available: false,
    reason: "server/stop_variants.js is not deployed on this box", feedsTheGate: false });
}`;

const REQUIRE_BLOCK = `

// The read side of the shadow SHORT ledger. tasks/shadow_short_ledger.py writes the rows
// nightly; without this nothing reads them, and a ledger nothing reads can never become a
// verdict — the exact failure the near-miss census had for weeks.
//
// It answers a question upstream of BOTH surfaces above: /api/gate-health counts gates
// firing on setups that FORMED, /api/near-miss counts setups that ALMOST formed, and
// neither can see a move for which no branch exists at all. On 2026-08-28 Gold fell
// 4631 -> 4530 in one H1 bar and left no row on any surface in this system.
//
// Guarded exactly like near_miss and stop_variants above, for the reason those two
// taught: index.js is hand-patched onto the VPS while modules travel as their own tracked
// files, so a require whose file has not landed yet must degrade rather than take down
// the box that trades continuously.
let shadowShortSummary;
try {
  ({ shadowShortSummary } = require("./shadow_shorts"));
} catch (shadowShortError) {
  console.error(
    \`[shadow-shorts] module unavailable (\${shadowShortError.message}) \` +
    \`— /api/shadow-shorts will report unavailable. Signals and trading are unaffected.\`
  );
}
if (typeof shadowShortSummary !== "function") {
  shadowShortSummary = () => ({ available: false,
    reason: "server/shadow_shorts.js is not deployed on this box", byAsset: {},
    feedsTheGate: false });
}`;

const ROUTE_ANCHOR = `app.get("/api/near-miss", (_, res) => {
  try {
    res.json(nearMissCensus());
  } catch (e) {
    console.error("[near-miss]", e.message);
    res.status(500).json({ available: false, reason: e.message, rows: [], feedsTheGate: false });
  }
});`;

const ROUTE_BLOCK = `

// One level upstream of the census above. /api/near-miss counts setups that ALMOST
// formed — a setup one measurable condition short. This counts moves for which NO branch
// exists at all, so there is no condition to be short of and nothing to count anywhere
// else: on 2026-08-28 Gold fell 4631 -> 4530 in a single H1 bar and left no row on any
// surface in this system, while /api/signals still read BUY MOMENTUM confidence 74.
//
// Deliberately NOT merged into /api/near-miss, for the same reason that route is not
// merged into /api/gate-health: "a setup missed by 0.6 RSI" and "no setup could exist"
// are different facts, and putting them in one payload makes every reader treat them as
// the same kind of number.
//
// Read-only over tasks/shadow_shorts_scored.jsonl, which tasks/shadow_short_ledger.py
// writes nightly. It is NOT evidence for trading the short side — the family failed a
// 5.1-year nested walk-forward — it is the instrument that lets that verdict be
// re-checked against live bars instead of re-argued.
app.get("/api/shadow-shorts", (_, res) => {
  try {
    res.json(shadowShortSummary());
  } catch (e) {
    console.error("[shadow-shorts]", e.message);
    res.status(500).json({ available: false, reason: e.message, byAsset: {}, feedsTheGate: false });
  }
});`;

const ALLOWLIST_ANCHOR = `  "/api/near-miss",
  // Fair Value Gap zones, derived from the same bars /api/signals already exposes`;

const ALLOWLIST_BLOCK = `  "/api/near-miss",
  // Moves for which no setup exists at all, priced as paper trades. Strictly less
  // sensitive again than the line above: a row is an asset name, a count, a mean R and a
  // verdict string, all of it about trades that were never taken. No keys, no account
  // numbers, no positions, and no live levels — the entry and stop prices stay in the
  // file and are not served. There is no POST at this path; the rows are written by
  // tasks/shadow_short_ledger.py on disk, never over HTTP.
  "/api/shadow-shorts",
  // Fair Value Gap zones, derived from the same bars /api/signals already exposes`;

function fail(message) {
  console.error('ABORT: ' + message + ' — nothing was written.');
  process.exit(1);
}

if (!fs.existsSync(TARGET)) fail('no such file ' + TARGET);
const original = fs.readFileSync(TARGET, 'utf8');

// BOTH boxes store index.js with CRLF, and the anchors below are written with LF because
// this file is. Matching raw therefore fails on every anchor while the file is perfectly
// correct -- and it fails SILENTLY on an already-patched file, which short-circuits above
// and never exercises the anchors at all. So: normalise to LF for matching, remember what
// the file actually used, and restore exactly that on write. Never rewrite a whole file's
// line endings as a side effect of inserting twenty lines -- that turns a small patch into
// a diff against every line and makes the next parity run unreadable.
const crlfCount = (original.match(/\r\n/g) || []).length;
const usesCrlf = crlfCount > 0;
const normalised = usesCrlf ? original.replace(/\r\n/g, '\n') : original;

console.log('target: %s (%d chars, %s)', TARGET, original.length,
  usesCrlf ? `CRLF x${crlfCount}` : 'LF');

if (normalised.includes('/api/shadow-shorts')) {
  console.log('ALREADY PATCHED — /api/shadow-shorts is present. Nothing to do.');
  process.exit(0);
}

const edits = [
  ['guarded require', REQUIRE_ANCHOR, REQUIRE_ANCHOR + REQUIRE_BLOCK],
  ['route', ROUTE_ANCHOR, ROUTE_ANCHOR + ROUTE_BLOCK],
  ['public allowlist', ALLOWLIST_ANCHOR, ALLOWLIST_BLOCK],
];

let patched = normalised;
for (const [label, anchor, replacement] of edits) {
  const occurrences = patched.split(anchor).length - 1;
  if (occurrences !== 1) {
    fail(`anchor for "${label}" matched ${occurrences} times, expected exactly 1`);
  }
  patched = patched.replace(anchor, replacement);
  console.log('  applied: %s', label);
}

// Parse with the same engine node uses. A patch that produces invalid JS must never reach
// a box that is about to be restarted into it.
try {
  new vm.Script(patched, { filename: TARGET });
} catch (e) {
  fail('the patched source does not parse (' + e.message + ')');
}
console.log('  patched source parses clean (+%d chars)', patched.length - normalised.length);

// Put the file's own line endings back before anything is written.
const output = usesCrlf ? patched.replace(/\n/g, '\r\n') : patched;
const outCrlf = (output.match(/\r\n/g) || []).length;
if (usesCrlf && outCrlf <= crlfCount) {
  fail(`line-ending restore produced ${outCrlf} CRLF against ${crlfCount} before`);
}

if (DRY_RUN) {
  console.log('DRY RUN — verified only, nothing written. Re-run without --dry-run.');
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
const backup = `${TARGET}.bak-shadowshorts-${stamp}`;

// Compare BYTES to BYTES. `original.length` is a character count, and index.js is CRLF
// with multibyte characters in it -- 523,084 chars against 530,849 bytes here -- so
// checking the backup's byte size against it fails on a perfectly good copy and aborts a
// correct patch. Caught by rehearsing this script against a copy of the real target
// before it was ever pointed at the box that trades.
const sourceBytes = fs.statSync(TARGET).size;
fs.copyFileSync(TARGET, backup);
if (!fs.existsSync(backup) || fs.statSync(backup).size !== sourceBytes) {
  fail('backup ' + path.basename(backup) + ' missing or wrong size');
}
console.log('  backup verified: %s (%d bytes)', path.basename(backup), fs.statSync(backup).size);

fs.writeFileSync(TARGET, output, 'utf8');

// Read back from disk rather than trusting the write. Restore on any doubt.
const readBack = fs.readFileSync(TARGET, 'utf8');
if (!readBack.includes('/api/shadow-shorts')) {
  fs.copyFileSync(backup, TARGET);
  fail('read-back does not contain the route; original restored from backup');
}
console.log('PATCHED. Verify independently: grep -c shadow-shorts on the target.');
