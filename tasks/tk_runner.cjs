#!/usr/bin/env node
'use strict';
/**
 * TK SWING TREND PULLBACK -- the live runner, shadow by default.
 *
 * His own strategy, which until now existed only in TradingView. The system could not
 * trade it. This finds the same setups against the live bridge feed and records them in
 * the shape tasks/fvg_executor.py already knows how to place.
 *
 * THE MODEL, transcribed from TK_Swing_Trend_Pullback_v2 (303 lines) and measured at
 * +0.2145 net R per trade pooled across XAUUSD, BTCUSD and SP500, 5 folds of 5, +117R:
 *
 *   uptrend    ema21 > ema50 AND ema21 > ema21[slope]
 *   momentum   highest(high - ema50, 15) > pushAtr * atr     (inert below ~1, kept for fidelity)
 *   pullback   low <= ema21 + tol*atr AND close >= ema21 - tol*atr
 *              AND close > open AND close > ema50
 *   filter     rsi(14) > 40
 *   stop       min(lowest(low,5), ema21) - 1.5*atr
 *   target     entry + 2R
 *
 * LONG ONLY, AND THAT IS THE POINT. enableShorts defaults TRUE in his v2 and the short
 * side loses on every timeframe and every asset -- H4 pooled PF 0.850, 1 fold of 5.
 * Disabling it moves the pooled result from +0.0393 to +0.2145 R per trade. This runner
 * simply never looks at the short side.
 *
 * HIS LIVE PANEL VALUES ARE THE DEFAULTS HERE, not the script's: EMA 21/51, slope 1,
 * push 0.5, tolerance 0.55, ATR 12. A 192-configuration out-of-sample search could not
 * beat them -- every candidate lost on the held-out half AND on both instruments it had
 * never seen.
 *
 * NO TRADE MANAGEMENT. v2's factory engine (partial at 1.5R, break-even, R-ratchet) was
 * measured against v1's ATR trail and against no management at all on the same entries:
 * held-out +0.2685 / +0.3015 / +0.3180. The engine is the weakest of the three. A plain
 * 1.5xATR stop and a 2R target is what ships, and the broker holds both.
 *
 *   node tasks/tk_runner.cjs [--once] [--why] [--host http://localhost:3001]
 *
 * H4 CADENCE. A setup can only exist on a CLOSED 4-hour bar, so running more often than
 * that cannot find one -- it can only re-find the same one. The dedupe key is the bar
 * time, so a re-run inside the same bar records nothing twice.
 *
 * WRITES ONE FILE: tasks/tk_shadow.jsonl, append-only. Places no orders, touches no gate,
 * threshold, position, setting or learning file.
 */

const fs   = require("fs");
const path = require("path");
const http = require("http");

const ROOT   = path.join(__dirname, "..");
const LEDGER = path.join(ROOT, "tasks", "tk_shadow.jsonl");

function strArg(f, d) { const i = process.argv.indexOf(f); return (i === -1 || i + 1 >= process.argv.length) ? d : process.argv[i + 1]; }
function numArg(f, d) { const i = process.argv.indexOf(f); if (i === -1 || i + 1 >= process.argv.length) return d; const v = Number(process.argv[i + 1]); return Number.isFinite(v) ? v : d; }

const HOST    = strArg("--host", "http://localhost:3001");
const ONCE    = process.argv.includes("--once");
const WHY     = process.argv.includes("--why");

// His live panel values, 2026-09-02.
const EMA_FAST = 21, EMA_SLOW = 51, SLOPE = 1;
const PUSH_LB = 15, PUSH_ATR = 0.5;
const TOL = 0.55, RSI_LEN = 14, RSI_MIN = 40;
const ATR_LEN = 12, ATR_SL = 1.5, RR = 2.0, SWING_LB = 5;
// The measurement drops any trade whose stop is under 3x the spread; without the same
// rule here the runner records setups the backtest never counted.
const MIN_STOP_SPREADS = 3;
const SPREAD = { XAUUSD: 0.22, BTCUSD: 17.00, SP500: 0.36, gold: 0.22, btc: 17.00, spx: 0.36 };

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

// Pine's ta.ema / ta.atr / ta.rsi. Written out rather than borrowed: calcRSI in this
// project was measured NOT to be Wilder once, and it moved every downstream number.
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
function rsiAt(c, end, len) {
  const from = Math.max(1, end - len * 5);
  if (end - from < len) return null;
  let g = 0, ls = 0;
  for (let i = from; i < from + len; i++) {
    const d = c[i] - c[i - 1];
    if (d >= 0) g += d; else ls -= d;
  }
  let ag = g / len, al = ls / len;
  for (let i = from + len; i <= end; i++) {
    const d = c[i] - c[i - 1];
    ag = (ag * (len - 1) + (d > 0 ? d : 0)) / len;
    al = (al * (len - 1) + (d < 0 ? -d : 0)) / len;
  }
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}
const highestIn = (a, end, n) => { let m = -Infinity; for (let i = Math.max(0, end - n + 1); i <= end; i++) m = Math.max(m, a[i]); return m; };
const lowestIn  = (a, end, n) => { let m =  Infinity; for (let i = Math.max(0, end - n + 1); i <= end; i++) m = Math.min(m, a[i]); return m; };

function alreadyLogged(key) {
  if (!fs.existsSync(LEDGER)) return false;
  for (const raw of fs.readFileSync(LEDGER, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try { if (JSON.parse(line).key === key) return true; } catch (e) { /* skip corrupt */ }
  }
  return false;
}

/** Long-only, evaluated on the last CLOSED h4 bar. */
function evaluate(assetKey, symbol, h4, trace) {
  const note = (k, v) => { if (trace) trace[k] = v; };
  const { highs, lows, closes, opens, times } = h4;
  if (!opens) { note("stop", "NO OPEN PRICES IN THE FEED"); return null; }
  const i = closes.length - 1;
  note("bars", closes.length);
  if (i < EMA_SLOW * 4) { note("stop", "NOT ENOUGH BARS"); return null; }

  const e21 = emaAt(closes, i, EMA_FAST), e50 = emaAt(closes, i, EMA_SLOW);
  const e21p = emaAt(closes, i - SLOPE, EMA_FAST);
  const atr = atrAt(highs, lows, closes, i, ATR_LEN);
  const rsi = rsiAt(closes, i, RSI_LEN);
  if ([e21, e50, e21p, atr, rsi].some(v => v === null)) { note("stop", "INDICATOR UNAVAILABLE"); return null; }

  // Both halves reported separately. "uptrend=false" with only the EMA values shown is
  // ambiguous when ema21 > ema50 but the slope has rolled over -- which is exactly BTC's
  // state on the first run, and reading it as a stack failure would be wrong.
  const stackOk = e21 > e50, slopeOk = e21 > e21p;
  note("emaStack", stackOk + " (21:" + e21.toFixed(2) + " 50:" + e50.toFixed(2) + ")");
  note("ema21Rising", slopeOk);
  if (!stackOk) { note("stop", "EMA21 NOT ABOVE EMA50"); return null; }
  if (!slopeOk) { note("stop", "EMA21 NOT RISING"); return null; }

  const push = highestIn(highs.map((h, k) => h - e50), i, PUSH_LB) > PUSH_ATR * atr;
  note("momentumPush", push);
  if (!push) { note("stop", "NO MOMENTUM PUSH"); return null; }

  const tol = TOL * atr;
  const touch = lows[i] <= e21 + tol && closes[i] >= e21 - tol;
  note("pullbackTouch", touch);
  if (!touch) { note("stop", "PRICE NOT AT THE EMA21 ZONE"); return null; }

  const bullClose = closes[i] > opens[i];
  note("bullishClose", bullClose);
  if (!bullClose) { note("stop", "ENTRY BAR NOT BULLISH"); return null; }
  if (!(closes[i] > e50)) { note("stop", "CLOSE BELOW EMA50"); return null; }

  note("rsi", rsi.toFixed(1));
  if (!(rsi > RSI_MIN)) { note("stop", "RSI BELOW " + RSI_MIN); return null; }

  const entry = closes[i];
  const stop  = Math.min(lowestIn(lows, i, SWING_LB), e21) - ATR_SL * atr;
  const risk  = entry - stop;
  if (!(risk > 0)) { note("stop", "NON-POSITIVE RISK"); return null; }
  const sp = SPREAD[symbol] ?? SPREAD[assetKey];
  if (sp && risk < MIN_STOP_SPREADS * sp) { note("stop", "STOP UNDER 3x SPREAD"); return null; }

  note("stop", "SETUP");
  return {
    key: assetKey + "|" + (times ? times[i] : i) + "|tk",
    asset: assetKey, symbol, direction: "BUY",
    entry, stop, target: entry + RR * risk, risk,
    rr: RR, riskPct: entry ? (risk / entry) * 100 : null,
    entryBarTime: times ? times[i] : null,
    model: "TK_SWING_PULLBACK", measuredNetR: 0.2145,
    shadow: true, feedsTheGate: false,
    seenAt: new Date().toISOString(),
  };
}

async function tick() {
  let raw;
  try { raw = await get("/api/mt5/candles/raw"); }
  catch (e) { console.error("[tk] cannot read bars: " + e.message); return; }
  const assets = raw && raw.assets ? raw.assets : null;
  if (!assets) { console.error("[tk] no assets in the candle dump"); return; }

  let found = 0;
  for (const key of Object.keys(assets)) {
    const entry = assets[key];
    const h4 = entry && entry.bars ? entry.bars.h4 : null;
    if (!h4 || !h4.closes) { if (WHY) console.log("[why] " + key + ": no h4 bars"); continue; }
    const trace = WHY ? {} : null;
    const setup = evaluate(key, entry.symbol || key, h4, trace);
    if (WHY) {
      console.log("[why] " + (entry.symbol || key) + ": "
        + Object.entries(trace).map(([k, v]) => k + "=" + v).join("  "));
    }
    if (!setup) continue;
    if (alreadyLogged(setup.key)) { if (WHY) console.log("[tk] " + key + ": already recorded"); continue; }
    fs.appendFileSync(LEDGER, JSON.stringify(setup) + "\n", "utf8");
    found++;
    console.log("[tk] SHADOW " + setup.symbol + " BUY entry " + setup.entry.toFixed(2)
      + " stop " + setup.stop.toFixed(2) + " target " + setup.target.toFixed(2)
      + " risk " + setup.riskPct.toFixed(3) + "%");
  }
  if (!found) console.log("[tk] " + new Date().toISOString() + " no new setups");
}

module.exports = { evaluate };

if (require.main === module) {
  (async () => {
    console.log("TK SWING PULLBACK runner -- LONG ONLY, SHADOW ONLY, places no orders. host " + HOST);
    await tick();
    if (ONCE) return;
    setInterval(tick, 15 * 60 * 1000);
  })();
}
