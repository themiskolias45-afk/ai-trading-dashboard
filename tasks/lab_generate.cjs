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

const path = require('path');
const ROOT = path.join(__dirname, '..');

const { STRATEGIES, SESSIONS, availableSymbols } = require(path.join(__dirname, 'lab_strategies.cjs'));
const { validateSpec } = require(path.join(__dirname, 'lab_run.cjs'));
const registry = require(path.join(__dirname, 'lab_registry.cjs'));
const queue = require(path.join(__dirname, 'lab_queue.cjs'));

// ── the declared space ──────────────────────────────────────────────────────
// SMALL ON PURPOSE. Every cell is a trial, and a trial raises the bar for its whole
// family. Widen this deliberately, never casually.
const SYMBOLS    = ['XAUUSD', 'BTCUSD', 'SP500', 'NAS100'];
const TIMEFRAMES = ['H1', 'H4'];          // M15 is noisy and D1 is thin; both can be added
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

/** Every candidate in the declared space, grouped by family. Deterministic order. */
function enumerateSpace() {
  const have = new Set(availableSymbols());
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
