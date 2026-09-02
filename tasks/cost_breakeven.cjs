#!/usr/bin/env node
'use strict';
/**
 * BREAK-EVEN COST -- how much spread an instrument's edge can actually pay.
 *
 * Every R/trade in the profitable ledger is scored at the house flat basis of 0.05R, and
 * tasks/_cost_basis.cjs already established that the flat number is CONSERVATIVE for the
 * three live instruments (5.8x the real spread cost on Gold, 3.8x on BTC, 10.7x on SPX).
 * It says nothing about the candidates, and it cannot: cost in R is
 *
 *     costR = spread / |entry - stop|
 *
 * and both halves differ enormously across instruments. XRPUSD's spread is 0.63% of price
 * against Gold's 0.005% -- a 123x difference that no flat number can represent.
 *
 * This asks the question the ledger's NEEDS_COST_CHECK rows are waiting on:
 *
 *   1. What does the REAL spread cost, in R, on this instrument's own risk distances?
 *   2. What spread would take the edge to exactly zero? (the break-even)
 *   3. How much headroom is that -- break-even divided by the spread actually quoted?
 *
 * Headroom below 1.0 means the instrument does not pay its own spread and must not trade,
 * however good its gross number looks.
 *
 *   node tasks/cost_breakeven.cjs [--symbols ETHUSD,XRPUSD,...] [--gate 70] [--hold 320]
 *
 * SPREADS ARE PASSED IN, MEASURED, NOT GUESSED -- read from the live MT5 terminal with
 * symbol_info().spread * point and recorded in SPREADS below with the date. They are one
 * feed's typical values at one moment: spreads widen at the open, on news and overnight,
 * and none of that is modelled here. Commission, swap on a held position and slippage
 * through a fast stop are all real and NONE of them is measured -- so headroom near 1.0
 * is a REJECTION, not a pass. Only a wide margin means anything.
 *
 * READ-ONLY. Shells to tasks/_replay_mtf.cjs, which patches an in-memory copy of the
 * engine. No gate, threshold, setting, position or learning file is touched.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");

function strArg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return (i === -1 || i + 1 >= process.argv.length) ? fallback : process.argv[i + 1];
}
function numArg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  if (i === -1 || i + 1 >= process.argv.length) return fallback;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : fallback;
}

// Measured from the live terminal 2026-09-02 via symbol_info().spread * point, after
// selecting each symbol into Market Watch and waiting for a tick -- an unselected symbol
// reports spread 0, which would read as a free instrument.
const SPREADS = {
  XAUUSD:  { spread: 0.22,    price: 4308.99,  ticker: "GC=F" },
  BTCUSD:  { spread: 17.00,   price: 76649.37, ticker: "BTC-USD" },
  SP500:   { spread: 0.36,    price: 7624.50,  ticker: "^GSPC" },
  ETHUSD:  { spread: 2.47,    price: 2373.35,  ticker: "ETHUSD" },
  XRPUSD:  { spread: 0.0083,  price: 1.3199,   ticker: "XRPUSD" },
  LTCUSD:  { spread: 1.00,    price: 48.34,    ticker: "LTCUSD" },
  XAGUSD:  { spread: 0.021,   price: 63.764,   ticker: "XAGUSD" },
  USOUSD:  { spread: 0.037,   price: 90.51,    ticker: "USOUSD" },
  GBPUSD:  { spread: 0.00015, price: 1.35,     ticker: "GBPUSD" },
  USDJPY:  { spread: 0.019,   price: 159.85,   ticker: "USDJPY" },
  EURUSD:  { spread: 0.00014, price: 1.16,     ticker: "EURUSD" },
  AUDUSD:  { spread: 0.00014, price: 0.71,     ticker: "AUDUSD" },
};

const GATE    = numArg("--gate", 70);
const HOLD    = String(numArg("--hold", 320));
const SYMBOLS = strArg("--symbols", "ETHUSD,XRPUSD,XAGUSD,XAUUSD,BTCUSD,SP500")
  .split(",").map(s => s.trim().toUpperCase());

function replay(symbol, ticker) {
  const env = {
    ...process.env,
    MTF_CONF_FLOOR: "40",
    MTF_EMIT_R: "1",
    MTF_EMIT_RISK: "1",     // the whole point: |entry - stop| per trade
    MTF_MAX_HOLD: HOLD,     // NEVER the default 40 -- see the horizon note in _replay_mtf
  };
  delete env.MTF_MIN_RR; delete env.MTF_PIVOT_MIN_ATR; delete env.MTF_TRAIL_LADDER;
  const res = spawnSync(process.execPath,
    [path.join(ROOT, "tasks", "_replay_mtf.cjs"), ROOT, symbol, ticker, "40"],
    { env, maxBuffer: 128 * 1024 * 1024, encoding: "utf8", timeout: 900000 });
  if (res.status !== 0) throw new Error("exit " + res.status + ": " + String(res.stderr || "").slice(-240));
  return JSON.parse(res.stdout);
}

// The risk field's name is not guaranteed across versions of the emitter, so look for any
// of the plausible spellings and say plainly when none is present rather than treating a
// missing field as a zero risk distance, which would divide by zero into infinity.
function riskOf(t) {
  for (const k of ["risk", "riskDistance", "riskPrice", "stopDistance"]) {
    if (Number.isFinite(t[k]) && t[k] > 0) return t[k];
  }
  return null;
}

const pad = (v, w) => String(v).padEnd(w);
const num = (v, d) => Number.isFinite(v) ? (v >= 0 ? "+" : "") + v.toFixed(d) : "-";

const lines = [];
const say = (s) => { lines.push(s); console.log(s); };

say("=".repeat(112));
say("  BREAK-EVEN COST  --  what spread can each instrument's edge actually pay?");
say("  " + new Date().toISOString() + "   gate " + GATE + "  hold " + HOLD + " H4 bars");
say("  costR = spread / |entry - stop|.  Headroom = break-even spread / quoted spread.");
say("  Spread only: commission, swap and slippage are NOT modelled, so headroom near 1.0 is a REJECT.");
say("=".repeat(112));
say("");
say("  " + pad("symbol", 9) + pad("n", 6) + pad("gross R/t", 11) + pad("med risk", 11)
  + pad("spread", 10) + pad("costR", 9) + pad("net R/t", 10) + pad("breakeven", 12) + "headroom");

const results = [];
for (const symbol of SYMBOLS) {
  const meta = SPREADS[symbol];
  if (!meta) { say("  " + pad(symbol, 9) + "no measured spread on record"); continue; }
  let trades;
  try { trades = replay(symbol, meta.ticker); }
  catch (e) { say("  " + pad(symbol, 9) + "ERROR " + e.message.slice(0, 60)); continue; }

  const gated = trades.filter(t => (t.conf ?? 0) >= GATE && Number.isFinite(t.r));
  const withRisk = gated.filter(t => riskOf(t) !== null);
  if (!gated.length) { say("  " + pad(symbol, 9) + "no trades at gate " + GATE); continue; }
  if (!withRisk.length) {
    say("  " + pad(symbol, 9) + pad(gated.length, 6)
      + "risk distance absent from every row -- cannot cost this instrument");
    continue;
  }

  const risks = withRisk.map(riskOf).sort((a, b) => a - b);
  const medRisk = risks[Math.floor(risks.length / 2)];
  const grossR = withRisk.reduce((a, t) => a + t.r, 0);
  const costs  = withRisk.map(t => meta.spread / riskOf(t));
  const totalCost = costs.reduce((a, c) => a + c, 0);
  const netR = grossR - totalCost;
  const n = withRisk.length;

  // Break-even spread solves  sum(r_i) = S * sum(1/risk_i), so S = grossR / sum(1/risk).
  const invRisk = withRisk.reduce((a, t) => a + 1 / riskOf(t), 0);
  const breakeven = invRisk > 0 ? grossR / invRisk : null;
  const headroom = (breakeven !== null && meta.spread > 0) ? breakeven / meta.spread : null;

  results.push({ symbol, n, grossRpt: grossR / n, netRpt: netR / n, medRisk,
    spread: meta.spread, costRpt: totalCost / n, breakeven, headroom });

  say("  " + pad(symbol, 9) + pad(n, 6) + pad(num(grossR / n, 4), 11)
    + pad(medRisk.toFixed(medRisk < 1 ? 5 : 2), 11)
    + pad(meta.spread < 1 ? meta.spread.toFixed(5) : meta.spread.toFixed(2), 10)
    + pad((totalCost / n).toFixed(4), 9) + pad(num(netR / n, 4), 10)
    + pad(breakeven === null ? "-" : (breakeven < 1 ? breakeven.toFixed(5) : breakeven.toFixed(2)), 12)
    + (headroom === null ? "-" : headroom.toFixed(1) + "x"));
}

say("");
say("  READING IT: headroom is how many times the quoted spread the edge could absorb before");
say("  reaching zero. Under 1.0x the instrument cannot pay its own spread. Between 1x and");
say("  roughly 3x, the unmodelled costs -- commission, swap, slippage -- can plausibly close");
say("  the gap on their own, so that band is not a pass either.");

try {
  const outDir = path.join(ROOT, "tasks", "analysis");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "cost-breakeven.txt"), lines.join("\n") + "\n");
  fs.writeFileSync(path.join(outDir, "cost-breakeven.json"), JSON.stringify({
    generatedAt: new Date().toISOString(), gate: GATE, hold: Number(HOLD),
    spreadsMeasured: "2026-09-02 live MT5 symbol_info", results, feedsTheGate: false,
  }, null, 2));
  say("");
  say("  written to tasks/analysis/cost-breakeven.{txt,json}");
} catch (e) { console.error("  report not written: " + e.message); }
