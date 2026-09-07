/**
 * API shape snapshot — runs after every server edit.
 * Fetches 3 core endpoints, extracts JSON schema (keys + types, not values),
 * diffs against stored snapshots in tasks/snapshots/.
 * Exits 0 = shapes match (or first run, saved). Exits 1 = shape changed (regression).
 *
 * Usage: node tasks/api_snapshot.cjs [--update] [--verbose]
 *   --update   overwrite stored schemas with current shapes (use after intentional API change)
 *   --verbose  print full diff on mismatch
 */

'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

const SNAPSHOTS_DIR = path.join(__dirname, 'snapshots');
const BASE_URL      = 'http://localhost:3001';
const UPDATE_MODE   = process.argv.includes('--update');
const VERBOSE       = process.argv.includes('--verbose');

const ENDPOINTS = [
  { name: 'signals',      path: '/api/signals' },
  { name: 'performance',  path: '/api/performance' },
  { name: 'gate-health',  path: '/api/gate-health' },
];

function fetchJSON(urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get(BASE_URL + urlPath, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Non-JSON response from ${urlPath}: ${data.slice(0, 100)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout: ${urlPath}`)); });
  });
}

function extractSchema(value, depth = 0) {
  if (depth > 5) return 'deep';
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    if (value.length === 0) return 'array<empty>';
    return `array<${extractSchema(value[0], depth + 1)}>`;
  }
  if (typeof value === 'object') {
    const schema = {};
    for (const [k, v] of Object.entries(value)) {
      schema[k] = extractSchema(v, depth + 1);
    }
    return schema;
  }
  return typeof value;
}

// NULL IS AN ABSENT VALUE, NOT A CHANGED SHAPE — and conflating the two made this
// check unable to be green in any steady state.
//
// Measured 2026-08-31. The stored schema recorded `spx.stop: "number"`. SPX has no setup
// today, so it publishes stop/target/rr/h1Agree as null and the check read FAIL with 4
// differences. On Yahoo-sourced bars, taken during a restart window, it read 16 (m15
// null, barFreshness.spansWeekend absent). Nothing was wrong on any of those runs: an
// asset without a setup HAS no stop, and that is ordinary market variation.
//
// This mattered because tasks/hooks/post-edit-check.ps1 does `exit 1` on a non-zero exit
// here, so a check that flips with the market was hard-blocking every edit to
// server/index.js. `--update` cannot fix it: recording "null" merely re-arms the same
// oscillation from the other side, going red the moment SPX finds a setup again.
//
// So a null on either side is reported as a WARNING and does not fail the run. Everything
// that actually describes a shape still FAILS HARD:
//   - KEY ADDED / KEY REMOVED           (a field appearing or vanishing)
//   - number -> string, object -> string (a real type change between two real values)
// A field that goes PERMANENTLY null therefore stops blocking, which is the cost — so it
// is printed on every run rather than swallowed. Visible and non-blocking beats invisible,
// and beats an alarm people learn to skip past.
const NULL_SCHEMA = 'null';

function diffSchemas(stored, current, path = '') {
  const diffs = [];
  // Checked BEFORE the typeof comparison: both sides are the string "null" vs e.g.
  // "number", so typeof is 'string' on both and the type guard below would not catch it.
  if (stored === NULL_SCHEMA || current === NULL_SCHEMA) {
    if (stored !== current) {
      diffs.push({ soft: true, text: `${path}: ${stored} -> ${current}`
        + ` (value absent this run, not a shape change)` });
    }
    return diffs;
  }
  if (typeof stored !== typeof current) {
    diffs.push({ soft: false, text: `${path}: type changed from ${JSON.stringify(stored)} to ${JSON.stringify(current)}` });
    return diffs;
  }
  if (typeof stored !== 'object' || stored === null) {
    if (stored !== current) {
      diffs.push({ soft: false, text: `${path}: changed from "${stored}" to "${current}"` });
    }
    return diffs;
  }
  const allKeys = new Set([...Object.keys(stored), ...Object.keys(current)]);
  for (const key of allKeys) {
    if (!(key in stored)) diffs.push({ soft: false, text: `${path}.${key}: KEY ADDED` });
    else if (!(key in current)) diffs.push({ soft: false, text: `${path}.${key}: KEY REMOVED` });
    else diffs.push(...diffSchemas(stored[key], current[key], `${path}.${key}`));
  }
  return diffs;
}

async function main() {
  if (!fs.existsSync(SNAPSHOTS_DIR)) {
    fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  }

  let anyFailed = false;
  let serverReachable = true;

  for (const endpoint of ENDPOINTS) {
    const snapshotFile = path.join(SNAPSHOTS_DIR, `${endpoint.name}.schema.json`);
    let currentData;

    try {
      currentData = await fetchJSON(endpoint.path);
    } catch (e) {
      if (e.message.includes('ECONNREFUSED') || e.message.includes('Timeout')) {
        console.log(`[SKIP] ${endpoint.name}: server not reachable — ${e.message}`);
        serverReachable = false;
        continue;
      }
      console.log(`[WARN] ${endpoint.name}: fetch error — ${e.message}`);
      continue;
    }

    const currentSchema = extractSchema(currentData);

    if (!fs.existsSync(snapshotFile) || UPDATE_MODE) {
      fs.writeFileSync(snapshotFile, JSON.stringify(currentSchema, null, 2));
      console.log(`[SAVED] ${endpoint.name}: schema ${UPDATE_MODE ? 'updated' : 'created'} → ${snapshotFile}`);
      continue;
    }

    let storedSchema;
    try {
      storedSchema = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
    } catch (e) {
      console.log(`[WARN] ${endpoint.name}: could not read stored schema — ${e.message}`);
      continue;
    }

    const allDiffs = diffSchemas(storedSchema, currentSchema, endpoint.name);
    const hard = allDiffs.filter(d => !d.soft);
    const soft = allDiffs.filter(d => d.soft);

    // Warnings print on EVERY run, including a passing one. A null that has become
    // permanent is exactly what this no longer blocks on, so it must stay visible.
    if (soft.length > 0) {
      console.log(`[WARN] ${endpoint.name}: ${soft.length} field(s) null this run — not blocking`);
      const shownSoft = (VERBOSE || soft.length <= 5) ? soft : soft.slice(0, 5);
      shownSoft.forEach(d => console.log(`  ~ ${d.text}`));
      if (shownSoft.length < soft.length) {
        console.log(`  ~ ... and ${soft.length - shownSoft.length} more (run --verbose to see all)`);
      }
    }

    if (hard.length === 0) {
      console.log(`[OK] ${endpoint.name}: shape unchanged`);
    } else {
      console.log(`[FAIL] ${endpoint.name}: SHAPE CHANGED — ${hard.length} difference(s)`);
      const shown = (VERBOSE || hard.length <= 5) ? hard : hard.slice(0, 5);
      shown.forEach(d => console.log(`  ↳ ${d.text}`));
      if (shown.length < hard.length) {
        console.log(`  ↳ ... and ${hard.length - shown.length} more (run --verbose to see all)`);
      }
      console.log(`  If intentional: node tasks/api_snapshot.cjs --update`);
      anyFailed = true;
    }
  }

  if (!serverReachable) {
    console.log('[INFO] Server unreachable — snapshot check skipped. Start server first.');
    process.exit(0);
  }

  process.exit(anyFailed ? 1 : 0);
}

main().catch(e => {
  console.error('[ERROR]', e.message);
  process.exit(1);
});
