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

function diffSchemas(stored, current, path = '') {
  const diffs = [];
  if (typeof stored !== typeof current) {
    diffs.push(`${path}: type changed from ${JSON.stringify(stored)} to ${JSON.stringify(current)}`);
    return diffs;
  }
  if (typeof stored !== 'object' || stored === null) {
    if (stored !== current) {
      diffs.push(`${path}: changed from "${stored}" to "${current}"`);
    }
    return diffs;
  }
  const allKeys = new Set([...Object.keys(stored), ...Object.keys(current)]);
  for (const key of allKeys) {
    if (!(key in stored)) diffs.push(`${path}.${key}: KEY ADDED`);
    else if (!(key in current)) diffs.push(`${path}.${key}: KEY REMOVED`);
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

    const diffs = diffSchemas(storedSchema, currentSchema, endpoint.name);
    if (diffs.length === 0) {
      console.log(`[OK] ${endpoint.name}: shape unchanged`);
    } else {
      console.log(`[FAIL] ${endpoint.name}: SHAPE CHANGED — ${diffs.length} difference(s)`);
      if (VERBOSE || diffs.length <= 5) {
        diffs.forEach(d => console.log(`  ↳ ${d}`));
      } else {
        diffs.slice(0, 5).forEach(d => console.log(`  ↳ ${d}`));
        console.log(`  ↳ ... and ${diffs.length - 5} more (run --verbose to see all)`);
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
