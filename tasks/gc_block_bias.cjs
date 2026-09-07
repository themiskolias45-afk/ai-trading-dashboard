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
function runTrade(H1, from, dir, entry, stop, target, spread, P) {
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return null;
  const costR = spread / risk;
  const hold = P.maxhold;
  for (let i = from + 1; i < Math.min(H1.t.length, from + 1 + hold); i++) {
    const hi = H1.h[i], lo = H1.l[i];
    const hitStop   = dir === 'SELL' ? hi >= stop   : lo <= stop;
    const hitTarget = dir === 'SELL' ? lo <= target : hi >= target;
    if (hitStop && hitTarget) return { r: -1 - costR, bars: i - from, outcome: 'AMBIGUOUS' };
    if (hitStop)   return { r: -1 - costR, bars: i - from, outcome: 'STOP' };
    if (hitTarget) return { r: P.rr - costR, bars: i - from, outcome: 'TARGET' };
  }
  const last = H1.c[Math.min(H1.t.length - 1, from + hold)];
  const move = dir === 'SELL' ? (entry - last) : (last - entry);
  return { r: move / risk - costR, bars: hold, outcome: 'EXPIRED' };
}

// ── the backtest, parameterised so a grid can reuse one load of the CSVs ──────
// Indicator series are cached by length: a grid over EMA lengths recomputes each
// series once, not once per configuration.
const _emaCache = new Map(), _atrCache = new Map();
function cachedEma(H1, len, key) {
  const k = key + '|e' + len;
  if (!_emaCache.has(k)) _emaCache.set(k, emaSeries(H1.c, len));
  return _emaCache.get(k);
}
function cachedAtr(H1, len, key) {
  const k = key + '|a' + len;
  if (!_atrCache.has(k)) _atrCache.set(k, atrSeries(H1.h, H1.l, H1.c, len));
  return _atrCache.get(k);
}

function backtest(D1, H1, spread, P, key) {
  const ema = cachedEma(H1, P.ema, key);
  const atr = cachedAtr(H1, P.atrlen, key);
  const trades = [], controls = [];
  const sessWin = SESSIONS[P.session];
  const inSess = ts => {
    if (!sessWin) return true;
    const h = new Date(ts * 1000).getUTCHours();
    return h >= sessWin[0] && h < sessWin[1];
  };

  for (let b = 0; b + 2 * P.block <= D1.t.length; b += 1) {
    const a0 = b, a1 = b + P.block - 1;
    const c0 = b + P.block, c1 = b + 2 * P.block - 1;
    const dir1 = D1.c[a1] - D1.c[a0];
    const dir2 = D1.c[c1] - D1.c[c0];

    let side = null;
    if (dir1 < 0 && dir2 > 0 && P.shorts) side = 'SELL';
    else if (dir1 > 0 && dir2 < 0 && P.longs) side = 'BUY';
    if (!side) continue;

    let hi = -Infinity, lo = Infinity;
    for (let i = c0; i <= c1; i++) { if (D1.h[i] > hi) hi = D1.h[i]; if (D1.l[i] < lo) lo = D1.l[i]; }
    const range = hi - lo;
    if (!(range > 0)) continue;
    const zone = side === 'SELL' ? lo + P.zone * range : hi - P.zone * range;

    const startTs = D1.t[c1] + 86400;
    const endTs = startTs + P.expiry * 86400;
    let armed = false;

    for (let i = 0; i < H1.t.length; i++) {
      if (H1.t[i] < startTs) continue;
      if (H1.t[i] > endTs) break;
      if (ema[i] == null || atr[i] == null) continue;
      if (!armed) {
        if (side === 'SELL' ? H1.h[i] >= zone : H1.l[i] <= zone) armed = true;
        continue;
      }
      if (!inSess(H1.t[i])) continue;
      const trigger = side === 'SELL' ? (H1.c[i] < ema[i]) : (H1.c[i] > ema[i]);
      if (!trigger) continue;

      const entry = H1.c[i];
      const dist = P.atrsl * atr[i];
      const stop = side === 'SELL' ? entry + dist : entry - dist;
      const target = side === 'SELL' ? entry - P.rr * dist : entry + P.rr * dist;
      const res = runTrade(H1, i, side, entry, stop, target, spread, P);
      if (res) trades.push({ ts: H1.t[i], side, ...res });

      const ci = i + P.ctrl;
      if (ci + 1 < H1.t.length && atr[ci] != null) {
        const ce = H1.c[ci];
        const cs = side === 'SELL' ? ce + dist : ce - dist;
        const ct = side === 'SELL' ? ce - P.rr * dist : ce + P.rr * dist;
        const cr = runTrade(H1, ci, side, ce, cs, ct, spread, P);
        if (cr) controls.push({ ts: H1.t[ci], side, ...cr });
      }
      break;
    }
  }
  return { trades, controls };
}

function metrics(trades, controls, folds) {
  const sum = (a, f) => a.reduce((x, y) => x + f(y), 0);
  const n = trades.length;
  if (!n) return null;
  const net = sum(trades, t => t.r);
  const gp = sum(trades.filter(t => t.r > 0), t => t.r);
  const gl = Math.abs(sum(trades.filter(t => t.r <= 0), t => t.r));
  const rpt = net / n;
  const ctrlRpt = controls.length ? sum(controls, t => t.r) / controls.length : 0;
  const per = Math.floor(n / folds);
  let pos = 0; const foldR = [];
  if (per >= 1) {
    for (let f = 0; f < folds; f++) {
      const s = trades.slice(f * per, f === folds - 1 ? n : (f + 1) * per);
      const r = sum(s, t => t.r) / (s.length || 1);
      foldR.push(r); if (r > 0) pos++;
    }
  }
  return {
    n, wr: trades.filter(t => t.r > 0).length / n * 100,
    pf: gl > 0 ? gp / gl : Infinity, rpt, netR: net,
    control: ctrlRpt, edge: rpt - ctrlRpt, foldsPos: pos, folds, foldR,
  };
}

function cliParams() {
  return {
    block: BLOCK, zone: ZONE_PCT, ema: EMA_LEN, atrlen: ATR_LEN, atrsl: ATR_SL,
    rr: RR, expiry: EXPIRY_DAYS, session: SESSION, shorts: ALLOW_SHORT,
    longs: ALLOW_LONG, ctrl: CTRL_OFFSET, maxhold: MAX_HOLD_H1,
  };
}

/* ── GRID MODE ────────────────────────────────────────────────────────────────
   Loads each symbol's CSVs ONCE and reuses them across every configuration, and
   caches each indicator series by length, because running the script per config
   spent all its time re-parsing 47,000-bar files.

   THE TRIAL COUNT IS PRINTED, AND IT IS THE POINT. A grid this size will always
   produce something that looks good; the lab's own bar exists because of that.
   So the ranking is NOT by raw R/trade: a configuration must clear the matched
   control AND be positive in at least 4 of 5 chronological folds before it is
   allowed near the top of the table. Fold consistency is the cheap defence
   against a number that is really one lucky window.
*/
function gridMode() {
  const symbols = strArg('--symbols', 'XAUUSD,BTCUSD,SP500').split(',').map(s => s.trim().toUpperCase());
  const G = {
    block:  strArg('--g-block',  '5,6,7').split(',').map(Number),
    zone:   strArg('--g-zone',   '0.8,0.9').split(',').map(Number),
    ema:    strArg('--g-ema',    '12,34,50').split(',').map(Number),
    atrsl:  strArg('--g-atrsl',  '1.5,2.0').split(',').map(Number),
    rr:     strArg('--g-rr',     '2,3').split(',').map(Number),
    session: strArg('--g-session', 'london,any').split(','),
    side:   strArg('--g-side',   'short,long').split(','),
  };
  const minTrades = numArg('--min-trades', 60);
  const top = numArg('--top', 10);

  const rows = [];
  let trials = 0;
  for (const sym of symbols) {
    if (SPREAD[sym] == null) { console.error('skipping ' + sym + ': no measured spread'); continue; }
    const D1 = loadBars(sym, 'D1'), H1 = loadBars(sym, 'H1');
    if (!D1 || !H1) { console.error('skipping ' + sym + ': missing D1 or H1 history'); continue; }
    const spread = SPREAD[sym];
    for (const block of G.block)
      for (const zone of G.zone)
        for (const ema of G.ema)
          for (const atrsl of G.atrsl)
            for (const rr of G.rr)
              for (const session of G.session)
                for (const side of G.side) {
                  const P = {
                    block, zone, ema, atrlen: ATR_LEN, atrsl, rr, expiry: EXPIRY_DAYS,
                    session, shorts: side === 'short', longs: side === 'long',
                    ctrl: CTRL_OFFSET, maxhold: MAX_HOLD_H1,
                  };
                  trials++;
                  const { trades, controls } = backtest(D1, H1, spread, P, sym);
                  const m = metrics(trades, controls, FOLDS);
                  if (!m || m.n < minTrades) continue;
                  rows.push({ sym, side, block, zone, ema, atrsl, rr, session, ...m });
                }
  }

  const bar = '='.repeat(118);
  console.log(bar);
  console.log('  GC BLOCK BIAS -- GRID.  ' + trials + ' configurations tested across ' + symbols.length + ' symbol(s).');
  console.log(bar);
  console.log('  Ranked by R/trade, but ONLY among configurations that BEAT THEIR MATCHED CONTROL');
  console.log('  and are positive in >= 4 of ' + FOLDS + ' chronological folds. With ' + trials + ' trials, anything');
  console.log('  selected on raw return alone is a lottery ticket -- these two filters are the price');
  console.log('  of looking at this many combinations at once.');
  console.log('');

  const qualified = rows.filter(r => r.edge > 0 && r.foldsPos >= 4 && r.rpt > 0);
  qualified.sort((a, b) => b.rpt - a.rpt);

  const hdr = '  #  symbol   side   blk zone ema  atr  rr  session   n     WR%     PF    R/trade   control    EDGE   folds';
  if (!qualified.length) {
    console.log('  NOTHING QUALIFIED. No configuration is simultaneously profitable, better than');
    console.log('  its control, and positive in 4 of 5 folds. That is a result, not a failure.');
  } else {
    console.log(hdr);
    console.log('  ' + '-'.repeat(114));
    qualified.slice(0, top).forEach((r, i) => {
      console.log('  ' + String(i + 1).padStart(2) + '  ' + r.sym.padEnd(8) + r.side.padEnd(7) +
        String(r.block).padEnd(4) + String(r.zone).padEnd(5) + String(r.ema).padEnd(5) +
        String(r.atrsl).padEnd(5) + String(r.rr).padEnd(4) + r.session.padEnd(9) +
        String(r.n).padStart(4) + '  ' + r.wr.toFixed(1).padStart(6) + '  ' +
        (isFinite(r.pf) ? r.pf.toFixed(3) : 'inf').padStart(6) + '  ' +
        (r.rpt >= 0 ? '+' : '') + r.rpt.toFixed(4).padStart(8) + '  ' +
        (r.control >= 0 ? '+' : '') + r.control.toFixed(4).padStart(8) + '  ' +
        (r.edge >= 0 ? '+' : '') + r.edge.toFixed(4).padStart(8) + '  ' +
        r.foldsPos + '/' + r.folds);
    });
  }

  console.log('');
  console.log('  For contrast, the best by RAW R/trade ignoring both filters:');
  const raw = rows.slice().sort((a, b) => b.rpt - a.rpt).slice(0, 3);
  raw.forEach(r => console.log('    ' + r.sym + ' ' + r.side + ' blk' + r.block + ' zone' + r.zone +
    ' ema' + r.ema + ' atr' + r.atrsl + ' rr' + r.rr + ' ' + r.session +
    '  R/t ' + (r.rpt >= 0 ? '+' : '') + r.rpt.toFixed(4) + '  edge ' + (r.edge >= 0 ? '+' : '') + r.edge.toFixed(4) +
    '  folds ' + r.foldsPos + '/' + r.folds + '  n=' + r.n));
  console.log('  If those differ from the table above, the difference IS the selection effect.');
  console.log('');
  console.log('  ' + rows.length + ' of ' + trials + ' configurations produced >= ' + minTrades + ' trades. feedsTheGate: false.');
  console.log(bar);
}

function main() {
  if (process.argv.includes('--grid')) return gridMode();
  const D1 = loadBars(SYMBOL, 'D1');
  const H1 = loadBars(SYMBOL, 'H1');
  if (!D1 || !H1) { console.error('missing history for ' + SYMBOL + ' (need D1 and H1)'); process.exit(1); }
  if (SPREAD[SYMBOL] == null) {
    console.error('REFUSING: no measured spread for ' + SYMBOL + '.');
    console.error('Running it at zero cost would flatter it against every priced symbol');
    console.error('here, which is the worst possible way to pick a winner. Add its measured');
    console.error('spread to tasks/cost_breakeven.cjs and to the table above first.');
    process.exit(2);
  }
  const spread = SPREAD[SYMBOL];

  const P = cliParams();
  const { trades, controls } = backtest(D1, H1, spread, P, SYMBOL);

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
