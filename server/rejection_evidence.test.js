'use strict';
/**
 * Tests for per-gate rejection verdicts.
 *
 * The failure that matters here is a sign error. Calling a gate "earning its
 * keep" when it is actually throwing away winners would point every future
 * investigation at the wrong gate, so both directions are asserted explicitly.
 *
 * Run: node server/rejection_evidence.test.js
 */

const assert = require("assert");
const fs   = require("fs");
const os   = require("os");
const path = require("path");
const {
  buildEvidence, summariseGate, verdictFor,
  VERDICT_TOO_FEW, VERDICT_EARNING, VERDICT_COSTING, VERDICT_NEUTRAL,
  MIN_RESOLVED_FOR_VERDICT,
} = require("./rejection_evidence");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("  PASS  " + name); }
  catch (e) { failed++; console.log("  FAIL  " + name + "\n          " + e.message); }
}

function row(gate, outcome, r, extra) {
  return Object.assign({ gate, outcome, r, setup: "TEST_SETUP", symbol: "XAUUSD", rr: 1.5 }, extra || {});
}

function withLedger(rows, fn) {
  const file = path.join(os.tmpdir(), "rej_test_" + Date.now() + "_" + Math.random().toString(36).slice(2) + ".jsonl");
  fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join("\n") + "\n");
  try { return fn(file); } finally { try { fs.unlinkSync(file); } catch (e) {} }
}

console.log("\n── the sign of the verdict ──────────────────────────────────");

test("rejections that would have WON mean the gate is COSTING money", () => {
  const rows = Array.from({ length: 8 }, () => row("MIN_RR", "TARGET", 1.5));
  withLedger(rows, file => {
    const gate = buildEvidence(file).gates.MIN_RR;
    assert.strictEqual(gate.verdict, VERDICT_COSTING, "got " + gate.verdict);
    assert.strictEqual(gate.wouldHaveWon, 8);
    assert.ok(gate.netR > 0, "netR should be positive, got " + gate.netR);
  });
});

test("rejections that would have LOST mean the gate is EARNING its keep", () => {
  const rows = Array.from({ length: 8 }, () => row("MIN_RR", "STOP", -1));
  withLedger(rows, file => {
    const gate = buildEvidence(file).gates.MIN_RR;
    assert.strictEqual(gate.verdict, VERDICT_EARNING, "got " + gate.verdict);
    assert.strictEqual(gate.wouldHaveLost, 8);
    assert.ok(gate.netR < 0);
  });
});

test("a wash is NO MEASURABLE COST, not a recommendation either way", () => {
  const rows = [row("MIN_RR","TARGET",1), row("MIN_RR","STOP",-1), row("MIN_RR","TARGET",1),
                row("MIN_RR","STOP",-1), row("MIN_RR","TARGET",1), row("MIN_RR","STOP",-1)];
  withLedger(rows, file => {
    assert.strictEqual(buildEvidence(file).gates.MIN_RR.verdict, VERDICT_NEUTRAL);
  });
});

console.log("\n── the sample floor ─────────────────────────────────────────");

test("below the floor no verdict is issued, however lopsided the record", () => {
  const rows = Array.from({ length: MIN_RESOLVED_FOR_VERDICT - 1 }, () => row("MIN_RR", "TARGET", 3));
  withLedger(rows, file => {
    const gate = buildEvidence(file).gates.MIN_RR;
    assert.strictEqual(gate.verdict, VERDICT_TOO_FEW, "4 huge wins must not become a verdict");
    assert.ok(gate.detail.includes("need " + MIN_RESOLVED_FOR_VERDICT));
  });
});

test("PENDING and NO_DATA never count toward the floor", () => {
  const rows = [
    ...Array.from({ length: 20 }, () => row("CONFIDENCE", "PENDING", null)),
    ...Array.from({ length: 5 },  () => row("CONFIDENCE", "NO_DATA", null)),
    row("CONFIDENCE", "TARGET", 1.5),
  ];
  withLedger(rows, file => {
    const gate = buildEvidence(file).gates.CONFIDENCE;
    assert.strictEqual(gate.resolved, 1, "only TARGET/STOP resolve");
    assert.strictEqual(gate.pending, 20);
    assert.strictEqual(gate.unscorable, 5);
    assert.strictEqual(gate.verdict, VERDICT_TOO_FEW);
    assert.ok(gate.detail.includes("20 still inside their horizon"), gate.detail);
  });
});

console.log("\n── attribution ──────────────────────────────────────────────");

test("gates are kept separate — one gate's evidence never credits another", () => {
  const rows = [
    ...Array.from({ length: 6 }, () => row("MIN_RR", "TARGET", 2)),
    ...Array.from({ length: 6 }, () => row("CONFIDENCE", "STOP", -1)),
  ];
  withLedger(rows, file => {
    const e = buildEvidence(file);
    assert.strictEqual(e.gates.MIN_RR.verdict, VERDICT_COSTING);
    assert.strictEqual(e.gates.CONFIDENCE.verdict, VERDICT_EARNING);
  });
});

test("a row with no gate becomes UNSPECIFIED, never MIN_RR", () => {
  // Crediting the R:R gate with another gate's evidence is the exact
  // misattribution the ledger spec exists to prevent.
  const rows = Array.from({ length: 6 }, () => { const r = row("MIN_RR", "TARGET", 1); delete r.gate; return r; });
  withLedger(rows, file => {
    const e = buildEvidence(file);
    assert.ok(e.gates.UNSPECIFIED, "expected an UNSPECIFIED bucket");
    assert.strictEqual(e.gates.MIN_RR, undefined, "must NOT be attributed to MIN_RR");
  });
});

test("per-setup view aggregates across gates", () => {
  const rows = [
    row("MIN_RR", "TARGET", 1, { setup: "BUY_OVERSOLD" }),
    row("CONFIDENCE", "TARGET", 1, { setup: "BUY_OVERSOLD" }),
    row("MIN_RR", "STOP", -1, { setup: "BUY_OVERSOLD" }),
  ];
  withLedger(rows, file => {
    const s = buildEvidence(file).setups.BUY_OVERSOLD;
    assert.strictEqual(s.won, 2);
    assert.strictEqual(s.lost, 1);
    assert.strictEqual(s.gates.MIN_RR, 2);
    assert.strictEqual(s.gates.CONFIDENCE, 1);
  });
});

console.log("\n── robustness ───────────────────────────────────────────────");

test("a missing ledger is a normal state, not an error", () => {
  const e = buildEvidence(path.join(os.tmpdir(), "definitely_not_here_" + Date.now() + ".jsonl"));
  assert.strictEqual(e.available, false);
  assert.strictEqual(e.reason, "no scored ledger yet");
  assert.deepStrictEqual(e.gates, {});
});

test("malformed lines are counted and skipped, not fatal", () => {
  const file = path.join(os.tmpdir(), "rej_bad_" + Date.now() + ".jsonl");
  fs.writeFileSync(file, JSON.stringify(row("MIN_RR", "TARGET", 1)) + "\n{ not json\n\n"
    + JSON.stringify(row("MIN_RR", "STOP", -1)) + "\n");
  try {
    const e = buildEvidence(file);
    assert.strictEqual(e.totals.malformed, 1);
    assert.strictEqual(e.gates.MIN_RR.resolved, 2);
  } finally { fs.unlinkSync(file); }
});

test("a resolved row with no r falls back rather than dropping the episode", () => {
  const rows = [row("MIN_RR", "TARGET", null, { rr: 2 }), row("MIN_RR", "STOP", null)];
  withLedger(rows, file => {
    const gate = buildEvidence(file).gates.MIN_RR;
    assert.strictEqual(gate.resolved, 2, "neither episode may be silently dropped");
    assert.ok(Math.abs(gate.netR - 1) < 1e-9, "expected +2 and -1 = +1, got " + gate.netR);
  });
});

test("the payload always disclaims itself", () => {
  withLedger([row("MIN_RR", "TARGET", 1)], file => {
    const e = buildEvidence(file);
    assert.strictEqual(e.feedsTheGate, false, "must state it changes nothing");
    assert.ok(/PAPER/.test(e.caveat), "must say these are paper trades");
    assert.ok(/walk-forward wins/.test(e.caveat), "must defer to walk-forward");
  });
});

console.log("\n── the mutation check ───────────────────────────────────────");

test("verdictFor is not returning one constant", () => {
  const winners = { resolved: 10, wouldHaveWon: 10, wouldHaveLost: 0, pending: 0, netR: 10 };
  const losers  = { resolved: 10, wouldHaveWon: 0, wouldHaveLost: 10, pending: 0, netR: -10 };
  const wash    = { resolved: 10, wouldHaveWon: 5, wouldHaveLost: 5, pending: 0, netR: 0 };
  const thin    = { resolved: 1,  wouldHaveWon: 1, wouldHaveLost: 0, pending: 0, netR: 5 };
  assert.strictEqual(verdictFor(winners).verdict, VERDICT_COSTING);
  assert.strictEqual(verdictFor(losers).verdict, VERDICT_EARNING);
  assert.strictEqual(verdictFor(wash).verdict, VERDICT_NEUTRAL);
  assert.strictEqual(verdictFor(thin).verdict, VERDICT_TOO_FEW);
});

test("summariseGate counts outcomes independently", () => {
  const b = summariseGate([
    row("G", "TARGET", 1), row("G", "STOP", -1),
    row("G", "PENDING", null), row("G", "NO_DATA", null),
  ]);
  assert.strictEqual(b.resolved, 2);
  assert.strictEqual(b.pending, 1);
  assert.strictEqual(b.unscorable, 1);
});

console.log("\n" + (failed === 0 ? passed + " passed, 0 failed" : passed + " passed, " + failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
