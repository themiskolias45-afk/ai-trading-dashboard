#!/usr/bin/env node
'use strict';
/* ============================================================================
   ema_cross_backtest.cjs — EMA-Cross Momentum on THIS system's instruments
   ============================================================================

   THE RULE, as described in the UK100 batch report (strategy 2, the highest
   expectancy of its three at +0.173R over 385 trades):

     "Pure trend-following on a fast timeframe. When the short average pushes
      through the long one and the trend is clearly pointing one way, it jumps on
      board and rides the move - long in an uptrend, short in a downtrend - and
      stays in until the trend flips."
     "Stop 2.0xATR - aims for 2x the risk - exits when the opposite signal fires."

   That is a fast/slow EMA crossover, LONG and SHORT, stop at 2.0 ATR, target at
   2R, and an exit when the opposite cross fires. It is implemented here exactly as
   written and tested on BTCUSD / XAUUSD / SP500 M15 - the instruments this system
   already trades. NO NEW ASSETS.

   WHY IT COULD NOT BE TESTED BEFORE. M15 was frozen at 2026-07-26 for a month: the
   only writer of tasks/history/*_M15.csv refused while a position was open, and a
   position was almost always open. The bridge now pushes M15, so this is the first
   time an M15 rule can be measured here at all.

   THE PERIODS ARE DECLARED, NOT SEARCHED. The report does not state its EMA
   lengths. Trying many and keeping the best is precisely the multiple-testing trap
   CSCV measured on this project's other axes (ceiling 54%, entry-RSI floor 95%), so
   three standard pairs are fixed up front, ALL of them are reported, and the
   promotion bar is deflated by the trial count using tasks/_deflated_bar.cjs. A
   winner picked from three trials must clear a higher bar than a winner picked from
   one, and this says by how much.

   HONEST MECHANICS, each of which flatters the result if done the other way:
     - Entry is the NEXT bar's OPEN after the cross closes. Entering at the close
       that produced the signal is lookahead.
     - Stop and target are checked against the bar's HIGH and LOW, not its close.
     - A bar that touches BOTH counts as a LOSS. Intrabar order is unknowable and
       the flattering assumption manufactures edge.
     - Costs charged per trade in R, on the same basis the rest of the project uses.

   Read-only. No setting, no gate, no position. feedsTheGate false.

   Usage:
     node tasks/ema_cross_backtest.cjs
     node tasks/ema_cross_backtest.cjs --cost 0.05 --folds 5
     node tasks/ema_cross_backtest.cjs --json
   ============================================================================ */

const path = require("path");
const fs   = require("fs");
const { deflatedBar } = require(path.join(__dirname, "_deflated_bar.cjs"));

const ROOT = path.join(__dirname, "..");

function opt(name, def) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}
const flag = n => process.argv.includes(n);

const COST_R    = Number(opt("--cost", "0.05"));
const FOLDS     = Number(opt("--folds", "5"));
const ATR_MULT  = Number(opt("--atr-mult", "2.0"));   // stop distance, per the rule
const TARGET_R  = Number(opt("--target-r", "2.0"));   // "aims for 2x the risk"
const ATR_LEN   = Number(opt("--atr-len", "14"));
const AS_JSON   = flag("--json");

// Declared in advance. Three conventional pairs, nothing tuned.
const PAIRS = [
  { label: "9/21",  fast: 9,  slow: 21 },
  { label: "12/26", fast: 12, slow: 26 },
  { label: "20/50", fast: 20, slow: 50 },
];

const ASSETS = ["BTCUSD", "XAUUSD", "SP500"];

// ── bars ────────────────────────────────────────────────────────────────────
function loadM15(sym) {
  const p = path.join(ROOT, "tasks", "history", sym + "_M15.csv");
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
  const out = new Array(values.length);
  let seed = 0;
  for (let i = 0; i < period; i++) { seed += values[i]; out[i] = null; }
  out[period - 1] = seed / period;
  for (let i = period; i < values.length; i++) out[i] = values[i] * k + out[i - 1] * (1 - k);
  return out;
}

// Wilder ATR, the same definition the engine's atr() uses.
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

// ── one asset, one pair ─────────────────────────────────────────────────────
function runAsset(bars, pair) {
  const { t, o, h, l, c } = bars;
  const fast = emaSeries(c, pair.fast);
  const slow = emaSeries(c, pair.slow);
  const atr  = atrSeries(h, l, c, ATR_LEN);

  const trades = [];
  let pos = null;   // { dir, entry, stop, target, openedAt }

  const start = Math.max(pair.slow, ATR_LEN) + 2;
  for (let i = start; i < c.length - 1; i++) {
    if (fast[i] === null || slow[i] === null || fast[i - 1] === null || atr[i] === null) continue;

    const crossedUp   = fast[i - 1] <= slow[i - 1] && fast[i] > slow[i];
    const crossedDown = fast[i - 1] >= slow[i - 1] && fast[i] < slow[i];

    // Manage an open position on THIS bar before considering a new signal.
    if (pos) {
      const hi = h[i], lo = l[i];
      const hitStop   = pos.dir === 1 ? lo <= pos.stop   : hi >= pos.stop;
      const hitTarget = pos.dir === 1 ? hi >= pos.target : lo <= pos.target;

      if (hitStop && hitTarget) {
        // Both touched in one bar. Intrabar order is unknowable, so it is a LOSS -
        // assuming the target came first is how backtests invent edge.
        trades.push({ t: t[pos.openedAt], r: -1 - COST_R, exit: "BOTH_IN_BAR" });
        pos = null;
      } else if (hitStop) {
        trades.push({ t: t[pos.openedAt], r: -1 - COST_R, exit: "STOP" });
        pos = null;
      } else if (hitTarget) {
        trades.push({ t: t[pos.openedAt], r: TARGET_R - COST_R, exit: "TARGET" });
        pos = null;
      } else if ((pos.dir === 1 && crossedDown) || (pos.dir === -1 && crossedUp)) {
        // "stays in until the trend flips" - exit at the NEXT open, not this close.
        const px = o[i + 1];
        const r = pos.dir === 1 ? (px - pos.entry) / pos.risk : (pos.entry - px) / pos.risk;
        trades.push({ t: t[pos.openedAt], r: r - COST_R, exit: "FLIP" });
        pos = null;
      }
    }

    if (!pos && (crossedUp || crossedDown)) {
      const dir = crossedUp ? 1 : -1;
      const entry = o[i + 1];                 // NEXT bar's open. Never this close.
      const risk = atr[i] * ATR_MULT;
      if (!(risk > 0)) continue;
      pos = {
        dir, entry, risk,
        stop:   dir === 1 ? entry - risk : entry + risk,
        target: dir === 1 ? entry + risk * TARGET_R : entry - risk * TARGET_R,
        openedAt: i + 1,
      };
    }
  }
  return trades;
}

// ── folds ───────────────────────────────────────────────────────────────────
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
    perFold.push({
      fold: k + 1, n: slice.length, R,
      rpt: R / slice.length,
      wins: slice.filter(x => x.r > 0).length,
      from: new Date(slice[0].t * 1000).toISOString().slice(0, 10),
      to: new Date(slice[slice.length - 1].t * 1000).toISOString().slice(0, 10),
    });
  }
  const totalR = sorted.reduce((a, x) => a + x.r, 0);
  return {
    n: sorted.length, totalR, rpt: totalR / sorted.length,
    winRate: (sorted.filter(x => x.r > 0).length / sorted.length) * 100,
    perFold,
    worstFold: Math.min(...perFold.map(f => f.rpt)),
    foldsPositive: perFold.filter(f => f.rpt > 0).length,
    exits: sorted.reduce((m, x) => { m[x.exit] = (m[x.exit] || 0) + 1; return m; }, {}),
  };
}

// ── main ────────────────────────────────────────────────────────────────────
const bars = {};
const missing = [];
for (const s of ASSETS) {
  const b = loadM15(s);
  if (!b) { missing.push(s); continue; }
  bars[s] = b;
}
if (!Object.keys(bars).length) {
  console.error("No M15 bars found. Run tasks/topup_bars_from_bridge.cjs --execute first.");
  process.exit(1);
}

const results = [];
for (const pair of PAIRS) {
  const all = [];
  const per = {};
  for (const sym of Object.keys(bars)) {
    const tr = runAsset(bars[sym], pair);
    per[sym] = tr.length;
    all.push(...tr);
  }
  const st = foldStats(all);
  results.push({ pair: pair.label, fast: pair.fast, slow: pair.slow, perAsset: per, stats: st });
}

// The bar a pair must clear: the standard error of its OWN per-fold results,
// deflated for having tried PAIRS.length of them. Same instrument as the strategy
// searcher uses, for the same reason - best-of-three is a different claim from
// best-of-one and the bar has to know which.
const scored = results.filter(r => r.stats);
for (const r of scored) {
  const f = r.stats.perFold.map(x => x.rpt);
  const mean = f.reduce((a, b) => a + b, 0) / f.length;
  const sd = Math.sqrt(f.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, f.length - 1));
  const se = sd / Math.sqrt(f.length);
  const d = deflatedBar(se, PAIRS.length);
  r.bar = d;
  // A pair is only interesting if its WORST fold clears the deflated bar above zero.
  r.clears = !!(d && r.stats.worstFold > d.bar);
}

const out = {
  measuredAt: new Date().toISOString(),
  rule: "EMA cross, long+short, stop " + ATR_MULT + "xATR, target " + TARGET_R
      + "R, exit on opposite cross",
  timeframe: "M15",
  assets: Object.keys(bars),
  missingAssets: missing,
  params: { costR: COST_R, folds: FOLDS, atrLen: ATR_LEN, atrMult: ATR_MULT, targetR: TARGET_R },
  pairsTested: PAIRS.length,
  results,
  caveats: [
    "Entry is the NEXT bar's open after the cross closes — entering at the signal close is lookahead.",
    "Stop and target checked against the bar HIGH and LOW; a bar touching both is scored a LOSS.",
    "Costs " + COST_R + "R/trade. No slippage model, no spread per instrument, no margin model.",
    "Three EMA pairs declared in advance and ALL reported. The bar is deflated for 3 trials.",
    "M15 bars only became current on 2026-08-25 — before that they were a month stale.",
  ],
  feedsTheGate: false,
};

if (AS_JSON) {
  const dir = path.join(ROOT, "tasks", "analysis");
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "ema-cross-backtest.json");
  fs.writeFileSync(p, JSON.stringify(out, null, 2));
  console.log(p);
  process.exit(0);
}

console.log("");
console.log("EMA-CROSS MOMENTUM on M15 — BTCUSD / XAUUSD / SP500");
console.log("=".repeat(80));
console.log("  " + out.rule);
console.log("  cost " + COST_R + "R/trade · " + FOLDS + " sequential folds · judged on WORST FOLD");
if (missing.length) console.log("  MISSING M15: " + missing.join(", "));
console.log("");
console.log("  " + "pair".padEnd(8) + "trades".padEnd(9) + "win%".padEnd(8)
          + "R/trade".padEnd(10) + "totalR".padEnd(10) + "worst fold".padEnd(13)
          + "folds+".padEnd(9) + "bar".padEnd(9) + "clears?");
for (const r of results) {
  if (!r.stats) { console.log("  " + r.pair.padEnd(8) + "too few trades to fold"); continue; }
  const s = r.stats;
  console.log("  " + r.pair.padEnd(8)
    + String(s.n).padEnd(9)
    + s.winRate.toFixed(1).padEnd(8)
    + ((s.rpt >= 0 ? "+" : "") + s.rpt.toFixed(3)).padEnd(10)
    + ((s.totalR >= 0 ? "+" : "") + s.totalR.toFixed(1)).padEnd(10)
    + ((s.worstFold >= 0 ? "+" : "") + s.worstFold.toFixed(3)).padEnd(13)
    + (s.foldsPositive + "/" + FOLDS).padEnd(9)
    + (r.bar ? r.bar.bar.toFixed(3) : "—").padEnd(9)
    + (r.clears ? "YES" : "no"));
}
console.log("");
for (const r of results) {
  if (!r.stats) continue;
  console.log("  " + r.pair + "  per asset: "
    + Object.entries(r.perAsset).map(([k, v]) => k + " " + v).join(", ")
    + "   exits: " + Object.entries(r.stats.exits).map(([k, v]) => k + " " + v).join(", "));
}
console.log("");
if (scored.length && scored[0].bar) {
  console.log("  The bar is each pair's own per-fold standard error x "
    + scored[0].bar.multiple.toFixed(2) + ", deflated for " + PAIRS.length + " trials.");
}
console.log("");
for (const c of out.caveats) console.log("  · " + c);
console.log("");
