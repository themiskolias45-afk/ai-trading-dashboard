#!/usr/bin/env node
'use strict';
/* ============================================================================
   sizing_cap_audit.cjs — how much of the intended risk budget actually reached
   the order, and what truncated the rest.
   ============================================================================

   WHY THIS EXISTS.

   mt5_bridge.py:get_lot_size already logs every truncation it performs:

       [10:45:49] [A] Lot size capped: 42.06 -> 2.00 (maxLotSize)
       [10:45:49] [A] Sizing from risk-engine budget $142.70 -> 2.0 lots
       [10:45:49] [A] ORDER PLACED: BUY 2.0 lot SP500 @ 7705.13 SL:7700.68 ...

   Measured 2026-09-10: NOTHING IN THE REPO READS THOSE LINES. `grep -rl
   "Lot size capped"` returns mt5_bridge.py and nothing else. The bridge has been
   writing an exact record of every truncated order into a file no reader opens,
   which is the same shape as a setting with no reader: the control works, the
   evidence is produced, and no decision is ever informed by it.

   WHAT IT MEASURES, AND WHY IT NEEDS NO CONTRACT SPECS.

   The two log lines together pin the instrument's value per lot exactly, with no
   hardcoded tick_value, contract_size or point value anywhere in this file:

       wantedLots = budget / valuePerLot     (mt5_bridge.py:1290)
   =>  valuePerLot = budget / wantedLots

   That is the dollar cost of the FULL stop distance for one lot, for this order,
   from this broker. Multiply by the lots actually sent and you have the money
   really at risk. Hardcoding a point value here would be inventing the number the
   log already states, and would be wrong the first time a broker changed a spec.

   WHAT IT IS NOT.

   READ-ONLY, AND DELIBERATELY OFF EVERY LIVE PATH. It opens no MT5 client, makes
   no HTTP call, and writes exactly one file: the report named below. It does not
   read or write strategy settings, the gate, learning.json, the journal, the
   shadow ledger or the rejection ledger. It cannot suppress a setup, cannot move
   a confidence value and cannot drop a learning row, because it never touches
   anything on those paths. Running it while the book is open is safe.

   IT PROPOSES NOTHING. A truncation is not automatically a fault: the wide-stop
   SP500 order on 2026-09-08 was capped by 1.09x, which is the cap doing exactly
   its job. Raising maxLotSize on the strength of this report would be wrong —
   see the gold leverage measurement in mt5_bridge.py:1320-1326, where one lot of
   gold is 57x one lot of SP500 and no single lot number is right for both.
   ============================================================================ */

const fs   = require('fs');
const path = require('path');

const REPO_ROOT   = path.resolve(__dirname, '..');
const LOG_DIR     = path.join(REPO_ROOT, 'tasks', 'logs');
const REPORT_PATH = path.join(LOG_DIR, 'sizing_cap_audit.txt');
const JSON_PATH   = path.join(LOG_DIR, 'sizing_cap_audit.json');

// How far back from an ORDER PLACED line the sizing lines for that same order can
// sit. Measured on real logs the span is 1-4 lines (AUTO-MODE, optional entry-drift
// note, optional cap lines, budget line, ORDER PLACED). 30 is generous and is
// bounded by the AUTO-MODE / previous-ORDER sentinels below regardless.
const MAX_LOOKBACK_LINES = 30;

// A truncation smaller than this is the cap grazing a legitimately-sized order
// rather than dominating it. 1.09x happened on a real 88-point-stop SP500 fill.
const MATERIAL_TRUNCATION = 1.5;

// Below this share of the intended budget the R record and the money record have
// stopped describing the same trade.
const RISK_SHORTFALL_ALERT = 0.5;

const RE_ORDER   = /ORDER PLACED:\s+(BUY|SELL)\s+([\d.]+)\s+lot\s+(\S+)\s+@\s+([\d.]+)\s+SL:([\d.]+)(?:\s+TP:([\d.]+))?/;
const RE_BUDGET  = /Sizing from risk-engine budget\s+\$([\d,.]+)\s*(?:->|→)\s*([\d.]+)\s+lots/;
const RE_CAP_MAX = /Lot size capped:\s+([\d.]+)\s*(?:->|→)\s*([\d.]+)\s+\(maxLotSize\)/;
const RE_CAP_NOT = /Lot size capped:\s+([\d.]+)\s*(?:->|→)\s*([\d.]+)\s+lots\s+\((\S+)\s+exposure/;
const RE_AUTO    = /AUTO-MODE: executing/;
const RE_TIME    = /^\[(\d{2}:\d{2}:\d{2})\]/;

function readLinesOrEmpty(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`cannot read ${filePath}: ${err.message}`);
  }
}

function toNumber(raw) {
  const cleaned = String(raw).replace(/,/g, '');
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) ? value : null;
}

/* Collect the sizing lines belonging to ONE order.

   Walks backward from the ORDER PLACED line, stopping at the AUTO-MODE marker
   that opens the block or at the previous ORDER PLACED. The stop condition is
   what keeps the DISPLAY copy of the cap line — the bridge logs the same cap
   twice per setup, once for the panel at its own fallback risk percent and once
   for the order actually being sent — from being attributed to this order. */
function collectOrderBlock(lines, orderIndex) {
  const block = { capMax: null, capNotional: null, budget: null };
  const floor = Math.max(0, orderIndex - MAX_LOOKBACK_LINES);

  for (let i = orderIndex - 1; i >= floor; i -= 1) {
    const line = lines[i];
    if (RE_ORDER.test(line)) break;

    const budgetMatch = line.match(RE_BUDGET);
    if (budgetMatch && !block.budget) {
      block.budget = { dollars: toNumber(budgetMatch[1]), lots: toNumber(budgetMatch[2]) };
    }

    const capMaxMatch = line.match(RE_CAP_MAX);
    if (capMaxMatch && !block.capMax) {
      block.capMax = { wanted: toNumber(capMaxMatch[1]), got: toNumber(capMaxMatch[2]) };
    }

    const capNotMatch = line.match(RE_CAP_NOT);
    if (capNotMatch && !block.capNotional) {
      block.capNotional = { wanted: toNumber(capNotMatch[1]), got: toNumber(capNotMatch[2]) };
    }

    if (RE_AUTO.test(line)) break;
  }
  return block;
}

/* The dollar cost of the full stop distance for ONE lot, taken from the bridge's
   own arithmetic rather than from any spec table. Returns null when the log did
   not state enough to pin it, which is reported as unknown rather than guessed. */
function deriveValuePerLot(block) {
  if (block.capMax && block.budget && block.capMax.wanted > 0) {
    return { value: block.budget.dollars / block.capMax.wanted, basis: 'cap line + budget (exact)' };
  }
  if (block.capNotional && block.budget && block.capNotional.wanted > 0) {
    return { value: block.budget.dollars / block.capNotional.wanted, basis: 'notional cap + budget (exact)' };
  }
  if (block.budget && block.budget.lots > 0) {
    return { value: block.budget.dollars / block.budget.lots, basis: 'budget / sent lots (rounded to lot step)' };
  }
  return { value: null, basis: 'no risk-engine budget logged' };
}

function parseLog(filePath, accountTag) {
  const lines = readLinesOrEmpty(filePath);
  if (lines === null) return { missing: true, orders: [] };

  const orders = [];
  for (let i = 0; i < lines.length; i += 1) {
    const orderMatch = lines[i].match(RE_ORDER);
    if (!orderMatch) continue;

    const [, direction, lotsRaw, symbol, entryRaw, stopRaw] = orderMatch;
    const lots  = toNumber(lotsRaw);
    const entry = toNumber(entryRaw);
    const stop  = toNumber(stopRaw);
    if (lots === null || entry === null || stop === null) continue;

    const block        = collectOrderBlock(lines, i);
    const valuePerLot  = deriveValuePerLot(block);
    const stopDistance = Math.abs(entry - stop);
    const timeMatch    = lines[i].match(RE_TIME);

    const budgetDollars = block.budget ? block.budget.dollars : null;
    const realisedRisk  = valuePerLot.value === null ? null : lots * valuePerLot.value;

    // WHEN valuePerLot CAME FROM budget/lots, riskFraction IS NOT A MEASUREMENT.
    // realisedRisk = lots x (budget / lots) = budget, so the ratio is 1.0 by
    // construction and would print as a confident "100.0%" having tested nothing.
    // Only a cap line supplies an INDEPENDENT wantedLots, and only then does the
    // comparison carry information. Anything else is reported as unmeasurable.
    const riskIsIndependent = valuePerLot.basis.includes('exact');
    const riskFraction = (realisedRisk === null || !budgetDollars || !riskIsIndependent)
      ? null
      : realisedRisk / budgetDollars;

    let wantedLots = null;
    let truncatedBy = null;
    if (block.capMax)           wantedLots = block.capMax.wanted;
    else if (block.capNotional) wantedLots = block.capNotional.wanted;
    if (wantedLots !== null && lots > 0) truncatedBy = wantedLots / lots;

    orders.push({
      account: accountTag,
      logLine: i + 1,
      time: timeMatch ? timeMatch[1] : null,
      symbol,
      direction,
      entry,
      stop,
      stopDistance,
      lotsSent: lots,
      lotsWanted: wantedLots,
      truncatedBy,
      cappedBy: block.capMax ? 'maxLotSize' : (block.capNotional ? 'maxNotionalPct' : null),
      budgetDollars,
      valuePerLot: valuePerLot.value,
      valuePerLotBasis: valuePerLot.basis,
      realisedRisk,
      riskFraction,
    });
  }
  return { missing: false, orders };
}

function fmt(value, decimals) {
  return value === null || value === undefined ? '     —' : value.toFixed(decimals);
}

function buildReport(orders, sources) {
  const out = [];
  const rule = '='.repeat(100);
  out.push(rule);
  out.push('  SIZING CAP AUDIT — how much of the intended risk budget reached the order');
  out.push(`  generated ${new Date().toISOString()}`);
  out.push('  READ-ONLY. No config, gate, journal or learning file is read or written.');
  out.push(rule);
  out.push('');

  for (const source of sources) {
    out.push(`  source: ${source.label} — ${source.missing ? 'NOT PRESENT (skipped)' : `${source.count} order(s)`}`);
  }
  out.push('');

  if (orders.length === 0) {
    out.push('  No ORDER PLACED lines found. Nothing to audit — this is not a failure.');
    out.push(rule);
    return out.join('\n');
  }

  out.push('  Per order. "wanted" is what risk-based sizing asked for, "sent" is what went to');
  out.push('  the broker, and "risk%" is the share of the intended budget actually at risk.');
  out.push('');
  out.push('  risk% IS BLANK UNLESS A CAP LINE WAS LOGGED, AND THAT IS THE HONEST ANSWER.');
  out.push('  Without a cap line the only way to price a lot is budget/lots, which makes');
  out.push('  risk% exactly 1.0 by construction — a tautology, not a check. Those rows are');
  out.push('  not evidence that the order was correctly sized; they are rows where the log');
  out.push('  does not say. An uncapped order is EXPECTED to sit at budget, but this tool');
  out.push('  cannot confirm it and does not pretend to.');
  out.push('');
  out.push('   acct time      symbol    stopDist   wanted     sent   trunc   budget$   atRisk$   risk%  capped by');
  out.push('   ' + '-'.repeat(96));

  for (const o of orders) {
    const riskPct = o.riskFraction === null ? '    —' : `${(o.riskFraction * 100).toFixed(1)}%`;
    out.push(
      `   ${o.account.padEnd(4)} ${(o.time || '--:--:--').padEnd(9)} ${o.symbol.padEnd(9)} ` +
      `${fmt(o.stopDistance, 2).padStart(8)} ${fmt(o.lotsWanted, 2).padStart(8)} ${fmt(o.lotsSent, 2).padStart(8)} ` +
      `${o.truncatedBy === null ? '     —' : (o.truncatedBy.toFixed(1) + 'x').padStart(6)} ` +
      // atRisk$ is suppressed on the same condition as risk%: without a cap line it is
      // lots x (budget/lots), i.e. the budget echoed back in a column that looks like an
      // independent computation. Two tautologies dressed as two measurements is worse
      // than one, because the pair corroborate each other.
      `${fmt(o.budgetDollars, 2).padStart(9)} ${fmt(o.riskFraction === null ? null : o.realisedRisk, 2).padStart(9)} ${riskPct.padStart(7)}  ${o.cappedBy || '—'}`
    );
  }
  out.push('');

  const truncated = orders.filter((o) => o.truncatedBy !== null && o.truncatedBy >= MATERIAL_TRUNCATION);
  const shortfall = orders.filter((o) => o.riskFraction !== null && o.riskFraction < RISK_SHORTFALL_ALERT);

  out.push(rule);
  out.push('  FINDINGS');
  out.push(rule);

  if (truncated.length === 0) {
    out.push(`  No order was truncated by ${MATERIAL_TRUNCATION}x or more. The caps are not binding.`);
  } else {
    out.push(`  ${truncated.length} of ${orders.length} order(s) truncated by >= ${MATERIAL_TRUNCATION}x:`);
    const bySymbol = new Map();
    for (const o of truncated) {
      if (!bySymbol.has(o.symbol)) bySymbol.set(o.symbol, []);
      bySymbol.get(o.symbol).push(o);
    }
    for (const [symbol, rows] of bySymbol) {
      const worst = Math.max(...rows.map((r) => r.truncatedBy));
      const causes = [...new Set(rows.map((r) => r.cappedBy))].join(', ');
      out.push(`    ${symbol.padEnd(9)} ${String(rows.length).padStart(2)} order(s), worst ${worst.toFixed(1)}x, by ${causes}`);
    }
  }
  out.push('');

  if (shortfall.length > 0) {
    out.push(`  ${shortfall.length} order(s) carried under ${(RISK_SHORTFALL_ALERT * 100).toFixed(0)}% of the intended budget.`);
    out.push('  On those, R and money are no longer describing the same trade: an R-denominated');
    out.push('  result cannot be compared against one sized nearer to budget.');
    for (const o of shortfall) {
      out.push(`    ${o.symbol.padEnd(9)} ${o.time || ''} stop ${o.stopDistance.toFixed(2)} — ` +
               `$${o.realisedRisk.toFixed(2)} at risk against a $${o.budgetDollars.toFixed(2)} budget ` +
               `(${(o.riskFraction * 100).toFixed(1)}%)`);
    }
    out.push('');
    out.push('  NOTE THE DIRECTION OF THE INTERACTION: the cap bites HARDEST when the stop is');
    out.push('  TIGHTEST, because lots = budget / (stopDistance x pointValue). So a degenerate');
    out.push('  stop does not merely risk being swept — it also shrinks the position far below');
    out.push('  the intended risk. Fixing either one alone changes the effect of the other.');
  }

  out.push('');
  out.push(rule);
  out.push('  THIS REPORT PROPOSES NOTHING. It does not recommend raising maxLotSize: one lot');
  out.push('  of gold is ~57x one lot of SP500, so no single lot number is right for both, and');
  out.push('  the cap exists because maxLotSize 10 was 49x leverage on gold. Any change to a');
  out.push('  cap or to stop logic must be replayed first and the firing set compared before');
  out.push('  and after via /api/signals.');
  out.push(rule);
  return out.join('\n');
}

function main() {
  const sources = [];
  const allOrders = [];

  for (const tag of ['A', 'B']) {
    const filePath = path.join(LOG_DIR, `bridge_log_${tag}.txt`);
    const parsed = parseLog(filePath, tag);
    sources.push({ label: `bridge_log_${tag}.txt`, missing: parsed.missing, count: parsed.orders.length });
    allOrders.push(...parsed.orders);
  }

  allOrders.sort((a, b) => (a.account === b.account ? a.logLine - b.logLine : a.account.localeCompare(b.account)));

  const report = buildReport(allOrders, sources);
  fs.writeFileSync(REPORT_PATH, report + '\n', 'utf8');
  fs.writeFileSync(JSON_PATH, JSON.stringify({
    generatedAt: new Date().toISOString(),
    readOnly: true,
    sources,
    materialTruncation: MATERIAL_TRUNCATION,
    riskShortfallAlert: RISK_SHORTFALL_ALERT,
    orders: allOrders,
  }, null, 2) + '\n', 'utf8');

  process.stdout.write(report + '\n');
  process.stdout.write(`\nreport: ${REPORT_PATH}\njson:   ${JSON_PATH}\n`);
}

try {
  main();
} catch (err) {
  process.stderr.write(`sizing_cap_audit failed: ${err.message}\n`);
  process.exit(1);
}
