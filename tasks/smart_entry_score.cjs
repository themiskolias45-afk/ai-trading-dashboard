#!/usr/bin/env node
'use strict';
/**
 * THE SMART ENTRY SCORE -- measured before it is believed.
 *
 * The proposed architecture is a hierarchy, not five equal strategies:
 *
 *   HTF bias -> liquidity -> CRT -> displacement -> FVG -> structure -> EMA -> session
 *
 * scored out of 100 and bucketed A+ / A / B / no-trade. This harness BUILDS that score
 * and then asks the only question that decides whether it is worth having:
 *
 *   DOES A HIGHER SCORE ACTUALLY PRODUCE A HIGHER R?
 *
 * If R rises with the bucket, the weighting is carrying information and the engine can
 * use it. If it does not, the weights are decoration -- nine numbers that feel right and
 * predict nothing -- and shipping them would be exactly how this repo accumulated 514
 * signal-path commits against 7 closed trades. Nothing here is wired into the engine and
 * the report says so on every row.
 *
 *   node tasks/smart_entry_score.cjs [--bias h4] [--exec m15] [--hold 960] [--maxrr 5]
 *                                    [--symbols XAUUSD,BTCUSD,SP500] [--folds 5]
 *
 * THE ENTRY MODEL is the one already measured in tasks/crt_fvg_strategy.cjs: CRT sweep
 * and reclaim on the bias timeframe, same-direction FVG on the execution timeframe after
 * the sweep is KNOWN, entry on the retest at the near edge, stop beyond the sweep
 * extreme, target the opposite side of the swept range capped at --maxrr. That model
 * scores +0.058R against a matched control of -0.275R. The score does not change which
 * trades are taken -- it RANKS them, so the buckets are a partition of one population and
 * cannot be confounded by a different trade list.
 *
 * COMPONENTS, and the weights as proposed (they are inputs to this test, not conclusions):
 *
 *   HTF bias            15   EMA50/200 alignment on the bias timeframe, direction-matched
 *   Liquidity alignment 15   the swept side is the side that feeds the HTF direction
 *   CRT structure       15   sweep size against the instrument's own average bar range
 *   Displacement        15   the reclaim leg's range against ATR -- the impulse, not a drift
 *   FVG quality         10   gap height in average ranges
 *   Market structure    10   HH/HL for longs, LH/LL for shorts, on the bias timeframe
 *   EMA alignment       10   price vs EMA21/50 on the execution timeframe at entry
 *   Session quality      5   London and NY hours, from the bar's own UTC timestamp
 *   Volatility regime    5   ATR inside a workable band -- not dead, not a news spike
 *
 * EVERY COMPONENT IS POINT-IN-TIME. Each is computed from bars up to and including the
 * ENTRY bar and never beyond it. An indicator that peeks one bar ahead produces a
 * beautiful monotonic table and a worthless engine.
 *
 * READ-ONLY. Broker CSVs in, a report in tasks/analysis out. No gate, threshold, setting,
 * position or learning file is touched. feedsTheGate is false.
 */

const fs   = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const { detectCRT }  = require(path.join(ROOT, "server", "structure.js"));
const { detectFVGs } = require(path.join(ROOT, "server", "fvg.js"));

const TF_SECONDS = { d1: 86400, h4: 14400, h1: 3600, m15: 900 };
const TF_FILE    = { d1: "D1", h4: "H4", h1: "H1", m15: "M15" };

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

const BIAS_TF     = strArg("--bias", "h4").toLowerCase();
const EXEC_TF     = strArg("--exec", "m15").toLowerCase();
const MAX_HOLD    = numArg("--hold", 960);
const MAX_RR      = numArg("--maxrr", 5);
const FOLDS       = Math.max(2, numArg("--folds", 5));
const WINDOW      = numArg("--window", 100);
const EXEC_WINDOW = numArg("--execwindow", 60);
const SEARCH      = numArg("--search", 40);
const RETEST      = numArg("--retest", 40);
const SYMBOLS     = strArg("--symbols", "XAUUSD,BTCUSD,SP500").split(",").map(s => s.trim());

// --profile proposed : the weights exactly as specified. Kept so the comparison is
//                      reproducible and so nobody has to take "it did not separate" on
//                      trust -- run it and see the A+ bucket come out below no-trade.
// --profile measured : re-weighted onto the components that showed a POSITIVE measured
//                      lift on this population, in proportion to that lift.
//
// The proposed weights failed for a specific and fixable reason, not because the idea is
// wrong. Measured 2026-09-02 over 790 entries:
//
//   emaAlignment    full +0.0087  zero -0.0948   lift +0.1035
//   htfBias         full +0.0999  zero +0.0017   lift +0.0981
//   marketStructure full +0.0558  zero +0.0434   lift +0.0124
//   session         full +0.0789  zero +0.0866   lift -0.0078   <- costs points
//   liquidity, crtStructure, displacement, fvgQuality, volatility
//                   NEVER score zero on this population
//
// That last line is the whole failure. Those five are conditions of the entry model
// itself -- every trade here already IS a CRT sweep with an FVG retest -- so they add 55
// near-constant points and drown the two components that actually discriminate. A score
// where 55% of the points are the same for every candidate cannot rank candidates.
const PROFILES = {
  proposed: {
    htfBias: 15, liquidity: 15, crtStructure: 15, displacement: 15,
    fvgQuality: 10, marketStructure: 10, emaAlignment: 10, session: 5, volatility: 5,
  },
  measured: {
    emaAlignment: 45, htfBias: 42, marketStructure: 13,
    liquidity: 0, crtStructure: 0, displacement: 0, fvgQuality: 0, session: 0, volatility: 0,
  },
};
const PROFILE = PROFILES[strArg("--profile", "proposed")] ? strArg("--profile", "proposed") : "proposed";
const WEIGHTS = PROFILES[PROFILE];

function loadBars(symbol, tf) {
  const file = path.join(ROOT, "tasks", "history", symbol + "_" + TF_FILE[tf] + ".csv");
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  lines.shift();
  const times = [], highs = [], lows = [], closes = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const p = line.split(",");
    if (p.length < 5) continue;
    const t = Number(p[0]), h = Number(p[2]), l = Number(p[3]), c = Number(p[4]);
    if (!(Number.isFinite(t) && Number.isFinite(h) && Number.isFinite(l) && Number.isFinite(c))) continue;
    times.push(t); highs.push(h); lows.push(l); closes.push(c);
  }
  return { times, highs, lows, closes };
}

function sliceBars(bars, from, to) {
  return {
    highs:  bars.highs.slice(from, to),
    lows:   bars.lows.slice(from, to),
    closes: bars.closes.slice(from, to),
    times:  bars.times.slice(from, to),
  };
}

// EMA over the closes ENDING at endIdx. Seeded with the simple mean of the first period
// so a short series cannot inherit a value from bars that do not exist.
function emaAt(closes, endIdx, period) {
  const start = endIdx - period * 3;
  const from = Math.max(0, start);
  if (endIdx - from < period) return null;
  let ema = 0;
  for (let i = from; i < from + period; i++) ema += closes[i];
  ema /= period;
  const k = 2 / (period + 1);
  for (let i = from + period; i <= endIdx; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

function atrAt(highs, lows, closes, endIdx, period) {
  if (endIdx < period) return null;
  let sum = 0;
  for (let i = endIdx - period + 1; i <= endIdx; i++) {
    const prevClose = closes[i - 1];
    const tr = Math.max(highs[i] - lows[i],
      Math.abs(highs[i] - prevClose), Math.abs(lows[i] - prevClose));
    sum += tr;
  }
  return sum / period;
}

/**
 * Score one candidate. `biasIdx` is the bias bar the CRT completed on; `entryIdx` is the
 * execution bar the retest filled on. Nothing beyond either index is read.
 */
function scoreEntry(bias, exec, biasIdx, entryIdx, crt, zone, direction) {
  const parts = {};
  const bull = direction === "bullish";

  // HTF BIAS -- EMA50/200 on the bias timeframe, and price on the right side of both.
  const ema50  = emaAt(bias.closes, biasIdx, 50);
  const ema200 = emaAt(bias.closes, biasIdx, 200);
  const price  = bias.closes[biasIdx];
  if (ema50 === null || ema200 === null) parts.htfBias = 0;
  else {
    const aligned = bull ? (ema50 > ema200 && price > ema50) : (ema50 < ema200 && price < ema50);
    const half    = bull ? (price > ema50 || ema50 > ema200) : (price < ema50 || ema50 < ema200);
    parts.htfBias = aligned ? WEIGHTS.htfBias : (half ? WEIGHTS.htfBias * 0.4 : 0);
  }

  // LIQUIDITY ALIGNMENT -- a bullish setup should have swept the LOW (sell-side liquidity)
  // and a bearish one the HIGH. detectCRT already enforces the pairing, so the score comes
  // from the sweep being CONFIRMED and from its size relative to the range it swept.
  const sweepFrac = crt.rangeSize > 0 ? crt.sweepDistance / crt.rangeSize : 0;
  parts.liquidity = crt.confirmed
    ? WEIGHTS.liquidity * Math.min(1, 0.5 + sweepFrac * 2)
    : WEIGHTS.liquidity * 0.3;

  // CRT STRUCTURE -- sweep distance in average bar ranges. A one-tick poke is not a grab.
  const inRanges = Number.isFinite(crt.sweepDistanceInRanges) ? crt.sweepDistanceInRanges : 0;
  parts.crtStructure = WEIGHTS.crtStructure * Math.max(0, Math.min(1, inRanges / 0.5));

  // DISPLACEMENT -- the reclaim leg's true range against ATR on the bias timeframe. This
  // is the component that separates an impulsive reclaim from a drift back inside.
  const atr = atrAt(bias.highs, bias.lows, bias.closes, biasIdx, 14);
  const legRange = bias.highs[biasIdx] - bias.lows[biasIdx];
  parts.displacement = (atr && atr > 0)
    ? WEIGHTS.displacement * Math.max(0, Math.min(1, (legRange / atr) / 1.5)) : 0;

  // FVG QUALITY -- gap height in average ranges of the execution timeframe.
  const h = Number.isFinite(zone.heightInRanges) ? zone.heightInRanges : 0;
  parts.fvgQuality = WEIGHTS.fvgQuality * Math.max(0, Math.min(1, h / 0.6));

  // MARKET STRUCTURE -- HH/HL for longs, LH/LL for shorts, over the last 20 bias bars,
  // compared against the 20 before them.
  const recentFrom = Math.max(0, biasIdx - 19);
  const priorFrom  = Math.max(0, biasIdx - 39);
  const maxOf = (arr, a, b) => Math.max.apply(null, arr.slice(a, b));
  const minOf = (arr, a, b) => Math.min.apply(null, arr.slice(a, b));
  if (priorFrom < recentFrom) {
    const recentHigh = maxOf(bias.highs, recentFrom, biasIdx + 1);
    const recentLow  = minOf(bias.lows,  recentFrom, biasIdx + 1);
    const priorHigh  = maxOf(bias.highs, priorFrom, recentFrom);
    const priorLow   = minOf(bias.lows,  priorFrom, recentFrom);
    const trending = bull ? (recentHigh > priorHigh && recentLow > priorLow)
                          : (recentHigh < priorHigh && recentLow < priorLow);
    const half     = bull ? (recentHigh > priorHigh || recentLow > priorLow)
                          : (recentHigh < priorHigh || recentLow < priorLow);
    parts.marketStructure = trending ? WEIGHTS.marketStructure
                          : (half ? WEIGHTS.marketStructure * 0.4 : 0);
  } else parts.marketStructure = 0;

  // EMA ALIGNMENT on the EXECUTION timeframe at the entry bar -- confirmation only, which
  // is the whole point: it never generates the setup, it grades it.
  const e21 = emaAt(exec.closes, entryIdx, 21);
  const e50 = emaAt(exec.closes, entryIdx, 50);
  if (e21 === null || e50 === null) parts.emaAlignment = 0;
  else {
    const aligned = bull ? e21 > e50 : e21 < e50;
    const reclaim = bull ? exec.closes[entryIdx] > e21 : exec.closes[entryIdx] < e21;
    parts.emaAlignment = (aligned ? WEIGHTS.emaAlignment * 0.6 : 0)
                       + (reclaim ? WEIGHTS.emaAlignment * 0.4 : 0);
  }

  // SESSION -- London 07-16 UTC and New York 12-21 UTC, full marks on the overlap.
  const hour = new Date(exec.times[entryIdx] * 1000).getUTCHours();
  const london = hour >= 7 && hour < 16;
  const ny     = hour >= 12 && hour < 21;
  parts.session = (london && ny) ? WEIGHTS.session
                : (london || ny) ? WEIGHTS.session * 0.6 : 0;

  // VOLATILITY REGIME -- exec ATR as a fraction of price, full marks inside a workable
  // band. Dead tape cannot reach a target; a news spike is not a setup, it is a hazard.
  const eAtr = atrAt(exec.highs, exec.lows, exec.closes, entryIdx, 14);
  const pxNow = exec.closes[entryIdx];
  if (!eAtr || !pxNow) parts.volatility = 0;
  else {
    const pct = (eAtr / pxNow) * 100;
    parts.volatility = (pct >= 0.03 && pct <= 0.5) ? WEIGHTS.volatility
                     : (pct > 0.5 && pct <= 1.0)   ? WEIGHTS.volatility * 0.5 : 0;
  }

  const total = Object.values(parts).reduce((a, v) => a + v, 0);
  return { total, parts };
}

function resolveTrade(exec, entryIdx, direction, entry, stop, target, holdBars) {
  const limit = Math.min(entryIdx + holdBars, exec.highs.length - 1);
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return null;
  for (let i = entryIdx + 1; i <= limit; i++) {
    const hitStop   = direction === "bullish" ? exec.lows[i] <= stop   : exec.highs[i] >= stop;
    const hitTarget = direction === "bullish" ? exec.highs[i] >= target : exec.lows[i] <= target;
    if (hitStop) return { outcome: "LOSS", r: -1 };
    if (hitTarget) return { outcome: "WIN", r: Math.abs(target - entry) / risk };
  }
  const move = direction === "bullish" ? exec.closes[limit] - entry : entry - exec.closes[limit];
  return { outcome: "OPEN", r: move / risk };
}

function collect(symbol) {
  const bias = loadBars(symbol, BIAS_TF);
  const exec = loadBars(symbol, EXEC_TF);
  if (!bias || !exec) return { symbol, error: "missing archive" };
  const biasSec = TF_SECONDS[BIAS_TF];
  const trades = [];
  let execCursor = 0;
  const execAtOrAfter = (t) => {
    while (execCursor < exec.times.length && exec.times[execCursor] < t) execCursor++;
    return execCursor < exec.times.length ? execCursor : -1;
  };

  for (let b = WINDOW; b < bias.times.length; b++) {
    const found = detectCRT(sliceBars(bias, b - WINDOW + 1, b + 1), { maxPatterns: 5 });
    const crt = found && found.patterns ? found.patterns.find(p => p.barsAgo === 0) : null;
    if (!crt) continue;
    const start = execAtOrAfter(bias.times[b] + biasSec);
    if (start === -1 || start + EXEC_WINDOW >= exec.times.length) continue;
    const direction = crt.direction === "bearish" ? "bearish" : "bullish";

    let zone = null, zoneIdx = -1;
    const searchEnd = Math.min(start + EXEC_WINDOW + SEARCH, exec.times.length);
    for (let j = start + EXEC_WINDOW; j < searchEnd; j++) {
      const fvg = detectFVGs(sliceBars(exec, j - EXEC_WINDOW + 1, j + 1),
        { maxZones: 6, includeFilled: true });
      const fresh = fvg && fvg.zones ? fvg.zones.find(z => z.barsAgo === 0 && z.direction === direction) : null;
      if (fresh) { zone = fresh; zoneIdx = j; break; }
    }
    if (!zone) continue;

    const entryPrice = direction === "bullish" ? zone.top : zone.bottom;
    let entryIdx = -1;
    const retestEnd = Math.min(zoneIdx + 1 + RETEST, exec.times.length);
    for (let k = zoneIdx + 1; k < retestEnd; k++) {
      const touched = direction === "bullish" ? exec.lows[k] <= entryPrice : exec.highs[k] >= entryPrice;
      if (touched) { entryIdx = k; break; }
    }
    if (entryIdx === -1) continue;

    const stop = crt.invalidation;
    let target = crt.objective;
    const ok = direction === "bullish" ? (stop < entryPrice && target > entryPrice)
                                       : (stop > entryPrice && target < entryPrice);
    if (!ok) continue;
    const risk = Math.abs(entryPrice - stop);
    if (MAX_RR > 0 && Math.abs(target - entryPrice) > MAX_RR * risk) {
      target = direction === "bullish" ? entryPrice + MAX_RR * risk : entryPrice - MAX_RR * risk;
    }

    const res = resolveTrade(exec, entryIdx, direction, entryPrice, stop, target, MAX_HOLD);
    if (!res) continue;
    const scored = scoreEntry(bias, exec, b, entryIdx, crt, zone, direction);
    trades.push({ symbol, r: res.r, outcome: res.outcome, score: scored.total,
      parts: scored.parts, entryTime: exec.times[entryIdx] });
  }
  return { symbol, trades };
}

const BUCKETS = [
  { name: "A+  85-100", min: 85, max: 101 },
  { name: "A   75-84",  min: 75, max: 85 },
  { name: "B   65-74",  min: 65, max: 75 },
  { name: "no  <65",    min: -1, max: 65 },
];

function stat(trades) {
  if (!trades.length) return { n: 0, wr: 0, rpt: 0, netR: 0 };
  const wins = trades.filter(t => t.r > 0).length;
  const netR = trades.reduce((a, t) => a + t.r, 0);
  return { n: trades.length, wr: (wins / trades.length) * 100, rpt: netR / trades.length, netR };
}

const lines = [];
const say = (s) => { lines.push(s); console.log(s); };
const pad = (v, w) => String(v).padEnd(w);
const num = (v, d) => Number.isFinite(v) ? (v >= 0 ? "+" : "") + v.toFixed(d) : "-";

say("=".repeat(104));
say("  SMART ENTRY SCORE  --  does a higher score actually produce a higher R?");
say("  " + new Date().toISOString());
say("  weighting profile: " + PROFILE.toUpperCase());
say("  entry model: CRT sweep -> same-direction FVG -> retest | bias " + BIAS_TF
  + " exec " + EXEC_TF + " hold " + MAX_HOLD + " maxRR " + MAX_RR);
say("  The score RANKS one population of trades. It admits nothing and blocks nothing here.");
say("=".repeat(104));

const all = [];
for (const symbol of SYMBOLS) {
  const out = collect(symbol);
  if (out.error) { say("  " + symbol + ": " + out.error); continue; }
  all.push(...out.trades);
  say("  " + pad(symbol, 9) + out.trades.length + " scored entries");
}

say("");
say("  " + pad("bucket", 14) + pad("n", 8) + pad("WR%", 9) + pad("R/trade", 11) + pad("netR", 11) + "share");
for (const b of BUCKETS) {
  const rows = all.filter(t => t.score >= b.min && t.score < b.max);
  const s = stat(rows);
  say("  " + pad(b.name, 14) + pad(s.n, 8) + pad(s.n ? s.wr.toFixed(1) : "-", 9)
    + pad(s.n ? num(s.rpt, 4) : "-", 11) + pad(s.n ? num(s.netR, 2) : "-", 11)
    + (all.length ? ((s.n / all.length) * 100).toFixed(1) + "%" : "-"));
}
const overall = stat(all);
say("  " + "-".repeat(96));
say("  " + pad("ALL", 14) + pad(overall.n, 8) + pad(overall.wr.toFixed(1), 9)
  + pad(num(overall.rpt, 4), 11) + pad(num(overall.netR, 2), 11));

// FOLD STABILITY OF EACH BUCKET. A bucket that is negative in one fold and positive in
// four is a regime, not a filter. A bucket negative in FIVE of five is a signal with its
// sign flipped, and that is usable -- it is the difference between "do not trust the
// score" and "invert it". Folds are chronological and equal-count WITHIN the bucket, so
// each fold answers the same question at a different time.
say("");
say("  FOLD STABILITY  --  R/trade per chronological fifth, within each bucket");
say("  " + pad("bucket", 14) + pad("n", 7) + Array.from({ length: FOLDS },
  (_, i) => pad("fold" + (i + 1), 11)).join("") + "neg folds");
for (const b of BUCKETS) {
  const rows = all.filter(t => t.score >= b.min && t.score < b.max)
    .sort((x, y) => x.entryTime - y.entryTime);
  const size = Math.floor(rows.length / FOLDS);
  if (size < 3) {
    say("  " + pad(b.name, 14) + pad(rows.length, 7) + "fewer than 3 per fold - not foldable");
    continue;
  }
  const fr = [];
  for (let k = 0; k < FOLDS; k++) {
    fr.push(stat(rows.slice(k * size, k === FOLDS - 1 ? rows.length : (k + 1) * size)).rpt);
  }
  say("  " + pad(b.name, 14) + pad(rows.length, 7)
    + fr.map(v => pad(num(v, 4), 11)).join("")
    + fr.filter(v => v < 0).length + "/" + FOLDS);
}

// MONOTONICITY IS THE VERDICT. A score whose top bucket does not beat its bottom bucket
// is a number that feels right and predicts nothing, and shipping it would be the exact
// failure this repo has already paid for.
const top = stat(all.filter(t => t.score >= 75));
const bottom = stat(all.filter(t => t.score < 65));
say("");
if (top.n >= 20 && bottom.n >= 20) {
  const spread = top.rpt - bottom.rpt;
  say("  A-and-above (" + top.n + " trades) " + num(top.rpt, 4)
    + "   vs   below-65 (" + bottom.n + " trades) " + num(bottom.rpt, 4)
    + "   SPREAD " + num(spread, 4));
  say(spread > 0.05
    ? "  VERDICT: the score SEPARATES. Higher-scoring setups really do pay more."
    : (spread > 0
      ? "  VERDICT: separation is positive but small -- inside what one fold can move."
      : "  VERDICT: the score does NOT separate. The weights are decoration as they stand."));
} else {
  say("  VERDICT: too few trades in the top or bottom bucket to judge separation.");
}

// Per-component: does each one, on its own, mark better trades? This is what tells you
// WHICH weights to change rather than that the total is wrong.
say("");
say("  COMPONENT CHECK -- R/trade when the component scores full marks vs when it scores zero");
say("  " + pad("component", 20) + pad("full n", 9) + pad("full R", 11) + pad("zero n", 9)
  + pad("zero R", 11) + "lift");
for (const key of Object.keys(WEIGHTS)) {
  const full = all.filter(t => t.parts[key] >= WEIGHTS[key] * 0.999);
  const zero = all.filter(t => t.parts[key] <= 0.001);
  if (full.length < 10 || zero.length < 10) {
    say("  " + pad(key, 20) + pad(full.length, 9) + pad("-", 11) + pad(zero.length, 9) + pad("-", 11) + "too few");
    continue;
  }
  const f = stat(full), z = stat(zero);
  say("  " + pad(key, 20) + pad(f.n, 9) + pad(num(f.rpt, 4), 11) + pad(z.n, 9)
    + pad(num(z.rpt, 4), 11) + num(f.rpt - z.rpt, 4));
}

say("");
say("  A component with a NEGATIVE lift is costing points to setups that do better without it.");
say("  Nothing here is wired into the engine. feedsTheGate: false.");

try {
  const outDir = path.join(ROOT, "tasks", "analysis");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "smart-entry-score.txt"), lines.join("\n") + "\n");
  say("");
  say("  written to tasks/analysis/smart-entry-score.txt");
} catch (e) { console.error("  report not written: " + e.message); }
