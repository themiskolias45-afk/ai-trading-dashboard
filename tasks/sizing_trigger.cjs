'use strict';
/**
 * Is the sizing trigger met yet?
 *
 * THE TRIGGER, verbatim from the `liveconfig` claim in server/evidence_register.js:
 *
 *   "flip to 0 when XAUUSD alone has >=30 closed fills with positive expectancy
 *    after costs. Gold, not pooled — the edge is Gold, and pooling lets BTC's
 *    3-of-5 record and SPX's negative one vote on a Gold decision."
 *
 * WHY THIS EXISTS. Correct risk-based sizing ALREADY EXISTS in get_lot_size
 * (mt5_bridge.py) and is discarded by `fixedLotSize: 0.01`. It is the largest
 * single lever on returns in the system and it needs NO new edge — which is
 * exactly why it was given a stated trigger instead of a judgement call on the
 * day. A trigger nobody watches is a decision that gets made by whoever
 * remembers it first, so this watches it.
 *
 * IT DECIDES NOTHING AND WRITES NOTHING. No config is read for writing, no
 * setting is changed, no trade is affected. It reports a number and the honest
 * uncertainty around it. The flip stays a human decision, deliberately.
 *
 * ── Three things it refuses to do the easy way ───────────────────────────────
 *
 * 1. R IS DERIVED FROM PRICES, using the SERVER'S OWN FUNCTION. The journal's
 *    `rr` field is the signal's PLAN, not what happened — a 0% win-rate trade
 *    once reported avgRR +2.5 because of it. Rather than copy the formula (there
 *    are already two copies, in index.js and score_rr_rejections.py, and a third
 *    would drift), realizedRFromPrices is EXTRACTED from server/index.js source
 *    at run time and evaluated. If the server's definition changes, this changes
 *    with it or it fails loudly.
 *
 * 2. "POSITIVE EXPECTANCY" IS REPORTED WITH ITS CONFIDENCE INTERVAL. Thirty
 *    trades with a mean of +0.05R is not a positive edge, it is a coin landing
 *    slightly heads. The trigger as written says "positive", and this does NOT
 *    silently raise that bar — it reports the one-sided 95% lower bound beside
 *    the point estimate so the decision is made knowing which one it is.
 *
 * 3. IT NEVER POOLS THE TWO BOXES. journal.json is per-machine and the boxes
 *    trade different accounts, so this reports THIS BOX and says so by name. A
 *    pooled Gold count would also be unsafe on its own terms: pooling assumes
 *    both boxes run the same engine, which only vps_parity.cjs can establish.
 *
 * Usage:
 *   node tasks/sizing_trigger.cjs [--json]
 */

const fs   = require("fs");
const os   = require("os");
const path = require("path");
const vm   = require("vm");

const ROOT = path.join(__dirname, "..");

// The trigger's own threshold. Named, not inline, because it is quoted in the
// evidence register and in the handover note — three places that must agree.
const TRIGGER_MIN_FILLS = 30;

// Costs charged as a flat R. 0.05R is the house standard across every MTF
// harness in this project, and it is CONSERVATIVE for Gold specifically: a
// $0.20-0.50 XAUUSD spread against the $76-134 stop distances actually in the
// journal is 0.002-0.007R. The sweep is printed so nothing rests on one figure.
const COST_LEVELS_R  = [0, 0.02, 0.05];
const HEADLINE_COST_R = 0.05;

// What the journal calls Gold. The engine's ticker is GC=F but fills are booked
// under the broker symbol; both are accepted so a renamed feed cannot silently
// zero the count — which would read as "no progress" rather than as a fault.
const GOLD_SYMBOLS = ["XAUUSD", "GOLD", "GC=F"];

// One-sided 95% t critical values by degrees of freedom. A normal approximation
// (1.645) is wrong in the direction that matters here — it makes a small sample
// look MORE certain than it is, which is precisely the error this section exists
// to prevent. Interpolated between table rows; df above 120 uses the normal limit.
const T_95_ONE_SIDED = [
  [5, 2.015], [10, 1.812], [15, 1.753], [20, 1.725], [25, 1.708],
  [29, 1.699], [40, 1.684], [60, 1.671], [120, 1.658],
];

function tCritical95OneSided(degreesOfFreedom) {
  if (degreesOfFreedom <= 0) return null;
  if (degreesOfFreedom >= 120) return 1.645;
  if (degreesOfFreedom <= T_95_ONE_SIDED[0][0]) return T_95_ONE_SIDED[0][1];
  for (let i = 1; i < T_95_ONE_SIDED.length; i++) {
    const [dfHigh, tHigh] = T_95_ONE_SIDED[i];
    const [dfLow,  tLow]  = T_95_ONE_SIDED[i - 1];
    if (degreesOfFreedom <= dfHigh) {
      const span = dfHigh - dfLow;
      const position = (degreesOfFreedom - dfLow) / span;
      return tLow + position * (tHigh - tLow);
    }
  }
  return 1.645;
}

/**
 * The server's own realizedRFromPrices, lifted out of server/index.js.
 *
 * Extracted rather than copied for the same reason _replay_mtf.cjs extracts its
 * constants: a literal duplicated here would silently drift the day someone
 * retunes the server, and the drift would be invisible — both sides would keep
 * producing plausible numbers that disagree. MAX_PLAUSIBLE_RR comes along with
 * it because the function reads it, and it is the guard that stopped ONE row
 * with a degenerate stop from inverting the sign of a 498-episode ledger.
 */
function loadServerScorer(root = ROOT) {
  const indexPath = path.join(root, "server", "index.js");
  const source = fs.readFileSync(indexPath, "utf8");

  const constMatch = source.match(/^const\s+MAX_PLAUSIBLE_RR\s*=\s*([^;]+);/m);
  if (!constMatch) {
    throw new Error("could not extract MAX_PLAUSIBLE_RR from server/index.js — refusing to "
      + "score, because a missing cap is exactly how a degenerate stop inverts a ledger");
  }

  const start = source.indexOf("function realizedRFromPrices(");
  if (start === -1) throw new Error("could not find realizedRFromPrices in server/index.js");
  let depth = 0, end = -1;
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) { end = i + 1; break; }
  }
  if (end === -1) throw new Error("realizedRFromPrices in server/index.js is unbalanced");

  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(
    `const MAX_PLAUSIBLE_RR = ${constMatch[1].trim()};\n${source.slice(start, end)}`,
    sandbox
  );
  if (typeof sandbox.realizedRFromPrices !== "function") {
    throw new Error("extracted realizedRFromPrices is not callable");
  }
  return sandbox.realizedRFromPrices;
}

function loadJournal(root = ROOT) {
  const journalPath = path.join(root, "server", "journal.json");
  const raw = fs.readFileSync(journalPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("journal.json is not an array");
  return parsed;
}

function isGold(symbol) {
  const upper = String(symbol || "").toUpperCase();
  return GOLD_SYMBOLS.some(name => upper.startsWith(name));
}

function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

// Sample standard deviation (n-1). Population sd would understate the spread on
// exactly the small samples this tool is built to be careful about.
function sampleStdDev(values) {
  if (values.length < 2) return null;
  const average = mean(values);
  const variance = values.reduce((sum, v) => sum + (v - average) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * Gold's closed record on THIS box, scored in R.
 *
 * Unscorable fills are counted and reported, never dropped: a trade whose stop
 * was never recorded still happened, and silently excluding it would make the
 * count disagree with the journal for no stated reason.
 */
function readGoldRecord(root = ROOT, scorer = null) {
  const realizedRFromPrices = scorer || loadServerScorer(root);
  const journal = loadJournal(root);

  const goldClosed = journal.filter(t => isGold(t.symbol) && String(t.status).toUpperCase() === "CLOSED");
  const scored = [], unscorable = [];

  for (const trade of goldClosed) {
    const realizedR = realizedRFromPrices(trade.direction, trade.entry, trade.sl, trade.closePrice);
    if (realizedR === null) unscorable.push(trade);
    else scored.push({ ...trade, realizedR });
  }

  const rValues = scored.map(t => t.realizedR);
  const stdDev = sampleStdDev(rValues);
  const grossMean = mean(rValues);

  // The interval is on the COST-ADJUSTED mean, because that is what the trigger
  // asks about ("positive expectancy AFTER costs"). Cost is a constant shift, so
  // it moves the bound by exactly the cost and leaves the spread alone.
  const netMean = grossMean === null ? null : grossMean - HEADLINE_COST_R;
  let lowerBound95 = null;
  if (netMean !== null && stdDev !== null && rValues.length >= 2) {
    const tCritical = tCritical95OneSided(rValues.length - 1);
    lowerBound95 = netMean - tCritical * (stdDev / Math.sqrt(rValues.length));
  }

  const byCost = COST_LEVELS_R.map(cost => ({
    cost,
    expectancy: grossMean === null ? null : grossMean - cost,
  }));

  const bySetup = {};
  for (const trade of scored) {
    const setup = trade.setup || "UNATTRIBUTED";
    const bucket = bySetup[setup] || (bySetup[setup] = { trades: 0, totalR: 0, wins: 0 });
    bucket.trades++;
    bucket.totalR += trade.realizedR;
    if (trade.realizedR > 0) bucket.wins++;
  }

  // Observed fill rate, from this box's own record rather than a remembered
  // annual figure. Needs two fills to define a span at all.
  const openTimes = goldClosed
    .map(t => Date.parse(t.openTime))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const spanDays = openTimes.length >= 2
    ? (openTimes[openTimes.length - 1] - openTimes[0]) / 86400000
    : null;
  const fillsPerDay = spanDays && spanDays > 0 ? (openTimes.length - 1) / spanDays : null;

  const remaining = Math.max(0, TRIGGER_MIN_FILLS - scored.length);
  const daysToTrigger = fillsPerDay && fillsPerDay > 0 ? remaining / fillsPerDay : null;

  const countMet = scored.length >= TRIGGER_MIN_FILLS;
  const expectancyPositive = netMean !== null && netMean > 0;

  return {
    box: os.hostname(),
    closedGoldFills: goldClosed.length,
    scored: scored.length,
    unscorable: unscorable.length,
    wins: rValues.filter(r => r > 0).length,
    grossMean, netMean, stdDev, lowerBound95, byCost, bySetup,
    fillsPerDay, daysToTrigger, remaining,
    countMet, expectancyPositive,
    triggerMet: countMet && expectancyPositive,
    // A trigger met on a point estimate whose interval still spans zero is the
    // case worth naming: the stated condition IS satisfied, and the evidence
    // behind it is thin. Saying so is not moving the goalposts, it is refusing
    // to let "positive" and "proven" read as the same word.
    evidenceThin: countMet && expectancyPositive && lowerBound95 !== null && lowerBound95 <= 0,
  };
}

function fmtR(value) {
  if (value === null || value === undefined) return "—";
  return (value >= 0 ? "+" : "") + value.toFixed(3) + "R";
}

function formatReport(record) {
  const lines = [];
  lines.push("SIZING TRIGGER — is it time to flip fixedLotSize 0.01 -> 0?");
  lines.push(`box: ${record.box} · trigger: XAUUSD alone, >=${TRIGGER_MIN_FILLS} closed fills `
    + `with positive expectancy after costs`);
  lines.push("This box only. journal.json is per-machine and the boxes trade different");
  lines.push("accounts — run it on both and read them separately, never added together.");
  lines.push("");

  lines.push(`  Gold closed fills   ${record.scored} scored`
    + (record.unscorable ? ` (+${record.unscorable} unscorable — no usable entry/stop/close)` : "")
    + `   [need ${TRIGGER_MIN_FILLS}]`);
  lines.push(`  Wins                ${record.wins}/${record.scored}`
    + (record.scored ? ` (${Math.round(100 * record.wins / record.scored)}%)` : ""));
  lines.push("");

  lines.push("  Expectancy per trade, in R, by assumed round-trip cost:");
  for (const level of record.byCost) {
    const marker = level.cost === HEADLINE_COST_R ? "  <- headline" : "";
    lines.push(`    cost ${level.cost.toFixed(2)}R   ${fmtR(level.expectancy)}${marker}`);
  }
  lines.push("");

  lines.push(`  Net expectancy      ${fmtR(record.netMean)} at ${HEADLINE_COST_R}R cost`);
  lines.push(`  Std dev             ${record.stdDev === null ? "—" : record.stdDev.toFixed(3) + "R"}`);
  lines.push(`  95% lower bound     ${fmtR(record.lowerBound95)}   `
    + `(one-sided; the mean is above this with 95% confidence)`);
  lines.push("");

  const setupNames = Object.keys(record.bySetup);
  if (setupNames.length > 0) {
    lines.push("  By setup — so a trigger carried by ONE setup is visible as that:");
    for (const name of setupNames.sort((a, b) => record.bySetup[b].trades - record.bySetup[a].trades)) {
      const bucket = record.bySetup[name];
      lines.push(`    ${name.padEnd(22)} ${String(bucket.trades).padStart(3)} trades  `
        + `${String(bucket.wins).padStart(3)}W  ${fmtR(bucket.totalR / bucket.trades)}/trade`);
    }
    lines.push("");
  }

  if (record.remaining > 0) {
    const eta = record.daysToTrigger === null
      ? "no rate yet — needs two fills to measure one"
      : `~${Math.round(record.daysToTrigger)} days at the observed rate of `
        + `${(record.fillsPerDay * 365).toFixed(0)}/year`;
    lines.push(`  ${record.remaining} more Gold fills needed. ETA: ${eta}.`);
  }

  lines.push("");
  lines.push("  VERDICT");
  if (!record.countMet) {
    lines.push(`    NOT YET — ${record.scored} of ${TRIGGER_MIN_FILLS} fills. Expectancy is not `
      + `even asked until the count is met;`);
    lines.push("    a positive mean on a handful of trades is what noise looks like.");
  } else if (!record.expectancyPositive) {
    lines.push(`    COUNT MET, EXPECTANCY NEGATIVE (${fmtR(record.netMean)}). Do not flip. The `
      + "trigger is both conditions,");
    lines.push("    and this is the condition that protects real money.");
  } else if (record.evidenceThin) {
    lines.push(`    TRIGGER MET, EVIDENCE THIN. ${record.scored} fills, ${fmtR(record.netMean)} net, `
      + `but the 95% lower bound is ${fmtR(record.lowerBound95)}`);
    lines.push("    — the interval still spans zero. The stated condition IS satisfied; this is a");
    lines.push("    decision to make knowingly, not a green light. Re-read the 2026-07-28 note.");
  } else {
    lines.push(`    TRIGGER MET. ${record.scored} fills, ${fmtR(record.netMean)} net after costs, `
      + `95% lower bound ${fmtR(record.lowerBound95)}.`);
    lines.push("    The flip is `fixedLotSize` 0.01 -> 0 in strategy_settings.json — ON BOTH BOXES,");
    lines.push("    that file is per-machine and untracked. Never write it with PowerShell");
    lines.push("    Set-Content -Encoding utf8: the BOM silently reset the VPS to defaults once.");
  }
  lines.push("");
  lines.push("  This tool changes nothing. The flip is a human decision, deliberately.");
  return lines.join("\n");
}

module.exports = { readGoldRecord, formatReport, loadServerScorer, TRIGGER_MIN_FILLS, HEADLINE_COST_R };

if (require.main === module) {
  try {
    const record = readGoldRecord();
    if (process.argv.includes("--json")) console.log(JSON.stringify(record, null, 2));
    else console.log(formatReport(record));
    process.exit(0);
  } catch (err) {
    // Exit 1 on a failure to MEASURE. "Not yet triggered" is a successful run —
    // conflating the two would make a broken reader look like a quiet trigger,
    // which is the failure mode this whole tool exists to avoid elsewhere.
    console.error(`[sizing-trigger] could not measure: ${err.message}`);
    process.exit(1);
  }
}
