#!/usr/bin/env node
'use strict';
/* ============================================================================
   h1_strategies_backtest.cjs — the two H1 strategies from the UK100 batch,
   tested on THIS system's instruments
   ============================================================================

   The batch report describes three strategies. Strategy 2 (EMA-Cross Momentum,
   M15) is already covered by tasks/ema_cross_backtest.cjs. These are the other two,
   both on H1, both with stated stops and targets that were never applied here:

   1 · BUY-THE-DIP REVERSION   +0.069R, H1, LONG only, n=984
       "This one waits for a panic. When the market drops much faster and further
        than usual and looks exhausted, it steps in and buys the bounce. The idea:
        sharp, oversold sell-offs tend to snap back within a day or two, so it fades
        the fear rather than joining it."
       Stop 2.5xATR below entry · take profit at 1.5x the risk · closes within a day.

   3 · REVERSAL IN TREND       +0.070R, H1, LONG + SHORT, n=702
       "It only trades WITH the bigger trend. In an uptrend it buys small dips
        instead of chasing highs; in a downtrend it sells the rallies. So it gets a
        better entry price but always in the direction the market is already
        heading."
       Stop 2.5xATR · take profit at 1.5x the risk · closes within a day.

   WHAT IS INTERPRETED, SAID PLAINLY. The stops, targets and the one-day time exit
   are STATED in the report and are implemented exactly. The entry TRIGGERS are
   described in words, not numbers - "drops much faster and further than usual",
   "small dips" - so they are given explicit definitions here:

     - "much faster and further than usual" = the close is DIP_ATR or more below the
       recent high, measured in ATR, which is the natural way to say "unusual" for a
       given instrument's own volatility.
     - "the bigger trend" = price against the H1 EMA200, the same structural trend
       definition generateSignal already uses.
     - "small dips" = a pullback of at least PULLBACK_ATR against the trend.

   Those three numbers are DECLARED here and swept over a small fixed grid, with the
   promotion bar deflated for the number of combinations tried. That is not the same
   as knowing their rule, and a result here is evidence about THIS definition on
   THESE instruments - never a verdict on their strategy.

   HONEST MECHANICS, each the way that does not manufacture edge:
     - entry at the NEXT bar's open after the trigger bar closes
     - stop and target checked against bar HIGH and LOW, never the close
     - a bar touching BOTH is scored a LOSS - intrabar order is unknowable
     - the one-day exit closes at the open of the bar after 24 H1 bars

   Read-only. No setting, no gate, no position. feedsTheGate false.

   Usage:
     node tasks/h1_strategies_backtest.cjs
     node tasks/h1_strategies_backtest.cjs --cost 0.02
     node tasks/h1_strategies_backtest.cjs --json
   ============================================================================ */

const path = require("path");
const fs   = require("fs");
const { deflatedBar } = require(path.join(__dirname, "_deflated_bar.cjs"));
const { costFor, FLAT_COST_R, describeBasis } = require(path.join(__dirname, "_cost_basis.cjs"));

const ROOT = path.join(__dirname, "..");

function opt(name, def) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}
const flag = n => process.argv.includes(n);

const COST_R   = Number(opt("--cost", "0.05"));
const FOLDS    = Number(opt("--folds", "5"));
const ATR_LEN  = 14;
const ATR_MULT = 2.5;    // stated: "Stop 2.5xATR"
const TARGET_R = 1.5;    // stated: "take profit at 1.5x the risk"
const HOLD_BARS = 24;    // stated: "closes within a day" — 24 H1 bars
const LOOKBACK = 24;     // window for "recent high/low"
const AS_JSON  = flag("--json");

// What the header says about the basis. Per-asset says SPREAD ONLY in the headline
// itself, because a number is only readable next to what it was charged.
function costHeader() {
  return COST_BASIS === "perasset"
    ? "PER-ASSET SPREAD ONLY (a FLOOR - no commission, no swap, no slippage)"
    : COST_R + "R/trade flat";
}

// --cost-basis perasset charges each trade its own instrument's SPREAD over that
// trade's own risk distance, instead of one flat number for three instruments whose
// spreads differ by orders of magnitude.
//
// OPT-IN, NEVER THE DEFAULT. _cost_basis.cjs states what this basis is and is not:
// spread is a FLOOR on cost. Commission, swap on a held position and slippage on a
// stop through a fast market are all real and NONE is modelled here. Its own warning
// is that a harness switching to spread-only costs and reporting a better number
// "has not found edge, it has stopped paying for things that still cost money".
//
// It understates MORE for this strategy than for most: HOLD_BARS is 24 H1 bars, so a
// position routinely sits overnight and pays SWAP - precisely one of the components
// spread alone does not capture.
const COST_BASIS = String(opt("--cost-basis", "flat")).toLowerCase();
if (COST_BASIS !== "flat" && COST_BASIS !== "perasset") {
  console.error('--cost-basis must be "flat" or "perasset"');
  process.exit(1);
}

// Declared grids. Small on purpose: every extra combination raises the bar.
const DIP_ATRS      = [1.5, 2.0, 3.0];   // strategy 1 — how far below the recent high
const PULLBACK_ATRS = [0.5, 1.0, 1.5];   // strategy 3 — how deep a "small dip"

const ASSETS = ["BTCUSD", "XAUUSD", "SP500"];

function loadH1(sym) {
  const p = path.join(ROOT, "tasks", "history", sym + "_H1.csv");
  if (!fs.existsSync(p)) return null;
  const lines = fs.readFileSync(p, "utf8").trim().split("\n").slice(1);
  const t = [], o = [], h = [], l = [], c = [];
  for (const line of lines) {
    const f = line.split(",");
    const close = parseFloat(f[4]);
    if (!Number.isFinite(close)) continue;
    t.push(Number(f[0])); o.push(parseFloat(f[1])); h.push(parseFloat(f[2]));
    l.push(parseFloat(f[3])); c.push(close);
  }
  return { t, o, h, l, c };
}

function emaSeries(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  out[period - 1] = seed / period;
  for (let i = period; i < values.length; i++) out[i] = values[i] * k + out[i - 1] * (1 - k);
  return out;
}

function atrSeries(h, l, c, period) {
  const out = new Array(c.length).fill(null);
  const tr = new Array(c.length).fill(0);
  for (let i = 1; i < c.length; i++) {
    tr[i] = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
  }
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  let a = sum / period;
  out[period] = a;
  for (let i = period + 1; i < c.length; i++) { a = (a * (period - 1) + tr[i]) / period; out[i] = a; }
  return out;
}

// Walk one open position forward. Shared by both strategies so their exits cannot
// drift apart — the report gives them the same stop, target and time exit.
// Cost in R for ONE trade. Flat unless --cost-basis perasset, in which case it is
// this instrument's spread divided by this trade's risk distance. costFor falls back
// to the flat number itself on an unknown symbol or a non-positive risk, so a bad
// row is charged MORE, never less.
function tradeCost(sym, risk) {
  if (COST_BASIS !== "perasset") return COST_R;
  const c = costFor(sym, risk);
  return (c && Number.isFinite(c.costR)) ? c.costR : FLAT_COST_R;
}

function resolve(bars, entryIdx, dir, entry, risk, sym) {
  const { o, h, l } = bars;
  const stop   = dir === 1 ? entry - risk : entry + risk;
  const target = dir === 1 ? entry + risk * TARGET_R : entry - risk * TARGET_R;
  const last = Math.min(entryIdx + HOLD_BARS, h.length - 2);
  for (let j = entryIdx; j <= last; j++) {
    const hitStop   = dir === 1 ? l[j] <= stop   : h[j] >= stop;
    const hitTarget = dir === 1 ? h[j] >= target : l[j] <= target;
    // Both in one bar is a LOSS. Assuming the target came first is how a backtest
    // invents edge it never had.
    if (hitStop && hitTarget) return { r: -1 - tradeCost(sym, risk), exit: "BOTH_IN_BAR" };
    if (hitStop)   return { r: -1 - tradeCost(sym, risk), exit: "STOP" };
    if (hitTarget) return { r: TARGET_R - tradeCost(sym, risk), exit: "TARGET" };
  }
  const px = o[last + 1];
  const r = dir === 1 ? (px - entry) / risk : (entry - px) / risk;
  return { r: r - tradeCost(sym, risk), exit: "TIME" };
}

function runBuyTheDip(bars, dipAtr, sym) {
  const { t, o, h, c } = bars;
  const atr = atrSeries(bars.h, bars.l, c, ATR_LEN);
  const trades = [];
  let blockedUntil = -1;
  for (let i = LOOKBACK + ATR_LEN + 1; i < c.length - HOLD_BARS - 2; i++) {
    if (i < blockedUntil || atr[i] === null || !(atr[i] > 0)) continue;
    let recentHigh = -Infinity;
    for (let k = i - LOOKBACK; k <= i; k++) if (h[k] > recentHigh) recentHigh = h[k];
    // "drops much faster and further than usual": the close sits dipAtr or more
    // below the recent high, in this instrument's own ATR units.
    if ((recentHigh - c[i]) / atr[i] < dipAtr) continue;
    const entry = o[i + 1];
    const risk = atr[i] * ATR_MULT;
    const res = resolve(bars, i + 1, 1, entry, risk, sym);   // LONG only, as stated
    trades.push({ t: t[i + 1], ...res });
    blockedUntil = i + HOLD_BARS;   // one position at a time
  }
  return trades;
}

function runReversalInTrend(bars, pullbackAtr, sym) {
  const { t, o, h, l, c } = bars;
  const atr = atrSeries(h, l, c, ATR_LEN);
  const ema200 = emaSeries(c, 200);
  const trades = [];
  let blockedUntil = -1;
  for (let i = 200 + LOOKBACK; i < c.length - HOLD_BARS - 2; i++) {
    if (i < blockedUntil || atr[i] === null || ema200[i] === null || !(atr[i] > 0)) continue;
    const up = c[i] > ema200[i];
    let ext = up ? -Infinity : Infinity;
    for (let k = i - LOOKBACK; k <= i; k++) {
      if (up) { if (h[k] > ext) ext = h[k]; }
      else    { if (l[k] < ext) ext = l[k]; }
    }
    // WITH the bigger trend: in an uptrend buy a dip from the recent high, in a
    // downtrend sell a rally from the recent low.
    const move = up ? (ext - c[i]) / atr[i] : (c[i] - ext) / atr[i];
    if (move < pullbackAtr) continue;
    const dir = up ? 1 : -1;
    const entry = o[i + 1];
    const risk = atr[i] * ATR_MULT;
    const res = resolve(bars, i + 1, dir, entry, risk, sym);
    trades.push({ t: t[i + 1], ...res });
    blockedUntil = i + HOLD_BARS;
  }
  return trades;
}

function foldStats(trades) {
  if (!trades.length) return null;
  const sorted = [...trades].sort((a, b) => a.t - b.t);
  const size = Math.floor(sorted.length / FOLDS);
  if (size < 5) return null;
  const perFold = [];
  for (let k = 0; k < FOLDS; k++) {
    const from = k * size;
    const to = (k === FOLDS - 1) ? sorted.length : (k + 1) * size;
    const slice = sorted.slice(from, to);
    const R = slice.reduce((a, x) => a + x.r, 0);
    perFold.push({ fold: k + 1, n: slice.length, R, rpt: R / slice.length });
  }
  const totalR = sorted.reduce((a, x) => a + x.r, 0);
  return {
    n: sorted.length, totalR, rpt: totalR / sorted.length,
    winRate: (sorted.filter(x => x.r > 0).length / sorted.length) * 100,
    worstFold: Math.min(...perFold.map(f => f.rpt)),
    foldsPositive: perFold.filter(f => f.rpt > 0).length,
    perFold,
    exits: sorted.reduce((m, x) => { m[x.exit] = (m[x.exit] || 0) + 1; return m; }, {}),
  };
}

const bars = {};
const missing = [];
for (const s of ASSETS) {
  const b = loadH1(s);
  if (!b) { missing.push(s); continue; }
  bars[s] = b;
}
if (!Object.keys(bars).length) {
  console.error("No H1 bars found.");
  process.exit(1);
}

const TRIALS = DIP_ATRS.length + PULLBACK_ATRS.length;
const rows = [];

for (const d of DIP_ATRS) {
  const all = [];
  for (const sym of Object.keys(bars)) all.push(...runBuyTheDip(bars[sym], d, sym));
  rows.push({ strategy: "1 Buy-the-Dip", param: d + " ATR dip", stats: foldStats(all) });
}
for (const p of PULLBACK_ATRS) {
  const all = [];
  for (const sym of Object.keys(bars)) all.push(...runReversalInTrend(bars[sym], p, sym));
  rows.push({ strategy: "3 Reversal-in-Trend", param: p + " ATR pullback", stats: foldStats(all) });
}

for (const r of rows) {
  if (!r.stats) continue;
  const f = r.stats.perFold.map(x => x.rpt);
  const mean = f.reduce((a, b) => a + b, 0) / f.length;
  const sd = Math.sqrt(f.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, f.length - 1));
  const d = deflatedBar(sd / Math.sqrt(f.length), TRIALS);
  r.bar = d;
  r.clears = !!(d && r.stats.worstFold > d.bar);
}

const out = {
  measuredAt: new Date().toISOString(),
  timeframe: "H1",
  assets: Object.keys(bars),
  missingAssets: missing,
  stated: { stopAtr: ATR_MULT, targetR: TARGET_R, holdBars: HOLD_BARS },
  interpreted: { lookbackBars: LOOKBACK, dipAtrs: DIP_ATRS, pullbackAtrs: PULLBACK_ATRS,
                 trend: "H1 EMA200" },
  params: { costR: COST_R, costBasis: COST_BASIS, basisNote: describeBasis(COST_BASIS), folds: FOLDS, trials: TRIALS },
  rows,
  caveats: [
    "Stops, targets and the one-day exit are STATED in the report and implemented exactly.",
    "Entry TRIGGERS are described in words, not numbers — the ATR thresholds here are MY "
      + "definitions, declared and swept, with the bar deflated for " + TRIALS + " trials.",
    "A result here is evidence about THIS definition on THESE instruments. It is never a "
      + "verdict on their strategy, which runs on UK100.",
    "Entry at the next bar's open; stop/target on bar high/low; both-in-one-bar scored a LOSS.",
  ],
  feedsTheGate: false,
};

if (AS_JSON) {
  const dir = path.join(ROOT, "tasks", "analysis");
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "h1-strategies-backtest.json");
  fs.writeFileSync(p, JSON.stringify(out, null, 2));
  console.log(p);
  process.exit(0);
}

console.log("");
console.log("UK100 BATCH — the two H1 strategies, on BTCUSD / XAUUSD / SP500 H1");
console.log("=".repeat(84));
console.log("  stated and implemented exactly: stop " + ATR_MULT + "xATR · target "
          + TARGET_R + "R · close within " + HOLD_BARS + " bars");
console.log("  cost " + costHeader() + " · " + FOLDS + " folds · bar deflated for " + TRIALS + " trials");
if (missing.length) console.log("  MISSING H1: " + missing.join(", "));
console.log("");
console.log("  " + "strategy".padEnd(22) + "trigger".padEnd(18) + "trades".padEnd(9)
          + "win%".padEnd(8) + "R/trade".padEnd(10) + "totalR".padEnd(10)
          + "worst".padEnd(9) + "folds+".padEnd(8) + "clears?");
for (const r of rows) {
  if (!r.stats) {
    console.log("  " + r.strategy.padEnd(22) + r.param.padEnd(18) + "too few trades");
    continue;
  }
  const s = r.stats;
  console.log("  " + r.strategy.padEnd(22) + r.param.padEnd(18)
    + String(s.n).padEnd(9)
    + s.winRate.toFixed(1).padEnd(8)
    + ((s.rpt >= 0 ? "+" : "") + s.rpt.toFixed(3)).padEnd(10)
    + ((s.totalR >= 0 ? "+" : "") + s.totalR.toFixed(1)).padEnd(10)
    + ((s.worstFold >= 0 ? "+" : "") + s.worstFold.toFixed(3)).padEnd(9)
    + (s.foldsPositive + "/" + FOLDS).padEnd(8)
    + (r.clears ? "YES" : "no"));
}
console.log("");
console.log("  reference — the report's own figures on UK100 H1:");
console.log("    1 Buy-the-Dip Reversion   +0.069R over 984 trades");
console.log("    3 Reversal in Trend       +0.070R over 702 trades");
console.log("");
for (const c of out.caveats) console.log("  · " + c);
console.log("");
