#!/usr/bin/env node
'use strict';
/**
 * Score the stop-variant shadow ledger: would a lower-timeframe stop have paid?
 *
 * tasks/stop_variants.jsonl records, for every signal that formed with a direction, what
 * the H4 and H1 ATR stop/target would have been AT THE SAME R:R. This walks each of those
 * geometries forward on real broker bars and reports what they would have returned.
 *
 * WHY IT IS A PAIRED TEST, which matters more than the sample size. Every row carries BOTH
 * the variant levels and the `baseline` the engine actually traded, from the SAME signal at
 * the SAME instant. So each row is its own control: same setup, same entry, same R:R, one
 * variable changed - the timeframe the ATR was measured on. That removes the objection
 * that killed earlier CRT work, where a candidate population and its control were not the
 * same trades (19 CRT trades appeared on Gold while the total rose by 3, so CRT had
 * DISPLACED 16 - see [[crt_confluence_rejected_crt_is_closed]]).
 *
 * WHAT THESE NUMBERS ARE NOT. Forgone PAPER geometries. No spread, no slippage, no partial
 * fill, and the entry was never filled. They are evidence about stop SCALE and resolution
 * SPEED, never realised P&L, and they must never be merged with get_performance. Where this
 * disagrees with a walk-forward, the walk-forward wins.
 * feedsTheGate is false. Nothing here changes a stop, a target, a threshold or a trade.
 *
 * ── SCORING RULES, deliberately the same discipline as score_rr_rejections.py ────────
 *   WIN / LOSS      target or stop reached first inside the horizon.
 *   AMBIGUOUS       one bar holds BOTH levels. Order is unknowable, so it is its own
 *                   bucket and is EXCLUDED from the mean rather than guessed. An
 *                   ambiguous bar is a wide, volatile bar; assuming the good fill is how
 *                   a backtest flatters itself, and assuming the bad one biases the other
 *                   way. Reported, never silently resolved.
 *   TIMEOUT         neither level reached inside the horizon. Marked to market so a
 *                   geometry that went nowhere is not scored as a free win.
 *   PENDING         the horizon has not elapsed yet in real time.
 *   NO_DATA         no bars cover the window.
 *   UNSCORABLE      the row cannot support a trade (missing levels, zero risk).
 *
 * Usage:
 *   node tasks/score_stop_variants.cjs [--input PATH] [--emit] [--min 5]
 */

const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = path.join(__dirname, "..");
const ARCHIVE_DIR  = path.join(PROJECT_ROOT, "tasks", "history");

function strArg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return (i === -1 || i + 1 >= process.argv.length) ? fallback : process.argv[i + 1];
}
function numArg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  if (i === -1 || i + 1 >= process.argv.length) return fallback;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : fallback;
}

const INPUT = strArg("--input", path.join(PROJECT_ROOT, "tasks", "stop_variants.jsonl"));
const EMIT  = process.argv.includes("--emit");
// Per-row outcomes. Off by default so the report stays readable, on when you need
// to see WHY a cell reads the way it does - or to verify the scorer itself.
const SHOW_ROWS = process.argv.includes("--rows");
// Floor for a verdict. Below this a cell is reported as TOO FEW TO JUDGE rather than
// given a number that reads like a finding. Same convention as the rejection ledger.
const MIN_FOR_VERDICT = numArg("--min", 5);

const TF_SECONDS = { d1: 86400, h4: 14400, h1: 3600, m15: 900 };
// Horizon per execution timeframe, in bars of that timeframe. A tighter stop resolves
// faster, so the horizon is expressed in the variant's OWN bars rather than in hours.
const HORIZON_BARS = { d1: 20, h4: 30, h1: 48, m15: 96 };

const ARCHIVE_SYMBOL = { BTCUSD: "BTCUSD", XAUUSD: "XAUUSD", SP500: "SP500" };

/**
 * Load one <SYMBOL>_<TF>.csv. Returns null rather than a partial series: a silently short
 * series would produce a plausible-looking score, which is worse than no score.
 *
 * NOTE: this duplicates the loader in tasks/crt_amd_mtf_measure.cjs. Kept separate on
 * purpose for now - that file is a working, verified measurement tool and refactoring it
 * mid-flight to share code risks the thing it measures. If a third reader appears, extract
 * both into tasks/_bar_source.cjs then, with the tests to prove they still agree.
 */
function loadArchive(symbol, timeframe) {
  const file = path.join(ARCHIVE_DIR, `${symbol}_${timeframe.toUpperCase()}.csv`);
  try {
    if (!fs.existsSync(file)) return null;
    const lines = fs.readFileSync(file, "utf8").trim().split(/\r?\n/);
    if (lines.length < 3) return null;
    const header = lines[0].split(",").map(h => h.trim());
    const iT = header.indexOf("time"), iH = header.indexOf("high");
    const iL = header.indexOf("low"),  iC = header.indexOf("close");
    if ([iT, iH, iL, iC].some(i => i === -1)) return null;

    const times = [], highs = [], lows = [], closes = [];
    let previousTime = -Infinity;
    for (let i = 1; i < lines.length; i++) {
      const row = lines[i].split(",");
      const t = Number(row[iT]), h = Number(row[iH]), l = Number(row[iL]), c = Number(row[iC]);
      if (![t, h, l, c].every(Number.isFinite)) continue;
      if (t <= previousTime) continue;
      previousTime = t;
      times.push(t); highs.push(h); lows.push(l); closes.push(c);
    }
    return closes.length < 50 ? null : { times, highs, lows, closes };
  } catch (e) {
    console.error(`[bars] ${path.basename(file)}: ${e.message}`);
    return null;
  }
}

const barCache = new Map();
function barsFor(symbol, timeframe) {
  const key = `${symbol}|${timeframe}`;
  if (!barCache.has(key)) barCache.set(key, loadArchive(symbol, timeframe));
  return barCache.get(key);
}

/** First bar index opening at or after `epochSeconds`. -1 when the window is not covered. */
function indexAtOrAfter(times, epochSeconds) {
  let lo = 0, hi = times.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] >= epochSeconds) { found = mid; hi = mid - 1; } else { lo = mid + 1; }
  }
  return found;
}

/**
 * Walk one geometry forward. Returns { outcome, r, bars } and never guesses.
 */
function walk(bars, startIndex, direction, entry, stop, target, horizonBars) {
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return { outcome: "UNSCORABLE", r: null, bars: 0, why: "zero risk distance" };
  const rewardR = Math.abs(target - entry) / risk;
  const last = Math.min(bars.closes.length - 1, startIndex + horizonBars);

  for (let i = startIndex; i <= last; i++) {
    const high = bars.highs[i], low = bars.lows[i];
    const hitStop   = direction === "BUY" ? low  <= stop   : high >= stop;
    const hitTarget = direction === "BUY" ? high >= target : low  <= target;
    if (hitStop && hitTarget) {
      return { outcome: "AMBIGUOUS", r: null, bars: i - startIndex + 1,
               why: "stop and target both inside one bar" };
    }
    if (hitStop)   return { outcome: "LOSS", r: -1,      bars: i - startIndex + 1 };
    if (hitTarget) return { outcome: "WIN",  r: rewardR, bars: i - startIndex + 1 };
  }

  // Neither level reached. Mark to market rather than scoring it flat - a geometry that
  // drifted the wrong way for the whole horizon is not a free scratch.
  if (last <= startIndex) return { outcome: "NO_DATA", r: null, bars: 0, why: "no bars in window" };
  const exit = bars.closes[last];
  const moved = direction === "BUY" ? exit - entry : entry - exit;
  return { outcome: "TIMEOUT", r: moved / risk, bars: last - startIndex + 1 };
}

function pad(v, w) { return String(v).padEnd(w); }
function fx(v, d) { return (v === null || v === undefined || !Number.isFinite(v)) ? "-" : v.toFixed(d); }

function summarise(list) {
  const scored = list.filter(x => Number.isFinite(x.r));
  if (!scored.length) return null;
  const wins = list.filter(x => x.outcome === "WIN").length;
  const losses = list.filter(x => x.outcome === "LOSS").length;
  const totalR = scored.reduce((s, x) => s + x.r, 0);
  return {
    resolved: scored.length,
    wins, losses,
    ambiguous: list.filter(x => x.outcome === "AMBIGUOUS").length,
    timeouts:  list.filter(x => x.outcome === "TIMEOUT").length,
    winRate: (wins + losses) ? wins / (wins + losses) * 100 : null,
    totalR,
    rPerTrade: totalR / scored.length,
    avgBars: scored.reduce((s, x) => s + x.bars, 0) / scored.length,
  };
}

function main() {
  const out = [];
  const say = (l) => { out.push(l); console.log(l); };

  say("=".repeat(96));
  say(`  STOP-VARIANT SCORER  ${new Date().toISOString()}`);
  say("  PAIRED: every row scores its variant AND the baseline the engine actually traded,");
  say("  from the same signal at the same instant. One variable changes: the ATR timeframe.");
  say("=".repeat(96));

  if (!fs.existsSync(INPUT)) {
    say(`\n  No ledger at ${INPUT} yet — nothing to score.`);
    say("  It fills from the */10 cron in server/index.js whenever a setup forms with a direction.");
    return;
  }

  const lines = fs.readFileSync(INPUT, "utf8").split("\n").filter(l => l.trim());
  const rows = [];
  let malformed = 0;
  for (const line of lines) {
    try { rows.push(JSON.parse(line)); } catch (e) { malformed++; }
  }
  say(`\n  ledger rows: ${rows.length}${malformed ? `  (${malformed} malformed, kept on disk, skipped here)` : ""}`);

  const nowEpoch = Math.floor(Date.now() / 1000);
  const results = [];
  const reasons = {};

  for (const row of rows) {
    const tf = row.variantTimeframe;
    const symbol = ARCHIVE_SYMBOL[row.symbol];
    const at = Date.parse(row.at);
    if (!symbol || !tf || !Number.isFinite(at)) {
      reasons.UNSCORABLE = (reasons.UNSCORABLE || 0) + 1; continue;
    }
    const bars = barsFor(symbol, tf);
    if (!bars) { reasons.NO_BARS = (reasons.NO_BARS || 0) + 1; continue; }

    const horizon = HORIZON_BARS[tf] || 48;
    const startEpoch = Math.floor(at / 1000);
    // The horizon must have ELAPSED in real time, or the answer is not known yet.
    if (nowEpoch < startEpoch + horizon * TF_SECONDS[tf]) {
      reasons.PENDING = (reasons.PENDING || 0) + 1; continue;
    }
    const idx = indexAtOrAfter(bars.times, startEpoch);
    if (idx === -1) { reasons.NO_DATA = (reasons.NO_DATA || 0) + 1; continue; }

    const variant = walk(bars, idx, row.direction, row.entry, row.stop, row.target, horizon);
    // The baseline walks on the SAME bars from the SAME index - that is what makes it paired.
    const base = row.baseline
      ? walk(bars, idx, row.direction, row.entry, row.baseline.stop, row.baseline.target, horizon)
      : { outcome: "UNSCORABLE", r: null, bars: 0, why: "row carries no baseline" };

    results.push({ row, tf, symbol, variant, base });
  }

  if (SHOW_ROWS) {
    say("");
    say(`  ${pad("key", 8)}${pad("sym", 8)}${pad("tf", 5)}${pad("dir", 6)}` +
        `${pad("VARIANT", 12)}${pad("R", 9)}${pad("bars", 6)}${pad("BASELINE", 12)}R`);
    for (const r of results) {
      say(`  ${pad(r.row.key ? String(r.row.key).slice(0, 6) : "-", 8)}${pad(r.symbol, 8)}` +
          `${pad(r.tf, 5)}${pad(r.row.direction, 6)}${pad(r.variant.outcome, 12)}` +
          `${pad(fx(r.variant.r, 3), 9)}${pad(r.variant.bars, 6)}` +
          `${pad(r.base.outcome, 12)}${fx(r.base.r, 3)}`);
    }
  }

  if (!results.length) {
    say("\n  Nothing scorable yet.");
    for (const [k, v] of Object.entries(reasons)) say(`    ${pad(k, 14)}${v}`);
    say("\n  This is expected while the ledger is young: a row only becomes scorable once its");
    say("  horizon has elapsed in real time. Re-run tomorrow.");
    if (EMIT) writeReport(out);
    return;
  }

  say("");
  say(`  ${pad("symbol", 9)}${pad("variant", 9)}${pad("n", 5)}${pad("WR%", 8)}${pad("R/trade", 11)}` +
      `${pad("avg bars", 10)}| ${pad("BASELINE R", 12)}${pad("base WR%", 10)}delta`);

  const cells = new Map();
  for (const r of results) {
    const key = `${r.symbol}|${r.tf}`;
    if (!cells.has(key)) cells.set(key, { variant: [], base: [] });
    cells.get(key).variant.push(r.variant);
    cells.get(key).base.push(r.base);
  }

  const verdicts = [];
  for (const [key, cell] of cells) {
    const [symbol, tf] = key.split("|");
    const v = summarise(cell.variant);
    const b = summarise(cell.base);
    if (!v) { say(`  ${pad(symbol, 9)}${pad(tf, 9)}nothing resolved`); continue; }
    const delta = (b && Number.isFinite(b.rPerTrade)) ? v.rPerTrade - b.rPerTrade : null;
    say(`  ${pad(symbol, 9)}${pad(tf, 9)}${pad(v.resolved, 5)}${pad(fx(v.winRate, 1), 8)}` +
        `${pad(fx(v.rPerTrade, 4), 11)}${pad(fx(v.avgBars, 1), 10)}| ` +
        `${pad(b ? fx(b.rPerTrade, 4) : "-", 12)}${pad(b ? fx(b.winRate, 1) : "-", 10)}` +
        `${delta === null ? "-" : (delta > 0 ? "+" : "") + fx(delta, 4)}`);
    verdicts.push({ symbol, tf, v, b, delta });
  }

  say("");
  say("  VERDICT");
  say("  " + "-".repeat(92));
  for (const x of verdicts) {
    if (x.v.resolved < MIN_FOR_VERDICT) {
      say(`    ${pad(x.symbol + " " + x.tf, 18)}TOO FEW TO JUDGE — ${x.v.resolved} resolved, floor is ${MIN_FOR_VERDICT}`);
    } else if (x.delta === null) {
      say(`    ${pad(x.symbol + " " + x.tf, 18)}NO BASELINE — cannot pair, so no verdict`);
    } else if (x.delta > 0) {
      say(`    ${pad(x.symbol + " " + x.tf, 18)}TIGHTER STOP AHEAD by ${fx(x.delta, 4)}R/trade over ${x.v.resolved} paired rows`);
    } else {
      say(`    ${pad(x.symbol + " " + x.tf, 18)}TIGHTER STOP BEHIND by ${fx(Math.abs(x.delta), 4)}R/trade over ${x.v.resolved} paired rows`);
    }
  }
  const skipped = Object.entries(reasons).map(([k, v]) => `${k} ${v}`).join(", ");
  if (skipped) say(`\n  not scored: ${skipped}`);

  say("");
  say("  Forgone PAPER geometries: no spread, no slippage, no fill. Evidence about stop SCALE");
  say("  and resolution SPEED, never realised P&L. Never merge with get_performance, and where");
  say("  this disagrees with a walk-forward the walk-forward wins. AMBIGUOUS rows are excluded");
  say("  from the mean rather than guessed. feedsTheGate is false.");
  say("=".repeat(96));

  if (EMIT) writeReport(out);
}

function writeReport(out) {
  const logPath = path.join(PROJECT_ROOT, "tasks", "logs", "stop_variant_scores.txt");
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, out.join("\n") + "\n\n", "utf8");
    console.log(`\nappended to ${logPath}`);
  } catch (e) {
    console.error(`could not append report: ${e.message}`);
  }
}

try { main(); } catch (e) {
  console.error(`UNHANDLED: ${e && e.stack ? e.stack : e}`);
  process.exitCode = 1;
}
