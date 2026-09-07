'use strict';
/**
 * The FOURTH-ASSET screen: which candidate instruments are actually independent of
 * BTCUSD, XAUUSD and SP500?
 *
 *   node tasks/instrument_correlation_screen.cjs
 *   node tasks/instrument_correlation_screen.cjs --max-r 0.5 --json
 *
 * WHY THIS EXISTS. Sample size is the binding constraint on this system: 9 closed fills
 * and the confidence gate correctly declining a market where nothing qualifies. The one
 * lever that adds samples WITHOUT loosening a gate that is provably paying for itself
 * (43 resolved CONFIDENCE rejections, netR -13.646) is another instrument — more
 * independent chances per day against the same bars.
 *
 * "Independent" is the whole point and it is why NAS100 was rejected: it correlated
 * 0.951 with SP500, which is the same trade twice, double the risk, and no new sample.
 * tasks/instrument_universe_scan.cjs ranks candidates by EDGE and computes no
 * correlation at all, so this is the missing half.
 *
 * BROKER BARS, NEVER YAHOO. server/assets.js:30-33 records why: the Yahoo daily series
 * has a different session, which hands every trade ~3.7x longer to reach target and
 * moves the EXPIRED share by 16.3 points. A correlation computed on the wrong session
 * would be a fact about Yahoo, not about what this broker would fill.
 *
 * LOG RETURNS, NOT PRICES. Two rising price series correlate near 1.0 whatever they are
 * — that measures "both went up over five years", not co-movement. Correlating daily
 * log returns is the standard treatment and it is what makes 0.5 a meaningful bar.
 *
 * DATE-ALIGNED, INNER JOIN. These series have different lengths (BTC 2588 rows, SP500
 * 2071) because crypto trades weekends and the index does not. Correlating by row index
 * would silently pair a Saturday against a Monday and drift further apart every week.
 * Only days BOTH instruments actually traded are compared, and the overlap count is
 * printed so a thin comparison cannot pass itself off as a strong one.
 *
 * READ-ONLY. Reads CSVs, prints. Writes nothing, touches no gate, threshold, setting or
 * order path. It ranks candidates; it does not add one — that needs a per-asset
 * walk-forward and then SHADOW mode first.
 */

const fs = require('fs');
const path = require('path');

const HIST_DIR   = path.join(__dirname, 'history');
const INCUMBENTS = ['BTCUSD', 'XAUUSD', 'SP500'];
const MIN_OVERLAP_DAYS = 250;   // ~1 trading year; below this a correlation is a rumour

const argv   = process.argv.slice(2);
const MAX_R  = Number((argv.find(a => a.startsWith('--max-r=')) || '').split('=')[1]) || 0.5;
const ASJSON = argv.includes('--json');

/** Broker CSV -> { 'YYYY-MM-DD': close }. Unix seconds in col 0, close in col 4. */
function readDaily(symbol) {
  const file = path.join(HIST_DIR, `${symbol}_D1.csv`);
  if (!fs.existsSync(file)) return null;
  const out = new Map();
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {          // skip header
    const parts = lines[i].split(',');
    if (parts.length < 5) continue;
    const ts = Number(parts[0]);
    const close = Number(parts[4]);
    if (!Number.isFinite(ts) || !Number.isFinite(close) || close <= 0) continue;
    out.set(new Date(ts * 1000).toISOString().slice(0, 10), close);
  }
  return out.size ? out : null;
}

/** Daily LOG returns keyed by the day they land on. */
function logReturns(series) {
  const days = [...series.keys()].sort();
  const out = new Map();
  for (let i = 1; i < days.length; i++) {
    const prev = series.get(days[i - 1]);
    const cur  = series.get(days[i]);
    if (prev > 0 && cur > 0) out.set(days[i], Math.log(cur / prev));
  }
  return out;
}

/** Pearson r over the INNER JOIN of two return maps. Returns null below the floor. */
function correlate(a, b) {
  const xs = [], ys = [];
  for (const [day, va] of a) {
    const vb = b.get(day);
    if (vb !== undefined) { xs.push(va); ys.push(vb); }
  }
  const n = xs.length;
  if (n < MIN_OVERLAP_DAYS) return { r: null, n };
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a1 = xs[i] - mx, b1 = ys[i] - my;
    num += a1 * b1; dx += a1 * a1; dy += b1 * b1;
  }
  if (dx === 0 || dy === 0) return { r: null, n };
  return { r: num / Math.sqrt(dx * dy), n };
}

function main() {
  const symbols = fs.readdirSync(HIST_DIR)
    .filter(f => f.endsWith('_D1.csv'))
    .map(f => f.replace('_D1.csv', ''))
    .sort();

  const returns = new Map();
  for (const s of symbols) {
    const daily = readDaily(s);
    if (daily) returns.set(s, logReturns(daily));
  }

  const missing = INCUMBENTS.filter(s => !returns.has(s));
  if (missing.length) {
    console.error(`Cannot screen: incumbent series missing — ${missing.join(', ')}`);
    process.exit(2);
  }

  const rows = [];
  for (const s of symbols) {
    if (INCUMBENTS.includes(s) || !returns.has(s)) continue;
    const against = {};
    let worst = -1, worstVs = null, thin = false;
    for (const inc of INCUMBENTS) {
      const { r, n } = correlate(returns.get(s), returns.get(inc));
      against[inc] = { r: r === null ? null : Number(r.toFixed(3)), overlapDays: n };
      if (r === null) { thin = true; continue; }
      if (Math.abs(r) > worst) { worst = Math.abs(r); worstVs = inc; }
    }
    rows.push({
      symbol: s,
      // The WORST correlation decides. A candidate independent of two incumbents and
      // welded to the third is the third one again, and a mean would hide that.
      maxAbsR: worst < 0 ? null : Number(worst.toFixed(3)),
      closestTo: worstVs,
      thinOverlap: thin,
      against,
      verdict: thin ? 'INSUFFICIENT OVERLAP'
             : worst < 0 ? 'NO DATA'
             : worst < MAX_R ? 'INDEPENDENT — candidate'
             : 'TOO CORRELATED — same trade twice',
    });
  }
  rows.sort((a, b) => (a.maxAbsR ?? 9) - (b.maxAbsR ?? 9));

  if (ASJSON) { console.log(JSON.stringify({ maxR: MAX_R, incumbents: INCUMBENTS, rows }, null, 2)); return; }

  console.log('='.repeat(94));
  console.log(`  FOURTH-ASSET CORRELATION SCREEN — daily LOG returns, BROKER bars, date-aligned`);
  console.log(`  incumbents: ${INCUMBENTS.join(', ')}   bar: |r| < ${MAX_R}   min overlap: ${MIN_OVERLAP_DAYS}d`);
  console.log('='.repeat(94));
  console.log('  symbol     maxAbs r   closest to   ' + INCUMBENTS.map(i => i.padEnd(9)).join('') + ' overlap  verdict');
  console.log('  ' + '-'.repeat(90));
  for (const row of rows) {
    const cells = INCUMBENTS.map(i => {
      const v = row.against[i].r;
      return (v === null ? '   n/a' : (v >= 0 ? ' ' : '') + v.toFixed(3)).padEnd(9);
    }).join('');
    const minOverlap = Math.min(...INCUMBENTS.map(i => row.against[i].overlapDays));
    console.log('  ' + row.symbol.padEnd(11)
      + (row.maxAbsR === null ? '  n/a  ' : row.maxAbsR.toFixed(3).padStart(7)) + '    '
      + String(row.closestTo || '-').padEnd(13) + cells
      + String(minOverlap).padStart(6) + '   ' + row.verdict);
  }
  const pass = rows.filter(r => r.verdict.startsWith('INDEPENDENT'));
  console.log('  ' + '-'.repeat(90));
  console.log(`  ${pass.length} of ${rows.length} candidate(s) clear |r| < ${MAX_R}: `
            + (pass.length ? pass.map(p => `${p.symbol} (${p.maxAbsR})`).join(', ') : 'none'));
  console.log('');
  console.log('  CORRELATION IS A VETO, NOT A RECOMMENDATION. Clearing this bar only means a');
  console.log('  candidate is not the same trade again. It says nothing about edge — that needs a');
  console.log('  per-asset walk-forward — and nothing about cost, which killed NAS100-class names');
  console.log('  before. Nothing here may go live without a walk-forward and then SHADOW mode.');
  console.log('='.repeat(94));
}

if (require.main === module) main();
module.exports = { readDaily, logReturns, correlate };
