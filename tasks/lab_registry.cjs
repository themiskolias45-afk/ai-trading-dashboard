#!/usr/bin/env node
'use strict';
/* ============================================================================
   lab_registry.cjs — every candidate ever run, and the trial count that follows
   ============================================================================

   THIS IS THE FILE THAT MAKES IT A LAB RATHER THAN A P-HACKING MACHINE.

   A workbench that lets you try forty parameter sets and then shows you the best
   one is not a research tool, it is a machine for manufacturing false confidence.
   The maximum of N noisy trials is positive by construction: search hard enough
   over the same bars and something will look excellent, and the more freedom you
   had, the more certain that is.

   The defence is to COUNT THE SEARCH and charge for it. tasks/lab_report.cjs can
   deflate a Sharpe by a trial count, but it takes that count as a flag you type —
   and a number you type is a number you can quietly under-report, especially when
   the honest value is embarrassing. So the count comes from here instead: every
   run is appended, and the trial count for the next run is derived from what is
   already on disk. You cannot search without paying for it, because the payment
   is automatic.

   This is not a new idea in this project. tasks/strategy_search.cjs already does
   exactly this for the live engine's own axes — every candidate tested is
   appended and the promotion bar is deflated for the count. This file extends the
   same discipline to arbitrary strategies.

   WHAT A FAMILY IS, and why the trial count is scoped to it. Trials are counted
   within a SEARCH SPACE: the same strategy, on the same symbol, on the same
   timeframe. Testing ema_cross on XAUUSD M15 twenty times is twenty trials
   against that question. Testing it once on BTCUSD is one trial against a
   DIFFERENT question and must not inflate the first. Pooling every run this
   project ever made into one count would over-deflate until nothing could ever
   pass, and a bar nothing can clear is as useless as no bar.

   APPEND ONLY. Nothing is ever rewritten or removed — a registry you can prune is
   a registry that under-reports, which defeats the entire purpose. Re-running an
   IDENTICAL spec does not add a trial (it is the same question asked twice, not a
   new one), and that is decided by the spec hash, not by trusting the caller.
   ========================================================================== */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const LAB_DIR = path.join(ROOT, 'tasks', 'analysis', 'lab');
const REGISTRY = path.join(LAB_DIR, '_registry.jsonl');

/** Canonical JSON: keys sorted, so key ORDER can never change a spec's identity. */
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort()
    .map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

function specHash(spec) {
  return crypto.createHash('sha256').update(canonical(spec)).digest('hex').slice(0, 16);
}

/**
 * The search space a spec belongs to. Deliberately EXCLUDES the parameters and the
 * execution settings — those are what you are varying, and varying them is what
 * costs a trial.
 */
function familyOf(spec) {
  return [spec.strategy, spec.symbol, spec.timeframe].join('|');
}

function readAll() {
  if (!fs.existsSync(REGISTRY)) return [];
  const out = [];
  for (const line of fs.readFileSync(REGISTRY, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch (e) { /* a torn line must not kill the read */ }
  }
  return out;
}

/**
 * How many DISTINCT specs have been tried in this family, counting the one about to
 * run. Re-running an identical spec does not add a trial.
 *
 * Returns at least 1: a single trial is still a trial, and expectedMaxSharpe treats
 * trials <= 1 as no deflation, which is the correct behaviour for a first look.
 */
function trialsFor(spec) {
  const fam = familyOf(spec);
  const hash = specHash(spec);
  const seen = new Set();
  for (const row of readAll()) {
    if (row && row.family === fam && row.specHash) seen.add(row.specHash);
  }
  seen.add(hash);
  return seen.size;
}

/** Every distinct spec already tried in this family, newest run first. */
function siblings(spec) {
  const fam = familyOf(spec);
  const bySpec = new Map();
  for (const row of readAll()) {
    if (row && row.family === fam && row.specHash) bySpec.set(row.specHash, row);
  }
  return [...bySpec.values()].sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
}

function register(entry) {
  fs.mkdirSync(LAB_DIR, { recursive: true });
  const row = {
    ts: new Date().toISOString(),
    specHash: specHash(entry.spec),
    family: familyOf(entry.spec),
    name: entry.name,
    spec: entry.spec,
    summary: entry.summary || null,
  };
  fs.appendFileSync(REGISTRY, JSON.stringify(row) + '\n');
  return row;
}

/**
 * The leaderboard. One row per DISTINCT spec (newest run wins), across all
 * families, so candidates can be compared side by side.
 *
 * Sorted by out-of-sample expectancy, and that choice is stated rather than
 * implied: ranking by TOTAL R would simply reward whichever candidate traded most,
 * and ranking by in-sample anything would rank the search itself.
 */
function leaderboard() {
  const bySpec = new Map();
  for (const row of readAll()) {
    if (row && row.specHash) bySpec.set(row.specHash, row);
  }
  const rows = [...bySpec.values()];
  const famCount = {};
  for (const r of rows) famCount[r.family] = (famCount[r.family] || 0) + 1;
  return rows
    .map(r => ({ ...r, familyTrials: famCount[r.family] || 1 }))
    .sort((a, b) => {
      const av = a.summary && typeof a.summary.oosExpectancyR === 'number' ? a.summary.oosExpectancyR : -Infinity;
      const bv = b.summary && typeof b.summary.oosExpectancyR === 'number' ? b.summary.oosExpectancyR : -Infinity;
      return bv - av;
    });
}

/**
 * The PLATEAU question: is this candidate a lone spike, or the middle of a shelf?
 *
 * For each parameter, finds the sibling specs that differ ONLY in that parameter and
 * returns them ordered by its value. A candidate whose neighbours are all losers is
 * an artefact of the search however good its own numbers look; one sitting in a band
 * of positives is a real effect. This is the single most diagnostic view in a lab and
 * it is exactly what a per-candidate report cannot show you.
 */
function plateau(spec) {
  const sibs = siblings(spec);
  const keys = Object.keys(spec.params || {});
  const out = {};
  for (const key of keys) {
    const near = sibs.filter(s => {
      if (!s.spec || !s.spec.params) return false;
      if (canonical(s.spec.exec || {}) !== canonical(spec.exec || {})) return false;
      if (s.spec.session !== spec.session) return false;
      for (const k of keys) {
        if (k === key) continue;
        if (s.spec.params[k] !== spec.params[k]) return false;
      }
      return true;
    });
    if (near.length > 1) {
      out[key] = near
        .map(s => ({
          value: s.spec.params[key],
          name: s.name,
          oosExpectancyR: s.summary ? s.summary.oosExpectancyR : null,
          verdict: s.summary ? s.summary.verdict : null,
          isThis: s.specHash === specHash(spec),
        }))
        .sort((a, b) => a.value - b.value);
    }
  }
  return out;
}

// ── self-test ───────────────────────────────────────────────────────────────
function selftest() {
  let failed = 0;
  const ok = (n, c, x) => { if (!c) { failed++; console.log('  FAIL  ' + n + (x ? '  ' + x : '')); } else console.log('  ok    ' + n); };

  const a = { strategy: 'ema_cross', symbol: 'XAUUSD', timeframe: 'M15', session: 'any',
              params: { fast: 20, slow: 50 }, exec: { atrMult: 2 } };
  // Key order must not change identity.
  const b = { exec: { atrMult: 2 }, params: { slow: 50, fast: 20 }, session: 'any',
              timeframe: 'M15', symbol: 'XAUUSD', strategy: 'ema_cross' };
  ok('spec hash ignores key order', specHash(a) === specHash(b));
  ok('a changed parameter changes the hash',
    specHash(a) !== specHash({ ...a, params: { fast: 21, slow: 50 } }));
  ok('family excludes the parameters',
    familyOf(a) === familyOf({ ...a, params: { fast: 99, slow: 200 } }));
  ok('family separates symbols',
    familyOf(a) !== familyOf({ ...a, symbol: 'BTCUSD' }));

  // trialsFor counts the pending run even with an empty registry.
  ok('a first run is 1 trial, not 0', trialsFor(a) >= 1);

  console.log('');
  console.log(failed === 0 ? '  ALL CHECKS PASSED' : '  ' + failed + ' CHECK(S) FAILED');
  return failed;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) process.exit(selftest() === 0 ? 0 : 1);
  if (argv.includes('--leaderboard')) {
    const rows = leaderboard();
    if (!rows.length) { console.log('registry is empty'); process.exit(0); }
    console.log('');
    console.log('  ' + 'candidate'.padEnd(34) + 'family'.padEnd(28)
      + 'trials'.padEnd(8) + 'OOS exp'.padEnd(10) + 'verdict');
    console.log('  ' + '-'.repeat(96));
    for (const r of rows) {
      const s = r.summary || {};
      console.log('  ' + String(r.name).slice(0, 33).padEnd(34)
        + String(r.family).slice(0, 27).padEnd(28)
        + String(r.familyTrials).padEnd(8)
        + (typeof s.oosExpectancyR === 'number' ? s.oosExpectancyR.toFixed(4) : '—').padEnd(10)
        + (s.verdict || '—'));
    }
    console.log('');
    console.log('  Ranked by OUT-OF-SAMPLE expectancy. Total R would just reward whichever');
    console.log('  candidate traded most; in-sample anything would rank the search itself.');
    console.log('');
    process.exit(0);
  }
  console.log('usage: lab_registry.cjs [--leaderboard | --selftest]');
}

module.exports = {
  REGISTRY, LAB_DIR, canonical, specHash, familyOf,
  readAll, trialsFor, siblings, register, leaderboard, plateau, selftest,
};
