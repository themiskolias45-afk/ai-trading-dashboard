/**
 * Ad-hoc cross-tab over a parallel_analysis fact pack.
 *
 * The fact pack precomputes single-axis buckets (byRegime, byAdx, ...) and the
 * setup|regime pair, but a rule of the form "setup X must not fire when Y" has
 * to be checked against the OTHER axes too, or it just renames a condition that
 * was really about adx, asset or direction. This slices facts.trades on any
 * combination of fields using the exact summarise() arithmetic from
 * tasks/evaluate_change.py, so every number here is comparable to the fact pack.
 *
 * Usage: node tasks/_regime_xtab.cjs <facts.json> <field[,field...]> [filterExpr]
 *   node tasks/_regime_xtab.cjs facts.json setup,regime
 *   node tasks/_regime_xtab.cjs facts.json adxBand "setup==='RANGE_TRADE_LONG'"
 */

const COST_R = 0.05;           // must match evaluate_change.COST_R
const MIN_SAMPLE = 5;          // must match parallel_analysis.MIN_SAMPLE

function summarise(trades) {
  const wins = trades.filter((t) => t.outcome === 'WIN');
  const losses = trades.filter((t) => t.outcome === 'LOSS');
  const closed = wins.length + losses.length;
  if (closed === 0) return { n: trades.length, wr: 0, pf: 0, R: 0, rpt: 0, closed: 0, wins: 0, losses: 0 };
  const grossWin = wins.reduce((sum, t) => sum + (t.rr - COST_R), 0);
  const grossLoss = losses.length * (1 + COST_R);
  const total = grossWin - grossLoss;
  return {
    n: trades.length,
    closed,
    wins: wins.length,
    losses: losses.length,
    wr: (wins.length / closed) * 100,
    pf: grossLoss ? grossWin / grossLoss : Infinity,
    R: total,
    rpt: total / closed,
  };
}

// Same edges as parallel_analysis.py, so a band here means the same band there.
const ADX_EDGES = [[20, 'adx<20'], [30, 'adx20-30'], [Infinity, 'adx>=30']];
const RSI_EDGES = [[35, 'rsi<35'], [50, 'rsi35-50'], [65, 'rsi50-65'], [Infinity, 'rsi>=65']];
const VOL_EDGES = [[0.8, 'vol<0.8x'], [1.5, 'vol0.8-1.5x'], [Infinity, 'vol>=1.5x']];

function band(value, edges) {
  if (value === null || value === undefined) return null;
  for (const [upper, label] of edges) if (value < upper) return label;
  return edges[edges.length - 1][1];
}

function enrich(trade) {
  return {
    ...trade,
    adxBand: band(trade.adx, ADX_EDGES),
    rsiBand: band(trade.rsi, RSI_EDGES),
    volBand: band(trade.volRatio, VOL_EDGES),
    year: new Date(trade.t * 1000).getUTCFullYear(),
  };
}

function main() {
  const [factsPath, fieldSpec, filterExpr] = process.argv.slice(2);
  if (!factsPath || !fieldSpec) {
    console.error('usage: node tasks/_regime_xtab.cjs <facts.json> <field[,field]> [filterExpr]');
    process.exit(2);
  }

  const facts = require(require('path').resolve(factsPath));
  let rows = facts.trades.map(enrich);

  if (filterExpr) {
    // eslint-disable-next-line no-new-func
    const predicate = new Function('t', `with (t) { return (${filterExpr}); }`);
    rows = rows.filter((t) => {
      try { return predicate(t); } catch (err) { return false; }
    });
  }

  const fields = fieldSpec.split(',').map((f) => f.trim());
  const groups = new Map();
  for (const trade of rows) {
    if (fields.some((f) => trade[f] === null || trade[f] === undefined)) continue;
    const key = fields.map((f) => trade[f]).join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(trade);
  }

  const out = [...groups.entries()]
    .map(([key, trades]) => ({ key, ...summarise(trades) }))
    .sort((a, b) => b.rpt - a.rpt);

  const width = Math.max(fieldSpec.length, ...out.map((r) => r.key.length)) + 2;
  console.log(
    fieldSpec.padEnd(width) + 'n'.padStart(6) + 'clsd'.padStart(6) + 'W'.padStart(5) +
    'L'.padStart(5) + 'WR%'.padStart(7) + 'PF'.padStart(7) + 'totR'.padStart(9) +
    'expR'.padStart(8) + '  flag');
  for (const r of out) {
    console.log(
      r.key.padEnd(width) + String(r.n).padStart(6) + String(r.closed).padStart(6) +
      String(r.wins).padStart(5) + String(r.losses).padStart(5) +
      r.wr.toFixed(1).padStart(7) + (Number.isFinite(r.pf) ? r.pf.toFixed(2) : 'inf').padStart(7) +
      r.R.toFixed(2).padStart(9) + r.rpt.toFixed(3).padStart(8) +
      (r.closed < MIN_SAMPLE ? '  LOW-SAMPLE' : ''));
  }

  const totals = summarise(rows);
  console.log('-'.repeat(width + 53));
  console.log('TOTAL'.padEnd(width) + String(totals.n).padStart(6) + String(totals.closed).padStart(6) +
    String(totals.wins).padStart(5) + String(totals.losses).padStart(5) +
    totals.wr.toFixed(1).padStart(7) + (Number.isFinite(totals.pf) ? totals.pf.toFixed(2) : 'inf').padStart(7) +
    totals.R.toFixed(2).padStart(9) + totals.rpt.toFixed(3).padStart(8));
}

main();
