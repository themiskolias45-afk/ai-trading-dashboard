#!/usr/bin/env node
'use strict';
/* ============================================================================
   lab_strategies.cjs — pluggable strategies + ONE honest executor
   ============================================================================

   WHY THIS EXISTS. Every backtest in this project grew its own fill mechanics,
   which means every one of them could flatter its result in its own private way.
   ema_cross_backtest.cjs got the mechanics right and wrote them down; this file
   takes that discipline and makes it the SHARED path, so a new strategy is a
   `generate()` function and nothing else. A strategy author cannot accidentally
   invent a more generous fill, because they do not touch the fill code at all.

   THE MECHANICS, each of which flatters the result if done the other way:

     - ENTRY IS THE NEXT BAR'S OPEN. Entering at the close that produced the
       signal is lookahead: that close is not knowable until the bar is over.
     - STOP AND TARGET ARE CHECKED AGAINST HIGH AND LOW, never the close. A stop
       that only triggers on closes is not a stop.
     - A BAR THAT TOUCHES BOTH COUNTS AS A LOSS. Intrabar order is unknowable and
       the flattering assumption manufactures edge out of nothing. This single
       rule is the difference between an honest trend backtest and a fantasy.
     - THE TRAILING STOP ONLY EVER MOVES IN THE TRADE'S FAVOUR, and it is armed
       from the bar's EXTREME, which is the earliest moment it could have armed.
       It is then checked on LATER bars only — arming and firing on the same bar
       would let one bar both create and hit a stop that did not exist when the
       bar opened.
     - COSTS ARE CHARGED PER TRADE IN R, on the same basis the rest of the
       project uses, and they are charged on EVERY trade including losers.
     - NO POSITION IS EVER PYRAMIDED and only one is open at a time per run. A
       backtest that stacks entries is measuring a sizing policy, not a signal.

   WHAT A STRATEGY IS. An object:
     { id, label, describe, params: { name: { def, min, max, step } },
       generate(bars, p) -> [{ i, dir }]        // i = index of the SIGNAL bar
     }
   `generate` may look only at bars[0..i]. It returns signal bars; the executor
   enters on i+1's open. It never sees the stop, the target or the trail — those
   belong to the executor so they cannot be special-cased per strategy.

   SESSIONS are UTC hour windows on the ENTRY bar. They are a filter on when a
   trade may OPEN, never on when it may close: a session filter that also closed
   positions would be a different strategy wearing the same name.
   ========================================================================== */

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

// ── bars ────────────────────────────────────────────────────────────────────
const TIMEFRAMES = ['M15', 'H1', 'H4', 'D1'];

function loadBars(symbol, timeframe) {
  if (!/^[A-Z0-9]{1,12}$/.test(symbol)) throw new Error('bad symbol: ' + symbol);
  if (!TIMEFRAMES.includes(timeframe)) throw new Error('bad timeframe: ' + timeframe);
  const p = path.join(ROOT, 'tasks', 'history', symbol + '_' + timeframe + '.csv');
  if (!fs.existsSync(p)) return null;
  const lines = fs.readFileSync(p, 'utf8').trim().split('\n').slice(1);
  const t = [], o = [], h = [], l = [], c = [];
  for (const line of lines) {
    const f = line.split(',');
    const close = parseFloat(f[4]);
    if (!Number.isFinite(close)) continue;
    t.push(Number(f[0])); o.push(parseFloat(f[1])); h.push(parseFloat(f[2]));
    l.push(parseFloat(f[3])); c.push(close);
  }
  return { t, o, h, l, c, n: c.length };
}

function availableSymbols() {
  const dir = path.join(ROOT, 'tasks', 'history');
  if (!fs.existsSync(dir)) return [];
  const set = new Set();
  for (const f of fs.readdirSync(dir)) {
    const m = /^([A-Z0-9]{1,12})_(M15|H1|H4|D1)\.csv$/.exec(f);
    if (m) set.add(m[1]);
  }
  return [...set].sort();
}

// ── indicators ──────────────────────────────────────────────────────────────
function emaSeries(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  out[period - 1] = seed / period;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) out[i] = values[i] * k + out[i - 1] * (1 - k);
  return out;
}

/** Wilder ATR — the same definition the live engine uses. */
function atrSeries(h, l, c, period) {
  const tr = new Array(c.length).fill(null);
  for (let i = 1; i < c.length; i++) {
    tr[i] = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
  }
  const out = new Array(c.length).fill(null);
  if (c.length <= period) return out;
  let seed = 0;
  for (let i = 1; i <= period; i++) seed += tr[i];
  out[period] = seed / period;
  for (let i = period + 1; i < c.length; i++) out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
  return out;
}

/** Wilder RSI. calcRSI in the live engine was once NOT Wilder; this one is. */
function rsiSeries(c, period) {
  const out = new Array(c.length).fill(null);
  if (c.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = c[i] - c[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  let ag = gain / period, al = loss / period;
  out[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = period + 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
    al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}

/** Simple moving average. Used as a slow trend filter, where an EMA's recency
    weighting is not wanted. */
function smaSeries(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let run = 0;
  for (let i = 0; i < values.length; i++) {
    run += values[i];
    if (i >= period) run -= values[i - period];
    if (i >= period - 1) out[i] = run / period;
  }
  return out;
}

/**
 * Bollinger bands and BANDWIDTH as a fraction of the middle band.
 * Bandwidth is what defines a 'squeeze', and it is expressed as a fraction rather
 * than in price units so a threshold means the same thing on Gold at 4400 and on
 * BTC at 78000 -- a squeeze defined in points is a different strategy per symbol.
 */
function bollinger(values, period, mult) {
  const mid = smaSeries(values, period);
  const up = new Array(values.length).fill(null);
  const lo = new Array(values.length).fill(null);
  const bw = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    if (mid[i] === null) continue;
    let sq = 0;
    for (let k = i - period + 1; k <= i; k++) { const d = values[k] - mid[i]; sq += d * d; }
    const sd = Math.sqrt(sq / period);
    up[i] = mid[i] + mult * sd;
    lo[i] = mid[i] - mult * sd;
    bw[i] = mid[i] !== 0 ? (up[i] - lo[i]) / Math.abs(mid[i]) : null;
  }
  return { mid, up, lo, bw };
}

/**
 * Index of the first bar of each UTC day, so a strategy can find a session's
 * OPENING RANGE without needing a broker calendar. Day boundaries are UTC midnight,
 * which is a convention rather than a market fact -- stated here because an opening
 * range measured from the wrong boundary is a different strategy wearing the name.
 */
function dayStarts(times) {
  const starts = new Array(times.length).fill(false);
  let prev = null;
  for (let i = 0; i < times.length; i++) {
    const d = new Date(times[i] * 1000).getUTCDate();
    if (prev === null || d !== prev) starts[i] = true;
    prev = d;
  }
  return starts;
}

// ── sessions ────────────────────────────────────────────────────────────────
// UTC hour windows, [from, to). `any` disables the filter entirely.
const SESSIONS = {
  any:    null,
  asia:   [0, 8],
  london: [7, 16],
  ny:     [12, 21],
};
function inSession(tsSeconds, session) {
  const win = SESSIONS[session];
  if (!win) return true;
  const hour = new Date(tsSeconds * 1000).getUTCHours();
  return hour >= win[0] && hour < win[1];
}

// ── the strategies ──────────────────────────────────────────────────────────
const STRATEGIES = {
  ema_cross: {
    id: 'ema_cross',
    label: 'EMA crossover, long and short',
    describe: 'Fast EMA crosses the slow EMA and the trade is taken in that direction. '
      + 'The rule the UK100 batch report described, implemented as written.',
    params: {
      fast: { def: 20, min: 3,  max: 100, step: 1 },
      slow: { def: 50, min: 10, max: 400, step: 1 },
    },
    generate(bars, p) {
      if (!(p.fast < p.slow)) return [];   // a cross needs two different lengths
      const f = emaSeries(bars.c, p.fast), s = emaSeries(bars.c, p.slow);
      const out = [];
      for (let i = 1; i < bars.n; i++) {
        if (f[i] === null || s[i] === null || f[i - 1] === null || s[i - 1] === null) continue;
        const now = f[i] - s[i], prev = f[i - 1] - s[i - 1];
        if (prev <= 0 && now > 0) out.push({ i, dir: 'BUY' });
        else if (prev >= 0 && now < 0) out.push({ i, dir: 'SELL' });
      }
      return out;
    },
  },

  donchian_break: {
    id: 'donchian_break',
    label: 'Donchian channel breakout',
    describe: 'Close breaks the highest high / lowest low of the last N bars, excluding '
      + 'the current bar so the channel cannot contain the breakout that defines it.',
    params: { lookback: { def: 55, min: 5, max: 300, step: 1 } },
    generate(bars, p) {
      const out = [];
      const n = Math.max(2, Math.round(p.lookback));
      for (let i = n; i < bars.n; i++) {
        let hi = -Infinity, lo = Infinity;
        // EXCLUDES bar i. A channel that includes the breakout bar can never be broken.
        for (let k = i - n; k < i; k++) { if (bars.h[k] > hi) hi = bars.h[k]; if (bars.l[k] < lo) lo = bars.l[k]; }
        if (bars.c[i] > hi) out.push({ i, dir: 'BUY' });
        else if (bars.c[i] < lo) out.push({ i, dir: 'SELL' });
      }
      return out;
    },
  },

  rsi_reversion: {
    id: 'rsi_reversion',
    label: 'RSI mean reversion',
    describe: 'Buys when RSI crosses back UP through the oversold line and sells when it '
      + 'crosses back DOWN through overbought. Crossing back, not merely being beyond it: '
      + 'an oversold market can stay oversold for weeks.',
    params: {
      period:     { def: 14, min: 2,  max: 50, step: 1 },
      oversold:   { def: 30, min: 5,  max: 45, step: 1 },
      overbought: { def: 70, min: 55, max: 95, step: 1 },
    },
    generate(bars, p) {
      if (!(p.oversold < p.overbought)) return [];
      const r = rsiSeries(bars.c, Math.round(p.period));
      const out = [];
      for (let i = 1; i < bars.n; i++) {
        if (r[i] === null || r[i - 1] === null) continue;
        if (r[i - 1] <= p.oversold && r[i] > p.oversold) out.push({ i, dir: 'BUY' });
        else if (r[i - 1] >= p.overbought && r[i] < p.overbought) out.push({ i, dir: 'SELL' });
      }
      return out;
    },
  },

  // ── researched additions, 2026-08-31 ────────────────────────────────────
  // Each carries the EVIDENCE AND THE CAVEAT from the literature, because a
  // strategy added on a headline number is how a lab becomes a machine for
  // rediscovering other people's overfits. Every one of these is famous, and every
  // one has a published reason to doubt it. That is exactly why they are worth
  // measuring HERE, on these instruments, with the deflation this lab applies.

  opening_range_breakout: {
    id: 'opening_range_breakout',
    label: 'Opening range breakout (ORB)',
    describe: 'Marks the high and low of the first N bars of each UTC day, then trades '
      + 'the first break of that range. Zarattini, Barbon and Aziz (SSRN 4729284) report '
      + 'large returns on US equities 2016-2023.',
    // CAVEATS, on the record: the published work is on STOCKS IN PLAY (unusual-volume
    // names on news), not on the index and metal CFDs traded here, so this is a
    // DIFFERENT POPULATION and the headline numbers do not transfer. An independent
    // replication found break-even at roughly 2.2 cents/share of slippage and that 76%
    // of the confirmation filter's P&L came from 2022 alone. The authors also run
    // day-trading education businesses. Concentration and cost-sensitivity are exactly
    // what lab_report's concentration block and cost stress are built to expose.
    params: {
      rangeBars: { def: 4, min: 1, max: 24, step: 1 },
    },
    generate(bars, p) {
      const n = Math.max(1, Math.round(p.rangeBars));
      const starts = dayStarts(bars.t);
      const out = [];
      let hi = null, lo = null, readyAt = -1, firedToday = false;
      for (let i = 0; i < bars.n; i++) {
        if (starts[i]) {
          // New day: begin a fresh range. The range is not usable until it closes.
          hi = -Infinity; lo = Infinity; readyAt = i + n; firedToday = false;
        }
        if (hi === null) continue;
        if (i < readyAt) {
          if (bars.h[i] > hi) hi = bars.h[i];
          if (bars.l[i] < lo) lo = bars.l[i];
          continue;
        }
        // ONE trade per day, the FIRST break. Taking every break would re-enter the
        // same move repeatedly and inflate the trade count with correlated rows.
        if (firedToday || !isFinite(hi) || !isFinite(lo)) continue;
        if (bars.c[i] > hi) { out.push({ i, dir: 'BUY' }); firedToday = true; }
        else if (bars.c[i] < lo) { out.push({ i, dir: 'SELL' }); firedToday = true; }
      }
      return out;
    },
  },

  tsmom: {
    id: 'tsmom',
    label: 'Time-series momentum (absolute momentum)',
    describe: 'Long when the return over the last N bars is positive, short when it is '
      + 'negative. Moskowitz, Ooi and Pedersen (2012) found 12-month time-series momentum '
      + 'positive for every one of 58 futures contracts they tested.',
    // CAVEATS, and they are serious. A bootstrap study of TSMOM on ETFs finds in-sample
    // Sharpes clustering at only 0.1-0.2 and turning NEGATIVE out of sample for nearly
    // every parameterisation. Worse for this system specifically: the original paper's
    // one exception -- the instrument where the trend pattern does not appear -- is the
    // S&P 500, which is the instrument this engine already loses on. That is recorded
    // in the vault as time_series_momentum_fails_on_the_sp500. Expect this to fail on
    // SP500 and treat it as a control rather than a candidate there.
    params: {
      lookback: { def: 100, min: 10, max: 500, step: 1 },
    },
    generate(bars, p) {
      const n = Math.max(2, Math.round(p.lookback));
      const out = [];
      let last = null;
      for (let i = n; i < bars.n; i++) {
        const sign = bars.c[i] > bars.c[i - n] ? 'BUY' : bars.c[i] < bars.c[i - n] ? 'SELL' : null;
        if (!sign) continue;
        // Signal only on a FLIP. Emitting every bar the sign holds would produce one
        // entry per bar, which the executor would mostly skip anyway (one position at
        // a time) but which makes the signal count meaningless.
        if (sign !== last) { out.push({ i, dir: sign }); last = sign; }
      }
      return out;
    },
  },

  bb_squeeze_break: {
    id: 'bb_squeeze_break',
    label: 'Bollinger squeeze, then break',
    describe: 'Waits for bandwidth to compress below a threshold, then trades the first '
      + 'close outside the band. Tests directly the hypothesis the live engine already '
      + 'holds in BB_SQUEEZE_WATCH, which is watch-only and has never been measured.',
    // CAVEAT: the supporting numbers for this one come from vendor and blog backtests,
    // not peer review, and the reported profit-factor ladder from stacking filters
    // (1.15 -> 1.52 with RSI -> 1.89 with ADX) is the exact shape of a multiple-testing
    // artefact: each added filter is another trial, and none of those figures is
    // deflated for the search that produced it. Treated here as a HYPOTHESIS, and the
    // reason it is worth running is that the live engine already believes it.
    params: {
      period:       { def: 20,   min: 5,    max: 100, step: 1 },
      mult:         { def: 2.0,  min: 1.0,  max: 4.0, step: 0.5 },
      squeezePct:   { def: 0.04, min: 0.005, max: 0.25, step: 0.005 },
    },
    generate(bars, p) {
      const period = Math.max(5, Math.round(p.period));
      const b = bollinger(bars.c, period, p.mult);
      const out = [];
      let squeezed = false;
      for (let i = 1; i < bars.n; i++) {
        if (b.bw[i] === null) continue;
        if (b.bw[i] < p.squeezePct) { squeezed = true; continue; }
        // Only a break that FOLLOWS a squeeze counts. Without that the rule degenerates
        // into 'trade every band touch', which is a different and much-traded idea.
        if (!squeezed) continue;
        if (bars.c[i] > b.up[i]) { out.push({ i, dir: 'BUY' }); squeezed = false; }
        else if (bars.c[i] < b.lo[i]) { out.push({ i, dir: 'SELL' }); squeezed = false; }
      }
      return out;
    },
  },

  rsi2_pullback: {
    id: 'rsi2_pullback',
    label: 'Connors RSI(2) pullback with a trend filter',
    describe: 'Buys a very short-term oversold reading ONLY while price is above a long '
      + 'moving average, and mirrors it short below. Larry Connors popularised the '
      + '2-period RSI; the trend filter is what separates it from catching knives.',
    // Distinct from rsi_reversion above, which needs a cross back through the level and
    // has no trend filter. This is the classic formulation: dips are only bought WITH
    // the longer trend.
    // CAVEAT: reported out-of-sample decay 2015-2025 attributed to HFT competition, and
    // it degrades badly in sustained bear markets -- win rates fell below 60% through
    // 2008 and March 2020, when buying the dip repeatedly failed. A strategy that works
    // until it is most needed is a specific and testable weakness; the concentration
    // and quarter-by-quarter blocks are where that will show.
    params: {
      rsiPeriod:  { def: 2,  min: 2,  max: 10,  step: 1 },
      entry:      { def: 10, min: 2,  max: 30,  step: 1 },
      trendLen:   { def: 200, min: 20, max: 400, step: 10 },
    },
    generate(bars, p) {
      const r = rsiSeries(bars.c, Math.max(2, Math.round(p.rsiPeriod)));
      const ma = smaSeries(bars.c, Math.max(20, Math.round(p.trendLen)));
      const out = [];
      for (let i = 1; i < bars.n; i++) {
        if (r[i] === null || ma[i] === null) continue;
        const up = bars.c[i] > ma[i];
        if (up && r[i] < p.entry) out.push({ i, dir: 'BUY' });
        else if (!up && r[i] > (100 - p.entry)) out.push({ i, dir: 'SELL' });
      }
      return out;
    },
  },
};

// ── the executor ────────────────────────────────────────────────────────────
/**
 * Turn signal bars into closed trades. Shared by every strategy so none of them
 * can invent a friendlier fill.
 *
 * exec params:
 *   atrLen      ATR period for the stop distance
 *   atrMult     stop at atrMult * ATR from entry
 *   targetR     take profit at targetR * risk  (0 disables the target)
 *   trailStartR arm the trail once the trade is this many R in profit (0 = off)
 *   trailGiveR  once armed, the stop sits trailGiveR below the best R reached
 *   maxHoldBars force an exit after this many bars (0 = no limit)
 *   costR       charged on EVERY trade, winners included
 *   session     entry-time filter
 */
function runStrategy(bars, strategy, params, exec) {
  const atr = atrSeries(bars.h, bars.l, bars.c, Math.round(exec.atrLen));
  const signals = strategy.generate(bars, params);
  const trades = [];
  let openUntil = -1;                       // index the last trade closed on

  for (const sig of signals) {
    const entryIdx = sig.i + 1;             // NEXT bar's open. Never bar i.
    if (entryIdx >= bars.n) break;
    if (entryIdx <= openUntil) continue;    // one position at a time, never pyramided
    const a = atr[sig.i];
    if (!Number.isFinite(a) || a <= 0) continue;
    if (!inSession(bars.t[entryIdx], exec.session)) continue;

    const isBuy = sig.dir === 'BUY';
    const entry = bars.o[entryIdx];
    const risk  = a * exec.atrMult;
    if (!(risk > 0)) continue;
    const stop0 = isBuy ? entry - risk : entry + risk;
    const target = exec.targetR > 0 ? (isBuy ? entry + risk * exec.targetR : entry - risk * exec.targetR) : null;

    let stop = stop0, bestR = 0, exitIdx = null, exitPrice = null, reason = null;

    for (let k = entryIdx; k < bars.n; k++) {
      const hi = bars.h[k], lo = bars.l[k];
      const hitStop   = isBuy ? lo <= stop   : hi >= stop;
      const hitTarget = target !== null && (isBuy ? hi >= target : lo <= target);

      // BOTH TOUCHED = LOSS. Intrabar order is unknowable; assuming the good one
      // first is how a backtest manufactures an edge it does not have.
      if (hitStop && hitTarget) { exitIdx = k; exitPrice = stop;   reason = 'STOP_AND_TARGET'; break; }
      if (hitStop)              { exitIdx = k; exitPrice = stop;   reason = bestR > 0 ? 'TRAIL' : 'STOP'; break; }
      if (hitTarget)            { exitIdx = k; exitPrice = target; reason = 'TARGET'; break; }

      // Arm/advance the trail from THIS bar's extreme, but it can only fire on a
      // LATER bar — the checks above already ran for bar k.
      if (exec.trailStartR > 0) {
        const runR = isBuy ? (hi - entry) / risk : (entry - lo) / risk;
        if (runR > bestR) bestR = runR;
        if (bestR >= exec.trailStartR) {
          const lockR = bestR - exec.trailGiveR;
          const cand = isBuy ? entry + lockR * risk : entry - lockR * risk;
          // Only ever in the trade's favour.
          if (isBuy ? cand > stop : cand < stop) stop = cand;
        }
      }

      if (exec.maxHoldBars > 0 && (k - entryIdx) >= exec.maxHoldBars) {
        exitIdx = k; exitPrice = bars.c[k]; reason = 'MAX_HOLD'; break;
      }
    }

    // Still open at the end of history is NOT a trade. Counting it at the last
    // close would book an unresolved position as a result.
    if (exitIdx === null) break;

    const rawR = isBuy ? (exitPrice - entry) / risk : (entry - exitPrice) / risk;
    trades.push({
      r: rawR - exec.costR,
      openTime:  new Date(bars.t[entryIdx] * 1000).toISOString(),
      closeTime: new Date(bars.t[exitIdx] * 1000).toISOString(),
      symbol: exec.symbol || null,
      exitReason: reason,
      direction: sig.dir,
      barsHeld: exitIdx - entryIdx,
    });
    openUntil = exitIdx;
  }
  return trades;
}

// ── self-test ───────────────────────────────────────────────────────────────
function selftest() {
  let failed = 0;
  const ok = (n, c, x) => { if (!c) { failed++; console.log('  FAIL  ' + n + (x ? '  ' + x : '')); } else console.log('  ok    ' + n); };

  // Synthetic bars where the answer is known by construction.
  const mk = (arr) => {
    const t = [], o = [], h = [], l = [], c = [];
    arr.forEach((b, i) => { t.push(1700000000 + i * 900); o.push(b[0]); h.push(b[1]); l.push(b[2]); c.push(b[3]); });
    return { t, o, h, l, c, n: c.length };
  };

  // EMA maths against a hand value: SMA seed then the standard recurrence.
  const e = emaSeries([1, 2, 3, 4, 5], 3);
  ok('EMA seeds with an SMA', Math.abs(e[2] - 2) < 1e-12, 'got ' + e[2]);
  ok('EMA recurrence', Math.abs(e[3] - (4 * 0.5 + 2 * 0.5)) < 1e-12, 'got ' + e[3]);

  // RSI of a monotonic rise is 100 (no losses at all).
  const r = rsiSeries([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16], 14);
  ok('RSI of an unbroken rise is 100', Math.abs(r[14] - 100) < 1e-9, 'got ' + r[14]);

  // Session windows.
  const noon = Math.floor(Date.UTC(2024, 0, 1, 12) / 1000);
  const three = Math.floor(Date.UTC(2024, 0, 1, 3) / 1000);
  ok('london includes 12:00 UTC', inSession(noon, 'london'));
  ok('london excludes 03:00 UTC', !inSession(three, 'london'));
  ok('asia includes 03:00 UTC', inSession(three, 'asia'));
  ok('any accepts everything', inSession(three, 'any') && inSession(noon, 'any'));

  // Donchian excludes the current bar, so a new high IS a breakout.
  const bars = mk(Array.from({ length: 40 }, (_, i) => {
    const base = 100 + (i >= 30 ? 10 : 0);
    return [base, base + 1, base - 1, base];
  }));
  const sigs = STRATEGIES.donchian_break.generate(bars, { lookback: 10 });
  ok('donchian fires on the step up', sigs.some(s => s.i === 30 && s.dir === 'BUY'),
    'got ' + JSON.stringify(sigs.slice(0, 3)));

  // THE CENTRAL RULE: a bar touching stop AND target books a LOSS.
  //
  // The signal sits on bar 1, NOT bar 0, because ATR is undefined on the first bar
  // (it needs a previous close) and the executor correctly SKIPS a signal with no
  // ATR. The first version of this test signalled on bar 0, produced nothing, and
  // was a bug in the test rather than the executor — worth keeping the note, since
  // an empty result reads identically to a rule that never fired.
  //   atr[1] = TR = max(101-99, |101-100|, |99-100|) = 2, atrMult 1 -> risk 2
  //   entry  = bar 2 open = 100 -> stop 98, target (2R) 104
  //   bar 2 spans 97..105, touching BOTH.
  const both = mk([
    [100, 101, 99, 100],
    [100, 101, 99, 100],
    [100, 105, 97, 100],
    [100, 101, 99, 100],
  ]);
  const fakeStrat = { generate: () => [{ i: 1, dir: 'BUY' }] };
  const t2 = runStrategy(
    { ...both, }, fakeStrat, {},
    { atrLen: 1, atrMult: 1, targetR: 2, trailStartR: 0, trailGiveR: 0,
      maxHoldBars: 0, costR: 0, session: 'any', symbol: 'TEST' });
  ok('a bar touching both books a LOSS', t2.length === 1 && t2[0].r < 0,
    'got ' + JSON.stringify(t2));
  ok('the loss is exactly -1R', t2.length === 1 && Math.abs(t2[0].r + 1) < 1e-12, 'got ' + (t2[0] || {}).r);
  ok('and names the reason', t2.length === 1 && t2[0].exitReason === 'STOP_AND_TARGET');

  // Entry is the NEXT bar's open, never the signal bar's close.
  ok('entry is next bar open', t2.length === 1 && t2[0].openTime === new Date(both.t[2] * 1000).toISOString());

  // Cost is charged on every trade.
  const t3 = runStrategy({ ...both }, fakeStrat, {},
    { atrLen: 1, atrMult: 1, targetR: 2, trailStartR: 0, trailGiveR: 0,
      maxHoldBars: 0, costR: 0.05, session: 'any', symbol: 'TEST' });
  ok('cost charged on a loser too', Math.abs(t3[0].r - (t2[0].r - 0.05)) < 1e-12,
    'got ' + t3[0].r + ' vs ' + t2[0].r);

  // An unresolved position at the end of history is NOT booked. Signal on bar 1
  // again, for the ATR reason above; the stop is far enough away never to be hit.
  const openEnd = mk([
    [100, 101, 99.5, 100], [100, 101, 99.5, 100], [100, 100.5, 99.6, 100],
  ]);
  const t4 = runStrategy(openEnd, fakeStrat, {},
    { atrLen: 1, atrMult: 5, targetR: 10, trailStartR: 0, trailGiveR: 0,
      maxHoldBars: 0, costR: 0, session: 'any', symbol: 'TEST' });
  ok('a position still open at the end is not a trade', t4.length === 0, 'got ' + t4.length);

  // ---- the researched additions ----------------------------------------

  // SMA is the plain mean over the window.
  ok('SMA is the window mean', Math.abs(smaSeries([1, 2, 3, 4], 2)[3] - 3.5) < 1e-12);

  // Bollinger bandwidth is a FRACTION, so a flat series has bandwidth 0 and a
  // threshold means the same thing on Gold at 4400 as on BTC at 78000.
  const flat = bollinger([10, 10, 10, 10, 10], 3, 2);
  ok('bandwidth of a flat series is 0', Math.abs(flat.bw[4]) < 1e-12, 'got ' + flat.bw[4]);
  const scaled = bollinger([100, 102, 98, 101, 99], 3, 2);
  const scaled10 = bollinger([1000, 1020, 980, 1010, 990], 3, 2);
  ok('bandwidth is scale-free', Math.abs(scaled.bw[4] - scaled10.bw[4]) < 1e-9,
    scaled.bw[4] + ' vs ' + scaled10.bw[4]);

  // dayStarts marks the first bar of each UTC day and nothing else.
  const dayT = [
    Date.UTC(2024, 0, 1, 22) / 1000, Date.UTC(2024, 0, 1, 23) / 1000,
    Date.UTC(2024, 0, 2, 0) / 1000,  Date.UTC(2024, 0, 2, 1) / 1000,
  ];
  const ds = dayStarts(dayT);
  ok('dayStarts marks exactly the day boundaries',
    ds[0] === true && ds[1] === false && ds[2] === true && ds[3] === false,
    JSON.stringify(ds));

  // ORB fires AT MOST ONCE per day. Two breaks on one day must not become two trades.
  {
    const t = [], o = [], h = [], l = [], c = [];
    // 8 hourly bars inside one UTC day: 2 range bars, then repeated breaks.
    for (let i = 0; i < 8; i++) {
      t.push(Date.UTC(2024, 0, 3, i) / 1000);
      const base = i < 2 ? 100 : 110;      // range 99..101, then break upward
      o.push(base); h.push(base + 1); l.push(base - 1); c.push(base);
    }
    const sigs = STRATEGIES.opening_range_breakout.generate({ t, o, h, l, c, n: 8 }, { rangeBars: 2 });
    ok('ORB fires at most once per day', sigs.length === 1, 'got ' + sigs.length);
    ok('ORB fires on the first break, not inside the range', sigs[0] && sigs[0].i === 2,
      'got i=' + (sigs[0] && sigs[0].i));
  }

  // tsmom signals only on a FLIP, never once per bar while the sign holds.
  {
    const c2 = [];
    for (let i = 0; i < 40; i++) c2.push(100 + i);          // monotonic rise
    const bars2 = { t: c2.map((_, i) => 1700000000 + i * 3600), o: c2, h: c2, l: c2, c: c2, n: c2.length };
    const sig = STRATEGIES.tsmom.generate(bars2, { lookback: 5 });
    ok('tsmom emits one signal for an unbroken trend', sig.length === 1, 'got ' + sig.length);
    ok('and it is a BUY', sig[0] && sig[0].dir === 'BUY');
  }

  // bb_squeeze_break requires a squeeze FIRST. A break with no prior compression is
  // a different and much-traded idea, and must not fire here.
  {
    const c3 = [];
    for (let i = 0; i < 60; i++) c3.push(100 + (i % 2 ? 8 : -8));   // permanently wide
    const bars3 = { t: c3.map((_, i) => 1700000000 + i * 3600), o: c3, h: c3, l: c3, c: c3, n: c3.length };
    const sig3 = STRATEGIES.bb_squeeze_break.generate(bars3, { period: 20, mult: 2, squeezePct: 0.001 });
    ok('no squeeze means no breakout signal', sig3.length === 0, 'got ' + sig3.length);
  }

  // rsi2_pullback only buys ABOVE its trend filter. Below it, a low RSI must not buy.
  {
    const c4 = [];
    for (let i = 0; i < 300; i++) c4.push(200 - i * 0.5);     // steady downtrend
    const bars4 = { t: c4.map((_, i) => 1700000000 + i * 3600), o: c4, h: c4, l: c4, c: c4, n: c4.length };
    const sig4 = STRATEGIES.rsi2_pullback.generate(bars4, { rsiPeriod: 2, entry: 10, trendLen: 100 });
    ok('rsi2 never buys below its trend filter', sig4.every(x => x.dir === 'SELL'),
      'buys=' + sig4.filter(x => x.dir === 'BUY').length);
  }

  // Every strategy must be well-formed and only ever look backwards.
  for (const [id, st] of Object.entries(STRATEGIES)) {
    ok('strategy ' + id + ' declares params and a generate',
      !!st.params && typeof st.generate === 'function' && typeof st.describe === 'string');
  }

  console.log('');
  console.log(failed === 0 ? '  ALL CHECKS PASSED' : '  ' + failed + ' CHECK(S) FAILED');
  return failed;
}

if (require.main === module) {
  if (process.argv.includes('--selftest')) process.exit(selftest() === 0 ? 0 : 1);
  console.log('strategies: ' + Object.keys(STRATEGIES).join(', '));
  console.log('symbols:    ' + availableSymbols().join(', '));
  console.log('timeframes: ' + TIMEFRAMES.join(', '));
  console.log('sessions:   ' + Object.keys(SESSIONS).join(', '));
}

module.exports = {
  STRATEGIES, SESSIONS, TIMEFRAMES,
  loadBars, availableSymbols, runStrategy, inSession,
  emaSeries, atrSeries, rsiSeries, smaSeries, bollinger, dayStarts, selftest,
};
