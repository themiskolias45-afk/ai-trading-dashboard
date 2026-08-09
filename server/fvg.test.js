'use strict';
/**
 * Tests for FVG detection.
 *
 * Fixtures are hand-built so the correct answer is known by construction rather
 * than by running the code and blessing whatever came out. That mistake is on
 * record in this repo: a 188/188 GREEN suite once passed the bug and failed the
 * fix, so several tests here assert against the WRONG behaviour deliberately
 * failing — see "the mutation check" at the bottom.
 *
 * Run: node server/fvg.test.js
 */

const assert = require("assert");
const {
  detectFVGs, averageBarRange, judgeFill,
  STATUS_FRESH, STATUS_PARTIAL, STATUS_FILLED,
} = require("./fvg");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("  PASS  " + name); }
  catch (e) { failed++; console.log("  FAIL  " + name + "\n          " + e.message); }
}

/**
 * Build a bar series from [low, high] pairs, oldest first.
 * closes are set mid-bar; FVG detection never reads them except for "current price".
 */
function series(pairs) {
  return {
    lows:   pairs.map(p => p[0]),
    highs:  pairs.map(p => p[1]),
    closes: pairs.map(p => (p[0] + p[1]) / 2),
  };
}

/** Filler bars that create no gaps: each overlaps its neighbours generously. */
function flat(count, low, high) {
  return Array.from({ length: count }, () => [low, high]);
}

console.log("\n── detection: the basic shapes ──────────────────────────────");

test("bullish gap: candle 3 low above candle 1 high", () => {
  // c1 high 100, c2 displaces up, c3 low 110 → gap 100..110
  const bars = series([...flat(20, 90, 100), [95, 100], [100, 115], [110, 120]]);
  const { zones } = detectFVGs(bars);
  assert.strictEqual(zones.length, 1, "expected exactly one zone, got " + zones.length);
  assert.strictEqual(zones[0].direction, "bullish");
  assert.strictEqual(zones[0].bottom, 100);
  assert.strictEqual(zones[0].top, 110);
  assert.strictEqual(zones[0].height, 10);
});

test("bearish gap: candle 3 high below candle 1 low", () => {
  // c1 low 100, c2 displaces down, c3 high 90 → gap 90..100
  const bars = series([...flat(20, 100, 110), [100, 108], [85, 102], [80, 90]]);
  const { zones } = detectFVGs(bars);
  assert.strictEqual(zones.length, 1, "expected exactly one zone, got " + zones.length);
  assert.strictEqual(zones[0].direction, "bearish");
  assert.strictEqual(zones[0].bottom, 90);
  assert.strictEqual(zones[0].top, 100);
});

test("overlapping wicks are not a gap", () => {
  // c3 low 99 vs c1 high 100 — they overlap by 1, so no imbalance.
  const bars = series([...flat(20, 90, 100), [95, 100], [98, 115], [99, 120]]);
  assert.strictEqual(detectFVGs(bars).zones.length, 0);
});

test("touching exactly is not a gap", () => {
  // c3 low == c1 high. Nothing was skipped.
  const bars = series([...flat(20, 90, 100), [95, 100], [100, 115], [100, 120]]);
  assert.strictEqual(detectFVGs(bars).zones.length, 0);
});

console.log("\n── bar order: the trap ──────────────────────────────────────");

test("ORDER MATTERS: reversing the series flips bullish to bearish", () => {
  const pairs = [...flat(20, 90, 100), [95, 100], [100, 115], [110, 120]];
  const forward  = detectFVGs(series(pairs));
  const backward = detectFVGs(series(pairs.slice().reverse()));
  assert.strictEqual(forward.zones[0].direction, "bullish");
  assert.strictEqual(backward.zones.length, 1, "reversed series should still find one gap");
  assert.strictEqual(backward.zones[0].direction, "bearish",
    "if this is not bearish, the detector is order-blind and the oldest-first "
    + "contract is not actually being exercised");
});

test("barsAgo counts back from the newest bar", () => {
  // Gap completes at the third-from-last bar → barsAgo 2.
  const bars = series([...flat(20, 90, 100), [95, 100], [100, 115], [110, 120], [112, 122], [113, 123]]);
  const { zones } = detectFVGs(bars);
  assert.strictEqual(zones[0].barsAgo, 2, "got barsAgo " + zones[0].barsAgo);
});

console.log("\n── mitigation: fresh, partial, filled ───────────────────────");

test("untouched gap is FRESH", () => {
  const bars = series([...flat(20, 90, 100), [95, 100], [100, 115], [110, 120], [112, 122]]);
  const { zones } = detectFVGs(bars);
  assert.strictEqual(zones[0].status, STATUS_FRESH);
  assert.strictEqual(zones[0].fillPercent, 0);
});

test("price dipping halfway in is PARTIAL", () => {
  // Gap 100..110; a later bar dips to 105 → half filled.
  const bars = series([...flat(20, 90, 100), [95, 100], [100, 115], [110, 120], [105, 118]]);
  const { zones } = detectFVGs(bars);
  assert.strictEqual(zones[0].status, STATUS_PARTIAL);
  assert.ok(Math.abs(zones[0].fillPercent - 0.5) < 1e-9, "fillPercent " + zones[0].fillPercent);
});

test("price trading through is FILLED and dropped by default", () => {
  // Gap 100..110; a later bar reaches 98, below the gap floor.
  const bars = series([...flat(20, 90, 100), [95, 100], [100, 115], [110, 120], [98, 118]]);
  assert.strictEqual(detectFVGs(bars).zones.length, 0, "a filled gap must not be reported");
});

test("filled gaps are returned when explicitly asked for", () => {
  const bars = series([...flat(20, 90, 100), [95, 100], [100, 115], [110, 120], [98, 118]]);
  const { zones } = detectFVGs(bars, { includeFilled: true });
  assert.strictEqual(zones.length, 1);
  assert.strictEqual(zones[0].status, STATUS_FILLED);
});

test("a bearish gap is filled by trading UP, not down", () => {
  // Bearish gap 90..100. A later bar dropping to 70 must NOT fill it.
  const down = series([...flat(20, 100, 110), [100, 108], [85, 102], [80, 90], [70, 88]]);
  assert.strictEqual(detectFVGs(down).zones[0].status, STATUS_FRESH,
    "trading further down must leave a bearish gap unfilled");
  // A later bar rallying to 101 must fill it.
  const up = series([...flat(20, 100, 110), [100, 108], [85, 102], [80, 90], [85, 101]]);
  assert.strictEqual(detectFVGs(up).zones.length, 0, "rallying through must fill it");
});

console.log("\n── the noise floor ──────────────────────────────────────────");

test("a gap smaller than the minimum is ignored", () => {
  // Average bar range 10, floor 0.25 -> 2.5. This gap is 1.
  const bars = series([...flat(20, 90, 100), [95, 100], [100, 106], [101, 111]]);
  assert.strictEqual(detectFVGs(bars).zones.length, 0, "1-point gap should be below the floor");
});

test("the same gap is reported when the floor is lowered", () => {
  const bars = series([...flat(20, 90, 100), [95, 100], [100, 106], [101, 111]]);
  const { zones } = detectFVGs(bars, { minGapRangeFraction: 0.05 });
  assert.strictEqual(zones.length, 1, "expected the gap to appear with a lower floor");
  assert.strictEqual(zones[0].height, 1);
});

test("heightInRanges expresses size in bar-ranges", () => {
  const bars = series([...flat(20, 90, 100), [95, 100], [100, 115], [110, 120]]);
  const { zones, averageRange } = detectFVGs(bars);
  assert.ok(averageRange > 0, "average range should be positive");
  assert.ok(Math.abs(zones[0].heightInRanges - zones[0].height / averageRange) < 1e-9);
});

console.log("\n── ordering and caps ────────────────────────────────────────");

// Exactly two gaps, separated by overlapping filler.
//
// The first draft of this fixture stacked the two gap groups back to back and
// asserted 2 zones. It found 4 — a rising staircase gaps on EVERY consecutive
// triple, not just the ones you meant to build. The detector was right and the
// fixture was wrong, which is the entire reason these are hand-built: bars 23-26
// below deliberately overlap so no incidental gap forms between the two real ones.
const TWO_GAP_SERIES = [
  ...flat(20, 90, 100),
  [95, 100], [100, 115], [110, 120],   // idx 20-22: bullish gap 100..110 at idx 22
  [110, 120], [110, 120], [115, 120],  // idx 23-25: overlapping filler, no gaps
  [120, 135], [130, 140],              // idx 26-27: bullish gap 120..130 at idx 27
];

test("zones come back newest first", () => {
  const { zones } = detectFVGs(series(TWO_GAP_SERIES));
  assert.strictEqual(zones.length, 2, "expected two zones, got " + zones.length
    + " (" + zones.map(z => z.bottom + ".." + z.top).join(", ") + ")");
  assert.strictEqual(zones[0].barsAgo, 0, "newest gap is on the final bar");
  assert.strictEqual(zones[1].barsAgo, 5);
  assert.ok(zones[0].barsAgo < zones[1].barsAgo, "newest zone must come first");
  assert.strictEqual(zones[0].bottom, 120);
  assert.strictEqual(zones[1].bottom, 100);
});

test("maxZones caps the list without reordering it", () => {
  const { zones, totalFound } = detectFVGs(series(TWO_GAP_SERIES), { maxZones: 1 });
  assert.strictEqual(zones.length, 1);
  assert.strictEqual(zones[0].barsAgo, 0, "the cap must keep the newest, not the first found");
  assert.strictEqual(totalFound, 2, "totalFound must report everything, not just what fit");
});

test("a rising staircase gaps on every triple — and that is correct", () => {
  // Guards the lesson above: this SHOULD find many zones. If a future change makes
  // it find one or two, something has started merging or swallowing gaps.
  const staircase = series([
    ...flat(20, 90, 100),
    [95, 100], [100, 115], [110, 120], [118, 125], [125, 140], [135, 145],
  ]);
  const { totalFound } = detectFVGs(staircase);
  assert.strictEqual(totalFound, 4, "expected 4 staircase gaps, got " + totalFound);
});

console.log("\n── current-price context ────────────────────────────────────");

test("priceInside is true when the last close sits in the zone", () => {
  // Bearish gap 90..100; final close lands at 95 inside it.
  const bars = series([...flat(20, 100, 110), [100, 108], [85, 102], [80, 90]]);
  bars.closes[bars.closes.length - 1] = 95;
  const { zones } = detectFVGs(bars);
  assert.strictEqual(zones[0].priceInside, true);
});

test("distancePct is signed: above price is positive", () => {
  const bars = series([...flat(20, 90, 100), [95, 100], [100, 115], [110, 120]]);
  bars.closes[bars.closes.length - 1] = 100;
  const { zones } = detectFVGs(bars);   // gap 100..110, midpoint 105
  assert.ok(zones[0].distancePct > 0, "a zone above price should be positive, got " + zones[0].distancePct);
  assert.ok(Math.abs(zones[0].distancePct - 5) < 1e-9);
});

console.log("\n── malformed input ──────────────────────────────────────────");

test("null bars return an error, not a throw", () => {
  assert.strictEqual(detectFVGs(null).error, "no bars");
  assert.deepStrictEqual(detectFVGs(null).zones, []);
});

test("fewer than 3 bars returns an error", () => {
  assert.ok(detectFVGs(series([[1, 2], [1, 2]])).error);
});

test("mismatched array lengths are rejected", () => {
  assert.ok(detectFVGs({ highs: [1, 2, 3], lows: [1, 2] }).error);
});

test("NaN in the series is rejected rather than propagated", () => {
  assert.ok(detectFVGs({ highs: [1, 2, NaN], lows: [0, 1, 2] }).error);
});

test("missing closes still detects, just without price context", () => {
  const bars = series([...flat(20, 90, 100), [95, 100], [100, 115], [110, 120]]);
  delete bars.closes;
  const { zones } = detectFVGs(bars);
  assert.strictEqual(zones.length, 1);
  assert.strictEqual(zones[0].distancePct, null);
  assert.strictEqual(zones[0].priceInside, false);
});

test("a perfectly flat series produces nothing and does not divide by zero", () => {
  const bars = series(flat(30, 100, 100));
  const out = detectFVGs(bars);
  assert.strictEqual(out.zones.length, 0);
  assert.strictEqual(out.averageRange, 0);
});

console.log("\n── the mutation check ───────────────────────────────────────");
// A suite that cannot fail proves nothing. These assert that the tests above are
// actually load-bearing by feeding the detector inputs its rules must reject.

test("detector rejects a 2-candle 'gap' (needs three)", () => {
  // Only two candles that do not overlap — not an FVG under any definition.
  assert.strictEqual(detectFVGs(series([[90, 100], [110, 120]])).zones.length, 0);
});

test("judgeFill is not silently returning FRESH for everything", () => {
  assert.strictEqual(judgeFill("bullish", 100, 110, 95,  -Infinity).status, STATUS_FILLED);
  assert.strictEqual(judgeFill("bullish", 100, 110, 105, -Infinity).status, STATUS_PARTIAL);
  assert.strictEqual(judgeFill("bullish", 100, 110, 115, -Infinity).status, STATUS_FRESH);
  assert.strictEqual(judgeFill("bearish", 90, 100, Infinity, 105).status, STATUS_FILLED);
  assert.strictEqual(judgeFill("bearish", 90, 100, Infinity, 95).status,  STATUS_PARTIAL);
  assert.strictEqual(judgeFill("bearish", 90, 100, Infinity, 85).status,  STATUS_FRESH);
});

test("a zero-height gap is treated as filled, never as a live zone", () => {
  assert.strictEqual(judgeFill("bullish", 100, 100, Infinity, -Infinity).status, STATUS_FILLED);
});

test("averageBarRange actually averages", () => {
  assert.strictEqual(averageBarRange([10, 20], [0, 0], 20), 15);
  assert.strictEqual(averageBarRange([10, 20], [0, 0], 1),  20, "sample size must window the tail");
});

console.log("\n" + (failed === 0
  ? passed + " passed, 0 failed"
  : passed + " passed, " + failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
