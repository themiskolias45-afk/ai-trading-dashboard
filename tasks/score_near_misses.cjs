#!/usr/bin/env node
'use strict';
/**
 * Price the RSI ceiling: when it blocked a setup, did price then go the way that setup
 * would have gone?
 *
 * THE CEILING IS THE BINDING CONSTRAINT on how often this system trades - 4 of 4
 * near-misses on 2026-08-27, 24 of 24 on 2026-08-22 - and it is the ONLY blocker with no
 * rejection-ledger row, so unlike CONFIDENCE (EARNING ITS KEEP, -5.12R over 23 priced
 * rejections) it has never had a verdict of any kind from live data. This gives it one.
 *
 * ── WHY THIS IS A FORWARD-RETURN STUDY AND NOT A TRADE SIMULATION ───────────────────
 *
 * A near miss has NO entry/stop/target triple. That is deliberate: REJECTION-LEDGER-SPEC
 * rule 3.1 requires a FORMED setup, and a setup the ceiling blocked never formed. So the
 * levels do not exist and CANNOT be recovered - only invented.
 *
 * Inventing them would mean re-deriving the engine's stop rule outside the engine, which
 * is a second implementation of generateSignal that can silently disagree with the first.
 * This project already has a memory of exactly that shape: two replay harnesses that named
 * different assets. So this deliberately measures something SMALLER and true instead:
 *
 *     at the moment the ceiling blocked a LONG setup, what did price do next?
 *
 * The direction is not a guess. MOMENTUM and TREND_FOLLOW are both LONG setups, and
 * RSI_ABOVE_CEILING is an OVERBOUGHT veto - it can only ever block a long. So a blocked
 * setup is a forgone BUY, structurally.
 *
 * Returns are measured in ATR UNITS, not per cent and not R, so three instruments at very
 * different volatilities can be compared without pooling a Gold move with a BTC move - the
 * bug that once inverted the sign of a pooled CRT result.
 *
 * WHAT THIS CAN AND CANNOT SAY.
 *   CAN: whether the population the ceiling blocks drifted UP or DOWN afterwards, and by
 *        how much relative to its own volatility.
 *   CANNOT: what a trade would have returned. There is no stop, so there is no R, no
 *        win rate and no expectancy. Any sentence here containing "R" would be invented.
 * A positive drift means the ceiling is blocking moves that continued. It is a REASON TO
 * MEASURE with rsi_ceiling_walkforward.cjs, never on its own a reason to move the ceiling.
 * feedsTheGate is false.
 *
 * Usage:
 *   node tasks/score_near_misses.cjs [--input PATH] [--horizon 20] [--emit] [--rows]
 */

const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = path.join(__dirname, "..");
const ARCHIVE_DIR  = path.join(PROJECT_ROOT, "tasks", "history");

function strArg(f, d) { const i = process.argv.indexOf(f); return (i === -1 || i + 1 >= process.argv.length) ? d : process.argv[i + 1]; }
function numArg(f, d) { const i = process.argv.indexOf(f); if (i === -1 || i + 1 >= process.argv.length) return d; const v = Number(process.argv[i + 1]); return Number.isFinite(v) ? v : d; }

const INPUT     = strArg("--input", path.join(PROJECT_ROOT, "tasks", "near_misses.jsonl"));
const HORIZON   = numArg("--horizon", 20);   // bars of the blocked setup's own timeframe
const EMIT      = process.argv.includes("--emit");
const SHOW_ROWS = process.argv.includes("--rows");
const MIN_FOR_VERDICT = numArg("--min", 5);

const TF_SECONDS = { d1: 86400, h4: 14400, h1: 3600, m15: 900 };
const ATR_PERIOD = 14;

// The census keys on sourceSymbol, so BOTH the broker symbol and its Yahoo twin appear.
// Only the broker series is scored: the engine trades XAUUSD, not GC=F, and the two
// genuinely present different structure - GC=F found 30 CRT patterns where XAUUSD found
// 52 on the same window. Scoring the proxy would answer a question about a different
// instrument. Yahoo rows are counted and reported, never silently dropped.
const BROKER_SYMBOLS = new Set(["BTCUSD", "XAUUSD", "SP500"]);

function loadArchive(symbol, timeframe) {
  const file = path.join(ARCHIVE_DIR, `${symbol}_${timeframe.toUpperCase()}.csv`);
  try {
    if (!fs.existsSync(file)) return null;
    const lines = fs.readFileSync(file, "utf8").trim().split(/\r?\n/);
    if (lines.length < 3) return null;
    const h = lines[0].split(",").map(x => x.trim());
    const iT = h.indexOf("time"), iH = h.indexOf("high"), iL = h.indexOf("low"), iC = h.indexOf("close");
    if ([iT, iH, iL, iC].some(i => i === -1)) return null;
    const times = [], highs = [], lows = [], closes = [];
    let prev = -Infinity;
    for (let i = 1; i < lines.length; i++) {
      const r = lines[i].split(",");
      const t = Number(r[iT]), hi = Number(r[iH]), lo = Number(r[iL]), c = Number(r[iC]);
      if (![t, hi, lo, c].every(Number.isFinite)) continue;
      if (t <= prev) continue;
      prev = t;
      times.push(t); highs.push(hi); lows.push(lo); closes.push(c);
    }
    return closes.length < 50 ? null : { times, highs, lows, closes };
  } catch (e) { return null; }
}
const cache = new Map();
function barsFor(sym, tf) { const k = sym + "|" + tf; if (!cache.has(k)) cache.set(k, loadArchive(sym, tf)); return cache.get(k); }

/** The engine's ATR - a SIMPLE MEAN of the last n true ranges (index.js:1138), not Wilder. */
function engineAtr(bars, endIndex, period) {
  const n = period || ATR_PERIOD;
  if (endIndex < n + 1) return null;
  const tr = [];
  for (let i = Math.max(1, endIndex - n * 3); i <= endIndex; i++) {
    tr.push(Math.max(bars.highs[i] - bars.lows[i],
                     Math.abs(bars.highs[i] - bars.closes[i - 1]),
                     Math.abs(bars.lows[i] - bars.closes[i - 1])));
  }
  if (tr.length < n) return null;
  const w = tr.slice(-n);
  const avg = w.reduce((a, b) => a + b, 0) / n;
  return avg > 0 ? avg : null;
}

function indexAtOrAfter(times, epoch) {
  let lo = 0, hi = times.length - 1, found = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (times[m] >= epoch) { found = m; hi = m - 1; } else lo = m + 1; }
  return found;
}

function pad(v, w) { return String(v).padEnd(w); }
function fx(v, d) { return (v === null || v === undefined || !Number.isFinite(v)) ? "-" : v.toFixed(d); }
function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function main() {
  const out = [];
  const say = (l) => { out.push(l); console.log(l); };

  say("=".repeat(96));
  say(`  NEAR-MISS FORWARD RETURN  ${new Date().toISOString()}   horizon ${HORIZON} bars`);
  say("  What price did AFTER the RSI ceiling blocked a long. Measured in ATR units.");
  say("  NOT a trade simulation: a blocked setup has no stop, so there is no R and no win rate.");
  say("=".repeat(96));

  if (!fs.existsSync(INPUT)) {
    say(`\n  No ledger at ${INPUT} yet - nothing to score.`);
    if (EMIT) writeReport(out);
    return;
  }

  const lines = fs.readFileSync(INPUT, "utf8").split("\n").filter(l => l.trim());
  const rows = []; let malformed = 0;
  for (const l of lines) { try { rows.push(JSON.parse(l)); } catch (e) { malformed++; } }
  say(`\n  ledger rows: ${rows.length}${malformed ? `  (${malformed} malformed, kept on disk, skipped)` : ""}`);

  const now = Math.floor(Date.now() / 1000);
  const scored = [];
  const skipped = {};
  const bump = (k) => { skipped[k] = (skipped[k] || 0) + 1; };

  for (const row of rows) {
    if (row.condition !== "RSI_ABOVE_CEILING") { bump("not a ceiling block"); continue; }
    if (!BROKER_SYMBOLS.has(row.symbol)) { bump("Yahoo proxy row (not scored by design)"); continue; }
    const tf = String(row.timeframe || "").toLowerCase();
    if (!TF_SECONDS[tf]) { bump("unknown timeframe"); continue; }

    const at = Date.parse(row.at);
    if (!Number.isFinite(at)) { bump("unparseable timestamp"); continue; }
    const startEpoch = Math.floor(at / 1000);
    if (now < startEpoch + HORIZON * TF_SECONDS[tf]) { bump("PENDING - horizon not elapsed"); continue; }

    const bars = barsFor(row.symbol, tf);
    if (!bars) { bump("no archive series"); continue; }
    const i0 = indexAtOrAfter(bars.times, startEpoch);
    if (i0 === -1 || i0 + HORIZON >= bars.closes.length) { bump("window not covered by archive"); continue; }

    const atr = engineAtr(bars, i0, ATR_PERIOD);
    if (!atr) { bump("ATR not computable"); continue; }

    const entry = bars.closes[i0];
    const exit  = bars.closes[i0 + HORIZON];
    // A blocked ceiling setup is a forgone LONG, structurally - the ceiling is an
    // overbought veto and both ceiled setups are long-only.
    const moveAtr = (exit - entry) / atr;
    // Also the best and worst excursion, because a drift that only happened after a deep
    // drawdown is not the same fact as a clean one.
    let bestAtr = -Infinity, worstAtr = Infinity;
    for (let i = i0; i <= i0 + HORIZON; i++) {
      bestAtr  = Math.max(bestAtr,  (bars.highs[i] - entry) / atr);
      worstAtr = Math.min(worstAtr, (bars.lows[i]  - entry) / atr);
    }
    scored.push({ row, tf, moveAtr, bestAtr, worstAtr, margin: row.margin, atr, entry, exit });
  }

  if (SHOW_ROWS && scored.length) {
    say("");
    say(`  ${pad("date", 12)}${pad("sym", 8)}${pad("tf", 5)}${pad("setup", 14)}${pad("margin", 9)}` +
        `${pad("move ATR", 10)}${pad("best", 9)}worst`);
    for (const s of scored) {
      say(`  ${pad(s.row.date, 12)}${pad(s.row.symbol, 8)}${pad(s.tf, 5)}${pad(s.row.setup, 14)}` +
          `${pad(fx(s.margin, 2), 9)}${pad(fx(s.moveAtr, 3), 10)}${pad(fx(s.bestAtr, 2), 9)}${fx(s.worstAtr, 2)}`);
    }
  }

  if (!scored.length) {
    say("\n  Nothing scorable yet.");
    for (const [k, v] of Object.entries(skipped)) say(`    ${pad(k, 40)}${v}`);
    say("\n  A row becomes scorable only once its horizon has elapsed in real time AND the");
    say("  archive covers the window. Re-run once the ledger has a few days on it.");
    if (EMIT) writeReport(out);
    return;
  }

  // Per symbol x setup, so a Gold result never hides inside a BTC one.
  const cells = new Map();
  for (const s of scored) {
    const k = `${s.row.symbol}|${s.row.setup}`;
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(s);
  }

  say("");
  say(`  ${pad("symbol", 9)}${pad("setup", 15)}${pad("n", 5)}${pad("median", 10)}${pad("mean", 10)}` +
      `${pad("% up", 8)}${pad("med best", 10)}med worst`);
  const verdicts = [];
  for (const [k, list] of cells) {
    const [symbol, setup] = k.split("|");
    const moves = list.map(x => x.moveAtr);
    const med = median(moves);
    const mean = moves.reduce((a, b) => a + b, 0) / moves.length;
    const up = moves.filter(x => x > 0).length / moves.length * 100;
    say(`  ${pad(symbol, 9)}${pad(setup, 15)}${pad(list.length, 5)}${pad(fx(med, 3), 10)}` +
        `${pad(fx(mean, 3), 10)}${pad(fx(up, 1), 8)}${pad(fx(median(list.map(x => x.bestAtr)), 2), 10)}` +
        `${fx(median(list.map(x => x.worstAtr)), 2)}`);
    verdicts.push({ symbol, setup, n: list.length, med, mean, up });
  }

  say("");
  say("  VERDICT");
  say("  " + "-".repeat(92));
  for (const v of verdicts) {
    const label = pad(v.symbol + " " + v.setup, 24);
    if (v.n < MIN_FOR_VERDICT) {
      say(`    ${label}TOO FEW TO JUDGE - ${v.n} scored, floor is ${MIN_FOR_VERDICT}`);
    } else if (v.med > 0.1) {
      say(`    ${label}BLOCKED MOVES CONTINUED UP - median ${fx(v.med, 3)} ATR over ${v.n}. ` +
          `Worth a walk-forward, not a config change.`);
    } else if (v.med < -0.1) {
      say(`    ${label}BLOCKED MOVES FELL - median ${fx(v.med, 3)} ATR over ${v.n}. The ceiling looks earned.`);
    } else {
      say(`    ${label}NO MEASURABLE DRIFT - median ${fx(v.med, 3)} ATR over ${v.n}, inside the noise.`);
    }
  }
  const sk = Object.entries(skipped).map(([k, v]) => `${k} ${v}`).join("; ");
  if (sk) say(`\n  not scored: ${sk}`);

  say("");
  say("  There is no stop here, so there is no R, no win rate and no expectancy - any such");
  say("  number would be invented. A positive drift is a REASON TO MEASURE with");
  say("  tasks/rsi_ceiling_walkforward.cjs, never on its own a reason to move the ceiling.");
  say("  feedsTheGate is false.");
  say("=".repeat(96));
  if (EMIT) writeReport(out);
}

function writeReport(out) {
  const p = path.join(PROJECT_ROOT, "tasks", "logs", "near_miss_scores.txt");
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, out.join("\n") + "\n\n", "utf8");
    console.log(`\nappended to ${p}`);
  } catch (e) { console.error(`could not append report: ${e.message}`); }
}

try { main(); } catch (e) {
  console.error(`UNHANDLED: ${e && e.stack ? e.stack : e}`);
  process.exitCode = 1;
}
