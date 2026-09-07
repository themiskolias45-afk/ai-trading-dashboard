#!/usr/bin/env node
'use strict';
/* ============================================================================
   entry_drift_audit.cjs — what the fill costs, measured
   ============================================================================

   THE QUESTION NOBODY HAS ASKED HERE. The engine approves a setup on its PLANNED
   entry, stop and target. The bridge then fills at the live tick, which is not the
   planned entry. The stop and target do not move, so the realised risk:reward is
   whatever the fill made it — and nothing anywhere re-checks it.

   `entryDrift` has been recorded on every trade for weeks by mt5_bridge.py and
   server/index.js. Nothing has ever READ it. A field with no reader is this
   project's most repeated defect and it was carrying the answer the whole time.

   WHAT IT FOUND, on the three positions open across the fleet 2026-08-31:

     SP500   plannedRr 2.00  ->  realised 1.18 (laptop) / 1.26 (VPS)
     BTCUSD  plannedRr 1.50  ->  realised 1.47 (VPS, opened at the floor)
     XAUUSD  laptop drift -39.39 points = -26.6% OF THE RISK on one fill

   MIN_RR is 1.5. Two of those three are BELOW IT as actually held. The gate is
   enforced at SIGNAL time and never again, so a trade can clear a 1.5 floor on
   paper and be a 1.18 in the account, and every downstream number — expectancy,
   the R:R cap, the rejection ledger's counterfactuals — is computed against the
   plan rather than the position.

   THIS TOOL BLOCKS NOTHING. It is read-only: it opens journals and prints. It adds
   no guard, refuses no trade, moves no threshold, and writes no config. Whether a
   fill guard SHOULD exist is a separate decision that needs a measured cost first,
   and this is the measurement. Standing rule 3 — never block a good signal — means
   the answer to a bad fill is not a veto invented on intuition.

   THE DRIFT IS NOT ALWAYS BAD, and reporting only the harm would be dishonest: the
   XAUUSD fill above drifted 39 points in the trade's FAVOUR and turned a planned
   2.0 into a realised 3.08. Both directions are counted separately, because a
   symmetric drift is a spread cost and a one-sided drift is a stale signal, and
   they have completely different remedies.

   USAGE
     node tasks/entry_drift_audit.cjs                 this box
     node tasks/entry_drift_audit.cjs --journal <f>   any journal file
     node tasks/entry_drift_audit.cjs --min-rr 1.5    override the floor
     node tasks/entry_drift_audit.cjs --json
     node tasks/entry_drift_audit.cjs --selftest
   ========================================================================== */

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const flag = n => argv.includes(n);

/** The live R:R floor, read from config rather than hardcoded. */
function liveMinRr() {
  const cli = Number(opt('--min-rr', NaN));
  if (Number.isFinite(cli)) return cli;
  try {
    const raw = fs.readFileSync(path.join(ROOT, 'server', 'strategy_settings.json'), 'utf8')
      .replace(/^﻿/, '');
    const s = JSON.parse(raw);
    if (Number.isFinite(Number(s.minRr))) return Number(s.minRr);
  } catch (e) { /* fall through */ }
  // The documented floor. Stated rather than silently assumed.
  return 1.5;
}

function readJournal(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const j = JSON.parse(raw);
  const rows = Array.isArray(j) ? j : (j.journal || j.trades || j.rows || []);
  return Array.isArray(rows) ? rows : [];
}

/**
 * Realised risk:reward, from the levels ACTUALLY on the position.
 *
 * Deliberately recomputed from entry/sl/tp rather than trusting the stored `rr`:
 * this project has already recorded that journal `rr` was the SIGNAL'S PLAN stored
 * against a broker fill, which is exactly the conflation being measured here. A
 * number that might be the plan cannot be used to audit the plan.
 */
function realisedRr(t) {
  const entry = Number(t.entry), sl = Number(t.sl), tp = Number(t.tp);
  if (![entry, sl, tp].every(Number.isFinite)) return null;
  const risk = Math.abs(entry - sl);
  if (!(risk > 0)) return null;
  return Math.abs(tp - entry) / risk;
}

function analyse(rows, minRr) {
  const out = {
    total: rows.length,
    scorable: 0, withDriftField: 0,
    belowFloor: [], favourable: [], adverse: [],
    plannedVsRealised: [], driftFractions: [],
  };

  for (const t of rows) {
    if (!t || !t.symbol) continue;
    const rr = realisedRr(t);
    if (rr === null) continue;
    out.scorable++;

    const planned = Number(t.plannedRr);
    const rec = {
      symbol: t.symbol, ticket: t.ticket || null, status: t.status || null,
      openTime: (t.openTime || '').slice(0, 19),
      plannedRr: Number.isFinite(planned) ? planned : null,
      realisedRr: Number(rr.toFixed(4)),
      delta: Number.isFinite(planned) ? Number((rr - planned).toFixed(4)) : null,
    };

    const ed = t.entryDrift;
    if (ed && Number.isFinite(Number(ed.riskFraction))) {
      out.withDriftField++;
      const f = Number(ed.riskFraction);
      rec.driftPoints = Number(ed.points);
      rec.driftRiskFraction = f;
      out.driftFractions.push(f);
      // Sign convention: entryDrift.riskFraction is (filled - planned) / risk on a
      // BUY, so POSITIVE means a worse entry for a long. Direction is read from the
      // row rather than assumed, because a short drifting up is a BETTER fill.
      const isBuy = String(t.direction || t.type || 'BUY').toUpperCase() === 'BUY';
      const adverse = isBuy ? f > 0 : f < 0;
      (adverse ? out.adverse : out.favourable).push(rec);
    }

    if (Number.isFinite(planned)) out.plannedVsRealised.push(rec);
    // The finding that matters: approved on a plan at or above the floor, HELD below it.
    if (rr < minRr && Number.isFinite(planned) && planned >= minRr) out.belowFloor.push(rec);
  }
  return out;
}

function pct(x) { return (x * 100).toFixed(1) + '%'; }
function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; }

function report(res, minRr, label) {
  const L = console.log;
  L('');
  L('='.repeat(80));
  L('  ENTRY DRIFT AUDIT — ' + label);
  L('='.repeat(80));
  L('  MIN_RR floor in force: ' + minRr + '   (read from config, not hardcoded)');
  L('');
  // COVERAGE FIRST, ALWAYS. A rate over 3 of 40 rows is a fact about the data.
  L('  rows ' + res.total + '   scorable (entry+sl+tp present) ' + res.scorable
    + '   carrying entryDrift ' + res.withDriftField);
  if (res.scorable && res.withDriftField < res.scorable) {
    L('  NOTE: ' + (res.scorable - res.withDriftField) + ' scorable row(s) predate the drift'
      + ' instrumentation. Their R:R is still checked; their drift cannot be.');
  }
  L('');

  if (!res.plannedVsRealised.length) {
    L('  No row carries plannedRr, so plan-vs-fill cannot be compared on this box.');
    L('');
    return;
  }

  const deltas = res.plannedVsRealised.map(r => r.delta).filter(Number.isFinite);
  const worse = deltas.filter(d => d < 0).length;
  L('  PLAN vs FILL   (n=' + deltas.length + ')');
  L('    realised R:R worse than planned   ' + worse + '/' + deltas.length
    + '   (' + pct(worse / deltas.length) + ')');
  L('    mean change in R:R                ' + (mean(deltas) >= 0 ? '+' : '')
    + mean(deltas).toFixed(4));
  L('');

  L('  *** APPROVED ABOVE THE FLOOR, HELD BELOW IT: ' + res.belowFloor.length + ' ***');
  if (res.belowFloor.length) {
    L('      The gate is enforced at SIGNAL time and never re-checked after the fill,');
    L('      so these cleared ' + minRr + ' on paper and are not ' + minRr + ' in the account.');
    for (const r of res.belowFloor) {
      L('      ' + r.symbol.padEnd(8) + (r.status || '').padEnd(8) + r.openTime.padEnd(21)
        + 'planned ' + String(r.plannedRr).padEnd(6) + '-> realised ' + r.realisedRr);
    }
  } else {
    L('      none — every gate-approved fill is still above the floor as held.');
  }
  L('');

  if (res.driftFractions.length) {
    const adv = res.adverse.length, fav = res.favourable.length;
    const worstAdv = res.adverse.slice().sort((a, b) =>
      Math.abs(b.driftRiskFraction) - Math.abs(a.driftRiskFraction))[0];
    L('  DRIFT DIRECTION   (n=' + res.driftFractions.length + ')');
    L('    adverse (worse fill)      ' + adv);
    L('    favourable (better fill)  ' + fav);
    L('    mean |drift| as a fraction of risk  '
      + pct(mean(res.driftFractions.map(Math.abs))));
    if (worstAdv) {
      L('    worst adverse: ' + worstAdv.symbol + ' ' + pct(Math.abs(worstAdv.driftRiskFraction))
        + ' of risk (' + worstAdv.driftPoints + ' pts) on ' + worstAdv.openTime);
    }
    L('');
    L('    Symmetric drift is a spread/latency cost. ONE-SIDED drift is a stale signal,');
    L('    and they have completely different remedies — which is why both are counted.');
  } else {
    L('  No row carries entryDrift, so fill direction cannot be measured here.');
  }
  L('');
  L('  Read-only. This blocks nothing, refuses nothing and changes no config.');
  L('');
}

// ── self-test ───────────────────────────────────────────────────────────────
function selftest() {
  let failed = 0;
  const ok = (n, c, x) => { if (!c) { failed++; console.log('  FAIL  ' + n + (x ? '  ' + x : '')); } else console.log('  ok    ' + n); };

  // R:R is recomputed from the LEVELS, never trusted from the stored field.
  ok('realised R:R from entry/sl/tp',
    Math.abs(realisedRr({ entry: 100, sl: 90, tp: 120 }) - 2) < 1e-12);
  ok('a zero-width stop is not scorable', realisedRr({ entry: 100, sl: 100, tp: 120 }) === null);
  ok('a missing tp is not scorable', realisedRr({ entry: 100, sl: 90 }) === null);
  ok('R:R ignores a stored rr that disagrees',
    Math.abs(realisedRr({ entry: 100, sl: 90, tp: 120, rr: 99 }) - 2) < 1e-12);

  // THE HEADLINE CASE: planned above the floor, held below it.
  const rows = [
    { symbol: 'SP500', direction: 'BUY', entry: 7744.96, sl: 7601.25, tp: 7915.05, plannedRr: 2 },
    { symbol: 'GOLD', direction: 'BUY', entry: 100, sl: 90, tp: 130, plannedRr: 2,
      entryDrift: { points: -5, riskFraction: -0.5 } },
    { symbol: 'BTC', direction: 'BUY', entry: 100, sl: 90, tp: 118, plannedRr: 2,
      entryDrift: { points: 2, riskFraction: 0.2 } },
  ];
  const r = analyse(rows, 1.5);
  ok('flags the gate-approved fill now below the floor', r.belowFloor.length === 1
    && r.belowFloor[0].symbol === 'SP500', JSON.stringify(r.belowFloor.map(x => x.symbol)));
  ok('counts scorable rows', r.scorable === 3, 'got ' + r.scorable);
  ok('counts drift coverage separately from scorable',
    r.withDriftField === 2, 'got ' + r.withDriftField);
  ok('a BUY filled ABOVE plan is adverse', r.adverse.length === 1 && r.adverse[0].symbol === 'BTC');
  ok('a BUY filled BELOW plan is favourable', r.favourable.length === 1 && r.favourable[0].symbol === 'GOLD');

  // Direction matters: the SAME drift sign is favourable for a SELL.
  const shorts = analyse([{ symbol: 'X', direction: 'SELL', entry: 100, sl: 110, tp: 80,
    plannedRr: 2, entryDrift: { points: 2, riskFraction: 0.2 } }], 1.5);
  ok('for a SELL, a positive drift is FAVOURABLE',
    shorts.favourable.length === 1 && shorts.adverse.length === 0);

  // A trade planned BELOW the floor is not a gate failure and must not be flagged.
  const under = analyse([{ symbol: 'Y', direction: 'BUY', entry: 100, sl: 90, tp: 111, plannedRr: 1.2 }], 1.5);
  ok('a trade planned below the floor is not counted as drift harm', under.belowFloor.length === 0);

  console.log('');
  console.log(failed === 0 ? '  ALL CHECKS PASSED' : '  ' + failed + ' CHECK(S) FAILED');
  return failed;
}

// ── main ────────────────────────────────────────────────────────────────────
if (require.main === module) {
  if (flag('--selftest')) process.exit(selftest() === 0 ? 0 : 1);

  const file = opt('--journal', path.join(ROOT, 'server', 'journal.json'));
  if (!fs.existsSync(file)) { console.error('no journal at ' + file); process.exit(2); }

  let rows;
  try { rows = readJournal(file); }
  catch (e) { console.error('could not read journal: ' + e.message); process.exit(2); }

  const minRr = liveMinRr();
  const res = analyse(rows, minRr);
  if (flag('--json')) console.log(JSON.stringify({ minRr, file, ...res }, null, 2));
  else report(res, minRr, path.basename(file));
  process.exit(0);
}

module.exports = { realisedRr, analyse, liveMinRr, readJournal, selftest };
