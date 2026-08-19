'use strict';

const MIN_KELLY = 0.005;
const MAX_KELLY = 0.05;
const DEFAULT_KELLY = 0.01;
const MIN_TRADES_FOR_KELLY = 10;
const BASE_RISK_PCT = 0.01;
const MAX_SINGLE_TRADE_RISK = 0.03;
const MAX_PORTFOLIO_RISK = 0.06;
const MIN_CONFIDENCE = 65;
const MIN_RR = 1.5;
const CORRELATION_PENALTY = 0.2;

function calcKelly(winRate, avgWin, avgLoss) {
  if (
    typeof winRate !== 'number' || typeof avgWin !== 'number' || typeof avgLoss !== 'number' ||
    winRate <= 0 || winRate >= 1 ||
    avgWin <= 0 || avgLoss <= 0
  ) {
    return DEFAULT_KELLY;
  }

  const ratio = avgWin / avgLoss;
  const kelly = winRate - (1 - winRate) / ratio;
  const halfKelly = kelly / 2;

  if (!isFinite(halfKelly) || isNaN(halfKelly)) {
    return DEFAULT_KELLY;
  }

  return Math.min(MAX_KELLY, Math.max(MIN_KELLY, halfKelly));
}

// What one lot is worth per 1.0 of price movement, in account currency. There is
// deliberately no default: this module has no way to know it, and assuming 1.0 is
// what produced a Gold size 74x too large. Callers pass the broker's own figure
// (tick_value / tick_size, pushed by the bridge), or get no size at all.
function resolveValuePerPoint(valuePerPoint) {
  const value = Number(valuePerPoint);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function calcATRSize(accountBalance, entry, stop, atrValue, riskPct, valuePerPoint) {
  const riskAmount = accountBalance * riskPct;
  let stopDistance = Math.abs(entry - stop);
  let atrAdjusted = false;

  if (atrValue > 0 && stopDistance < atrValue * 0.3) {
    stopDistance = atrValue * 0.5;
    atrAdjusted = true;
  }

  if (stopDistance <= 0) {
    return { lots: 0, stopDistance: 0, riskAmount, atrAdjusted: false };
  }

  const pointValue = resolveValuePerPoint(valuePerPoint);
  if (pointValue === null) {
    return { lots: 0, stopDistance, riskAmount, atrAdjusted, valueUnknown: true };
  }

  // Risk per lot is the stop distance PRICED in account currency, not the raw
  // price distance. XAUUSD moves 100 oz per lot; the account settles in GBP.
  const lots = riskAmount / (stopDistance * pointValue);

  return { lots, stopDistance, riskAmount, atrAdjusted };
}

function calcSize(opts) {
  const { accountBalance, signal, learningStats, atrValue, valuePerPoint } = opts;

  if (!accountBalance || !signal) {
    return { lots: 0, riskPct: 0, riskAmount: 0, reasoning: 'Missing required inputs' };
  }

  const { entry, stop, confidence } = signal;

  if (!entry || !stop || typeof confidence !== 'number') {
    return { lots: 0, riskPct: 0, riskAmount: 0, reasoning: 'Signal missing entry, stop, or confidence' };
  }

  let riskPct = BASE_RISK_PCT;
  const reasoningParts = ['Base risk: 1%'];

  let confidenceMultiplier = 1.0;
  if (confidence >= 90) {
    confidenceMultiplier = 1.5;
    reasoningParts.push('Confidence >= 90: 1.5x multiplier');
  } else if (confidence >= 75) {
    confidenceMultiplier = 1.25;
    reasoningParts.push('Confidence >= 75: 1.25x multiplier');
  } else {
    reasoningParts.push('Confidence >= 65: 1.0x multiplier');
  }

  riskPct *= confidenceMultiplier;

  if (
    learningStats &&
    typeof learningStats.tradeCount === 'number' &&
    learningStats.tradeCount >= MIN_TRADES_FOR_KELLY
  ) {
    const kellyFraction = calcKelly(
      learningStats.winRate,
      learningStats.avgWin,
      learningStats.avgLoss
    );
    // Kelly scales bidirectionally — up when system is hot, down when it's cold.
    // Constrained to 0.5x–2x of the pre-Kelly risk so single trade never blows out.
    const preKellyRisk = riskPct;
    const kellyTarget  = Math.min(Math.max(kellyFraction, preKellyRisk * 0.5), preKellyRisk * 2.0);
    riskPct = kellyTarget;
    const kellyDir = kellyFraction > preKellyRisk ? 'scaled UP' : kellyFraction < preKellyRisk ? 'scaled DOWN' : 'unchanged';
    reasoningParts.push(`Kelly (${learningStats.tradeCount} trades): f=${(kellyFraction * 100).toFixed(2)}% → ${kellyDir} to ${(kellyTarget * 100).toFixed(2)}%`);
  }

  riskPct = Math.min(riskPct, MAX_SINGLE_TRADE_RISK);
  if (riskPct === MAX_SINGLE_TRADE_RISK) {
    reasoningParts.push('Capped at 3% max single trade risk');
  }

  const effectiveAtr = typeof atrValue === 'number' && atrValue > 0 ? atrValue : 0;
  const { lots, stopDistance, riskAmount, atrAdjusted, valueUnknown } = calcATRSize(
    accountBalance,
    entry,
    stop,
    effectiveAtr,
    riskPct,
    valuePerPoint
  );

  if (atrAdjusted) {
    reasoningParts.push('Stop widened to 0.5x ATR (original stop too tight)');
  }

  if (valueUnknown) {
    reasoningParts.push('No valuePerPoint for this symbol — refusing to size');
  }

  return {
    lots,
    riskPct,
    riskAmount,
    stopDistance,
    reasoning: reasoningParts.join(' | ')
  };
}

function calcPortfolioRisk(positions, accountBalance, valuePerPointBySymbol = {}) {
  if (!Array.isArray(positions) || !accountBalance || accountBalance <= 0) {
    return { totalRiskPct: 0, safeToAdd: true, maxNewRisk: MAX_PORTFOLIO_RISK, unpriced: 0 };
  }

  const directionMap = {};
  let totalRisk = 0;
  let unpriced = 0;

  for (const pos of positions) {
    if (!pos || typeof pos.entry !== 'number' || typeof pos.stop !== 'number' || typeof pos.lots !== 'number') {
      continue;
    }

    // Exposure has to be priced in account currency, exactly as the sizing does.
    // Multiplying raw price distance by lots under-counted an open Gold position
    // by ~74x, so the portfolio cap was measuring something that was not money.
    const pointValue = resolveValuePerPoint(
      pos.valuePerPoint !== undefined ? pos.valuePerPoint : valuePerPointBySymbol[pos.symbol]
    );
    if (pointValue === null) {
      unpriced += 1;
      continue;
    }

    const posRisk = Math.abs(pos.entry - pos.stop) * pos.lots * pointValue;
    totalRisk += posRisk;

    if (pos.symbol && pos.direction) {
      const key = pos.direction;
      if (!directionMap[key]) {
        directionMap[key] = new Set();
      }
      directionMap[key].add(pos.symbol);
    }
  }

  let correlationPenalty = 0;
  for (const direction of Object.keys(directionMap)) {
    if (directionMap[direction].size > 1) {
      correlationPenalty += totalRisk * CORRELATION_PENALTY;
      break;
    }
  }

  const adjustedRisk = totalRisk + correlationPenalty;
  const totalRiskPct = adjustedRisk / accountBalance;
  const maxNewRisk = Math.max(0, MAX_PORTFOLIO_RISK - totalRiskPct);
  const safeToAdd = totalRiskPct < MAX_PORTFOLIO_RISK;

  return { totalRiskPct, safeToAdd, maxNewRisk, unpriced };
}

// options.minConfidence — the live confidenceThreshold, passed in by the caller.
//
// This used to be the hardcoded MIN_CONFIDENCE (65) and nothing else, which made it
// a second, invisible copy of the confidence gate that no amount of configuration
// could move. The bridge calls /api/size before every trade and fails closed on
// rejection, so the EFFECTIVE live gate was max(confidenceThreshold, 65) no matter
// what the dashboard said. Measured 2026-08-03: with confidenceThreshold set to 50,
// signals at 52 and 60 were approved by the engine and then rejected here with
// "Confidence 52% below minimum 65%" — so lowering the gate below 65 did nothing at
// all, while the one band it did newly admit (65-69) is the only negative one in the
// table at PF 0.91.
//
// MIN_CONFIDENCE stays as the default so the module's existing tests and any caller
// that does not supply a threshold behave exactly as before.
function validateTrade(signal, accountBalance, openPositions, options = {}) {
  if (!signal || !Number.isFinite(accountBalance) || accountBalance <= 0) {
    return { approved: false, reason: 'Invalid inputs', suggestedSize: 0 };
  }

  const suppliedMin = Number(options.minConfidence);
  const minConfidence = Number.isFinite(suppliedMin) && suppliedMin >= 0
    ? suppliedMin
    : MIN_CONFIDENCE;

  // No `direction` here on purpose: the duplicate guard below matches on symbol
  // alone, so the incoming signal's direction no longer decides anything.
  const { entry, stop, target, confidence, symbol } = signal;

  if (typeof confidence !== 'number' || confidence < minConfidence) {
    return {
      approved: false,
      reason: `Confidence ${confidence}% below minimum ${minConfidence}%`,
      suggestedSize: 0
    };
  }

  if (typeof entry !== 'number' || typeof stop !== 'number' || typeof target !== 'number') {
    return { approved: false, reason: 'Signal missing entry, stop, or target', suggestedSize: 0 };
  }

  const stopDistance = Math.abs(entry - stop);
  const rewardDistance = Math.abs(target - entry);

  if (stopDistance <= 0) {
    return { approved: false, reason: 'Stop distance is zero', suggestedSize: 0 };
  }

  const rr = rewardDistance / stopDistance;
  if (rr < MIN_RR) {
    return {
      approved: false,
      reason: `R:R ${rr.toFixed(2)} below minimum ${MIN_RR}`,
      suggestedSize: 0
    };
  }

  const positions = Array.isArray(openPositions) ? openPositions : [];

  // Matches on SYMBOL ALONE. It used to require symbol AND direction, which meant an
  // opposite-direction entry passed every gate: on 2026-08-08 account A was found
  // holding XAUUSD BUY #1713655080 @4241.74 (opened 08-05) and XAUUSD SELL
  // #1726672007 @4296.78 (opened 08-07) at the same time. The MT5 accounts are in
  // HEDGING mode, so the platform is happy to carry both sides and nothing
  // downstream objects — this check is the only thing that could have stopped it.
  //
  // The cost is not the doubled spread on 0.01 lots. It is that one market state
  // then writes two opposing outcomes into the learning tables under two different
  // setup names, and the journal has three entries in its whole life. That is a
  // permanently corrupted per-setup win rate.
  //
  // The reason string MUST keep starting with "Already holding":
  // mt5_bridge.py:437 (RISK_ENGINE_DUPLICATE_PREFIX) matches that literal prefix to
  // decide whether to write a DUPLICATE row to the rejection ledger. Reword it and
  // the gate silently stops being recorded.
  //
  // If a deliberate reversal is ever wanted, it belongs here as an explicit
  // close-then-open, not as a second position that happens to face the other way.
  if (symbol) {
    const held = positions.find(p => p && p.symbol === symbol);
    if (held) {
      // Never interpolate a missing direction — "Already holding XAUUSD undefined"
      // is what the operator would have to debug from.
      const heldDirection = typeof held.direction === 'string' && held.direction
        ? held.direction
        : 'UNKNOWN';
      return {
        approved: false,
        reason: `Already holding ${symbol} ${heldDirection}`,
        suggestedSize: 0
      };
    }
  }

  const { totalRiskPct, safeToAdd, maxNewRisk, unpriced } = calcPortfolioRisk(
    positions, accountBalance, options.valuePerPointBySymbol || {}
  );

  if (!safeToAdd) {
    return {
      approved: false,
      reason: `Portfolio risk at ${(totalRiskPct * 100).toFixed(2)}% — at or above 6% limit`,
      suggestedSize: 0
    };
  }

  const suggestedRiskPct = Math.min(BASE_RISK_PCT, maxNewRisk);
  const suggestedRiskAmount = accountBalance * suggestedRiskPct;

  const projectedTotalRisk = totalRiskPct + (suggestedRiskAmount / accountBalance);
  if (projectedTotalRisk > MAX_PORTFOLIO_RISK) {
    return {
      approved: false,
      reason: `Adding trade would push portfolio risk to ${(projectedTotalRisk * 100).toFixed(2)}% — exceeds 6% limit`,
      suggestedSize: 0
    };
  }

  // A wrong lot size is worse than no lot size, so this returns 0 rather than a
  // guess when the symbol's value per point is unknown. The approve/reject gate
  // above is unchanged either way — refusing to size must not refuse the trade.
  const pointValue = resolveValuePerPoint(
    options.valuePerPoint !== undefined
      ? options.valuePerPoint
      : (options.valuePerPointBySymbol || {})[symbol]
  );
  const suggestedSize = pointValue === null
    ? 0
    : suggestedRiskAmount / (stopDistance * pointValue);

  const notes = [`R:R ${rr.toFixed(2)}`, `portfolio risk ${(totalRiskPct * 100).toFixed(2)}%`];
  if (pointValue === null) {
    notes.push(`no valuePerPoint for ${symbol || 'symbol'} — size not calculated`);
  }
  if (unpriced) {
    notes.push(`${unpriced} open position(s) unpriced, portfolio risk understated`);
  }

  return {
    approved: true,
    reason: `All checks passed — ${notes.join(', ')}`,
    suggestedSize
  };
}

module.exports = { calcKelly, calcATRSize, calcSize, calcPortfolioRisk, validateTrade };
