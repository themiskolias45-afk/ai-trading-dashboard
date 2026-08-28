#!/usr/bin/env node
'use strict';
/**
 * CALIBRATION OFFICER — does confidence mean anything?
 *
 *   node tasks/calibration_officer.cjs            # live journal only (fast)
 *   node tasks/calibration_officer.cjs --replay   # also replay the archive (~90s)
 *   node tasks/calibration_officer.cjs --emit     # write the report under tasks/logs
 *
 * WHY THIS EXISTS. Confidence is the number every gate trusts, and nothing has ever
 * checked whether it is TRUE. On 2026-08-28 the replay showed SP500 firing on exactly one
 * path — MOMENTUM / DAILY+H4_AGREE / TRENDING at confidence ~86, the HIGHEST-confidence
 * cohort in the system — and losing 36 of 39, with 21 consecutive losses since
 * 2024-01-31. That is not a weak edge; a coin flip beats it. Confidence there is not
 * merely uninformative, it is INVERTED, and no surface in the system was watching for it.
 *
 * The live learning engine structurally cannot catch it: getLearningBoost needs 5 closed
 * trades PER SETUP before it will act, and SPX has one. So the only place the evidence
 * exists is the replay — which is paper, and must never be quoted as realised edge.
 *
 * TWO POPULATIONS, REPORTED SEPARATELY AND NEVER MERGED:
 *   LIVE    server/journal.json. Authoritative and tiny. Real fills, real slippage.
 *   REPLAY  the broker archive through the real engine. Large and paper: no spread
 *           modelling, no slippage, entries never filled.
 * Pooling them would let 387 paper trades outvote 7 real ones and call the result
 * "measured". Where they disagree, the LIVE number is the one about money.
 *
 * PER ASSET, NEVER POOLED. Pooling lets Gold vote on an SPX question, and SPX is the
 * whole reason this exists.
 *
 * IT CHANGES NOTHING. Read-only. No gate, no threshold, no confidence, no sizing, no
 * signal admitted or suppressed. feedsTheGate is false and stays false.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EMIT = process.argv.includes('--emit');
const WITH_REPLAY = process.argv.includes('--replay');

// Below this many resolved trades a win rate is an anecdote. Same floor the rejection
// ledger and the shadow ledger use — three surfaces answering "is this worth anything"
// with different floors would disagree for no reason a reader could see.
const MIN_FOR_VERDICT = 5;

// Confidence buckets. Deliberately coarse: the gate is 70, so the question is whether
// clearing it by a lot beats clearing it by a little, not whether 86 differs from 87.
const BUCKETS = [
  { label: '<70  (below gate)', lo: 0,  hi: 70 },
  { label: '70-79', lo: 70, hi: 80 },
  { label: '80-89', lo: 80, hi: 90 },
  { label: '90+',   lo: 90, hi: 101 },
];

const ASSETS = { XAUUSD: 'GOLD', BTCUSD: 'BTC', SP500: 'SPX' };

const out = [];
const say = line => { out.push(line); console.log(line); };

function bucketFor(confidence) {
  return BUCKETS.find(b => confidence >= b.lo && confidence < b.hi) || null;
}

/** Live closed trades, grouped by asset then confidence bucket. */
function readLive() {
  const file = path.join(ROOT, 'server', 'journal.json');
  let rows;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    rows = Array.isArray(parsed) ? parsed : (parsed.trades || parsed.journal || []);
  } catch (e) {
    return { error: e.message, byAsset: {} };
  }
  const byAsset = {};
  for (const row of rows) {
    // A trade with no close is not evidence yet, and a trade with no confidence cannot
    // be bucketed — counted as unusable rather than dropped silently.
    const pnl = row.pnl;
    if (pnl === null || pnl === undefined) continue;
    const confidence = Number(row.confidence);
    const asset = ASSETS[row.symbol] || row.symbol;
    const entry = (byAsset[asset] = byAsset[asset] || { usable: 0, unbucketed: 0, buckets: {} });
    if (!Number.isFinite(confidence)) { entry.unbucketed++; continue; }
    const bucket = bucketFor(confidence);
    if (!bucket) { entry.unbucketed++; continue; }
    const slot = (entry.buckets[bucket.label] = entry.buckets[bucket.label] || { n: 0, wins: 0 });
    slot.n++;
    if (pnl > 0) slot.wins++;
    entry.usable++;
  }
  return { byAsset };
}

/** The same question against the archive, through the real engine. Paper, and labelled so. */
function readReplay() {
  const byAsset = {};
  for (const [symbol, label] of Object.entries(ASSETS)) {
    const ticker = { XAUUSD: 'GC=F', BTCUSD: 'BTC-USD', SP500: '^GSPC' }[symbol];
    let raw;
    try {
      raw = execFileSync('node',
        [path.join(ROOT, 'tasks', '_replay_mtf.cjs'), ROOT, symbol, ticker, '40'],
        { encoding: 'utf8', timeout: 180000, maxBuffer: 64 * 1024 * 1024 });
    } catch (e) {
      byAsset[label] = { error: (e.message || 'replay failed').slice(0, 120) };
      continue;
    }
    const line = raw.split('\n').find(l => l.trim().startsWith('[{'));
    if (!line) { byAsset[label] = { error: 'replay produced no trade list' }; continue; }
    let trades;
    try { trades = JSON.parse(line); } catch (e) { byAsset[label] = { error: 'unparseable trade list' }; continue; }
    const entry = { usable: 0, unbucketed: 0, buckets: {} };
    for (const trade of trades) {
      if (trade.outcome !== 'WIN' && trade.outcome !== 'LOSS') continue;
      const bucket = bucketFor(Number(trade.conf));
      if (!bucket) { entry.unbucketed++; continue; }
      const slot = (entry.buckets[bucket.label] = entry.buckets[bucket.label] || { n: 0, wins: 0 });
      slot.n++;
      if (trade.outcome === 'WIN') slot.wins++;
      entry.usable++;
    }
    byAsset[label] = entry;
  }
  return { byAsset };
}

/**
 * The verdict. INVERTED is its own word on purpose: a cohort that wins far LESS often
 * than its confidence claims is a different fault from one that is merely noisy, and
 * calling both "poorly calibrated" is how the SPX case stayed invisible.
 */
function verdictFor(bucket, winRatePct) {
  if (bucket.lo >= 100) return 'n/a';
  const claimed = bucket.lo;                     // the floor of the bucket is its claim
  const gap = winRatePct - claimed;
  if (gap <= -35) return 'INVERTED — wins far less often than it claims';
  if (gap <= -15) return 'OVERCONFIDENT';
  if (gap >= 15)  return 'UNDERCONFIDENT';
  return 'calibrated';
}

function report(title, population, caveat) {
  say('');
  say('='.repeat(78));
  say(title);
  say(caveat);
  say('='.repeat(78));
  if (population.error) { say('  unreadable: ' + population.error); return; }
  const assets = Object.keys(population.byAsset).sort();
  if (!assets.length) { say('  no resolved trades'); return; }
  for (const asset of assets) {
    const entry = population.byAsset[asset];
    if (entry.error) { say('  ' + asset + '  ' + entry.error); continue; }
    say('');
    say('  ' + asset + '  (' + entry.usable + ' resolved'
      + (entry.unbucketed ? ', ' + entry.unbucketed + ' without usable confidence' : '') + ')');
    const labels = BUCKETS.map(b => b.label).filter(l => entry.buckets[l]);
    if (!labels.length) { say('     nothing bucketable'); continue; }
    const scored = [];
    for (const label of labels) {
      const slot = entry.buckets[label];
      const winRate = slot.wins / slot.n * 100;
      const bucket = BUCKETS.find(b => b.label === label);
      const verdict = slot.n < MIN_FOR_VERDICT
        ? 'TOO FEW TO JUDGE (floor ' + MIN_FOR_VERDICT + ')'
        : verdictFor(bucket, winRate);
      say('     conf ' + label.padEnd(18)
        + 'n=' + String(slot.n).padStart(4)
        + '   win ' + winRate.toFixed(0).padStart(3) + '%'
        + '   ' + verdict);
      if (slot.n >= MIN_FOR_VERDICT) scored.push({ lo: bucket.lo, winRate, n: slot.n });
    }

    // DOES MORE CONFIDENCE WIN MORE? This is the question that survives the fact that
    // confidence here is a SCORE, not a probability. The absolute verdicts above compare
    // a win rate to the bucket's own number, which assumes confidence claims a win rate —
    // the project's own skills do read it that way ("65-74% conf -> expect ~65-70% WR"),
    // but it makes almost everything look INVERTED and buries the case that matters.
    //
    // Ordering is scale-free: if the score is informative at all, higher buckets should
    // win more often. A cohort where the HIGHEST confidence is the WORST performer is
    // broken in a way no threshold change can fix, and that is exactly SP500.
    if (scored.length >= 2) {
      scored.sort((a, b) => a.lo - b.lo);
      const best = scored.reduce((m, s) => s.winRate > m.winRate ? s : m, scored[0]);
      const top = scored[scored.length - 1];
      const rises = scored.every((s, i) => i === 0 || s.winRate >= scored[i - 1].winRate - 5);
      const topIsWorst = scored.every(s => s.winRate >= top.winRate);
      // Carry the top bucket's n into the verdict. GOLD's 90+ cleared the floor with
      // SIX trades and produced a confident-sounding "BROKEN"; a verdict about the
      // highest-confidence cohort that does not say how thin that cohort is invites
      // exactly the over-reading this whole file exists to prevent.
      const sample = ' [top bucket ' + top.lo + '+, n=' + top.n + ']';
      const ordering = topIsWorst && scored.length >= 2
        ? 'BROKEN — the HIGHEST confidence bucket is the WORST performer'
        : rises
          ? 'informative — win rate rises with confidence'
          : 'NOT informative — win rate does not rise with confidence (best bucket is '
            + best.lo + '+, not ' + top.lo + '+)';
      say('     ordering: ' + ordering + sample);
    } else if (labels.length) {
      say('     ordering: unjudgeable — fewer than two buckets clear the floor');
    }
  }
}

say('CALIBRATION OFFICER — does confidence mean what it says?');
say('Per asset, never pooled. Live and replay reported separately and never merged.');
say('Read-only: no gate, threshold, confidence or sizing is touched. feedsTheGate=false.');

report('LIVE — server/journal.json',
  readLive(),
  'Authoritative. Real fills, real slippage. Small by construction — this system is weeks old.');

if (WITH_REPLAY) {
  report('REPLAY — the broker archive through the real engine',
    readReplay(),
    'PAPER: no spread modelling, no slippage, entries never filled. Never quote as realised edge.');
} else {
  say('');
  say('  (replay not run — pass --replay for the large-sample view, ~90s)');
}

say('');
say('  A bucket labelled INVERTED wins far LESS often than its confidence claims. That is');
say('  a different fault from noise, and calling both "poorly calibrated" is how SP500 —');
say('  which fires only at ~86 and lost 36 of 39 replayed trades — stayed invisible.');
say('  Where live and replay disagree, the LIVE number is the one about money.');

if (EMIT) {
  const dir = path.join(ROOT, 'tasks', 'logs');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'calibration_officer.txt'), out.join('\n') + '\n', 'utf8');
    console.log('\nwrote tasks/logs/calibration_officer.txt');
  } catch (e) {
    console.error('could not write the report: ' + e.message);
  }
}
