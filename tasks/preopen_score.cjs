#!/usr/bin/env node
// SCORES THE PRE-OPEN PLAN AGAINST WHAT ACTUALLY HAPPENED.
//
// The plan makes a falsifiable prediction every time it runs. For each asset it records a
// confidence, a gap to the gate, and `ready` - "this would fire". 52 plans had been written
// before this existed and not one of them had ever been checked.
//
// A forecast nobody scores teaches nothing. It cannot be wrong, so it cannot improve, and a
// reader has no way to know whether "30pt short" means "nearly traded" or "never trades".
// This turns the plan from a statement into a record with a track record attached.
//
// WHAT IS COMPARED
//   prediction : per asset, at plan time - ready (conf >= gate) and the gap in points
//   outcome    : did that asset open a trade in the journal within the scoring window
//                that follows the plan
//
// The window runs from the plan's own generatedAt to the end of the NEW YORK session it was
// built for, because that is the period the plan claims to describe. A trade outside it is
// not the plan's to claim or to answer for.
//
// WHAT THIS IS NOT
//   It scores the PLAN's calls, not the engine's edge. "ready but no trade" can be correct
//   behaviour - a gate downstream may have refused for a good reason - so a miss is a
//   prompt to look, never a verdict that anything is broken. It changes no threshold, feeds
//   no gate, and opens nothing.
//
//   node tasks/preopen_score.cjs            print the scorecard
//   node tasks/preopen_score.cjs --json     machine-readable, for the API
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.dirname(__dirname);
const PLAN_DIR = path.join(ROOT, "tasks", "analysis");
const JOURNAL = path.join(ROOT, "server", "journal.json");
const OUT = path.join(ROOT, "tasks", "analysis", "preopen-score-latest.json");

// The plan's asset keys against the broker symbols the journal records.
const SYMBOL_OF = { btc: ["BTCUSD"], gold: ["XAUUSD"], spx: ["SP500", "^GSPC"] };
const NY_SESSION_HOURS = 4;      // NEW YORK runs 13-17 UTC

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return fallback; }
}

function loadPlans() {
  let names;
  try { names = fs.readdirSync(PLAN_DIR); } catch (e) { return []; }
  return names
    .filter(n => /^preopen-plan-\d{8}T\d{6}\.json$/.test(n))
    .sort()
    .map(n => ({ file: n, doc: readJson(path.join(PLAN_DIR, n), null) }))
    .filter(p => p.doc && Array.isArray(p.doc.assets) && p.doc.generatedAt);
}

function loadTrades() {
  const j = readJson(JOURNAL, []);
  const rows = Array.isArray(j) ? j : (j.trades || j.entries || []);
  return rows
    .map(t => ({ symbol: String(t.symbol || "").toUpperCase(), at: Date.parse(t.openTime) }))
    .filter(t => t.symbol && Number.isFinite(t.at));
}

// Bands rather than raw points: with this sample size a per-point curve would be noise
// wearing a shape. Wide enough to hold rows, narrow enough to mean something.
function bandOf(gap) {
  if (gap <= 0) return "0 (ready)";
  if (gap <= 5) return "1-5";
  if (gap <= 15) return "6-15";
  if (gap <= 30) return "16-30";
  return "31+";
}

function score() {
  const plans = loadPlans();
  const trades = loadTrades();
  const rows = [];

  for (const { file, doc } of plans) {
    const planAt = Date.parse(doc.generatedAt);
    if (!Number.isFinite(planAt)) continue;
    // The window the plan actually speaks for.
    const nyOpen = Date.parse(doc.nextNewYorkOpen);
    const windowEnd = Number.isFinite(nyOpen)
      ? nyOpen + NY_SESSION_HOURS * 3600 * 1000
      : planAt + 24 * 3600 * 1000;
    if (windowEnd > Date.now()) continue;      // not resolved yet - never scored early

    for (const a of doc.assets) {
      if (!a || a.unavailable || !SYMBOL_OF[a.key]) continue;
      const syms = SYMBOL_OF[a.key];
      const traded = trades.some(t => syms.includes(t.symbol) && t.at >= planAt && t.at <= windowEnd);
      // A "ready" call while the engine already holds that symbol in that direction was
      // never going to become a trade - sizing.js refuses it as a duplicate, correctly.
      // Counting those as misses made the plan look wrong for being right: on the laptop
      // it was most of the gap between "said WOULD FIRE 16" and "traded 2".
      //
      // undefined on plans written before the field existed, and those stay UNKNOWN rather
      // than being assumed clear - an assumption there would quietly restore the same bias.
      const dup = a.wouldBeDuplicate;
      rows.push({
        file, at: doc.generatedAt, asset: a.key,
        gate: doc.gate, confidence: a.confidence, gap: a.gap,
        predictedReady: !!a.ready, traded,
        wouldBeDuplicate: dup === undefined ? null : !!dup,
        correct: !!a.ready === traded,
      });
    }
  }

  const byBand = {};
  for (const r of rows) {
    const b = bandOf(r.gap);
    const e = byBand[b] || (byBand[b] = { band: b, n: 0, traded: 0 });
    e.n++; if (r.traded) e.traded++;
  }
  for (const e of Object.values(byBand)) e.tradedPct = e.n ? Math.round(e.traded / e.n * 1000) / 10 : 0;

  const ready = rows.filter(r => r.predictedReady);
  const notReady = rows.filter(r => !r.predictedReady);
  // The honest denominator: ready calls where nothing was already blocking the entry.
  const readyClear = ready.filter(r => r.wouldBeDuplicate === false);
  const readyDup   = ready.filter(r => r.wouldBeDuplicate === true);
  const readyUnknown = ready.filter(r => r.wouldBeDuplicate === null);

  return {
    generatedAt: new Date().toISOString(),
    plansFound: plans.length,
    plansScored: new Set(rows.map(r => r.file)).size,
    predictions: rows.length,
    journalTrades: trades.length,
    readySaid: ready.length,
    readyAndTraded: ready.filter(r => r.traded).length,
    readyClearSaid: readyClear.length,
    readyClearTraded: readyClear.filter(r => r.traded).length,
    readyBlockedByDuplicate: readyDup.length,
    readyDuplicateTraded: readyDup.filter(r => r.traded).length,
    readyUnknownDuplicate: readyUnknown.length,
    notReadySaid: notReady.length,
    notReadyButTraded: notReady.filter(r => r.traded).length,
    bands: Object.values(byBand).sort((a, b) => a.band.localeCompare(b.band)),
    rows: rows.slice(-40),
    // Stated in the payload so no surface can present a thin sample as a finding.
    caveat: "Scores the PLAN's calls, not the engine's edge. 'ready but no trade' can be " +
            "correct - a downstream gate may have refused for a good reason. Changes no " +
            "threshold, feeds no gate, opens nothing.",
  };
}

function main() {
  const s = score();
  try {
    fs.writeFileSync(OUT + ".tmp", JSON.stringify(s, null, 1));
    fs.renameSync(OUT + ".tmp", OUT);
  } catch (e) { console.error("could not write " + OUT + ": " + e.message); }

  if (process.argv.includes("--json")) { console.log(JSON.stringify(s)); return; }

  console.log("PRE-OPEN PLAN SCORECARD");
  console.log("  plans on disk       : " + s.plansFound);
  console.log("  plans resolved      : " + s.plansScored + "  (a plan is scored only after its window has closed)");
  console.log("  predictions scored  : " + s.predictions);
  console.log("  journal trades      : " + s.journalTrades);
  console.log("");
  console.log("  said WOULD FIRE     : " + s.readySaid + "   of which traded: " + s.readyAndTraded);
  console.log("     of those, entry was already blocked as a DUPLICATE : " + s.readyBlockedByDuplicate +
              "  (traded " + s.readyDuplicateTraded + ")");
  console.log("     nothing blocking, the honest denominator           : " + s.readyClearSaid +
              "  (traded " + s.readyClearTraded + ")");
  if (s.readyUnknownDuplicate) console.log("     written before the field existed, UNKNOWN          : " + s.readyUnknownDuplicate);
  console.log("  said NOT ready      : " + s.notReadySaid + "   of which traded anyway: " + s.notReadyButTraded);
  console.log("");
  console.log("  how often a trade followed, by distance to the gate:");
  if (!s.bands.length) console.log("    (nothing resolved yet)");
  for (const b of s.bands) {
    console.log("    " + String(b.band).padEnd(11) + " n=" + String(b.n).padEnd(5) +
                " traded " + b.traded + " (" + b.tradedPct + "%)");
  }
  console.log("");
  console.log("  " + s.caveat);
}

if (require.main === module) main();
module.exports = { score };
