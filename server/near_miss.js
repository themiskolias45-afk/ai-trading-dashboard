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
 *   - THE COUNTER IS IN MEMORY ONLY. noteNearMiss() opens no file and never has. It
 *     cannot corrupt learning.json, the journal, rejections.jsonl or the shadow stats,
 *     because it never touches any of them. That is unchanged and must stay unchanged:
 *     it is called from inside generateSignal, so any synchronous I/O added there would
 *     block the signal path on every refresh.
 *   - flushNearMisses() PERSISTS the counter, and is deliberately a SEPARATE function
 *     called from a cron tick OUTSIDE signal generation. See its own comment for why
 *     the in-memory-only property had to be kept while still surviving a restart.
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

// Where the census is persisted. Its own file on purpose: REJECTION-LEDGER-SPEC rule 3.1
// requires a rejection to have a FORMED setup with a real entry/stop/target triple, and a
// near miss has no formed setup. Writing here rather than into tasks/rejections.jsonl
// means the shared contract, both scorers and mt5_bridge.py stay untouched.
const fs   = require("fs");
const path = require("path");
const NEAR_MISS_LOG_PATH = path.join(__dirname, "..", "tasks", "near_misses.jsonl");

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

/**
 * Persist the census so it survives a restart. Append-only; never truncates, never
 * rewrites, never deletes.
 *
 * WHY THIS EXISTS. Measured 2026-08-27: `/api/near-miss` startedAt was
 * 2026-08-27T07:17:40.501Z and `/api/status` startedAt was 07:17:40.528Z - the same
 * instant. The census lifetime WAS the server uptime. BTC had been SIGNAL-DEAD for 16
 * days blocked at `D1 MOMENTUM RSI_ABOVE_CEILING thr 80, actual 80.6` - a margin of 0.6
 * of one RSI point, with every other MOMENTUM condition passing - and the whole 16 days
 * of that had accumulated nothing, because every restart wiped it. The RSI ceiling is
 * the binding constraint on how often this system trades and it is the ONLY blocker with
 * no rejection-ledger row, so it was unfalsifiable by construction. Observability that
 * does not survive is not observability.
 *
 * WHY IT IS NOT CALLED FROM noteNearMiss. noteNearMiss runs inside generateSignal. An
 * appendFileSync there would put disk I/O on the signal path on every refresh, which is
 * a far worse defect than the one being fixed. The counter stays purely in memory and
 * this runs on a cron tick instead.
 *
 * ONE ROW PER KEY PER UTC DAY. The scorable event is "at time T, this setup would have
 * fired but for RSI X against ceiling Y" - a walk-forward starts from T and needs no
 * more. Re-writing it every tick would add volume without adding information. Dedupe is
 * read back FROM THE FILE rather than held in a state file, the same shape
 * tasks/band_monitor.cjs uses and for the same reason: no second file to corrupt, and a
 * restart cannot make it forget what it already wrote.
 *
 * feedsTheGate stays false. Nothing here votes on confidence, on a threshold, or on
 * whether a signal fires. Do NOT let these rows move the ceiling on their own - they are
 * forgone paper setups and a walk-forward still wins wherever the two disagree.
 *
 * Returns a plain report and never throws: the caller is a cron tick and a failure here
 * must degrade to a log line, never take the server down.
 */
function flushNearMisses(nowIso) {
  const report = { written: 0, skipped: 0, malformed: 0, path: NEAR_MISS_LOG_PATH, error: null };
  try {
    const stamp = typeof nowIso === "string" ? nowIso : new Date().toISOString();
    const day   = stamp.slice(0, 10);

    const snapshot = nearMissCensus();
    if (!snapshot.available || !Array.isArray(snapshot.rows) || snapshot.rows.length === 0) {
      return report;
    }

    // Read back what today already has. A missing file is not an error - it is the
    // first flush. An unreadable one must NOT suppress the write: losing the row is the
    // failure being fixed, so a duplicate is strictly preferable to a silent drop.
    const alreadyWritten = new Set();
    try {
      if (fs.existsSync(NEAR_MISS_LOG_PATH)) {
        const lines = fs.readFileSync(NEAR_MISS_LOG_PATH, "utf8").split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const parsed = JSON.parse(trimmed);
            if (parsed && typeof parsed.key === "string") alreadyWritten.add(parsed.key);
          } catch (lineError) {
            // One corrupt line must not cost the whole dedupe set.
            report.malformed++;
          }
        }
      }
    } catch (readError) {
      report.error = `dedupe read failed (${readError.message}) - writing anyway`;
      console.error(`[near-miss] ${report.error}`);
    }

    const pending = [];
    for (const row of snapshot.rows) {
      const key = `${row.symbol}|${row.timeframe}|${row.setup}|${row.condition}|${day}`;
      if (alreadyWritten.has(key)) { report.skipped++; continue; }
      alreadyWritten.add(key);
      pending.push(JSON.stringify({
        key,
        at:         stamp,
        date:       day,
        symbol:     row.symbol,
        timeframe:  row.timeframe,
        setup:      row.setup,
        condition:  row.condition,
        threshold:  row.threshold,
        actual:     row.lastActual,
        margin:     row.minMargin,
        count:      row.count,
        firstAt:    row.firstAt,
        censusFrom: snapshot.startedAt,
        feedsTheGate: false,
      }));
    }

    if (pending.length === 0) return report;

    // One append for the batch: fewer partial-write windows than a call per row.
    fs.mkdirSync(path.dirname(NEAR_MISS_LOG_PATH), { recursive: true });
    fs.appendFileSync(NEAR_MISS_LOG_PATH, pending.join("\n") + "\n", "utf8");
    report.written = pending.length;
    return report;
  } catch (e) {
    report.error = e.message;
    console.error(`[near-miss] flush failed: ${e.message}`);
    return report;
  }
}

module.exports = { noteNearMiss, nearMissCensus, flushNearMisses, MAX_TRACKED_KEYS, NEAR_MISS_LOG_PATH };
