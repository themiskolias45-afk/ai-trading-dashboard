#!/usr/bin/env node
'use strict';
/**
 * THE CRT->FVG STRATEGY, AS ACTUALLY DESCRIBED -- measured end to end.
 *
 * Every CRT number in this repo so far measured CRT ALONE (entry at the pattern bar) or
 * CRT as a confidence contributor. The strategy people actually trade is a CONJUNCTION:
 *
 *   1. LIQUIDITY GRAB   a candle sweeps the prior range extreme and closes back inside
 *   2. CONFIRMATION     the next candle closes in the reclaim direction
 *                       (1 and 2 are exactly what detectCRT already requires)
 *   3. FVG              on the EXECUTION timeframe, a same-direction fair value gap
 *                       forms AFTER the sweep is known
 *   4. ENTRY            price retraces into that gap -- filled at the near edge
 *   5. STOP             beyond the sweep extreme (the pattern's own invalidation)
 *   6. TARGET           the opposite side of the swept range (the pattern's objective)
 *
 * Nobody had measured 3 and 4. That is the whole point of the strategy: the FVG is what
 * turns "the sweep happened" into an entry PRICE, and entering on a retracement rather
 * than at the pattern bar changes BOTH the stop distance and the R:R of every trade.
 *
 *   node tasks/crt_fvg_strategy.cjs [--bias h4] [--exec m15] [--hold 960] [--folds 5]
 *                                   [--search 40] [--symbols XAUUSD,BTCUSD,SP500]
 *
 * BROKER BARS ONLY, from tasks/history/<SYMBOL>_<TF>.csv. Yahoo caps 15m at ~60 days and
 * 948f21e measured the same index at +0.020R on Yahoo against -0.525R on broker bars over
 * an identical window: a 15m verdict from Yahoo is a verdict about Yahoo.
 *
 * -- THE THREE RULES THAT KEEP IT HONEST --------------------------------------------
 *
 * 1. DETECTION IS POINT-IN-TIME. detectCRT and detectFVGs both scale their thresholds
 *    off the average range of the bars handed to them, so one pass over the whole series
 *    would score a 2022 pattern with 2026 volatility. Both are re-run on a trailing
 *    window ending at each bar, and a pattern counts ONLY if it completes on that final
 *    bar (barsAgo === 0).
 * 2. THE JOIN IS AS-OF, ON CLOSE TIMES. Bar times are OPEN times. A bias bar opening at
 *    t is not known until t + tfSeconds. The FVG search may only begin at the first exec
 *    bar opening at or after that close. _replay_mtf.cjs had a look-ahead bug at exactly
 *    this line once, by comparing open times.
 * 3. AMBIGUITY RESOLVES AS A LOSS. If one exec bar contains both the stop and the target
 *    there is no way to know which came first, and assuming the good one is how a
 *    backtest flatters itself.
 *
 * THE CONTROL is the part that decides anything. Each real trade is paired with a trade
 * of the SAME direction and the SAME stop/target distances entered at an unrelated
 * earlier bar. If the pattern trades and their controls score the same, the conjunction
 * is doing nothing and the win rate is just the geometry of a wide target.
 *
 * READ-ONLY. Reads CSVs, writes a report to tasks/analysis. Touches no gate, no setting,
 * no position, no learning file. Nothing here can affect trading.
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
const FOLDS       = Math.max(2, numArg("--folds", 5));
const WINDOW      = numArg("--window", 100);
const EXEC_WINDOW = numArg("--execwindow", 60);
const SEARCH      = numArg("--search", 40);
const RETEST      = numArg("--retest", 40);
const CONTROL_OFFSET = numArg("--controloffset", 137);
const SYMBOLS     = strArg("--symbols", "XAUUSD,BTCUSD,SP500").split(",").map(s => s.trim());

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
    // A malformed row is dropped WITH its timestamp. Substituting a value would make an
    // invented bar indistinguishable from a real one everywhere downstream.
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

function resolveTrade(exec, entryIdx, direction, entry, stop, target, holdBars) {
  const limit = Math.min(entryIdx + holdBars, exec.highs.length - 1);
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return null;
  for (let i = entryIdx + 1; i <= limit; i++) {
    const hi = exec.highs[i], lo = exec.lows[i];
    const hitStop   = direction === "bullish" ? lo <= stop   : hi >= stop;
    const hitTarget = direction === "bullish" ? hi >= target : lo <= target;
    // Stop first, deliberately: one bar holding both is unresolvable and the pessimistic
    // reading is the only one that cannot flatter the result.
    if (hitStop) return { outcome: "LOSS", r: -1, bars: i - entryIdx };
    if (hitTarget) return { outcome: "WIN", r: Math.abs(target - entry) / risk, bars: i - entryIdx };
  }
  // Unresolved at the horizon is MARKED TO MARKET, never scored as a flat scratch.
  // Truncating to zero is exactly the bias that made every verdict in this repo read
  // low -- see the HORIZON WARNING in tasks/_replay_mtf.cjs.
  const last = exec.closes[limit];
  const move = direction === "bullish" ? last - entry : entry - last;
  return { outcome: "OPEN", r: move / risk, bars: limit - entryIdx };
}

function stats(trades) {
  if (!trades.length) return { n: 0, wr: 0, rpt: 0, netR: 0 };
  const wins = trades.filter(t => t.r > 0).length;
  const netR = trades.reduce((a, t) => a + t.r, 0);
  return { n: trades.length, wr: (wins / trades.length) * 100, rpt: netR / trades.length, netR };
}

function foldStats(trades, n) {
  const sorted = [...trades].sort((a, b) => a.entryTime - b.entryTime);
  const size = Math.floor(sorted.length / n);
  if (size < 5) return null;
  const out = [];
  for (let k = 0; k < n; k++) {
    const slice = sorted.slice(k * size, k === n - 1 ? sorted.length : (k + 1) * size);
    out.push(stats(slice).rpt);
  }
  return out;
}

function run(symbol) {
  const bias = loadBars(symbol, BIAS_TF);
  const exec = loadBars(symbol, EXEC_TF);
  if (!bias || !exec) return { symbol, error: "missing " + BIAS_TF + " or " + EXEC_TF + " archive" };
  if (bias.times.length < WINDOW + 5) return { symbol, error: "not enough bias bars" };

  const biasSec = TF_SECONDS[BIAS_TF];
  const trades = [], controls = [];
  let sweeps = 0, withFvg = 0, entered = 0;

  let execCursor = 0;
  const execAtOrAfter = (t) => {
    while (execCursor < exec.times.length && exec.times[execCursor] < t) execCursor++;
    return execCursor < exec.times.length ? execCursor : -1;
  };

  for (let b = WINDOW; b < bias.times.length; b++) {
    const window = sliceBars(bias, b - WINDOW + 1, b + 1);
    const found = detectCRT(window, { maxPatterns: 5 });
    if (!found || !found.patterns || !found.patterns.length) continue;
    // RULE 1: only a pattern completing on the final bar of the window is point-in-time.
    const crt = found.patterns.find(p => p.barsAgo === 0);
    if (!crt) continue;
    sweeps++;

    // RULE 2: a bias bar opening at t is not known until it CLOSES.
    const knownAt = bias.times[b] + biasSec;
    const start = execAtOrAfter(knownAt);
    if (start === -1 || start + EXEC_WINDOW >= exec.times.length) continue;

    const wantDirection = crt.direction === "bearish" ? "bearish" : "bullish";

    // 3. The first same-direction FVG that FORMS after the sweep is known.
    let zone = null, zoneIdx = -1;
    const searchEnd = Math.min(start + EXEC_WINDOW + SEARCH, exec.times.length);
    for (let j = start + EXEC_WINDOW; j < searchEnd; j++) {
      const ew = sliceBars(exec, j - EXEC_WINDOW + 1, j + 1);
      const fvg = detectFVGs(ew, { maxZones: 6, includeFilled: true });
      if (!fvg || !fvg.zones || !fvg.zones.length) continue;
      const fresh = fvg.zones.find(z => z.barsAgo === 0 && z.direction === wantDirection);
      if (fresh) { zone = fresh; zoneIdx = j; break; }
    }
    if (!zone) continue;
    withFvg++;

    // 4. Entry on the retest, filled at the NEAR edge -- the first price inside the zone,
    //    and the worst of the fills commonly quoted for this entry.
    const entryPrice = wantDirection === "bullish" ? zone.top : zone.bottom;
    let entryIdx = -1;
    const retestEnd = Math.min(zoneIdx + 1 + RETEST, exec.times.length);
    for (let k = zoneIdx + 1; k < retestEnd; k++) {
      const touched = wantDirection === "bullish"
        ? exec.lows[k] <= entryPrice
        : exec.highs[k] >= entryPrice;
      if (touched) { entryIdx = k; break; }
    }
    if (entryIdx === -1) continue;

    // 5 and 6. Stop beyond the sweep extreme, target the opposite side of the range.
    const stop   = crt.invalidation;
    const target = crt.objective;
    const validGeometry = wantDirection === "bullish"
      ? (stop < entryPrice && target > entryPrice)
      : (stop > entryPrice && target < entryPrice);
    if (!validGeometry) continue;

    const res = resolveTrade(exec, entryIdx, wantDirection, entryPrice, stop, target, MAX_HOLD);
    if (!res) continue;
    entered++;
    const risk = Math.abs(entryPrice - stop);
    trades.push({
      r: res.r, outcome: res.outcome, bars: res.bars,
      entryTime: exec.times[entryIdx],
      rr: Math.abs(target - entryPrice) / risk,
      riskPct: entryPrice ? (risk / entryPrice) * 100 : null,
    });

    // THE CONTROL: same direction, same stop and target DISTANCES, entered at an
    // unrelated earlier bar. It answers the only question that matters -- does the
    // CRT+FVG conjunction beat taking the same shaped trade for no reason?
    const cIdx = entryIdx - CONTROL_OFFSET;
    if (cIdx > 0) {
      const cEntry = exec.closes[cIdx];
      const reward = Math.abs(target - entryPrice);
      const cStop   = wantDirection === "bullish" ? cEntry - risk   : cEntry + risk;
      const cTarget = wantDirection === "bullish" ? cEntry + reward : cEntry - reward;
      const cRes = resolveTrade(exec, cIdx, wantDirection, cEntry, cStop, cTarget, MAX_HOLD);
      if (cRes) controls.push({ r: cRes.r, outcome: cRes.outcome, entryTime: exec.times[cIdx] });
    }
  }

  return { symbol, sweeps, withFvg, entered, trades, controls };
}

const pad = (v, w) => String(v).padEnd(w);
const num = (v, d) => (v === null || v === undefined || !Number.isFinite(v)) ? "-" : v.toFixed(d);

const lines = [];
const say = (s) => { lines.push(s); console.log(s); };

say("=".repeat(112));
say("  CRT -> FVG STRATEGY  --  sweep, reclaim, same-direction FVG, entry on the retest");
say("  " + new Date().toISOString());
say("  bias " + BIAS_TF + " | exec " + EXEC_TF + " | hold " + MAX_HOLD + " exec bars | folds " + FOLDS
  + " | fvg search " + SEARCH + " | retest " + RETEST);
say("  Stop = sweep extreme. Target = opposite side of the swept range. Ambiguous bar = LOSS.");
say("  Unresolved at the horizon is MARKED TO MARKET, never scored as a flat scratch.");
say("=".repeat(112));
say("");
say("  " + pad("symbol", 9) + pad("sweeps", 9) + pad("+FVG", 8) + pad("entered", 9)
  + pad("WR%", 8) + pad("R/trade", 10) + pad("netR", 10) + pad("avgRR", 8)
  + pad("control", 10) + pad("EDGE", 10) + "folds+");

const all = [], allControls = [];
for (const symbol of SYMBOLS) {
  const out = run(symbol);
  if (out.error) { say("  " + pad(symbol, 9) + "ERROR: " + out.error); continue; }
  const s = stats(out.trades);
  const c = stats(out.controls);
  const folds = foldStats(out.trades, FOLDS);
  const positive = folds ? folds.filter(f => f > 0).length : null;
  const avgRr = out.trades.length ? out.trades.reduce((a, t) => a + t.rr, 0) / out.trades.length : null;
  say("  " + pad(symbol, 9) + pad(out.sweeps, 9) + pad(out.withFvg, 8) + pad(out.entered, 9)
    + pad(num(s.wr, 1), 8) + pad(num(s.rpt, 4), 10) + pad(num(s.netR, 2), 10)
    + pad(num(avgRr, 2), 8) + pad(num(c.rpt, 4), 10) + pad(num(s.rpt - c.rpt, 4), 10)
    + (folds ? positive + "/" + FOLDS + "  [" + folds.map(f => num(f, 3)).join(" ") + "]" : "n<5 per fold"));
  all.push(...out.trades); allControls.push(...out.controls);
}

const pooled = stats(all), pooledC = stats(allControls);
const pooledFolds = foldStats(all, FOLDS);
say("  " + "-".repeat(108));
say("  " + pad("POOLED", 9) + pad("", 9) + pad("", 8) + pad(pooled.n, 9)
  + pad(num(pooled.wr, 1), 8) + pad(num(pooled.rpt, 4), 10) + pad(num(pooled.netR, 2), 10)
  + pad("", 8) + pad(num(pooledC.rpt, 4), 10) + pad(num(pooled.rpt - pooledC.rpt, 4), 10)
  + (pooledFolds ? pooledFolds.filter(f => f > 0).length + "/" + FOLDS : "-"));
say("");
say("  EDGE is the strategy minus its matched control. A positive R/trade with an edge of");
say("  zero means the GEOMETRY paid, not the pattern.");

const outDir = path.join(ROOT, "tasks", "analysis");
try {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "crt-fvg-strategy.txt"), lines.join("\n") + "\n");
  fs.writeFileSync(path.join(outDir, "crt-fvg-strategy.json"), JSON.stringify({
    generatedAt: new Date().toISOString(),
    config: { bias: BIAS_TF, exec: EXEC_TF, hold: MAX_HOLD, folds: FOLDS, search: SEARCH, retest: RETEST },
    pooled, pooledControl: pooledC, feedsTheGate: false,
  }, null, 2));
  say("");
  say("  written to tasks/analysis/crt-fvg-strategy.{txt,json}");
} catch (e) {
  console.error("  report not written: " + e.message);
}
