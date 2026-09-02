#!/usr/bin/env node
'use strict';
/**
 * OUT-OF-SAMPLE CONFIGURATION SEARCH for the CRT/FVG models.
 *
 * The same three guards that rejected a better-looking TK Swing Pullback configuration
 * an hour ago, applied to FVG continuation and to the CRT+FVG+EMA short model:
 *
 *   1. THE SPLIT IS BY DATE, NOT BY TRADE. Every configuration produces a different
 *      number of trades, so splitting each at its own 60th trade would give each a
 *      different test window and make the columns incomparable.
 *   2. THE SHIPPED CONFIGURATION IS SCORED ON THE SAME TEST WINDOW. "Better" has to mean
 *      better than what is already running.
 *   3. THE WINNER IS RE-TESTED ON THE INSTRUMENTS THE FIT NEVER SAW. This is the guard
 *      that caught the TK search: it had passed the train/test split and still lost on
 *      both other symbols.
 *
 *   node tasks/model_optimise.cjs --model fvgcont [--symbol XAUUSD] [--split 0.6]
 *   node tasks/model_optimise.cjs --model crtema  [--side SELL]
 *
 * Costs are the measured broker spread, charged per trade as spread / |entry - stop|,
 * because the m15 models pay 0.12-0.20R and a gross ranking would be meaningless.
 *
 * READ-ONLY. Shells out to tasks/strategy_suite.cjs --json. Places nothing, changes
 * nothing.
 */

const path = require("path");
const { execFileSync } = require("child_process");
const ROOT = path.join(__dirname, "..");

function strArg(f, d) { const i = process.argv.indexOf(f); return (i === -1 || i + 1 >= process.argv.length) ? d : process.argv[i + 1]; }
function numArg(f, d) { const i = process.argv.indexOf(f); if (i === -1) return d; const v = Number(process.argv[i + 1]); return Number.isFinite(v) ? v : d; }

const MODEL  = strArg("--model", "fvgcont");        // fvgcont | crtema
const SYMBOL = strArg("--symbol", "XAUUSD");
const SPLIT  = numArg("--split", 0.6);
const SIDE   = strArg("--side", MODEL === "crtema" ? "SELL" : "BUY");
const OTHERS = ["XAUUSD", "BTCUSD", "SP500"].filter(s => s !== SYMBOL);

const SPREAD = { XAUUSD: 0.22, BTCUSD: 17.00, SP500: 0.36 };

// What ships today, from tasks/fvg_runner.cjs and the strategy_suite defaults.
const SHIPPED = { disp: 1.5, maxrr: 5, retest: 40, execwindow: 60, search: 40 };

// Only axes the earlier plateau sweep showed actually move the result.
const GRID = {
  disp:   [1.0, 1.5, 2.0, 2.5],
  maxrr:  [3, 5, 8],
  retest: [20, 40, 80],
};

function runConfig(cfg, symbol) {
  const args = [path.join(ROOT, "tasks", "strategy_suite.cjs"),
    "--models", MODEL === "crtema" ? "crtfvg" : "fvgcont",
    "--symbols", symbol, "--json",
    "--bias", "h4", "--exec", "m15", "--hold", "960",
    "--disp", String(cfg.disp), "--maxrr", String(cfg.maxrr),
    "--retest", String(cfg.retest), "--execwindow", String(cfg.execwindow),
    "--search", String(cfg.search)];
  if (MODEL === "crtema") args.push("--gates", "ema");
  const out = execFileSync(process.execPath, args, { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
  const parsed = JSON.parse(out);
  return parsed.trades.filter(t => SIDE === "ALL" || t.direction === (SIDE === "BUY" ? "bullish" : "bearish"));
}

function stat(rows) {
  if (!rows.length) return { n: 0, wr: 0, rpt: 0, netRpt: 0, netR: 0, pf: null };
  const wins = rows.filter(t => t.r > 0);
  const gp = wins.reduce((a, t) => a + t.r, 0);
  const gl = Math.abs(rows.filter(t => t.r <= 0).reduce((a, t) => a + t.r, 0));
  const gross = rows.reduce((a, t) => a + t.r, 0);
  // Cost matters more here than anywhere else in the project: these are m15 stops and the
  // spread runs 0.12-0.20R, so a gross ranking would pick a different winner.
  const priced = rows.filter(t => SPREAD[t.symbol] && t.riskPrice > 0);
  const cost = priced.reduce((a, t) => a + SPREAD[t.symbol] / t.riskPrice, 0);
  return { n: rows.length, wr: wins.length / rows.length * 100, rpt: gross / rows.length,
    netRpt: priced.length ? (gross - cost) / priced.length : null,
    netR: gross - cost, pf: gl > 0 ? gp / gl : null };
}
function foldsOf(rows, n) {
  const s = [...rows].sort((a, b) => a.entryTime - b.entryTime);
  const size = Math.floor(s.length / n);
  if (size < 5) return null;
  let pos = 0;
  for (let k = 0; k < n; k++) if (stat(s.slice(k * size, k === n - 1 ? s.length : (k + 1) * size)).rpt > 0) pos++;
  return pos;
}

const pad = (v, w) => String(v).padEnd(w);
const num = (v, d) => Number.isFinite(v) ? (v >= 0 ? "+" : "") + v.toFixed(d) : "-";
const iso = (s) => new Date(s * 1000).toISOString().slice(0, 10);

console.log("=".repeat(108));
console.log("  OUT-OF-SAMPLE SEARCH -- " + (MODEL === "crtema" ? "CRT+FVG+EMA reclaim" : "FVG continuation")
  + "   side " + SIDE);
console.log("  " + new Date().toISOString() + "   fit " + SYMBOL + " on the first "
  + (SPLIT * 100).toFixed(0) + "%, judge on the rest, then check " + OTHERS.join(" and "));
console.log("=".repeat(108));

const shippedAll = runConfig(SHIPPED, SYMBOL);
if (!shippedAll.length) { console.log("  shipped config produced no trades on " + SYMBOL); process.exit(1); }
const times = shippedAll.map(t => t.entryTime).sort((a, b) => a - b);
const splitTime = times[Math.floor(times.length * SPLIT)];
console.log("");
console.log("  split " + iso(splitTime) + "   train " + iso(times[0]) + " -> " + iso(splitTime)
  + "   test " + iso(splitTime) + " -> " + iso(times[times.length - 1]));

const combos = [];
for (const disp of GRID.disp)
  for (const maxrr of GRID.maxrr)
    for (const retest of GRID.retest)
      combos.push({ ...SHIPPED, disp, maxrr, retest });
console.log("  searching " + combos.length + " configurations...");

const scored = [];
for (const cfg of combos) {
  let trades;
  try { trades = runConfig(cfg, SYMBOL); } catch (e) { continue; }
  const train = trades.filter(t => t.entryTime < splitTime);
  const test  = trades.filter(t => t.entryTime >= splitTime);
  if (train.length < 30) continue;      // too thin to choose on
  scored.push({ cfg, train: stat(train), test: stat(test), folds: foldsOf(test, 5) });
}
if (!scored.length) { console.log("  no configuration produced enough training trades"); process.exit(1); }

// CHOSEN ON TRAIN TOTAL NET R, which is what the verdict judges. The first version
// selected on net R PER TRADE and then rejected its own pick on total R -- two different
// objectives in one tool, so it surfaced a highly selective config while a far better
// one sat third in the list. Selection and verdict now optimise the same quantity.
scored.sort((a, b) => (b.train.netR ?? -9e9) - (a.train.netR ?? -9e9));
const best = scored[0];
const shipTrain = stat(shippedAll.filter(t => t.entryTime < splitTime));
const shipTest  = stat(shippedAll.filter(t => t.entryTime >= splitTime));
const shipFolds = foldsOf(shippedAll.filter(t => t.entryTime >= splitTime), 5);

const row = (label, cfg, tr, te, f) => console.log("  " + pad(label, 24)
  + pad("disp" + cfg.disp + " rr" + cfg.maxrr + " retest" + cfg.retest, 26)
  + pad(tr.n, 7) + pad(num(tr.netRpt, 4), 10)
  + pad(te.n, 7) + pad(te.n ? te.wr.toFixed(1) : "-", 7)
  + pad(te.pf === null ? "-" : te.pf.toFixed(3), 8)
  + pad(num(te.netRpt, 4), 10) + pad(num(te.netR, 2), 10) + (f === null ? "-" : f + "/5"));

console.log("");
console.log("  " + pad("", 24) + pad("configuration", 26) + pad("trainN", 7) + pad("trainNet", 10)
  + pad("testN", 7) + pad("WR%", 7) + pad("PF", 8) + pad("testNet", 10) + pad("testR", 10) + "folds");
row("SHIPPED", SHIPPED, shipTrain, shipTest, shipFolds);
row("BEST ON TRAIN", best.cfg, best.train, best.test, best.folds);
console.log("");
console.log("  Top 4 by TRAINING TOTAL net R, with the test they were never fitted to:");
for (const s of scored.slice(0, 4)) row("", s.cfg, s.train, s.test, s.folds);

const delta = (best.test.netRpt ?? 0) - (shipTest.netRpt ?? 0);
console.log("");
console.log("  HELD-OUT VERDICT: best-on-train " + num(best.test.netRpt, 4)
  + " vs shipped " + num(shipTest.netRpt, 4) + "   (" + num(delta, 4) + ")");

console.log("");
console.log("  CROSS-INSTRUMENT -- the fit never saw these:");
console.log("  " + pad("symbol", 10) + pad("config", 10) + pad("trades", 8) + pad("WR%", 7)
  + pad("PF", 8) + pad("net R/t", 10) + "folds");
let bestWins = 0, shipWins = 0;
const crossTotals = { shipped: 0, best: 0 };
for (const sym of OTHERS) {
  const results = {};
  for (const [label, cfg] of [["shipped", SHIPPED], ["best", best.cfg]]) {
    let t = [];
    try { t = runConfig(cfg, sym); } catch (e) { /* shown as 0 below */ }
    const st = stat(t), f = foldsOf(t, 5);
    results[label] = st;
    crossTotals[label] += Number.isFinite(st.netR) ? st.netR : 0;
    console.log("  " + pad(sym, 10) + pad(label, 10) + pad(st.n, 8)
      + pad(st.n ? st.wr.toFixed(1) : "-", 7) + pad(st.pf === null ? "-" : st.pf.toFixed(3), 8)
      + pad(num(st.netRpt, 4), 10) + (f === null ? "-" : f + "/5"));
  }
  if ((results.best.netRpt ?? -9) > (results.shipped.netRpt ?? -9)) bestWins++; else shipWins++;
}
// TOTAL R, NOT R PER TRADE. The first version of this verdict ranked on net R/trade and
// recommended a configuration that made 60% LESS money: it won +0.8275 against +0.3663
// per trade on the held-out half and took 19 trades against 102. A model whose binding
// constraint is sample size cannot be judged on per-trade return alone, and a selective
// variant will always flatter that column.
const totalShipped = shipTest.netR + crossTotals.shipped;
const totalBest    = best.test.netR + crossTotals.best;
console.log("");
console.log("  TOTAL NET R across the held-out half and both unseen instruments:");
console.log("    shipped " + num(totalShipped, 2) + "R      candidate " + num(totalBest, 2) + "R");

console.log("");
if (totalBest <= totalShipped) {
  console.log("  VERDICT: REJECT. Higher R per trade, LOWER total R -- it is more selective, not");
  console.log("  better. Per-trade return is the wrong objective for a system short of sample size.");
} else if (delta > 0 && bestWins > shipWins) {
  console.log("  VERDICT: the candidate beat the shipped config on held-out data AND on the");
  console.log("  instruments it was never fitted to. That is the only combination worth acting on.");
} else if (delta > 0) {
  console.log("  VERDICT: REJECT. It won on the fitted symbol's held-out half and lost on "
    + shipWins + " of " + OTHERS.length + " instruments it never saw -- the same shape as the");
  console.log("  TK search, which also passed a train/test split and still failed this check.");
} else {
  console.log("  VERDICT: REJECT. It did not even beat the shipped config on held-out data.");
}
