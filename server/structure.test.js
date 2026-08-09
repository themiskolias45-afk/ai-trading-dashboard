'use strict';
/**
 * Tests for CRT and AMD detection.
 *
 * Same discipline as fvg.test.js: fixtures are hand-built so the right answer is
 * known by construction, and the negative cases carry the weight. A pattern
 * detector that fires on everything is worse than none, so most of these assert
 * that something is NOT detected.
 *
 * Run: node server/structure.test.js
 */

const assert = require("assert");
const { detectCRT, detectAMD } = require("./structure");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("  PASS  " + name); }
  catch (e) { failed++; console.log("  FAIL  " + name + "\n          " + e.message); }
}

/** Bars from [low, high, close] triples, oldest first. */
function series(rows) {
  return {
    lows:   rows.map(r => r[0]),
    highs:  rows.map(r => r[1]),
    closes: rows.map(r => r[2]),
  };
}
/** Calm filler so averageBarRange is a known 10 and nothing incidental triggers. */
function calm(count) {
  return Array.from({ length: count }, () => [95, 105, 100]);
}

console.log("\n── CRT: the three-candle model ──────────────────────────────");

test("sweeping the high and closing back inside is a BEARISH CRT", () => {
  // c1 range 95-105. c2 pokes to 112 but closes 101 (inside). c3 closes below c2.
  const bars = series([...calm(20), [95, 105, 100], [99, 112, 101], [90, 102, 96]]);
  const { patterns } = detectCRT(bars);
  assert.strictEqual(patterns.length, 1, "expected 1, got " + patterns.length);
  assert.strictEqual(patterns[0].direction, "bearish");
  assert.strictEqual(patterns[0].sweptSide, "high");
  assert.strictEqual(patterns[0].objective, 95, "objective is the opposite edge of c1");
  assert.strictEqual(patterns[0].invalidation, 112, "invalidation is the sweep extreme");
});

test("sweeping the low and closing back inside is a BULLISH CRT", () => {
  const bars = series([...calm(20), [95, 105, 100], [88, 101, 99], [98, 110, 104]]);
  const { patterns } = detectCRT(bars);
  assert.strictEqual(patterns.length, 1);
  assert.strictEqual(patterns[0].direction, "bullish");
  assert.strictEqual(patterns[0].sweptSide, "low");
  assert.strictEqual(patterns[0].objective, 105);
});

test("closing OUTSIDE the swept range is a breakout, not a CRT", () => {
  // c2 pokes to 112 AND closes 110 — above c1's high. The push held.
  const bars = series([...calm(20), [95, 105, 100], [99, 112, 110], [90, 102, 96]]);
  assert.strictEqual(detectCRT(bars).patterns.length, 0,
    "a candle that closes beyond the range it violated must not count");
});

test("a sweep that engulfs BOTH edges is excluded", () => {
  const bars = series([...calm(20), [95, 105, 100], [85, 115, 100], [90, 102, 96]]);
  assert.strictEqual(detectCRT(bars).patterns.length, 0);
});

test("no sweep at all is not a CRT", () => {
  const bars = series([...calm(20), [95, 105, 100], [97, 103, 100], [90, 102, 96]]);
  assert.strictEqual(detectCRT(bars).patterns.length, 0);
});

test("a sweep too shallow to clear the noise floor is ignored", () => {
  // avg range 10, floor 0.05 -> 0.5. This clears the high by 0.2.
  const bars = series([...calm(20), [95, 105, 100], [99, 105.2, 101], [90, 102, 96]]);
  assert.strictEqual(detectCRT(bars).patterns.length, 0);
  // Same bars with a lower floor DO produce it — proves the floor is the reason.
  assert.strictEqual(detectCRT(bars, { minSweepRangeFraction: 0.001 }).patterns.length, 1);
});

test("unconfirmed c3 is dropped by default and kept on request", () => {
  // Swept the high, but c3 closes UP — no distribution.
  const bars = series([...calm(20), [95, 105, 100], [99, 112, 101], [100, 112, 108]]);
  assert.strictEqual(detectCRT(bars).patterns.length, 0, "default requires confirmation");
  const loose = detectCRT(bars, { requireConfirmation: false });
  assert.strictEqual(loose.patterns.length, 1);
  assert.strictEqual(loose.patterns[0].confirmed, false, "must be honest that it is unconfirmed");
});

test("CRT direction is not inverted", () => {
  // The single most damaging possible bug: a high sweep must never read bullish.
  const highSweep = series([...calm(20), [95, 105, 100], [99, 112, 101], [90, 102, 96]]);
  const lowSweep  = series([...calm(20), [95, 105, 100], [88, 101, 99], [98, 110, 104]]);
  assert.strictEqual(detectCRT(highSweep).patterns[0].direction, "bearish");
  assert.strictEqual(detectCRT(lowSweep).patterns[0].direction, "bullish");
  assert.ok(detectCRT(highSweep).patterns[0].objective < detectCRT(highSweep).patterns[0].rangeHigh,
    "a bearish objective must sit below the range high");
});

test("barsAgo counts back from the newest bar", () => {
  const bars = series([...calm(20), [95, 105, 100], [99, 112, 101], [90, 102, 96], [92, 100, 95], [91, 99, 94]]);
  assert.strictEqual(detectCRT(bars).patterns[0].barsAgo, 2);
});

test("malformed input returns an error rather than throwing", () => {
  assert.ok(detectCRT(null).error);
  assert.ok(detectCRT(series([[1, 2, 1]])).error);
  assert.ok(detectCRT({ highs: [1, 2, 3], lows: [1, 2], closes: [1, 2, 3] }).error);
  assert.ok(detectCRT({ highs: [1, 2, NaN], lows: [0, 1, 2], closes: [1, 1, 1] }).error);
});

console.log("\n── AMD: range, sweep, expansion over a window ───────────────");

/** A tight accumulation of `n` bars inside [low, high]. */
function tight(n, low, high) {
  return Array.from({ length: n }, () => [low, high, (low + high) / 2]);
}

test("tight range, high swept and reclaimed, then expansion down is BEARISH AMD", () => {
  const bars = series([
    ...calm(25),
    ...tight(12, 99, 101),        // accumulation 99-101
    [100, 106, 100],              // manipulation: took 101, closed back inside
    [92, 100, 95],                // distribution: closed below 99
  ]);
  const out = detectAMD(bars, { window: 12 });
  assert.strictEqual(out.patterns.length, 1, "expected 1, got " + out.patterns.length);
  assert.strictEqual(out.patterns[0].direction, "bearish");
  assert.strictEqual(out.patterns[0].accumulationHigh, 101);
  assert.strictEqual(out.patterns[0].accumulationLow, 99);
});

test("low swept and reclaimed, then expansion up is BULLISH AMD", () => {
  const bars = series([
    ...calm(25),
    ...tight(12, 99, 101),
    [94, 100, 100],               // took 99, closed back inside
    [100, 108, 105],              // closed above 101
  ]);
  const out = detectAMD(bars, { window: 12 });
  assert.strictEqual(out.patterns.length, 1);
  assert.strictEqual(out.patterns[0].direction, "bullish");
});

test("no distribution means no AMD", () => {
  const bars = series([
    ...calm(25),
    ...tight(12, 99, 101),
    [100, 106, 100],
    [99, 101, 100],               // went nowhere
  ]);
  assert.strictEqual(detectAMD(bars, { window: 12 }).patterns.length, 0);
});

test("a TRENDING window is not accumulation", () => {
  // Bars that march upward have a wide span; without the tightness test this
  // would fire constantly and AMD would be meaningless.
  const trend = Array.from({ length: 12 }, (_, k) => [100 + k * 5, 110 + k * 5, 105 + k * 5]);
  const bars = series([...calm(25), ...trend, [160, 175, 160], [120, 158, 125]]);
  assert.strictEqual(detectAMD(bars, { window: 12 }).patterns.length, 0,
    "a trend must not be mistaken for a consolidation");
});

test("sessionAligned is false everywhere, always", () => {
  const bars = series([...calm(25), ...tight(12, 99, 101), [100, 106, 100], [92, 100, 95]]);
  const out = detectAMD(bars, { window: 12 });
  assert.strictEqual(out.sessionAligned, false, "top level must disclaim session alignment");
  assert.strictEqual(out.patterns[0].sessionAligned, false, "and so must every pattern");
  assert.ok(out.sessionNote.includes("no timestamps"), "the reason must be stated");
});

test("too few bars for the window returns an error, not a silent empty", () => {
  const out = detectAMD(series(calm(5)), { window: 12 });
  assert.ok(out.error, "expected an error explaining the shortfall");
  assert.strictEqual(out.patterns.length, 0);
});

test("AMD direction is not inverted", () => {
  const highSwept = series([...calm(25), ...tight(12, 99, 101), [100, 106, 100], [92, 100, 95]]);
  const pattern = detectAMD(highSwept, { window: 12 }).patterns[0];
  assert.strictEqual(pattern.direction, "bearish");
  assert.ok(pattern.objective < pattern.accumulationLow, "bearish objective sits below the range");
});

console.log("\n── the mutation check ───────────────────────────────────────");

test("CRT does not fire on calm bars", () => {
  assert.strictEqual(detectCRT(series(calm(60))).totalFound, 0,
    "identical bars contain no sweep; anything else means the detector is broken");
});

test("AMD does not fire on calm bars", () => {
  assert.strictEqual(detectAMD(series(calm(60)), { window: 12 }).totalFound, 0);
});

test("totalFound reports everything even when maxPatterns truncates", () => {
  const block = [[95, 105, 100], [99, 112, 101], [90, 102, 96]];
  const bars = series([...calm(20), ...block, ...calm(3), ...block]);
  const out = detectCRT(bars, { maxPatterns: 1 });
  assert.strictEqual(out.patterns.length, 1);
  assert.ok(out.totalFound >= 2, "totalFound was " + out.totalFound + ", expected >= 2");
});

console.log("\n" + (failed === 0 ? passed + " passed, 0 failed" : passed + " passed, " + failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
