/**
 * The healer's MT5 bridge check, and specifically WHO the startup grace covers.
 *
 * This check has been wrong twice, and both times it failed the same way: it reported
 * green while the box that trades was dead. First by deriving the account list from the
 * accounts that had already reported, so a bridge that never connected was not in the
 * denominator and could not be missed. Then by handing a five-minute pass to any account
 * that was not reporting — including one that HAD been reporting and then went silent.
 *
 * The grace exists for exactly one thing: a cold boot where the MT5 terminal is still
 * launching and the bridge has not sent its first heartbeat. An account that has already
 * posted has proved it can reach the server; there is nothing left to wait for.
 *
 * The window is measured against process.uptime(), which is the SERVER's clock, so it
 * re-opens on every server restart — and a restart is the single most likely moment for
 * a bridge to fail to come back. That is why the distinction below matters rather than
 * being a technicality.
 *
 * These call the REAL exported function, not a restatement of it. A test that
 * re-implements what it checks passes when the shipped code is wrong.
 *
 * Run: node server/autohealer_mt5grace.test.js
 */

// Must be set BEFORE the require: autohealer.js reads MT5_EXPECTED_ACCOUNTS at module
// load, which is itself deliberate — see the comment on EXPECTED_MT5_ACCOUNTS.
process.env.MT5_EXPECTED_ACCOUNTS = 'A,B';

const assert = require('assert');
const healer = require('./autohealer');

const GRACE_MS = 5 * 60 * 1000;     // MT5_STARTUP_GRACE_MS
const STALE_MS = 3 * 60 * 1000;     // STALE_MT5_MS

const realUptime = process.uptime;
let failures = 0;

/** Runs the real check with a controlled clock and account state. */
function run({ uptimeSeconds, lastSeen }) {
  process.uptime = () => uptimeSeconds;
  try {
    healer._setContextForTests({ mt5LastSeenByAccount: lastSeen });
    healer.checkMt5Bridge();
    return healer.getStatus().checks.mt5Bridge;
  } finally {
    process.uptime = realUptime;
  }
}

function check(label, fn) {
  try { fn(); console.log('  PASS  ' + label); }
  catch (e) { failures++; console.error('  FAIL  ' + label + '\n        ' + e.message); }
}

const iso = msAgo => new Date(Date.now() - msAgo).toISOString();

console.log('MT5 bridge check — startup grace');

// Both accounts posting recently. The everyday case, and the one thing that must stay
// green: if this goes red the check is crying wolf on a working system.
check('both accounts reporting -> ok, at any uptime', () => {
  const r = run({ uptimeSeconds: 10, lastSeen: { A: iso(20_000), B: iso(20_000) } });
  assert.strictEqual(r.ok, true, 'expected ok');
  assert.match(r.detail, /2\/2 expected account\(s\) reporting/);
});

// Cold boot: nothing has posted yet because nothing has had time to. Green is correct
// here, and it is the whole reason the grace exists.
check('never connected, inside grace -> ok and says no heartbeat yet', () => {
  const r = run({ uptimeSeconds: 30, lastSeen: {} });
  assert.strictEqual(r.ok, true, 'expected ok inside grace');
  assert.match(r.detail, /has never connected/);
  assert.match(r.detail, /no heartbeat yet/);
  assert.match(r.detail, /startup grace expires in \d+s/,
    'the detail must say how long the grace has left — a reader cannot otherwise tell a '
    + 'fresh grace from one about to lapse');
});

// The grace ran out and still no heartbeat. Red, as before this change.
check('never connected, past grace -> fails', () => {
  const r = run({ uptimeSeconds: (GRACE_MS / 1000) + 30, lastSeen: {} });
  assert.strictEqual(r.ok, false, 'expected failure once the grace has expired');
  assert.match(r.detail, /has never connected/);
});

// THE REGRESSION. An account that posted and then went silent, still inside the server's
// grace window. Before this fix it read ok:true and every consumer recorded HEALTHY,
// because they all read `ok` and the caveat lived only in the detail string.
check('posted then went silent, INSIDE grace -> fails (was green)', () => {
  const r = run({
    uptimeSeconds: 60,                                  // well inside the 5-minute window
    lastSeen: { A: iso(20_000), B: iso(STALE_MS + 30_000) },
  });
  assert.strictEqual(r.ok, false,
    'a bridge that has already proved it can post has nothing left to wait for — the '
    + 'startup grace must not cover it');
  assert.match(r.detail, /B silent for \d+s/);
  assert.doesNotMatch(r.detail, /startup grace/,
    'must not claim grace for an account the grace does not cover');
});

// One silent account must not be hidden by a healthy one.
check('one live, one silent, past grace -> fails and names the silent one', () => {
  const r = run({
    uptimeSeconds: (GRACE_MS / 1000) + 30,
    lastSeen: { A: iso(20_000), B: iso(STALE_MS + 30_000) },
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.detail, /1\/2 expected account\(s\) reporting/);
  assert.match(r.detail, /B silent/);
});

// A bridge posting under a tag nobody declared is a misconfigured ACCOUNT_TAG, and it
// must be reported rather than silently ignored.
check('undeclared account is surfaced', () => {
  const r = run({ uptimeSeconds: 30, lastSeen: { A: iso(20_000), B: iso(20_000), Z: iso(20_000) } });
  assert.match(r.detail, /undeclared account\(s\) reporting: Z/);
});

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
