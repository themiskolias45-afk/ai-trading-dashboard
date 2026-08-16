'use strict';
/**
 * Near-miss census — the setups that ALMOST formed.
 *
 * Why this exists. SP500 has never traded in this system's life. On 2026-08-16 it was
 * STRONG UPTREND, above all three EMAs, MACD bullish and ADX 22.8, and it missed
 * MOMENTUM by 0.7 RSI points: the band is `rsi > 52 && rsi < 72` and RSI was 72.7.
 * Nothing counted that anywhere. logGateRejection fires at index.js:1398/1464/1942,
 * every one of them DOWNSTREAM of setup formation, so a condition that stops a setup
 * from forming never reaches a gate and never writes a row. The rejection ledger — the
 * tool built to answer "why does it never trade" — is structurally blind to it, and so
 * is /api/gate-health, which reports on gates that fired.
 *
 * This is NOT the rejection ledger and must never be confused with it.
 * tasks/REJECTION-LEDGER-SPEC.md rule 3.1 says a rejection requires a setup that FORMED,
 * with a real entry/stop/target triple. A near miss has no formed setup, so it is not a
 * rejection and no row belongs in tasks/rejections.jsonl. Rule 3.1 exists to keep 3799
 * XAUUSD BOTH_WAIT steps out of the evidence file, and that reasoning is sound. What
 * follows is a bounded in-memory counter instead: it answers "how often, and by how
 * much" without touching the ledger's schema, its scorers, or the bridge that shares
 * them.
 *
 * HARD PROPERTIES, all of which the caller depends on:
 *   - IN MEMORY ONLY. Writes no file. It cannot corrupt learning.json, the journal,
 *     rejections.jsonl or the shadow stats, because it never opens any of them.
 *   - Reset on restart, by design. This is a census, not a source of truth.
 *   - feedsTheGate is false and stays false. Nothing here votes on confidence, on a
 *     threshold, or on whether a signal fires.
 *   - Every path swallows its own failure and returns false, exactly as
 *     server/rejection_log.js does, so a bug here can never reach the trading path.
 */

// The counter is keyed sourceSymbol|timeframe|setup|condition, which is a small closed
// product: 3 symbols x 3 timeframes x a handful of instrumented conditions. The cap is
// belt-and-braces against a caller that ever passes something unbounded — the map stops
// growing rather than becoming the reason the process runs out of memory.
const MAX_TRACKED_KEYS = 500;

const census = new Map();
const startedAt = new Date().toISOString();
let droppedForCap = 0;

function trimmedOrNull(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function finiteOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/**
 * Record one near miss: a named setup whose every other condition passed, defeated by
 * a single measurable one.
 *
 * `threshold` is the bar and `actual` is what it read, the same pair the rejection
 * ledger carries, so a later sweep can ask "what if the bar had been X" without
 * re-deriving anything. Returns true only if a row was counted.
 */
function noteNearMiss(record) {
  try {
    if (!record || typeof record !== "object") return false;

    const symbol    = trimmedOrNull(record.symbol);
    const setup     = trimmedOrNull(record.setup);
    const condition = trimmedOrNull(record.condition);
    const timeframe = trimmedOrNull(record.timeframe) ?? "?";
    // A row without these cannot be attributed to anything, and a guessed symbol is
    // how the rejection ledger lost 182 rows to "no sourceSymbol". Drop, never invent.
    if (!symbol || !setup || !condition) return false;

    const actual    = finiteOrNull(record.actual);
    const threshold = finiteOrNull(record.threshold);
    if (actual === null || threshold === null) return false;

    const margin = Math.abs(actual - threshold);
    const key = `${symbol}|${timeframe}|${setup}|${condition}`;

    let row = census.get(key);
    if (!row) {
      if (census.size >= MAX_TRACKED_KEYS) { droppedForCap++; return false; }
      row = {
        symbol, timeframe, setup, condition,
        threshold,
        count: 0,
        minMargin: margin,
        maxMargin: margin,
        lastActual: actual,
        lastAt: null,
        firstAt: new Date().toISOString(),
      };
      census.set(key, row);
    }

    row.count++;
    row.threshold  = threshold;
    row.lastActual = actual;
    row.lastAt     = new Date().toISOString();
    if (margin < row.minMargin) row.minMargin = margin;
    if (margin > row.maxMargin) row.maxMargin = margin;
    return true;
  } catch (e) {
    // Observability degrades to silence; it never takes the caller down.
    console.error("[near-miss] census write failed:", e.message);
    return false;
  }
}

/** Read-only snapshot. Closest misses first — those are the ones worth arguing about. */
function nearMissCensus() {
  try {
    const rows = [...census.values()]
      .map(row => ({
        ...row,
        minMargin: Number(row.minMargin.toFixed(4)),
        maxMargin: Number(row.maxMargin.toFixed(4)),
      }))
      .sort((a, b) => a.minMargin - b.minMargin || b.count - a.count);

    return {
      available: true,
      startedAt,
      tracked: rows.length,
      droppedForCap,
      totalNearMisses: rows.reduce((sum, row) => sum + row.count, 0),
      rows,
      feedsTheGate: false,
      whatThisIs:
        "Setups whose every other condition passed and which died on ONE measurable " +
        "condition, counted in memory since the last restart. NOT rejections: no setup " +
        "formed, so there is no entry/stop/target triple and nothing here belongs in " +
        "tasks/rejections.jsonl (REJECTION-LEDGER-SPEC rule 3.1). A count says how often " +
        "a bar was missed and by how much. It does NOT say the bar is wrong — only a " +
        "walk-forward can say that.",
    };
  } catch (e) {
    console.error("[near-miss] census read failed:", e.message);
    return { available: false, reason: e.message, feedsTheGate: false };
  }
}

module.exports = { noteNearMiss, nearMissCensus, MAX_TRACKED_KEYS };
