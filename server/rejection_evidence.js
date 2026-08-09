'use strict';
/**
 * Per-gate verdicts from the scored rejection ledger.
 *
 * The ledger and the scorer already existed: server/rejection_log.js writes
 * rejections, tasks/score_rr_rejections.py walks each one forward against real
 * broker bars into tasks/rejections_scored.jsonl, and auto_daily.bat runs both
 * nightly. What nothing did was answer the question the whole apparatus exists
 * for, stated in tasks/REJECTION-LEDGER-SPEC.md:
 *
 *   "A gate whose rejections would have LOST money is earning its keep.
 *    A gate whose rejections would have WON is charging the account for nothing."
 *
 * That verdict was computable from a file on disk and nobody computed it.
 *
 * READ-ONLY AND INERT. This module opens one file, aggregates, and returns. It
 * writes nothing, mutates nothing, and is imported by a GET route only. No gate
 * threshold, no confidence, no signal admission changes as a result of anything
 * here — the ledger's founding rule is that observability must never alter what
 * trades, and a module that scores the gates is exactly where that rule would be
 * most tempting to break.
 */

const fs   = require("fs");
const path = require("path");

const SCORED_PATH = path.join(__dirname, "..", "tasks", "rejections_scored.jsonl");

// Below this, a gate's record is a curiosity, not a measurement. Deliberately the
// same floor the live learning engine uses for a setup boost.
const MIN_RESOLVED_FOR_VERDICT = 5;

const VERDICT_TOO_FEW  = "TOO FEW TO JUDGE";
const VERDICT_EARNING  = "EARNING ITS KEEP";
const VERDICT_COSTING  = "COSTING MONEY";
const VERDICT_NEUTRAL  = "NO MEASURABLE COST";

function readScoredRows(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath || SCORED_PATH, "utf8");
  } catch (e) {
    // A missing ledger is a normal state on a fresh checkout, not an error worth
    // taking a route down for.
    return { rows: [], error: e.code === "ENOENT" ? "no scored ledger yet" : e.message };
  }
  const rows = [];
  let malformed = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { rows.push(JSON.parse(trimmed)); } catch (e) { malformed++; }
  }
  return { rows, malformed };
}

/**
 * TARGET → the rejected setup would have reached its target: the gate cost you
 * that trade. STOP → it would have lost: the gate saved you. PENDING → the
 * scoring horizon has not elapsed. NO_DATA → unscorable, usually a missing
 * sourceSymbol, and per the spec that is recorded rather than guessed.
 */
function summariseGate(rows) {
  const bucket = {
    resolved: 0, wouldHaveWon: 0, wouldHaveLost: 0,
    pending: 0, unscorable: 0, netR: 0,
    setups: {}, symbols: {},
  };
  for (const row of rows) {
    const outcome = row.outcome;
    if (outcome === "TARGET" || outcome === "STOP") {
      const won = outcome === "TARGET";
      bucket.resolved++;
      if (won) bucket.wouldHaveWon++; else bucket.wouldHaveLost++;
      // A resolved row should carry r; fall back to the definitional value rather
      // than dropping the episode.
      bucket.netR += Number.isFinite(row.r) ? row.r : (won ? (Number(row.rr) || 1) : -1);
      const setup = row.setup || "UNKNOWN";
      bucket.setups[setup] = bucket.setups[setup] || { won: 0, lost: 0 };
      won ? bucket.setups[setup].won++ : bucket.setups[setup].lost++;
      const symbol = row.symbol || row.sourceSymbol || "UNKNOWN";
      bucket.symbols[symbol] = (bucket.symbols[symbol] || 0) + 1;
    } else if (outcome === "PENDING") bucket.pending++;
    else bucket.unscorable++;
  }
  return bucket;
}

function verdictFor(bucket) {
  if (bucket.resolved < MIN_RESOLVED_FOR_VERDICT) {
    return {
      verdict: VERDICT_TOO_FEW,
      detail: bucket.resolved + " resolved, need " + MIN_RESOLVED_FOR_VERDICT
        + (bucket.pending ? " (" + bucket.pending + " still inside their horizon)" : ""),
    };
  }
  const winRate = (bucket.wouldHaveWon / bucket.resolved) * 100;
  if (bucket.netR > 1) {
    return {
      verdict: VERDICT_COSTING,
      detail: "rejections would have returned " + bucket.netR.toFixed(2) + "R over "
        + bucket.resolved + " episodes (" + winRate.toFixed(0) + "% would have won) — "
        + "this gate is charging the account for setups that paid",
    };
  }
  if (bucket.netR < -1) {
    return {
      verdict: VERDICT_EARNING,
      detail: "rejections would have lost " + bucket.netR.toFixed(2) + "R over "
        + bucket.resolved + " episodes — the gate is doing its job",
    };
  }
  return {
    verdict: VERDICT_NEUTRAL,
    detail: "rejections net " + bucket.netR.toFixed(2) + "R over " + bucket.resolved
      + " episodes — inside the noise",
  };
}

/**
 * @param {string} [filePath] override, used by tests
 * @returns {object} per-gate and per-setup evidence with verdicts
 */
function buildEvidence(filePath) {
  const { rows, error, malformed } = readScoredRows(filePath);
  if (error) {
    return { available: false, reason: error, gates: {}, setups: {}, totals: null };
  }

  const byGate = {};
  for (const row of rows) {
    const gate = row.gate || "UNSPECIFIED";
    (byGate[gate] = byGate[gate] || []).push(row);
  }

  const gates = {};
  for (const [gate, gateRows] of Object.entries(byGate)) {
    const bucket = summariseGate(gateRows);
    const judged = verdictFor(bucket);
    gates[gate] = {
      resolved: bucket.resolved,
      wouldHaveWon: bucket.wouldHaveWon,
      wouldHaveLost: bucket.wouldHaveLost,
      wouldHaveWonPct: bucket.resolved ? Math.round((bucket.wouldHaveWon / bucket.resolved) * 100) : null,
      netR: Number(bucket.netR.toFixed(3)),
      pending: bucket.pending,
      unscorable: bucket.unscorable,
      total: gateRows.length,
      setups: bucket.setups,
      symbols: bucket.symbols,
      verdict: judged.verdict,
      detail: judged.detail,
    };
  }

  // Cross-gate setup view: which SETUPS are being thrown away, whatever killed them.
  const setups = {};
  for (const row of rows) {
    if (row.outcome !== "TARGET" && row.outcome !== "STOP") continue;
    const setup = row.setup || "UNKNOWN";
    setups[setup] = setups[setup] || { won: 0, lost: 0, netR: 0, gates: {} };
    const won = row.outcome === "TARGET";
    won ? setups[setup].won++ : setups[setup].lost++;
    setups[setup].netR += Number.isFinite(row.r) ? row.r : (won ? (Number(row.rr) || 1) : -1);
    const gate = row.gate || "UNSPECIFIED";
    setups[setup].gates[gate] = (setups[setup].gates[gate] || 0) + 1;
  }
  for (const s of Object.values(setups)) s.netR = Number(s.netR.toFixed(3));

  const allResolved = Object.values(gates).reduce((sum, g) => sum + g.resolved, 0);
  const allPending  = Object.values(gates).reduce((sum, g) => sum + g.pending, 0);
  const allNetR     = Object.values(gates).reduce((sum, g) => sum + g.netR, 0);

  return {
    available: true,
    gates,
    setups,
    totals: {
      rows: rows.length,
      malformed: malformed || 0,
      resolved: allResolved,
      pending: allPending,
      netR: Number(allNetR.toFixed(3)),
    },
    minResolvedForVerdict: MIN_RESOLVED_FOR_VERDICT,
    // Stated in the payload so no consumer can present this as realised edge.
    caveat: "Forgone PAPER trades on entries never filled: no spread, no slippage, "
      + "no partial fills, and a fixed scoring horizon. These are a screening signal for "
      + "which gate to investigate, NOT realised P&L and NOT a walk-forward. Where this "
      + "contradicts a walk-forward, the walk-forward wins.",
    feedsTheGate: false,
    updatedAt: new Date().toISOString(),
  };
}

module.exports = {
  buildEvidence,
  readScoredRows,
  summariseGate,
  verdictFor,
  SCORED_PATH,
  MIN_RESOLVED_FOR_VERDICT,
  VERDICT_TOO_FEW,
  VERDICT_EARNING,
  VERDICT_COSTING,
  VERDICT_NEUTRAL,
};
