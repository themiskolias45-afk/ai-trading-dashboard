#!/usr/bin/env node
'use strict';
/**
 * CRT + FVG -- the live runner, shadow by default.
 *
 * The combination the user has asked for repeatedly, and the measurement backs the
 * instinct: it has the LARGEST EDGE OVER A MATCHED CONTROL of anything measured on
 * 2026-09-02. Full period, h4 bias / m15 execution, 0.25xATR stop buffer + EMA21 reclaim:
 *
 *   377 trades | 61.3% WR | gross +0.1839 | net +0.1414 | 5 folds of 5
 *   control    -0.3585 at 0 of 5 folds     ->  EDGE +0.4999
 *
 * WHAT THE MEASUREMENT ALSO SAYS, kept here rather than left out. On a 60/40 date split
 * the held-out half returns +0.0627, not +0.1414; 80-86% of the long-side gross sits in
 * five rows; and the last 90 days are slightly negative. Beating random by half an R and
 * being profitable are different claims, and only the first is established.
 *
 * WHICH IS EXACTLY WHY IT RUNS. Another backtest cannot separate "a real edge with thin
 * absolute expectancy" from "five lucky rows" -- live setups can. It records in shadow
 * beside FVG continuation and TK, on the same feed, scored by the same tool, so in a few
 * weeks the three are comparable on data none of them was fitted to.
 *
 * THE MODEL:
 *   sweep      detectCRT on the h4 bias timeframe, point-in-time (barsAgo === 0)
 *   as-of      a bias bar opening at t is not known until t + 14400
 *   gap        first same-direction FVG forming on m15 after the sweep is known
 *   entry      price retraces to the gap's near edge
 *   confirm    EMA21 reclaim on the entry bar -- the layer worth +0.1414 - 0.0003
 *   stop       the sweep extreme, widened by 0.25 x ATR14(m15)
 *              (at the raw extreme the model is NEGATIVE: -0.0362 net, 2/5 folds)
 *   target     capped at 5R
 *
 * BOTH DIRECTIONS. Unlike TK, this model is positive on both sides -- SELL +0.1830 net at
 * 4/5, BUY +0.1068 at 4/5 -- so neither is hard-coded away.
 *
 *   node tasks/crt_runner.cjs [--once] [--why] [--host http://localhost:3001]
 *
 * WRITES tasks/crt_shadow.jsonl, append-only. Places no orders, touches no gate,
 * threshold, position, setting or learning file.
 */

const fs   = require("fs");
const path = require("path");
const http = require("http");

const ROOT   = path.join(__dirname, "..");
const LEDGER = path.join(ROOT, "tasks", "crt_shadow.jsonl");
const { detectCRT }  = require(path.join(ROOT, "server", "structure.js"));
const { detectFVGs } = require(path.join(ROOT, "server", "fvg.js"));

function strArg(f, d) { const i = process.argv.indexOf(f); return (i === -1 || i + 1 >= process.argv.length) ? d : process.argv[i + 1]; }
const HOST = strArg("--host", "http://localhost:3001");
const ONCE = process.argv.includes("--once");
const WHY  = process.argv.includes("--why");

// The measured configuration. Changing one without re-running the walk-forward makes this
// a different model wearing the measured model's numbers.
const BIAS_WINDOW  = 100;   // h4 bars handed to detectCRT
const EXEC_WINDOW  = 60;    // m15 bars handed to detectFVGs
const SEARCH_BARS  = 40;    // m15 bars allowed to form the gap
const RETEST_BARS  = 40;    // m15 bars allowed for the retest
const MAX_RR       = 5;
const STOP_BUF_ATR = 0.25;
const ATR_LEN      = 14;
const COOLDOWN_BARS = 20;
const MIN_STOP_SPREADS = 3;
const SPREAD = { XAUUSD: 0.22, BTCUSD: 17.00, SP500: 0.36, gold: 0.22, btc: 17.00, spx: 0.36 };
const H4_SECONDS = 14400;

function get(p) {
  return new Promise((resolve, reject) => {
    const req = http.get(HOST + p, { timeout: 8000 }, (res) => {
      let b = "";
      res.on("data", c => { b += c; });
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error(p + " HTTP " + res.statusCode));
        try { resolve(JSON.parse(b)); } catch (e) { reject(new Error("non-JSON from " + p)); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout " + p)); });
  });
}
const slice = (b, from, to) => ({
  highs: b.highs.slice(from, to), lows: b.lows.slice(from, to),
  closes: b.closes.slice(from, to), times: (b.times || []).slice(from, to),
});
function emaAt(src, end, len) {
  const from = Math.max(0, end - len * 4);
  if (end - from < len) return null;
  let sum = 0;
  for (let i = from; i < from + len; i++) sum += src[i];
  let e = sum / len;
  const k = 2 / (len + 1);
  for (let i = from + len; i <= end; i++) e = src[i] * k + e * (1 - k);
  return e;
}
function atrAt(h, l, c, end, len) {
  if (end < len + 1) return null;
  let sum = 0;
  for (let i = end - len + 1; i <= end; i++) {
    sum += Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
  }
  return sum / len;
}
function ledgerRows() {
  if (!fs.existsSync(LEDGER)) return [];
  const out = [];
  for (const raw of fs.readFileSync(LEDGER, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch (e) { /* corrupt row skipped */ }
  }
  return out;
}

function evaluate(assetKey, symbol, bias, exec, trace) {
  const note = (k, v) => { if (trace) trace[k] = v; };
  const bi = bias.closes.length - 1, ei = exec.closes.length - 1;
  note("biasBars", bi + 1); note("execBars", ei + 1);
  if (bi < BIAS_WINDOW + 2 || ei < EXEC_WINDOW + 2) { note("stop", "NOT ENOUGH BARS"); return null; }

  // Cooldown, from the FILE so a restart cannot forget it -- the same fix the FVG runner
  // needed when it fired 29% more often than the model it claimed to implement.
  const prior = ledgerRows().filter(r => r.asset === assetKey && Number.isFinite(r.entryBarTime));
  const lastEntry = prior.length ? Math.max(...prior.map(r => r.entryBarTime)) : null;
  if (lastEntry !== null && exec.times && exec.times[ei]) {
    const barSec = exec.times.length > 1 ? (exec.times[ei] - exec.times[ei - 1]) : 900;
    if (exec.times[ei] - lastEntry < COOLDOWN_BARS * barSec) { note("stop", "COOLDOWN"); return null; }
  }

  // The sweep must complete on the LAST CLOSED h4 bar, or on one recent enough that its
  // gap could still be forming.
  let crt = null, crtBar = -1;
  for (let b = bi; b >= Math.max(BIAS_WINDOW, bi - 3); b--) {
    const found = detectCRT(slice(bias, b - BIAS_WINDOW + 1, b + 1), { maxPatterns: 5 });
    const p = found && found.patterns ? found.patterns.find(x => x.barsAgo === 0) : null;
    if (p) { crt = p; crtBar = b; break; }
  }
  note("crtSweep", crt ? (crt.direction + " sweep of the " + crt.sweptSide) : "none in the last 4 h4 bars");
  if (!crt) { note("stop", "NO CRT SWEEP"); return null; }

  const direction = crt.direction === "bearish" ? "bearish" : "bullish";
  const knownAt = bias.times[crtBar] + H4_SECONDS;
  let start = 0;
  while (start < exec.times.length && exec.times[start] < knownAt) start++;
  if (start === -1 || start + EXEC_WINDOW >= exec.times.length) { note("stop", "SWEEP NOT YET CLOSED"); return null; }

  let zone = null, zoneIdx = -1, scanned = 0;
  for (let j = start + EXEC_WINDOW; j < Math.min(start + EXEC_WINDOW + SEARCH_BARS, exec.times.length); j++) {
    scanned++;
    const f = detectFVGs(slice(exec, j - EXEC_WINDOW + 1, j + 1), { maxZones: 6, includeFilled: true });
    const fresh = f && f.zones ? f.zones.find(z => z.barsAgo === 0 && z.direction === direction) : null;
    if (fresh) { zone = fresh; zoneIdx = j; break; }
  }
  note("gapSearchBars", scanned);
  if (!zone) { note("stop", "NO SAME-DIRECTION FVG AFTER THE SWEEP"); return null; }

  const entry = direction === "bullish" ? zone.top : zone.bottom;
  let eIdx = -1;
  for (let k = zoneIdx + 1; k < Math.min(zoneIdx + 1 + RETEST_BARS, exec.times.length); k++) {
    const touched = direction === "bullish" ? exec.lows[k] <= entry : exec.highs[k] >= entry;
    if (touched) { eIdx = k; break; }
  }
  if (eIdx === -1) { note("stop", "GAP FOUND, PRICE HAS NOT RETESTED IT YET"); return null; }
  if (eIdx !== ei) { note("stop", "RETEST ALREADY HAPPENED ON AN EARLIER BAR"); return null; }

  const e21 = emaAt(exec.closes, eIdx, 21);
  if (e21 === null) { note("stop", "EMA21 UNAVAILABLE"); return null; }
  const reclaimed = direction === "bullish" ? exec.closes[eIdx] > e21 : exec.closes[eIdx] < e21;
  note("emaReclaim", reclaimed);
  if (!reclaimed) { note("stop", "NO EMA21 RECLAIM ON THE ENTRY BAR"); return null; }

  const atr = atrAt(exec.highs, exec.lows, exec.closes, eIdx, ATR_LEN);
  if (!atr || atr <= 0) { note("stop", "ATR UNAVAILABLE"); return null; }
  const stop = direction === "bullish" ? crt.invalidation - STOP_BUF_ATR * atr
                                       : crt.invalidation + STOP_BUF_ATR * atr;
  const risk = Math.abs(entry - stop);
  const ok = direction === "bullish" ? (stop < entry) : (stop > entry);
  if (!ok || !(risk > 0)) { note("stop", "STOP ON THE WRONG SIDE OF ENTRY"); return null; }
  const sp = SPREAD[symbol] ?? SPREAD[assetKey];
  if (sp && risk < MIN_STOP_SPREADS * sp) { note("stop", "STOP UNDER 3x SPREAD"); return null; }

  note("stop", "SETUP");
  return {
    key: assetKey + "|" + exec.times[eIdx] + "|crt",
    asset: assetKey, symbol,
    direction: direction === "bullish" ? "BUY" : "SELL",
    entry, stop, target: direction === "bullish" ? entry + MAX_RR * risk : entry - MAX_RR * risk,
    risk, rr: MAX_RR, riskPct: entry ? (risk / entry) * 100 : null,
    entryBarTime: exec.times[eIdx], sweepExtreme: crt.invalidation,
    gapTop: zone.top, gapBottom: zone.bottom,
    model: "CRT_FVG", measuredNetR: 0.1414,
    shadow: true, feedsTheGate: false,
    seenAt: new Date().toISOString(),
  };
}

async function tick() {
  let raw;
  try { raw = await get("/api/mt5/candles/raw"); }
  catch (e) { console.error("[crt] cannot read bars: " + e.message); return; }
  const assets = raw && raw.assets ? raw.assets : null;
  if (!assets) { console.error("[crt] no assets in the candle dump"); return; }
  if (!Object.keys(assets).length) {
    console.error("[crt] CANDLE CACHE EMPTY -- the bridge has not pushed since the last "
      + "server restart. Not a market state; nothing was evaluated.");
    return;
  }

  const known = new Set(ledgerRows().map(r => r.key));
  let found = 0;
  for (const key of Object.keys(assets)) {
    const entry = assets[key];
    const b = entry && entry.bars ? entry.bars : null;
    if (!b || !b.h4 || !b.m15) { if (WHY) console.log("[why] " + key + ": no h4/m15 bars"); continue; }
    const trace = WHY ? {} : null;
    const setup = evaluate(key, entry.symbol || key, b.h4, b.m15, trace);
    if (WHY) console.log("[why] " + (entry.symbol || key) + ": "
      + Object.entries(trace).map(([k, v]) => k + "=" + v).join("  "));
    if (!setup || known.has(setup.key)) continue;
    fs.appendFileSync(LEDGER, JSON.stringify(setup) + "\n", "utf8");
    found++;
    console.log("[crt] SHADOW " + setup.symbol + " " + setup.direction
      + " entry " + setup.entry.toFixed(2) + " stop " + setup.stop.toFixed(2)
      + " target " + setup.target.toFixed(2) + " risk " + setup.riskPct.toFixed(3) + "%");
  }
  if (!found) console.log("[crt] " + new Date().toISOString() + " no new setups");
}

module.exports = { evaluate };

if (require.main === module) {
  (async () => {
    console.log("CRT + FVG runner -- SHADOW ONLY, places no orders. host " + HOST);
    await tick();
    if (ONCE) return;
    setInterval(tick, 15 * 60 * 1000);
  })();
}
