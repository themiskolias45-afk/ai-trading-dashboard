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
 *   NET +0.6655 R/trade after measured spread | 5/5 folds on all three instruments
 *   ~310 trades/yr against the live engine's ~107 fills/yr
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
// disp 1.0, maxRR 8, retest 80 -- and the reversal from 1.5 is documented because it was
// REJECTED this morning on the same axis.
//
// That rejection was correct at the time and does not apply to this configuration. It was
// disp 1.0 at rr 5 / retest 40, scored by a harness that capped no R and accepted stops
// narrower than the spread. With tasks/_rr_cap.cjs applied and any stop under 3x the
// spread dropped, disp 1 / rr 8 / retest 80 passes every guard the session has:
//
//   XAUUSD held-out (fit never saw it)  221 tr  PF 2.524  +1.0777 net  5/5  vs +0.4112 3/5
//   BTCUSD  never fitted                365 tr  PF 1.975  +0.6373      5/5  vs +0.2961 4/5
//   SP500   never fitted                461 tr  PF 1.820  +0.5221      5/5  vs +0.3525 5/5
//   total net R                         +711.47R                            vs +178.99R
//   LAST 90 DAYS                        67 tr   +1.0369 net (+69.5R)        vs +0.4753 (+16.2R)
//   concentration, top 5 rows           4% of gross                         vs 9%
//
// The recent-window and concentration checks are the two that killed the earlier
// candidate, and this one is BETTER on both. More trades, higher R, less dependent on a
// handful of rows.
//
// Changed while the shadow ledger was still EMPTY. After the first recorded row a
// parameter change makes the ledger a mixture of two models.
const DISPLACEMENT_ATR = 1.0;
const ATR_PERIOD       = 14;
const MAX_RR           = 8;
const RETEST_BARS      = 80;   // exec bars allowed for price to come back to the gap
const EXEC_WINDOW      = 60;   // trailing window the detector sees, as in the backtest
// A stop under 3x the spread is not tradeable, and the measurement DROPS those trades.
// Without the same rule here the runner would record setups the backtest never counted,
// which is the parity failure the cooldown fix already caught once.
const MIN_STOP_SPREADS = 3;
const SPREAD = { XAUUSD: 0.22, BTCUSD: 17.00, SP500: 0.36, gold: 0.22, btc: 17.00, spx: 0.36 };
// COOLDOWN, and it is not cosmetic. The measured model advances `lastEntry = eIdx + 20`
// after every fill, so it takes ONE trade per displacement episode. Without it the runner
// re-enters the same episode and fires 29% more often -- 5.17 setups per 1,000 bars
// against the backtest's 4.0, measured by tasks/fvg_parity.cjs. A live model that trades
// more often than the one that was walk-forwarded is not the model that was validated,
// however similar it looks.
const COOLDOWN_BARS    = 20;

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

// The most recent recorded entry bar time for an asset, so the cooldown survives a
// restart. Held in the FILE rather than in memory for the same reason the dedupe key is:
// an in-memory cooldown forgets on every restart and the runner double-enters.
function lastEntryTime(asset) {
  if (!fs.existsSync(LEDGER)) return null;
  let latest = null;
  for (const raw of fs.readFileSync(LEDGER, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      if (row.asset === asset && Number.isFinite(row.entryBarTime)) {
        if (latest === null || row.entryBarTime > latest) latest = row.entryBarTime;
      }
    } catch (e) { /* corrupt row skipped, never silently dropped from the count above */ }
  }
  return latest;
}

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

/**
 * Returns a setup object when the CURRENT exec bar completes a valid entry, else null.
 * `sinceLastEntry` is the exec-bar time of this asset's previous entry, used to enforce
 * the same one-trade-per-episode cooldown the measured model applies.
 */
function evaluate(assetKey, symbol, bias, exec, sinceLastEntry) {
  const bi = bias.closes.length - 1;
  const ei = exec.closes.length - 1;
  if (bi < 200 || ei < EXEC_WINDOW + 2) return null;

  // COOLDOWN -- parity with the measured model, which takes one trade per episode.
  if (Number.isFinite(sinceLastEntry) && exec.times && exec.times[ei]) {
    const barSeconds = exec.times.length > 1 ? (exec.times[ei] - exec.times[ei - 1]) : 900;
    if (exec.times[ei] - sinceLastEntry < COOLDOWN_BARS * barSeconds) return null;
  }

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
    const sp = SPREAD[symbol] ?? SPREAD[assetKey];
    if (sp && risk < MIN_STOP_SPREADS * sp) continue;
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
      measuredNetR: 0.6655,
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
    const setup = evaluate(assetKey, entry.symbol || assetKey, bars.h4, bars.m15,
      lastEntryTime(assetKey));
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

// Exported so tasks/fvg_parity.cjs can replay the archive through THIS code and check it
// finds what the backtest counted. A live runner that quietly differs from the model it
// claims to implement is the whole reason the shadow stage exists, and the only way to
// catch it is to run one function against both feeds.
module.exports = { evaluate, DISPLACEMENT_ATR, MAX_RR, RETEST_BARS, EXEC_WINDOW, COOLDOWN_BARS };

if (require.main === module) {
  (async () => {
    console.log("FVG CONTINUATION runner -- SHADOW ONLY, places no orders. host " + HOST);
    await tick();
    if (ONCE) return;
    // 15-minute cadence matches the execution timeframe: checking more often cannot find
    // a setup that needs a closed m15 bar to exist.
    setInterval(tick, 15 * 60 * 1000);
  })();
}
