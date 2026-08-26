#!/usr/bin/env node
/**
 * band_monitor — watch for a setup FIRING inside the RSI band that the ceiling
 * change on 2026-08-26 newly admitted.
 *
 * WHY THIS EXISTS
 * The ceiling moved from 72/68 to 80/76 that day. The sweep says that is the better
 * setting (5/5 folds against 2/5), but a walk-forward is not a live result. The change
 * only ever pays off through a setup that fires with its RSI between the OLD ceiling
 * and the NEW one — a trade the old configuration would have vetoed. Those are the only
 * live evidence the decision will ever produce, and without this they are invisible:
 * they look exactly like any other firing in the journal, and nothing marks them as
 * attributable to the change.
 *
 * WHAT IT IS NOT — the three constraints this was built under
 *   • It NEVER blocks a signal. It issues GETs only, against routes that are already
 *     readable without a login, and it holds no lock on the signal path. Nothing here
 *     is imported by the engine and nothing here can suppress a setup. feedsTheGate is
 *     false in the same sense every other observer in this project means it.
 *   • It NEVER blocks or touches learning. It does not open learning.json, journal.json,
 *     the shadow ledger, the rejection ledger or the calibration record — not even to
 *     read them. Sample size is the binding constraint here and nothing that slows
 *     accumulation is worth what it saves.
 *   • It NEVER deletes. The log is opened with appendFile and only ever grows. There is
 *     no rotation, no truncation, no unlink, and deliberately NO separate state file:
 *     dedupe is derived by reading the log back, so there is no second file that could
 *     be overwritten or corrupted. Nothing this program can do removes a byte.
 *
 * THE CEILING IS READ LIVE, NEVER HARDCODED
 * The new ceiling comes from GET /api/strategy-settings every run. Hardcoding a
 * threshold here would repeat the bug this project has already had five times — a gate
 * copy that drifts from the live one and reports a number nobody is trading. The only
 * hardcoded figures are PREVIOUS_CEILING, and those are a historical fact (the values in
 * force before 2026-08-26), not a live setting.
 *
 *   node tasks/band_monitor.cjs              # one pass, print and record
 *   node tasks/band_monitor.cjs --quiet      # same, print only on a hit (for schedulers)
 *   node tasks/band_monitor.cjs --no-alert   # record but never invoke the notifier
 *
 * EXIT CODES
 *   0  ran cleanly (whether or not anything was in the band)
 *   1  could not read the server at all — a real failure worth a RED
 *   2  read the server but the ceiling is missing or below the previous one, so the
 *      band is empty and this monitor cannot mean anything until that is looked at
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const HOST = process.env.SMARTENTRY_HOST || "http://localhost:3001";
const PROJECT_ROOT = path.join(__dirname, "..");
const LOG_PATH = path.join(__dirname, "logs", "band_monitor.txt");
const FETCH_TIMEOUT_MS = 8000;

/**
 * The ceiling values in force BEFORE 2026-08-26. These are history, not configuration:
 * they define the lower edge of the band being watched. If the live ceiling is ever
 * moved back to or below these, the band closes and this monitor says so rather than
 * silently watching an empty range.
 */
const PREVIOUS_CEILING = { MOMENTUM: 72, TREND_FOLLOW: 68 };

/** Only these two setups are bounded by an RSI ceiling; the rest have no band. */
const CEILED_SETUPS = Object.keys(PREVIOUS_CEILING);

const ASSET_KEYS = ["btc", "gold", "spx"];

const args = new Set(process.argv.slice(2));
const QUIET = args.has("--quiet");
const NO_ALERT = args.has("--no-alert");

function say(message) {
  if (!QUIET) console.log(message);
}

/**
 * GET one JSON route. Never throws: the caller gets {ok:false, error} instead, because
 * a monitor that dies on a transient socket error is a monitor that reports nothing on
 * exactly the morning something happened.
 */
async function getJson(pathname) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(HOST + pathname, { signal: controller.signal });
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}`, status: response.status };
    }
    return { ok: true, body: await response.json() };
  } catch (e) {
    return { ok: false, error: e.name === "AbortError" ? `timeout after ${FETCH_TIMEOUT_MS}ms` : e.message };
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
    console.error(`[band_monitor] could not append to ${LOG_PATH}: ${e.message}`);
    return false;
  }
}

/**
 * Dedupe from the log itself rather than a state file. One alert per
 * symbol+setup+direction+day: a signal persists across hourly refreshes and re-alerting
 * on every one of them trains you to ignore the alert.
 */
function alreadyRecordedToday(dedupeKey) {
  try {
    if (!fs.existsSync(LOG_PATH)) return false;
    return fs.readFileSync(LOG_PATH, "utf8").includes(`key=${dedupeKey}`);
  } catch (e) {
    // An unreadable log must not suppress an alert — fail toward telling you.
    console.error(`[band_monitor] could not read log for dedupe (${e.message}) — treating as new`);
    return false;
  }
}

/**
 * Resolve the Python interpreter through the shared resolver, never the bare name.
 *
 * `execFile("python", ...)` does NOT go through a shell, so it cannot use PATHEXT and
 * cannot find `python.exe` from the bare word on Windows. Measured: the whole alert
 * path was dead with `spawn python ENOENT` - detection worked, the record was written,
 * and the notification silently never happened. A monitor whose alert cannot fire is
 * decoration shaped like a safety net, and this one would have stayed that way until
 * the first real band firing, which is exactly the moment it must not.
 *
 * server/python_path.js probes real candidates and is what the healer already reports;
 * here it resolves to the Python312 interpreter. Loaded lazily and defensively so a
 * missing module degrades to the old behaviour instead of taking the monitor down.
 */
function pythonExe() {
  try {
    return require(path.join(PROJECT_ROOT, "server", "python_path.js")).pythonBinOrDefault();
  } catch (e) {
    console.error(`[band_monitor] python_path.js unavailable (${e.message}) — falling back to "python"`);
    return "python";
  }
}

/** Best-effort notifier. A failure here is reported and never changes the exit code. */
function sendAlert(message) {
  if (NO_ALERT) return;
  execFile(pythonExe(), [path.join(PROJECT_ROOT, "notifications.py"), "alert", message],
    { cwd: PROJECT_ROOT, timeout: 20000 },
    (error, stdout, stderr) => {
      if (error) {
        console.error(`[band_monitor] notifier failed (${error.message}) — the record in ` +
          `${path.basename(LOG_PATH)} is still authoritative`);
        if (stderr && stderr.trim()) console.error(`[band_monitor] notifier stderr: ${stderr.trim()}`);
      }
    });
}

/** Every RSI leg the signal payload carries, named so a hit says WHICH timeframe. */
function rsiLegs(signal) {
  const legs = [];
  const daily = signal && signal.indicators ? signal.indicators.rsi : null;
  if (Number.isFinite(daily)) legs.push({ timeframe: "D1", rsi: daily });
  if (signal && signal.h4 && Number.isFinite(signal.h4.rsi)) legs.push({ timeframe: "H4", rsi: signal.h4.rsi });
  if (signal && signal.h1 && Number.isFinite(signal.h1.rsi)) legs.push({ timeframe: "H1", rsi: signal.h1.rsi });
  return legs;
}

async function main() {
  const stamp = new Date().toISOString();

  const [signalsResponse, settingsResponse] = await Promise.all([
    getJson("/api/signals"),
    getJson("/api/strategy-settings"),
  ]);

  if (!signalsResponse.ok || !settingsResponse.ok) {
    const detail = [
      signalsResponse.ok ? null : `/api/signals: ${signalsResponse.error}`,
      settingsResponse.ok ? null : `/api/strategy-settings: ${settingsResponse.error}`,
    ].filter(Boolean).join("; ");
    console.error(`[band_monitor] ${stamp} SERVER UNREADABLE — ${detail}`);
    appendLog(`${stamp} ERROR server-unreadable ${detail}`);
    return 1;
  }

  const settings = settingsResponse.body;

  // settingsError non-null means the server is running on built-in defaults, not the
  // saved config. Say it before anything else — the band would be measured against a
  // ceiling nobody chose.
  if (settings.settingsError) {
    console.error(`[band_monitor] ${stamp} settingsError is set (${settings.settingsError}) — ` +
      `the server is on BUILT-IN DEFAULTS, not the saved config. Band is not trustworthy.`);
    appendLog(`${stamp} ERROR settings-error ${settings.settingsError}`);
    return 2;
  }

  const liveCeiling = {
    MOMENTUM: settings.momentumRsiMax,
    TREND_FOLLOW: settings.trendFollowRsiMax,
  };
  const gate = settings.confidenceThreshold;

  const closedBands = CEILED_SETUPS.filter(
    (setup) => !Number.isFinite(liveCeiling[setup]) || liveCeiling[setup] <= PREVIOUS_CEILING[setup]);
  if (closedBands.length === CEILED_SETUPS.length) {
    console.error(`[band_monitor] ${stamp} BAND EMPTY — live ceiling ` +
      `(${CEILED_SETUPS.map((s) => `${s} ${liveCeiling[s]}`).join(", ")}) is not above the ` +
      `previous (${CEILED_SETUPS.map((s) => `${s} ${PREVIOUS_CEILING[s]}`).join(", ")}). ` +
      `Nothing can land in the band, so this monitor cannot mean anything.`);
    appendLog(`${stamp} ERROR band-empty live=${JSON.stringify(liveCeiling)}`);
    return 2;
  }
  for (const setup of closedBands) {
    say(`  NOTE: ${setup} band is closed (live ${liveCeiling[setup]} <= previous ${PREVIOUS_CEILING[setup]})`);
  }

  say("=".repeat(84));
  say(`  BAND MONITOR — ${stamp}`);
  say(`  gate ${gate}  |  watching MOMENTUM [${PREVIOUS_CEILING.MOMENTUM}, ${liveCeiling.MOMENTUM}) ` +
      `and TREND_FOLLOW [${PREVIOUS_CEILING.TREND_FOLLOW}, ${liveCeiling.TREND_FOLLOW})`);
  say("=".repeat(84));

  const hits = [];

  for (const assetKey of ASSET_KEYS) {
    const signal = signalsResponse.body[assetKey];
    if (!signal) {
      say(`  ${assetKey.toUpperCase().padEnd(5)} absent from /api/signals`);
      continue;
    }

    const direction = signal.signal;
    const setup = signal.setup;
    const confidence = signal.confidence;
    const fired = (direction === "BUY" || direction === "SELL") && Number.isFinite(confidence) && confidence >= gate;

    if (!CEILED_SETUPS.includes(setup)) {
      say(`  ${assetKey.toUpperCase().padEnd(5)} ${String(setup).padEnd(18)} — no RSI ceiling applies`);
      continue;
    }

    const bandLow = PREVIOUS_CEILING[setup];
    const bandHigh = liveCeiling[setup];
    const inBand = rsiLegs(signal).filter((leg) => leg.rsi >= bandLow && leg.rsi < bandHigh);

    if (!fired) {
      const near = inBand.length ? `  (RSI in band on ${inBand.map((l) => `${l.timeframe} ${l.rsi}`).join(", ")}, but not firing)` : "";
      say(`  ${assetKey.toUpperCase().padEnd(5)} ${String(setup).padEnd(18)} ${direction} conf ${confidence} — not firing${near}`);
      continue;
    }

    if (!inBand.length) {
      say(`  ${assetKey.toUpperCase().padEnd(5)} ${String(setup).padEnd(18)} ${direction} conf ${confidence} — FIRING, but no leg in the band`);
      continue;
    }

    const legText = inBand.map((l) => `${l.timeframe} RSI ${l.rsi}`).join(", ");
    const dedupeKey = `${signal.ticker || assetKey}|${setup}|${direction}|${stamp.slice(0, 10)}`;

    if (alreadyRecordedToday(dedupeKey)) {
      say(`  ${assetKey.toUpperCase().padEnd(5)} ${String(setup).padEnd(18)} ${direction} — in band (${legText}), already recorded today`);
      continue;
    }

    const record = `${stamp} NEW-BAND-FIRING key=${dedupeKey} symbol=${assetKey.toUpperCase()} ` +
      `setup=${setup} direction=${direction} confidence=${confidence} gate=${gate} ` +
      `band=[${bandLow},${bandHigh}) legs="${legText}" entry=${signal.entry} stop=${signal.stop} ` +
      `target=${signal.target} rr=${signal.rr} source=${signal.dataSource}`;
    appendLog(record);
    hits.push({ assetKey, setup, direction, confidence, legText, bandLow, bandHigh });

    say("");
    say(`  *** NEW-BAND FIRING — ${assetKey.toUpperCase()} ${direction} ${setup} at ${confidence}% ***`);
    say(`      ${legText} — inside [${bandLow}, ${bandHigh}), the range the old ceiling vetoed.`);
    say(`      This setup would NOT have fired before 2026-08-26. It is live evidence on the change.`);
    say("");

    sendAlert(`NEW-BAND FIRING: ${assetKey.toUpperCase()} ${direction} ${setup} ${confidence}% — ` +
      `${legText}, inside [${bandLow},${bandHigh}). The old 72/68 ceiling would have vetoed this one.`);
  }

  if (!hits.length) say("  Nothing in the band this pass.");
  say("=".repeat(84));
  return 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((e) => {
    // Nothing above is expected to throw; if it does, say so loudly rather than exiting 0
    // and looking like a clean pass that found nothing.
    console.error(`[band_monitor] UNHANDLED: ${e && e.stack ? e.stack : e}`);
    appendLog(`${new Date().toISOString()} ERROR unhandled ${e && e.message ? e.message : e}`);
    process.exitCode = 1;
  });
