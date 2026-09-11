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

/**
 * MEMOISED ON THE FILE'S OWN STAT, and that is the whole point.
 *
 * WHY. This re-read and re-parsed the entire registry on EVERY call, and the callers
 * call it per candidate: lab_promote's judge() invokes trialsFor() once for every
 * report it scans, and plateau() -> siblings() adds more on top. That makes the scan
 * O(N x N) — N reports each paying for a full parse of an N-row file — in a registry
 * that grows by ~384 rows a day and is never pruned.
 *
 * MEASURED 2026-09-11, both boxes:
 *     laptop  6,571 rows / 4.57 MB — one readAll 44.0 ms — 6,561 reports — scan 751 s
 *     VPS     7,246 rows / 5.05 MB — one readAll 67.6 ms — 7,246 reports — scan ~1,274 s
 * The VPS scan had outgrown lab_drain's 960 s cap AND the task's own PT20M kill, so
 * promotion there was stopped mid-scan 19 times in one day and staged nothing. No cap
 * value could have fixed that: the work itself exceeded the task's hard limit. The
 * laptop was ~2 days from the same wall on the same growth rate.
 *
 * THE KEY IS (mtimeMs, size), NOT A BOOLEAN. lab_registry is required by the
 * long-lived server (server/index.js calls plateau()), and lab_generate/lab_run call
 * register() mid-process. A cache that never invalidated would serve them stale rows
 * — a correctness bug traded for a speed win, which is not a trade this project makes.
 * Keying on the file's own stat means any append invalidates it automatically: the
 * registry is APPEND ONLY (see the header), so every write strictly increases size.
 *
 * IT RETURNS A COPY OF THE ARRAY. Callers get their own array to sort or splice
 * without corrupting the cache for everybody else. Only the array is copied, not the
 * rows — that is a pointer copy of a few thousand entries, microseconds against the
 * 44-68 ms parse it replaces. The rows themselves are shared and must be treated as
 * read-only; no caller mutates one today.
 */
let _cacheKey = null;
let _cacheRows = null;

function readAll() {
  if (!fs.existsSync(REGISTRY)) { _cacheKey = null; _cacheRows = null; return []; }

  let key;
  try {
    const st = fs.statSync(REGISTRY);
    key = st.mtimeMs + ':' + st.size;
  } catch (e) {
    key = null;   // cannot stat — fall through and re-read rather than trust a cache
  }

  if (key !== null && key === _cacheKey && _cacheRows) return _cacheRows.slice();

  const out = [];
  for (const line of fs.readFileSync(REGISTRY, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch (e) { /* a torn line must not kill the read */ }
  }

  if (key !== null) { _cacheKey = key; _cacheRows = out; }
  return out.slice();
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
