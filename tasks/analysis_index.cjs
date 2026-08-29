/* ============================================================================
   ANALYSIS INDEX — make the nightly deep analysis readable
   ============================================================================

   WHY THIS EXISTS

   parallel_analysis.py runs nightly on the VPS: six replays feed one measured
   fact pack, five analysts read it in parallel, a synthesiser merges them. It
   writes tasks/analysis/latest.json — 542 KB, 825 replayed trades, per-setup and
   per-regime breakdowns.

   NO PAGE HAS EVER FETCHED IT. Grepped every file under dashboard/: not one
   reads /api/analysis. The largest single body of measurement this system
   produces has never been on a screen.

   WHAT IT DOES

   Trims that 542 KB into a compact artifact the page can load, at
   dashboard/analysis-latest.json. /dashboard is already served by
   express.static, so the page needs no route and the server needs no restart —
   the same reason the weekly surface is built this way.

   THE ONE RULE IT ENFORCES

   A FAILED reasoning layer must never render as an EMPTY one. On 2026-08-29 all
   five analysts and the synthesiser died with "OAuth session expired", the route
   served actions:[] blindSpots:[] verdict:null, and that was indistinguishable
   from an analysis that ran fine and found nothing. The per-agent `_error` is
   carried here as a first-class field so the page leads with it.

   Read-only over the report. Writes one file. Touches no gate, no threshold, no
   signal and no order.

   Usage: node tasks/analysis_index.cjs [--in <path>] [--out <path>] [--quiet]
   ============================================================================ */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

function opt(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const IN = opt("--in", path.join(ROOT, "tasks", "analysis", "latest.json"));
// --out so a test run cannot clobber what the page reads. That mistake was made
// once today with the agent-auth artifact and is not worth making twice.
const OUT = opt("--out", path.join(ROOT, "dashboard", "analysis-latest.json"));
const QUIET = process.argv.includes("--quiet");

/* The six breakdowns, in the order a reader wants them: what you traded, then
   how it was graded, then the market it was in, then which instrument. */
const BREAKDOWNS = [
  ["bySetup",     "By setup",     "which pattern the engine matched"],
  ["byRegime",    "By regime",    "the market state at entry"],
  ["byTrend",     "By trend",     "multi-timeframe trend at entry"],
  ["byDirection", "By direction", "long against short"],
  ["byAsset",     "By asset",     "instrument"],
  ["byStrength",  "By strength",  "the engine's own MODERATE / STRONG grading"],
];

/* ── THE AT-GATE VIEW ─────────────────────────────────────────────────────────
   The replay scores EVERY signal generateSignal emits, including hundreds the live
   confidenceThreshold would never admit. So the headline describes an engine that
   does not exist: at the time of writing it read PF 1.10 / +0.068R over 657 closed,
   while the 354 sub-gate trades inside it carried -49R on their own.

   The synthesiser caught this and said four of its own five analysts had built their
   case on that headline. Conditioning on conf >= the live gate gives PF 1.48 and
   +0.310R over 303 closed — the same replay, describing what the system actually
   opens.

   DERIVED HERE, NOT TRUSTED. The aggregation below was checked by reproducing the
   fact pack's OWN published overall from the same trade rows: 33.3% win, PF 1.10,
   +44.7R, +0.068R, exact to every decimal. Only then was it pointed at the gate
   subset, where it independently reproduced the synthesiser's 303 / 1.48 / +93.96R
   / +0.310. Two derivations agreeing is why this is publishable.

   R per trade is the fact pack's own convention: a win pays rr minus the cost
   assumption, a loss pays 1 plus it. EXPIRED rows are not closed and are excluded
   from every aggregate rather than counted as flat. */
function aggregateTrades(rows, cost) {
  const closed = rows.filter(t => t.outcome === "WIN" || t.outcome === "LOSS");
  if (!closed.length) return null;
  const wins = closed.filter(t => t.outcome === "WIN");
  const losses = closed.filter(t => t.outcome === "LOSS");
  const gross = wins.reduce((sum, t) => sum + (Number(t.rr) || 0) - cost, 0);
  const bad = losses.reduce((sum) => sum + 1 + cost, 0);
  const totalR = gross - bad;
  return {
    trades: rows.length,
    closed: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: +(wins.length / closed.length * 100).toFixed(1),
    profitFactor: bad > 0 ? +(gross / bad).toFixed(2) : null,
    totalR: +totalR.toFixed(2),
    expectancyR: +(totalR / closed.length).toFixed(3),
  };
}

/* The same six breakdowns, recomputed over the gate subset. Keyed off the trade
   fields the fact pack already carries, so nothing is re-derived from prices. */
const TRADE_KEY_BY_TABLE = {
  bySetup: t => t.setup, byRegime: t => t.regime, byTrend: t => t.trend,
  byDirection: t => t.dir, byAsset: t => t.asset, byStrength: t => t.strength,
};

function buildAtGate(facts, minSample) {
  const gate = facts.liveState
    && facts.liveState.strategySettings
    && Number(facts.liveState.strategySettings.confidenceThreshold);
  const rows = Array.isArray(facts.trades) ? facts.trades : null;
  // No gate or no trade rows means no at-gate view — stated, never estimated.
  if (!Number.isFinite(gate) || !rows) {
    return { available: false, reason: !rows ? "the report carries no trade rows" : "no live gate in the report" };
  }
  const admitted = rows.filter(t => Number(t.conf) >= gate);
  const rejected = rows.filter(t => Number(t.conf) < gate);
  const cost = Number(facts.costAssumptionR) || 0;

  const tables = {};
  for (const key of Object.keys(TRADE_KEY_BY_TABLE)) {
    const pick = TRADE_KEY_BY_TABLE[key];
    const groups = {};
    admitted.forEach(t => {
      const name = pick(t);
      if (name === undefined || name === null || name === "") return;
      (groups[name] = groups[name] || []).push(t);
    });
    tables[key] = Object.entries(groups).map(([name, group]) => {
      const agg = aggregateTrades(group, cost);
      return agg ? Object.assign({ name }, agg, { belowMinSample: agg.closed < minSample }) : null;
    }).filter(Boolean).sort((a, b) => (b.expectancyR ?? -99) - (a.expectancyR ?? -99));
  }

  return {
    available: true,
    gate,
    overall: aggregateTrades(admitted, cost),
    // What the gate threw away, which is the other half of the argument.
    rejected: aggregateTrades(rejected, cost),
    tables,
  };
}

function build() {
  let report;
  try {
    report = JSON.parse(fs.readFileSync(IN, "utf8"));
  } catch (e) {
    return {
      generatedAt: new Date().toISOString(),
      available: false,
      reason: `could not read ${path.relative(ROOT, IN)}: ${e.code || e.message}`,
      source: path.relative(ROOT, IN).replace(/\\/g, "/"),
    };
  }

  const facts = report.facts || {};
  const analysts = report.analysts || {};
  const synthesis = report.synthesis || {};

  // Which agents failed, and why. This is the field the whole file exists for.
  const analystErrors = Object.entries(analysts)
    .filter(([, a]) => a && a._error)
    .map(([agent, a]) => ({ agent, error: String(a._error).slice(0, 400) }));
  const synthesisError = synthesis._error ? String(synthesis._error).slice(0, 400) : null;
  const analystsTotal = Object.keys(analysts).length;
  const reasoningFailed = Boolean(synthesisError) || analystErrors.length > 0;

  // Each analyst's own text, when it produced one. Trimmed: the page shows an
  // excerpt and the full report stays on disk at analystReportsPath.
  const analystReports = Object.entries(analysts)
    .filter(([, a]) => a && !a._error)
    .map(([agent, a]) => ({
      agent,
      text: typeof a === "string" ? a : (a.text || a.report || JSON.stringify(a)),
    }))
    .map(r => ({ agent: r.agent, text: String(r.text).slice(0, 6000) }));

  const tables = BREAKDOWNS
    .filter(([key]) => facts[key] && Object.keys(facts[key]).length)
    .map(([key, label, note]) => ({
      key, label, note,
      rows: Object.entries(facts[key]).map(([name, v]) => ({
        name,
        trades: v.trades ?? null,
        closed: v.closed ?? null,
        wins: v.wins ?? null,
        losses: v.losses ?? null,
        winRatePct: v.winRatePct ?? null,
        profitFactor: v.profitFactor ?? null,
        totalR: v.totalR ?? null,
        expectancyR: v.expectancyR ?? null,
        // Carried through, never hidden: a row under the sample floor must be
        // visible AND marked, not silently dropped or silently trusted.
        belowMinSample: v.belowMinSample === true,
      // R is the unit this system judges edge by, so that is the sort key.
      })).sort((a, b) => (b.expectancyR ?? -99) - (a.expectancyR ?? -99)),
    }));

  const ageHours = report.generatedAt
    ? +(((Date.now() - Date.parse(report.generatedAt)) / 3600000).toFixed(1))
    : null;

  return {
    generatedAt: new Date().toISOString(),
    available: true,
    source: path.relative(ROOT, IN).replace(/\\/g, "/"),
    reportGeneratedAt: report.generatedAt || null,
    ageHours,
    // The analysis runs nightly, so past ~36h it has missed a run.
    staleAfterHours: 36,
    overall: facts.overall || null,
    atGate: buildAtGate(facts, facts.minSampleForRecommendation || 5),
    coverage: facts.coverage || null,
    costAssumptionR: facts.costAssumptionR ?? null,
    minSampleForRecommendation: facts.minSampleForRecommendation ?? null,
    replayErrors: Array.isArray(facts.replayErrors) ? facts.replayErrors : null,
    replaysOk: Array.isArray(facts.replayErrors) && facts.replayErrors.length === 0,
    reasoningFailed,
    synthesisError,
    analystErrors,
    analystsRun: analystsTotal - analystErrors.length,
    analystsTotal,
    verdict: synthesis.verdict ?? null,
    actions: synthesis.actions ?? [],
    blindSpots: synthesis.blindSpots ?? [],
    analystReports,
    tables,
    // Stated in the payload so no reader has to remember it.
    caveat: "These are REPLAYED trades over historical bars at a fixed cost assumption, "
          + "not realised P&L. Never merge them with get_performance, which counts real "
          + "fills. Where this disagrees with a walk-forward, the walk-forward wins.",
    feedsTheGate: false,
  };
}

const index = build();
try {
  fs.writeFileSync(OUT, JSON.stringify(index, null, 2));
} catch (e) {
  if (!QUIET) console.error(`[analysis-index] could not write ${path.relative(ROOT, OUT)}: ${e.message}`);
  process.exit(1);
}

if (!QUIET) {
  if (!index.available) {
    console.log(`[analysis-index] UNAVAILABLE — ${index.reason}`);
  } else {
    console.log(`[analysis-index] ${index.overall ? index.overall.trades : "?"} replayed trades, `
      + `${index.tables.length} breakdown(s), report ${index.ageHours}h old, `
      + `analysts ${index.analystsRun}/${index.analystsTotal}`
      + (index.reasoningFailed ? " — REASONING FAILED" : ""));
    console.log(`[analysis-index] wrote ${path.relative(ROOT, OUT)}`);
  }
}
process.exit(0);
