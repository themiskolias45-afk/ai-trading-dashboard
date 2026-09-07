'use strict';
/**
 * Stop-variant shadow ledger — what the SAME signal would have looked like with a
 * lower-timeframe stop.
 *
 * WHY THIS EXISTS. Every stop in this engine is `atrStop15 = atrVal * 1.5` at
 * server/index.js:1269, used at eleven sites, and `atrVal` is the DAILY ATR. Measured
 * against live broker bars on 2026-08-27:
 *
 *     GOLD   1.5x D1 ATR = 144.0 pts (3.13% of price)   1.5x H1 ATR = 25.9 (0.56%)  5.6x
 *     BTC    1.5x D1 ATR = 3277.8   (4.10%)             1.5x H1 ATR = 695.4 (0.87%) 4.7x
 *     SPX    1.5x D1 ATR = 102.4    (1.33%)             1.5x H1 ATR = 19.0  (0.25%) 5.4x
 *
 * That is not a bug: a daily stop on a daily setup is correct, and a tighter stop on a
 * daily signal is simply taken out by ordinary intraday noise. But the journal shows the
 * tight path already works when it happens — SP500 #1792687463 ran a 19.78-point stop
 * (0.26%) and returned +2.02R.
 *
 * The prize is not smaller risk, it is SPEED. The binding constraint on this system is
 * sample size, and the Gold D1 trade opened 2026-08-11 and closed 2026-08-25: fourteen
 * days for one data point. A 0.56% stop resolves in hours. Same signal, same gate, same
 * R:R, but each R is smaller in money and resolves far faster — which is the only thing
 * that actually moves the constraint.
 *
 * This module DOES NOT ACT ON THAT. It records what the alternative would have been so
 * the question can be settled with this account's own broker bars instead of an argument.
 *
 * HARD PROPERTIES — the caller depends on every one of them:
 *   - It NEVER changes a stop, a target, a signal, a threshold or a lot size. It computes
 *     numbers and appends them to its own file. `feedsTheGate` is false and stays false.
 *   - It is NOT called from generateSignal. It runs on a cron tick with the signal cache
 *     and the candle cache handed to it, so no disk I/O and no ATR maths ever lands on
 *     the signal path. This is the same separation server/near_miss.js keeps, for the
 *     same reason.
 *   - Append-only. No truncate, no rewrite, no unlink. A corrupt line is counted,
 *     reported and KEPT.
 *   - Every path swallows its own failure and returns a report, exactly as
 *     server/rejection_log.js and server/near_miss.js do, so a bug here cannot reach the
 *     trading path.
 *
 * NOT the rejection ledger and not the near-miss census. REJECTION-LEDGER-SPEC rule 3.1
 * governs tasks/rejections.jsonl and is untouched; near_miss.js answers "what stopped a
 * setup forming". This answers a third question — "the setup DID form, what would a
 * different stop have done" — and owns its own file so neither contract moves.
 */

const fs   = require("fs");
const path = require("path");

const STOP_VARIANT_LOG_PATH = path.join(__dirname, "..", "tasks", "stop_variants.jsonl");

// The multiple the live engine uses. Declared here so the shadow is measured against the
// SAME rule at a different timeframe, rather than against a second thing that also
// changed. If index.js ever stops using 1.5 this must follow it, or the comparison
// silently becomes about two variables at once.
const LIVE_ATR_MULTIPLE = 1.5;

// Period, matching the engine's default at index.js:1138.
const ATR_PERIOD = 14;

// Timeframes to shadow. d1 is the live baseline and is recorded on the row rather than
// as a variant of itself.
const VARIANT_TIMEFRAMES = ["h4", "h1"];

// Belt-and-braces against an unbounded caller, same reasoning as near_miss.js.
const MAX_ROWS_PER_FLUSH = 200;

// key -> true for rows this PROCESS already appended. Only a backstop for a persistent
// dedupe-read failure; the FILE remains the authority across restarts.
const writtenThisProcess = new Set();

/**
 * ATR over a sanitised bar series ({ highs, lows, closes } parallel arrays), computed
 * with the ENGINE'S OWN formula, deliberately.
 *
 * server/index.js:1138 `atr()` is a SIMPLE MEAN of the last `period` true ranges:
 *     trs.slice(-period).reduce((a, b) => a + b, 0) / period
 * It is NOT Wilder smoothing, despite ATR conventionally being Wilder and despite
 * calcADX() in the same file correctly using wilderSmooth() with a comment warning that
 * the wrong average moves a threshold decision. Measured 2026-08-27 on live broker bars,
 * a Wilder implementation disagreed with the engine by 0.99% on Gold, 14.1% on BTC and
 * 28.0% on SPX.
 *
 * That difference is NOT this module's business to correct. Changing the engine's ATR
 * would change every stop in the system. This shadow exists to isolate ONE variable -
 * the timeframe the ATR is measured on - so it must use whatever formula the live stop
 * uses. Using a "better" ATR here would compare two things at once and the result would
 * mean nothing. If index.js:1138 ever changes, this must follow it.
 *
 * Returns null rather than a wrong number if the series is short or malformed: a
 * fabricated ATR would silently produce a fabricated stop in the evidence file.
 */
function engineAtr(bars, period) {
  const n = Number.isFinite(period) ? period : ATR_PERIOD;
  if (!bars) return null;
  const highs = bars.highs, lows = bars.lows, closes = bars.closes;
  if (!Array.isArray(highs) || !Array.isArray(lows) || !Array.isArray(closes)) return null;
  const len = Math.min(highs.length, lows.length, closes.length);
  if (len < n + 1) return null;

  const trueRanges = [];
  for (let i = 1; i < len; i++) {
    const high = Number(highs[i]), low = Number(lows[i]), prevClose = Number(closes[i - 1]);
    if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(prevClose)) return null;
    trueRanges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  if (trueRanges.length < n) return null;

  // Simple mean of the LAST n true ranges - index.js:1138 verbatim.
  const window = trueRanges.slice(-n);
  let total = 0;
  for (const trueRange of window) total += trueRange;
  const average = total / n;

  return Number.isFinite(average) && average > 0 ? average : null;
}

function round(value, places) {
  const factor = Math.pow(10, places);
  return Math.round(value * factor) / factor;
}

/**
 * Build the shadow rows for ONE asset. Pure: no I/O, no globals, returns rows or a
 * reason it produced none. The reason is returned rather than logged so the caller can
 * report a silent asset instead of it just being absent.
 */
function computeStopVariants({ assetKey, signal, candleEntry, gate, stamp }) {
  const day = stamp.slice(0, 10);

  if (!signal || typeof signal !== "object") return { rows: [], skipped: "no signal" };

  const direction = signal.signal;
  if (direction !== "BUY" && direction !== "SELL") return { rows: [], skipped: "no direction" };

  const setup = signal.setup;
  if (!setup || setup === "WAIT" || setup === "NONE") return { rows: [], skipped: "no setup" };

  const entry     = Number(signal.entry);
  const liveStop  = Number(signal.stop);
  const liveTarget = Number(signal.target);
  if (!Number.isFinite(entry) || entry <= 0) return { rows: [], skipped: "no entry" };
  // Without a live stop AND target there is no R:R to hold constant, and a variant with
  // an invented R:R compares two things at once. Skip rather than guess.
  if (!Number.isFinite(liveStop) || !Number.isFinite(liveTarget)) {
    return { rows: [], skipped: "setup formed but carries no levels" };
  }

  const liveStopDistance = Math.abs(entry - liveStop);
  if (liveStopDistance <= 0) return { rows: [], skipped: "zero live stop distance" };
  const liveRr = Math.abs(liveTarget - entry) / liveStopDistance;
  if (!Number.isFinite(liveRr) || liveRr <= 0) return { rows: [], skipped: "live R:R not derivable" };

  const bars = candleEntry && candleEntry.bars ? candleEntry.bars : null;
  if (!bars) return { rows: [], skipped: "no MT5 bars for this asset" };

  // The baseline is the LIVE row, recorded beside every variant so a scorer never has to
  // reconstruct it and the two can never drift apart.
  const baseline = {
    timeframe:    signal.setupTimeframe || "d1",
    stop:         round(liveStop, 5),
    target:       round(liveTarget, 5),
    stopDistance: round(liveStopDistance, 5),
    stopPct:      round(liveStopDistance / entry * 100, 4),
    rr:           round(liveRr, 4),
    atr:          Number.isFinite(Number(signal.atr)) ? Number(signal.atr) : null,
  };

  const confidence = Number(signal.confidence);
  const fired = Number.isFinite(confidence) && Number.isFinite(gate) && confidence >= gate;

  const rows = [];
  const missing = [];
  for (const timeframe of VARIANT_TIMEFRAMES) {
    const atr = engineAtr(bars[timeframe], ATR_PERIOD);
    if (atr === null) { missing.push(timeframe); continue; }

    const stopDistance = atr * LIVE_ATR_MULTIPLE;
    if (!(stopDistance > 0)) { missing.push(timeframe); continue; }

    // Same R:R as the live signal, so the ONLY thing that differs is the stop scale.
    const stop   = direction === "BUY" ? entry - stopDistance : entry + stopDistance;
    const target = direction === "BUY" ? entry + stopDistance * liveRr : entry - stopDistance * liveRr;
    if (!(stop > 0) || !(target > 0)) { missing.push(timeframe); continue; }

    rows.push({
      key: `${candleEntry.symbol || assetKey}|${setup}|${direction}|${timeframe}|${fired ? "fired" : "formed"}|${day}`,
      at:   stamp,
      date: day,
      assetKey,
      symbol: candleEntry.symbol || null,
      ticker: signal.ticker || null,
      setup,
      direction,
      confidence: Number.isFinite(confidence) ? confidence : null,
      gate: Number.isFinite(gate) ? gate : null,
      // Whether this setup actually cleared the gate. Rows are kept either way: a formed
      // setup that did not fire is still evidence about stop geometry, and dropping it
      // would be the same blindness the rejection ledger was built to cure.
      fired,
      entry: round(entry, 5),
      variantTimeframe: timeframe,
      atrPeriod: ATR_PERIOD,
      atr: round(atr, 6),
      atrMultiple: LIVE_ATR_MULTIPLE,
      stop:         round(stop, 5),
      target:       round(target, 5),
      stopDistance: round(stopDistance, 5),
      stopPct:      round(stopDistance / entry * 100, 4),
      rr:           round(liveRr, 4),
      // How much tighter than what actually traded. The headline number.
      tighterThanLiveBy: round(liveStopDistance / stopDistance, 3),
      baseline,
      barsUsed: bars[timeframe] && bars[timeframe].closes ? bars[timeframe].closes.length : null,
      dataSource: signal.dataSource || null,
      sourceSymbol: signal.sourceSymbol || null,
      feedsTheGate: false,
    });
  }

  return { rows, skipped: missing.length ? `no usable bars for ${missing.join(",")}` : null };
}

/**
 * Read back which keys are already on file. A missing file is the first flush, not an
 * error. An UNREADABLE file must not suppress the write: losing the row is the failure
 * being prevented, so a duplicate is strictly preferable to a silent drop.
 */
function readExistingKeys(report) {
  const keys = new Set();
  try {
    if (!fs.existsSync(STOP_VARIANT_LOG_PATH)) return keys;
    const lines = fs.readFileSync(STOP_VARIANT_LOG_PATH, "utf8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed.key === "string") keys.add(parsed.key);
      } catch (lineError) {
        report.malformed++;
      }
    }
  } catch (readError) {
    report.error = `dedupe read failed (${readError.message}) - writing anyway`;
    console.error(`[stop-variants] ${report.error}`);
  }
  return keys;
}

/**
 * Compute and append. Called from a cron tick in index.js with the caches handed in.
 * Returns a plain report and never throws.
 */
function flushStopVariants({ signals, candles, gate, nowIso } = {}) {
  const report = {
    written: 0, skipped: 0, malformed: 0,
    path: STOP_VARIANT_LOG_PATH, error: null, reasons: {},
  };
  try {
    // Normalised through Date: the two boxes run in different timezones, and slice(0,10)
    // is only a UTC day if the string is Z-normalised.
    const parsed = nowIso === undefined ? new Date() : new Date(nowIso);
    const stamp  = Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString();

    if (!signals || typeof signals !== "object") { report.error = "no signal cache"; return report; }
    if (!candles || typeof candles !== "object") { report.error = "no candle cache"; return report; }

    const existing = readExistingKeys(report);
    for (const key of writtenThisProcess) existing.add(key);

    const pending = [];
    for (const assetKey of Object.keys(signals)) {
      if (assetKey === "updatedAt") continue;
      const candleEntry = candles[assetKey];
      if (!candleEntry) { report.reasons[assetKey] = "no MT5 bars for this asset"; continue; }

      const { rows, skipped } = computeStopVariants({
        assetKey, signal: signals[assetKey], candleEntry, gate, stamp,
      });
      if (skipped) report.reasons[assetKey] = skipped;

      for (const row of rows) {
        if (existing.has(row.key)) { report.skipped++; continue; }
        if (pending.length >= MAX_ROWS_PER_FLUSH) { report.skipped++; continue; }
        existing.add(row.key);
        writtenThisProcess.add(row.key);
        pending.push(JSON.stringify(row));
      }
    }

    if (pending.length === 0) return report;

    // One append for the batch: fewer partial-write windows than a call per row.
    fs.mkdirSync(path.dirname(STOP_VARIANT_LOG_PATH), { recursive: true });
    fs.appendFileSync(STOP_VARIANT_LOG_PATH, pending.join("\n") + "\n", "utf8");
    report.written = pending.length;
    return report;
  } catch (e) {
    report.error = e.message;
    console.error(`[stop-variants] flush failed: ${e.message}`);
    return report;
  }
}

/** Read-only summary for a route or a report. Never throws. */
function stopVariantSummary(limit) {
  try {
    if (!fs.existsSync(STOP_VARIANT_LOG_PATH)) {
      return { available: true, rows: 0, recent: [], feedsTheGate: false };
    }
    const lines = fs.readFileSync(STOP_VARIANT_LOG_PATH, "utf8").split("\n").filter(l => l.trim());
    const parsedRows = [];
    let malformed = 0;
    for (const line of lines) {
      try { parsedRows.push(JSON.parse(line)); } catch (e) { malformed++; }
    }
    const take = Number.isFinite(limit) && limit > 0 ? limit : 20;
    return {
      available: true,
      rows: parsedRows.length,
      malformed,
      recent: parsedRows.slice(-take),
      feedsTheGate: false,
      whatThisIs:
        "What the SAME signal would have looked like with a lower-timeframe ATR stop, at " +
        "the SAME R:R. Nothing here changed a stop, a target or a trade: these are shadow " +
        "geometries for measurement, not fills. They carry no spread and no slippage, so " +
        "they are evidence about stop SCALE and resolution SPEED, never realised P&L.",
    };
  } catch (e) {
    return { available: false, reason: e.message, feedsTheGate: false };
  }
}

module.exports = {
  flushStopVariants,
  computeStopVariants,
  stopVariantSummary,
  engineAtr,
  STOP_VARIANT_LOG_PATH,
  LIVE_ATR_MULTIPLE,
  ATR_PERIOD,
  VARIANT_TIMEFRAMES,
};
