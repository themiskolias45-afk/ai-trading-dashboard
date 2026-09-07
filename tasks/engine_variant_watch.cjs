'use strict';
/**
 * Walk-forwards a live engine CONDITION against its candidate, unattended, and records
 * the verdict so nobody has to run it by hand and nobody has to remember the answer.
 *
 *   node tasks/engine_variant_watch.cjs              run every variant, append the ledger
 *   node tasks/engine_variant_watch.cjs --report     print the ledger, run nothing
 *   node tasks/engine_variant_watch.cjs --force      re-run even if the bars have not moved
 *
 * WHY THIS EXISTS. The macd.bullish question — does `bullish` mean ACCELERATING or
 * RISING — was answered on 2026-09-07 by typing two walk-forwards by hand and reading
 * the tables. That answer is worth having every day, because it changes as folds fill,
 * and a measurement that only happens when someone remembers is not a measurement. The
 * lab already searches strategies 24/7 on both boxes; this does the same for the
 * conditions ALREADY IN the engine, which the lab never touches.
 *
 * DAILY, NOT CONTINUOUS, AND THAT IS DELIBERATE. Every variant here replays DAILY bars.
 * Re-running at 15-minute intervals would recompute an identical answer from identical
 * data ~96 times a day and report it as if it were new evidence. The job therefore skips
 * when the newest bar has not changed since the last run — exactly the contract
 * Strategy Search uses when it exits 4 for "bars unchanged". --force overrides it.
 *
 * IT CHANGES NOTHING. It sets no threshold, flips no default, edits no source. It runs
 * the replay harness with a const override and appends one row per variant to
 * tasks/analysis/engine_variants.jsonl. Promoting a variant stays a human decision, and
 * the standing bar is unchanged: a challenger must beat the live rule on its WORST FOLD
 * in most folds, not on its mean.
 */

const { execFileSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const ROOT      = path.join(__dirname, '..');
const LEDGER    = path.join(ROOT, 'tasks', 'analysis', 'engine_variants.jsonl');
const STATE     = path.join(ROOT, 'tasks', 'analysis', '.engine_variant_lastbar');
const HARNESS   = path.join(ROOT, 'tasks', 'mtf_walkforward.cjs');
const ASSETS    = ['XAUUSD', 'BTCUSD', 'SP500'];
const LIVE_GATE = 70;

// Each entry is one engine condition with a live arm and a candidate arm. Adding a
// variant here is the whole cost of measuring a new one forever.
const VARIANTS = [
  {
    id: 'macd_bullish_mode',
    question: 'Does macd.bullish mean ACCELERATING (MACD>signal) or RISING (MACD>0)?',
    env: 'MTF_MACD_BULLISH_MODE',
    live: 'signal',
    candidate: 'trend',
    note: 'Candidate is a strict SUPERSET of live — verified 0 blocks / 820 additions over '
        + '6561 (macd,signal) pairs — so it can only ADD trades. Live blocks 22-30% of days '
        + 'on which the asset is in a genuine uptrend but decelerating.',
  },
];

const argv    = process.argv.slice(2);
const REPORT  = argv.includes('--report');
const FORCE   = argv.includes('--force');

/** Newest D1 close timestamp across the traded assets — the "have the bars moved" key. */
function newestBarKey() {
  const stamps = [];
  for (const a of ASSETS) {
    const f = path.join(ROOT, 'tasks', 'history', `${a}_D1.csv`);
    if (!fs.existsSync(f)) continue;
    const lines = fs.readFileSync(f, 'utf8').trimEnd().split(/\r?\n/);
    const last = lines[lines.length - 1];
    if (last) stamps.push(`${a}:${last.split(',')[0]}`);
  }
  return stamps.join('|');
}

/** Run the harness once and pull the gate-70 row for each asset. */
function walkForward(envOverride) {
  const out = execFileSync(process.execPath, [HARNESS], {
    cwd: ROOT,
    env: { ...process.env, ...envOverride },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 15 * 60 * 1000,
  });
  // DEGRADED means the engine threw on some steps and the table is incomplete. Treated
  // as a hard failure, never parsed: an incomplete replay reported as a verdict is the
  // exact failure the harness banner exists to prevent, and it has already happened
  // twice on this project.
  if (/MTF_REPLAY DEGRADED/.test(out)) throw new Error('replay DEGRADED — engine threw, result discarded');

  const result = {};
  let current = null;
  for (const line of out.split(/\r?\n/)) {
    const header = line.match(/^\s+(\w+) ONLY .{1,3} (\d+) trades/);
    if (header) { current = header[1]; result[current] = { trades: Number(header[2]) }; continue; }
    if (!current) continue;
    const row = line.match(new RegExp(`^\\s+${LIVE_GATE}\\s`));
    if (!row) continue;
    const nums = line.match(/[-+]\d+\.\d+/g) || [];
    const tail = line.match(/(\d+)\/5\s+(.+?)\s*$/);
    if (nums.length >= 6 && tail) {
      result[current].worstFold    = Number(nums[5]);
      result[current].positiveFolds = Number(tail[1]);
      result[current].verdict      = tail[2].trim();
    }
    current = null;
  }
  return result;
}

function judge(live, cand) {
  // THE STANDING BAR, applied per asset: beat the live worst fold AND do not lose
  // positive folds. A better worst fold carried by FEWER positive folds is the shape
  // this rule exists to refuse — it is what disqualified the candidate on XAUUSD.
  if (!live || !cand || live.worstFold === undefined || cand.worstFold === undefined) return 'NO DATA';
  const worstBetter = cand.worstFold > live.worstFold;
  const foldsHeld   = cand.positiveFolds >= live.positiveFolds;
  if (worstBetter && foldsHeld) return 'CANDIDATE BEATS LIVE';
  if (worstBetter && !foldsHeld) return 'MIXED — better worst fold, FEWER positive folds';
  if (!worstBetter && foldsHeld) return 'MIXED — folds held, worst fold not beaten';
  return 'LIVE WINS';
}

function printLedger() {
  if (!fs.existsSync(LEDGER)) { console.log('no runs recorded yet'); return; }
  const rows = fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  console.log(`ENGINE VARIANT LEDGER — ${rows.length} run(s)`);
  for (const r of rows.slice(-8)) {
    console.log(`  ${r.ranAt.slice(0, 16)}  ${r.variant}`);
    for (const a of ASSETS) {
      const c = r.assets[a];
      if (!c) continue;
      console.log(`    ${a.padEnd(8)} live worst ${String(c.liveWorst).padStart(7)} ${c.liveFolds}/5`
                + `   cand worst ${String(c.candWorst).padStart(7)} ${c.candFolds}/5   ${c.judgement}`);
    }
  }
}

function main() {
  if (REPORT) return printLedger();

  const barKey = newestBarKey();
  const prev   = fs.existsSync(STATE) ? fs.readFileSync(STATE, 'utf8').trim() : '';
  if (!FORCE && barKey && barKey === prev) {
    console.log('bars unchanged since the last run — nothing new to measure. --force to override.');
    process.exit(4);   // same contract Strategy Search uses for "bars unchanged"
  }

  fs.mkdirSync(path.dirname(LEDGER), { recursive: true });

  for (const v of VARIANTS) {
    let live, cand;
    try {
      live = walkForward({ [v.env]: v.live });
      cand = walkForward({ [v.env]: v.candidate });
    } catch (e) {
      console.error(`[${v.id}] ABANDONED: ${e.message}`);
      continue;   // never record a partial measurement as a verdict
    }

    const assets = {};
    for (const a of ASSETS) {
      const l = live[a], c = cand[a];
      if (!l || !c) continue;
      assets[a] = {
        liveTrades: l.trades,   liveWorst: l.worstFold, liveFolds: l.positiveFolds, liveVerdict: l.verdict,
        candTrades: c.trades,   candWorst: c.worstFold, candFolds: c.positiveFolds, candVerdict: c.verdict,
        judgement: judge(l, c),
      };
    }

    const row = {
      ranAt: new Date().toISOString(),
      host: require('os').hostname(),
      variant: v.id,
      question: v.question,
      liveArm: v.live, candidateArm: v.candidate, gate: LIVE_GATE,
      barKey, assets, note: v.note,
      feedsTheGate: false,
      changedAnything: false,
    };
    fs.appendFileSync(LEDGER, JSON.stringify(row) + '\n');

    console.log(`[${v.id}] ${v.question}`);
    for (const a of ASSETS) {
      const c = assets[a];
      if (!c) { console.log(`  ${a.padEnd(8)} NO DATA`); continue; }
      console.log(`  ${a.padEnd(8)} trades ${c.liveTrades}->${c.candTrades}`
        + `   worst ${c.liveWorst}->${c.candWorst}`
        + `   folds ${c.liveFolds}/5->${c.candFolds}/5   ${c.judgement}`);
    }
    const wins = Object.values(assets).filter(x => x.judgement === 'CANDIDATE BEATS LIVE').length;
    console.log(`  ${wins} of ${Object.keys(assets).length} asset(s) clear the bar. `
              + `Nothing was changed — promoting a variant is a human decision.`);
  }

  if (barKey) fs.writeFileSync(STATE, barKey);
}

if (require.main === module) main();
module.exports = { walkForward, judge, newestBarKey };
