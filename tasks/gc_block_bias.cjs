#!/usr/bin/env node
'use strict';
/**
 * GC 5-DAY BLOCK BIAS -- the strategy from the two screenshots of 2026-09-05.
 *
 * SOURCE, transcribed rather than paraphrased, so this measures HIS rules:
 *   "Trend following based. Basically it reads the five bars of the Daily candle and
 *    marks the first day candle and last day candle to identify trend... then repeats
 *    for the next 5 days. If the first 5 days was downward and the 2nd is upward We
 *    look for sells into 80% of the range using the 12EMA on the 1H timeframe. SL is
 *    ATR based (1.5 ATR)"
 * and from the chart, which supplies the trigger the text leaves implicit:
 *   "Sell after Price closes below EMA in London"   (boxes labelled First 5 / Next 5)
 *
 * THE RULES AS IMPLEMENTED
 *   bias      block1 = 5 daily bars, block2 = the next 5. Direction of a block is
 *             close(last day) vs close(first day) -- "marks the first day candle and
 *             last day candle".
 *   setup     block1 DOWN and block2 UP  -> SHORT bias (his case)
 *             --longs 1 also tests the exact mirror, because a structure that only
 *             works on the side gold has already lost money on is worth separating
 *             from a structure that does not work at all.
 *   zone      80% of block2's range, measured from its low: low + 0.8*(high-low).
 *             Price must trade INTO that zone for the setup to arm.
 *   trigger   an H1 close back below the 12 EMA, during LONDON (UTC 07-16, the same
 *             window lab_strategies.cjs uses, so sessions mean one thing in this repo).
 *   stop      1.5 * ATR(14) on H1, from the entry.
 *   target    NOT SPECIFIED IN THE SOURCE. Defaults to 2R and is a flag. Any result
 *             here is conditional on that choice and the report says so.
 *   expiry    the setup dies after --expiry days if it never triggers, so a stale
 *             bias cannot fire weeks later and be scored as if it were this signal.
 *
 * SCORED THE SAME WAY AS EVERY OTHER MODEL IN THIS REPO so the number is comparable:
 * ambiguous bar (stop and target inside one bar) is a LOSS, unresolved is marked to
 * market and labelled, this project's MEASURED spread is charged per trade, five
 * chronological folds, and a MATCHED CONTROL -- same direction, same stop and target
 * distances, entered at an unrelated bar. The control is the column that matters: it
 * is what separates an edge from trade geometry, and it is what killed the Gaussian
 * filter and the swing-pullback family.
 *
 * READ-ONLY. Reads tasks/history/*.csv and prints. No gate, threshold, setting,
 * position, order or learning file is touched. feedsTheGate is false.
 */

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

function strArg(f, d) { const i = process.argv.indexOf(f); return (i === -1 || i + 1 >= process.argv.length) ? d : process.argv[i + 1]; }
function numArg(f, d) { const i = process.argv.indexOf(f); if (i === -1 || i + 1 >= process.argv.length) return d; const v = Number(process.argv[i + 1]); return Number.isFinite(v) ? v : d; }

const SYMBOL      = strArg('--symbol', 'XAUUSD');
const BLOCK       = numArg('--block', 5);        // "five bars of the Daily candle"
const ZONE_PCT    = numArg('--zone', 0.80);      // "80% of the range"
const EMA_LEN     = numArg('--ema', 12);         // "the 12EMA on the 1H timeframe"
const ATR_LEN     = numArg('--atrlen', 14);
const ATR_SL      = numArg('--atrsl', 1.5);      // "SL is ATR based (1.5 ATR)"
const RR          = numArg('--rr', 2.0);         // NOT in the source -- stated assumption
const EXPIRY_DAYS = numArg('--expiry', 5);
const SESSION     = strArg('--session', 'london');
const ALLOW_SHORT = numArg('--shorts', 1) !== 0;
const ALLOW_LONG  = numArg('--longs', 0) !== 0;  // the mirror, off by default
const FOLDS       = Math.max(2, numArg('--folds', 5));
const CTRL_OFFSET = numArg('--controloffset', 137);
const MAX_HOLD_H1 = numArg('--maxhold', 240);

const SESSIONS = { any: null, asia: [0, 8], london: [7, 16], ny: [12, 21] };
// This project's MEASURED spreads, copied from tasks/cost_breakeven.cjs so both
// harnesses charge the same cost. A symbol absent here REFUSES rather than defaulting
// to zero: a zero-spread run flatters a strategy exactly where it is cheapest to be
// wrong, and an unpriced symbol quietly outscoring a priced one is the worst possible
// way to pick a winner.
const SPREAD = {
  XAUUSD: 0.22, BTCUSD: 17.00, SP500: 0.36, ETHUSD: 2.47, XRPUSD: 0.0083,
  LTCUSD: 1.00, XAGUSD: 0.021, USOUSD: 0.037, GBPUSD: 0.00015, USDJPY: 0.019,
  EURUSD: 0.00014, AUDUSD: 0.00014,
  // NAS100 is NOT in cost_breakeven.cjs. Rather than invent a number, it is left out
  // and the run refuses -- see the check in main().
};

function inSession(tsSec) {
  const w = SESSIONS[SESSION];
  if (!w) return true;
  const h = new Date(tsSec * 1000).getUTCHours();
  return h >= w[0] && h < w[1];
}

function loadBars(symbol, tf) {
  const file = path.join(ROOT, 'tasks', 'history', symbol + '_' + tf + '.csv');
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  lines.shift();
  const t = [], o = [], h = [], l = [], c = [];
  for (const raw of lines) {
    const p = raw.trim().split(',');
    if (p.length < 5) continue;
    const vt = Number(p[0]), vo = Number(p[1]), vh = Number(p[2]), vl = Number(p[3]), vc = Number(p[4]);
    if (![vt, vo, vh, vl, vc].every(Number.isFinite)) continue;
    t.push(vt); o.push(vo); h.push(vh); l.push(vl); c.push(vc);
  }
  return { t, o, h, l, c };
}

// EMA seeded with an SMA, and Wilder ATR -- written out rather than borrowed, the same
// reason tk_pullback_v2 gives: a non-Wilder RSI once changed every downstream number.
function emaSeries(src, len) {
  const out = new Array(src.length).fill(null);
  if (src.length < len) return out;
  let s = 0; for (let i = 0; i < len; i++) s += src[i];
  let prev = s / len; out[len - 1] = prev;
  const k = 2 / (len + 1);
  for (let i = len; i < src.length; i++) { prev = src[i] * k + prev * (1 - k); out[i] = prev; }
  return out;
}
function atrSeries(h, l, c, len) {
  const tr = new Array(h.length).fill(null);
  for (let i = 1; i < h.length; i++) tr[i] = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
  const out = new Array(h.length).fill(null);
  if (h.length <= len) return out;
  let s = 0; for (let i = 1; i <= len; i++) s += tr[i];
  let prev = s / len; out[len] = prev;
  for (let i = len + 1; i < h.length; i++) { prev = (prev * (len - 1) + tr[i]) / len; out[i] = prev; }
  return out;
}

/** Simulate one trade forward from H1 index `from`. Ambiguous bar is a LOSS. */
function runTrade(H1, from, dir, entry, stop, target, spread) {
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return null;
  const costR = spread / risk;
  for (let i = from + 1; i < Math.min(H1.t.length, from + 1 + MAX_HOLD_H1); i++) {
    const hi = H1.h[i], lo = H1.l[i];
    const hitStop   = dir === 'SELL' ? hi >= stop   : lo <= stop;
    const hitTarget = dir === 'SELL' ? lo <= target : hi >= target;
    if (hitStop && hitTarget) return { r: -1 - costR, bars: i - from, outcome: 'AMBIGUOUS' };
    if (hitStop)   return { r: -1 - costR, bars: i - from, outcome: 'STOP' };
    if (hitTarget) return { r: RR - costR, bars: i - from, outcome: 'TARGET' };
  }
  const last = H1.c[Math.min(H1.t.length - 1, from + MAX_HOLD_H1)];
  const move = dir === 'SELL' ? (entry - last) : (last - entry);
  return { r: move / risk - costR, bars: MAX_HOLD_H1, outcome: 'EXPIRED' };
}

function main() {
  const D1 = loadBars(SYMBOL, 'D1');
  const H1 = loadBars(SYMBOL, 'H1');
  if (!D1 || !H1) { console.error('missing history for ' + SYMBOL + ' (need D1 and H1)'); process.exit(1); }
  const spread = SPREAD[SYMBOL] != null ? SPREAD[SYMBOL] : 0;

  const ema = emaSeries(H1.c, EMA_LEN);
  const atr = atrSeries(H1.h, H1.l, H1.c, ATR_LEN);

  const trades = [];
  const controls = [];

  // Walk consecutive, non-overlapping block pairs on the daily.
  for (let b = 0; b + 2 * BLOCK <= D1.t.length; b += 1) {
    const a0 = b, a1 = b + BLOCK - 1;             // block 1
    const c0 = b + BLOCK, c1 = b + 2 * BLOCK - 1; // block 2
    const dir1 = D1.c[a1] - D1.c[a0];
    const dir2 = D1.c[c1] - D1.c[c0];

    let side = null;
    if (dir1 < 0 && dir2 > 0 && ALLOW_SHORT) side = 'SELL';
    else if (dir1 > 0 && dir2 < 0 && ALLOW_LONG) side = 'BUY';
    if (!side) continue;

    // 80% of block 2's range. For a SELL we want the upper zone; for the mirror, lower.
    let hi = -Infinity, lo = Infinity;
    for (let i = c0; i <= c1; i++) { if (D1.h[i] > hi) hi = D1.h[i]; if (D1.l[i] < lo) lo = D1.l[i]; }
    const range = hi - lo;
    if (!(range > 0)) continue;
    const zone = side === 'SELL' ? lo + ZONE_PCT * range : hi - ZONE_PCT * range;

    // Arm from the H1 bar after block 2 closes; expire after EXPIRY_DAYS.
    const startTs = D1.t[c1] + 86400;
    const endTs   = startTs + EXPIRY_DAYS * 86400;
    let armed = false;

    for (let i = 0; i < H1.t.length; i++) {
      if (H1.t[i] < startTs) continue;
      if (H1.t[i] > endTs) break;
      if (ema[i] == null || atr[i] == null) continue;

      // Price must trade INTO the 80% zone before the trigger counts.
      if (!armed) {
        if (side === 'SELL' ? H1.h[i] >= zone : H1.l[i] <= zone) armed = true;
        continue;
      }
      if (!inSession(H1.t[i])) continue;

      const trigger = side === 'SELL' ? (H1.c[i] < ema[i]) : (H1.c[i] > ema[i]);
      if (!trigger) continue;

      const entry = H1.c[i];
      const dist  = ATR_SL * atr[i];
      const stop   = side === 'SELL' ? entry + dist : entry - dist;
      const target = side === 'SELL' ? entry - RR * dist : entry + RR * dist;

      const res = runTrade(H1, i, side, entry, stop, target, spread);
      if (res) trades.push({ ts: H1.t[i], side, ...res });

      // MATCHED CONTROL: identical direction and identical stop/target DISTANCES,
      // entered at an unrelated bar. If the control earns what the strategy earns,
      // the strategy is geometry rather than edge.
      const ci = i + CTRL_OFFSET;
      if (ci + 1 < H1.t.length && atr[ci] != null) {
        const ce = H1.c[ci];
        const cs = side === 'SELL' ? ce + dist : ce - dist;
        const ct = side === 'SELL' ? ce - RR * dist : ce + RR * dist;
        const cr = runTrade(H1, ci, side, ce, cs, ct, spread);
        if (cr) controls.push({ ts: H1.t[ci], side, ...cr });
      }
      break; // one trade per setup
    }
  }

  const say = console.log;
  const bar = '='.repeat(104);
  say(bar);
  say('  GC 5-DAY BLOCK BIAS  --  ' + SYMBOL + '   (the strategy from the 2026-09-05 screenshots)');
  say(bar);
  say('  bias: ' + BLOCK + ' daily bars vs the next ' + BLOCK + ', direction = close(last) - close(first)');
  say('  setup: block1 down + block2 up -> SELL' + (ALLOW_LONG ? '   (mirror BUY also enabled)' : '   (shorts only, as specified)'));
  say('  zone: ' + (ZONE_PCT * 100).toFixed(0) + '% of block2 range | trigger: H1 close through EMA' + EMA_LEN +
      ' in ' + SESSION.toUpperCase() + ' | stop ' + ATR_SL + 'xATR' + ATR_LEN);
  say('  target: ' + RR + 'R  <-- NOT specified in the source; this result is conditional on it');
  say('  costs: measured spread ' + spread + ' charged per trade | expiry ' + EXPIRY_DAYS + 'd | max hold ' + MAX_HOLD_H1 + ' H1 bars');
  say('');

  if (!trades.length) { say('  NO TRADES -- the setup never triggered on this history. That is a finding, not a crash.'); say(bar); return; }

  const sum = (a, f) => a.reduce((x, y) => x + f(y), 0);
  const stat = (arr, label) => {
    if (!arr.length) return '  ' + label.padEnd(10) + ' no trades';
    const n = arr.length;
    const wins = arr.filter(t => t.r > 0).length;
    const net = sum(arr, t => t.r);
    const gp = sum(arr.filter(t => t.r > 0), t => t.r);
    const gl = Math.abs(sum(arr.filter(t => t.r <= 0), t => t.r));
    const pf = gl > 0 ? gp / gl : Infinity;
    return '  ' + label.padEnd(10) + String(n).padStart(6) + '  ' + (wins / n * 100).toFixed(1).padStart(6) +
           '  ' + (isFinite(pf) ? pf.toFixed(3) : 'inf').padStart(7) + '  ' + (net / n >= 0 ? '+' : '') + (net / n).toFixed(4).padStart(8) +
           '  ' + (net >= 0 ? '+' : '') + net.toFixed(2).padStart(9);
  };

  say('  set         trades     WR%       PF   R/trade      netR');
  say('  ' + '-'.repeat(58));
  say(stat(trades, 'STRATEGY'));
  say(stat(controls, 'CONTROL'));
  const edge = (sum(trades, t => t.r) / trades.length) - (controls.length ? sum(controls, t => t.r) / controls.length : 0);
  say('');
  say('  EDGE OVER MATCHED CONTROL: ' + (edge >= 0 ? '+' : '') + edge.toFixed(4) + ' R/trade');
  say('    (this is the number that decides it -- raw R/trade can be pure trade geometry)');

  // five chronological folds
  say('');
  const per = Math.floor(trades.length / FOLDS);
  if (per >= 1) {
    let pos = 0;
    const parts = [];
    for (let f = 0; f < FOLDS; f++) {
      const slice = trades.slice(f * per, f === FOLDS - 1 ? trades.length : (f + 1) * per);
      const rr = sum(slice, t => t.r) / (slice.length || 1);
      if (rr > 0) pos++;
      parts.push((rr >= 0 ? '+' : '') + rr.toFixed(3));
    }
    say('  FOLDS (' + FOLDS + ' chronological): ' + parts.join('  ') + '   -> ' + pos + '/' + FOLDS + ' positive');
  } else {
    say('  FOLDS: too few trades to split into ' + FOLDS + ' -- not enough evidence to judge.');
  }

  const outcomes = {};
  for (const t of trades) outcomes[t.outcome] = (outcomes[t.outcome] || 0) + 1;
  say('  outcomes: ' + Object.entries(outcomes).map(([k, v]) => k + ' ' + v).join(' | '));
  say('  feedsTheGate: false -- this measures, it admits and suppresses nothing.');
  say(bar);
}

main();
