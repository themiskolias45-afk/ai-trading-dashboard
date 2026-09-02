#!/usr/bin/env node
'use strict';
/**
 * CRT + FVG -- the live runner, shadow by default.
 *
 * The combination the user has asked for repeatedly, traded manually by him for +68 GBP
 * on gold, and the measurement backs the instinct: it has the LARGEST EDGE OVER A MATCHED
 * CONTROL of anything measured on 2026-09-02. Full period, h4 bias / m15 execution,
 * 0.25xATR stop buffer + EMA21 reclaim:
 *
 *   377 trades | 61.3% WR | gross +0.1839 | net +0.1414 | 5 folds of 5
 *   control    -0.3585 at 0 of 5 folds     ->  EDGE +0.4999
 *
 * HE ENTERS ON THE RETEST, AND SO DOES THIS. That is not a coincidence to note in passing:
 * the retest is the entry rule the edge is attached to. Touching the gap is what gets
 * measured; chasing the displacement is a different trade with none of these numbers.
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
 * PARITY WITH THE MEASURED MODEL IS THE WHOLE POINT, and the first draft of this file
 * broke it three ways. Each is corrected here and named so it is not reintroduced:
 *   1. TARGET. modelCrtFvg targets `crt.objective` capped at 5R, NOT a flat 5R. A flat
 *      target is a different exit and carries none of the measured numbers.
 *   2. COOLDOWN. modelCrtFvg has no cooldown -- that belongs to the pullback and FVG
 *      models. A 20-bar cooldown here would suppress setups the measurement counted,
 *      which is a signal blocked by a constant nobody measured.
 *   3. SWEEP AGE. The gap search starts 60 exec bars after the sweep closes and runs for
 *      SEARCH+RETEST=80 more, so a sweep is live between 15h and ~35h old. Scanning only
 *      the last 4 h4 bars, as the draft did, left a one-hour overlap: it would have run
 *      for weeks and fired almost never, and read as "the market has no setups".
 *
 * THE MODEL:
 *   sweep      detectCRT on the h4 bias timeframe, point-in-time (barsAgo === 0)
 *   as-of      a bias bar opening at t is not known until t + 14400
 *   gap        the first same-direction FVG on m15, searched from 60 bars after that
 *   entry      price retraces to the gap's near edge, on THIS bar
 *   confirm    EMA21 reclaim on the entry bar -- the layer worth +0.1414 vs +0.0003
 *   stop       the sweep extreme, widened by 0.25 x ATR14(m15)
 *              (at the raw extreme the model is NEGATIVE: -0.0362 net, 2/5 folds)
 *   target     crt.objective, capped at 5R
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

// The measured configuration, matching tasks/strategy_suite.cjs defaults exactly. Changing
// one without re-running the walk-forward makes this a different model wearing the
// measured model's numbers.
const BIAS_WINDOW  = 100;   // --window     h4 bars handed to detectCRT
const EXEC_WINDOW  = 60;    // --execwindow m15 bars handed to detectFVGs, and the delay
const SEARCH_BARS  = 40;    // --search     m15 bars allowed to form the gap
const RETEST_BARS  = 40;    // --retest     m15 bars allowed for the retest
const MAX_RR       = 5;     // --maxrr      cap on crt.objective, never a flat target
const STOP_BUF_ATR = 0.25;  // --stopbuf
const ATR_LEN      = 14;
const MIN_STOP_SPREADS = 3;
// Derived, not chosen: the oldest sweep that can still retest on the current bar is
// (60 + 40 + 40) exec bars back, which is 35h of m15 -- 8.75 h4 bars. 12 covers it with
// margin. Widening this only lets older sweeps be considered; it changes no entry rule.
const SWEEP_LOOKBACK = 12;

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
function ledgerKeys() {
  if (!fs.existsSync(LEDGER)) return new Set();
  const out = new Set();
  for (const raw of fs.readFileSync(LEDGER, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try { out.add(JSON.parse(line).key); } catch (e) { /* corrupt row skipped */ }
  }
  return out;
}

// One sweep, followed all the way to an entry on the CURRENT bar or not at all.
// Returns a reason string on failure so --why can say which link broke.
function chainFromSweep(bias, exec, b, crt) {
  const ei = exec.closes.length - 1;
  const direction = crt.direction === "bearish" ? "bearish" : "bullish";
  const knownAt = bias.times[b] + H4_SECONDS;
  let start = 0;
  while (start < exec.times.length && exec.times[start] < knownAt) start++;
  if (start + EXEC_WINDOW >= exec.times.length) return { fail: "SWEEP TOO RECENT" };

  let zone = null, zoneIdx = -1;
  const end = Math.min(start + EXEC_WINDOW + SEARCH_BARS, exec.times.length);
  for (let j = start + EXEC_WINDOW; j < end; j++) {
    const f = detectFVGs(slice(exec, j - EXEC_WINDOW + 1, j + 1), { maxZones: 6, includeFilled: true });
    const fresh = f && f.zones ? f.zones.find(z => z.barsAgo === 0 && z.direction === direction) : null;
    if (fresh) { zone = fresh; zoneIdx = j; break; }
  }
  if (!zone) return { fail: "NO SAME-DIRECTION FVG" };

  const entry = direction === "bullish" ? zone.top : zone.bottom;
  let eIdx = -1;
  const rEnd = Math.min(zoneIdx + 1 + RETEST_BARS, exec.times.length);
  for (let k = zoneIdx + 1; k < rEnd; k++) {
    const touched = direction === "bullish" ? exec.lows[k] <= entry : exec.highs[k] >= entry;
    if (touched) { eIdx = k; break; }
  }
  if (eIdx === -1) return { fail: "NOT RETESTED YET" };
  // The entry must be THIS bar. An earlier retest is a trade the runner missed, and
  // filling it now at a different price is not the trade that was measured.
  if (eIdx !== ei) return { fail: "RETEST WAS " + (ei - eIdx) + " BARS AGO" };

  const e21 = emaAt(exec.closes, eIdx, 21);
  if (e21 === null) return { fail: "EMA21 UNAVAILABLE" };
  const reclaimed = direction === "bullish" ? exec.closes[eIdx] > e21 : exec.closes[eIdx] < e21;
  if (!reclaimed) return { fail: "NO EMA21 RECLAIM" };

  const atr = atrAt(exec.highs, exec.lows, exec.closes, eIdx, ATR_LEN);
  if (!atr || atr <= 0) return { fail: "ATR UNAVAILABLE" };
  const stop = direction === "bullish" ? crt.invalidation - STOP_BUF_ATR * atr
                                       : crt.invalidation + STOP_BUF_ATR * atr;

  // Target is the sweep's own objective, capped at MAX_RR -- what modelCrtFvg measured.
  const risk = Math.abs(entry - stop);
  let target = crt.objective;
  const sane = direction === "bullish" ? (stop < entry && target > entry)
                                       : (stop > entry && target < entry);
  if (!sane || !(risk > 0)) return { fail: "STOP OR OBJECTIVE ON THE WRONG SIDE" };
  const reward = Math.abs(target - entry);
  if (reward / risk > MAX_RR) {
    target = direction === "bullish" ? entry + MAX_RR * risk : entry - MAX_RR * risk;
  }
  return { direction, entry, stop, target, risk, eIdx, crt };
}

function evaluate(assetKey, symbol, bias, exec, trace) {
  const note = (k, v) => { if (trace) trace[k] = v; };
  const bi = bias.closes.length - 1, ei = exec.closes.length - 1;
  note("biasBars", bi + 1); note("execBars", ei + 1);
  if (bi < BIAS_WINDOW + 2 || ei < EXEC_WINDOW + 2) { note("stop", "NOT ENOUGH BARS"); return null; }

  // Walk the recent sweeps newest first and take the first that completes a chain onto
  // this bar. Newest first because a fresher sweep is the more relevant liquidity event
  // when two would both qualify; at most one row per bar is emitted either way.
  let sweeps = 0;
  const fails = [];
  for (let b = bi; b >= Math.max(BIAS_WINDOW, bi - SWEEP_LOOKBACK + 1); b--) {
    const found = detectCRT(slice(bias, b - BIAS_WINDOW + 1, b + 1), { maxPatterns: 5 });
    const crt = found && found.patterns ? found.patterns.find(x => x.barsAgo === 0) : null;
    if (!crt) continue;
    sweeps++;
    const chain = chainFromSweep(bias, exec, b, crt);
    if (chain.fail) { fails.push((bi - b) + "h4ago:" + chain.fail); continue; }

    const sp = SPREAD[symbol] ?? SPREAD[assetKey];
    if (sp && chain.risk < MIN_STOP_SPREADS * sp) {
      fails.push((bi - b) + "h4ago:STOP UNDER 3x SPREAD"); continue;
    }
    note("sweepsScanned", sweeps); note("stop", "SETUP");
    return {
      key: assetKey + "|" + exec.times[chain.eIdx] + "|crt",
      asset: assetKey, symbol,
      direction: chain.direction === "bullish" ? "BUY" : "SELL",
      entry: chain.entry, stop: chain.stop, target: chain.target,
      risk: chain.risk, rr: Math.abs(chain.target - chain.entry) / chain.risk,
      riskPct: chain.entry ? (chain.risk / chain.entry) * 100 : null,
      entryBarTime: exec.times[chain.eIdx], sweepBarsAgo: bi - b,
      sweepExtreme: chain.crt.invalidation, sweptSide: chain.crt.sweptSide,
      model: "CRT_FVG", measuredNetR: 0.1414,
      shadow: true, feedsTheGate: false,
      seenAt: new Date().toISOString(),
    };
  }
  note("sweepsScanned", sweeps);
  note("stop", sweeps ? fails.join(" | ") : "NO CRT SWEEP IN THE LAST " + SWEEP_LOOKBACK + " H4 BARS");
  return null;
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

  const known = ledgerKeys();
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
      + " target " + setup.target.toFixed(2) + " " + setup.rr.toFixed(2) + "R"
      + " risk " + setup.riskPct.toFixed(3) + "%");
  }
  if (!found) console.log("[crt] " + new Date().toISOString() + " no new setups");
}

module.exports = { evaluate, chainFromSweep };

if (require.main === module) {
  (async () => {
    console.log("CRT + FVG runner -- SHADOW ONLY, places no orders. host " + HOST);
    await tick();
    if (ONCE) return;
    setInterval(tick, 15 * 60 * 1000);
  })();
}
