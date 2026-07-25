/**
 * Standalone test runner for the Hermes self-learning calibration logic.
 *
 *   node server/hermes.test.js
 *
 * No test framework. Exit code 0 = all passed, 1 = at least one failure.
 *
 * What is actually being tested (verified against server/hermes.js, not assumed):
 * Hermes has no win-rate multiplier. Its calibration is sample-size + expectancy-sign:
 *
 *   MIN_SAMPLE = 8                                          hermes.js:22
 *   validated  = trades.length >= MIN_SAMPLE                 hermes.js:70   (computeLeaderboard)
 *   BOOST      = validated && expectancy > 0  -> champion    hermes.js:80   (computeChampions)
 *   PENALTY    = validated && expectancy < 0  -> benched,     hermes.js:132  (openNewDuels)
 *                pushRejection, no paper position opened
 *   NEUTRAL    = !validated -> no champion, no bench;
 *                the geometry keeps trading so it can finish learning
 *
 * winRate is computed and reported (hermes.js:67) but nothing gates on it, so the
 * high/low win-rate cases below are expressed the way the code reads them: as the
 * sign of cost-adjusted expectancy over a validated sample.
 *
 * Hermes keeps its state module-private and file-backed, and exposes no setter. So
 * each scenario injects a fixture by intercepting fs for STATE_PATH only (reads are
 * answered from the fixture, writes are dropped) and clearing the require cache so
 * hermes.js re-initialises with `state = null`. The real hermes_state.json is never
 * read and never written.
 */
const fs   = require("fs");
const path = require("path");

const HERMES_PATH = require.resolve("./hermes.js");
const STATE_PATH  = path.join(__dirname, "hermes_state.json");

// Mirrors of the constants inside hermes.js — not exported there, so kept in sync by hand.
const MIN_SAMPLE       = 8;    // hermes.js:22
const COST_R           = 0.05; // hermes.js:21
const PAPER_ENTRY_CONF = 50;   // hermes.js:20

let failures = 0;
let passes   = 0;

function assert(cond, msg) {
  if (!cond) { console.error("FAIL: " + msg); failures++; }
  else { console.log("PASS: " + msg); passes++; }
}

// ---------------------------------------------------------------------------
// fs interception — scoped strictly to STATE_PATH, everything else passes through
// ---------------------------------------------------------------------------
const realExistsSync    = fs.existsSync;
const realReadFileSync  = fs.readFileSync;
const realWriteFileSync = fs.writeFileSync;

let fixtureState = null;   // the state object hermes.js will "load"
let writtenState = null;   // what hermes.js tried to persist, captured instead of saved

fs.existsSync = function (target, ...rest) {
  if (target === STATE_PATH) return fixtureState !== null;
  return realExistsSync.call(fs, target, ...rest);
};

fs.readFileSync = function (target, ...rest) {
  if (target === STATE_PATH && fixtureState !== null) return JSON.stringify(fixtureState);
  return realReadFileSync.call(fs, target, ...rest);
};

fs.writeFileSync = function (target, contents, ...rest) {
  if (target === STATE_PATH) {
    try { writtenState = JSON.parse(contents); } catch (e) { writtenState = null; }
    return undefined;
  }
  return realWriteFileSync.call(fs, target, contents, ...rest);
};

function restoreFs() {
  fs.existsSync    = realExistsSync;
  fs.readFileSync  = realReadFileSync;
  fs.writeFileSync = realWriteFileSync;
}

// ---------------------------------------------------------------------------
// fixture helpers
// ---------------------------------------------------------------------------
const WIN_R  = parseFloat((2 - COST_R).toFixed(3));   // a 2R target, cost-adjusted, as markToMarket records it
const LOSS_R = parseFloat((-1 - COST_R).toFixed(3));  // a full stop-out, cost-adjusted

// Closed-trade history for one (asset, geometry) pair with an exact win/loss split.
function closedHistory(asset, geometry, winCount, lossCount) {
  const trades = [];
  for (let i = 0; i < winCount; i++) {
    trades.push({ id: `${asset}-${geometry}-w${i}`, asset, geometry, dir: "BUY", r: WIN_R, result: "WIN" });
  }
  for (let i = 0; i < lossCount; i++) {
    trades.push({ id: `${asset}-${geometry}-l${i}`, asset, geometry, dir: "BUY", r: LOSS_R, result: "LOSS" });
  }
  return trades;
}

function stateWith(closed) {
  return { inceptionAt: "2026-01-01T00:00:00.000Z", open: [], closed, rejections: [] };
}

// Load a fresh copy of hermes.js on top of the given fixture state.
function loadHermes(state) {
  fixtureState = state;
  writtenState = null;
  delete require.cache[HERMES_PATH];
  return require("./hermes.js");
}

// A live signal for `geometry` on btc that clears PAPER_ENTRY_CONF and has full geometry.
function signalCacheFor(geometry, confidence) {
  return {
    btc: {
      signal: "BUY", confidence, setup: geometry,
      entry: 100000, stop: 98000, target: 104000, rr: 2,
      trend: "UP", regime: "TREND",
    },
    gold: null,
    spx: null,
  };
}

// Entry price exactly — so markToMarket cannot close the position we just opened.
const PRICE_CACHE = { btc: 100000, gold: null, spx: null };

function rowFor(board, asset, geometry) {
  return board.find(r => r.asset === asset && r.geometry === geometry);
}

// ---------------------------------------------------------------------------
// Case 1 — high win rate, sufficient sample -> BOOST (promoted to champion, kept trading)
// ---------------------------------------------------------------------------
function testBoostOnHighWinRate() {
  console.log("\n-- case 1: high win rate + sufficient sample -> boosted to champion --");
  const geometry = "FVG_RECLAIM";
  const wins = 8, losses = 2;                       // 10 trades, comfortably over MIN_SAMPLE of 8
  const hermes = loadHermes(stateWith(closedHistory("btc", geometry, wins, losses)));

  const row = rowFor(hermes.computeLeaderboard(), "btc", geometry);
  assert(row !== undefined, "leaderboard has a row for the high-win-rate geometry");
  if (!row) return;

  const expectedExpectancy = parseFloat((((wins * WIN_R) + (losses * LOSS_R)) / (wins + losses)).toFixed(3));
  assert(row.trades === wins + losses, `sample size is ${wins + losses} (got ${row.trades})`);
  assert(row.trades >= MIN_SAMPLE, `sample size ${row.trades} is at or above MIN_SAMPLE ${MIN_SAMPLE}`);
  assert(row.winRate === 80, `win rate is 80% (got ${row.winRate}%)`);
  assert(row.validated === true, "validated is true once the sample clears MIN_SAMPLE");
  assert(row.expectancy === expectedExpectancy, `cost-adjusted expectancy is ${expectedExpectancy}R (got ${row.expectancy}R)`);
  assert(row.expectancy > 0, `expectancy is positive (${row.expectancy}R) — the boost precondition`);

  // The boost itself: promotion to champion for that asset.
  const champions = hermes.computeChampions();
  assert(champions.btc !== undefined, "btc has a champion geometry");
  assert(champions.btc && champions.btc.geometry === geometry, `champion for btc is ${geometry} (got ${champions.btc && champions.btc.geometry})`);
  assert(champions.btc && champions.btc.expectancy === row.expectancy, "champion carries the same expectancy as its leaderboard row");

  // A boosted geometry must not be benched: the cycle opens a paper position, no rejection.
  hermes.runHermesCycle(signalCacheFor(geometry, 72), PRICE_CACHE);
  const snap = hermes.getSnapshot(signalCacheFor(geometry, 72), PRICE_CACHE);
  assert(snap.duel.open.some(p => p.asset === "btc" && p.geometry === geometry),
    "boosted geometry gets a paper position opened");
  assert(snap.rejections.length === 0, `boosted geometry is not rejected (got ${snap.rejections.length} rejection(s))`);
}

// ---------------------------------------------------------------------------
// Case 2 — low win rate, sufficient sample -> PENALTY (benched, rejection logged)
// ---------------------------------------------------------------------------
function testPenaltyOnLowWinRate() {
  console.log("\n-- case 2: low win rate + sufficient sample -> benched --");
  const geometry = "RANGE_FADE";
  const wins = 2, losses = 8;                       // 10 trades, over MIN_SAMPLE, expectancy clearly negative
  const hermes = loadHermes(stateWith(closedHistory("btc", geometry, wins, losses)));

  const row = rowFor(hermes.computeLeaderboard(), "btc", geometry);
  assert(row !== undefined, "leaderboard has a row for the low-win-rate geometry");
  if (!row) return;

  const expectedExpectancy = parseFloat((((wins * WIN_R) + (losses * LOSS_R)) / (wins + losses)).toFixed(3));
  assert(row.trades >= MIN_SAMPLE, `sample size ${row.trades} is at or above MIN_SAMPLE ${MIN_SAMPLE}`);
  assert(row.winRate === 20, `win rate is 20% (got ${row.winRate}%)`);
  assert(row.validated === true, "validated is true once the sample clears MIN_SAMPLE");
  assert(row.expectancy === expectedExpectancy, `cost-adjusted expectancy is ${expectedExpectancy}R (got ${row.expectancy}R)`);
  assert(row.expectancy < 0, `expectancy is negative (${row.expectancy}R) — the penalty precondition`);

  // No boost: a negative-expectancy geometry can never be champion.
  const champions = hermes.computeChampions();
  assert(champions.btc === undefined, "penalised geometry is not promoted to champion");

  // The penalty itself: the cycle refuses the entry and logs why.
  hermes.runHermesCycle(signalCacheFor(geometry, 72), PRICE_CACHE);
  const snap = hermes.getSnapshot(signalCacheFor(geometry, 72), PRICE_CACHE);
  assert(!snap.duel.open.some(p => p.asset === "btc" && p.geometry === geometry),
    "penalised geometry gets no paper position opened");
  assert(snap.rejections.length === 1, `exactly one rejection is logged (got ${snap.rejections.length})`);

  const rejection = snap.rejections[0];
  assert(rejection !== undefined && rejection.asset === "btc" && rejection.geometry === geometry,
    "rejection names the penalised asset and geometry");
  assert(rejection !== undefined && /negative expectancy/.test(rejection.reason),
    `rejection reason cites negative expectancy (got ${rejection && rejection.reason})`);
  assert(rejection !== undefined && rejection.reason.includes(String(row.expectancy)),
    `rejection reason carries the measured expectancy ${row.expectancy}R`);

  // The penalty is persisted, not just reported.
  assert(writtenState !== null && Array.isArray(writtenState.rejections) && writtenState.rejections.length === 1,
    "rejection is written back to state");
  assert(writtenState !== null && Array.isArray(writtenState.open) && writtenState.open.length === 0,
    "no open position is persisted for the penalised geometry");
}

// ---------------------------------------------------------------------------
// Case 3 — below MIN_SAMPLE -> NEUTRAL / still learning (no boost, no penalty)
// ---------------------------------------------------------------------------
function testNeutralWhileStillLearning() {
  console.log("\n-- case 3: below MIN_SAMPLE -> neutral / still learning --");
  const geometry = "LIQUIDITY_SWEEP";
  const wins = 1, losses = 2;                       // 3 trades — well under MIN_SAMPLE of 8
  const hermes = loadHermes(stateWith(closedHistory("btc", geometry, wins, losses)));

  const row = rowFor(hermes.computeLeaderboard(), "btc", geometry);
  assert(row !== undefined, "leaderboard has a row for the small-sample geometry");
  if (!row) return;

  assert(row.trades === wins + losses, `sample size is ${wins + losses} (got ${row.trades})`);
  assert(row.trades < MIN_SAMPLE, `sample size ${row.trades} is below MIN_SAMPLE ${MIN_SAMPLE}`);
  assert(row.validated === false, "validated is false — the neutral 'still learning' value");

  // Neutral means neither side of the calibration fires, even though expectancy is negative here.
  assert(row.expectancy < 0, `expectancy happens to be negative (${row.expectancy}R) on this small sample`);

  const champions = hermes.computeChampions();
  assert(Object.keys(champions).length === 0, "an unvalidated geometry produces no champions at all");
  assert(champions.btc === undefined, "no boost while still learning");

  hermes.runHermesCycle(signalCacheFor(geometry, 72), PRICE_CACHE);
  const snap = hermes.getSnapshot(signalCacheFor(geometry, 72), PRICE_CACHE);
  assert(snap.rejections.length === 0,
    `no penalty while still learning — negative expectancy under MIN_SAMPLE is not benched (got ${snap.rejections.length} rejection(s))`);
  assert(snap.duel.open.some(p => p.asset === "btc" && p.geometry === geometry),
    "a still-learning geometry keeps trading so it can reach MIN_SAMPLE");
}

// ---------------------------------------------------------------------------
// MIN_SAMPLE boundary — one trade either side of the threshold flips the verdict
// ---------------------------------------------------------------------------
function testMinSampleBoundary() {
  console.log(`\n-- boundary: MIN_SAMPLE = ${MIN_SAMPLE} --`);
  const geometry = "BREAKER_RETEST";

  // One short of the threshold: still learning, so a losing record escapes the bench.
  const below = loadHermes(stateWith(closedHistory("btc", geometry, 0, MIN_SAMPLE - 1)));
  const belowRow = rowFor(below.computeLeaderboard(), "btc", geometry);
  assert(belowRow !== undefined && belowRow.trades === MIN_SAMPLE - 1, `fixture has ${MIN_SAMPLE - 1} trades`);
  assert(belowRow !== undefined && belowRow.validated === false, `${MIN_SAMPLE - 1} trades is not yet validated`);
  below.runHermesCycle(signalCacheFor(geometry, 72), PRICE_CACHE);
  assert(below.getSnapshot(signalCacheFor(geometry, 72), PRICE_CACHE).rejections.length === 0,
    `all-loss record over ${MIN_SAMPLE - 1} trades is not benched`);

  // Exactly at the threshold: validated, and the same losing record is now benched.
  const at = loadHermes(stateWith(closedHistory("btc", geometry, 0, MIN_SAMPLE)));
  const atRow = rowFor(at.computeLeaderboard(), "btc", geometry);
  assert(atRow !== undefined && atRow.trades === MIN_SAMPLE, `fixture has exactly ${MIN_SAMPLE} trades`);
  assert(atRow !== undefined && atRow.validated === true, `exactly ${MIN_SAMPLE} trades is validated`);
  at.runHermesCycle(signalCacheFor(geometry, 72), PRICE_CACHE);
  assert(at.getSnapshot(signalCacheFor(geometry, 72), PRICE_CACHE).rejections.length === 1,
    `all-loss record over exactly ${MIN_SAMPLE} trades is benched`);
}

// ---------------------------------------------------------------------------
// Champion selection picks the best validated geometry, not merely a positive one
// ---------------------------------------------------------------------------
function testChampionPicksHighestExpectancy() {
  console.log("\n-- champion selection: highest validated expectancy wins --");
  const strong = closedHistory("btc", "FVG_RECLAIM", 9, 1);   // higher expectancy
  const weak   = closedHistory("btc", "RANGE_FADE",  6, 4);   // positive but lower
  const hermes = loadHermes(stateWith(strong.concat(weak)));

  const board = hermes.computeLeaderboard();
  const strongRow = rowFor(board, "btc", "FVG_RECLAIM");
  const weakRow   = rowFor(board, "btc", "RANGE_FADE");
  assert(strongRow !== undefined && weakRow !== undefined, "both geometries appear on the leaderboard");
  if (!strongRow || !weakRow) return;

  assert(strongRow.validated && weakRow.validated, "both geometries are validated");
  assert(strongRow.expectancy > 0 && weakRow.expectancy > 0, "both geometries have positive expectancy");
  assert(strongRow.expectancy > weakRow.expectancy, "FVG_RECLAIM has the higher expectancy");
  assert(board.indexOf(strongRow) < board.indexOf(weakRow), "leaderboard is sorted by expectancy, best first");

  const champions = hermes.computeChampions();
  assert(champions.btc && champions.btc.geometry === "FVG_RECLAIM",
    `champion is the highest-expectancy geometry (got ${champions.btc && champions.btc.geometry})`);
  assert(Object.keys(champions).length === 1, "one champion per asset");
}

// ---------------------------------------------------------------------------
// The gates that sit in front of the calibration must still hold
// ---------------------------------------------------------------------------
function testEntryGatesStillApply() {
  console.log(`\n-- entry gates: PAPER_ENTRY_CONF = ${PAPER_ENTRY_CONF}, watch-only setup --`);
  const geometry = "FVG_RECLAIM";
  const history  = closedHistory("btc", geometry, 8, 2);      // boosted history, so only the gate can block

  const lowConf = loadHermes(stateWith(history));
  const lowConfSignals = signalCacheFor(geometry, PAPER_ENTRY_CONF - 1);
  lowConf.runHermesCycle(lowConfSignals, PRICE_CACHE);
  const lowSnap = lowConf.getSnapshot(lowConfSignals, PRICE_CACHE);
  assert(lowSnap.duel.open.length === 0,
    `confidence ${PAPER_ENTRY_CONF - 1} is below PAPER_ENTRY_CONF, so no position opens even for a champion`);
  assert(lowConf.computeChampions().btc !== undefined, "the geometry is still a champion despite the skipped entry");

  const watch = loadHermes(stateWith(history));
  const watchSignals = signalCacheFor("BB_SQUEEZE_WATCH", 72);
  watch.runHermesCycle(watchSignals, PRICE_CACHE);
  assert(watch.getSnapshot(watchSignals, PRICE_CACHE).duel.open.length === 0,
    "BB_SQUEEZE_WATCH is watch-only and never opens a position");
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------
const TESTS = [
  testBoostOnHighWinRate,
  testPenaltyOnLowWinRate,
  testNeutralWhileStillLearning,
  testMinSampleBoundary,
  testChampionPicksHighestExpectancy,
  testEntryGatesStillApply,
];

console.log("hermes calibration tests — boost / penalty / still-learning");

try {
  for (const test of TESTS) {
    try {
      test();
    } catch (e) {
      console.error(`FAIL: ${test.name} threw — ${e && e.message}`);
      failures++;
    }
  }
} finally {
  restoreFs();
  delete require.cache[HERMES_PATH];
}

const total = passes + failures;
console.log(`\n${failures ? "FAILED" : "OK"} — total ${total}, passed ${passes}, failed ${failures}`);
process.exit(failures ? 1 : 0);
