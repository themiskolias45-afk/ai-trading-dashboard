#!/usr/bin/env node
/**
 * macd_cross_monitor - alert when the MACD histogram crosses UP through zero, which is
 * the one condition currently standing between Gold and a live TREND_FOLLOW setup.
 *
 * WHY THIS EXISTS
 * Measured 2026-09-02 15:30Z, Gold: signal WAIT, confidence 0 against a live gate of 70,
 * and the engine named exactly one blocker -
 *   "BLOCKED: TREND_FOLLOW - MACD not bullish (histogram -26.78). Every other
 *    TREND_FOLLOW condition passed."
 * Every other leg had passed. That makes the zero-cross the single observable that turns
 * a dead chart into a candidate, and it is invisible unless something watches for it: the
 * histogram appears in no alert, no panel headline and no scheduled job.
 *
 * WHAT IT IS NOT - the three constraints this was built under, taken from band_monitor.cjs
 *   - It NEVER blocks a signal. GETs only. Nothing here is imported by the engine, it
 *     holds no lock on the signal path, and it cannot suppress or admit a setup.
 *     feedsTheGate is false in the same sense every other observer here means it.
 *   - It NEVER blocks or touches learning. It does not open learning.json, journal.json,
 *     the shadow ledger, the rejection ledger or the calibration record - not to write,
 *     not even to read. Sample size is the binding constraint on this system.
 *   - It NEVER deletes. The log is opened with appendFile and only ever grows. No
 *     rotation, no truncation, no unlink, and deliberately NO separate state file: the
 *     previous histogram sign is recovered by reading the log back, so there is no second
 *     file that could be overwritten or corrupted.
 *
 * A CROSS IS NOT A TRADE, AND THIS ALERT MUST NEVER READ LIKE ONE.
 * MACD turning bullish is NECESSARY for TREND_FOLLOW, not SUFFICIENT - confidence still
 * has to reach the live gate. The message therefore carries the live gate and the live
 * confidence, both read fresh every run, and states which of the two is still short. The
 * gate is NEVER hardcoded here: a copied threshold that drifts from the live one is a bug
 * this project has already shipped five times.
 *
 * ABSENCE IS NOT AN ANSWER ABOUT THE MARKET.
 * An unreachable server, a null payload and a missing histogram are answers about the
 * MEASUREMENT. None of them records a sign, so none can raise a cross OR suppress one:
 * the run exits non-zero having written nothing, and the next good read still compares
 * against the last real sign rather than against a gap.
 *
 *   node tasks/macd_cross_monitor.cjs              # one pass, print and record
 *   node tasks/macd_cross_monitor.cjs --quiet      # print only on a cross (for schedulers)
 *   node tasks/macd_cross_monitor.cjs --no-alert   # record but never invoke the notifier
 *
 * EXIT CODES
 *   0  ran cleanly (whether or not anything crossed)
 *   1  could not read the server at all - a real failure worth a RED
 *   2  read the server but no asset carried a usable histogram, so nothing could be judged
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const HOST = process.env.SMARTENTRY_HOST || "http://localhost:3001";
const PROJECT_ROOT = path.join(__dirname, "..");
// Overridable ONLY so the cross branch can be proven against a stub without writing
// fake signs into the real history. Unset in every scheduled run; the default is
// the real log. A branch that has never executed is not a verified branch.
const LOG_PATH = process.env.MACD_MONITOR_LOG
  || path.join(__dirname, "logs", "macd_cross_monitor.txt");
const FETCH_TIMEOUT_MS = 8000;

const ASSET_KEYS = ["btc", "gold", "spx"];

const args = new Set(process.argv.slice(2));
const QUIET = args.has("--quiet");
const NO_ALERT = args.has("--no-alert");

function say(message) {
  if (!QUIET) console.log(message);
}

/**
 * GET one JSON route. Never throws: the caller gets {ok:false, error} instead, because a
 * monitor that dies on a transient socket error reports nothing on exactly the morning
 * something happened.
 */
async function getJson(pathname) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(HOST + pathname, { signal: controller.signal });
    if (!response.ok) return { ok: false, error: "HTTP " + response.status, status: response.status };
    return { ok: true, body: await response.json() };
  } catch (e) {
    return { ok: false, error: e.name === "AbortError" ? "timeout after " + FETCH_TIMEOUT_MS + "ms" : e.message };
  } finally {
    clearTimeout(timer);
  }
}

/** Append one line. Creates the directory and the file if absent; never truncates. */
function appendLog(line) {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, line + "\n", "utf8");
    return true;
  } catch (e) {
    console.error("[macd_cross] could not append to " + LOG_PATH + ": " + e.message);
    return false;
  }
}

/**
 * The last sign this monitor actually RECORDED for one asset, or null if it never has.
 * Read back from the log rather than held in a state file.
 *
 * null is the honest answer on a first run and it deliberately produces NO alert: with no
 * previous sign there is no crossing to claim. Inventing one would fire a false entry
 * alert on the first execution of every new deployment.
 */
function lastRecordedSign(assetKey) {
  try {
    if (!fs.existsSync(LOG_PATH)) return null;
    const marker = "sign=" + assetKey + ":";
    const lines = fs.readFileSync(LOG_PATH, "utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const at = lines[i].indexOf(marker);
      if (at !== -1) return lines[i].slice(at + marker.length).split(/\s/)[0] || null;
    }
    return null;
  } catch (e) {
    // Unreadable log: say so and claim no previous sign rather than guess one.
    console.error("[macd_cross] could not read log for previous sign (" + e.message + ")");
    return null;
  }
}

/**
 * Resolve Python through the shared resolver, never the bare name. execFile does NOT go
 * through a shell, so on Windows it cannot use PATHEXT and cannot find python.exe from the
 * bare word - measured in band_monitor.cjs, where the whole alert path was dead with
 * "spawn python ENOENT" while detection and the log looked perfectly healthy.
 */
function pythonExe() {
  try {
    return require(path.join(PROJECT_ROOT, "server", "python_path.js")).pythonBinOrDefault();
  } catch (e) {
    console.error("[macd_cross] python_path.js unavailable (" + e.message + ") - falling back to python");
    return "python";
  }
}

/** Best-effort notifier. A failure here is reported and never changes the exit code. */
function sendAlert(message) {
  if (NO_ALERT) return;
  execFile(pythonExe(), [path.join(PROJECT_ROOT, "notifications.py"), "alert", message],
    { cwd: PROJECT_ROOT, timeout: 20000 },
    function (error, stdout, stderr) {
      if (error) {
        console.error("[macd_cross] notifier failed (" + error.message + ") - the record in "
          + path.basename(LOG_PATH) + " is still authoritative");
        if (stderr && stderr.trim()) console.error("[macd_cross] notifier stderr: " + stderr.trim());
      }
    });
}

function histogramOf(signal) {
  const h = signal && signal.indicators && signal.indicators.macd
    ? signal.indicators.macd.histogram : null;
  return Number.isFinite(h) ? h : null;
}

async function main() {
  const stamp = new Date().toISOString();

  const signals = await getJson("/api/signals");
  if (!signals.ok) {
    // Cannot see the market. Record nothing: a gap must never read as a cross, and must
    // never suppress the next real one either.
    console.error("[macd_cross] " + stamp + " cannot read /api/signals (" + signals.error
      + ") - no sign recorded");
    process.exitCode = 1;
    return;
  }

  // The gate is read LIVE every run and used only to describe how far the setup is from
  // firing. It is never compared against a copy held in this file.
  const settings = await getJson("/api/strategy-settings");
  const gate = settings.ok && settings.body && Number.isFinite(settings.body.confidenceThreshold)
    ? settings.body.confidenceThreshold : null;
  const settingsError = settings.ok
    ? (settings.body && settings.body.settingsError) || null
    : "unreadable (" + settings.error + ")";

  let judged = 0;
  let crossed = 0;

  for (const key of ASSET_KEYS) {
    const signal = signals.body && signals.body[key];
    const histogram = histogramOf(signal);

    if (histogram === null) {
      // A missing histogram is a broken read, not a flat market. Say so, record nothing.
      say("[macd_cross] " + stamp + " " + key.toUpperCase()
        + ": no usable MACD histogram - not judged");
      continue;
    }
    judged++;

    const sign = histogram >= 0 ? "pos" : "neg";
    const previous = lastRecordedSign(key);
    const confidence = Number.isFinite(signal.confidence) ? signal.confidence : null;
    const isCrossUp = previous === "neg" && sign === "pos";

    appendLog(stamp + " sign=" + key + ":" + sign + " hist=" + histogram.toFixed(2)
      + " conf=" + (confidence === null ? "?" : confidence)
      + " gate=" + (gate === null ? "?" : gate)
      + " prev=" + (previous === null ? "none" : previous)
      + (isCrossUp ? " CROSS_UP" : ""));

    if (!isCrossUp) {
      say("[macd_cross] " + stamp + " " + key.toUpperCase() + ": hist " + histogram.toFixed(2)
        + " (" + sign + ")" + (previous === null ? " - first record, no cross claimed" : ""));
      continue;
    }

    crossed++;

    // NECESSARY, NOT SUFFICIENT. Say what still has to happen; never imply an entry.
    const stillShort = (gate === null || confidence === null)
      ? "gate or confidence unreadable this run - check /api/signals before acting"
      : confidence >= gate
        ? "confidence " + confidence + " is AT/ABOVE the live gate " + gate + " - check the setup now"
        : "confidence " + confidence + " is still " + (gate - confidence) + "pt BELOW the live gate " + gate;

    const message = "MACD CROSSED UP - " + String(signal.label || key).toUpperCase() + "\n"
      + "histogram " + histogram.toFixed(2) + " (was " + previous + ")\n"
      + stillShort + "\n"
      + "setup now: " + (signal.setup || "?") + " | signal: " + (signal.signal || "?") + "\n"
      + (settingsError ? "WARNING settingsError: " + settingsError + "\n" : "")
      + "A cross is NECESSARY for TREND_FOLLOW, not sufficient. This is not a trade instruction.";

    say("[macd_cross] " + stamp + " " + key.toUpperCase() + ": CROSS UP - " + stillShort);
    sendAlert(message);
  }

  if (judged === 0) {
    console.error("[macd_cross] " + stamp
      + " server answered but no asset carried a usable histogram");
    process.exitCode = 2;
    return;
  }
  say("[macd_cross] " + stamp + " judged " + judged + "/" + ASSET_KEYS.length
    + ", " + crossed + " cross(es)");
}

main().catch(function (e) {
  console.error("[macd_cross] unhandled: " + (e && e.message ? e.message : e));
  process.exitCode = 1;
});
