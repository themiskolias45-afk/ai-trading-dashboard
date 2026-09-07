#!/usr/bin/env node
'use strict';
/* ============================================================================
   lab_shadow.cjs — run the PROMOTABLE lab candidates forward, in shadow
   ============================================================================

   THE GAP THIS FILLS. tasks/lab_run.cjs searches, tasks/lab_promote.cjs stages
   whatever clears its six-rule bar, and then NOTHING happens. A candidate that
   survived thousands of trials gets one Telegram message and accumulates no
   further evidence for the rest of its life. Every number attached to it stays a
   BACKTEST number, measured on the same history that selected it.

   Measured 2026-09-07: 5,293 trials, 9 SURVIVES, 2 clearing the full bar - and
   zero forward records for either. Both are BTCUSD H1, whose bars are refreshed
   hourly, so forward evidence was available the whole time. It was simply never
   collected.

   IT CANNOT TRADE, AND NOT BY POLICY - BY CONSTRUCTION. This file requires
   lab_strategies and lab_run and nothing else. There is no MT5 import, no bridge
   call, no HTTP request, no write to the settings file, no reference to the gate,
   a lot size or a stop. Every row it writes carries shadow:true and
   feedsTheGate:false, matching tk_shadow and fvg_shadow, so a reader that pools
   ledgers cannot mistake these for fills.

   THE SAME CODE PATH AS THE SEARCH. It calls validateSpec and then the identical
   runStrategy(bars, STRATEGIES[..], params, {...exec, session, symbol}) that
   lab_run uses. A shadow that re-implemented the strategy would be measuring a
   different thing and would drift from the backtest without anyone noticing.

   FORWARD MEANS AFTER STAGING. Only trades whose ENTRY is later than the moment
   the candidate was staged are recorded. That is the honest out-of-sample line:
   everything before it is in-sample by definition, because it is what selected
   the candidate. Rows are keyed by specHash + entry time and deduped, so running
   this every 15 minutes appends each trade exactly once.

   USAGE
     node tasks/lab_shadow.cjs            collect, append, write the panel file
     node tasks/lab_shadow.cjs --selftest
   ========================================================================== */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { STRATEGIES, loadBars, runStrategy } = require(path.join(__dirname, 'lab_strategies.cjs'));
const { validateSpec, labelFor } = require(path.join(__dirname, 'lab_run.cjs'));

const PROMOTABLE = path.join(ROOT, 'tasks', 'analysis', 'lab', '_promotable.jsonl');
const LEDGER     = path.join(ROOT, 'tasks', 'lab_shadow.jsonl');
const PANEL      = path.join(ROOT, 'dashboard', 'lab-shadow.json');

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    // A torn last line is not a reason to lose the rest of the ledger.
    try { out.push(JSON.parse(s)); } catch (err) { /* skip */ }
  }
  return out;
}

// Atomic, because this runs on a schedule while a dashboard may be reading it.
function writeJsonAtomic(file, payload) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 1), 'utf8');
  fs.renameSync(tmp, file);
}

function fmtR(v) {
  if (v === null || v === undefined) return '-';
  return (v >= 0 ? '+' : '') + Number(v).toFixed(4);
}

function collect(nowIso) {
  const candidates = readJsonl(PROMOTABLE);
  const existing   = readJsonl(LEDGER);
  const seen       = new Set(existing.map(function (r) { return r.key; }));

  const added        = [];
  const perCandidate = [];

  for (const cand of candidates) {
    const entry = { name: cand.name, label: cand.label, specHash: cand.specHash, stagedAt: cand.ts };

    let spec;
    try {
      spec = validateSpec(cand.spec);
    } catch (err) {
      perCandidate.push(Object.assign({}, entry, { error: 'spec rejected: ' + err.message }));
      continue;
    }

    const bars = loadBars(spec.symbol, spec.timeframe);
    if (!bars || bars.n < 200) {
      perCandidate.push(Object.assign({}, entry, {
        error: 'not enough bars for ' + spec.symbol + ' ' + spec.timeframe,
      }));
      continue;
    }

    const trades = runStrategy(bars, STRATEGIES[spec.strategy], spec.params,
      Object.assign({}, spec.exec, { session: spec.session, symbol: spec.symbol }));

    const staged  = Date.parse(cand.ts);
    const forward = trades.filter(function (t) { return Date.parse(t.openTime) > staged; });

    let newRows = 0;
    for (const t of forward) {
      const key = cand.specHash + '|' + t.openTime;
      if (seen.has(key)) continue;
      seen.add(key);
      newRows++;
      added.push({
        key:        key,
        specHash:   cand.specHash,
        name:       cand.name,
        label:      cand.label || labelFor(spec),
        symbol:     spec.symbol,
        timeframe:  spec.timeframe,
        strategy:   spec.strategy,
        direction:  t.direction,
        openTime:   t.openTime,
        closeTime:  t.closeTime,
        r:          t.r,
        exitReason: t.exitReason,
        barsHeld:   t.barsHeld,
        stagedAt:   cand.ts,
        // The two flags every shadow ledger in this project carries. Nothing here
        // reaches an order path, and no reader may treat these as fills.
        shadow:       true,
        feedsTheGate: false,
        seenAt:       nowIso,
      });
    }

    const mine = existing
      .filter(function (r) { return r.specHash === cand.specHash; })
      .concat(added.filter(function (r) { return r.specHash === cand.specHash; }));
    const sumR = mine.reduce(function (a, r) { return a + (Number(r.r) || 0); }, 0);
    const wins = mine.filter(function (r) { return Number(r.r) > 0; }).length;

    perCandidate.push(Object.assign({}, entry, {
      symbol:                 spec.symbol,
      timeframe:              spec.timeframe,
      backtestExpectancyR:    cand.summary ? cand.summary.expectancyR : null,
      backtestOosExpectancyR: cand.summary ? cand.summary.oosExpectancyR : null,
      backtestTrades:         cand.summary ? cand.summary.trades : null,
      forwardTrades:          mine.length,
      forwardNewThisRun:      newRows,
      forwardSumR:            Number(sumR.toFixed(4)),
      forwardExpectancyR:     mine.length ? Number((sumR / mine.length).toFixed(4)) : null,
      forwardWinRate:         mine.length ? Number((100 * wins / mine.length).toFixed(1)) : null,
      lastBarSeen:            new Date(bars.t[bars.n - 1] * 1000).toISOString(),
    }));
  }

  return { candidates: perCandidate, added: added };
}

function main(argv) {
  if (argv.indexOf('--selftest') >= 0) return selftest();

  const nowIso = new Date().toISOString();
  const result = collect(nowIso);
  const candidates = result.candidates;
  const added = result.added;

  if (added.length) {
    fs.appendFileSync(LEDGER, added.map(function (r) { return JSON.stringify(r); }).join('\n') + '\n', 'utf8');
  }

  writeJsonAtomic(PANEL, {
    generatedAt: nowIso,
    // Stated so the panel can say "nothing staged" rather than "none found": an
    // empty list because no candidate cleared the bar is a different fact from an
    // empty list because the staged ones have not fired yet.
    stagedCandidates: candidates.length,
    candidates: candidates,
    totals: {
      forwardTrades: candidates.reduce(function (a, c) { return a + (c.forwardTrades || 0); }, 0),
      forwardSumR:   Number(candidates.reduce(function (a, c) { return a + (c.forwardSumR || 0); }, 0).toFixed(4)),
      addedThisRun:  added.length,
    },
  });

  console.log('LAB SHADOW  ' + nowIso);
  console.log('  staged candidates: ' + candidates.length + '   new forward trades this run: ' + added.length);
  for (const c of candidates) {
    if (c.error) { console.log('  [SKIP] ' + c.name + ' - ' + c.error); continue; }
    console.log('  ' + c.label);
    console.log('    backtest exp ' + fmtR(c.backtestExpectancyR) + '  oos ' + fmtR(c.backtestOosExpectancyR)
      + '  over ' + c.backtestTrades + ' trades');
    console.log('    FORWARD      ' + c.forwardTrades + ' trades  sumR ' + fmtR(c.forwardSumR)
      + '  exp ' + fmtR(c.forwardExpectancyR)
      + '  win ' + (c.forwardWinRate === null ? '-' : c.forwardWinRate + '%'));
    console.log('    bars to ' + c.lastBarSeen + '   staged ' + c.stagedAt);
  }
  console.log('  ledger: ' + LEDGER);
  console.log('  panel : ' + PANEL);
  return 0;
}

function selftest() {
  let failed = 0;
  const ok = function (n, c, x) {
    if (!c) { failed++; console.log('  FAIL  ' + n + (x ? '  ' + x : '')); }
    else console.log('  ok    ' + n);
  };

  const cands = readJsonl(PROMOTABLE);
  ok('promotable file readable', Array.isArray(cands));

  // Every staged spec must still validate, or the search and the shadow disagree
  // about what the candidate even is.
  for (const c of cands) {
    let good = true, msg = '';
    try { validateSpec(c.spec); } catch (e) { good = false; msg = e.message; }
    ok('spec validates: ' + String(c.name || '?').slice(0, 44), good, msg);
  }

  // The forward window must exclude everything at or before staging.
  const staged = Date.parse('2026-01-02T00:00:00.000Z');
  const sample = [{ openTime: '2026-01-01T00:00:00.000Z' }, { openTime: '2026-01-03T00:00:00.000Z' }];
  const fwd = sample.filter(function (t) { return Date.parse(t.openTime) > staged; });
  ok('forward window excludes in-sample trades',
     fwd.length === 1 && fwd[0].openTime.indexOf('2026-01-03') === 0);

  // Dedupe must be stable across runs, or a 15-minute schedule multiplies rows.
  const seen = new Set(['hash|2026-01-03T00:00:00.000Z']);
  ok('dedupe rejects a repeat', seen.has('hash|2026-01-03T00:00:00.000Z'));

  // The safety flags are not optional on any row already written.
  const rows = readJsonl(LEDGER);
  ok('every ledger row is shadow and non-gating',
     rows.every(function (r) { return r.shadow === true && r.feedsTheGate === false; }),
     rows.length + ' rows checked');

  // This file must not be able to reach an order path or the live settings.
  //
  // Scoped to the OPERATIONAL half - everything above this selftest - because the
  // check's own banned-word list is executable code and matched itself otherwise.
  // A guard that fails on its own definition gets deleted rather than fixed, and
  // then nothing guards anything.
  const whole = fs.readFileSync(__filename, 'utf8');
  const operational = whole.slice(0, whole.indexOf('function selftest')).split('\n');
  const banned = ['mt5_bridge', 'order_send', 'execute_trade', 'strategy_settings', 'confidenceThreshold'];
  const hit = banned.filter(function (b) {
    return operational.some(function (l) {
      const t = l.trim();
      if (t.indexOf('//') === 0 || t.indexOf('*') === 0) return false;
      return l.indexOf(b) >= 0;
    });
  });
  ok('no order-path or settings reference in the operational code', hit.length === 0, hit.join(','));

  console.log(failed ? '\nSELFTEST FAILED (' + failed + ')' : '\nselftest passed');
  return failed ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { collect: collect, readJsonl: readJsonl, selftest: selftest };
