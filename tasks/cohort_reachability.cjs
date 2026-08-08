#!/usr/bin/env node
'use strict';

// Which signal cohorts can mathematically reach the live confidence gate?
//
// WHY THIS EXISTS
// ---------------
// This system encodes "this cohort has poor edge" as a LOW CONFIDENCE NUMBER rather
// than as an explicit block. That works right up until the gate moves. On 2026-08-02
// confidenceThreshold went 65 -> 70 and every per-asset base confidence tuned against
// 65 was left untouched, so cohorts silently became unreachable and nothing said so.
//
// It has now happened three times:
//   * Gold's neutral-H4 cohort capped at 74 under a floor of 75 — 1131 steps, 0 fires
//   * SPX H4-only, base 45, ceiling 60, against a 65 and then a 70 gate. The comment
//     beside it still reads "needs exceptional quality boosts to clear 65 gate" — it
//     could not clear 65 either.
//   * BTC H4-only MODERATE, base 50, ceiling 65: alive at gate 65, dead at gate 70.
//
// A dead cohort is invisible in every existing report. It produces no trades, so it
// contributes nothing to the journal, nothing to the learning table, and no error. It
// looks exactly like a quiet market.
//
// THE TRAP THIS ALSO CATCHES
// --------------------------
// getLearningBoost (server/index.js:460) returns 0 until a setup has >= 5 CLOSED
// trades, and can then add at most +/-15. So the learning engine can only ever
// amplify a cohort that is ALREADY firing. It cannot rescue a dead one: the cohort
// needs trades to earn the boost, and needs the boost to get trades. Any reachability
// maths that assumes the learning boost will save a cohort is wrong, which is why
// LEARNING_BOOST_WHEN_COLD below is 0 and not 15.
//
// Read-only. Computes nothing the engine uses; it only reports.

const fs   = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const INDEX_JS     = path.join(PROJECT_ROOT, 'server', 'index.js');
const SETTINGS     = path.join(PROJECT_ROOT, 'server', 'strategy_settings.json');

// ── The boost stack, mirrored from server/index.js:1505-1527 ──────────────────
// A signal has exactly ONE setup, so only ONE setup bonus can ever apply. The best
// available is SQUEEZE_BREAKOUT at +10, and it requires confirmed volume, which is
// the same condition the +5 volume boost needs. Best case is therefore +15 and
// requires a SQUEEZE_BREAKOUT on confirmed volume.
const VOLUME_BOOST         = 5;
const BEST_SETUP_BOOST     = 10;   // SQUEEZE_BREAKOUT + confirmed volume
// Deliberately 0. See "THE TRAP THIS ALSO CATCHES" above.
const LEARNING_BOOST_WHEN_COLD = 0;
const MAX_BOOST = VOLUME_BOOST + BEST_SETUP_BOOST + LEARNING_BOOST_WHEN_COLD;

// ── The cohort table, mirrored from server/index.js:1404-1484 ─────────────────
// `guard` is a literal that MUST still be present in index.js. If someone changes a
// base confidence and forgets this file, the guard check below fails loudly rather
// than letting this report quietly describe a system that no longer exists.
const COHORTS = [
  { name: 'Daily+H4 agree, both STRONG',        base: 95, guard: 'confidence = 95' },
  { name: 'Triple alignment, all STRONG',       base: 97, guard: 'allStrong ? 97 : 88' },
  { name: 'Daily+H4 agree, one STRONG',         base: 88, guard: '? 88 : 72' },
  { name: 'Daily+H4 agree, both MODERATE',      base: 72, guard: '? 88 : 72' },
  { name: 'Gold daily-neutral-H4, MODERATE',    base: 72, guard: 'daily.strength === "MODERATE" ? 72' },
  { name: 'Gold daily-neutral-H4, STRONG',      base: 70, guard: 'daily.strength === "STRONG"   ? 70' },
  { name: 'Gold H4-only, STRONG',               base: 68, guard: 'h4.strength === "STRONG" ? 68' },
  { name: 'Gold H4-only, MODERATE + squeeze',   base: 70, guard: 'GOLD_SQUEEZE_MODERATE_CONFIDENCE' },
  { name: 'Gold H4-only, MODERATE non-squeeze', base: 55, guard: ': 55;' },
  { name: 'BTC H4-only, STRONG',                base: 63, guard: 'h4.strength === "STRONG" ? 63' },
  { name: 'BTC H4-only, MODERATE',              base: 50, guard: 'h4.strength === "MODERATE" ? 50' },
  { name: 'SPX H4-only (any strength)',         base: 45, guard: 'confidence = 45' },
  { name: 'Daily fires, H4 disagrees (non-Gold)', base: 40, guard: 'daily.signal === "WAIT" ? 0 : 40' },
];

function readGate() {
  // Mirrors the server's own loader: strip a UTF-8 BOM, and treat an unreadable file
  // as the built-in default rather than guessing, because that is what the server
  // itself would then be running.
  try {
    const raw = fs.readFileSync(SETTINGS, 'utf8').replace(/^﻿/, '');
    const parsed = JSON.parse(raw);
    const gate = Number(parsed.confidenceThreshold);
    if (Number.isFinite(gate)) return { gate, source: path.basename(SETTINGS) };
  } catch (e) {
    // fall through
  }
  return { gate: 70, source: 'BUILT-IN DEFAULT (strategy_settings.json unreadable)' };
}

function checkGuards(source) {
  const drifted = COHORTS.filter(c => !source.includes(c.guard));
  return drifted;
}

function main() {
  let source;
  try {
    source = fs.readFileSync(INDEX_JS, 'utf8');
  } catch (e) {
    console.error(`FATAL: cannot read ${INDEX_JS}: ${e.message}`);
    process.exit(2);
  }

  const { gate, source: gateSource } = readGate();
  const drifted = checkGuards(source);

  console.log('='.repeat(78));
  console.log('COHORT REACHABILITY — can each cohort mathematically reach the gate?');
  console.log('='.repeat(78));
  console.log(`gate           ${gate}   (from ${gateSource})`);
  console.log(`max boost      +${MAX_BOOST}   (+${VOLUME_BOOST} volume, +${BEST_SETUP_BOOST} best setup, +${LEARNING_BOOST_WHEN_COLD} learning)`);
  console.log(`learning boost 0 until a setup has 5 CLOSED trades — it cannot rescue a dead cohort`);
  console.log('');

  if (drifted.length > 0) {
    console.log('!! TABLE DRIFT — these cohorts no longer match server/index.js:');
    for (const d of drifted) console.log(`     ${d.name}  (expected to find: ${d.guard})`);
    console.log('   The report below may describe a system that no longer exists. Fix this file.');
    console.log('');
  }

  const rows = COHORTS
    .map(c => ({ ...c, ceiling: Math.min(100, c.base + MAX_BOOST) }))
    .map(c => ({
      ...c,
      // Reachable at base means it fires with no help at all. Reachable only at the
      // ceiling means it needs a perfect storm: the single best setup type AND
      // confirmed volume, together, or it never fires.
      status: c.base >= gate ? 'FIRES AT BASE'
            : c.ceiling >= gate ? 'NEEDS BOOST'
            : 'DEAD',
      short: gate - c.ceiling,
    }))
    .sort((a, b) => a.base - b.base);

  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad('cohort', 42) + pad('base', 6) + pad('ceiling', 9) + pad('status', 15) + 'note');
  console.log('-'.repeat(78));
  for (const r of rows) {
    let note = '';
    if (r.status === 'DEAD')        note = `unreachable — ${r.short} short of the gate`;
    else if (r.status === 'NEEDS BOOST') note = `needs +${gate - r.base} of the +${MAX_BOOST} available`;
    console.log(pad(r.name, 42) + pad(r.base, 6) + pad(r.ceiling, 9) + pad(r.status, 15) + note);
  }

  const dead = rows.filter(r => r.status === 'DEAD');
  const tight = rows.filter(r => r.status === 'NEEDS BOOST' && gate - r.base > BEST_SETUP_BOOST);

  console.log('');
  console.log('-'.repeat(78));
  if (dead.length === 0) {
    console.log('OK — every cohort can reach the gate.');
  } else {
    console.log(`${dead.length} COHORT(S) CANNOT EVER FIRE at gate ${gate}:`);
    for (const d of dead) {
      console.log(`  ${d.name}: ceiling ${d.ceiling}, needs ${d.short} more than the boost stack can give`);
    }
    console.log('');
    console.log('These produce no trades, so they add nothing to the journal and nothing to');
    console.log('the learning table, and they raise no error. They look like a quiet market.');
    console.log('');
    console.log('Fix by DECIDING which they are, and saying so explicitly:');
    console.log('  - meant to be blocked  -> block it by name, do not encode it as a low score');
    console.log('  - meant to be tradeable -> its base must be within the boost stack of the gate');
  }
  if (tight.length > 0) {
    console.log('');
    console.log(`${tight.length} cohort(s) need MORE than the best single setup bonus (+${BEST_SETUP_BOOST}),`);
    console.log('so they fire only on a perfect storm of setup type AND confirmed volume:');
    for (const t of tight) console.log(`  ${t.name}: base ${t.base}, needs +${gate - t.base}`);
  }
  console.log('='.repeat(78));

  // Exit 1 on a dead cohort or a drifted table so this can gate a scheduled check.
  process.exit(dead.length > 0 || drifted.length > 0 ? 1 : 0);
}

main();
