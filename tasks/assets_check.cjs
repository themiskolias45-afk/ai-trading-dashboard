#!/usr/bin/env node
/**
 * Guards server/assets.js — the tradeable universe.
 *
 * The registry replaced four hand-written copies in server/index.js and there is a
 * FIFTH in mt5_bridge.py that it cannot import. Adding an instrument to one and not the
 * other does not fail loudly: it produces an asset that generates signals and can never
 * be held, or one the bridge pushes bars for that the engine never scores. That is the
 * exact shape of every silent failure in this repo, so it gets a check rather than a
 * comment asking people to remember.
 *
 *   node tasks/assets_check.cjs
 *
 * Exit 0 = consistent. Exit 1 = drift. Read-only: no network, no writes, no config.
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const reg  = require(path.join(root, 'server', 'assets.js'));

let failures = 0;
const fail = (msg) => { console.log(`[FAIL] ${msg}`); failures++; };
const ok   = (msg) => console.log(`[OK]   ${msg}`);

// 1. THE FROZEN BASELINE — what was hardcoded in server/index.js before 2026-09-02.
// This is not a duplicate of the registry: it is the historical value the refactor
// promised not to change, and it must be edited DELIBERATELY when an instrument is
// added, which is the point at which someone should be thinking about the bridge too.
const BASELINE_KEYS = ["btc", "gold", "spx"];
const BASELINE_BY_TICKER = { "BTC-USD": "btc", "GC=F": "gold", "^GSPC": "spx" };

const addedKeys = reg.ASSET_KEYS.filter(k => !BASELINE_KEYS.includes(k));
if (addedKeys.length === 0) {
  const same = JSON.stringify(reg.ASSET_KEY_BY_TICKER) === JSON.stringify(BASELINE_BY_TICKER);
  same ? ok('registry still byte-identical to the pre-refactor universe (3 assets)')
       : fail(`ticker map drifted from the baseline: ${JSON.stringify(reg.ASSET_KEY_BY_TICKER)}`);
} else {
  ok(`registry has grown beyond the baseline: +${addedKeys.join(', ')} — checks below apply to all`);
}

// 2. NO DUPLICATES. Two assets sharing a key silently overwrite each other in every
// object built from this list.
for (const [name, values] of [['key', reg.ASSETS.map(a => a.key)],
                              ['symbol', reg.ASSETS.map(a => a.symbol)]]) {
  const dupes = values.filter((v, i) => values.indexOf(v) !== i);
  dupes.length ? fail(`duplicate ${name}: ${[...new Set(dupes)].join(', ')}`)
               : ok(`no duplicate ${name}`);
}

// 3. SHAPE. Every asset must carry all four fields, and brokerSymbols must include the
// Yahoo ticker — isAssetHeld() matches an open position against this list, and a
// position opened on the Yahoo symbol would otherwise read as unheld.
for (const a of reg.ASSETS) {
  const missing = ['key', 'label', 'symbol', 'brokerSymbols'].filter(f => !a[f]);
  if (missing.length) { fail(`${a.key || '?'} missing ${missing.join(', ')}`); continue; }
  if (!Array.isArray(a.brokerSymbols) || a.brokerSymbols.length === 0) {
    fail(`${a.key}: brokerSymbols must be a non-empty array`);
  } else if (!a.brokerSymbols.map(s => s.toUpperCase()).includes(a.symbol.toUpperCase())) {
    fail(`${a.key}: brokerSymbols does not include its own ticker ${a.symbol}`);
  }
}
if (!failures) ok('every asset carries key, label, symbol and a brokerSymbols list containing its ticker');

// 4. THE FIFTH COPY — mt5_bridge.py. Parsed as text on purpose: this is a Node process
// and the bridge is Python, so the only honest check is whether the ticker appears in
// the bridge's alias map at all. Absent bridge file is UNVERIFIABLE, never a failure —
// a fresh clone or a checkout without the bridge must not read as drift.
const bridgePath = path.join(root, 'mt5_bridge.py');
if (!fs.existsSync(bridgePath)) {
  console.log('[UNVERIFIABLE] mt5_bridge.py not present — bridge coverage not checked');
} else {
  const bridge = fs.readFileSync(bridgePath, 'utf8');
  const missing = reg.ASSETS.filter(a => !bridge.includes(`"${a.symbol}"`));
  missing.length
    ? fail(`mt5_bridge.py has no alias entry for ${missing.map(a => a.symbol).join(', ')} `
         + `— the engine would score an asset the bridge never pushes bars for`)
    : ok(`all ${reg.ASSETS.length} tickers present in mt5_bridge.py's alias map`);
}

// 5. INDEX.JS MUST NOT HAVE GROWN A SIXTH COPY.
const indexPath = path.join(root, 'server', 'index.js');
if (fs.existsSync(indexPath)) {
  const idx = fs.readFileSync(indexPath, 'utf8');
  const relit = /const\s+assets\s*=\s*\[\s*\{\s*key:\s*"btc"/.test(idx)
             || /const\s+ASSET_KEY_BY_TICKER\s*=\s*\{\s*"BTC-USD"/.test(idx);
  relit ? fail('server/index.js has re-grown a hardcoded asset list — the registry is being bypassed')
        : ok('server/index.js holds no hardcoded asset list');
}

console.log(failures ? `\nDRIFT: ${failures} failure(s)` : '\nASSET REGISTRY CONSISTENT');
process.exit(failures ? 1 : 0);
