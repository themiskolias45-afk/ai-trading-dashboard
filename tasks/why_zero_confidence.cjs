#!/usr/bin/env node
"use strict";

/**
 * tasks/why_zero_confidence.cjs — name the thing holding confidence at zero.
 *
 * WHY THIS EXISTS
 * The user's standing question, asked across several sessions: "that is not possible,
 * 2 days now all the assets 0 confidence". Twice the answer was explained from the
 * code and twice that explanation was incomplete, because nothing on this machine
 * READ the census that already had the answer. /api/near-miss has recorded, all
 * along, exactly which condition killed each setup and by how much. It just had no
 * reader on the path a human actually looks at.
 *
 * This is that reader. It answers one question and stops.
 *
 * WHAT IT IS NOT
 * It is not a fix and it changes nothing. It writes no setting, touches no learning
 * data, and never suppresses or admits a signal. A diagnosis that can alter the thing
 * it diagnoses is not a diagnosis. It always exits 0 so it can never fail a caller.
 *
 * EXITING. It sets process.exitCode and RETURNS; it must never call process.exit().
 * Node's global fetch keeps undici sockets alive briefly after the last response, and
 * process.exit() while those handles are mid-close aborts the process with
 * "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" and exit code 127 - AFTER
 * printing a complete, correct report. A caller reading the exit code would see this
 * diagnostic fail while its own output said everything was fine.
 *
 * USAGE
 *   node tasks/why_zero_confidence.cjs [--host http://localhost:3001] [--json]
 */

const DEFAULT_HOST = "http://localhost:3001";
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : fallback;
};
const HOST = String(opt("--host", DEFAULT_HOST)).replace(/\/+$/, "");
const AS_JSON = argv.includes("--json");
const TIMEOUT_MS = 10000;

// A 401 is valid JSON and parses cleanly, so `it parsed` is not `it worked`. Every
// call here reports the status separately from the body - this project has already
// had a 401 read as healthy, and a session-gated route counted as two open positions.
async function getJson(pathname) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const response = await fetch(HOST + pathname, { signal: controller.signal });
    clearTimeout(timer);
    const text = await response.text();
    if (!response.ok) return { ok: false, status: response.status, error: text.slice(0, 200) };
    try {
      return { ok: true, status: response.status, body: JSON.parse(text) };
    } catch (parseError) {
      return { ok: false, status: response.status, error: "unparseable: " + parseError.message };
    }
  } catch (networkError) {
    return { ok: false, status: 0, error: networkError.message };
  }
}

function summariseNearMisses(rows) {
  const byCondition = new Map();
  for (const row of rows) {
    const key = row.condition || "UNKNOWN";
    const seen = byCondition.get(key) || { condition: key, rows: 0, closest: Infinity, closestRow: null };
    seen.rows += 1;
    const margin = Number(row.minMargin);
    if (Number.isFinite(margin) && margin < seen.closest) {
      seen.closest = margin;
      seen.closestRow = row;
    }
    byCondition.set(key, seen);
  }
  return [...byCondition.values()].sort((a, b) => b.rows - a.rows);
}

(async () => {
  const [signals, nearMiss, settings] = await Promise.all([
    getJson("/api/signals"),
    getJson("/api/near-miss"),
    getJson("/api/strategy-settings"),
  ]);

  const report = { host: HOST, generatedAt: new Date().toISOString(), assets: [], blockers: [], notes: [] };

  if (!signals.ok) {
    report.notes.push(`/api/signals unavailable (status ${signals.status}): ${signals.error}`);
  } else {
    for (const key of ["btc", "gold", "spx"]) {
      const asset = signals.body[key];
      if (!asset) continue;
      report.assets.push({
        asset: key.toUpperCase(),
        setup: asset.setup,
        confidence: asset.confidence,
        strength: asset.strength,
        // The engine states the blocker in plain language here, and it is the only
        // place a WATCH setup explains itself at all.
        reasons: Array.isArray(asset.reasons) ? asset.reasons : [],
      });
    }
  }

  const gate = settings.ok ? settings.body.confidenceThreshold : null;
  const ceilings = settings.ok
    ? { momentumRsiMax: settings.body.momentumRsiMax, trendFollowRsiMax: settings.body.trendFollowRsiMax }
    : null;
  report.gate = gate;
  report.ceilings = ceilings;
  if (settings.ok && settings.body.settingsError) {
    report.notes.push("SETTINGS ERROR — the server is on built-in defaults, not the saved config: "
      + settings.body.settingsError);
  }

  // censusRead distinguishes "the census says nothing got close" from "the census was
  // never reached". Both produce zero rows and they mean opposite things: the first is
  // a quiet market, the second is no information at all. Collapsing them let this tool
  // print "QUIET MARKET" while the server was unreachable.
  report.censusRead = false;
  if (!nearMiss.ok) {
    report.notes.push(`/api/near-miss unavailable (status ${nearMiss.status}): ${nearMiss.error}`);
  } else if (!nearMiss.body.available) {
    report.notes.push("near-miss census not available on this server build");
  } else {
    report.censusRead = true;
    const rows = Array.isArray(nearMiss.body.rows) ? nearMiss.body.rows : [];
    report.censusSince = nearMiss.body.startedAt;
    report.totalNearMisses = nearMiss.body.totalNearMisses;
    report.blockers = summariseNearMisses(rows).map((entry) => ({
      condition: entry.condition,
      rows: entry.rows,
      closestMargin: Number.isFinite(entry.closest) ? entry.closest : null,
      closestExample: entry.closestRow
        ? `${entry.closestRow.symbol} ${entry.closestRow.timeframe} ${entry.closestRow.setup} `
          + `threshold ${entry.closestRow.threshold}, actual ${entry.closestRow.lastActual}`
        : null,
    }));
  }

  if (AS_JSON) {
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 0;
    return;
  }

  const line = "=".repeat(84);
  console.log(line);
  console.log("  WHY IS CONFIDENCE ZERO — " + report.generatedAt);
  console.log("  gate " + (gate === null ? "unknown" : gate)
    + (ceilings ? `, RSI ceilings ${ceilings.momentumRsiMax}/${ceilings.trendFollowRsiMax}` : "")
    + "   host " + HOST);
  console.log(line);
  for (const asset of report.assets) {
    console.log(`  ${asset.asset.padEnd(5)} ${String(asset.setup).padEnd(20)} conf ${String(asset.confidence).padStart(3)}`);
    for (const reason of asset.reasons.slice(0, 4)) console.log("        - " + reason);
  }
  console.log("");
  if (report.blockers.length) {
    console.log("  NEAR-MISS CENSUS — what actually killed the setups"
      + (report.censusSince ? " (since " + report.censusSince + ")" : ""));
    for (const blocker of report.blockers) {
      console.log(`    ${blocker.condition.padEnd(20)} ${String(blocker.rows).padStart(3)} row(s)`
        + (blocker.closestMargin === null ? "" : `   closest margin ${blocker.closestMargin}`));
      if (blocker.closestExample) console.log("        " + blocker.closestExample);
    }
    const top = report.blockers[0];
    console.log("");
    console.log(`  VERDICT: ${top.condition} accounts for ${top.rows} of ${report.blockers.reduce((n, b) => n + b.rows, 0)} near-misses`
      + (top.closestMargin === null ? "." : `, the closest by ${top.closestMargin} point(s).`));
    if (top.condition === "RSI_ABOVE_CEILING") {
      console.log("  That is the RSI CEILING, not a fault. It is a configured bound doing its job");
      console.log("  while all three instruments trend. tasks/offline.bat ceiling measured 72/68 as");
      console.log("  positive in only 2 of 5 folds and 80/76 in 5 of 5, on both boxes and three cuts.");
      console.log("  Moving it is a DECISION, not a repair. Nothing here changes it.");
    }
  } else if (report.censusRead) {
    console.log("  No near-miss rows recorded since the last server start — nothing got close");
    console.log("  enough to a setup to be counted. That is a QUIET MARKET, not a blocked one.");
  } else {
    console.log("  NO DIAGNOSIS. The near-miss census could not be read, so nothing here knows");
    console.log("  why confidence is what it is. This is not 'nothing was blocking' — it is no");
    console.log("  information at all. Check the server is up, then re-run.");
  }
  for (const note of report.notes) console.log("  NOTE: " + note);
  console.log(line);
  process.exitCode = 0;
})().catch((unexpected) => {
  // Still exit 0. This tool exists to explain a quiet system; it must never be the
  // reason a morning routine reports a failure.
  console.log("  NOTE: diagnosis failed unexpectedly: " + unexpected.message);
  process.exitCode = 0;
});
