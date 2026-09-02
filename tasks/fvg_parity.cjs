#!/usr/bin/env node
'use strict';
/**
 * PARITY: does the LIVE runner find what the BACKTEST counted?
 *
 * tasks/strategy_suite.cjs measured FVG continuation over five years of broker CSVs and
 * reported 1,246 trades at +0.4075R gross. tasks/fvg_runner.cjs implements the same model
 * against the live bridge cache. Those are two pieces of code reading two feeds, and
 * nothing so far has checked that they agree.
 *
 * This replays the ARCHIVE through the RUNNER's own evaluate(), bar by bar, exactly as
 * the live runner sees it -- one growing window, decide on the last bar only. If the
 * counts are close, the runner implements the measured model. If they are not, the
 * backtest is describing code that is not what would trade, and every number attached to
 * it is about a different strategy.
 *
 *   node tasks/fvg_parity.cjs [--symbols XAUUSD,BTCUSD,SP500] [--bars 8000]
 *
 * WHY IT ONLY WALKS THE TAIL. Calling evaluate() on every one of ~100,000 m15 bars with a
 * fresh slice each time is O(n^2) on the detector. The tail is enough to compare RATES --
 * setups per 1,000 bars -- which is the quantity that has to match. A rate check on 8,000
 * bars catches a model that fires ten times too often or not at all, which is the failure
 * this exists to find.
 *
 * READ-ONLY. Reads CSVs, prints. Writes nothing, places nothing, changes nothing.
 */

const fs   = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const { evaluate, EXEC_WINDOW, COOLDOWN_BARS } = require(path.join(ROOT, "tasks", "fvg_runner.cjs"));

function strArg(f, d) { const i = process.argv.indexOf(f); return (i === -1 || i + 1 >= process.argv.length) ? d : process.argv[i + 1]; }
function numArg(f, d) { const i = process.argv.indexOf(f); if (i === -1) return d; const v = Number(process.argv[i + 1]); return Number.isFinite(v) ? v : d; }

const SYMBOLS  = strArg("--symbols", "XAUUSD,BTCUSD,SP500").split(",").map(s => s.trim());
const TAIL     = numArg("--bars", 8000);
const BIAS_TF  = "H4";
const EXEC_TF  = "M15";

function load(symbol, tf) {
  const file = path.join(ROOT, "tasks", "history", symbol + "_" + tf + ".csv");
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  lines.shift();
  const times = [], highs = [], lows = [], closes = [];
  for (const raw of lines) {
    const p = raw.trim().split(",");
    if (p.length < 5) continue;
    const t = Number(p[0]), h = Number(p[2]), l = Number(p[3]), c = Number(p[4]);
    if (!(Number.isFinite(t) && Number.isFinite(h) && Number.isFinite(l) && Number.isFinite(c))) continue;
    times.push(t); highs.push(h); lows.push(l); closes.push(c);
  }
  return { times, highs, lows, closes };
}
const upTo = (b, end) => ({
  times: b.times.slice(0, end + 1), highs: b.highs.slice(0, end + 1),
  lows: b.lows.slice(0, end + 1), closes: b.closes.slice(0, end + 1),
});

const pad = (v, w) => String(v).padEnd(w);
console.log("=".repeat(96));
console.log("  PARITY -- the live runner's evaluate(), replayed over the broker archive");
console.log("  " + new Date().toISOString() + "   tail " + TAIL + " m15 bars per asset");
console.log("  Backtest reference: 1,246 setups over the full archive, all three assets");
console.log("=".repeat(96));
console.log("");
console.log("  " + pad("symbol", 9) + pad("bars walked", 14) + pad("setups", 9)
  + pad("per 1k bars", 14) + pad("days", 8) + "per week");

let totalSetups = 0, totalBars = 0;
for (const symbol of SYMBOLS) {
  const bias = load(symbol, BIAS_TF), exec = load(symbol, EXEC_TF);
  if (!bias || !exec) { console.log("  " + pad(symbol, 9) + "missing archive"); continue; }

  const from = Math.max(EXEC_WINDOW + 3, exec.closes.length - TAIL);
  let setups = 0;
  let biasCursor = 0;
  let lastEntry = null;
  const seen = new Set();
  for (let i = from; i < exec.closes.length; i++) {
    // The bias series the runner would have had: every h4 bar CLOSED by this m15 bar's
    // open time. Same as-of rule as the backtest -- a bias bar opening at t is not known
    // until t + 14400.
    const tNow = exec.times[i];
    while (biasCursor + 1 < bias.times.length && bias.times[biasCursor + 1] + 14400 <= tNow) biasCursor++;
    if (biasCursor < 200) continue;
    // The cooldown is fed the same way the live runner feeds it -- from the previous
    // recorded entry -- so the replay exercises the real path, not a simplified one.
    const setup = evaluate(symbol, symbol, upTo(bias, biasCursor), upTo(exec, i), lastEntry);
    if (setup && !seen.has(setup.key)) { seen.add(setup.key); setups++; lastEntry = exec.times[i]; }
  }
  const walked = exec.closes.length - from;
  const days = (exec.times[exec.closes.length - 1] - exec.times[from]) / 86400;
  totalSetups += setups; totalBars += walked;
  console.log("  " + pad(symbol, 9) + pad(walked, 14) + pad(setups, 9)
    + pad((setups / walked * 1000).toFixed(2), 14) + pad(days.toFixed(0), 8)
    + (days > 0 ? (setups / days * 7).toFixed(2) : "-"));
}

console.log("  " + "-".repeat(88));
console.log("  " + pad("TOTAL", 9) + pad(totalBars, 14) + pad(totalSetups, 9)
  + pad((totalSetups / totalBars * 1000).toFixed(2), 14));
console.log("");
console.log("  The backtest's 1,246 setups came from ~308,000 archive m15 bars across the three");
console.log("  assets, a rate of about 4.0 per 1,000 bars. A runner rate far from that is not a");
console.log("  tuning difference, it is a different model.");
