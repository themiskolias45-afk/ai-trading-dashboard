#!/usr/bin/env node
'use strict';
/**
 * Intraday plan monitor — the loop the daily plan never had.
 *
 * THE GAP THIS CLOSES. The plan is built once, at 06:45, and then nothing looks at
 * it again until tomorrow. Price reaches the entry and nobody is told. Price takes
 * out the level the plan called support and the plan still reads as live. The
 * confidence crosses the gate at 14:00 and the morning briefing, which said WAIT,
 * is the last thing anyone read. A plan with no loop is a snapshot with an opinion.
 *
 * WHAT IT DOES. Every run compares the live board against the plan on disk and
 * against its OWN previous observation, and reports CROSSINGS — not states. "BTC is
 * above 79,000" is not news on the fortieth consecutive run; "BTC crossed 79,000
 * since the last check" is. Everything it emits is an event with a before and an
 * after.
 *
 * WHAT IT MUST NEVER DO, and does not:
 *   - It makes no POST, no PUT and no write of any kind to the server. It cannot
 *     open, close, size or block a trade. Rule 3: no change may suppress a setup
 *     that would otherwise have fired, and the safest way to honour that is to have
 *     no path to the engine at all.
 *   - It deletes nothing. Events append to a per-day JSONL; the state file is
 *     overwritten with its own successor and nothing else. Rule 6.
 *   - It never edits the plan artifact. tasks/plan_review.cjs grades the plan
 *     against what it ACTUALLY said, so a monitor that rewrote it would be grading
 *     its own edits.
 *
 * Usage:
 *   node tasks/plan_monitor.cjs                 # one pass, prints events
 *   node tasks/plan_monitor.cjs --quiet         # events only, no header
 *   node tasks/plan_monitor.cjs --no-notify     # never call notifications.py
 *   node tasks/plan_monitor.cjs --host 1.2.3.4  # check the other box
 *
 * Exit code is 0 whenever the pass COMPLETED, event or no event. A monitor that
 * exits non-zero because it found something would train the scheduler to treat a
 * working detector as a broken job — the shape a repaired rail leaves behind.
 * Exit 1 means the pass could not run: server unreachable, or no plan for today.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');

const PROJECT_ROOT = path.join(__dirname, '..');
const ANALYSIS_DIR = path.join(PROJECT_ROOT, 'tasks', 'analysis');
const STATE_FILE = path.join(ANALYSIS_DIR, 'plan-monitor-state.json');

const argv = process.argv.slice(2);
const QUIET = argv.includes('--quiet');
const NO_NOTIFY = argv.includes('--no-notify');
const HOST = (() => {
  const at = argv.indexOf('--host');
  return at >= 0 && argv[at + 1] ? argv[at + 1] : '127.0.0.1';
})();

// How close to a level counts as "reached". Scaled to ATR for the same reason the
// clustering tolerance is: 5 points is a rounding error on BTC and a whole move on
// SPX. A fixed price or percentage would make this monitor useful on one asset.
const TOUCH_ATR_FRACTION = 0.10;

// Events at or above this rank get a notification. The rest are recorded and read
// later. A monitor that pushes everything is a monitor that gets muted, and a muted
// monitor is the same as no monitor.
const NOTIFY_FROM_RANK = 2;
const RANK = { INFO: 1, NOTABLE: 2, URGENT: 3 };

let SESSION_COOKIE = null;
try {
  const secret = fs.readFileSync(path.join(PROJECT_ROOT, 'server', 'session_secret.txt'), 'utf8').trim();
  if (secret) SESSION_COOKIE = 'smartentry_session=' + secret;
} catch (e) {
  // No secret readable: the gated legs 401 and each caller degrades by name. Not fatal.
}

function get(routePath) {
  return new Promise((resolve, reject) => {
    const headers = SESSION_COOKIE ? { Cookie: SESSION_COOKIE } : {};
    const req = http.get({ host: HOST, port: 3001, path: routePath, headers, timeout: 10000 }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('unparseable JSON: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

/** UTC date string, the SAME one tv_daily_plan.py names its artifact with. */
function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function planPath(date) {
  return path.join(PROJECT_ROOT, 'tasks', `daily_plan_${date}.json`);
}

function eventsPath(date) {
  return path.join(ANALYSIS_DIR, `plan-events-${date}.jsonl`);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

/**
 * The previous observation, per asset. Absent on the first run of a day, and that
 * matters: with no `before` there is no crossing, so the first run records the
 * baseline and reports nothing. A monitor that fired every event on its first run
 * would alarm once per restart and be ignored by the second week.
 */
function readState() {
  const state = readJson(STATE_FILE, null);
  if (!state || state.date !== todayUtc()) return { date: todayUtc(), assets: {}, firstRun: true };
  return Object.assign({ firstRun: false }, state);
}

function writeState(state) {
  fs.mkdirSync(ANALYSIS_DIR, { recursive: true });
  // Overwrites its own predecessor and nothing else. The events are the record;
  // this file is only the "where was price last time" needed to see a crossing.
  fs.writeFileSync(STATE_FILE, JSON.stringify({
    date: state.date, assets: state.assets, updatedAt: new Date().toISOString(),
  }, null, 2), 'utf8');
}

/**
 * Did price cross `level` between the previous observation and now?
 *
 * Returns null for no crossing, or the direction it crossed. Both prices must be
 * finite: a missing previous price means no crossing can be asserted, which is a
 * different thing from asserting there was none.
 */
/**
 * A price, or NaN. Never 0.
 *
 * Number(null) is 0 and Number.isFinite(0) is true, so a guard written as
 * `Number.isFinite(Number(x))` accepts a MISSING price as the number zero. Caught by
 * the test suite before this ever ran against a real feed outage: with price 0 every
 * plan level is above spot, so a single null read would have fired URGENT
 * "crossed DOWN through the plan stop" on all three assets at once. No instrument
 * this system trades has a valid price at or below zero, so rejecting them costs
 * nothing and closes the whole class.
 */
function priceOrNaN(value) {
  const asNumber = Number(value);
  return Number.isFinite(asNumber) && asNumber > 0 ? asNumber : NaN;
}

function crossing(previousPrice, currentPrice, level) {
  if (![previousPrice, currentPrice, level].every(Number.isFinite)) return null;
  if (previousPrice < level && currentPrice >= level) return 'up';
  if (previousPrice > level && currentPrice <= level) return 'down';
  return null;
}

/** Within TOUCH_ATR_FRACTION of a level, or inside a band. */
function reached(price, low, high, tolerance) {
  if (!Number.isFinite(price)) return false;
  return price >= low - tolerance && price <= high + tolerance;
}

function formatPrice(value, decimals) {
  return Number.isFinite(value) ? value.toFixed(decimals) : '?';
}

/**
 * Every event for one asset: level crossings, plan-price touches, the gate, and the
 * day's range.
 *
 * `before` is the previous observation and may be undefined on the first run of the
 * day — every check below tolerates that by producing nothing rather than by
 * inventing a crossing from a missing number.
 */
function eventsForAsset(assetKey, live, assetContext, planAsset, before) {
  const events = [];
  const price = priceOrNaN(live && live.price);
  const atr = Number(live && live.atr);
  if (!Number.isFinite(price)) {
    return [{ asset: assetKey, rank: RANK.INFO, kind: 'no-price',
      text: `${assetKey.toUpperCase()}: no live price — nothing could be checked` }];
  }
  const decimals = price >= 10000 ? 0 : price >= 100 ? 2 : 4;
  const tolerance = Number.isFinite(atr) && atr > 0 ? atr * TOUCH_ATR_FRACTION : 0;
  // Same guard on the PREVIOUS price. A stored null would otherwise read as 0 and
  // manufacture a downward crossing through every level on the next pass.
  const previousPrice = priceOrNaN(before && before.price);

  const add = (rank, kind, text, extra) => events.push(
    Object.assign({ asset: assetKey, rank, kind, text, price }, extra || {}));

  // ── The plan's own prices ──────────────────────────────────────────
  const tradePlan = planAsset && planAsset.trade_plan;
  if (tradePlan) {
    for (const [name, level, rank] of [
      ['entry', tradePlan.entry, RANK.URGENT],
      ['target', tradePlan.target, RANK.URGENT],
      ['stop', tradePlan.stop, RANK.URGENT],
    ]) {
      const direction = crossing(previousPrice, price, Number(level));
      if (direction) {
        add(rank, `plan-${name}-crossed`,
          `${assetKey.toUpperCase()}: price crossed ${direction.toUpperCase()} through the plan ${name} `
          + `${formatPrice(Number(level), decimals)} (now ${formatPrice(price, decimals)})`,
          { level: Number(level), direction });
      }
    }
  }

  // ── Confluence zones ───────────────────────────────────────────────
  //
  // Entering a zone is the event, not being in one. The previous run's zone set is
  // compared by INDEX-FREE identity (the rounded midpoint), because the clustering
  // re-runs each pass and a zone's position in the ranked list is not stable.
  const zones = ((assetContext && assetContext.zones) || {}).byConfluence || [];
  const zoneKey = zone => `${zone.low.toFixed(4)}:${zone.high.toFixed(4)}`;
  const insideNow = zones.filter(z => reached(price, z.low, z.high, tolerance)).map(zoneKey);
  const insideBefore = (before && before.insideZones) || [];
  for (const zone of zones) {
    const key = zoneKey(zone);
    if (insideNow.includes(key) && !insideBefore.includes(key)) {
      add(zone.score >= 4 ? RANK.NOTABLE : RANK.INFO, 'zone-entered',
        `${assetKey.toUpperCase()}: price reached a x${zone.score} confluence zone `
        + `${formatPrice(zone.low, decimals)}–${formatPrice(zone.high, decimals)} `
        + `[${(zone.families || []).join(', ')}]`,
        { zoneLow: zone.low, zoneHigh: zone.high, confluence: zone.score });
    }
  }
  for (const key of insideBefore) {
    if (!insideNow.includes(key)) {
      add(RANK.INFO, 'zone-left',
        `${assetKey.toUpperCase()}: price left the zone at ${key.split(':')[0]}`);
    }
  }

  // ── The day's range ────────────────────────────────────────────────
  const projection = (assetContext && assetContext.projection) || {};
  const usedNow = Number(projection.rangeUsedPct);
  const usedBefore = before && Number(before.rangeUsedPct);
  if (Number.isFinite(usedNow) && Number.isFinite(usedBefore)
      && usedBefore < 100 && usedNow >= 100) {
    add(RANK.NOTABLE, 'range-spent',
      `${assetKey.toUpperCase()}: today has now travelled ${usedNow}% of a normal day's ATR range `
      + `— ${projection.reading}`, { rangeUsedPct: usedNow });
  }

  return { events, observation: {
    price, rangeUsedPct: Number.isFinite(usedNow) ? usedNow : null, insideZones: insideNow,
  } };
}

/**
 * The gate crossing, which is per asset but belongs to the signal rather than to the
 * levels — and is the single most consequential thing this monitor can notice. The
 * morning briefing said WAIT; the gate says otherwise now.
 */
function gateEvents(assetKey, live, gate, before) {
  const confidence = Number(live && live.confidence);
  const previous = before && Number(before.confidence);
  if (!Number.isFinite(confidence) || !Number.isFinite(gate)) return [];
  if (!Number.isFinite(previous)) return [];
  if (previous < gate && confidence >= gate) {
    return [{ asset: assetKey, rank: RANK.URGENT, kind: 'gate-crossed-up',
      text: `${assetKey.toUpperCase()}: confidence ${previous} → ${confidence} CROSSED THE GATE (${gate}) `
        + `— signal ${live.signal || '?'} ${live.setup || ''}`.trim(),
      confidence, gate }];
  }
  if (previous >= gate && confidence < gate) {
    return [{ asset: assetKey, rank: RANK.NOTABLE, kind: 'gate-crossed-down',
      text: `${assetKey.toUpperCase()}: confidence ${previous} → ${confidence} fell back below the gate (${gate})`,
      confidence, gate }];
  }
  return [];
}

function appendEvents(date, events) {
  if (!events.length) return;
  fs.mkdirSync(ANALYSIS_DIR, { recursive: true });
  const stamped = events.map(e => JSON.stringify(Object.assign({ at: new Date().toISOString() }, e)));
  // Append only. This file is the record and nothing in this tool rewrites it.
  fs.appendFileSync(eventsPath(date), stamped.join('\n') + '\n', 'utf8');
}

function notify(events) {
  const worth = events.filter(e => e.rank >= NOTIFY_FROM_RANK);
  if (!worth.length || NO_NOTIFY) return Promise.resolve();
  const message = worth.map(e => e.text).join(' | ').slice(0, 400);
  return new Promise(resolve => {
    let pythonBin = 'python';
    try { pythonBin = require(path.join(PROJECT_ROOT, 'server', 'python_path')).pythonBinOrDefault(); }
    catch (e) { /* fall back to PATH python; a missing notification never fails the pass */ }
    execFile(pythonBin,
      [path.join(PROJECT_ROOT, 'notifications.py'), 'alert', message, '--title', 'JARVIS Plan Monitor'],
      { cwd: PROJECT_ROOT, timeout: 20000 },
      err => {
        // A notification that did not send is reported, never fatal. The event is
        // already on disk, which is the part that must not be lost.
        if (err) console.error(`[monitor] notification failed: ${err.message}`);
        resolve();
      });
  });
}

async function main() {
  const date = todayUtc();
  if (!QUIET) console.log(`[monitor] plan monitor — ${date} — host ${HOST}`);

  let signals;
  let context;
  let settings;
  try {
    [signals, context, settings] = await Promise.all([
      get('/api/signals'),
      get('/api/market-context').catch(e => ({ available: false, why: e.message })),
      get('/api/strategy-settings').catch(e => ({ _error: e.message })),
    ]);
  } catch (e) {
    console.error(`[monitor] server unreachable (${e.message}) — nothing was checked`);
    process.exit(1);
  }

  // Never hardcode the gate. It moved 65 -> 70 and anything that baked it in was
  // correct only until that day.
  const gate = Number(settings && settings.confidenceThreshold);
  if (!Number.isFinite(gate)) {
    console.error('[monitor] no live gate from /api/strategy-settings — gate crossings cannot be judged');
  } else if (settings.settingsError) {
    console.error(`[monitor] WARNING: gate ${gate} is a BUILT-IN DEFAULT, not the saved config `
      + `(${settings.settingsError})`);
  }

  const plan = readJson(planPath(date), null);
  if (!plan) {
    console.error(`[monitor] no plan artifact for ${date} — run tv_daily_plan.py first`);
    process.exit(1);
  }

  const contextAssets = (context && context.available && context.assets) || {};
  const state = readState();
  const allEvents = [];
  const nextAssets = {};

  for (const assetKey of ['btc', 'gold', 'spx']) {
    const live = signals && signals[assetKey];
    if (!live) continue;
    const before = state.assets[assetKey];
    const assetContext = contextAssets[assetKey] && contextAssets[assetKey].available
      ? contextAssets[assetKey] : null;

    const result = eventsForAsset(assetKey, live, assetContext,
      (plan.assets || {})[assetKey], before);
    // eventsForAsset returns an array only on the no-price path; normalise.
    const assetEvents = Array.isArray(result) ? result : result.events;
    const observation = Array.isArray(result) ? { price: null } : result.observation;

    allEvents.push(...assetEvents, ...gateEvents(assetKey, live, gate, before));
    nextAssets[assetKey] = Object.assign({}, observation, {
      confidence: Number(live.confidence), signal: live.signal, at: new Date().toISOString(),
    });
  }

  writeState({ date, assets: nextAssets });

  if (state.firstRun) {
    // Baseline only. Reporting crossings against a `before` that does not exist
    // would fire the whole board on the first run after every restart.
    if (!QUIET) {
      console.log('[monitor] first pass of the day — baseline recorded, no crossings asserted');
      for (const [key, observation] of Object.entries(nextAssets)) {
        console.log(`  ${key.toUpperCase()} price ${observation.price} conf ${observation.confidence} `
          + `inZones ${(observation.insideZones || []).length}`);
      }
    }
    process.exit(0);
  }

  if (!allEvents.length) {
    if (!QUIET) console.log('[monitor] no crossings since the last pass');
    process.exit(0);
  }

  allEvents.sort((a, b) => b.rank - a.rank);
  for (const event of allEvents) {
    const tag = event.rank >= RANK.URGENT ? 'URGENT' : event.rank >= RANK.NOTABLE ? 'NOTABLE' : 'info';
    console.log(`  [${tag}] ${event.text}`);
  }
  appendEvents(date, allEvents);
  await notify(allEvents);
  console.log(`[monitor] ${allEvents.length} event(s) appended to ${path.basename(eventsPath(date))}`);
  process.exit(0);
}

// Runs as a CLI, imports as a module. The require.main guard is what lets
// plan_monitor.test.cjs exercise the crossing logic directly — without it, merely
// requiring this file would hit the live server and rewrite the state file, so the
// only way to test a detector would be to wait for the market to move.
if (require.main === module) {
  main().catch(e => {
    console.error(`[monitor] unhandled: ${e.stack || e.message}`);
    process.exit(1);
  });
}

module.exports = {
  crossing,
  priceOrNaN,
  reached,
  eventsForAsset,
  gateEvents,
  RANK,
  TOUCH_ATR_FRACTION,
  NOTIFY_FROM_RANK,
};
