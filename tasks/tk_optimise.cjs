#!/usr/bin/env node
'use strict';
/**
 * OUT-OF-SAMPLE CONFIGURATION SEARCH for TK Swing Trend Pullback.
 *
 * The per-axis sweep found a plateau -- PF 1.33 to 1.50 on every parameter -- and several
 * neighbours of the live settings score better. Stacking those per-axis winners into one
 * configuration is EXACTLY the mistake this session already caught once: a five-year
 * optimum for FVG continuation (disp 1.0) that the recent window flatly contradicted, and
 * a nine-component score whose in-sample re-weighting inverted out of sample.
 *
 * So the grid is fitted on the FIRST 60% of the period and judged ONLY on the last 40%,
 * which the search never sees. Three guards make that honest:
 *
 *   1. THE SPLIT IS BY DATE, NOT BY TRADE. Every configuration produces a different
 *      number of trades, so splitting each one at its own 60th trade would give each
 *      config a different test period and make the columns incomparable.
 *   2. THE LIVE CONFIGURATION IS SCORED ON THE SAME TEST WINDOW. "Better" has to mean
 *      better than what is running, on the same bars, or it means nothing.
 *   3. THE WINNER IS RE-TESTED ON THE OTHER TWO INSTRUMENTS, which the fit never touched.
 *      A parameter set that only works on the symbol it was fitted to is fitted to the
 *      symbol.
 *
 *   node tasks/tk_optimise.cjs [--tf H4] [--symbol XAUUSD] [--split 0.6]
 *
 * READ-ONLY. Shells out to tasks/tk_pullback_v2.cjs --json, which reads CSVs and prints.
 * Nothing here places an order or changes a setting.
 */

const path = require("path");
const { execFileSync } = require("child_process");
const ROOT = path.join(__dirname, "..");

function strArg(f, d) { const i = process.argv.indexOf(f); return (i === -1 || i + 1 >= process.argv.length) ? d : process.argv[i + 1]; }
function numArg(f, d) { const i = process.argv.indexOf(f); if (i === -1) return d; const v = Number(process.argv[i + 1]); return Number.isFinite(v) ? v : d; }

const TF     = strArg("--tf", "H4");
const SYMBOL = strArg("--symbol", "XAUUSD");
const SPLIT  = numArg("--split", 0.6);

// The live panel settings, read off the screenshots on 2026-09-02.
const LIVE = { emaslow: 51, slope: 1, pushatr: 0.5, tol: 0.55, atrlen: 12, atrtrail: 4.5 };

// Only axes the sweep showed actually move the result. `pushatr` is deliberately EXCLUDED:
// it is inert below ~1 on this strategy, so including it would multiply the grid by four
// and add nothing but chances to fit noise.
const GRID = {
  emaslow:  [48, 50, 55],
  tol:      [0.35, 0.55, 0.7, 0.9],
  atrlen:   [8, 12, 14, 20],
  atrtrail: [2.5, 3.5, 4.5, 6.0],
};

function runConfig(cfg, symbol) {
  const args = [path.join(ROOT, "tasks", "tk_pullback_v2.cjs"),
    "--tf", TF, "--symbols", symbol, "--shorts", "0", "--json",
    "--slope", String(LIVE.slope), "--pushatr", String(LIVE.pushatr),
    "--emaslow", String(cfg.emaslow), "--tol", String(cfg.tol),
    "--atrlen", String(cfg.atrlen), "--atrtrail", String(cfg.atrtrail),
    "--partial", "0", "--be", "0", "--trail", "0"];
  const out = execFileSync(process.execPath, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out).trades;
}

function stat(rows) {
  if (!rows.length) return { n: 0, wr: 0, rpt: 0, netR: 0, pf: null };
  const wins = rows.filter(t => t.r > 0);
  const gp = wins.reduce((a, t) => a + t.r, 0);
  const gl = Math.abs(rows.filter(t => t.r <= 0).reduce((a, t) => a + t.r, 0));
  const netR = rows.reduce((a, t) => a + t.r, 0);
  return { n: rows.length, wr: wins.length / rows.length * 100, rpt: netR / rows.length,
    netR, pf: gl > 0 ? gp / gl : null };
}
function foldsOf(rows, n) {
  const s = [...rows].sort((a, b) => a.entryTime - b.entryTime);
  const size = Math.floor(s.length / n);
  if (size < 5) return null;
  let pos = 0;
  for (let k = 0; k < n; k++) {
    if (stat(s.slice(k * size, k === n - 1 ? s.length : (k + 1) * size)).rpt > 0) pos++;
  }
  return pos;
}

const pad = (v, w) => String(v).padEnd(w);
const num = (v, d) => Number.isFinite(v) ? (v >= 0 ? "+" : "") + v.toFixed(d) : "-";

console.log("=".repeat(104));
console.log("  OUT-OF-SAMPLE CONFIGURATION SEARCH -- TK Swing Trend Pullback, long only");
console.log("  " + new Date().toISOString() + "   " + SYMBOL + " " + TF
  + "   fit on the first " + (SPLIT * 100).toFixed(0) + "% of the period, judge on the rest");
console.log("=".repeat(104));

// The split date comes from the LIVE config's own trade span, so every configuration is
// measured against one fixed boundary rather than its own.
const liveAll = runConfig(LIVE, SYMBOL);
if (!liveAll.length) { console.log("  live config produced no trades"); process.exit(1); }
const times = liveAll.map(t => t.entryTime).sort((a, b) => a - b);
const splitTime = times[Math.floor(times.length * SPLIT)];
const iso = (s) => new Date(s * 1000).toISOString().slice(0, 10);
console.log("");
console.log("  split at " + iso(splitTime) + "   train " + iso(times[0]) + " -> " + iso(splitTime)
  + "   test " + iso(splitTime) + " -> " + iso(times[times.length - 1]));

const combos = [];
for (const emaslow of GRID.emaslow)
  for (const tol of GRID.tol)
    for (const atrlen of GRID.atrlen)
      for (const atrtrail of GRID.atrtrail)
        combos.push({ ...LIVE, emaslow, tol, atrlen, atrtrail });

console.log("  searching " + combos.length + " configurations...");
const scored = [];
for (const cfg of combos) {
  let trades;
  try { trades = runConfig(cfg, SYMBOL); } catch (e) { continue; }
  const train = trades.filter(t => t.entryTime < splitTime);
  const test  = trades.filter(t => t.entryTime >= splitTime);
  // A configuration that barely trades in the training half cannot be chosen on the
  // strength of it: 20 trades is already thin for a fold-of-five judgement.
  if (train.length < 40) continue;
  scored.push({ cfg, train: stat(train), test: stat(test), testFolds: foldsOf(test, 5) });
}
if (!scored.length) { console.log("  no configuration produced enough training trades"); process.exit(1); }

// CHOSEN ON THE TRAINING HALF ONLY, by R/trade. Not by PF: PF rewards a configuration
// that takes very few, very good trades, and the binding constraint on this system is
// sample size.
scored.sort((a, b) => b.train.rpt - a.train.rpt);
const best = scored[0];
const liveTrain = stat(liveAll.filter(t => t.entryTime < splitTime));
const liveTest  = stat(liveAll.filter(t => t.entryTime >= splitTime));
const liveFolds = foldsOf(liveAll.filter(t => t.entryTime >= splitTime), 5);

const show = (label, cfg, tr, te, tf) => {
  console.log("  " + pad(label, 26)
    + pad("EMA" + cfg.emaslow + " tol" + cfg.tol + " atr" + cfg.atrlen + " trail" + cfg.atrtrail, 34)
    + pad(tr.n, 7) + pad(num(tr.rpt, 4), 10)
    + pad(te.n, 7) + pad(te.wr.toFixed(1), 7) + pad(te.pf === null ? "-" : te.pf.toFixed(3), 8)
    + pad(num(te.rpt, 4), 10) + pad(num(te.netR, 2), 10) + (tf === null ? "-" : tf + "/5"));
};
console.log("");
console.log("  " + pad("", 26) + pad("configuration", 34) + pad("trainN", 7) + pad("trainR", 10)
  + pad("testN", 7) + pad("WR%", 7) + pad("PF", 8) + pad("testR", 10) + pad("testNet", 10) + "folds");
show("LIVE (what runs today)", LIVE, liveTrain, liveTest, liveFolds);
show("BEST ON TRAIN", best.cfg, best.train, best.test, best.testFolds);

console.log("");
console.log("  Top 5 by TRAINING R/trade, with the test result they were never fitted to:");
for (const s of scored.slice(0, 5)) {
  show("", s.cfg, s.train, s.test, s.testFolds);
}

const delta = best.test.rpt - liveTest.rpt;
console.log("");
console.log("  OUT-OF-SAMPLE VERDICT: best-on-train scores " + num(best.test.rpt, 4)
  + " on the held-out half against the live config's " + num(liveTest.rpt, 4)
  + "  (" + num(delta, 4) + ")");
console.log(delta > 0
  ? "  The search found something that survived. Confirm it on the other instruments before acting."
  : "  The search found nothing that beats what is already running. Leave it alone.");

// The strongest available check: does the winner work on symbols the fit never saw?
console.log("");
console.log("  CROSS-INSTRUMENT CHECK -- the fit never saw these:");
console.log("  " + pad("symbol", 10) + pad("config", 10) + pad("trades", 8) + pad("WR%", 7)
  + pad("PF", 8) + pad("R/trade", 10) + "folds");
for (const sym of ["BTCUSD", "SP500"]) {
  for (const [label, cfg] of [["live", LIVE], ["best", best.cfg]]) {
    let t = [];
    try { t = runConfig(cfg, sym); } catch (e) { /* reported as no trades below */ }
    const st = stat(t), f = foldsOf(t, 5);
    console.log("  " + pad(sym, 10) + pad(label, 10) + pad(st.n, 8)
      + pad(st.n ? st.wr.toFixed(1) : "-", 7) + pad(st.pf === null ? "-" : st.pf.toFixed(3), 8)
      + pad(st.n ? num(st.rpt, 4) : "-", 10) + (f === null ? "-" : f + "/5"));
  }
}
