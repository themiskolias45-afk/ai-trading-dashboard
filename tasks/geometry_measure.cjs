'use strict';
/**
 * Measure FVG, CRT and AMD against real history — with a control group.
 *
 * WHY A CONTROL. "CRT wins 58% of the time" is not evidence. Any long with a
 * wide stop and a near target wins most of the time; the question is whether the
 * PATTERN did better than the same trade taken for no reason. So every detected
 * pattern is paired with a matched control: identical direction, identical stop
 * and target DISTANCES, identical holding limit, entered at a fixed lag earlier
 * in the same series. If the pattern and the control score the same, the pattern
 * is decoration — and that is a perfectly acceptable answer to get.
 *
 * METHOD. Each pattern becomes one trade with a defined entry, stop and target,
 * resolved bar by bar:
 *
 *   FVG  price returns to a fresh zone -> enter in the zone's direction,
 *        stop beyond the far edge, target one zone-height away
 *   CRT  enter at the confirmation close, stop at the sweep extreme,
 *        target the opposite edge of the range candle
 *   AMD  enter at the distribution close, stop at the manipulation extreme,
 *        target one accumulation-range beyond
 *
 * PESSIMISTIC RESOLUTION. If a bar's range contains both the stop and the
 * target, it counts as a LOSS. Intrabar order is unknowable from OHLC, and the
 * assumption that flatters the result is the one that produces fake edges.
 *
 * NOT A BACKTEST. No costs, no spread, no slippage, no position sizing. This
 * asks one question only: does the geometry predict direction better than
 * nothing? Anything that survives here still has to clear a real walk-forward.
 *
 * Usage: node tasks/geometry_measure.cjs [--years 10] [--hold 20]
 */

const https = require("https");
const path  = require("path");

const { detectFVGs }          = require(path.join(__dirname, "..", "server", "fvg.js"));
const { detectCRT, detectAMD } = require(path.join(__dirname, "..", "server", "structure.js"));

const ASSETS = [
  { name: "BTC",  ticker: "BTC-USD" },
  { name: "GOLD", ticker: "GC=F"    },
  { name: "SPX",  ticker: "^GSPC"   },
];

// Bars between a pattern and its matched control. Large enough to decorrelate,
// not so large the control sits in a different market era.
const CONTROL_LAG_BARS = 37;

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  if (i === -1 || i + 1 >= process.argv.length) return fallback;
  const value = Number(process.argv[i + 1]);
  return Number.isFinite(value) ? value : fallback;
}
const YEARS    = arg("--years", 10);
const HOLD_BARS = arg("--hold", 20);

// AMD is an intraday model: a 12-bar tight accumulation then a sweep is common
// within a day and rare across twelve DAYS, which is why the daily run produced
// 8 samples. --interval 1h (range capped at 730d by Yahoo) gives it a fair test.
function intervalArg() {
  const i = process.argv.indexOf("--interval");
  if (i === -1 || i + 1 >= process.argv.length) return "1d";
  const value = process.argv[i + 1];
  return ["1d", "1h", "4h", "1wk"].indexOf(value) !== -1 ? value : "1d";
}
const INTERVAL = intervalArg();
// Yahoo refuses multi-year ranges on intraday intervals.
const RANGE = INTERVAL === "1d" || INTERVAL === "1wk" ? YEARS + "y" : "730d";

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

/**
 * Resolve one trade forward from `startIndex`.
 * Returns { outcome: "WIN"|"LOSS"|"TIMEOUT", bars, r }.
 */
function resolveTrade(bars, startIndex, direction, entry, stop, target, holdBars) {
  const { highs, lows } = bars;
  const risk = Math.abs(entry - stop);
  const reward = Math.abs(target - entry);
  if (!(risk > 0) || !(reward > 0)) return null;
  const rMultiple = reward / risk;
  const isLong = direction === "bullish";

  const limit = Math.min(startIndex + holdBars, highs.length - 1);
  for (let j = startIndex + 1; j <= limit; j++) {
    const hitStop   = isLong ? lows[j]  <= stop   : highs[j] >= stop;
    const hitTarget = isLong ? highs[j] >= target : lows[j]  <= target;
    // Both in one bar: assume the stop. Intrabar order is unknowable.
    if (hitStop)   return { outcome: "LOSS",   bars: j - startIndex, r: -1 };
    if (hitTarget) return { outcome: "WIN",    bars: j - startIndex, r: rMultiple };
  }
  return { outcome: "TIMEOUT", bars: limit - startIndex, r: 0 };
}

/** Same trade geometry, taken CONTROL_LAG_BARS earlier for no reason at all. */
function controlFor(bars, startIndex, direction, entry, stop, target, holdBars) {
  const controlIndex = startIndex - CONTROL_LAG_BARS;
  if (controlIndex < 1) return null;
  const controlEntry = bars.closes[controlIndex];
  const riskDistance   = Math.abs(entry - stop);
  const rewardDistance = Math.abs(target - entry);
  const isLong = direction === "bullish";
  const controlStop   = isLong ? controlEntry - riskDistance   : controlEntry + riskDistance;
  const controlTarget = isLong ? controlEntry + rewardDistance : controlEntry - rewardDistance;
  return resolveTrade(bars, controlIndex, direction, controlEntry, controlStop, controlTarget, holdBars);
}

function summarise(results) {
  const resolved = results.filter(Boolean);
  const wins   = resolved.filter(r => r.outcome === "WIN").length;
  const losses = resolved.filter(r => r.outcome === "LOSS").length;
  const timeouts = resolved.filter(r => r.outcome === "TIMEOUT").length;
  const decided = wins + losses;
  const totalR = resolved.reduce((sum, r) => sum + r.r, 0);
  return {
    n: resolved.length,
    wins, losses, timeouts,
    winRate: decided > 0 ? (wins / decided) * 100 : null,
    expectancyR: resolved.length > 0 ? totalR / resolved.length : null,
    totalR,
  };
}

function line(label, s) {
  if (!s || s.n === 0) return "  " + label.padEnd(10) + "no samples";
  return "  " + label.padEnd(10)
    + String(s.n).padStart(5) + " trades  "
    + (s.winRate == null ? "  n/a  " : (s.winRate.toFixed(1) + "% win").padStart(11))
    + "   " + (s.expectancyR >= 0 ? "+" : "") + s.expectancyR.toFixed(3) + "R/trade"
    + "   (" + s.wins + "W " + s.losses + "L " + s.timeouts + " timeout)";
}

function verdict(pattern, control) {
  if (!pattern || pattern.n < 20) return "INSUFFICIENT SAMPLE — no claim either way";
  if (!control || control.n < 20) return "NO CONTROL — cannot judge";
  const edgeR = pattern.expectancyR - control.expectancyR;
  const edgeWin = (pattern.winRate ?? 0) - (control.winRate ?? 0);
  const direction = edgeR > 0 ? "better" : "worse";
  const magnitude = Math.abs(edgeR);
  let call;
  if (magnitude < 0.05) call = "NO DIFFERENCE — the pattern is not doing anything";
  else if (edgeR > 0.15) call = "PATTERN AHEAD — worth a walk-forward";
  else if (edgeR < -0.15) call = "PATTERN BEHIND — actively worse than random";
  else call = "MARGINAL — inside the noise, do not act on it";
  return call + "  (" + (edgeR >= 0 ? "+" : "") + edgeR.toFixed(3) + "R, "
    + (edgeWin >= 0 ? "+" : "") + edgeWin.toFixed(1) + "pp win rate " + direction + " than control)";
}

/* ── per-pattern trade construction ───────────────────────────── */

function fvgTrades(bars, holdBars) {
  // Every zone the detector can see, including ones later filled — excluding
  // them would only measure the gaps that never got tested.
  const zones = detectFVGs(bars, { maxZones: 100000, includeFilled: true }).zones;
  const trades = [], controls = [];
  for (const zone of zones) {
    // Find the first bar after formation where price returns into the zone.
    let touch = -1;
    for (let j = zone.barIndex + 1; j < bars.highs.length; j++) {
      const entered = zone.direction === "bullish" ? bars.lows[j] <= zone.top : bars.highs[j] >= zone.bottom;
      if (entered) { touch = j; break; }
    }
    if (touch === -1) continue;
    const isLong = zone.direction === "bullish";
    // Enter at the zone edge price reached, stop beyond the far edge, target one
    // zone-height away — the trade the "gap is support/resistance" claim implies.
    const entry  = isLong ? zone.top : zone.bottom;
    const stop   = isLong ? zone.bottom : zone.top;
    const target = isLong ? entry + zone.height : entry - zone.height;
    const t = resolveTrade(bars, touch, zone.direction, entry, stop, target, holdBars);
    if (!t) continue;
    trades.push(t);
    controls.push(controlFor(bars, touch, zone.direction, entry, stop, target, holdBars));
  }
  return { trades, controls };
}

function crtTrades(bars, holdBars) {
  const patterns = detectCRT(bars, { maxPatterns: 100000 }).patterns;
  const trades = [], controls = [];
  for (const p of patterns) {
    const entry = bars.closes[p.barIndex];
    const t = resolveTrade(bars, p.barIndex, p.direction, entry, p.invalidation, p.objective, holdBars);
    if (!t) continue;
    trades.push(t);
    controls.push(controlFor(bars, p.barIndex, p.direction, entry, p.invalidation, p.objective, holdBars));
  }
  return { trades, controls };
}

function amdTrades(bars, holdBars) {
  const patterns = detectAMD(bars, { maxPatterns: 100000 }).patterns;
  const trades = [], controls = [];
  for (const p of patterns) {
    const entry = bars.closes[p.barIndex];
    const t = resolveTrade(bars, p.barIndex, p.direction, entry, p.invalidation, p.objective, holdBars);
    if (!t) continue;
    trades.push(t);
    controls.push(controlFor(bars, p.barIndex, p.direction, entry, p.invalidation, p.objective, holdBars));
  }
  return { trades, controls };
}

/* ── run ──────────────────────────────────────────────────────── */

(async () => {
  console.log("GEOMETRY MEASUREMENT — " + RANGE + " of " + INTERVAL + " bars, " + HOLD_BARS + "-bar hold limit");
  console.log("Stop and target both hit in one bar counts as a LOSS. No costs modelled.");
  console.log("Control = same direction and same stop/target distances, entered "
    + CONTROL_LAG_BARS + " bars earlier for no reason.\n");

  const pooled = { FVG: { t: [], c: [] }, CRT: { t: [], c: [] }, AMD: { t: [], c: [] } };

  for (const asset of ASSETS) {
    let bars;
    try { bars = await fetchBars(asset.ticker); }
    catch (e) { console.log(asset.name + ": fetch failed — " + e.message + "\n"); continue; }

    console.log("═".repeat(78));
    console.log(asset.name + "  (" + asset.ticker + ", " + bars.highs.length + " bars)");
    console.log("═".repeat(78));

    for (const [label, builder] of [["FVG", fvgTrades], ["CRT", crtTrades], ["AMD", amdTrades]]) {
      const { trades, controls } = builder(bars, HOLD_BARS);
      const patternSummary = summarise(trades);
      const controlSummary = summarise(controls);
      pooled[label].t.push(...trades);
      pooled[label].c.push(...controls.filter(Boolean));
      console.log("\n" + label);
      console.log(line("pattern", patternSummary));
      console.log(line("control", controlSummary));
      console.log("  verdict:  " + verdict(patternSummary, controlSummary));
    }
    console.log("");
  }

  console.log("═".repeat(78));
  console.log("POOLED ACROSS ALL THREE ASSETS");
  console.log("═".repeat(78));
  for (const label of ["FVG", "CRT", "AMD"]) {
    const p = summarise(pooled[label].t);
    const c = summarise(pooled[label].c);
    console.log("\n" + label);
    console.log(line("pattern", p));
    console.log(line("control", c));
    console.log("  verdict:  " + verdict(p, c));
  }
  console.log("\nNothing here changes any live setting. A pattern that is ahead of its "
    + "control has earned a walk-forward, not a vote.");
})().catch(e => { console.error("FAILED: " + e.message); process.exit(1); });
