'use strict';
/**
 * SHADOW SHORT LEDGER — the read side.
 *
 * tasks/shadow_short_ledger.py writes two files nightly: an append-only ledger of every
 * downside break the engine has no setup for, and a derived _scored file where each one
 * has been walked forward on real broker bars. This module is what lets anything READ
 * them over HTTP.
 *
 * WHY THAT MATTERS ENOUGH TO BE ITS OWN FILE. On 2026-08-28 Gold fell 4631 -> 4530 inside
 * one H1 bar and produced no signal, no rejection row and no near-miss, because every
 * learning surface in this system keys off a setup that FORMED. The ledger fixed the
 * recording. But a ledger nothing reads can never become a verdict — that is exactly what
 * happened to the near-miss census for weeks, and to the candle-probability artifact that
 * had no caller at all. Writing the rows is half the job; this is the other half.
 *
 * WHAT THIS IS NOT. Not a proposal to trade the short side. The break-down family was
 * walk-forwarded over 5.1 years of H1 on 2026-08-28 and does NOT survive out of sample:
 * nested walk-forward gave GOLD 2/4 folds and mean +0.005R, BTC 2/4 / +0.185R, SPX 1/4 /
 * -0.063R, with in-sample means of +0.26R..+0.93R collapsing to zero. A 216-variant sweep
 * that appeared to show +1.45R was a look-ahead bug. This surface exists so that verdict
 * can be re-checked against LIVE bars months from now instead of re-argued.
 *
 * IT FEEDS NOTHING. No gate, no threshold, no stop, no sizing, no signal admitted or
 * suppressed. feedsTheGate is false in every payload and stays false.
 */

const fs = require('fs');
const path = require('path');

const LEDGER_PATH = path.join(__dirname, '..', 'tasks', 'shadow_shorts.jsonl');
const SCORED_PATH = path.join(__dirname, '..', 'tasks', 'shadow_shorts_scored.jsonl');

// Below this many resolved episodes a mean is an anecdote, not a reading. Same floor the
// rejection ledger uses, deliberately: two surfaces that answer "is this worth anything"
// with different floors would disagree for no reason a reader could see.
const MIN_RESOLVED_FOR_VERDICT = 5;

// Re-reading ~100KB per request is wasteful when the writer touches these files once a
// night. Keyed on both files' mtime+size, so a rewrite is picked up immediately and a
// stale answer is impossible.
let cache = { key: null, payload: null };

function fingerprint() {
  const parts = [];
  for (const filePath of [LEDGER_PATH, SCORED_PATH]) {
    try {
      const stat = fs.statSync(filePath);
      parts.push(`${stat.mtimeMs}:${stat.size}`);
    } catch (e) {
      parts.push('absent');
    }
  }
  return parts.join('|');
}

function readRows(filePath) {
  // A single corrupt line must never cost the whole file. It is COUNTED and reported
  // rather than swallowed — an error not mentioned is an error hidden.
  if (!fs.existsSync(filePath)) return { rows: [], malformed: 0, present: false };
  const rows = [];
  let malformed = 0;
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch (e) {
      malformed++;
    }
  }
  return { rows, malformed, present: true };
}

function summariseAsset(episodes) {
  const values = episodes
    .map(e => Number(e.r))
    .filter(v => Number.isFinite(v));
  if (!values.length) {
    return { resolved: 0, meanR: null, totalR: 0, winRatePct: null,
             verdict: 'TOO FEW TO JUDGE', outcomes: {} };
  }
  const totalR = values.reduce((sum, v) => sum + v, 0);
  const meanR = totalR / values.length;
  const wins = values.filter(v => v > 0).length;
  const outcomes = {};
  for (const episode of episodes) {
    const label = episode.outcome || 'UNKNOWN';
    outcomes[label] = (outcomes[label] || 0) + 1;
  }
  // WOULD HAVE PAID does not mean "trade it". It means this cohort of forgone paper
  // trades came out positive, which is a screening signal and nothing more.
  const verdict = values.length < MIN_RESOLVED_FOR_VERDICT
    ? 'TOO FEW TO JUDGE'
    : meanR > 0 ? 'WOULD HAVE PAID' : 'WOULD HAVE COST';
  return {
    resolved: values.length,
    meanR: Number(meanR.toFixed(4)),
    totalR: Number(totalR.toFixed(2)),
    winRatePct: Number((wins / values.length * 100).toFixed(1)),
    verdict,
    outcomes,
  };
}

/** Read-only summary for a route or a report. Never throws. */
function shadowShortSummary() {
  const key = fingerprint();
  if (cache.key === key && cache.payload) return cache.payload;

  let payload;
  try {
    const ledger = readRows(LEDGER_PATH);
    const scored = readRows(SCORED_PATH);

    if (!ledger.present) {
      payload = {
        available: true,
        logged: 0,
        resolved: 0,
        stillOpen: 0,
        byAsset: {},
        overall: summariseAsset([]),
        feedsTheGate: false,
        note: 'No ledger yet. tasks/shadow_short_ledger.py has not run on this box.',
      };
    } else {
      const byAsset = {};
      for (const episode of scored.rows) {
        const asset = episode.asset || 'unknown';
        (byAsset[asset] || (byAsset[asset] = [])).push(episode);
      }
      const assetSummaries = {};
      for (const asset of Object.keys(byAsset).sort()) {
        assetSummaries[asset] = summariseAsset(byAsset[asset]);
      }
      let updatedAt = null;
      try {
        updatedAt = fs.statSync(SCORED_PATH).mtime.toISOString();
      } catch (e) {
        updatedAt = null;
      }
      payload = {
        available: true,
        logged: ledger.rows.length,
        resolved: scored.rows.length,
        // Candidates whose horizon has not elapsed. Reported, never guessed at.
        stillOpen: Math.max(0, ledger.rows.length - scored.rows.length),
        malformedLines: ledger.malformed + scored.malformed,
        byAsset: assetSummaries,
        overall: summariseAsset(scored.rows),
        updatedAt,
        feedsTheGate: false,
      };
    }

    payload.setup = 'SHADOW_BREAK_SHORT';
    payload.minResolvedForVerdict = MIN_RESOLVED_FOR_VERDICT;
    payload.whatThisIs =
      'Downside breaks for which the engine has NO setup at all — upstream of every gate ' +
      'and of the near-miss census, both of which require a setup to have formed. Each is ' +
      'priced as a paper trade and walked forward on real broker bars.';
    payload.caveat =
      'FORGONE PAPER trades: a flat cost charged in R, no spread modelling, no slippage, ' +
      'no entry ever filled, and a fixed horizon. A screening signal, not realised P&L. ' +
      'Where this contradicts a walk-forward, the walk-forward wins.';
    payload.whatWouldChangeTheAnswer =
      'Several hundred resolved episodes from LIVE bars turning the mean positive on more ' +
      'than one asset, which would contradict the 5.1-year nested walk-forward that found ' +
      'no out-of-sample edge (GOLD 2/4 folds, BTC 2/4, SPX 1/4).';
  } catch (e) {
    // A read surface that throws is worse than one that says it cannot answer: the caller
    // gets a 500 and no reason, and the nightly job looks broken when only the reader is.
    //
    // Returned WITHOUT caching, deliberately. The cache key is the two files' mtime+size,
    // so caching a failure would pin it until the writer next touches them — a transient
    // EBUSY while the nightly job swaps the scored file would then be served as a hard
    // "unavailable" for the rest of the day, long after the condition cleared.
    console.error(`[shadow-shorts] read failed: ${e.message}`);
    return { available: false, reason: e.message, byAsset: {}, feedsTheGate: false };
  }

  cache = { key, payload };
  return payload;
}

module.exports = {
  shadowShortSummary,
  LEDGER_PATH,
  SCORED_PATH,
  MIN_RESOLVED_FOR_VERDICT,
};
