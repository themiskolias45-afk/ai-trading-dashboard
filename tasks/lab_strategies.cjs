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
  // Entry 100 on bar 1's open, ATR 1 so risk = 1: stop 99, target 102.
  // Bar 1 spans 98..103, touching both.
  const both = mk([
    [100, 101, 99, 100], [100, 103, 98, 100], [100, 101, 99, 100],
  ]);
  const fakeStrat = { generate: () => [{ i: 0, dir: 'BUY' }] };
  const t2 = runStrategy(
    { ...both, }, fakeStrat, {},
    { atrLen: 1, atrMult: 1, targetR: 2, trailStartR: 0, trailGiveR: 0,
      maxHoldBars: 0, costR: 0, session: 'any', symbol: 'TEST' });
  ok('a bar touching both books a LOSS', t2.length === 1 && t2[0].r < 0,
    'got ' + JSON.stringify(t2));
  ok('and names the reason', t2.length === 1 && t2[0].exitReason === 'STOP_AND_TARGET');

  // Entry is the NEXT bar's open, never the signal bar's close.
  ok('entry is next bar open', t2.length === 1 && t2[0].openTime === new Date(both.t[1] * 1000).toISOString());

  // Cost is charged on every trade.
  const t3 = runStrategy({ ...both }, fakeStrat, {},
    { atrLen: 1, atrMult: 1, targetR: 2, trailStartR: 0, trailGiveR: 0,
      maxHoldBars: 0, costR: 0.05, session: 'any', symbol: 'TEST' });
  ok('cost charged on a loser too', Math.abs(t3[0].r - (t2[0].r - 0.05)) < 1e-12,
    'got ' + t3[0].r + ' vs ' + t2[0].r);

  // An unresolved position at the end of history is NOT booked.
  const openEnd = mk([[100, 101, 99.5, 100], [100, 100.5, 99.6, 100]]);
  const t4 = runStrategy(openEnd, fakeStrat, {},
    { atrLen: 1, atrMult: 5, targetR: 10, trailStartR: 0, trailGiveR: 0,
      maxHoldBars: 0, costR: 0, session: 'any', symbol: 'TEST' });
  ok('a position still open at the end is not a trade', t4.length === 0, 'got ' + t4.length);

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
  emaSeries, atrSeries, rsiSeries, selftest,
};
