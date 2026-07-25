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

function calcATRSize(accountBalance, entry, stop, atrValue, riskPct) {
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

  const lots = riskAmount / stopDistance;

  return { lots, stopDistance, riskAmount, atrAdjusted };
}

function calcSize(opts) {
  const { accountBalance, signal, learningStats, atrValue } = opts;

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
  const { lots, stopDistance, riskAmount, atrAdjusted } = calcATRSize(
    accountBalance,
    entry,
    stop,
    effectiveAtr,
    riskPct
  );

  if (atrAdjusted) {
    reasoningParts.push('Stop widened to 0.5x ATR (original stop too tight)');
  }

  return {
    lots,
    riskPct,
    riskAmount,
    stopDistance,
    reasoning: reasoningParts.join(' | ')
  };
}

function calcPortfolioRisk(positions, accountBalance) {
  if (!Array.isArray(positions) || !accountBalance || accountBalance <= 0) {
    return { totalRiskPct: 0, safeToAdd: true, maxNewRisk: MAX_PORTFOLIO_RISK };
  }

  const directionMap = {};
  let totalRisk = 0;

  for (const pos of positions) {
    if (!pos || typeof pos.entry !== 'number' || typeof pos.stop !== 'number' || typeof pos.lots !== 'number') {
      continue;
    }

    const posRisk = Math.abs(pos.entry - pos.stop) * pos.lots;
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

  return { totalRiskPct, safeToAdd, maxNewRisk };
}

function validateTrade(signal, accountBalance, openPositions) {
  if (!signal || !Number.isFinite(accountBalance) || accountBalance <= 0) {
    return { approved: false, reason: 'Invalid inputs', suggestedSize: 0 };
  }

  const { entry, stop, target, confidence, symbol, direction } = signal;

  if (typeof confidence !== 'number' || confidence < MIN_CONFIDENCE) {
    return {
      approved: false,
      reason: `Confidence ${confidence}% below minimum ${MIN_CONFIDENCE}%`,
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

  if (symbol && direction) {
    const duplicate = positions.find(
      p => p && p.symbol === symbol && p.direction === direction
    );
    if (duplicate) {
      return {
        approved: false,
        reason: `Already holding ${symbol} ${direction}`,
        suggestedSize: 0
      };
    }
  }

  const { totalRiskPct, safeToAdd, maxNewRisk } = calcPortfolioRisk(positions, accountBalance);

  if (!safeToAdd) {
    return {
      approved: false,
      reason: `Portfolio risk at ${(totalRiskPct * 100).toFixed(2)}% — at or above 6% limit`,
      suggestedSize: 0
    };
  }

  const suggestedRiskPct = Math.min(BASE_RISK_PCT, maxNewRisk);
  const suggestedRiskAmount = accountBalance * suggestedRiskPct;
  const suggestedSize = stopDistance > 0 ? suggestedRiskAmount / stopDistance : 0;

  const projectedTotalRisk = totalRiskPct + (suggestedRiskAmount / accountBalance);
  if (projectedTotalRisk > MAX_PORTFOLIO_RISK) {
    return {
      approved: false,
      reason: `Adding trade would push portfolio risk to ${(projectedTotalRisk * 100).toFixed(2)}% — exceeds 6% limit`,
      suggestedSize: 0
    };
  }

  return {
    approved: true,
    reason: `All checks passed — R:R ${rr.toFixed(2)}, portfolio risk ${(totalRiskPct * 100).toFixed(2)}%`,
    suggestedSize
  };
}

module.exports = { calcKelly, calcATRSize, calcSize, calcPortfolioRisk, validateTrade };
