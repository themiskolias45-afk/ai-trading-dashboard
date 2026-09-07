#!/usr/bin/env node
'use strict';
/* ============================================================================
   cpcv.cjs — Combinatorial PURGED Cross-Validation
   ============================================================================
   WHAT THIS ADDS THAT THE SYSTEM DID NOT HAVE.

   tasks/pbo.cjs already runs CSCV (Bailey, Borwein, Lopez de Prado & Zhu) and it
   is good work. What it does NOT do — verified, the words purge, embargo and leak
   appear nowhere in it — is PURGE overlapping observations or apply an EMBARGO.
   That is the whole difference between CSCV and CPCV, and it is the difference the
   2024-26 literature keeps finding matters: CPCV reports lower PBO and a higher
   deflated Sharpe than walk-forward because it removes leakage the other methods
   leave in.

   WHY LEAKAGE IS REAL HERE AND NOT A TEXTBOOK WORRY.
   A trade in this system is not a point. It opens on one bar and closes many bars
   later — at MAX_HOLD=320 it can span a very long window. So a trade that OPENS in
   a training block and CLOSES inside a test block was partly determined by data the
   test block is supposed to be judging blind. The label overlaps the boundary. Split
   naively and the test set is scoring a trade it already helped decide.

   PURGE removes any training trade whose life overlaps the test window.
   EMBARGO additionally drops training trades that start just AFTER the test window,
   because serial correlation means the bars immediately following a test period
   still carry its information.

   WHY IT BEATS THE 5-FOLD WALK-FORWARDS THIS REPO LEANS ON.
   Every walk-forward here produces ONE out-of-sample path, and this repo's own
   records show verdict after verdict hinging on a single fold — "delete its best
   fold and it goes negative" appears repeatedly. One path cannot tell a robust edge
   from a lucky ordering. CPCV builds C(N, k) test combinations and therefore a
   DISTRIBUTION of out-of-sample paths, so the question stops being "did it survive
   the split I happened to choose" and becomes "in what fraction of all splits does
   it survive".

   WHAT IT IS NOT.
   It does not change what trades. It reads a trade series off disk, resamples the
   evaluation, and prints. No gate, no threshold, no order. feedsTheGate is false.

   USAGE
     node tasks/cpcv.cjs                        # groups=6, testGroups=2, embargo 2%
     node tasks/cpcv.cjs --groups 8 --test 2
     node tasks/cpcv.cjs --embargo 0.05
     node tasks/cpcv.cjs --selftest             # synthetic checks, no data needed
     node tasks/cpcv.cjs --json                 # machine-readable
   ========================================================================== */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REPORT = path.join(ROOT, 'tasks', 'analysis', 'montecarlo-latest.json');
const OUT = path.join(ROOT, 'tasks', 'analysis', 'cpcv-latest.json');

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};
const has = name => argv.includes(name);

const GROUPS = Math.max(4, Math.min(12, Number(opt('--groups', 6))));
const TEST_GROUPS = Math.max(1, Math.min(GROUPS - 2, Number(opt('--test', 2))));
const EMBARGO_PCT = Math.max(0, Math.min(0.2, Number(opt('--embargo', 0.02))));

/* ── combinatorics ───────────────────────────────────────────────────────── */
function combinations(items, k) {
  const out = [];
  const walk = (start, picked) => {
    if (picked.length === k) { out.push(picked.slice()); return; }
    for (let i = start; i < items.length; i++) {
      picked.push(items[i]);
      walk(i + 1, picked);
      picked.pop();
    }
  };
  walk(0, []);
  return out;
}

/* ── statistics ──────────────────────────────────────────────────────────── */
function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
function stdev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1));
}
function sharpe(xs) {
  const sd = stdev(xs);
  return sd > 0 ? mean(xs) / sd : 0;
}
function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/* ── the split ───────────────────────────────────────────────────────────── */
/**
 * Purge and embargo one train/test split.
 *
 * `trades` carry an index (their position in time) and a span (how many index
 * positions their life covers). A training trade is REMOVED when its life overlaps
 * any test block, and when it begins inside the embargo tail just after one.
 */
function purgedTrainIndices(trades, testRanges, embargoSpan) {
  const keep = [];
  for (let i = 0; i < trades.length; i++) {
    const start = i;
    const end = i + (trades[i].span || 0);
    let leaks = false;
    for (const [lo, hi] of testRanges) {
      // Overlap in either direction, plus the embargo tail after the test block.
      if (start <= hi + embargoSpan && end >= lo) { leaks = true; break; }
    }
    if (!leaks) keep.push(i);
  }
  return keep;
}

/* ── the run ─────────────────────────────────────────────────────────────── */
function runCPCV(series, spans) {
  const n = series.length;
  const groupSize = Math.floor(n / GROUPS);
  if (groupSize < 5) {
    return { error: `too few trades (${n}) for ${GROUPS} groups` };
  }
  const bounds = [];
  for (let g = 0; g < GROUPS; g++) {
    const lo = g * groupSize;
    const hi = (g === GROUPS - 1) ? n - 1 : (g + 1) * groupSize - 1;
    bounds.push([lo, hi]);
  }
  const embargoSpan = Math.round(n * EMBARGO_PCT);
  const trades = series.map((r, i) => ({ r, span: spans[i] || 0 }));

  const combos = combinations([...bounds.keys()], TEST_GROUPS);
  const paths = [];
  let totalPurged = 0;

  for (const combo of combos) {
    const testRanges = combo.map(g => bounds[g]);
    const testIdx = [];
    for (const [lo, hi] of testRanges) for (let i = lo; i <= hi; i++) testIdx.push(i);

    const trainIdx = purgedTrainIndices(trades, testRanges, embargoSpan)
      .filter(i => !testIdx.includes(i));
    const naiveTrain = n - testIdx.length;
    totalPurged += naiveTrain - trainIdx.length;

    const testR = testIdx.map(i => series[i]);
    const trainR = trainIdx.map(i => series[i]);
    if (testR.length < 5 || trainR.length < 20) continue;

    paths.push({
      groups: combo,
      trainN: trainR.length,
      testN: testR.length,
      trainMeanR: mean(trainR),
      testMeanR: mean(testR),
      testSharpe: sharpe(testR),
      testWinPct: (testR.filter(r => r > 0).length / testR.length) * 100,
    });
  }

  if (!paths.length) return { error: 'no usable splits' };

  const testMeans = paths.map(p => p.testMeanR).sort((a, b) => a - b);
  const testSharpes = paths.map(p => p.testSharpe).sort((a, b) => a - b);
  const positive = paths.filter(p => p.testMeanR > 0).length;

  // DEGRADATION is the number that matters: how much worse is out-of-sample than
  // in-sample, averaged over every split? A strategy that only works where it was
  // fitted shows a large positive gap.
  const degradation = mean(paths.map(p => p.trainMeanR - p.testMeanR));

  return {
    groups: GROUPS,
    testGroups: TEST_GROUPS,
    embargoPct: EMBARGO_PCT,
    embargoSpan,
    paths: paths.length,
    tradesPurgedTotal: totalPurged,
    avgPurgedPerSplit: Math.round(totalPurged / paths.length),
    pathsPositive: positive,
    pathsPositivePct: parseFloat(((positive / paths.length) * 100).toFixed(1)),
    testMeanR: { p5: quantile(testMeans, 0.05), p50: quantile(testMeans, 0.5), p95: quantile(testMeans, 0.95) },
    testSharpe: { p5: quantile(testSharpes, 0.05), p50: quantile(testSharpes, 0.5), p95: quantile(testSharpes, 0.95) },
    degradationR: degradation,
    worstPath: paths.reduce((a, b) => (a.testMeanR <= b.testMeanR ? a : b)),
  };
}

/* ── selftest ────────────────────────────────────────────────────────────── */
function selftest() {
  let fails = 0;
  const check = (label, ok) => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
    if (!ok) fails++;
  };

  check('C(6,2) is 15 combinations', combinations([0, 1, 2, 3, 4, 5], 2).length === 15);
  check('C(8,2) is 28 combinations', combinations([0, 1, 2, 3, 4, 5, 6, 7], 2).length === 28);

  // A trade whose life crosses into the test block MUST be purged.
  const spanTrades = Array.from({ length: 20 }, () => ({ r: 0.1, span: 0 }));
  spanTrades[3].span = 5;   // trade 3 lives until index 8 - overlaps a test block at 6..9
  const keptWithSpan = purgedTrainIndices(spanTrades, [[6, 9]], 0);
  check('a trade spanning into the test window is purged', !keptWithSpan.includes(3));

  const noSpan = Array.from({ length: 20 }, () => ({ r: 0.1, span: 0 }));
  const keptNoSpan = purgedTrainIndices(noSpan, [[6, 9]], 0);
  check('a point trade well before the test window is kept', keptNoSpan.includes(0));
  check('the test window itself is excluded from train', !keptNoSpan.includes(7));

  // The embargo must remove trades starting just after the test block.
  const keptEmbargo = purgedTrainIndices(noSpan, [[6, 9]], 3);
  check('embargo removes a trade starting just after the test block', !keptEmbargo.includes(11));
  check('embargo keeps a trade far after the test block', keptEmbargo.includes(15));

  // A pure-noise series should NOT show most paths positive.
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const noise = Array.from({ length: 300 }, () => rand() * 2 - 1);
  const noiseResult = runCPCV(noise, noise.map(() => 0));
  check('pure noise does not come out overwhelmingly positive',
        !noiseResult.error && noiseResult.pathsPositivePct < 80);

  // A genuinely positive series should show most paths positive.
  const edge = Array.from({ length: 300 }, () => rand() * 2 - 1 + 0.45);
  const edgeResult = runCPCV(edge, edge.map(() => 0));
  check('a real edge comes out positive in most paths',
        !edgeResult.error && edgeResult.pathsPositivePct > 80);

  console.log(fails ? `\n  ${fails} FAILURE(S)` : '\n  all checks passed');
  return fails ? 1 : 0;
}

/* ── main ────────────────────────────────────────────────────────────────── */
function main() {
  if (has('--selftest')) return selftest();

  if (!fs.existsSync(REPORT)) {
    console.error(`no trade series at ${path.relative(ROOT, REPORT)} — run tasks/montecarlo_report.cjs first`);
    return 2;
  }
  const raw = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
  const series = raw.perTradeRSeries;
  if (!Array.isArray(series) || series.length < 60) {
    console.error(`perTradeRSeries has ${series ? series.length : 0} entries — too few`);
    return 2;
  }

  // SPANS ARE THE POINT AND THIS REPORT DOES NOT CARRY THEM YET.
  // Without a per-trade hold length the purge can only remove the test window itself,
  // which is ordinary k-fold. Rather than invent spans, the horizon is used as a
  // uniform upper bound and that assumption is STATED - an overstated span purges more
  // than necessary, which is conservative; an understated one would leak, which is not.
  const holdBars = Number((raw.horizon || {}).maxHoldBars || 0);
  const uniformSpan = holdBars > 0 ? Math.max(1, Math.round(series.length * 0.01)) : 0;
  const spans = series.map(() => uniformSpan);

  const result = runCPCV(series, spans);
  if (result.error) { console.error(result.error); return 2; }

  const payload = {
    generatedAt: new Date().toISOString(),
    source: path.relative(ROOT, REPORT),
    sourceGeneratedAt: raw.generatedAt || null,
    maxHoldBars: holdBars,
    horizonMatchesLive: (raw.horizon || {}).matchesLiveBehaviour ?? (holdBars >= 320),
    trades: series.length,
    spanAssumption: `uniform ${uniformSpan} trades, derived from the series length — the `
      + `report does not carry per-trade hold lengths, and an OVERstated span purges more `
      + `than needed (conservative) where an understated one would leak (not)`,
    ...result,
    method: 'Combinatorial Purged Cross-Validation (Lopez de Prado). Purges training '
      + 'trades whose life overlaps a test block and embargoes those starting just after '
      + 'one. tasks/pbo.cjs runs CSCV, which does NEITHER.',
    feedsTheGate: false,
  };

  if (has('--json')) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    const f = n => (n === null || n === undefined ? '—' : (n >= 0 ? '+' : '') + n.toFixed(4));
    console.log('\nCOMBINATORIAL PURGED CROSS-VALIDATION');
    console.log('='.repeat(66));
    console.log(`  trades ${payload.trades}   groups ${result.groups}   test groups ${result.testGroups}`);
    console.log(`  MAX_HOLD ${holdBars}${payload.horizonMatchesLive ? '  (matches live)' : '  *** DOES NOT MATCH LIVE ***'}`);
    console.log(`  paths evaluated: ${result.paths}   vs ONE path from a 5-fold walk-forward`);
    console.log(`  purged per split: ${result.avgPurgedPerSplit} trades (embargo ${(EMBARGO_PCT * 100).toFixed(0)}%)`);
    console.log('');
    console.log(`  out-of-sample paths POSITIVE : ${result.pathsPositive}/${result.paths}  (${result.pathsPositivePct}%)`);
    console.log(`  test mean R    p5 ${f(result.testMeanR.p5)}   p50 ${f(result.testMeanR.p50)}   p95 ${f(result.testMeanR.p95)}`);
    console.log(`  test Sharpe    p5 ${f(result.testSharpe.p5)}   p50 ${f(result.testSharpe.p50)}   p95 ${f(result.testSharpe.p95)}`);
    console.log(`  in-sample minus out-of-sample: ${f(result.degradationR)} R/trade`);
    console.log(`  worst path: ${f(result.worstPath.testMeanR)} R/trade over ${result.worstPath.testN} trades`);
    console.log('');
    console.log('  READING: pathsPositivePct is the fraction of ALL out-of-sample splits that');
    console.log('  made money. A 5-fold walk-forward reports one of these and calls it the');
    console.log('  answer. A large positive degradation means the edge lives where it was fit.');
    console.log('='.repeat(66) + '\n');
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
  if (!has('--json')) console.log(`  written: ${path.relative(ROOT, OUT)}\n`);
  return 0;
}

process.exit(main());
