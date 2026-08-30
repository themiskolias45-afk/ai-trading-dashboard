'use strict';
/**
 * Standalone test runner for tasks/plan_monitor.cjs — no external framework.
 * Run: node tasks/plan_monitor.test.cjs
 * Exit 0 = all passed, 1 = one or more failures.
 *
 * WHY THIS EXISTS RATHER THAN "run it and see". A monitor reports CROSSINGS, and a
 * crossing needs two observations minutes apart. Waiting for the market to move
 * through a level is not a test, it is a hope — and the failure mode being guarded
 * against is precisely a detector that never fires and therefore always looks calm.
 * This codebase has that exact bug on record more than once: a check that cannot
 * fire reads as clean.
 */

const monitor = require('./plan_monitor.cjs');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) { passed++; return; }
  failed++;
  failures.push(`${name}${detail ? ' — ' + detail : ''}`);
}

// ── crossing ────────────────────────────────────────────────────────────
check('crossing up is detected', monitor.crossing(99, 101, 100) === 'up');
check('crossing down is detected', monitor.crossing(101, 99, 100) === 'down');
check('landing exactly on the level counts as crossed up',
  monitor.crossing(99, 100, 100) === 'up');
check('no crossing when both sides are above', monitor.crossing(101, 102, 100) === null);
check('no crossing when both sides are below', monitor.crossing(98, 99, 100) === null);
// The load-bearing one: with no previous price there is no crossing to assert. A
// monitor that treated `undefined` as 0 would report a cross UP through every level
// on the first pass after any restart.
check('a missing previous price asserts NO crossing',
  monitor.crossing(undefined, 101, 100) === null);
check('NaN anywhere asserts NO crossing', monitor.crossing(NaN, 101, 100) === null
  && monitor.crossing(99, 101, NaN) === null);

// ── reached ─────────────────────────────────────────────────────────────
check('inside the band is reached', monitor.reached(105, 100, 110, 0) === true);
check('outside with no tolerance is not reached', monitor.reached(111, 100, 110, 0) === false);
check('tolerance extends the band', monitor.reached(111, 100, 110, 2) === true);
check('a non-finite price is never reached', monitor.reached(NaN, 100, 110, 5) === false);

// ── gateEvents ──────────────────────────────────────────────────────────
// The single most consequential thing this tool can notice: the briefing said WAIT
// and the gate says otherwise now.
const crossedUp = monitor.gateEvents('spx',
  { confidence: 72, signal: 'BUY', setup: 'BREAKOUT' }, 70, { confidence: 57 });
check('confidence crossing the gate upward is URGENT',
  crossedUp.length === 1 && crossedUp[0].rank === monitor.RANK.URGENT
  && crossedUp[0].kind === 'gate-crossed-up', JSON.stringify(crossedUp));
check('the gate event names both sides of the move',
  crossedUp[0].text.includes('57') && crossedUp[0].text.includes('72'),
  crossedUp[0] && crossedUp[0].text);

const crossedDown = monitor.gateEvents('spx', { confidence: 66 }, 70, { confidence: 74 });
check('falling back below the gate is NOTABLE, not urgent',
  crossedDown.length === 1 && crossedDown[0].rank === monitor.RANK.NOTABLE,
  JSON.stringify(crossedDown));

check('no event while confidence stays below the gate',
  monitor.gateEvents('spx', { confidence: 60 }, 70, { confidence: 57 }).length === 0);
check('no event while confidence stays above the gate',
  monitor.gateEvents('spx', { confidence: 80 }, 70, { confidence: 74 }).length === 0);
check('no previous confidence means no gate event asserted',
  monitor.gateEvents('spx', { confidence: 80 }, 70, undefined).length === 0);
// A hardcoded gate is the failure CLAUDE.md names by number: it moved 65 -> 70 and
// anything that baked it in was correct only until that day. A non-finite gate must
// produce nothing rather than fall back to a constant.
check('a non-finite gate produces no event, never a default',
  monitor.gateEvents('spx', { confidence: 80 }, NaN, { confidence: 50 }).length === 0);

// ── eventsForAsset ──────────────────────────────────────────────────────
const zoneContext = {
  projection: { available: true, rangeUsedPct: 105, reading: 'RANGE SPENT — a normal day is already done' },
  zones: { byConfluence: [
    { low: 7740, high: 7760, mid: 7750, score: 5, families: ['pivot', 'swing', 'prior-period', 'round-number', 'bollinger'] },
    { low: 7600, high: 7610, mid: 7605, score: 2, families: ['pivot', 'swing'] },
  ] },
};
const planAsset = { trade_plan: { entry: 7720, stop: 7690, target: 7800 } };

// Price moves 7715 -> 7750: crosses the plan entry AND enters the x5 zone.
const moved = monitor.eventsForAsset('spx',
  { price: 7750, atr: 50 }, zoneContext, planAsset,
  { price: 7715, rangeUsedPct: 80, insideZones: [] });
const kinds = moved.events.map(e => e.kind);
check('crossing the plan entry is reported',
  kinds.includes('plan-entry-crossed'), JSON.stringify(kinds));
check('the entry crossing is URGENT',
  moved.events.find(e => e.kind === 'plan-entry-crossed').rank === monitor.RANK.URGENT);
check('entering a confluence zone is reported',
  kinds.includes('zone-entered'), JSON.stringify(kinds));
check('a x5 zone entry is NOTABLE',
  moved.events.find(e => e.kind === 'zone-entered').rank === monitor.RANK.NOTABLE);
check('the zone event names the confluence count and the methods',
  moved.events.find(e => e.kind === 'zone-entered').text.includes('x5')
  && moved.events.find(e => e.kind === 'zone-entered').text.includes('pivot'));
check('crossing 100% of the ATR range is reported once, on the crossing',
  kinds.includes('range-spent'), JSON.stringify(kinds));
check('the observation carries the zones price is now inside',
  moved.observation.insideZones.length === 1, JSON.stringify(moved.observation));

// Same price, run again: the zone is already in `insideZones`, so NOTHING repeats.
// This is the whole difference between a monitor and a status line.
const again = monitor.eventsForAsset('spx',
  { price: 7750, atr: 50 }, zoneContext, planAsset, moved.observation);
check('a second pass at the same price reports NOTHING',
  again.events.length === 0, JSON.stringify(again.events.map(e => e.kind)));
check('range-spent does not re-fire once already spent',
  !again.events.some(e => e.kind === 'range-spent'));

// Leaving the zone is its own event.
const left = monitor.eventsForAsset('spx',
  { price: 7700, atr: 50 }, zoneContext, planAsset, moved.observation);
check('leaving a zone is reported', left.events.some(e => e.kind === 'zone-left'),
  JSON.stringify(left.events.map(e => e.kind)));

// The stop being taken out is URGENT whichever way price got there.
const stopped = monitor.eventsForAsset('spx',
  { price: 7680, atr: 50 }, zoneContext, planAsset,
  { price: 7700, rangeUsedPct: 105, insideZones: [] });
check('crossing the plan stop is reported and URGENT',
  stopped.events.some(e => e.kind === 'plan-stop-crossed' && e.rank === monitor.RANK.URGENT),
  JSON.stringify(stopped.events.map(e => e.kind)));

// First pass of the day: no `before` at all. Must produce no crossings.
const firstPass = monitor.eventsForAsset('spx',
  { price: 7750, atr: 50 }, zoneContext, planAsset, undefined);
check('with no previous observation, no crossing is asserted',
  !firstPass.events.some(e => e.kind.endsWith('-crossed')),
  JSON.stringify(firstPass.events.map(e => e.kind)));

// A WAIT asset has no trade_plan. Zones must still be monitored — "where does this
// stop going up" is the question a WAIT chart is read to answer.
const waitAsset = monitor.eventsForAsset('spx',
  { price: 7750, atr: 50 }, zoneContext, { trade_plan: null },
  { price: 7715, rangeUsedPct: 80, insideZones: [] });
check('a WAIT asset still gets zone events',
  waitAsset.events.some(e => e.kind === 'zone-entered'));
check('a WAIT asset gets no plan-price events',
  !waitAsset.events.some(e => e.kind.startsWith('plan-')));

// No context at all (endpoint down): must degrade, not throw.
let survivedNoContext = true;
try {
  monitor.eventsForAsset('spx', { price: 7750, atr: 50 }, null, planAsset,
    { price: 7715, insideZones: [] });
} catch (e) { survivedNoContext = false; }
check('a missing market context degrades rather than throwing', survivedNoContext);

// ── The null-is-zero trap ───────────────────────────────────────────────
// Number(null) is 0 and 0 is finite, so a naive guard accepts a MISSING price as
// the number zero — and with price 0 every plan level sits above spot, so one null
// read fires URGENT "crossed DOWN through the plan stop" on all three assets. This
// was a live defect in the first cut of this file, found here rather than during a
// feed outage.
check('null is not a price', Number.isNaN(monitor.priceOrNaN(null)));
check('undefined is not a price', Number.isNaN(monitor.priceOrNaN(undefined)));
check('zero is not a price', Number.isNaN(monitor.priceOrNaN(0)));
check('a negative number is not a price', Number.isNaN(monitor.priceOrNaN(-5)));
check('an empty string is not a price', Number.isNaN(monitor.priceOrNaN('')));
check('a real price passes through', monitor.priceOrNaN(7719.4) === 7719.4);

const noPrice = monitor.eventsForAsset('spx', { price: null }, zoneContext, planAsset,
  { price: 7715, insideZones: [] });
check('a missing live price yields one named INFO event and NO crossing',
  Array.isArray(noPrice) && noPrice.length === 1 && noPrice[0].kind === 'no-price',
  JSON.stringify(noPrice));

// The mirror case: a null stored in the PREVIOUS observation must not manufacture a
// crossing on the next pass either.
const nullBefore = monitor.eventsForAsset('spx', { price: 7750, atr: 50 }, zoneContext,
  planAsset, { price: null, insideZones: [] });
check('a null PREVIOUS price asserts no crossing',
  !nullBefore.events.some(e => e.kind.endsWith('-crossed')),
  JSON.stringify(nullBefore.events.map(e => e.kind)));

// ── Report ──────────────────────────────────────────────────────────────
console.log(`\nplan_monitor.cjs — ${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFAILURES:');
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  process.exit(1);
}
console.log('All assertions passed.\n');
process.exit(0);
