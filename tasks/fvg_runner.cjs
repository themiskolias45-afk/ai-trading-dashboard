#!/usr/bin/env node
'use strict';
/**
 * FVG CONTINUATION -- the live runner, shadow by default.
 *
 * The model measured on 2026-09-02 over 1,246 trades and five years of broker bars:
 *
 *   trend on the bias timeframe (EMA50 > EMA200 and price above EMA50, mirrored short)
 *   -> a DISPLACEMENT bar on the execution timeframe: range above 1.5x its own ATR14,
 *      closing in the trend direction
 *   -> the same-direction FVG that displacement bar created
 *   -> price retraces into the gap; entry at the NEAR edge
 *   -> stop the far side of the gap or the displacement bar's extreme, whichever is
 *      further; target 5R
 *
 *   gross +0.4075 R/trade | spread cost 0.1824 | NET +0.2252 | headroom 2.2x | 5/5 folds
 *   288 trades/yr against the live engine's ~107 fills/yr
 *
 * WHY THIS RUNS BESIDE THE ENGINE AND NOT INSIDE IT. The engine's setup chain is
 * first-match-wins: the last setup added to it (SELL_BOUNCE) DISPLACED 16 Gold trades
 * while adding 3, because a match higher in the chain steals steps from one below. This
 * model trades a different timeframe on a different trigger, so it gets its own path and
 * cannot suppress a single existing signal. Rule 3 -- never block a good signal -- is
 * satisfied structurally rather than by argument.
 *
 * SHADOW BY DEFAULT. --execute is not implemented here on purpose. The first job is
 * PARITY: the measurement ran on tasks/history CSVs and this runs on the live bridge
 * cache, and if the two disagree about when a setup exists then the backtest is not
 * describing this code. Shadow rows carry everything needed to score them later against
 * the same convention the backtest used.
 *
 *   node tasks/fvg_runner.cjs [--host http://localhost:3001] [--once] [--verbose]
 *
 * WRITES ONE FILE: tasks/fvg_shadow.jsonl, append-only. It places no orders, touches no
 * gate, threshold, position, setting or learning file, and nothing in the engine reads it.
 */

const fs   = require("fs");
const path = require("path");
const http = require("http");

const ROOT = path.join(__dirname, "..");
const { detectFVGs } = require(path.join(ROOT, "server", "fvg.js"));

const LEDGER = path.join(ROOT, "tasks", "fvg_shadow.jsonl");

function strArg(f, d) { const i = process.argv.indexOf(f); return (i === -1 || i + 1 >= process.argv.length) ? d : process.argv[i + 1]; }
const HOST    = strArg("--host", "http://localhost:3001");
const ONCE    = process.argv.includes("--once");
const VERBOSE = process.argv.includes("--verbose");

// Exactly the constants the measurement used. Changing one here without re-running the
// walk-forward makes this a different model wearing the measured model's numbers.
const DISPLACEMENT_ATR = 1.5;
const ATR_PERIOD       = 14;
const MAX_RR           = 5;
const RETEST_BARS      = 40;   // exec bars allowed for price to come back to the gap
const EXEC_WINDOW      = 60;   // trailing window the detector sees, as in the backtest

function get(urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get(HOST + urlPath, { timeout: 8000 }, (res) => {
      let body = "";
      res.on("data", c => { body += c; });
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error(urlPath + " HTTP " + res.statusCode));
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error("non-JSON from " + urlPath)); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout " + urlPath)); });
  });
}

function emaAt(closes, endIdx, period) {
  const from = Math.max(0, endIdx - period * 3);
  if (endIdx - from < period) return null;
  let ema = 0;
  for (let i = from; i < from + period; i++) ema += closes[i];
  ema /= period;
  const k = 2 / (period + 1);
  for (let i = from + period; i <= endIdx; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}
function atrAt(h, l, c, endIdx, period) {
  if (endIdx < period) return null;
  let sum = 0;
  for (let i = endIdx - period + 1; i <= endIdx; i++) {
    sum += Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
  }
  return sum / period;
}
const sliceBars = (b, from, to) => ({
  highs: b.highs.slice(from, to), lows: b.lows.slice(from, to),
  closes: b.closes.slice(from, to), times: (b.times || []).slice(from, to),
});

function alreadyLogged(key) {
  if (!fs.existsSync(LEDGER)) return false;
  // Read rather than hold in memory: the runner is meant to survive a restart without
  // re-emitting a setup it already recorded, and an in-memory set forgets on every
  // restart -- which is how the near-miss census lost its whole history until it was
  // given a file.
  for (const raw of fs.readFileSync(LEDGER, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try { if (JSON.parse(line).key === key) return true; } catch (e) { /* skip corrupt */ }
  }
  return false;
}

/** Returns a setup object when the CURRENT exec bar completes a valid entry, else null. */
function evaluate(assetKey, symbol, bias, exec) {
  const bi = bias.closes.length - 1;
  const ei = exec.closes.length - 1;
  if (bi < 200 || ei < EXEC_WINDOW + 2) return null;

  const e50 = emaAt(bias.closes, bi, 50), e200 = emaAt(bias.closes, bi, 200);
  if (e50 === null || e200 === null) return null;
  const px = bias.closes[bi];
  const direction = (e50 > e200 && px > e50) ? "bullish"
                  : (e50 < e200 && px < e50) ? "bearish" : null;
  if (!direction) return null;

  // Look back over the retest window for the most recent displacement bar that created a
  // same-direction gap, then ask whether THIS bar is the retest of it.
  for (let j = ei - 1; j >= Math.max(EXEC_WINDOW, ei - RETEST_BARS); j--) {
    const atr = atrAt(exec.highs, exec.lows, exec.closes, j, ATR_PERIOD);
    if (!atr || atr <= 0) continue;
    const range = exec.highs[j] - exec.lows[j];
    const withTrend = direction === "bullish" ? exec.closes[j] > exec.closes[j - 1]
                                              : exec.closes[j] < exec.closes[j - 1];
    if (!(range > DISPLACEMENT_ATR * atr && withTrend)) continue;

    const fvg = detectFVGs(sliceBars(exec, j - EXEC_WINDOW + 1, j + 1),
      { maxZones: 6, includeFilled: true });
    const zone = fvg && fvg.zones ? fvg.zones.find(z => z.barsAgo === 0 && z.direction === direction) : null;
    if (!zone) continue;

    const entry = direction === "bullish" ? zone.top : zone.bottom;
    // The retest must happen on the CURRENT bar, and must not already have happened on an
    // earlier one -- otherwise every bar after a fill would re-emit the same setup.
    let touchedEarlier = false;
    for (let k = j + 1; k < ei; k++) {
      const t = direction === "bullish" ? exec.lows[k] <= entry : exec.highs[k] >= entry;
      if (t) { touchedEarlier = true; break; }
    }
    if (touchedEarlier) continue;
    const touchedNow = direction === "bullish" ? exec.lows[ei] <= entry : exec.highs[ei] >= entry;
    if (!touchedNow) continue;

    const stop = direction === "bullish" ? Math.min(zone.bottom, exec.lows[j])
                                         : Math.max(zone.top, exec.highs[j]);
    const risk = Math.abs(entry - stop);
    if (!(risk > 0)) continue;
    const target = direction === "bullish" ? entry + MAX_RR * risk : entry - MAX_RR * risk;

    return {
      key: assetKey + "|" + (exec.times ? exec.times[j] : j) + "|" + entry.toFixed(6),
      asset: assetKey, symbol,
      direction: direction === "bullish" ? "BUY" : "SELL",
      entry, stop, target, risk,
      rr: MAX_RR,
      riskPct: entry ? (risk / entry) * 100 : null,
      displacementBarTime: exec.times ? exec.times[j] : null,
      entryBarTime: exec.times ? exec.times[ei] : null,
      gapTop: zone.top, gapBottom: zone.bottom,
      gapHeightInRanges: zone.heightInRanges,
      model: "FVG_CONTINUATION",
      measuredNetR: 0.2252,
      shadow: true,
      feedsTheGate: false,
      seenAt: new Date().toISOString(),
    };
  }
  return null;
}

async function tick() {
  let raw;
  try { raw = await get("/api/mt5/candles/raw"); }
  catch (e) { console.error("[fvg] cannot read bars: " + e.message); return; }
  const assets = raw && raw.assets ? raw.assets : null;
  if (!assets) { console.error("[fvg] no assets in the candle dump"); return; }

  let found = 0;
  for (const assetKey of Object.keys(assets)) {
    const entry = assets[assetKey];
    const bars = entry && entry.bars ? entry.bars : null;
    if (!bars || !bars.h4 || !bars.m15) {
      if (VERBOSE) console.log("[fvg] " + assetKey + ": no h4/m15 bars");
      continue;
    }
    const setup = evaluate(assetKey, entry.symbol || assetKey, bars.h4, bars.m15);
    if (!setup) { if (VERBOSE) console.log("[fvg] " + assetKey + ": no setup"); continue; }
    if (alreadyLogged(setup.key)) { if (VERBOSE) console.log("[fvg] " + assetKey + ": already recorded"); continue; }
    fs.appendFileSync(LEDGER, JSON.stringify(setup) + "\n", "utf8");
    found++;
    console.log("[fvg] SHADOW " + setup.symbol + " " + setup.direction
      + " entry " + setup.entry.toFixed(2) + " stop " + setup.stop.toFixed(2)
      + " target " + setup.target.toFixed(2) + " risk " + setup.riskPct.toFixed(3) + "%");
  }
  if (!found) console.log("[fvg] " + new Date().toISOString() + " no new setups");
}

(async () => {
  console.log("FVG CONTINUATION runner — SHADOW ONLY, places no orders. host " + HOST);
  await tick();
  if (ONCE) return;
  // 15-minute cadence matches the execution timeframe: checking more often cannot find a
  // setup that needs a closed m15 bar to exist.
  setInterval(tick, 15 * 60 * 1000);
})();
