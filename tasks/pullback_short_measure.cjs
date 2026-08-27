#!/usr/bin/env node
'use strict';
/**
 * Should this engine short a pullback INSIDE a daily uptrend?
 *
 * THE QUESTION, and why it is worth asking properly. Gold fell 4599 -> 4570 on
 * 2026-08-27 and the engine produced no SELL. That is not a fault: all three SELL
 * branches require the daily trend NOT to be up.
 *   SELL_BOUNCE           needs inDowntrend, or MIXED below EMA50
 *   RANGE_TRADE_SHORT     needs !inUptrend
 *   SQUEEZE_BREAKOUT SELL needs a breakout DOWN through the lower band
 * So the engine is structurally long-biased while the daily is up, and the one time it
 * did short Gold - RANGE_TRADE_SHORT, 2026-08-07 - it lost 99.10. That is a reason to
 * MEASURE the idea, not a reason to ship it and not a reason to dismiss it.
 *
 * ── THE TEST IS PAIRED, WHICH IS THE WHOLE POINT ────────────────────────────────────
 *
 * At every qualifying moment it scores BOTH directions from the SAME entry with MIRRORED
 * geometry: the SHORT being proposed, and the LONG the engine would actually take. Same
 * bar, same stop distance, same R:R. So this cannot be answered by "it was a bull market"
 * - if the long wins and the short loses at identical moments, that IS the answer, and if
 * both lose the moment itself is bad rather than the direction.
 *
 * DEFINITIONS ARE THE ENGINE'S OWN, not invented here:
 *   uptrend      index.js:1278-1284 - price above EMA200, EMA50 and (for STRONG) EMA20.
 *   stop         index.js:1269 - 1.5x ATR, where ATR is the engine's SIMPLE MEAN of the
 *                last 14 true ranges (index.js:1138), NOT Wilder.
 * Using a "better" ATR or a tidier trend rule would measure a different system.
 *
 * ANTI-LOOK-AHEAD, both rules load-bearing:
 *   1. The daily bias is AS-OF. `times` are bar OPEN times, so a D1 bar opening at t is
 *      not known until t + 86400. The exec bar must open at or after that.
 *   2. EMAs and ATR are computed on bars up to and including the trigger bar only.
 * An exec bar holding both stop and target scores AMBIGUOUS and is EXCLUDED, never
 * resolved in the flattering direction.
 *
 * It changes nothing. Read-only against the archive; no threshold, no stop, no trade.
 *
 * Usage:
 *   node tasks/pullback_short_measure.cjs [--exec h1] [--folds 5] [--rr 2] [--cost 0] [--emit]
 */

const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = path.join(__dirname, "..");
const ARCHIVE_DIR  = path.join(PROJECT_ROOT, "tasks", "history");

function strArg(f, d) { const i = process.argv.indexOf(f); return (i === -1 || i + 1 >= process.argv.length) ? d : process.argv[i + 1]; }
function numArg(f, d) { const i = process.argv.indexOf(f); if (i === -1 || i + 1 >= process.argv.length) return d; const v = Number(process.argv[i + 1]); return Number.isFinite(v) ? v : d; }

const EXEC_TF = strArg("--exec", "h1");
const FOLDS   = Math.max(2, numArg("--folds", 5));
const RR      = numArg("--rr", 2);
const COST_R  = numArg("--cost", 0);          // charged as a fraction of each trade's risk
const HOLD    = numArg("--hold", 96);
const EMIT    = process.argv.includes("--emit");

const ATR_MULT = 1.5;      // index.js:1269
const ATR_N    = 14;       // index.js:1138
const TF_SECONDS = { d1: 86400, h4: 14400, h1: 3600, m15: 900 };
const SYMBOLS = ["XAUUSD", "SP500", "BTCUSD"];
// The pullback cut, swept rather than picked. One threshold would be a cherry.
const RSI_CUTS = [50, 45, 40, 35];
const MIN_PER_FOLD = 8;

function loadCsv(symbol, tf) {
  const file = path.join(ARCHIVE_DIR, `${symbol}_${tf.toUpperCase()}.csv`);
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, "utf8").trim().split(/\r?\n/);
  const h = lines[0].split(",").map(x => x.trim());
  const iT = h.indexOf("time"), iH = h.indexOf("high"), iL = h.indexOf("low"), iC = h.indexOf("close");
  if ([iT, iH, iL, iC].some(i => i === -1)) return null;
  const times = [], highs = [], lows = [], closes = [];
  let prev = -Infinity;
  for (let i = 1; i < lines.length; i++) {
    const r = lines[i].split(",");
    const t = Number(r[iT]), hi = Number(r[iH]), lo = Number(r[iL]), c = Number(r[iC]);
    if (![t, hi, lo, c].every(Number.isFinite) || t <= prev) continue;
    prev = t; times.push(t); highs.push(hi); lows.push(lo); closes.push(c);
  }
  return closes.length < 250 ? null : { times, highs, lows, closes };
}

/** EMA series - same recurrence the engine uses. */
function emaSeries(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length);
  let e = values[0];
  out[0] = e;
  for (let i = 1; i < values.length; i++) { e = values[i] * k + e * (1 - k); out[i] = e; }
  return out;
}

/** Wilder-free RSI matching calcRSI's intent: Wilder smoothing of gains/losses. */
function rsiSeries(closes, period) {
  const n = period || 14;
  const out = new Array(closes.length).fill(null);
  if (closes.length < n + 1) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= n; loss /= n;
  out[n] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (n - 1) + (d > 0 ? d : 0)) / n;
    loss = (loss * (n - 1) + (d < 0 ? -d : 0)) / n;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

/** The ENGINE's ATR: simple mean of the last n true ranges (index.js:1138). */
function atrAt(bars, i, n) {
  if (i < n + 1) return null;
  const tr = [];
  for (let k = i - n + 1; k <= i; k++) {
    tr.push(Math.max(bars.highs[k] - bars.lows[k],
                     Math.abs(bars.highs[k] - bars.closes[k - 1]),
                     Math.abs(bars.lows[k] - bars.closes[k - 1])));
  }
  const avg = tr.reduce((a, b) => a + b, 0) / n;
  return avg > 0 ? avg : null;
}

function walk(bars, start, dir, entry, stop, target, hold) {
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return null;
  const rewardR = Math.abs(target - entry) / risk;
  const last = Math.min(bars.closes.length - 1, start + hold);
  for (let i = start; i <= last; i++) {
    const hitStop   = dir === "LONG" ? bars.lows[i]  <= stop   : bars.highs[i] >= stop;
    const hitTarget = dir === "LONG" ? bars.highs[i] >= target : bars.lows[i]  <= target;
    if (hitStop && hitTarget) return { r: null, ambiguous: true };
    if (hitStop)   return { r: -1,      ambiguous: false };
    if (hitTarget) return { r: rewardR, ambiguous: false };
  }
  if (last <= start) return null;
  const exit = bars.closes[last];
  const moved = dir === "LONG" ? exit - entry : entry - exit;
  return { r: moved / risk, ambiguous: false };
}

function pad(v, w) { return String(v).padEnd(w); }
function fx(v, d) { return (v === null || v === undefined || !Number.isFinite(v)) ? "-" : v.toFixed(d); }

function foldStats(trades, folds) {
  const scored = trades.filter(t => Number.isFinite(t.r));
  if (scored.length < folds * MIN_PER_FOLD) {
    return { usable: false, n: scored.length };
  }
  const sorted = [...scored].sort((a, b) => a.t - b.t);
  const size = Math.floor(sorted.length / folds);
  const per = [];
  for (let f = 0; f < folds; f++) {
    const from = f * size, to = (f === folds - 1) ? sorted.length : from + size;
    const slice = sorted.slice(from, to);
    per.push(slice.reduce((s, x) => s + x.r - COST_R, 0) / slice.length);
  }
  return {
    usable: true, n: sorted.length, per,
    positive: per.filter(x => x > 0).length,
    worst: Math.min(...per),
    mean: sorted.reduce((s, x) => s + x.r - COST_R, 0) / sorted.length,
  };
}

function main() {
  const out = [];
  const say = l => { out.push(l); console.log(l); };

  say("=".repeat(104));
  say(`  SHORT THE PULLBACK INSIDE A DAILY UPTREND?   ${new Date().toISOString()}`);
  say(`  exec ${EXEC_TF} | stop ${ATR_MULT}x ATR(${ATR_N}) engine-style | R:R ${RR} | hold ${HOLD} bars | ${FOLDS} folds | cost ${COST_R}R`);
  say("  PAIRED: the SHORT and the LONG scored from the SAME entry with mirrored geometry.");
  say("=".repeat(104));

  const rows = [];
  for (const symbol of SYMBOLS) {
    const d1 = loadCsv(symbol, "d1");
    const ex = loadCsv(symbol, EXEC_TF);
    if (!d1 || !ex) { say(`  ${symbol}: missing archive series`); continue; }

    const c = d1.closes;
    const e20 = emaSeries(c, 20), e50 = emaSeries(c, 50), e200 = emaSeries(c, 200);
    const exRsi = rsiSeries(ex.closes, 14);

    for (const cut of RSI_CUTS) {
      const shorts = [], longs = [];
      let di = 0;
      for (let i = 250; i < ex.closes.length - 1; i++) {
        const rsi = exRsi[i];
        if (rsi === null || rsi >= cut) continue;          // must be a PULLBACK

        // RULE 1: as-of daily bias. Advance to the last D1 bar CLOSED before this exec bar.
        const t = ex.times[i];
        while (di + 1 < d1.times.length && d1.times[di + 1] + TF_SECONDS.d1 <= t) di++;
        if (d1.times[di] + TF_SECONDS.d1 > t) continue;    // no closed daily yet
        if (di < 200) continue;

        // The ENGINE's uptrend test, on the daily, as of that close.
        const px = c[di];
        const up = px > e200[di] && px > e50[di];
        if (!up) continue;

        const atr = atrAt(ex, i, ATR_N);
        if (!atr) continue;
        const entry = ex.closes[i];
        const dist = atr * ATR_MULT;
        if (!(dist > 0) || i + 1 >= ex.closes.length) continue;

        const s = walk(ex, i + 1, "SHORT", entry, entry + dist, entry - dist * RR, HOLD);
        const l = walk(ex, i + 1, "LONG",  entry, entry - dist, entry + dist * RR, HOLD);
        if (!s || !l) continue;
        shorts.push({ t, r: s.r, amb: s.ambiguous });
        longs.push({ t, r: l.r, amb: l.ambiguous });
      }
      rows.push({ symbol, cut, shorts, longs });
    }
  }

  say("");
  say(`  ${pad("symbol", 9)}${pad("RSI<", 6)}${pad("n", 7)}${pad("SHORT R", 10)}${pad("folds+", 8)}${pad("worst", 10)}` +
      `| ${pad("LONG R", 10)}${pad("folds+", 8)}${pad("worst", 10)}verdict`);

  const verdicts = [];
  for (const r of rows) {
    const sS = foldStats(r.shorts, FOLDS);
    const lS = foldStats(r.longs, FOLDS);
    if (!sS.usable) {
      say(`  ${pad(r.symbol, 9)}${pad(r.cut, 6)}${pad(sS.n, 7)}UNDERPOWERED (needs ${FOLDS * MIN_PER_FOLD})`);
      continue;
    }
    const shortPasses = sS.worst > 0 && sS.positive === FOLDS;
    const verdict = shortPasses ? "SHORT PASSES"
      : (sS.mean > lS.mean ? "short better than long, but fails folds" : "SHORT LOSES to the long");
    say(`  ${pad(r.symbol, 9)}${pad(r.cut, 6)}${pad(sS.n, 7)}${pad(fx(sS.mean, 4), 10)}` +
        `${pad(sS.positive + "/" + FOLDS, 8)}${pad(fx(sS.worst, 4), 10)}| ` +
        `${pad(fx(lS.mean, 4), 10)}${pad(lS.usable ? lS.positive + "/" + FOLDS : "-", 8)}` +
        `${pad(lS.usable ? fx(lS.worst, 4) : "-", 10)}${verdict}`);
    verdicts.push({ ...r, sS, lS, shortPasses });
  }

  say("");
  say("  VERDICT");
  say("  " + "-".repeat(100));
  const passes = verdicts.filter(v => v.shortPasses);
  if (!passes.length) {
    say("  NO CELL PASSES. Not one symbol x pullback-cut has the short positive in every fold");
    say("  with a positive worst fold - the bar every threshold in this repo is held to.");
    const beat = verdicts.filter(v => v.sS.mean > v.lS.mean);
    say(`  Short beat long on MEAN in ${beat.length} of ${verdicts.length} powered cells, and that is`);
    say("  not the bar: a mean that survives while the worst fold does not loses money in the");
    say("  year that matters.");
    say("");
    say("  So the engine refusing to short a pullback inside a daily uptrend is SUPPORTED by");
    say("  five years of this account's own bars. Do not add a counter-trend short.");
  } else {
    for (const v of passes) {
      say(`  PASS  ${v.symbol} RSI<${v.cut}  n=${v.sS.n}  worst ${fx(v.sS.worst, 4)}  ${v.sS.positive}/${FOLDS}  ` +
          `mean ${fx(v.sS.mean, 4)}  (long mean ${fx(v.lS.mean, 4)})`);
    }
    say("");
    say("  A PASS here is a reason to look harder, NOT a reason to ship. It is one harness on");
    say("  paper geometries with no spread and no slippage; re-run with --cost before believing");
    say("  it, and a walk-forward on the live engine still outranks it.");
  }
  say("");
  say("  Paper geometries: no spread, no slippage, entries never filled. AMBIGUOUS bars are");
  say("  excluded, never resolved the flattering way. feedsTheGate is false.");
  say("=".repeat(104));

  if (EMIT) {
    const p = path.join(PROJECT_ROOT, "tasks", "logs", "pullback_short.txt");
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.appendFileSync(p, out.join("\n") + "\n\n", "utf8");
      console.log(`\nappended to ${p}`);
    } catch (e) { console.error(`could not append: ${e.message}`); }
  }
}

try { main(); } catch (e) {
  console.error(`UNHANDLED: ${e && e.stack ? e.stack : e}`);
  process.exitCode = 1;
}
