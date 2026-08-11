#!/usr/bin/env node
'use strict';

// Report which signal cohorts can mathematically reach the live confidence gate.
//
// The table and the arithmetic live in server/cohort_table.js so this script and the
// server cannot drift apart. This file is only the report and the exit code.
//
// Run it after ANY change to confidenceThreshold or to a per-asset base confidence.
// Exits 1 on a dead cohort or a drifted table, so it can gate a scheduled check.

const fs   = require('fs');
const path = require('path');

const {
  VOLUME_BOOST,
  BEST_SETUP_BOOST,
  LEARNING_BOOST_WHEN_COLD,
  MAX_BOOST,
  computeReachability,
  findTableDrift,
} = require('../server/cohort_table.js');

const PROJECT_ROOT = path.join(__dirname, '..');
const INDEX_JS     = path.join(PROJECT_ROOT, 'server', 'index.js');
const SETTINGS     = path.join(PROJECT_ROOT, 'server', 'strategy_settings.json');

function readGate() {
  // Mirrors the server's own loader: strip a UTF-8 BOM, and treat an unreadable file
  // as the built-in default, because that is what the server itself would be running.
  //
  // dailyOnlyMinConfidence matters as much as the threshold: for the neutral-H4
  // cohorts the engine gates on max(confidenceThreshold, cohortFloor) at
  // index.js:1721, so reading only the threshold would call those cohorts alive at
  // the exact moment a dashboard edit killed them.
  try {
    const raw = fs.readFileSync(SETTINGS, 'utf8').replace(/^﻿/, '');
    const parsed = JSON.parse(raw);
    const gate = Number(parsed.confidenceThreshold);
    if (Number.isFinite(gate)) {
      return {
        gate,
        dailyOnlyMinConfidence: Number(parsed.dailyOnlyMinConfidence) || 0,
        source: path.basename(SETTINGS),
      };
    }
  } catch (e) {
    // fall through to the default
  }
  return { gate: 70, dailyOnlyMinConfidence: 0, source: 'BUILT-IN DEFAULT (strategy_settings.json unreadable)' };
}

function main() {
  let indexSource;
  try {
    indexSource = fs.readFileSync(INDEX_JS, 'utf8');
  } catch (e) {
    console.error(`FATAL: cannot read ${INDEX_JS}: ${e.message}`);
    process.exit(2);
  }

  const { gate, dailyOnlyMinConfidence, source: gateSource } = readGate();
  const drifted = findTableDrift(indexSource);
  const rows    = computeReachability(gate, dailyOnlyMinConfidence);

  console.log('='.repeat(78));
  console.log('COHORT REACHABILITY — can each cohort mathematically reach the gate?');
  console.log('='.repeat(78));
  console.log(`gate           ${gate}   (from ${gateSource})`);
  console.log(`daily-only floor ${dailyOnlyMinConfidence}   (raises the gate for the neutral-H4 cohorts only)`);
  console.log(`max boost      +${MAX_BOOST}   (+${VOLUME_BOOST} volume, +${BEST_SETUP_BOOST} best setup, +${LEARNING_BOOST_WHEN_COLD} learning)`);
  console.log('learning boost 0 until a setup has 5 CLOSED trades — it cannot rescue a dead cohort');
  console.log('NOTE: macro penalties of up to -30 apply AFTER this point, so FIRES AT BASE');
  console.log('      is not a promise. Penalties only subtract, so a DEAD verdict still holds.');
  console.log('');

  if (drifted.length > 0) {
    console.log('!! TABLE DRIFT — these cohorts no longer match server/index.js:');
    for (const d of drifted) console.log(`     ${d.name}  (missing: ${d.missing.join(' | ')})`);
    console.log('   The report below may describe a system that no longer exists.');
    console.log('   Fix server/cohort_table.js.');
    console.log('');
  }

  const pad = (value, width) => String(value).padEnd(width);
  console.log(pad('cohort', 42) + pad('base', 6) + pad('ceiling', 9) + pad('status', 15) + 'note');
  console.log('-'.repeat(78));
  for (const row of rows) {
    let note = '';
    if (row.status === 'BLOCKED (MEASURED)') note = 'refused on out-of-sample evidence, not arithmetic — floor 101';
    else if (row.status === 'DEAD') note = `unreachable — ${row.short} short of gate ${row.effectiveGate}`;
    else if (row.status === 'NEEDS BOOST') note = `needs +${row.boostNeeded} of the +${MAX_BOOST} available`;
    if (row.cappedByEngine) note += `${note ? '; ' : ''}engine caps it at ${row.ceiling}`;
    console.log(pad(row.name, 42) + pad(row.base, 6) + pad(row.ceiling, 9) + pad(row.status, 19) + note);
  }

  // A deliberate block is NOT a finding. Counting it as one is how a report trains
  // its reader to skim: the list says "5 cohorts cannot fire" and four of them are
  // accidents while the fifth is a decision someone already made on evidence.
  const dead    = rows.filter(r => r.status === 'DEAD');
  const blocked = rows.filter(r => r.status === 'BLOCKED (MEASURED)');
  const tight   = rows.filter(r => r.status === 'NEEDS BOOST' && r.boostNeeded > BEST_SETUP_BOOST);

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
    console.log('  - meant to be blocked   -> block it by name, do not encode it as a low score');
    console.log('  - meant to be tradeable -> its base must be within the boost stack of the gate');
  }
  if (tight.length > 0) {
    console.log('');
    console.log(`${tight.length} cohort(s) need MORE than the best single setup bonus (+${BEST_SETUP_BOOST}),`);
    console.log('so they fire only on a perfect storm of setup type AND confirmed volume:');
    for (const t of tight) console.log(`  ${t.name}: base ${t.base}, needs +${t.boostNeeded}`);
  }
  if (blocked.length > 0) {
    console.log('');
    console.log(`${blocked.length} cohort(s) are BLOCKED ON PURPOSE and are not a finding:`);
    for (const b of blocked) console.log(`  ${b.name}: measured negative out of sample; held under floor ${b.effectiveGate}`);
    console.log('These still reach the rejection ledger at their true confidence, so the');
    console.log('evidence that could overturn the decision keeps accumulating at zero risk.');
    console.log('Re-measure with `node tasks/cohort_walkforward.cjs` before unblocking one.');
  }
  console.log('='.repeat(78));

  process.exit(dead.length > 0 || drifted.length > 0 ? 1 : 0);
}

main();
