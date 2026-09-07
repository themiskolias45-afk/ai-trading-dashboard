#!/usr/bin/env node
'use strict';
/* ============================================================================
   lab_generate.cjs — propose candidates nobody has tried yet, forever
   ============================================================================

   The 24/7 half of the lab. It enumerates the candidate space, removes everything
   the registry has already seen, and queues the next few. The drain runs them, the
   promoter judges them. Nothing here decides anything.

   BREADTH FIRST ACROSS FAMILIES, and this is the one real design decision.

   Trials are counted per family (strategy|symbol|timeframe) and the deflated Sharpe
   is charged against that count. So a generator that hammers one family drives that
   family's bar toward unclearable while every other family sits at one trial with a
   bar anything could clear. That is not rigour, it is an artefact of the ORDER the
   robot happened to search in.

   So each cycle takes from the family with the FEWEST trials so far. Exploration
   stays even, and the deflation penalty means what it says: how hard did we look at
   THIS question.

   WHY THE GRIDS ARE COARSE. A fine grid does not find more edge, it finds more
   noise, and every cell costs a trial that raises the bar for its whole family. The
   grids below are deliberately small and DECLARED IN CODE rather than swept
   automatically, so the space is a thing you can read and argue with rather than a
   number that quietly grows.

   IT NEVER RE-QUEUES A KNOWN SPEC. Identity is the canonical spec hash from
   lab_registry.cjs, so re-running is impossible by construction rather than by
   remembering to check.

   USAGE
     node tasks/lab_generate.cjs                 queue the default batch
     node tasks/lab_generate.cjs --max 12
     node tasks/lab_generate.cjs --dry-run       print what it WOULD queue
     node tasks/lab_generate.cjs --space         how big the space is, and how much is done
     node tasks/lab_generate.cjs --selftest
   ========================================================================== */

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const { STRATEGIES, SESSIONS, availableSymbols } = require(path.join(__dirname, 'lab_strategies.cjs'));
const { validateSpec } = require(path.join(__dirname, 'lab_run.cjs'));
const registry = require(path.join(__dirname, 'lab_registry.cjs'));
const queue = require(path.join(__dirname, 'lab_queue.cjs'));

// ── the declared space ──────────────────────────────────────────────────────
// SMALL ON PURPOSE. Every cell is a trial, and a trial raises the bar for its whole
// family. Widen this deliberately, never casually.
/* NAS100 IS KEPT, ON PURPOSE. It carries a known caveat - measured 2026-09-05, 0.951
   correlation with SP500, so it is close to the same trade and must never be sized as
   an independent instrument alongside one. That is a reason to MEASURE it carefully,
   not a reason to stop looking: it goes live only if it proves it makes money, and it
   can never prove anything if the search refuses to generate it.

   I removed it earlier the same day and that was wrong - a permanent veto guarantees
   the evidence that would settle the question never accumulates.

   Its bars were 229h stale, so the freshness gate below skips it until the exporter can
   run again. That is a DATA condition that clears by itself, not a ban.
   lab_promote stages NAS100 candidates with the correlation caveat attached, so the
   warning travels with the result instead of the result being suppressed. */
const SYMBOLS    = ['XAUUSD', 'BTCUSD', 'SP500', 'NAS100'];
// D1 IS EXCLUDED, AND NOW THERE IS A NUMBER BEHIND IT. Measured 2026-09-07: the
// registry held 5,417 trials and ZERO on D1, so "D1 is thin" had never been tested.
// It is thin, and the ceiling is the point:
//
//   XAUUSD/BTCUSD/SP500 D1 hold 2,066-2,587 bars over eight years. The HIGHEST
//   frequency strategy in the lab, rsi_reversion at period 5, produces 51-53 trades.
//   tsmom produces 9-40. lab_promote requires 100.
//
// So no D1 cell can ever be promoted, and sweeping D1 would spend trials - raising the
// deflation bar for every H1 and H4 family - on candidates that are unpromotable by
// construction.
//
// AND IT WOULD PUT A TRAP IN THE REGISTRY. XAUUSD D1 swing_trend_pullback 13/34/3
// reports SURVIVES at DSR 98.0%, expectancy +0.6681R, OOS +1.4500R - on 44 TRADES.
// Anyone scanning verdicts without reading trade counts would find the best-looking
// result in the entire lab. lab_promote's MIN_TRADES floor catches it, but only
// because nothing on D1 is generated for it to catch.
//
// M15 stays out for the opposite reason: 13 trials exist and its bars are 183-229h
// stale on every symbol, so it cannot be measured honestly at the moment anyway.
const TIMEFRAMES = ['H1', 'H4'];
// SESSIONS ARE INDEPENDENT CONFIGURATIONS, NOT SLICES OF `any`. See the long note at
// SESSIONS in lab_strategies.cjs: because runStrategy holds one position at a time, a
// session filter frees the slot for signals the unfiltered run had blocked, so a
// filtered run takes trades `any` never saw - 128 of 171 in the measured case. Each
// session cell is therefore its own trial and its own candidate, which is already how
// the registry counts them; what must NOT happen is anyone reading london-vs-any as
// "where the edge lives".
//
// `asia` is deliberately absent. It is defined in lab_strategies and has never been
// swept, so no asia cell exists in the registry - a gap, not a decision. Adding it
// multiplies every family by a third again, and the deflation bar rises for all of
// them, so it is left out until there is a reason to spend that.
const SESSIONS_USED = ['any', 'london', 'ny'];

// Parameter grids per strategy, coarse and declared.
const PARAM_GRID = {
  // EVERY STRATEGY MUST HAVE AT LEAST ONE AXIS WITH >= lab_promote BAR.MIN_NEIGHBOURS
  // DISTINCT VALUES, or its candidates can never satisfy the plateau requirement and
  // are unpromotable in principle.
  //
  // This was NOT true when the grids were first written: MIN_NEIGHBOURS was 4 and not
  // one axis in the entire lab had 4 values. The promotion bar was unclearable, the
  // 24/7 loop would have searched forever and promoted nothing, and it would have
  // read as "no strategy is good enough" rather than "the gate is impossible" -- the
  // same shape as every other check in this project that could not fire and
  // therefore looked clean.
  //
  // Only ONE axis per strategy needs the width, because plateauEvidence picks the
  // BEST axis rather than requiring all of them. That is the cheap fix: widening every
  // axis would multiply the space and raise the deflation bar for no extra evidence.
  // The widened axis is marked <-- PLATEAU AXIS on each line. Guarded by a test in
  // lab_generate --selftest so it cannot silently regress.

  ema_cross:      { fast: [10, 20, 35, 50],            //  <-- PLATEAU AXIS
                    slow: [50, 100, 200] },
  donchian_break: { lookback: [20, 40, 55, 100] },     //  <-- PLATEAU AXIS
  rsi_reversion:  { period: [5, 7, 10, 14],            //  <-- PLATEAU AXIS
                    oversold: [25, 30], overbought: [70, 75] },

  // Researched additions. Grids stay COARSE otherwise: every cell is a trial that
  // raises the deflation bar for its whole family, so a wide grid makes the bar
  // harder to clear rather than the answer better.
  opening_range_breakout: { rangeBars: [1, 2, 4, 8] }, //  <-- PLATEAU AXIS
  tsmom:                  { lookback: [25, 50, 100, 200] }, // <-- PLATEAU AXIS
  bb_squeeze_break:       { period: [20, 50], mult: [2.0],
                            squeezePct: [0.01, 0.02, 0.04, 0.08] }, // <-- PLATEAU AXIS

  // Added 2026-09-07 on request, measured on H4 first. `within` is the plateau axis
  // because it is the parameter that makes this a PULLBACK rather than an EMA re-cross -
  // the first implementation had it inert, so every value scored identically and the
  // whole thing was a moving-average crossover under another name.
  swing_trend_pullback: { fast: [13, 21, 34], slow: [34, 55, 89],
                          within: [1, 3, 5, 8] },  //  <-- PLATEAU AXIS

  // ITS MATCHED CONTROL, swept alongside it ON PURPOSE. Same trend filter, no timing at
  // all. Measured 2026-09-02 by strategy_suite.cjs the control BEAT the pullback on every
  // timeframe; measured here on XAUUSD H4 with the trend filter held identical, the
  // pullback beat the control by ~0.27R/trade. Those two results disagree and both stay
  // on the record until something reconciles them. Searching the control costs trials,
  // which raises the bar for the pullback family too - that is the correct price for
  // knowing whether an edge is the idea or just the direction.
  trend_every_n: { fast: [13, 21, 34], slow: [34, 55, 89],
                   everyN: [15, 30, 45, 60] },     //  <-- PLATEAU AXIS

  // Zone breakout and the trend+zone COMBINATION, added 2026-09-07.
  //
  // Handed to the sweep rather than hand-picked, and the reason is on the record:
  // measured by hand on XAUUSD H4, breakout_zone zoneBars=8 first reported SURVIVES at
  // DSR 97.0%, then 63.7%, then 51.7% - same cell, same bars, nothing changed but the
  // number of trials in its family. The deflated Sharpe was doing its job and the first
  // reading was an artifact of a nearly empty family. Any cell I pick by hand and quote
  // has that same inflation baked in; only letting the grid fill in removes it.
  //
  // zoneBars is the plateau axis for both: on XAUUSD it ran 5..10 all positive
  // out-of-sample, while the maxZoneAtr axis went NEGATIVE at 1.2 and 1.3. One axis
  // holding and another not is exactly what plateauEvidence is for.
  breakout_zone:       { zoneBars: [5, 6, 7, 8, 10],   //  <-- PLATEAU AXIS
                         maxZoneAtr: [1.5, 2.0] },
  trend_zone_breakout: { zoneBars: [5, 6, 7, 8, 10],   //  <-- PLATEAU AXIS
                         maxZoneAtr: [1.5], fast: [21], slow: [55] },
  rsi2_pullback:          { rsiPeriod: [2], entry: [3, 5, 10, 15], // <-- PLATEAU AXIS
                            trendLen: [100, 200] },
};

// Execution variants. The trailing pair is the shape the original screenshot used.
const EXEC_GRID = [
  { atrMult: 2.0, targetR: 2.0, trailStartR: 0,   trailGiveR: 1.0, costR: 0.05 },
  { atrMult: 2.0, targetR: 3.0, trailStartR: 0,   trailGiveR: 1.0, costR: 0.05 },
  { atrMult: 2.0, targetR: 4.0, trailStartR: 2.0, trailGiveR: 4.0, costR: 0.05 },
  { atrMult: 3.0, targetR: 2.0, trailStartR: 0,   trailGiveR: 1.0, costR: 0.05 },
];

function cartesian(obj) {
  const keys = Object.keys(obj);
  let out = [{}];
  for (const k of keys) {
    const next = [];
    for (const base of out) for (const v of obj[k]) next.push({ ...base, [k]: v });
    out = next;
  }
  return out;
}

/* FROZEN BARS ARE NOT A SEARCH SPACE, AND THEY COST MORE THAN THEY LOOK.
   Measured 2026-09-07: of 78 CSVs in tasks/history only 7 were current. NAS100 ended
   2026-08-28 (229h), XAUUSD_M15 the same, and twenty other symbols were frozen at
   2026-09-02. The exporter that would refresh them refuses whenever a position is
   open - correctly, it opens a second MT5 client - and a position had been open
   since 2026-08-19, so the refusal had become permanent.

   Re-testing identical bars would merely be wasted work if the trial count were free.
   It is not: lab_registry.trialsFor() raises the deflated-Sharpe bar for a family with
   every trial in it, so trials on frozen data make the bar HARDER for the candidates
   that do have live data, while adding no information of their own. That is the search
   penalising itself for standing still.

   Per (symbol, timeframe), because XAUUSD_H1 is current while XAUUSD_M15 is not.
   96h by default: wide enough that a weekend plus a bank holiday never trips it,
   narrow enough to exclude everything measured above. */
let STALE_SKIPPED = [];

const MAX_BAR_AGE_H = Number(process.env.LAB_MAX_BAR_AGE_H) > 0
  ? Number(process.env.LAB_MAX_BAR_AGE_H) : 96;

function barAgeHours(symbol, timeframe) {
  const file = path.join(ROOT, 'tasks', 'history', symbol + '_' + timeframe + '.csv');
  let fh;
  try {
    const size = fs.statSync(file).size;
    if (!size) return null;
    // Read only the tail: these files reach tens of MB and this runs over every pair.
    const len = Math.min(4096, size);
    const buf = Buffer.alloc(len);
    fh = fs.openSync(file, 'r');
    fs.readSync(fh, buf, 0, len, size - len);
    const lines = buf.toString('utf8').trim().split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const ts = Number(String(lines[i]).split(',')[0]);
      if (Number.isFinite(ts) && ts > 0) return (Date.now() / 1000 - ts) / 3600;
    }
    return null;
  } catch (e) {
    return null;                                   // unreadable is not "fresh"
  } finally {
    if (fh !== undefined) { try { fs.closeSync(fh); } catch (e) { /* ignore */ } }
  }
}

/** Every candidate in the declared space, grouped by family. Deterministic order. */
function enumerateSpace() {
  const have = new Set(availableSymbols());
  STALE_SKIPPED = [];
  const families = new Map();
  for (const stratId of Object.keys(PARAM_GRID)) {
    if (!STRATEGIES[stratId]) continue;
    const paramSets = cartesian(PARAM_GRID[stratId]).filter(p => {
      // Skip combinations the strategy itself would reject, rather than queueing a
      // run that can only produce zero trades.
      if (stratId === 'ema_cross') return p.fast < p.slow;
      if (stratId === 'rsi_reversion') return p.oversold < p.overbought;
      return true;
    });
    for (const symbol of SYMBOLS) {
      if (!have.has(symbol)) continue;             // no bars on this box, skip quietly
      for (const timeframe of TIMEFRAMES) {
        const ageH = barAgeHours(symbol, timeframe);
        if (ageH === null || ageH > MAX_BAR_AGE_H) {
          // Dedupe on the STRING THAT IS PUSHED. The inner loop runs once per strategy,
          // so keying on a prefix while storing a decorated value lists the same market
          // once per strategy - which is how a five-line report became fifty.
          const tag = symbol + ' ' + timeframe
            + (ageH === null ? ' (unreadable)' : ' (' + ageH.toFixed(0) + 'h)');
          if (STALE_SKIPPED.indexOf(tag) < 0) STALE_SKIPPED.push(tag);
          continue;
        }
        const key = [stratId, symbol, timeframe].join('|');
        const list = families.get(key) || [];
        for (const session of SESSIONS_USED) {
          if (!Object.prototype.hasOwnProperty.call(SESSIONS, session)) continue;
          for (const params of paramSets) {
            for (const exec of EXEC_GRID) {
              try {
                list.push(validateSpec({ strategy: stratId, symbol, timeframe, session, params, exec }));
              } catch (e) { /* a spec the validator rejects is not a candidate */ }
            }
          }
        }
        families.set(key, list);
      }
    }
  }
  return families;
}

/** What has already been run, as a set of spec hashes. */
function seenHashes() {
  const seen = new Set();
  for (const row of registry.readAll()) if (row && row.specHash) seen.add(row.specHash);
  // Anything already QUEUED counts as seen too, or a slow drain would let the
  // generator queue the same spec again on the next tick.
  for (const job of queue.state()) {
    if (job && job.spec && job.status === 'QUEUED') {
      try { seen.add(registry.specHash(job.spec)); } catch (e) { /* ignore */ }
    }
  }
  return seen;
}

/**
 * Choose the next batch: repeatedly take from the family with the FEWEST trials that
 * still has an untried candidate. See the header for why order matters.
 */
function pickBatch(max) {
  const families = enumerateSpace();
  const seen = seenHashes();

  const state = [];
  for (const [key, specs] of families) {
    const untried = specs.filter(s => !seen.has(registry.specHash(s)));
    if (!untried.length) continue;
    // Trials so far in this family, from the registry.
    const trials = registry.trialsFor(untried[0]) - 1;   // -1: trialsFor counts the pending one
    state.push({ key, untried, trials });
  }

  const batch = [];
  while (batch.length < max && state.some(f => f.untried.length)) {
    state.sort((a, b) => (a.trials - b.trials) || a.key.localeCompare(b.key));
    const target = state.find(f => f.untried.length);
    if (!target) break;
    batch.push(target.untried.shift());
    target.trials++;                      // so the next pick moves to another family
  }
  return batch;
}

function spaceReport() {
  const families = enumerateSpace();
  const seen = seenHashes();
  let total = 0, done = 0;
  const rows = [];
  for (const [key, specs] of families) {
    const d = specs.filter(s => seen.has(registry.specHash(s))).length;
    total += specs.length; done += d;
    rows.push({ key, total: specs.length, done: d });
  }
  rows.sort((a, b) => (a.done / a.total) - (b.done / b.total) || a.key.localeCompare(b.key));
  return { total, done, rows };
}

// ── self-test ───────────────────────────────────────────────────────────────
function selftest() {
  let failed = 0;
  const ok = (n, c, x) => { if (!c) { failed++; console.log('  FAIL  ' + n + (x ? '  ' + x : '')); } else console.log('  ok    ' + n); };

  const c = cartesian({ a: [1, 2], b: [3, 4] });
  ok('cartesian covers every combination', c.length === 4);

  const fams = enumerateSpace();
  ok('the space is non-empty', fams.size > 0, 'families=' + fams.size);

  // ema_cross must never emit fast >= slow: those produce zero trades by construction.
  let bad = 0;
  for (const [k, specs] of fams) {
    if (!k.startsWith('ema_cross')) continue;
    for (const s of specs) if (s.params.fast >= s.params.slow) bad++;
  }
  ok('ema_cross never emits fast >= slow', bad === 0, 'bad=' + bad);

  // Every emitted spec must already be valid — the generator validates as it builds.
  let invalid = 0;
  for (const [, specs] of fams) for (const s of specs.slice(0, 3)) {
    try { validateSpec(s); } catch (e) { invalid++; }
  }
  ok('every emitted spec revalidates', invalid === 0, 'invalid=' + invalid);

  // A batch must contain no duplicates, and must spread across families.
  const b = pickBatch(8);
  const hashes = new Set(b.map(s => registry.specHash(s)));
  ok('a batch has no duplicate specs', hashes.size === b.length, b.length + ' vs ' + hashes.size);
  if (b.length >= 4) {
    const famsInBatch = new Set(b.map(s => registry.familyOf(s)));
    ok('a batch spreads across families', famsInBatch.size > 1, 'families=' + famsInBatch.size);
  }
  // And nothing already run may reappear.
  const seen = seenHashes();
  ok('a batch never re-queues a known spec', b.every(s => !seen.has(registry.specHash(s))));

  // THE REACHABILITY GUARD. Every strategy must have at least one axis wide enough
  // to satisfy the promotion bar's plateau requirement. Without this the bar is
  // unclearable in principle and the whole 24/7 loop is decoration -- which is
  // exactly what shipped the first time, on every single axis.
  {
    let minNeighbours = 4;
    try { minNeighbours = require(path.join(__dirname, 'lab_promote.cjs')).BAR.MIN_NEIGHBOURS; }
    catch (e) { /* fall back to the documented default */ }
    const fams = enumerateSpace();
    const perStrat = {};
    for (const [key, specs] of fams) {
      const strat = key.split('|')[0];
      if (perStrat[strat] || !specs.length) continue;
      const axes = {};
      for (const p of Object.keys(specs[0].params)) axes[p] = new Set(specs.map(x => x.params[p]));
      perStrat[strat] = axes;
    }
    for (const [strat, axes] of Object.entries(perStrat)) {
      const widest = Math.max(...Object.values(axes).map(v => v.size));
      ok(strat + ' has a plateau axis (>= ' + minNeighbours + ' values)',
        widest >= minNeighbours, 'widest axis has ' + widest);
    }
  }

  console.log('');
  console.log(failed === 0 ? '  ALL CHECKS PASSED' : '  ' + failed + ' CHECK(S) FAILED');
  return failed;
}

// ── CLI ─────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const argv = process.argv.slice(2);
  const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };

  if (argv.includes('--selftest')) process.exit(selftest() === 0 ? 0 : 1);

  if (argv.includes('--space')) {
    const s = spaceReport();
    console.log('');
    console.log('  declared space: ' + s.done + ' / ' + s.total + ' explored ('
      + (s.total ? (100 * s.done / s.total).toFixed(1) : '0') + '%)');
    console.log('');
    for (const r of s.rows.slice(0, 24)) {
      console.log('  ' + r.key.padEnd(34) + String(r.done).padStart(4) + ' / ' + String(r.total).padEnd(6)
        + (r.done === r.total ? ' complete' : ''));
    }
    console.log('');
    process.exit(0);
  }

  const max = Math.max(1, Math.min(50, Number(opt('--max', '8'))));
  const dry = argv.includes('--dry-run');

  // DO NOT PILE UP. If the drain is behind, adding more is pointless and would only
  // grow a backlog nobody reads.
  const pending = queue.state().filter(j => j.status === 'QUEUED').length;
  const HEADROOM = 40;
  if (pending >= HEADROOM) {
    console.log('  ' + pending + ' already pending (headroom ' + HEADROOM + ') — generated nothing.');
    process.exit(0);
  }

  const batch = pickBatch(Math.min(max, HEADROOM - pending));
  // SAY WHAT WAS EXCLUDED AND WHY. A silent skip and a fully-explored space print the
  // same "nothing new to queue", and those are opposite facts: one means the search is
  // finished, the other means it is blind on that market.
  if (STALE_SKIPPED.length) {
    console.log('');
    console.log('  SKIPPED — bars older than ' + MAX_BAR_AGE_H + 'h, so a trial there would'
      + ' re-test frozen data and raise its family bar for nothing:');
    for (const t of STALE_SKIPPED) console.log('    ' + t);
    console.log('    Refresh is tasks/refresh_bars_vps.bat, which REFUSES while a position'
      + ' is open (it opens a second MT5 client). Override with LAB_MAX_BAR_AGE_H.');
  }

  if (!batch.length) {
    console.log('  the declared space is fully explored — nothing new to queue.');
    console.log('  Widen tasks/lab_generate.cjs deliberately: every new cell is a trial that');
    console.log('  raises the bar for its whole family.');
    process.exit(0);
  }

  console.log('');
  for (const s of batch) {
    const line = '  ' + s.strategy.padEnd(16) + s.symbol.padEnd(8) + s.timeframe.padEnd(5)
      + s.session.padEnd(8) + JSON.stringify(s.params);
    if (dry) console.log('  WOULD QUEUE' + line);
    else { queue.enqueue(s, 'generator'); console.log('  queued' + line); }
  }
  console.log('');
  console.log('  ' + (dry ? 'DRY RUN — nothing queued.' : batch.length + ' queued. The drain will run them.'));
  console.log('');
  process.exit(0);
}

module.exports = { enumerateSpace, pickBatch, spaceReport, seenHashes, cartesian, selftest };
