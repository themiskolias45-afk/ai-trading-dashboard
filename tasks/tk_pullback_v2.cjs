#!/usr/bin/env node
'use strict';
/**
 * TK SWING TREND PULLBACK v2 -- the user's own Pine strategy, implemented exactly.
 *
 * Transcribed from Downloads/TK_Swing_Trend_Pullback_v2.pine (299 lines, 2026-07-13), so
 * this repo measures HIS strategy rather than an approximation of it. An earlier harness
 * here rejected "swing trend pullback" on a matched-control test; that harness had no
 * momentum push, no EMA slope, no RSI gate, an ATR-free stop, a 5R target instead of 2R,
 * and NO TRADE MANAGEMENT AT ALL. It was a different strategy and its verdict does not
 * transfer.
 *
 * ENTRY, long (shorts are the exact mirror, as in the Pine):
 *   uptrend      ema21 > ema50 AND ema21 > ema21[3]
 *   momentum     highest(high - ema50, 15) > 0.6 * atr
 *   pullback     low <= ema21 + 0.6*atr AND close >= ema21 - 0.6*atr
 *                AND close > open AND close > ema50
 *   filter       rsi(14) > 40          (short: rsi < 60)
 *   fill         at the close of the signal bar
 *
 * RISK
 *   stop         min(lowest(low,5), ema21) - 1.5*atr      (short: max(highest(high,5), ema21) + 1.5*atr)
 *   target       entry +/- 2.0 R
 *
 * THE FACTORY EXIT ENGINE, which is the part no previous harness here modelled:
 *   partial      33% of the position closes at 1.5R
 *   break-even   once peak >= 1.0R, stop moves to entry + 0.1R
 *   ratchet      once peak >= 1.5R, stop moves to entry + (peakR - 0.75)*R
 *   max hold     150 bars
 *
 *   node tasks/tk_pullback_v2.cjs [--tf H4|D1|M15|H1] [--symbols XAUUSD,BTCUSD,SP500]
 *                                 [--longs 1] [--shorts 1] [--folds 5]
 *
 * SCORED THE SAME WAY AS EVERY OTHER MODEL HERE so the numbers are comparable: ambiguous
 * bar is a LOSS, unresolved is marked to market and labelled, measured broker spread
 * charged per trade, five chronological folds, and a MATCHED CONTROL -- same direction,
 * same stop and target distances, entered at an unrelated bar. The Pine's own
 * commission 0.05% + 2 ticks slippage is replaced by this project's measured spreads so
 * the comparison against the other models is like for like; both are stated.
 *
 * READ-ONLY. Reads tasks/history/*.csv, prints, writes one report. No gate, threshold,
 * setting, position or learning file is touched.
 */

const fs   = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");

function strArg(f, d) { const i = process.argv.indexOf(f); return (i === -1 || i + 1 >= process.argv.length) ? d : process.argv[i + 1]; }
function numArg(f, d) { const i = process.argv.indexOf(f); if (i === -1 || i + 1 >= process.argv.length) return d; const v = Number(process.argv[i + 1]); return Number.isFinite(v) ? v : d; }

// Every default is the Pine's own input default.
const TF            = strArg("--tf", "H4").toUpperCase();
const SYMBOLS       = strArg("--symbols", "XAUUSD,BTCUSD,SP500").split(",").map(s => s.trim());
const EMA_FAST      = numArg("--emafast", 21);
const EMA_SLOW      = numArg("--emaslow", 50);
const SLOPE_LOOKBACK= numArg("--slope", 3);
const PUSH_LOOKBACK = numArg("--pushlb", 15);
const PUSH_ATR      = numArg("--pushatr", 0.6);
const PULLBACK_TOL  = numArg("--tol", 0.60);
// Trend filter: "ema" (shipped, default) or "gauss" (Ehlers N-pole, opt-in).
// Anything else is REFUSED rather than silently falling back to ema - a typo that
// quietly ran the baseline under the candidate label is the one failure this test
// cannot afford.
const TREND_FILTER  = String(strArg("--trend", "ema")).toLowerCase();
const GAUSS_POLES   = numArg("--poles", 4);
if (TREND_FILTER !== "ema" && TREND_FILTER !== "gauss") {
  console.error(`--trend ${TREND_FILTER} is not a filter. Use "ema" (default) or "gauss".`);
  console.error("Refusing rather than defaulting: a typo that silently ran the baseline");
  console.error("under the candidate's label is the one error this comparison cannot survive.");
  process.exit(2);
}

const RSI_LEN       = numArg("--rsilen", 14);
const RSI_MIN       = numArg("--rsimin", 40);
const ATR_LEN       = numArg("--atrlen", 14);
const ATR_SL        = numArg("--atrsl", 1.5);
const RR            = numArg("--rr", 2.0);
const SWING_LB      = numArg("--swinglb", 5);
const MAX_BARS      = numArg("--maxbars", 150);
const PARTIAL_AT_R  = numArg("--partialr", 1.5);
const PARTIAL_PCT   = numArg("--partialpct", 33) / 100;
const BE_TRIGGER_R  = numArg("--ber", 1.0);
const BE_OFFSET_R   = numArg("--beoffset", 0.1);
const TRAIL_START_R = numArg("--trailstart", 1.5);
const TRAIL_DIST_R  = numArg("--traildist", 0.75);
const FOLDS         = Math.max(2, numArg("--folds", 5));
const CONTROL_OFFSET= numArg("--controloffset", 137);
const ALLOW_LONGS   = numArg("--longs", 1) !== 0;
const ALLOW_SHORTS  = numArg("--shorts", 1) !== 0;
const USE_PARTIAL   = numArg("--partial", 1) !== 0;
const USE_BE        = numArg("--be", 1) !== 0;
const USE_TRAIL     = numArg("--trail", 1) !== 0;
// v1's LEGACY exit: a plain ATR trailing stop, no partial, no break-even, no R-ratchet.
// v2 replaced it with the R-engine, so the two versions are different strategies from the
// entry onward and cannot be compared by entry parameters alone.
const ATR_TRAIL     = numArg("--atrtrail", 0);   // 0 = off; v1 live runs 4.5

// Live terminal, 2026-09-02. Spread only.
const SPREAD = { XAUUSD: 0.22, BTCUSD: 17.00, SP500: 0.36 };

function loadBars(symbol, tf) {
  const file = path.join(ROOT, "tasks", "history", symbol + "_" + tf + ".csv");
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  lines.shift();
  const t = [], o = [], h = [], l = [], c = [];
  for (const raw of lines) {
    const p = raw.trim().split(",");
    if (p.length < 5) continue;
    // OPEN is column 1 and every other harness here discarded it. The Pine needs it:
    // `close > open` is part of the entry, so dropping it silently changes the strategy.
    const vt = Number(p[0]), vo = Number(p[1]), vh = Number(p[2]), vl = Number(p[3]), vc = Number(p[4]);
    if (![vt, vo, vh, vl, vc].every(Number.isFinite)) continue;
    t.push(vt); o.push(vo); h.push(vh); l.push(vl); c.push(vc);
  }
  return { times: t, opens: o, highs: h, lows: l, closes: c };
}

// ta.ema, ta.atr and ta.rsi as Pine computes them: EMA seeded with an SMA, ATR and RSI
// both Wilder-smoothed. calcRSI in this project was NOT Wilder once and it changed every
// downstream number, so it is written out rather than borrowed.
function emaSeries(src, len) {
  const out = new Array(src.length).fill(null);
  if (src.length < len) return out;
  let sum = 0;
  for (let i = 0; i < len; i++) sum += src[i];
  let prev = sum / len;
  out[len - 1] = prev;
  const k = 2 / (len + 1);
  for (let i = len; i < src.length; i++) { prev = src[i] * k + prev * (1 - k); out[i] = prev; }
  return out;
}
// ── Ehlers multi-pole Gaussian filter, OPT-IN via --trend gauss ──────────────
// Added 2026-09-05 to test one claim found in outside research: that a Gaussian IIR
// filter detects trend with less lag than an EMA at equal smoothing, and is therefore
// a better trend gate for a pullback strategy. It is the ONLY idea from that search
// worth compute - everything else was unmeasured, under 20 trades, or reported a
// Sharpe of 10 on gold.
//
// DEFAULT IS "ema" AND MUST STAY THAT WAY. Every number in tasks/profitable.cjs was
// measured on the EMA path; silently changing it would not improve the strategy, it
// would invalidate the ledger and make today's numbers incomparable to every prior
// run. This is additive: with no --trend flag, not one value moves.
//
//   beta  = (1 - cos(2*pi/period)) / (2^(1/poles) - 1)
//   alpha = -beta + sqrt(beta^2 + 2*beta)
// then a single-pole recursion applied `poles` times in cascade, which is the
// standard realisation of the N-pole form.
//
// Seeded with the SAME SMA seed as emaSeries above, and returning nulls over the same
// warm-up window, so the two filters are compared on identical bars. A filter that
// silently started earlier would look better purely by trading a different sample.
function gaussSeries(src, len, poles) {
  const out = new Array(src.length).fill(null);
  if (src.length < len) return out;
  const beta  = (1 - Math.cos(2 * Math.PI / len)) / (Math.pow(2, 1 / poles) - 1);
  const alpha = -beta + Math.sqrt(beta * beta + 2 * beta);

  let sum = 0;
  for (let i = 0; i < len; i++) sum += src[i];
  const seed = sum / len;

  const stage = new Array(poles).fill(seed);
  out[len - 1] = seed;
  for (let i = len; i < src.length; i++) {
    let v = src[i];
    for (let p = 0; p < poles; p++) {
      stage[p] = alpha * v + (1 - alpha) * stage[p];
      v = stage[p];
    }
    out[i] = v;
  }
  return out;
}

// Which trend filter this run uses. "ema" is the shipped path and the default.
function trendSeries(src, len) {
  return TREND_FILTER === "gauss" ? gaussSeries(src, len, GAUSS_POLES) : emaSeries(src, len);
}

function atrSeries(h, l, c, len) {
  const tr = new Array(h.length).fill(null);
  for (let i = 1; i < h.length; i++) {
    tr[i] = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
  }
  const out = new Array(h.length).fill(null);
  if (h.length <= len) return out;
  let sum = 0;
  for (let i = 1; i <= len; i++) sum += tr[i];
  let prev = sum / len;
  out[len] = prev;
  for (let i = len + 1; i < h.length; i++) { prev = (prev * (len - 1) + tr[i]) / len; out[i] = prev; }
  return out;
}
function rsiSeries(c, len) {
  const out = new Array(c.length).fill(null);
  if (c.length <= len) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= len; i++) {
    const d = c[i] - c[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let ag = gain / len, al = loss / len;
  out[len] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = len + 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    ag = (ag * (len - 1) + (d > 0 ? d : 0)) / len;
    al = (al * (len - 1) + (d < 0 ? -d : 0)) / len;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}
const highestIn = (a, end, n) => { let m = -Infinity; for (let i = Math.max(0, end - n + 1); i <= end; i++) m = Math.max(m, a[i]); return m; };
const lowestIn  = (a, end, n) => { let m =  Infinity; for (let i = Math.max(0, end - n + 1); i <= end; i++) m = Math.min(m, a[i]); return m; };

/**
 * Walk one position forward with the full factory exit engine.
 * Returns realised R for the WHOLE position, partial included.
 */
function manage(bars, entryIdx, dir, entry, initialStop, target, atrAtEntry) {
  const risk = Math.abs(entry - initialStop);
  if (!(risk > 0)) return null;
  const long = dir === 1;
  let stop = initialStop;
  let peakR = 0;
  let partialDone = false;
  let realised = 0;              // R already banked by the partial
  let extreme = long ? bars.highs[entryIdx] : bars.lows[entryIdx];
  let remaining = 1;             // fraction of the position still open
  const limit = Math.min(entryIdx + MAX_BARS, bars.highs.length - 1);

  for (let i = entryIdx + 1; i <= limit; i++) {
    const hi = bars.highs[i], lo = bars.lows[i];

    // WITHIN-BAR ORDER IS UNKNOWABLE, so the pessimistic reading is taken: the stop is
    // checked against the stop level as it stood at the START of the bar, before this
    // bar's extreme is allowed to advance the trail. Letting the same bar both raise the
    // trail and avoid the stop is how a backtest invents money.
    const hitStop = long ? lo <= stop : hi >= stop;
    if (hitStop) {
      const r = long ? (stop - entry) / risk : (entry - stop) / risk;
      return { r: realised + remaining * r, bars: i - entryIdx,
        outcome: r >= 0 ? "STOP_PROFIT" : "STOP_LOSS" };
    }

    // Partial take-profit: a third off at 1.5R, the runner keeps the original target.
    if (USE_PARTIAL && !partialDone) {
      const pt = long ? entry + PARTIAL_AT_R * risk : entry - PARTIAL_AT_R * risk;
      const hitPartial = long ? hi >= pt : lo <= pt;
      if (hitPartial) {
        realised += PARTIAL_PCT * PARTIAL_AT_R;
        remaining -= PARTIAL_PCT;
        partialDone = true;
      }
    }

    const hitTarget = long ? hi >= target : lo <= target;
    if (hitTarget) {
      const r = long ? (target - entry) / risk : (entry - target) / risk;
      return { r: realised + remaining * r, bars: i - entryIdx, outcome: "TARGET" };
    }

    // LEGACY ATR TRAIL (v1). Uses the running extreme since entry, and like every other
    // stop move here it only affects LATER bars.
    if (ATR_TRAIL > 0 && atrAtEntry > 0) {
      extreme = long ? Math.max(extreme, hi) : Math.min(extreme, lo);
      const t = long ? extreme - ATR_TRAIL * atrAtEntry : extreme + ATR_TRAIL * atrAtEntry;
      stop = long ? Math.max(stop, t) : Math.min(stop, t);
    }

    // Now the bar's extreme updates the peak and may ratchet the stop for LATER bars.
    const excursion = long ? (hi - entry) / risk : (entry - lo) / risk;
    if (excursion > peakR) peakR = excursion;
    if (USE_BE && peakR >= BE_TRIGGER_R) {
      const be = long ? entry + BE_OFFSET_R * risk : entry - BE_OFFSET_R * risk;
      stop = long ? Math.max(stop, be) : Math.min(stop, be);
    }
    if (USE_TRAIL && peakR >= TRAIL_START_R) {
      const tr = long ? entry + (peakR - TRAIL_DIST_R) * risk
                      : entry - (peakR - TRAIL_DIST_R) * risk;
      stop = long ? Math.max(stop, tr) : Math.min(stop, tr);
    }
  }
  // Max-hold exit: the Pine closes at market, so this is marked to market and labelled.
  const last = bars.closes[limit];
  const r = long ? (last - entry) / risk : (entry - last) / risk;
  return { r: realised + remaining * r, bars: limit - entryIdx, outcome: "MAX_HOLD" };
}

function run(symbol) {
  const b = loadBars(symbol, TF);
  if (!b) return { symbol, error: "missing " + symbol + "_" + TF + ".csv" };
  const { times, opens, highs, lows, closes } = b;
  const ema21 = trendSeries(closes, EMA_FAST);
  const ema50 = trendSeries(closes, EMA_SLOW);
  const atr   = atrSeries(highs, lows, closes, ATR_LEN);
  const rsi   = rsiSeries(closes, RSI_LEN);

  // Precomputed once. The first version built `highs.map(...)` INSIDE the bar loop,
  // which is a fresh 100,000-element array per bar -- O(n^2) and minutes per symbol on
  // m15. Same numbers, and it actually finishes.
  const distAbove = highs.map((h, k) => ema50[k] === null ? -Infinity : h - ema50[k]);
  const distBelow = lows.map((l, k) => ema50[k] === null ? -Infinity : ema50[k] - l);

  const trades = [], controls = [];
  let openUntil = -1;

  for (let i = Math.max(EMA_SLOW + SLOPE_LOOKBACK, PUSH_LOOKBACK, ATR_LEN + 1, RSI_LEN + 1); i < closes.length - 1; i++) {
    if (i <= openUntil) continue;                    // one position at a time, as in Pine
    if (ema21[i] === null || ema50[i] === null || atr[i] === null || rsi[i] === null) continue;
    if (ema21[i - SLOPE_LOOKBACK] === null) continue;

    const a = atr[i], tol = PULLBACK_TOL * a;
    const up   = ema21[i] > ema50[i] && ema21[i] > ema21[i - SLOPE_LOOKBACK];
    const down = ema21[i] < ema50[i] && ema21[i] < ema21[i - SLOPE_LOOKBACK];

    let dir = 0, entry = closes[i], stop = null;
    if (ALLOW_LONGS && up) {
      const push = highestIn(distAbove, i, PUSH_LOOKBACK) > PUSH_ATR * a;
      const touch = lows[i] <= ema21[i] + tol && closes[i] >= ema21[i] - tol;
      if (push && touch && closes[i] > opens[i] && closes[i] > ema50[i] && rsi[i] > RSI_MIN) {
        dir = 1;
        stop = Math.min(lowestIn(lows, i, SWING_LB), ema21[i]) - ATR_SL * a;
      }
    }
    if (dir === 0 && ALLOW_SHORTS && down) {
      const pushDn = highestIn(distBelow, i, PUSH_LOOKBACK) > PUSH_ATR * a;
      const touchUp = highs[i] >= ema21[i] - tol && closes[i] <= ema21[i] + tol;
      if (pushDn && touchUp && closes[i] < opens[i] && closes[i] < ema50[i] && rsi[i] < (100 - RSI_MIN)) {
        dir = -1;
        stop = Math.max(highestIn(highs, i, SWING_LB), ema21[i]) + ATR_SL * a;
      }
    }
    if (dir === 0 || stop === null) continue;

    const risk = Math.abs(entry - stop);
    if (!(risk > 0)) continue;
    const target = dir === 1 ? entry + risk * RR : entry - risk * RR;
    const res = manage(b, i, dir, entry, stop, target, a);
    if (!res) continue;
    trades.push({ r: res.r, outcome: res.outcome, entryTime: times[i], symbol,
      direction: dir === 1 ? "BUY" : "SELL", riskPrice: risk });
    openUntil = i + res.bars;

    const cIdx = i - CONTROL_OFFSET;
    if (cIdx > EMA_SLOW) {
      const cEntry = closes[cIdx];
      const cStop = dir === 1 ? cEntry - risk : cEntry + risk;
      const cTarget = dir === 1 ? cEntry + risk * RR : cEntry - risk * RR;
      const cRes = manage(b, cIdx, dir, cEntry, cStop, cTarget, a);
      if (cRes) controls.push({ r: cRes.r, entryTime: times[cIdx], symbol,
        direction: dir === 1 ? "BUY" : "SELL", riskPrice: risk });
    }
  }
  return { symbol, trades, controls, bars: closes.length,
    spanYears: times.length > 1 ? (times[times.length - 1] - times[0]) / (365.25 * 86400) : null };
}

function stat(rows) {
  if (!rows.length) return { n: 0, wr: 0, rpt: 0, netR: 0, pf: null };
  const wins = rows.filter(t => t.r > 0);
  const losses = rows.filter(t => t.r <= 0);
  const gp = wins.reduce((a, t) => a + t.r, 0);
  const gl = Math.abs(losses.reduce((a, t) => a + t.r, 0));
  const netR = rows.reduce((a, t) => a + t.r, 0);
  return { n: rows.length, wr: (wins.length / rows.length) * 100, rpt: netR / rows.length,
    netR, pf: gl > 0 ? gp / gl : null };
}
function costed(rows) {
  const priced = rows.filter(t => SPREAD[t.symbol] && t.riskPrice > 0);
  if (!priced.length) return null;
  const cost = priced.reduce((a, t) => a + SPREAD[t.symbol] / t.riskPrice, 0);
  const gross = priced.reduce((a, t) => a + t.r, 0);
  return { costRpt: cost / priced.length, netRpt: (gross - cost) / priced.length,
    headroom: cost > 0 ? gross / cost : null };
}
function folds(rows, n) {
  const s = [...rows].sort((a, b) => a.entryTime - b.entryTime);
  const size = Math.floor(s.length / n);
  if (size < 5) return null;
  const out = [];
  for (let k = 0; k < n; k++) out.push(stat(s.slice(k * size, k === n - 1 ? s.length : (k + 1) * size)).rpt);
  return out;
}

// --json prints the raw trade list and nothing else, so tasks/tk_optimise.cjs can do the
// train/test split itself rather than re-implementing the strategy. One implementation,
// one place to be wrong.
const JSON_OUT = process.argv.includes("--json");

const pad = (v, w) => String(v).padEnd(w);
const num = (v, d) => Number.isFinite(v) ? (v >= 0 ? "+" : "") + v.toFixed(d) : "-";
const lines = [];
const say = (s) => { lines.push(s); console.log(s); };

if (JSON_OUT) {
  const out = { trades: [], controls: [] };
  for (const symbol of SYMBOLS) {
    const r = run(symbol);
    if (r.error) continue;
    out.trades.push(...r.trades); out.controls.push(...r.controls);
  }
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

say("=".repeat(118));
say("  TK SWING TREND PULLBACK v2 -- the Pine strategy, implemented from source");
say("  " + new Date().toISOString() + "   timeframe " + TF);
say("  EMA " + EMA_FAST + "/" + EMA_SLOW + " slope " + SLOPE_LOOKBACK + " | push " + PUSH_ATR
  + "xATR/" + PUSH_LOOKBACK + " | tol " + PULLBACK_TOL + "xATR | RSI>" + RSI_MIN
  + " | SL " + ATR_SL + "xATR | TP " + RR + "R | maxhold " + MAX_BARS);
say("  exit engine: partial " + (PARTIAL_PCT * 100).toFixed(0) + "% at " + PARTIAL_AT_R
  + "R | BE at " + BE_TRIGGER_R + "R +" + BE_OFFSET_R + "R | trail from " + TRAIL_START_R
  + "R, " + TRAIL_DIST_R + "R behind peak"
  + (USE_PARTIAL && USE_BE && USE_TRAIL ? "" : "   [SOME ENGINE PARTS DISABLED]"));
say("  costs: this project's MEASURED broker spread, not the Pine's 0.05% + 2 ticks");
say("=".repeat(118));
say("");
say("  " + pad("symbol", 9) + pad("side", 7) + pad("trades", 8) + pad("WR%", 8) + pad("PF", 8)
  + pad("R/trade", 10) + pad("netR", 10) + pad("control", 10) + pad("EDGE", 10)
  + pad("costR", 9) + pad("NET R/t", 10) + "folds+");

const all = { trades: [], controls: [] };
for (const symbol of SYMBOLS) {
  const out = run(symbol);
  if (out.error) { say("  " + pad(symbol, 9) + out.error); continue; }
  all.trades.push(...out.trades); all.controls.push(...out.controls);
  for (const side of ["ALL", "BUY", "SELL"]) {
    const ts = side === "ALL" ? out.trades : out.trades.filter(t => t.direction === side);
    const cs = side === "ALL" ? out.controls : out.controls.filter(t => t.direction === side);
    if (!ts.length) { if (side === "ALL") say("  " + pad(symbol, 9) + pad(side, 7) + "no trades"); continue; }
    const s = stat(ts), c = stat(cs), f = folds(ts, FOLDS), cst = costed(ts);
    say("  " + pad(side === "ALL" ? symbol : "", 9) + pad(side, 7) + pad(s.n, 8)
      + pad(s.wr.toFixed(1), 8) + pad(s.pf === null ? "-" : s.pf.toFixed(3), 8)
      + pad(num(s.rpt, 4), 10) + pad(num(s.netR, 2), 10)
      + pad(c.n ? num(c.rpt, 4) : "-", 10) + pad(c.n ? num(s.rpt - c.rpt, 4) : "-", 10)
      + pad(cst ? cst.costRpt.toFixed(4) : "-", 9) + pad(cst ? num(cst.netRpt, 4) : "-", 10)
      + (f ? f.filter(x => x > 0).length + "/" + FOLDS : "n<5/fold"));
  }
}

say("  " + "-".repeat(110));
for (const side of ["ALL", "BUY", "SELL"]) {
  const ts = side === "ALL" ? all.trades : all.trades.filter(t => t.direction === side);
  const cs = side === "ALL" ? all.controls : all.controls.filter(t => t.direction === side);
  if (!ts.length) continue;
  const s = stat(ts), c = stat(cs), f = folds(ts, FOLDS), cst = costed(ts);
  say("  " + pad(side === "ALL" ? "POOLED" : "", 9) + pad(side, 7) + pad(s.n, 8)
    + pad(s.wr.toFixed(1), 8) + pad(s.pf === null ? "-" : s.pf.toFixed(3), 8)
    + pad(num(s.rpt, 4), 10) + pad(num(s.netR, 2), 10)
    + pad(c.n ? num(c.rpt, 4) : "-", 10) + pad(c.n ? num(s.rpt - c.rpt, 4) : "-", 10)
    + pad(cst ? cst.costRpt.toFixed(4) : "-", 9) + pad(cst ? num(cst.netRpt, 4) : "-", 10)
    + (f ? f.filter(x => x > 0).length + "/" + FOLDS : "n<5/fold"));
}
say("");
say("  PF here is computed in R, so it is comparable across instruments but NOT identical");
say("  to TradingView's cash profit factor on one symbol at one position size.");

try {
  const outDir = path.join(ROOT, "tasks", "analysis");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "tk-pullback-v2-" + TF + ".txt"), lines.join("\n") + "\n");
  say("  written to tasks/analysis/tk-pullback-v2-" + TF + ".txt");
} catch (e) { console.error("  report not written: " + e.message); }
