#!/usr/bin/env node
'use strict';
/**
 * THE FIVE STRATEGIES, ON THE THREE ASSETS, UNDER ONE MEASUREMENT.
 *
 * Three of the five had never been measured at all -- not rejected, never asked. This
 * builds them and scores every model the same way so the numbers can be read against each
 * other instead of against five different harnesses' conventions:
 *
 *   crtfvg      CRT sweep + reclaim -> same-direction FVG -> entry on the retest
 *   emarev      the same, but requiring an EMA21 RECLAIM on the entry bar
 *               (liquidity sweep + structure shift + displacement + EMA reclaim + FVG)
 *   pullback    swing trend continuation: HH/HL intact, pullback into the EMA21-50 value
 *               zone, entry on the rejection back in trend direction
 *   fvgcont     trend + DISPLACEMENT bar + the FVG that bar created + retrace + entry
 *               (deliberately NOT "price touched an FVG", which is measured as dead)
 *
 * WHY THEY SHARE ONE FILE. Every model gets: broker bars only, point-in-time detection,
 * an as-of join on CLOSE times, a stop and a target in price, ambiguous-bar-is-a-loss,
 * marked-to-market at the horizon rather than scored flat, five chronological folds, and
 * a MATCHED CONTROL -- the same direction with the same stop and target distances entered
 * at an unrelated earlier bar. Without the control a 60% win rate on a wide target reads
 * as edge when it is geometry.
 *
 *   node tasks/strategy_suite.cjs [--models crtfvg,emarev,pullback,fvgcont]
 *                                 [--bias h4] [--exec m15] [--hold 960] [--maxrr 5]
 *                                 [--symbols XAUUSD,BTCUSD,SP500] [--htf]
 *
 *   --htf   additionally require full HTF alignment (EMA50/200 on the bias timeframe),
 *           the one filter that survived an out-of-sample test on 2026-09-02.
 *
 * READ-ONLY. Reads tasks/history/*.csv, writes a report to tasks/analysis. No gate,
 * threshold, setting, position or learning file is touched. feedsTheGate: false.
 */

const fs   = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const { detectCRT, detectAMD } = require(path.join(ROOT, "server", "structure.js"));
const { detectFVGs } = require(path.join(ROOT, "server", "fvg.js"));

// Measured from the live MT5 terminal 2026-09-02 (symbol_info().spread * point, after
// selecting the symbol into Market Watch and waiting for a tick -- an unselected symbol
// reports spread 0, which reads as a free instrument). Spread ONLY: commission, swap on a
// held position and slippage through a fast stop are all real and none is modelled, so a
// model that only just survives this is NOT surviving.
const SPREAD = { XAUUSD: 0.22, BTCUSD: 17.00, SP500: 0.36 };

const TF_SECONDS = { d1: 86400, h4: 14400, h1: 3600, m15: 900 };
const TF_FILE    = { d1: "D1", h4: "H4", h1: "H1", m15: "M15" };

function strArg(f, d) { const i = process.argv.indexOf(f); return (i === -1 || i + 1 >= process.argv.length) ? d : process.argv[i + 1]; }
function numArg(f, d) { const i = process.argv.indexOf(f); if (i === -1 || i + 1 >= process.argv.length) return d; const v = Number(process.argv[i + 1]); return Number.isFinite(v) ? v : d; }

const BIAS_TF     = strArg("--bias", "h4").toLowerCase();
const EXEC_TF     = strArg("--exec", "m15").toLowerCase();
const MAX_HOLD    = numArg("--hold", 960);
const MAX_RR      = numArg("--maxrr", 5);
const FOLDS       = Math.max(2, numArg("--folds", 5));
const WINDOW      = numArg("--window", 100);
const EXEC_WINDOW = numArg("--execwindow", 60);
const SEARCH      = numArg("--search", 40);
const RETEST      = numArg("--retest", 40);
const CONTROL_OFFSET = numArg("--controloffset", 137);
const REQUIRE_HTF = process.argv.includes("--htf");
// Exposed for the robustness sweep. A result that exists only at one value of a knob the
// author chose is fitted; a result that holds across a plateau is a property of the
// market. Nobody had asked this of FVG continuation, whose 1.5 / 5R / 40 were all picked
// by hand.
const DISP_ATR = numArg("--disp", 1.5);
const SYMBOLS = strArg("--symbols", "XAUUSD,BTCUSD,SP500").split(",").map(s => s.trim());
const MODELS  = strArg("--models", "crtfvg,emarev,pullback,fvgcont").split(",").map(s => s.trim());

function loadBars(symbol, tf) {
  const file = path.join(ROOT, "tasks", "history", symbol + "_" + TF_FILE[tf] + ".csv");
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  lines.shift();
  const times = [], highs = [], lows = [], closes = [];
  for (const raw of lines) {
    const p = raw.trim().split(",");
    if (p.length < 5) continue;
    const t = Number(p[0]), h = Number(p[2]), l = Number(p[3]), c = Number(p[4]);
    if (!(Number.isFinite(t) && Number.isFinite(h) && Number.isFinite(l) && Number.isFinite(c))) continue;
    times.push(t); highs.push(h); lows.push(l); closes.push(c);
  }
  return { times, highs, lows, closes };
}
const slice = (b, from, to) => ({
  highs: b.highs.slice(from, to), lows: b.lows.slice(from, to),
  closes: b.closes.slice(from, to), times: b.times.slice(from, to),
});

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

// TREND on the bias timeframe, at a point in time. Used both as the pullback model's own
// premise and as the optional --htf filter on every other model.
function htfAligned(bias, idx, direction) {
  const e50 = emaAt(bias.closes, idx, 50), e200 = emaAt(bias.closes, idx, 200);
  if (e50 === null || e200 === null) return false;
  const px = bias.closes[idx];
  return direction === "bullish" ? (e50 > e200 && px > e50) : (e50 < e200 && px < e50);
}
// HH/HL over the last 20 bias bars against the 20 before them.
function swingTrend(bias, idx) {
  if (idx < 40) return null;
  const rFrom = idx - 19, pFrom = idx - 39;
  const mx = (a, x, y) => Math.max.apply(null, a.slice(x, y));
  const mn = (a, x, y) => Math.min.apply(null, a.slice(x, y));
  const rh = mx(bias.highs, rFrom, idx + 1), rl = mn(bias.lows, rFrom, idx + 1);
  const ph = mx(bias.highs, pFrom, rFrom),  pl = mn(bias.lows, pFrom, rFrom);
  if (rh > ph && rl > pl) return "bullish";
  if (rh < ph && rl < pl) return "bearish";
  return null;
}

function resolveTrade(exec, entryIdx, direction, entry, stop, target, holdBars) {
  const limit = Math.min(entryIdx + holdBars, exec.highs.length - 1);
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return null;
  for (let i = entryIdx + 1; i <= limit; i++) {
    const hitStop   = direction === "bullish" ? exec.lows[i] <= stop    : exec.highs[i] >= stop;
    const hitTarget = direction === "bullish" ? exec.highs[i] >= target : exec.lows[i] <= target;
    // Ambiguous bar resolves as a LOSS: there is no way to know which came first, and
    // assuming the good one is how a backtest flatters itself.
    if (hitStop) return { outcome: "LOSS", r: -1 };
    if (hitTarget) return { outcome: "WIN", r: Math.abs(target - entry) / risk };
  }
  const move = direction === "bullish" ? exec.closes[limit] - entry : entry - exec.closes[limit];
  return { outcome: "OPEN", r: move / risk };
}

function capTarget(direction, entry, stop, target) {
  if (MAX_RR <= 0) return target;
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return target;
  if (Math.abs(target - entry) <= MAX_RR * risk) return target;
  return direction === "bullish" ? entry + MAX_RR * risk : entry - MAX_RR * risk;
}

// One place builds every trade and its control, so no model can accidentally be scored
// on a kinder convention than another.
function record(out, exec, entryIdx, direction, entry, stop, target) {
  const symbol = out.symbol;
  const ok = direction === "bullish" ? (stop < entry && target > entry) : (stop > entry && target < entry);
  if (!ok) return;
  const capped = capTarget(direction, entry, stop, target);
  const res = resolveTrade(exec, entryIdx, direction, entry, stop, capped, MAX_HOLD);
  if (!res) return;
  const risk = Math.abs(entry - stop), reward = Math.abs(capped - entry);
  out.trades.push({ r: res.r, outcome: res.outcome, entryTime: exec.times[entryIdx],
    rr: reward / risk, riskPrice: risk, symbol });
  const cIdx = entryIdx - CONTROL_OFFSET;
  if (cIdx > 0) {
    const cE = exec.closes[cIdx];
    const cS = direction === "bullish" ? cE - risk : cE + risk;
    const cT = direction === "bullish" ? cE + reward : cE - reward;
    const cR = resolveTrade(exec, cIdx, direction, cE, cS, cT, MAX_HOLD);
    if (cR) out.controls.push({ r: cR.r, entryTime: exec.times[cIdx], riskPrice: risk, symbol });
  }
}

/* ── THE STACK ───────────────────────────────────────────────────────────────────
 *
 * The proposal is not five strategies side by side, it is ONE entry with layers:
 *
 *   HTF bias -> liquidity (CRT) -> AMD -> displacement -> FVG -> pullback -> EMA confirm
 *
 * So the base is CRT sweep + FVG retest, and each layer is a GATE that can be switched on
 * independently. Measuring the ladder -- base, then base+one, then the full stack -- is
 * the only way to see which layer earns its place. A stack measured only as a whole tells
 * you it works or it does not; it never tells you which part to drop.
 *
 * Every gate costs trades. A layer that adds edge while cutting the count in half may
 * still be a bad trade for a system whose binding constraint is sample size, and the
 * trade count is printed beside every edge for exactly that reason.
 */
function passesGates(gates, ctx) {
  const { bias, exec, b, eIdx, direction, crt } = ctx;

  // HTF BIAS -- EMA50/200 alignment on the bias timeframe. The one filter that survived
  // an out-of-sample test on 2026-09-02 (+0.0878 vs -0.0056 on held-out data).
  if (gates.htf && !htfAligned(bias, b, direction)) return false;

  // STRUCTURE -- HH/HL for longs, LH/LL for shorts, on the bias timeframe.
  if (gates.struct && swingTrend(bias, b) !== direction) return false;

  // DISPLACEMENT -- the reclaim leg is an IMPULSE, not a drift: the bias bar that
  // completed the CRT has a range above 1.5x its own ATR.
  if (gates.disp) {
    const atr = atrAt(bias.highs, bias.lows, bias.closes, b, 14);
    const range = bias.highs[b] - bias.lows[b];
    if (!atr || !(range > 1.5 * atr)) return false;
  }

  // AMD -- accumulation, manipulation, distribution completing at this bias bar. Checked
  // on the SAME trailing window as the CRT so both are point-in-time.
  if (gates.amd) {
    const amd = detectAMD(slice(bias, b - WINDOW + 1, b + 1));
    const p = amd && amd.patterns ? amd.patterns.find(x => x.barsAgo <= 2) : null;
    if (!p) return false;
    const amdDir = p.direction === "bearish" ? "bearish" : "bullish";
    if (amdDir !== direction) return false;
  }

  // PULLBACK -- entry is happening into the execution timeframe's value zone rather than
  // chasing extension. The FVG retest usually is a pullback; this makes it explicit.
  if (gates.pullback) {
    const e21 = emaAt(exec.closes, eIdx, 21), e50 = emaAt(exec.closes, eIdx, 50);
    if (e21 === null || e50 === null) return false;
    const zTop = Math.max(e21, e50), zBot = Math.min(e21, e50);
    const px = exec.closes[eIdx];
    const nearValue = px <= zTop * 1.004 && px >= zBot * 0.996;
    if (!nearValue) return false;
  }

  // EMA CONFIRMATION -- the reclaim, which the proposal is explicit should confirm and
  // never generate.
  if (gates.ema) {
    const e21 = emaAt(exec.closes, eIdx, 21);
    if (e21 === null) return false;
    const reclaimed = direction === "bullish" ? exec.closes[eIdx] > e21 : exec.closes[eIdx] < e21;
    if (!reclaimed) return false;
  }
  return true;
}

/* ── MODEL 1 & 2: CRT -> FVG, optionally requiring an EMA21 reclaim ──────────────── */
function modelCrtFvg(bias, exec, out, opts) {
  const biasSec = TF_SECONDS[BIAS_TF];
  let cursor = 0;
  const at = (t) => { while (cursor < exec.times.length && exec.times[cursor] < t) cursor++;
    return cursor < exec.times.length ? cursor : -1; };

  for (let b = WINDOW; b < bias.times.length; b++) {
    const found = detectCRT(slice(bias, b - WINDOW + 1, b + 1), { maxPatterns: 5 });
    const crt = found && found.patterns ? found.patterns.find(p => p.barsAgo === 0) : null;
    if (!crt) continue;
    const direction = crt.direction === "bearish" ? "bearish" : "bullish";

    const start = at(bias.times[b] + biasSec);
    if (start === -1 || start + EXEC_WINDOW >= exec.times.length) continue;

    let zone = null, zoneIdx = -1;
    const end = Math.min(start + EXEC_WINDOW + SEARCH, exec.times.length);
    for (let j = start + EXEC_WINDOW; j < end; j++) {
      const f = detectFVGs(slice(exec, j - EXEC_WINDOW + 1, j + 1), { maxZones: 6, includeFilled: true });
      const fresh = f && f.zones ? f.zones.find(z => z.barsAgo === 0 && z.direction === direction) : null;
      if (fresh) { zone = fresh; zoneIdx = j; break; }
    }
    if (!zone) continue;
    const entry = direction === "bullish" ? zone.top : zone.bottom;

    let eIdx = -1;
    const rEnd = Math.min(zoneIdx + 1 + RETEST, exec.times.length);
    for (let k = zoneIdx + 1; k < rEnd; k++) {
      const touched = direction === "bullish" ? exec.lows[k] <= entry : exec.highs[k] >= entry;
      if (touched) { eIdx = k; break; }
    }
    if (eIdx === -1) continue;

    // EMA RECLAIM -- the proposal's "high quality reversal" adds this on top of the
    // sweep. It is the ONLY difference between emarev and crtfvg, so the two columns
    // isolate exactly what the reclaim requirement is worth.
    if (!passesGates(opts.gates || {}, { bias, exec, b, eIdx, direction, crt })) continue;
    out.candidates++;
    record(out, exec, eIdx, direction, entry, crt.invalidation, crt.objective);
  }
}

/* ── MODEL 3: SWING TREND PULLBACK ──────────────────────────────────────────────── */
// HH/HL intact on the bias timeframe, price pulls back into the EMA21-50 value zone on
// the execution timeframe, and entry is the REJECTION -- a close back in the trend
// direction after trading into the zone. Stop under the pullback's own extreme, target
// the prior swing extreme.
function modelPullback(bias, exec, out) {
  const biasSec = TF_SECONDS[BIAS_TF];
  let cursor = 0;
  const at = (t) => { while (cursor < exec.times.length && exec.times[cursor] < t) cursor++;
    return cursor < exec.times.length ? cursor : -1; };
  let lastEntry = -1;

  for (let b = 40; b < bias.times.length; b++) {
    const direction = swingTrend(bias, b);
    if (!direction) continue;
    if (REQUIRE_HTF && !htfAligned(bias, b, direction)) continue;

    // The scan must START after enough bars exist for EMA21/50 and then run for a real
    // window. The first version began at start+60 and ended at start+SEARCH+RETEST, so on
    // any timeframe where SEARCH+RETEST < 60 the loop could never execute -- it returned
    // ZERO trades on h1 and h4 and would have read as "swing pullback does not work on 4H"
    // when the model had never been given a bar to look at.
    const start = at(bias.times[b] + biasSec);
    const scanFrom = start + EXEC_WINDOW;
    const scanEnd = Math.min(scanFrom + SEARCH + RETEST, exec.times.length - 1);
    if (start === -1 || scanFrom >= exec.times.length - 2) continue;

    for (let k = scanFrom; k < scanEnd; k++) {
      // One position at a time: a model that stacks twenty entries on one pullback is
      // measuring the same idea twenty times.
      if (k <= lastEntry) continue;
      const e21 = emaAt(exec.closes, k, 21), e50 = emaAt(exec.closes, k, 50);
      if (e21 === null || e50 === null) continue;
      const zTop = Math.max(e21, e50), zBot = Math.min(e21, e50);
      const inZone = direction === "bullish" ? (exec.lows[k] <= zTop && exec.closes[k] >= zBot)
                                             : (exec.highs[k] >= zBot && exec.closes[k] <= zTop);
      if (!inZone) continue;
      const rejected = direction === "bullish" ? exec.closes[k] > exec.closes[k - 1]
                                               : exec.closes[k] < exec.closes[k - 1];
      if (!rejected) continue;

      const lookback = 20;
      const from = Math.max(0, k - lookback);
      const swingLow  = Math.min.apply(null, exec.lows.slice(from, k + 1));
      const swingHigh = Math.max.apply(null, exec.highs.slice(from, k + 1));
      const entry = exec.closes[k];
      const stop   = direction === "bullish" ? swingLow : swingHigh;
      const target = direction === "bullish"
        ? entry + (entry - swingLow) * MAX_RR : entry - (swingHigh - entry) * MAX_RR;
      out.candidates++;
      record(out, exec, k, direction, entry, stop, target);
      lastEntry = k + 20;
      break;
    }
  }
}

/* ── MODEL 4: FVG CONTINUATION ──────────────────────────────────────────────────── */
// Trend, then a DISPLACEMENT bar -- range above 1.5x ATR in the trend direction -- then
// the FVG that displacement created, then a retrace into it. The displacement requirement
// is the whole distinction from "price touched an FVG", which is measured as dead against
// its own control over 22,199 trades.
function modelFvgCont(bias, exec, out) {
  const biasSec = TF_SECONDS[BIAS_TF];
  let cursor = 0;
  const at = (t) => { while (cursor < exec.times.length && exec.times[cursor] < t) cursor++;
    return cursor < exec.times.length ? cursor : -1; };
  let lastEntry = -1;

  for (let b = 40; b < bias.times.length; b++) {
    const e50 = emaAt(bias.closes, b, 50), e200 = emaAt(bias.closes, b, 200);
    if (e50 === null || e200 === null) continue;
    const px = bias.closes[b];
    const direction = (e50 > e200 && px > e50) ? "bullish" : (e50 < e200 && px < e50) ? "bearish" : null;
    if (!direction) continue;

    const start = at(bias.times[b] + biasSec);
    if (start === -1 || start + EXEC_WINDOW >= exec.times.length) continue;
    const end = Math.min(start + EXEC_WINDOW + SEARCH, exec.times.length);

    for (let j = start + EXEC_WINDOW; j < end; j++) {
      if (j <= lastEntry) continue;
      const atr = atrAt(exec.highs, exec.lows, exec.closes, j, 14);
      if (!atr || atr <= 0) continue;
      const range = exec.highs[j] - exec.lows[j];
      const withTrend = direction === "bullish" ? exec.closes[j] > exec.closes[j - 1]
                                                : exec.closes[j] < exec.closes[j - 1];
      if (!(range > DISP_ATR * atr && withTrend)) continue;

      const f = detectFVGs(slice(exec, j - EXEC_WINDOW + 1, j + 1), { maxZones: 6, includeFilled: true });
      const zone = f && f.zones ? f.zones.find(z => z.barsAgo === 0 && z.direction === direction) : null;
      if (!zone) continue;

      const entry = direction === "bullish" ? zone.top : zone.bottom;
      let eIdx = -1;
      const rEnd = Math.min(j + 1 + RETEST, exec.times.length);
      for (let k = j + 1; k < rEnd; k++) {
        const touched = direction === "bullish" ? exec.lows[k] <= entry : exec.highs[k] >= entry;
        if (touched) { eIdx = k; break; }
      }
      if (eIdx === -1) continue;

      // Stop the far side of the gap plus the displacement bar's own extreme -- the level
      // that says the continuation failed.
      const stop = direction === "bullish" ? Math.min(zone.bottom, exec.lows[j])
                                           : Math.max(zone.top, exec.highs[j]);
      const risk = Math.abs(entry - stop);
      const target = direction === "bullish" ? entry + MAX_RR * risk : entry - MAX_RR * risk;
      out.candidates++;
      record(out, exec, eIdx, direction, entry, stop, target);
      lastEntry = eIdx + 20;
      break;
    }
  }
}

// THE LADDER. Each rung is the base entry plus one more layer, so the difference between
// two consecutive rows IS that layer's contribution -- in edge AND in trades given up.
// Standalone models keep their own rungs because the instruction was not to ignore any of
// them, and a combination is only worth building if it beats its parts.
const LADDER = [
  { key: "base",      label: "CRT + FVG (base)",            gates: {} },
  { key: "htf",       label: "+ HTF bias",                  gates: { htf: 1 } },
  { key: "struct",    label: "+ HTF + structure",           gates: { htf: 1, struct: 1 } },
  { key: "disp",      label: "+ HTF + struct + displace",   gates: { htf: 1, struct: 1, disp: 1 } },
  { key: "amd",       label: "+ ... + AMD",                 gates: { htf: 1, struct: 1, disp: 1, amd: 1 } },
  { key: "pull",      label: "+ ... + pullback",            gates: { htf: 1, struct: 1, disp: 1, amd: 1, pullback: 1 } },
  { key: "full",      label: "FULL STACK (+ EMA confirm)",  gates: { htf: 1, struct: 1, disp: 1, amd: 1, pullback: 1, ema: 1 } },
];

// Each layer added to the BASE on its own, which is the only way to tell a layer that
// contributes from one that merely rides along with the layers before it.
// PAIRS ON THE WINNING LAYER. The ladder showed that stacking everything annihilates the
// sample; the solo table showed which single layer is worth having. This asks the only
// question left: does a SECOND layer on top of that one add anything, or just cost trades.
const PAIRS = [
  { key: "p_ema_htf",  label: "EMA reclaim + HTF",          gates: { ema: 1, htf: 1 } },
  { key: "p_ema_str",  label: "EMA reclaim + structure",    gates: { ema: 1, struct: 1 } },
  { key: "p_ema_pul",  label: "EMA reclaim + pullback",     gates: { ema: 1, pullback: 1 } },
  { key: "p_ema_dsp",  label: "EMA reclaim + displacement", gates: { ema: 1, disp: 1 } },
];

const SOLO = [
  { key: "s_htf",  label: "base + HTF only",          gates: { htf: 1 } },
  { key: "s_str",  label: "base + structure only",    gates: { struct: 1 } },
  { key: "s_dsp",  label: "base + displacement only", gates: { disp: 1 } },
  { key: "s_amd",  label: "base + AMD only",          gates: { amd: 1 } },
  { key: "s_pul",  label: "base + pullback only",     gates: { pullback: 1 } },
  { key: "s_ema",  label: "base + EMA reclaim only",  gates: { ema: 1 } },
];

const STANDALONE = [
  { key: "pullback", label: "Swing trend pullback (standalone)", fn: modelPullback },
  { key: "fvgcont",  label: "FVG continuation (standalone)",     fn: modelFvgCont },
];

// costR for one trade = spread / |entry - stop|. Both halves differ across instruments,
// which is why a single flat number cannot be right for all three.
function costOf(t) {
  const sp = SPREAD[t.symbol];
  return (Number.isFinite(sp) && t.riskPrice > 0) ? sp / t.riskPrice : null;
}
function costedStat(rows) {
  const priced = rows.filter(t => costOf(t) !== null);
  if (!priced.length) return null;
  const gross = priced.reduce((a, t) => a + t.r, 0);
  const cost  = priced.reduce((a, t) => a + costOf(t), 0);
  // Break-even multiple: how many times the quoted spread the edge could absorb before
  // reaching zero. Under 1.0x it cannot pay its own spread.
  return { n: priced.length, grossRpt: gross / priced.length, costRpt: cost / priced.length,
    netRpt: (gross - cost) / priced.length, headroom: cost > 0 ? gross / cost : null };
}
function spanYears(rows) {
  if (rows.length < 2) return null;
  const ts = rows.map(t => t.entryTime).sort((a, b) => a - b);
  return (ts[ts.length - 1] - ts[0]) / (365.25 * 24 * 3600);
}
function worstStreak(rows) {
  const s = [...rows].sort((a, b) => a.entryTime - b.entryTime);
  let run = 0, worst = 0;
  for (const t of s) { if (t.r <= 0) { run++; worst = Math.max(worst, run); } else run = 0; }
  return worst;
}
function stat(rows) {
  if (!rows.length) return { n: 0, wr: 0, rpt: 0, netR: 0, openPct: 0 };
  const wins = rows.filter(t => t.r > 0).length;
  const netR = rows.reduce((a, t) => a + t.r, 0);
  // OPEN rows never reached a stop or a target -- they are marked to market at the
  // horizon. A headline R/trade carried by OPEN rows is a claim about where price
  // happened to be at an arbitrary cutoff, not about a trade the system would have
  // closed, so the share is printed rather than buried.
  const open = rows.filter(t => t.outcome === "OPEN").length;
  return { n: rows.length, wr: (wins / rows.length) * 100, rpt: netR / rows.length, netR,
    openPct: (open / rows.length) * 100 };
}
function folds(rows, n) {
  const s = [...rows].sort((a, b) => a.entryTime - b.entryTime);
  const size = Math.floor(s.length / n);
  if (size < 5) return null;
  const out = [];
  for (let k = 0; k < n; k++) out.push(stat(s.slice(k * size, k === n - 1 ? s.length : (k + 1) * size)).rpt);
  return out;
}

const pad = (v, w) => String(v).padEnd(w);
const num = (v, d) => Number.isFinite(v) ? (v >= 0 ? "+" : "") + v.toFixed(d) : "-";
const lines = [];
const say = (s) => { lines.push(s); console.log(s); };

say("=".repeat(118));
say("  STRATEGY SUITE  --  every model, same three assets, same measurement");
say("  " + new Date().toISOString());
say("  bias " + BIAS_TF + " | exec " + EXEC_TF + " | hold " + MAX_HOLD + " | cap " + MAX_RR
  + "R | folds " + FOLDS + (REQUIRE_HTF ? " | HTF ALIGNMENT REQUIRED" : ""));
say("  Ambiguous bar = LOSS. Unresolved = marked to market. Control = same shape, unrelated entry.");
say("=".repeat(118));

const bySymbolBars = {};
for (const s of SYMBOLS) {
  bySymbolBars[s] = { bias: loadBars(s, BIAS_TF), exec: loadBars(s, EXEC_TF) };
}

function runCombo(label, gates) {
  const all = { trades: [], controls: [] };
  let cands = 0;
  for (const symbol of SYMBOLS) {
    const bars = bySymbolBars[symbol];
    if (!bars.bias || !bars.exec) continue;
    const out = { trades: [], controls: [], candidates: 0, symbol };
    modelCrtFvg(bars.bias, bars.exec, out, { gates });
    cands += out.candidates;
    all.trades.push(...out.trades); all.controls.push(...out.controls);
  }
  const s = stat(all.trades), c = stat(all.controls), f = folds(all.trades, FOLDS);
  const yrs = spanYears(all.trades);
  say("  " + pad(label, 34) + pad(s.n, 8) + pad(s.n ? s.wr.toFixed(1) : "-", 8)
    + pad(s.n ? num(s.rpt, 4) : "-", 10) + pad(s.n ? num(s.netR, 2) : "-", 10)
    + pad(s.n && c.n ? num(s.rpt - c.rpt, 4) : "-", 10)
    + pad(yrs ? (s.n / yrs).toFixed(0) : "-", 8)
    + pad(yrs ? num(s.netR / yrs, 1) : "-", 9)
    + (() => { const cs = costedStat(all.trades);
        return cs ? pad(cs.costRpt.toFixed(4), 9) + pad(num(cs.netRpt, 4), 10)
                  + pad(cs.headroom === null ? "-" : cs.headroom.toFixed(1) + "x", 10)
                  : pad("-", 9) + pad("-", 10) + pad("-", 10); })()
    + (f ? f.filter(x => x > 0).length + "/" + FOLDS : "n<5/fold"));
  return { label, n: s.n, rpt: s.rpt, edge: s.n && c.n ? s.rpt - c.rpt : null,
    folds: f ? f.filter(x => x > 0).length : null };
}

const header = () => say("  " + pad("layer", 34) + pad("trades", 8) + pad("WR%", 8)
  + pad("R/trade", 10) + pad("netR", 10) + pad("EDGE", 10) + pad("tr/yr", 8)
  + pad("R/yr", 9) + pad("costR", 9) + pad("NET R/t", 10) + pad("headroom", 10) + "folds+");

say("");
say("  THE LADDER -- each rung is the one above it plus one more layer, all three assets pooled");
header();
const ladderRows = LADDER.map(r => runCombo(r.label, r.gates));

say("");
say("  EACH LAYER ON THE BASE ALONE -- what the layer contributes without the others");
header();
SOLO.forEach(r => runCombo(r.label, r.gates));

say("");
say("  PAIRS ON THE BEST SINGLE LAYER");
header();
PAIRS.forEach(r => runCombo(r.label, r.gates));

say("");
say("  THE TWO STANDALONE MODELS, for comparison");
header();
for (const m of STANDALONE) {
  const all = { trades: [], controls: [] };
  for (const symbol of SYMBOLS) {
    const bars = bySymbolBars[symbol];
    if (!bars.bias || !bars.exec) continue;
    const out = { trades: [], controls: [], candidates: 0, symbol };
    m.fn(bars.bias, bars.exec, out);
    all.trades.push(...out.trades); all.controls.push(...out.controls);
  }
  const s = stat(all.trades), c = stat(all.controls), f = folds(all.trades, FOLDS);
  const yrs = spanYears(all.trades);
  say("  " + pad(m.label, 34) + pad(s.n, 8) + pad(s.n ? s.wr.toFixed(1) : "-", 8)
    + pad(s.n ? num(s.rpt, 4) : "-", 10) + pad(s.n ? num(s.netR, 2) : "-", 10)
    + pad(s.n && c.n ? num(s.rpt - c.rpt, 4) : "-", 10)
    + pad(yrs ? (s.n / yrs).toFixed(0) : "-", 8)
    + pad(yrs ? num(s.netR / yrs, 1) : "-", 9)
    + (() => { const cs = costedStat(all.trades);
        return cs ? pad(cs.costRpt.toFixed(4), 9) + pad(num(cs.netRpt, 4), 10)
                  + pad(cs.headroom === null ? "-" : cs.headroom.toFixed(1) + "x", 10)
                  : pad("-", 9) + pad("-", 10) + pad("-", 10); })()
    + (f ? f.filter(x => x > 0).length + "/" + FOLDS : "n<5/fold"));
}

// The best rung by edge, with its cost in trades stated beside it -- a stack that wins on
// edge and gives up 90% of the flow is not automatically the right answer for a system
// whose binding constraint is sample size.
const usable = ladderRows.filter(r => r.n >= 30 && r.edge !== null);
if (usable.length) {
  const best = usable.reduce((a, b) => (b.edge > a.edge ? b : a));
  const base = ladderRows[0];
  say("");
  say("  BEST RUNG BY EDGE (min 30 trades): " + best.label + "  edge " + num(best.edge, 4)
    + ", " + best.n + " trades against the base's " + base.n
    + " (" + ((best.n / base.n) * 100).toFixed(0) + "% of the flow kept)");
}

say("");
say("  EDGE is the model minus its matched control. Positive R/trade with an edge near zero");
say("  means the target geometry paid, not the setup.");

try {
  const outDir = path.join(ROOT, "tasks", "analysis");
  fs.mkdirSync(outDir, { recursive: true });
  const suffix = REQUIRE_HTF ? "-htf" : "";
  fs.writeFileSync(path.join(outDir, "strategy-suite" + suffix + ".txt"), lines.join("\n") + "\n");
  say("");
  say("  written to tasks/analysis/strategy-suite" + suffix + ".txt");
} catch (e) { console.error("  report not written: " + e.message); }
