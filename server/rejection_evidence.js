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

// R per episode inside this band is noise, not a finding. Mirrors
// NEUTRAL_R_PER_EPISODE in tasks/score_rr_rejections.py. Without it a gate that came
// out at +0.07R/episode reads as "COSTING MONEY" purely because the absolute total
// crossed 1R, which is a function of sample size rather than of edge.
const NEUTRAL_R_PER_EPISODE = 0.10;

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

function isResolved(row) {
  return row.outcome === "TARGET" || row.outcome === "STOP";
}

/**
 * One entry per episode, which is the unit of evidence this ledger deals in.
 *
 * The gates re-fire on every refresh, so a single setup that stands for a day
 * produces dozens of rows minutes apart. tasks/score_rr_rejections.py already
 * groups them — group_episodes() keys on gate, instrument, timeframe, setup and
 * direction within EPISODE_GAP_BARS — and stamps each row with an `episode` id
 * precisely so nothing downstream counts them as independent bets. This module
 * read that file for weeks and ignored the field while printing the word
 * "episodes" in its own verdicts: 768 rows are 113 episodes, so every sample size
 * it served was 2-4x too large. DUPLICATE was the worst case — 49 of its 51 rows
 * were ONE Gold BUY re-offered every poll cycle across five days while that exact
 * position was already open, which alone produced a COSTING MONEY verdict.
 *
 * Selection mirrors episodes_from_scored(): the first row of the episode that
 * actually resolved to an R figure, else the first row, so an episode still
 * appears in the PENDING/unscorable counts rather than vanishing.
 *
 * A row with no `episode` id is its own episode. That is the legacy ledger
 * written before the scorer stamped them, and treating a missing id as a shared
 * one would collapse the entire file into a single observation.
 */
function collapseToEpisodes(rows) {
  const byEpisode = new Map();
  const unstamped = [];
  for (const row of rows) {
    const id = row.episode;
    if (id === undefined || id === null) { unstamped.push(row); continue; }
    const held = byEpisode.get(id);
    if (held === undefined) { byEpisode.set(id, row); continue; }
    if (!Number.isFinite(held.r) && Number.isFinite(row.r)) byEpisode.set(id, row);
  }
  return [...byEpisode.values(), ...unstamped];
}

/**
 * TARGET → the rejected setup would have reached its target: the gate cost you
 * that trade. STOP → it would have lost: the gate saved you. PENDING → the
 * scoring horizon has not elapsed. NO_DATA → unscorable, usually a missing
 * sourceSymbol, and per the spec that is recorded rather than guessed.
 *
 * Expects rows already collapsed by collapseToEpisodes.
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
  // Both tests must pass before a direction is claimed: enough total R to be worth
  // naming, AND enough per episode to be distinguishable from noise. The absolute
  // test alone lets a large sample of near-zero episodes cross 1R and read as a
  // finding; the per-episode test alone lets three lucky episodes read as one.
  const rPerEpisode = bucket.netR / bucket.resolved;
  if (bucket.netR > 1 && rPerEpisode >= NEUTRAL_R_PER_EPISODE) {
    return {
      verdict: VERDICT_COSTING,
      detail: "rejections would have returned " + bucket.netR.toFixed(2) + "R over "
        + bucket.resolved + " episodes (" + winRate.toFixed(0) + "% would have won) — "
        + "this gate is charging the account for setups that paid",
    };
  }
  if (bucket.netR < -1 && rPerEpisode <= -NEUTRAL_R_PER_EPISODE) {
    return {
      verdict: VERDICT_EARNING,
      detail: "rejections would have lost " + bucket.netR.toFixed(2) + "R over "
        + bucket.resolved + " episodes — the gate is doing its job",
    };
  }
  return {
    verdict: VERDICT_NEUTRAL,
    detail: "rejections net " + bucket.netR.toFixed(2) + "R over " + bucket.resolved
      + " episodes (" + rPerEpisode.toFixed(3) + "R each, band ±"
      + NEUTRAL_R_PER_EPISODE.toFixed(2) + ") — inside the noise",
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

  // Collapse ONCE, here, so the per-gate view and the cross-gate setup view below
  // both count episodes. They used to disagree with each other and with the Python
  // report that writes the file they read.
  const episodes = collapseToEpisodes(rows);

  const rawRowsByGate = {};
  for (const row of rows) {
    const gate = row.gate || "UNSPECIFIED";
    rawRowsByGate[gate] = (rawRowsByGate[gate] || 0) + 1;
  }

  const byGate = {};
  for (const episode of episodes) {
    const gate = episode.gate || "UNSPECIFIED";
    (byGate[gate] = byGate[gate] || []).push(episode);
  }

  const gates = {};
  for (const [gate, gateEpisodes] of Object.entries(byGate)) {
    const bucket = summariseGate(gateEpisodes);
    const judged = verdictFor(bucket);
    gates[gate] = {
      resolved: bucket.resolved,
      wouldHaveWon: bucket.wouldHaveWon,
      wouldHaveLost: bucket.wouldHaveLost,
      wouldHaveWonPct: bucket.resolved ? Math.round((bucket.wouldHaveWon / bucket.resolved) * 100) : null,
      netR: Number(bucket.netR.toFixed(3)),
      rPerEpisode: bucket.resolved ? Number((bucket.netR / bucket.resolved).toFixed(3)) : null,
      pending: bucket.pending,
      unscorable: bucket.unscorable,
      // `total` stays the denominator of the counts above, which is now episodes, so
      // resolved + pending + unscorable === total still holds. `rows` carries the raw
      // ledger count alongside it, because the ratio between them is itself the
      // signal that a setup stood for days rather than recurring.
      total: gateEpisodes.length,
      rows: rawRowsByGate[gate] || gateEpisodes.length,
      setups: bucket.setups,
      symbols: bucket.symbols,
      verdict: judged.verdict,
      detail: judged.detail,
    };
  }

  // Cross-gate setup view: which SETUPS are being thrown away, whatever killed them.
  // Episodes, not rows, for the same reason as above — RANGE_TRADE_SHORT's record was
  // the loudest thing on this board and most of it was one short seen many times.
  const setups = {};
  for (const row of episodes) {
    if (!isResolved(row)) continue;
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
      episodes: episodes.length,
      malformed: malformed || 0,
      resolved: allResolved,
      pending: allPending,
      netR: Number(allNetR.toFixed(3)),
    },
    minResolvedForVerdict: MIN_RESOLVED_FOR_VERDICT,
    neutralRPerEpisode: NEUTRAL_R_PER_EPISODE,
    // Stated so no reader has to infer it from the numbers: every count above is a
    // count of EPISODES, matching tasks/score_rr_rejections.py. `totals.rows` is the
    // only raw ledger figure in the payload.
    countsAre: "episodes",
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
  collapseToEpisodes,
  summariseGate,
  verdictFor,
  SCORED_PATH,
  MIN_RESOLVED_FOR_VERDICT,
  NEUTRAL_R_PER_EPISODE,
  VERDICT_TOO_FEW,
  VERDICT_EARNING,
  VERDICT_COSTING,
  VERDICT_NEUTRAL,
};
