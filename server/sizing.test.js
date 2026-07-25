'use strict';

/**
 * Standalone test runner for server/sizing.js — no external framework.
 * Run: node server/sizing.test.js
 * Exit code 0 = all passed, 1 = one or more failures.
 *
 * Assertions are written against the ACTUAL return shapes of sizing.js:
 *   calcKelly(winRate, avgWin, avgLoss)                     -> number  (clamped 0.005..0.05, default 0.01)
 *   calcATRSize(balance, entry, stop, atrValue, riskPct)     -> { lots, stopDistance, riskAmount, atrAdjusted }
 *   calcSize({ accountBalance, signal, learningStats, atrValue }) -> { lots, riskPct, riskAmount, stopDistance?, reasoning }
 *   calcPortfolioRisk(positions, balance)                    -> { totalRiskPct, safeToAdd, maxNewRisk }
 *   validateTrade(signal, balance, openPositions)            -> { approved, reason, suggestedSize }
 */

const {
  calcKelly,
  calcATRSize,
  calcSize,
  calcPortfolioRisk,
  validateTrade
} = require('./sizing.js');

// Bounds declared in sizing.js — duplicated here so the test fails loudly if they drift.
const MIN_KELLY = 0.005;
const MAX_KELLY = 0.05;
const DEFAULT_KELLY = 0.01;
const MAX_SINGLE_TRADE_RISK = 0.03;
const MAX_PORTFOLIO_RISK = 0.06;
const FLOAT_TOLERANCE = 1e-9;

let total = 0;
let failures = 0;
let knownIssues = 0;

function assert(cond, msg) {
  total++;
  if (!cond) {
    console.error('FAIL: ' + msg);
    failures++;
  } else {
    console.log('PASS: ' + msg);
  }
}

// Documents behaviour in sizing.js that is wrong but currently shipped.
// Reported separately so a real regression still shows up as FAIL, and so the
// exit code stays usable as a gate. Not counted in total/passed/failed.
function knownIssue(msg) {
  knownIssues++;
  console.warn('KNOWN ISSUE: ' + msg);
}

function isCleanNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function nearly(actual, expected) {
  return isCleanNumber(actual) && Math.abs(actual - expected) < FLOAT_TOLERANCE;
}

function section(title) {
  console.log('\n--- ' + title + ' ---');
}

// ---------------------------------------------------------------------------
// 1. Normal valid trades
// ---------------------------------------------------------------------------
section('1. Normal valid trades');

// Realistic BTC long: $10k account, entry 100000, stop 98000, target 104000, 75% confidence.
const NORMAL_BALANCE = 10000;
const NORMAL_SIGNAL = {
  symbol: 'BTC',
  direction: 'LONG',
  entry: 100000,
  stop: 98000,
  target: 104000,
  confidence: 75
};

const kellyNormal = calcKelly(0.6, 200, 100);
assert(isCleanNumber(kellyNormal), 'calcKelly(0.6, 200, 100) returns a finite number (got ' + kellyNormal + ')');
assert(kellyNormal > 0, 'calcKelly normal case is positive (got ' + kellyNormal + ')');
assert(
  kellyNormal >= MIN_KELLY && kellyNormal <= MAX_KELLY,
  'calcKelly normal case stays inside 0.5%-5% bounds (got ' + kellyNormal + ')'
);

// 60% win rate at 2:1 payoff => raw kelly 0.4, half-kelly 0.2, clamped to the 5% ceiling.
assert(nearly(kellyNormal, MAX_KELLY), 'calcKelly(0.6, 200, 100) clamps half-kelly 0.20 down to 0.05');

// Modest edge that lands between the clamps: 40% win rate at 4:1 payoff.
// raw kelly = 0.4 - 0.6/4 = 0.25 -> half = 0.125 -> still above ceiling, so use a thinner edge:
// 30% win rate at 3:1 => 0.30 - 0.70/3 = 0.0667 -> half = 0.0333 -> inside bounds.
const kellyMid = calcKelly(0.3, 300, 100);
assert(
  kellyMid > MIN_KELLY && kellyMid < MAX_KELLY,
  'calcKelly(0.3, 300, 100) returns an un-clamped interior value (got ' + kellyMid + ')'
);
assert(nearly(kellyMid, (0.3 - 0.7 / 3) / 2), 'calcKelly interior value equals half-kelly exactly');

const atrSizeNormal = calcATRSize(NORMAL_BALANCE, 100000, 98000, 0, 0.01);
assert(isCleanNumber(atrSizeNormal.lots), 'calcATRSize normal returns finite lots (got ' + atrSizeNormal.lots + ')');
assert(atrSizeNormal.lots > 0, 'calcATRSize normal lots are positive (got ' + atrSizeNormal.lots + ')');
assert(nearly(atrSizeNormal.riskAmount, 100), 'calcATRSize risks 1% of $10,000 = $100');
assert(nearly(atrSizeNormal.stopDistance, 2000), 'calcATRSize stopDistance = |100000 - 98000| = 2000');
assert(nearly(atrSizeNormal.lots, 0.05), 'calcATRSize lots = $100 risk / 2000 stop = 0.05');
assert(atrSizeNormal.atrAdjusted === false, 'calcATRSize does not ATR-adjust when atrValue is 0');

const sizeNormal = calcSize({ accountBalance: NORMAL_BALANCE, signal: NORMAL_SIGNAL });
assert(isCleanNumber(sizeNormal.lots), 'calcSize normal returns finite lots (got ' + sizeNormal.lots + ')');
assert(sizeNormal.lots > 0, 'calcSize normal lots are positive (got ' + sizeNormal.lots + ')');
assert(
  sizeNormal.riskPct > 0 && sizeNormal.riskPct <= MAX_SINGLE_TRADE_RISK,
  'calcSize normal riskPct is positive and <= 3% cap (got ' + sizeNormal.riskPct + ')'
);
assert(nearly(sizeNormal.riskPct, 0.0125), 'calcSize applies the 1.25x multiplier at 75% confidence (1% -> 1.25%)');
assert(nearly(sizeNormal.riskAmount, 125), 'calcSize normal riskAmount = 1.25% of $10,000 = $125');
assert(nearly(sizeNormal.lots, 0.0625), 'calcSize normal lots = $125 / 2000 = 0.0625');
assert(
  typeof sizeNormal.reasoning === 'string' && sizeNormal.reasoning.length > 0,
  'calcSize normal returns a non-empty reasoning string'
);

// High confidence gets the 1.5x multiplier, still under the 3% single-trade cap.
const sizeHighConf = calcSize({
  accountBalance: NORMAL_BALANCE,
  signal: Object.assign({}, NORMAL_SIGNAL, { confidence: 92 })
});
assert(nearly(sizeHighConf.riskPct, 0.015), 'calcSize applies the 1.5x multiplier at 92% confidence (1% -> 1.5%)');
assert(
  sizeHighConf.riskPct <= MAX_SINGLE_TRADE_RISK,
  'calcSize high-confidence riskPct still respects the 3% cap (got ' + sizeHighConf.riskPct + ')'
);
assert(sizeHighConf.lots > sizeNormal.lots, 'calcSize scales lots up with confidence');

// Kelly path activates once the sample is >= 10 trades, and is capped at 2x pre-Kelly risk.
const sizeWithKelly = calcSize({
  accountBalance: NORMAL_BALANCE,
  signal: NORMAL_SIGNAL,
  learningStats: { tradeCount: 40, winRate: 0.6, avgWin: 200, avgLoss: 100 }
});
assert(isCleanNumber(sizeWithKelly.lots), 'calcSize with Kelly stats returns finite lots');
assert(
  sizeWithKelly.riskPct <= MAX_SINGLE_TRADE_RISK,
  'calcSize with a hot Kelly edge is still capped at 3% (got ' + sizeWithKelly.riskPct + ')'
);
assert(nearly(sizeWithKelly.riskPct, 0.025), 'calcSize caps Kelly scale-up at 2x pre-Kelly risk (1.25% -> 2.5%)');
assert(
  sizeWithKelly.reasoning.indexOf('Kelly') !== -1,
  'calcSize reasoning mentions Kelly when the trade sample is large enough'
);

// Below the 10-trade minimum the Kelly branch must not run.
const sizeThinSample = calcSize({
  accountBalance: NORMAL_BALANCE,
  signal: NORMAL_SIGNAL,
  learningStats: { tradeCount: 4, winRate: 0.6, avgWin: 200, avgLoss: 100 }
});
assert(
  sizeThinSample.reasoning.indexOf('Kelly') === -1,
  'calcSize skips Kelly below the 10-trade minimum'
);
assert(nearly(sizeThinSample.riskPct, 0.0125), 'calcSize keeps base risk when the trade sample is too thin');

const validNormal = validateTrade(NORMAL_SIGNAL, NORMAL_BALANCE, []);
assert(validNormal.approved === true, 'validateTrade approves a clean 2:1 trade at 75% confidence');
assert(isCleanNumber(validNormal.suggestedSize), 'validateTrade approved suggestedSize is a finite number');
assert(validNormal.suggestedSize > 0, 'validateTrade approved suggestedSize is positive (got ' + validNormal.suggestedSize + ')');
assert(nearly(validNormal.suggestedSize, 0.05), 'validateTrade suggestedSize = 1% of $10,000 / 2000 stop = 0.05');
assert(
  typeof validNormal.reason === 'string' && validNormal.reason.length > 0,
  'validateTrade approved result carries a reason string'
);

const portfolioNormal = calcPortfolioRisk(
  [{ symbol: 'BTC', direction: 'LONG', entry: 100000, stop: 98000, lots: 0.05 }],
  NORMAL_BALANCE
);
assert(isCleanNumber(portfolioNormal.totalRiskPct), 'calcPortfolioRisk returns a finite totalRiskPct');
assert(nearly(portfolioNormal.totalRiskPct, 0.01), 'calcPortfolioRisk: one 0.05-lot BTC position on $10k = 1% risk');
assert(portfolioNormal.safeToAdd === true, 'calcPortfolioRisk allows adding at 1% total risk');
assert(nearly(portfolioNormal.maxNewRisk, 0.05), 'calcPortfolioRisk maxNewRisk = 6% limit - 1% used = 5%');

// Two symbols in the same direction attract the 20% correlation penalty.
const portfolioCorrelated = calcPortfolioRisk(
  [
    { symbol: 'BTC', direction: 'LONG', entry: 100000, stop: 98000, lots: 0.1 },
    { symbol: 'GOLD', direction: 'LONG', entry: 2000, stop: 1980, lots: 10 }
  ],
  NORMAL_BALANCE
);
assert(nearly(portfolioCorrelated.totalRiskPct, 0.048), 'calcPortfolioRisk adds a 20% correlation penalty (4% -> 4.8%)');
assert(portfolioCorrelated.safeToAdd === true, 'calcPortfolioRisk still safe at 4.8% total risk');

// ---------------------------------------------------------------------------
// 2. Edge case: zero account balance
// ---------------------------------------------------------------------------
section('2. Zero account balance');

const atrZeroBalance = calcATRSize(0, 100000, 98000, 0, 0.01);
assert(isCleanNumber(atrZeroBalance.lots), 'calcATRSize zero balance returns finite lots, not NaN (got ' + atrZeroBalance.lots + ')');
assert(atrZeroBalance.lots === 0, 'calcATRSize zero balance returns zero lots');
assert(atrZeroBalance.riskAmount === 0, 'calcATRSize zero balance risks $0');

const sizeZeroBalance = calcSize({ accountBalance: 0, signal: NORMAL_SIGNAL });
assert(sizeZeroBalance.lots === 0, 'calcSize zero balance returns zero lots');
assert(sizeZeroBalance.riskPct === 0, 'calcSize zero balance returns zero riskPct');
assert(sizeZeroBalance.riskAmount === 0, 'calcSize zero balance returns zero riskAmount');
assert(
  sizeZeroBalance.reasoning === 'Missing required inputs',
  'calcSize zero balance reports "Missing required inputs" (got "' + sizeZeroBalance.reasoning + '")'
);
assert(!Number.isNaN(sizeZeroBalance.lots), 'calcSize zero balance does not leak NaN');

const validateZeroBalance = validateTrade(NORMAL_SIGNAL, 0, []);
assert(validateZeroBalance.approved === false, 'validateTrade rejects a zero account balance');
assert(validateZeroBalance.reason === 'Invalid inputs', 'validateTrade zero balance reason is "Invalid inputs"');
assert(validateZeroBalance.suggestedSize === 0, 'validateTrade zero balance suggests size 0');

const portfolioZeroBalance = calcPortfolioRisk(
  [{ symbol: 'BTC', direction: 'LONG', entry: 100000, stop: 98000, lots: 0.05 }],
  0
);
assert(portfolioZeroBalance.totalRiskPct === 0, 'calcPortfolioRisk zero balance returns 0% risk, not Infinity');
assert(isCleanNumber(portfolioZeroBalance.totalRiskPct), 'calcPortfolioRisk zero balance avoids divide-by-zero Infinity');
assert(nearly(portfolioZeroBalance.maxNewRisk, MAX_PORTFOLIO_RISK), 'calcPortfolioRisk zero balance returns the full 6% headroom');

// ---------------------------------------------------------------------------
// 3. Edge case: stop price equal to entry (zero risk per unit)
// ---------------------------------------------------------------------------
section('3. Stop price equal to entry');

const atrZeroStop = calcATRSize(NORMAL_BALANCE, 100000, 100000, 0, 0.01);
assert(atrZeroStop.lots === 0, 'calcATRSize entry == stop returns zero lots, not Infinity');
assert(isCleanNumber(atrZeroStop.lots), 'calcATRSize entry == stop lots stay finite');
assert(atrZeroStop.stopDistance === 0, 'calcATRSize entry == stop reports zero stopDistance');
assert(atrZeroStop.atrAdjusted === false, 'calcATRSize entry == stop with no ATR does not claim an ATR adjustment');

// With a real ATR the too-tight stop is widened to 0.5x ATR instead of dividing by zero.
const atrZeroStopWithAtr = calcATRSize(NORMAL_BALANCE, 100000, 100000, 1500, 0.01);
assert(isCleanNumber(atrZeroStopWithAtr.lots), 'calcATRSize entry == stop with ATR returns finite lots (got ' + atrZeroStopWithAtr.lots + ')');
assert(atrZeroStopWithAtr.atrAdjusted === true, 'calcATRSize widens a zero-width stop using ATR');
assert(nearly(atrZeroStopWithAtr.stopDistance, 750), 'calcATRSize widened stopDistance = 0.5 x 1500 ATR = 750');
assert(nearly(atrZeroStopWithAtr.lots, 100 / 750), 'calcATRSize widened lots = $100 / 750');

const sizeZeroStop = calcSize({
  accountBalance: NORMAL_BALANCE,
  signal: Object.assign({}, NORMAL_SIGNAL, { stop: 100000 })
});
assert(sizeZeroStop.lots === 0, 'calcSize entry == stop returns zero lots');
assert(isCleanNumber(sizeZeroStop.lots), 'calcSize entry == stop does not leak Infinity/NaN into lots');
assert(sizeZeroStop.stopDistance === 0, 'calcSize entry == stop reports zero stopDistance');
assert(isCleanNumber(sizeZeroStop.riskAmount), 'calcSize entry == stop riskAmount stays finite');

const validateZeroStop = validateTrade(
  Object.assign({}, NORMAL_SIGNAL, { stop: 100000 }),
  NORMAL_BALANCE,
  []
);
assert(validateZeroStop.approved === false, 'validateTrade rejects a trade whose stop equals its entry');
assert(
  validateZeroStop.reason === 'Stop distance is zero',
  'validateTrade zero-stop reason is "Stop distance is zero" (got "' + validateZeroStop.reason + '")'
);
assert(validateZeroStop.suggestedSize === 0, 'validateTrade zero-stop suggests size 0');

// Zero-width R:R (target also equal to entry) must not surface NaN either.
const validateAllEqual = validateTrade(
  { symbol: 'BTC', direction: 'LONG', entry: 100000, stop: 100000, target: 100000, confidence: 80 },
  NORMAL_BALANCE,
  []
);
assert(validateAllEqual.approved === false, 'validateTrade rejects entry == stop == target');
assert(isCleanNumber(validateAllEqual.suggestedSize), 'validateTrade entry == stop == target keeps suggestedSize finite');
assert(
  validateAllEqual.reason.indexOf('NaN') === -1 && validateAllEqual.reason.indexOf('Infinity') === -1,
  'validateTrade reason text contains no NaN/Infinity leakage'
);

// calcKelly with a zero-payoff denominator must fall back, not divide by zero.
const kellyZeroLoss = calcKelly(0.6, 200, 0);
assert(isCleanNumber(kellyZeroLoss), 'calcKelly with avgLoss = 0 returns a finite number, not Infinity');
assert(nearly(kellyZeroLoss, DEFAULT_KELLY), 'calcKelly with avgLoss = 0 falls back to the 1% default');

// ---------------------------------------------------------------------------
// 4. Missing required fields
// ---------------------------------------------------------------------------
section('4. Missing required fields');

const missingFieldCases = [
  ['null signal', null, NORMAL_BALANCE, 'Invalid inputs'],
  ['undefined signal', undefined, NORMAL_BALANCE, 'Invalid inputs'],
  ['undefined balance', NORMAL_SIGNAL, undefined, 'Invalid inputs'],
  ['null balance', NORMAL_SIGNAL, null, 'Invalid inputs']
];

for (const [label, signal, balance, expectedReason] of missingFieldCases) {
  const outcome = validateTrade(signal, balance, []);
  assert(outcome.approved === false, 'validateTrade rejects ' + label);
  assert(
    outcome.reason === expectedReason,
    'validateTrade ' + label + ' reason is "' + expectedReason + '" (got "' + outcome.reason + '")'
  );
  assert(outcome.suggestedSize === 0, 'validateTrade ' + label + ' suggests size 0');
}

const missingConfidence = validateTrade(
  { symbol: 'BTC', direction: 'LONG', entry: 100000, stop: 98000, target: 104000 },
  NORMAL_BALANCE,
  []
);
assert(missingConfidence.approved === false, 'validateTrade rejects a signal with no confidence field');
assert(
  missingConfidence.reason.indexOf('Confidence') !== -1,
  'validateTrade flags the missing confidence field by name (got "' + missingConfidence.reason + '")'
);

const nullEntry = validateTrade(
  { symbol: 'BTC', direction: 'LONG', entry: null, stop: 98000, target: 104000, confidence: 80 },
  NORMAL_BALANCE,
  []
);
assert(nullEntry.approved === false, 'validateTrade rejects a null entry');
assert(
  nullEntry.reason === 'Signal missing entry, stop, or target',
  'validateTrade null entry reason names entry/stop/target (got "' + nullEntry.reason + '")'
);

const undefinedStop = validateTrade(
  { symbol: 'BTC', direction: 'LONG', entry: 100000, stop: undefined, target: 104000, confidence: 80 },
  NORMAL_BALANCE,
  []
);
assert(undefinedStop.approved === false, 'validateTrade rejects an undefined stop');
assert(
  undefinedStop.reason === 'Signal missing entry, stop, or target',
  'validateTrade undefined stop reason names entry/stop/target'
);

const missingTarget = validateTrade(
  { symbol: 'BTC', direction: 'LONG', entry: 100000, stop: 98000, confidence: 80 },
  NORMAL_BALANCE,
  []
);
assert(missingTarget.approved === false, 'validateTrade rejects a missing target');
assert(
  missingTarget.reason === 'Signal missing entry, stop, or target',
  'validateTrade missing target reason names entry/stop/target'
);

// calcSize guards the same missing fields with its own reasoning string.
const sizeNoSignal = calcSize({ accountBalance: NORMAL_BALANCE, signal: null });
assert(sizeNoSignal.lots === 0, 'calcSize with a null signal returns zero lots');
assert(sizeNoSignal.reasoning === 'Missing required inputs', 'calcSize null signal reports "Missing required inputs"');

const sizeNoEntry = calcSize({
  accountBalance: NORMAL_BALANCE,
  signal: { stop: 98000, confidence: 80 }
});
assert(sizeNoEntry.lots === 0, 'calcSize with a missing entry returns zero lots');
assert(
  sizeNoEntry.reasoning === 'Signal missing entry, stop, or confidence',
  'calcSize missing entry reasoning names entry/stop/confidence (got "' + sizeNoEntry.reasoning + '")'
);

const sizeNoConfidence = calcSize({
  accountBalance: NORMAL_BALANCE,
  signal: { entry: 100000, stop: 98000 }
});
assert(sizeNoConfidence.lots === 0, 'calcSize with a missing confidence returns zero lots');
assert(
  sizeNoConfidence.reasoning === 'Signal missing entry, stop, or confidence',
  'calcSize missing confidence reasoning names entry/stop/confidence'
);

const sizeEmptyOpts = calcSize({});
assert(sizeEmptyOpts.lots === 0, 'calcSize with an empty options object returns zero lots');
assert(isCleanNumber(sizeEmptyOpts.riskAmount), 'calcSize with an empty options object keeps riskAmount finite');

// ---------------------------------------------------------------------------
// 5. Invalid input types
// ---------------------------------------------------------------------------
section('5. Invalid input types');

const invalidBalanceCases = [
  ['negative balance', -10000],
  ['non-numeric string balance', '10000'],
  ['NaN balance', Number.NaN],
  ['boolean balance', true],
  ['object balance', {}]
];

for (const [label, balance] of invalidBalanceCases) {
  const outcome = validateTrade(NORMAL_SIGNAL, balance, []);
  assert(outcome.approved === false, 'validateTrade rejects a ' + label);
  assert(
    outcome.reason === 'Invalid inputs',
    'validateTrade ' + label + ' reason is "Invalid inputs" (got "' + outcome.reason + '")'
  );
  assert(outcome.suggestedSize === 0, 'validateTrade ' + label + ' suggests size 0');
}

const stringPrices = validateTrade(
  { symbol: 'BTC', direction: 'LONG', entry: '100000', stop: '98000', target: '104000', confidence: 80 },
  NORMAL_BALANCE,
  []
);
assert(stringPrices.approved === false, 'validateTrade rejects numeric-string entry/stop/target');
assert(
  stringPrices.reason === 'Signal missing entry, stop, or target',
  'validateTrade string prices reason names entry/stop/target'
);

const stringConfidence = validateTrade(
  Object.assign({}, NORMAL_SIGNAL, { confidence: '80' }),
  NORMAL_BALANCE,
  []
);
assert(stringConfidence.approved === false, 'validateTrade rejects a non-numeric confidence string');
assert(
  stringConfidence.reason.indexOf('Confidence') !== -1,
  'validateTrade string confidence is flagged as a confidence problem'
);

const negativeConfidence = validateTrade(
  Object.assign({}, NORMAL_SIGNAL, { confidence: -20 }),
  NORMAL_BALANCE,
  []
);
assert(negativeConfidence.approved === false, 'validateTrade rejects a negative confidence');

const lowConfidence = validateTrade(
  Object.assign({}, NORMAL_SIGNAL, { confidence: 50 }),
  NORMAL_BALANCE,
  []
);
assert(lowConfidence.approved === false, 'validateTrade rejects confidence below the 65% floor');
assert(
  lowConfidence.reason.indexOf('65') !== -1,
  'validateTrade sub-threshold reason cites the 65% minimum (got "' + lowConfidence.reason + '")'
);

// Payoff below the 1.5 R:R floor must be rejected even at high confidence.
const poorRR = validateTrade(
  { symbol: 'BTC', direction: 'LONG', entry: 100000, stop: 98000, target: 100500, confidence: 95 },
  NORMAL_BALANCE,
  []
);
assert(poorRR.approved === false, 'validateTrade rejects a 0.25 R:R trade at 95% confidence');
assert(poorRR.reason.indexOf('R:R') !== -1, 'validateTrade poor-payoff reason cites R:R (got "' + poorRR.reason + '")');

// calcKelly: probability outside (0,1) and non-numeric inputs must fall back to the default.
const invalidKellyCases = [
  ['winRate > 1', [1.5, 200, 100]],
  ['winRate == 1', [1, 200, 100]],
  ['winRate < 0', [-0.2, 200, 100]],
  ['winRate == 0', [0, 200, 100]],
  ['non-numeric winRate string', ['0.6', 200, 100]],
  ['non-numeric avgWin string', [0.6, '200', 100]],
  ['negative avgWin', [0.6, -200, 100]],
  ['negative avgLoss', [0.6, 200, -100]],
  ['undefined inputs', [undefined, undefined, undefined]],
  ['null inputs', [null, null, null]]
];

for (const [label, argv] of invalidKellyCases) {
  const kelly = calcKelly(argv[0], argv[1], argv[2]);
  assert(isCleanNumber(kelly), 'calcKelly ' + label + ' returns a finite number (got ' + kelly + ')');
  assert(
    nearly(kelly, DEFAULT_KELLY),
    'calcKelly ' + label + ' falls back to the 1% default (got ' + kelly + ')'
  );
}

// A negative edge must floor at MIN_KELLY, never go negative.
const kellyNegativeEdge = calcKelly(0.3, 100, 100);
assert(kellyNegativeEdge > 0, 'calcKelly with a losing edge never returns a negative fraction (got ' + kellyNegativeEdge + ')');
assert(nearly(kellyNegativeEdge, MIN_KELLY), 'calcKelly with a losing edge floors at the 0.5% minimum');

// calcPortfolioRisk must tolerate malformed position lists.
const malformedPositions = calcPortfolioRisk(
  [
    null,
    undefined,
    { symbol: 'BTC', direction: 'LONG', entry: '100000', stop: 98000, lots: 0.05 },
    { symbol: 'GOLD', direction: 'LONG', entry: 2000, stop: 1980, lots: 'ten' },
    { symbol: 'SPX', direction: 'LONG', entry: 5000, stop: 4950, lots: 1 }
  ],
  NORMAL_BALANCE
);
assert(isCleanNumber(malformedPositions.totalRiskPct), 'calcPortfolioRisk skips malformed positions without producing NaN');
assert(nearly(malformedPositions.totalRiskPct, 0.005), 'calcPortfolioRisk counts only the one well-formed position (0.5%)');
assert(malformedPositions.safeToAdd === true, 'calcPortfolioRisk still safe after skipping malformed positions');

const nonArrayPositions = calcPortfolioRisk('not-an-array', NORMAL_BALANCE);
assert(nonArrayPositions.totalRiskPct === 0, 'calcPortfolioRisk with a non-array positions argument returns 0% risk');
assert(nonArrayPositions.safeToAdd === true, 'calcPortfolioRisk with a non-array positions argument stays safe-to-add');

const nullPositions = calcPortfolioRisk(null, NORMAL_BALANCE);
assert(nullPositions.totalRiskPct === 0, 'calcPortfolioRisk with null positions returns 0% risk');
assert(nearly(nullPositions.maxNewRisk, MAX_PORTFOLIO_RISK), 'calcPortfolioRisk with null positions returns full headroom');

// validateTrade must tolerate a malformed openPositions argument rather than throw.
const badPositionsArg = validateTrade(NORMAL_SIGNAL, NORMAL_BALANCE, 'not-an-array');
assert(badPositionsArg.approved === true, 'validateTrade treats a non-array openPositions as empty and still approves');
assert(isCleanNumber(badPositionsArg.suggestedSize), 'validateTrade non-array openPositions keeps suggestedSize finite');

// calcSize must ignore a malformed learningStats block instead of poisoning riskPct.
const badLearningStats = calcSize({
  accountBalance: NORMAL_BALANCE,
  signal: NORMAL_SIGNAL,
  learningStats: { tradeCount: 'lots', winRate: 'high', avgWin: null, avgLoss: null }
});
assert(isCleanNumber(badLearningStats.riskPct), 'calcSize ignores a malformed learningStats block (riskPct stays finite)');
assert(nearly(badLearningStats.riskPct, 0.0125), 'calcSize keeps base risk when learningStats is malformed');

// A negative ATR must not widen the stop or flip the sizing.
const negativeAtr = calcSize({
  accountBalance: NORMAL_BALANCE,
  signal: NORMAL_SIGNAL,
  atrValue: -500
});
assert(negativeAtr.lots > 0, 'calcSize ignores a negative atrValue and still sizes the trade');
assert(nearly(negativeAtr.stopDistance, 2000), 'calcSize with a negative atrValue keeps the raw 2000 stop distance');

// ---------------------------------------------------------------------------
// 6. Portfolio risk limits (guards the 6% ceiling)
// ---------------------------------------------------------------------------
section('6. Portfolio risk limits');

const overExposed = [{ symbol: 'BTC', direction: 'LONG', entry: 100000, stop: 98000, lots: 0.35 }];
const overExposedRisk = calcPortfolioRisk(overExposed, NORMAL_BALANCE);
assert(nearly(overExposedRisk.totalRiskPct, 0.07), 'calcPortfolioRisk reports 7% risk for a 0.35-lot BTC position on $10k');
assert(overExposedRisk.safeToAdd === false, 'calcPortfolioRisk blocks new trades above the 6% ceiling');
assert(overExposedRisk.maxNewRisk === 0, 'calcPortfolioRisk clamps maxNewRisk to 0 when over the limit');

const rejectedForPortfolio = validateTrade(
  { symbol: 'GOLD', direction: 'SHORT', entry: 2000, stop: 2020, target: 1940, confidence: 90 },
  NORMAL_BALANCE,
  overExposed
);
assert(rejectedForPortfolio.approved === false, 'validateTrade rejects a new trade when portfolio risk is already 7%');
assert(
  rejectedForPortfolio.reason.indexOf('6%') !== -1,
  'validateTrade portfolio rejection cites the 6% limit (got "' + rejectedForPortfolio.reason + '")'
);
assert(rejectedForPortfolio.suggestedSize === 0, 'validateTrade portfolio rejection suggests size 0');

const duplicatePosition = validateTrade(NORMAL_SIGNAL, NORMAL_BALANCE, [
  { symbol: 'BTC', direction: 'LONG', entry: 99000, stop: 97000, lots: 0.05 }
]);
assert(duplicatePosition.approved === false, 'validateTrade rejects a duplicate BTC LONG');
assert(
  duplicatePosition.reason.indexOf('Already holding') !== -1,
  'validateTrade duplicate rejection says "Already holding" (got "' + duplicatePosition.reason + '")'
);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const passed = total - failures;
console.log('\n=====================================');
console.log('sizing.js test summary');
console.log('  total:  ' + total);
console.log('  passed: ' + passed);
console.log('  failed: ' + failures);
console.log('  result: ' + (failures ? 'FAILED' : 'ALL PASSED'));
console.log('=====================================');

process.exit(failures ? 1 : 0);
