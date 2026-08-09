'use strict';
/**
 * CRT walk-forward WITH COSTS.
 *
 * geometry_measure.cjs established that CRT beats a matched control in 6 of 6
 * asset/timeframe cells. That is a screening result, in-sample across all
 * history, with no costs. It earned this: sequential out-of-sample folds, and an
 * honest answer to "does it survive what it costs to trade".
 *
 * WHY A COST SWEEP RATHER THAN A COST NUMBER. Nothing in this system logs an
 * observed spread — only the 50-point cap it is compared against — so any single
 * cost figure would be invented. Instead the harness sweeps cost and reports the
 * BREAK-EVEN: the round-trip cost at which CRT's net expectancy reaches zero.
 * That converts an unanswerable question into one the broker statement answers.
 *
 * Cost is expressed as a fraction of the instrument's own average bar range, so
 * it is comparable across BTC, Gold and SPX, and applied per trade as
 *
 *     costR = costPrice / riskDistance
 *
 * This is the crux of CRT specifically. Its stop sits at the sweep extreme, which
 * is often CLOSE to entry, so a fixed spread is a LARGE fraction of risk. A model
 * that charged a flat R would flatter it badly.
 *
 * FOLDS ARE SEQUENTIAL AND DISJOINT. No parameter is fitted on one fold and
 * tested on another — CRT as implemented has nothing to fit — so this measures
 * consistency across regimes, which is the failure mode that matters: an "edge"
 * that is one good year and four flat ones.
 *
 * Usage:
 *   node tasks/crt_walkforward.cjs [--folds 5] [--years 10] [--interval 1d] [--hold 20]
 */

const https = require("https");
const path  = require("path");
const { detectCRT } = require(path.join(__dirname, "..", "server", "structure.js"));

const ASSETS = [
  { name: "BTC",  ticker: "BTC-USD" },
  { name: "GOLD", ticker: "GC=F"    },
  { name: "SPX",  ticker: "^GSPC"   },
];

// Round-trip cost as a fraction of one average bar range.
const COST_LEVELS = [0, 0.02, 0.05, 0.10, 0.20, 0.35, 0.50];
const CONTROL_LAG_BARS = 37;

function numArg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  if (i === -1 || i + 1 >= process.argv.length) return fallback;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : fallback;
}
function strArg(flag, fallback, allowed) {
  const i = process.argv.indexOf(flag);
  if (i === -1 || i + 1 >= process.argv.length) return fallback;
  const v = process.argv[i + 1];
  return allowed.indexOf(v) !== -1 ? v : fallback;
}

const FOLDS     = Math.max(2, numArg("--folds", 5));
const YEARS     = numArg("--years", 10);
const HOLD_BARS = numArg("--hold", 20);
const INTERVAL  = strArg("--interval", "1d", ["1d", "1h", "1wk"]);
const RANGE     = INTERVAL === "1h" ? "730d" : YEARS + "y";

function fetchBars(ticker) {
  const url = "https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(ticker)
    + "?range=" + RANGE + "&interval=" + INTERVAL;
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, res => {
      let body = "";
      res.on("data", c => { body += c; });
      res.on("end", () => {
        try {
          const q = JSON.parse(body).chart.result[0].indicators.quote[0];
          const rows = q.high.map((h, i) => [h, q.low[i], q.close[i]])
            .filter(r => r.every(v => typeof v === "number" && Number.isFinite(v)));
          resolve({ highs: rows.map(r => r[0]), lows: rows.map(r => r[1]), closes: rows.map(r => r[2]) });
        } catch (e) { reject(new Error("parse " + ticker + ": " + e.message)); }
      });
    }).on("error", reject);
  });
}

function sliceBars(bars, from, to) {
  return {
    highs:  bars.highs.slice(from, to),
    lows:   bars.lows.slice(from, to),
    closes: bars.closes.slice(from, to),
  };
}

function averageBarRange(bars) {
  let total = 0;
  for (let i = 0; i < bars.highs.length; i++) total += bars.highs[i] - bars.lows[i];
  return bars.highs.length ? total / bars.highs.length : 0;
}

/**
 * Resolve one trade. Returns gross R and the risk distance, so cost can be
 * applied afterwards at any level without re-walking the bars.
 * Stop and target inside one bar counts as a LOSS.
 */
function resolveTrade(bars, startIndex, direction, entry, stop, target, holdBars) {
  const risk = Math.abs(entry - stop);
  const reward = Math.abs(target - entry);
  if (!(risk > 0) || !(reward > 0)) return null;
  const isLong = direction === "bullish";
  const limit = Math.min(startIndex + holdBars, bars.highs.length - 1);
  for (let j = startIndex + 1; j <= limit; j++) {
    const hitStop   = isLong ? bars.lows[j]  <= stop   : bars.highs[j] >= stop;
    const hitTarget = isLong ? bars.highs[j] >= target : bars.lows[j]  <= target;
    if (hitStop)   return { grossR: -1, risk, outcome: "LOSS" };
    if (hitTarget) return { grossR: reward / risk, risk, outcome: "WIN" };
  }
  return { grossR: 0, risk, outcome: "TIMEOUT" };
}

function crtTrades(bars, holdBars) {
  const patterns = detectCRT(bars, { maxPatterns: 1000000 }).patterns;
  const trades = [], controls = [];
  for (const p of patterns) {
    const entry = bars.closes[p.barIndex];
    const t = resolveTrade(bars, p.barIndex, p.direction, entry, p.invalidation, p.objective, holdBars);
    if (!t) continue;
    trades.push(t);

    const ci = p.barIndex - CONTROL_LAG_BARS;
    if (ci < 1) { continue; }
    const cEntry = bars.closes[ci];
    const riskDistance   = Math.abs(entry - p.invalidation);
    const rewardDistance = Math.abs(p.objective - entry);
    const isLong = p.direction === "bullish";
    const c = resolveTrade(bars, ci, p.direction,
      cEntry,
      isLong ? cEntry - riskDistance   : cEntry + riskDistance,
      isLong ? cEntry + rewardDistance : cEntry - rewardDistance,
      holdBars);
    if (c) controls.push(c);
  }
  return { trades, controls };
}

/**
 * Net expectancy per trade at a given round-trip cost in PRICE units.
 *
 * When pooling across assets a single price cost is meaningless — BTC's average
 * bar range is 1398 and Gold's is 22.6, so one number charges Gold a BTC-sized
 * spread. Pass costFraction instead and each trade is charged against ITS OWN
 * instrument's range, carried on the trade as assetRange.
 */
function expectancyAtCost(trades, costPrice, costFraction) {
  if (!trades.length) return null;
  let total = 0;
  for (const t of trades) {
    const cost = costFraction != null ? (t.assetRange || 0) * costFraction : costPrice;
    total += t.grossR - (cost / t.risk);
  }
  return total / trades.length;
}

/** Smallest cost (price units) at which net expectancy hits zero. Bisection. */
function breakEvenCost(trades, averageRange) {
  if (!trades.length || expectancyAtCost(trades, 0) <= 0) return 0;
  let low = 0, high = averageRange * 2;
  if (expectancyAtCost(trades, high) > 0) return high; // survives absurd costs
  for (let i = 0; i < 60; i++) {
    const mid = (low + high) / 2;
    if (expectancyAtCost(trades, mid) > 0) low = mid; else high = mid;
  }
  return (low + high) / 2;
}

function winRate(trades) {
  const decided = trades.filter(t => t.outcome !== "TIMEOUT").length;
  return decided ? (trades.filter(t => t.outcome === "WIN").length / decided) * 100 : null;
}

(async () => {
  console.log("CRT WALK-FORWARD WITH COSTS");
  console.log(RANGE + " of " + INTERVAL + " bars · " + FOLDS + " sequential out-of-sample folds · "
    + HOLD_BARS + "-bar hold");
  console.log("Cost = round trip, as a fraction of one average bar range, charged per trade as");
  console.log("costR = costPrice / riskDistance. CRT stops sit at the sweep extreme and are often");
  console.log("tight, so a flat spread is a LARGE fraction of risk — that is the whole question.");
  console.log("Stop and target in one bar = LOSS.\n");

  const pooled = [];
  const perAsset = [];

  for (const asset of ASSETS) {
    let bars;
    try { bars = await fetchBars(asset.ticker); }
    catch (e) { console.log(asset.name + ": fetch failed — " + e.message + "\n"); continue; }

    const total = bars.highs.length;
    const foldSize = Math.floor(total / FOLDS);
    const range = averageBarRange(bars);

    console.log("═".repeat(80));
    console.log(asset.name + "  " + total + " bars · avg bar range " + range.toFixed(2)
      + " · fold ≈ " + foldSize + " bars");
    console.log("═".repeat(80));
    console.log("  fold        n   win%   grossR   " + COST_LEVELS.slice(1).map(c => (c * 100) + "%").map(s => s.padStart(7)).join("") + "   control");

    const assetTrades = [];
    let foldsPositiveGross = 0, foldsPositiveAt10 = 0, foldsCounted = 0;

    for (let f = 0; f < FOLDS; f++) {
      const from = f * foldSize;
      const to   = (f === FOLDS - 1) ? total : (f + 1) * foldSize;
      const slice = sliceBars(bars, from, to);
      const sliceRange = averageBarRange(slice);
      const { trades, controls } = crtTrades(slice, HOLD_BARS);
      if (trades.length < 10) {
        console.log("  " + String(f + 1).padStart(4) + "  " + String(trades.length).padStart(7) + "   (too few to judge)");
        continue;
      }
      foldsCounted++;
      // Tag each trade with its own instrument's scale so the pooled sweep can
      // charge a per-asset cost rather than one meaningless average.
      for (const t of trades) t.assetRange = sliceRange;
      assetTrades.push(...trades);
      pooled.push(...trades);

      const gross = expectancyAtCost(trades, 0);
      const controlGross = controls.length ? expectancyAtCost(controls, 0) : null;
      if (gross > 0) foldsPositiveGross++;
      const at10 = expectancyAtCost(trades, sliceRange * 0.10);
      if (at10 > 0) foldsPositiveAt10++;

      const cells = COST_LEVELS.slice(1).map(level => {
        const v = expectancyAtCost(trades, sliceRange * level);
        return ((v >= 0 ? "+" : "") + v.toFixed(2)).padStart(7);
      }).join("");

      console.log("  " + String(f + 1).padStart(4)
        + String(trades.length).padStart(8)
        + (winRate(trades) == null ? "    n/a" : (winRate(trades).toFixed(0) + "%").padStart(7))
        + ((gross >= 0 ? "+" : "") + gross.toFixed(3)).padStart(9)
        + cells
        + (controlGross == null ? "        n/a" : ((controlGross >= 0 ? "+" : "") + controlGross.toFixed(3)).padStart(11)));
    }

    const be = breakEvenCost(assetTrades, range);
    perAsset.push({ name: asset.name, trades: assetTrades, breakEven: be, range,
                    foldsPositiveGross, foldsPositiveAt10, foldsCounted });
    console.log("\n  folds positive gross: " + foldsPositiveGross + "/" + foldsCounted
      + "   at 10% cost: " + foldsPositiveAt10 + "/" + foldsCounted);
    console.log("  BREAK-EVEN round-trip cost: " + be.toFixed(2) + " price units  ("
      + (range > 0 ? (be / range * 100).toFixed(1) : "?") + "% of an average bar range)");
    console.log("");
  }

  console.log("═".repeat(80));
  console.log("POOLED");
  console.log("═".repeat(80));
  if (!pooled.length) { console.log("no trades"); return; }
  console.log("  trades " + pooled.length + "   win " + winRate(pooled).toFixed(1) + "%");
  console.log("  (each trade charged against its OWN instrument's bar range)");
  for (const level of COST_LEVELS) {
    const v = expectancyAtCost(pooled, null, level);
    console.log("    cost " + String((level * 100).toFixed(0) + "%").padStart(4)
      + " of that asset's avg bar range  ->  " + ((v >= 0 ? "+" : "") + v.toFixed(4)) + "R/trade"
      + (v <= 0 ? "   <-- underwater" : ""));
  }
  console.log("\n  Per-asset break-even (round-trip cost that takes expectancy to zero):");
  for (const a of perAsset) {
    console.log("    " + a.name.padEnd(5) + a.breakEven.toFixed(2).padStart(9) + " price units   "
      + (a.range > 0 ? (a.breakEven / a.range * 100).toFixed(1) : "?").padStart(6) + "% of avg bar range"
      + "   folds positive gross " + a.foldsPositiveGross + "/" + a.foldsCounted);
  }
  console.log("\n  Compare each break-even against your ACTUAL round-trip spread + commission for");
  console.log("  that symbol. Nothing in this repo logs an observed spread, so that number has to");
  console.log("  come from the broker. One recorded data point: BTCUSD was seen at ~1700 points.");
  console.log("\n  This changes no live setting. A pattern that survives its own costs across folds");
  console.log("  has earned a discussion about wiring it in — not the wiring itself.");
})().catch(e => { console.error("FAILED: " + e.message); process.exit(1); });
