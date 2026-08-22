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
  buildEvidence, summariseGate, verdictFor, classOfEpisodes,
  VERDICT_TOO_FEW, VERDICT_EARNING, VERDICT_COSTING, VERDICT_NEUTRAL,
  VERDICT_NOT_FORGONE, VERDICT_STATE_GATE,
  CLASS_QUALITY, CLASS_CONTEXT, CLASS_NOT_FORGONE, CLASS_UNKNOWN,
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

console.log("\n── episodes, not rows ───────────────────────────────────────");

test("rows sharing an episode id count ONCE, however many there are", () => {
  // The real shape of the bug: one Gold BUY re-offered every poll cycle for days.
  // Twelve rows of one setup are one piece of evidence, not twelve.
  const rows = Array.from({ length: 12 }, () => row("DUPLICATE", "TARGET", 2, { episode: 7 }));
  withLedger(rows, file => {
    const gate = buildEvidence(file).gates.DUPLICATE;
    assert.strictEqual(gate.resolved, 1, "12 rows of one episode must resolve once");
    assert.strictEqual(gate.total, 1, "the denominator is episodes");
    assert.strictEqual(gate.rows, 12, "the raw row count stays visible");
    assert.strictEqual(gate.verdict, VERDICT_TOO_FEW, "1 episode cannot earn a verdict");
  });
});

test("distinct episode ids stay distinct", () => {
  const rows = Array.from({ length: 8 }, (_, i) => row("MIN_RR", "TARGET", 1.5, { episode: i }));
  withLedger(rows, file => {
    const gate = buildEvidence(file).gates.MIN_RR;
    assert.strictEqual(gate.resolved, 8);
    assert.strictEqual(gate.verdict, VERDICT_COSTING);
  });
});

test("a row with NO episode id is its own episode, never merged with the rest", () => {
  // The legacy ledger predates the scorer stamping ids. Treating a missing id as a
  // shared one would collapse the whole file into a single observation.
  const rows = Array.from({ length: 6 }, () => row("MIN_RR", "STOP", -1));
  withLedger(rows, file => {
    const gate = buildEvidence(file).gates.MIN_RR;
    assert.strictEqual(gate.resolved, 6, "unstamped rows must not collapse");
    assert.strictEqual(gate.verdict, VERDICT_EARNING);
  });
});

test("the episode's representative is the row that RESOLVED, not merely the first", () => {
  const rows = [
    row("MIN_RR", "PENDING", null, { episode: 1 }),
    row("MIN_RR", "PENDING", null, { episode: 1 }),
    row("MIN_RR", "TARGET",  2.5,  { episode: 1 }),
  ];
  withLedger(rows, file => {
    const gate = buildEvidence(file).gates.MIN_RR;
    assert.strictEqual(gate.resolved, 1, "the episode resolved, so it must count as resolved");
    assert.strictEqual(gate.pending, 0, "it must not also be counted as pending");
    assert.ok(Math.abs(gate.netR - 2.5) < 1e-9, "expected the resolved row's R, got " + gate.netR);
  });
});

test("an episode where nothing resolved still appears, as pending", () => {
  const rows = Array.from({ length: 5 }, () => row("CONFIDENCE", "PENDING", null, { episode: 3 }));
  withLedger(rows, file => {
    const gate = buildEvidence(file).gates.CONFIDENCE;
    assert.strictEqual(gate.pending, 1, "one episode, still inside its horizon");
    assert.strictEqual(gate.resolved, 0);
  });
});

test("the per-setup view counts episodes too", () => {
  const rows = [
    ...Array.from({ length: 9 }, () => row("MIN_RR", "TARGET", 1, { setup: "RANGE_TRADE_SHORT", episode: 4 })),
    row("CONFIDENCE", "STOP", -1, { setup: "RANGE_TRADE_SHORT", episode: 5 }),
  ];
  withLedger(rows, file => {
    const s = buildEvidence(file).setups.RANGE_TRADE_SHORT;
    assert.strictEqual(s.won, 1, "nine rows of one episode are one win");
    assert.strictEqual(s.lost, 1);
    assert.strictEqual(s.gates.MIN_RR, 1);
  });
});

test("the payload says which unit it is counting in", () => {
  withLedger([row("MIN_RR", "TARGET", 1, { episode: 1 })], file => {
    const e = buildEvidence(file);
    assert.strictEqual(e.countsAre, "episodes");
    assert.strictEqual(e.totals.rows, 1);
    assert.strictEqual(e.totals.episodes, 1);
  });
});

console.log("\n── the noise band ───────────────────────────────────────────");

test("a large sample of near-zero episodes is NOISE, not a finding", () => {
  // 40 episodes at +0.07R each clears 1R absolute but says nothing. This is exactly
  // MIN_RR's real record once its rows are collapsed.
  const rows = Array.from({ length: 40 }, (_, i) => row("MIN_RR", "TARGET", 0.07, { episode: i }));
  withLedger(rows, file => {
    const gate = buildEvidence(file).gates.MIN_RR;
    assert.ok(gate.netR > 1, "precondition: the absolute total does cross 1R, got " + gate.netR);
    assert.strictEqual(gate.verdict, VERDICT_NEUTRAL, "inside the band it is not a verdict");
    assert.ok(gate.detail.includes("inside the noise"), gate.detail);
  });
});

test("the band applies in both directions", () => {
  const rows = Array.from({ length: 40 }, (_, i) => row("CONFIDENCE", "STOP", -0.07, { episode: i }));
  withLedger(rows, file => {
    const gate = buildEvidence(file).gates.CONFIDENCE;
    assert.ok(gate.netR < -1, "precondition: crosses -1R, got " + gate.netR);
    assert.strictEqual(gate.verdict, VERDICT_NEUTRAL, "a gate must not be credited on noise either");
  });
});

test("a real per-episode edge still gets its verdict", () => {
  const rows = Array.from({ length: 10 }, (_, i) => row("MIN_RR", "TARGET", 0.5, { episode: i }));
  withLedger(rows, file => {
    const gate = buildEvidence(file).gates.MIN_RR;
    assert.strictEqual(gate.verdict, VERDICT_COSTING, "0.5R/episode is well outside the band");
    assert.ok(Math.abs(gate.rPerEpisode - 0.5) < 1e-9, "rPerEpisode should be surfaced");
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

console.log("\n── gate class: not every gate is scoreable the same way ─────");

test("a NOT_FORGONE gate is never scored for R, however many winners", () => {
  // The real defect. Five DUPLICATE episodes reaching target produced +10.1R and a
  // COSTING MONEY verdict against a guard whose entire job is to stop the system
  // re-entering a position it already holds. The trade was TAKEN; its outcome is in
  // the journal; adding it here counts the same move twice.
  const rows = Array.from({ length: 8 }, (_, i) =>
    row("DUPLICATE", "TARGET", 2, { episode: i, gateClass: CLASS_NOT_FORGONE }));
  withLedger(rows, file => {
    const gate = buildEvidence(file).gates.DUPLICATE;
    assert.strictEqual(gate.gateClass, CLASS_NOT_FORGONE, "the class must be surfaced");
    assert.strictEqual(gate.resolved, 8, "the episodes are still counted");
    assert.strictEqual(gate.wouldHaveWon, 8, "and so is what they did");
    assert.strictEqual(gate.netR, null, "but no R is attributed");
    assert.strictEqual(gate.rPerEpisode, null);
    assert.strictEqual(gate.verdict, VERDICT_NOT_FORGONE,
      "8 winners past the floor must NOT read COSTING MONEY, got " + gate.verdict);
    assert.ok(/already open/.test(gate.detail), gate.detail);
  });
});

test("a NOT_FORGONE episode never enters the per-setup forgone tally", () => {
  // MOMENTUM read +11.3R with 6 of its 14 episodes being one Gold BUY that was open
  // throughout. A position the system took is not a setup it threw away.
  const rows = [
    row("CONFIDENCE", "TARGET", 1, { setup: "MOMENTUM", episode: 1, gateClass: CLASS_QUALITY }),
    row("DUPLICATE",  "TARGET", 9, { setup: "MOMENTUM", episode: 2, gateClass: CLASS_NOT_FORGONE }),
    row("DUPLICATE",  "TARGET", 9, { setup: "MOMENTUM", episode: 3, gateClass: CLASS_NOT_FORGONE }),
  ];
  withLedger(rows, file => {
    const s = buildEvidence(file).setups.MOMENTUM;
    assert.strictEqual(s.won, 1, "only the genuinely forgone episode counts");
    assert.ok(Math.abs(s.netR - 1) < 1e-9, "18R of already-open position must not land here, got " + s.netR);
    assert.strictEqual(s.gates.DUPLICATE, undefined, "and the gate must not appear at all");
  });
});

test("a CONTEXT gate reports its numbers and never a verdict, in either direction", () => {
  // A NEWS_BLACKOUT rejection that would have won does not make the blackout wrong.
  for (const [outcome, r] of [["TARGET", 2], ["STOP", -1]]) {
    const rows = Array.from({ length: 9 }, (_, i) =>
      row("NEWS_BLACKOUT", outcome, r, { episode: i, gateClass: CLASS_CONTEXT }));
    withLedger(rows, file => {
      const gate = buildEvidence(file).gates.NEWS_BLACKOUT;
      assert.strictEqual(gate.verdict, VERDICT_STATE_GATE,
        outcome + " must not produce a verdict, got " + gate.verdict);
      assert.strictEqual(gate.resolved, 9, "the numbers are still reported");
      assert.ok(Number.isFinite(gate.netR), "CONTEXT keeps its R, unlike NOT_FORGONE");
    });
  }
});

test("an unclassified gate keeps the behaviour that shipped before classes existed", () => {
  // Legacy rows predate the stamp. Silently reclassifying them would rewrite history.
  const rows = Array.from({ length: 8 }, (_, i) => row("MIN_RR", "STOP", -1, { episode: i }));
  withLedger(rows, file => {
    const gate = buildEvidence(file).gates.MIN_RR;
    assert.strictEqual(gate.gateClass, CLASS_UNKNOWN);
    assert.strictEqual(gate.verdict, VERDICT_EARNING, "must still be judged as quality");
    assert.ok(Number.isFinite(gate.netR));
  });
});

test("totals.netR survives a null and never becomes NaN", () => {
  const rows = [
    ...Array.from({ length: 6 }, (_, i) => row("MIN_RR", "TARGET", 1, { episode: i, gateClass: CLASS_QUALITY })),
    ...Array.from({ length: 6 }, (_, i) => row("DUPLICATE", "TARGET", 5, { episode: 100 + i, gateClass: CLASS_NOT_FORGONE })),
  ];
  withLedger(rows, file => {
    const t = buildEvidence(file).totals;
    assert.ok(Number.isFinite(t.netR), "got " + t.netR);
    assert.ok(Math.abs(t.netR - 6) < 1e-9, "only the QUALITY gate contributes R, got " + t.netR);
    assert.strictEqual(t.resolved, 12, "but every episode is still counted as resolved");
  });
});

test("classOfEpisodes is not returning one constant", () => {
  assert.strictEqual(classOfEpisodes([{ gateClass: CLASS_QUALITY }]), CLASS_QUALITY);
  assert.strictEqual(classOfEpisodes([{ gateClass: CLASS_CONTEXT }]), CLASS_CONTEXT);
  assert.strictEqual(classOfEpisodes([{ gateClass: CLASS_NOT_FORGONE }]), CLASS_NOT_FORGONE);
  assert.strictEqual(classOfEpisodes([{}]), CLASS_UNKNOWN, "no stamp anywhere is UNKNOWN");
  assert.strictEqual(classOfEpisodes([{ gateClass: "NONSENSE" }]), CLASS_UNKNOWN,
    "an unrecognised stamp must not be trusted");
  assert.strictEqual(classOfEpisodes([{}, { gateClass: CLASS_CONTEXT }]), CLASS_CONTEXT,
    "the first stamped row settles it");
});

test("the class table is not duplicated in JS - it comes from the rows", () => {
  // Two copies of the map would drift. The scorer is the authority; if a row says a
  // gate is CONTEXT then it is, whatever the gate happens to be called here.
  const rows = Array.from({ length: 9 }, (_, i) =>
    row("MIN_RR", "TARGET", 2, { episode: i, gateClass: CLASS_CONTEXT }));
  withLedger(rows, file => {
    assert.strictEqual(buildEvidence(file).gates.MIN_RR.verdict, VERDICT_STATE_GATE,
      "the stamp on the row wins, not the gate name");
  });
});

console.log("\n" + (failed === 0 ? passed + " passed, 0 failed" : passed + " passed, " + failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
