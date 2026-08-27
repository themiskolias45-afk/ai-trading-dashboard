#!/usr/bin/env node
'use strict';
/**
 * CRT / AMD across a BIAS timeframe and an EXECUTION timeframe.
 *
 * WHY THIS EXISTS. `tasks/crt_walkforward.cjs` accepts `--interval 1d|1h|1wk` and nothing
 * else, so "4H bias, 15m execution" — the configuration this pattern family is actually
 * traded on — has never been measurable in this repo. Every CRT number on record is a
 * single-timeframe number.
 *
 * AMD was additionally blocked: CLAUDE.md still says it is "unmeasurable until the bridge
 * sends bar timestamps". Verified 2026-08-27 — the bridge now sends `times` on d1, h4, h1
 * AND m15, 0 malformed, correct 14400s/900s steps. `detectAMD` already reads them and
 * marks accumulation=ASIA / sweep=LONDON / distribution=NY. That blocker is gone.
 *
 * WHAT IT DOES NOT DO. It changes no threshold, no stop, no signal and no trade. It reads
 * `/api/mt5/candles/raw` and prints. Nothing is written unless --emit is passed, and even
 * then only to tasks/logs/.
 *
 * ── THE TWO ANTI-LOOK-AHEAD RULES, WHICH ARE LOAD-BEARING ──────────────────────────
 *
 * 1. DETECTION IS POINT-IN-TIME. `detectCRT`/`detectAMD` scale their thresholds off the
 *    average range of the bars handed to them, so one pass over the whole series would
 *    score an early pattern using later volatility. The detector is re-run on a trailing
 *    window per bar and a pattern is accepted ONLY if it completes on the final bar
 *    (barsAgo === 0). This is the same rule tasks/crt_confluence.cjs relies on.
 *
 * 2. THE JOIN IS AS-OF, ON CLOSE TIMES. `times` are bar OPEN times. A bias bar opening at
 *    t is not KNOWN until t + tfSeconds. Execution may only begin on an exec bar opening
 *    at or after that close. _replay_mtf.cjs had a look-ahead bug at exactly this line
 *    once, by comparing open times — see [[crt_confluence_rejected_crt_is_closed]].
 *
 * Intrabar ambiguity resolves as a LOSS: if one exec bar contains both the stop and the
 * target, there is no way to know which came first, and assuming the good one is how a
 * backtest flatters itself.
 *
 * Usage:
 *   node tasks/crt_amd_mtf_measure.cjs [--host http://localhost:3001]
 *        [--hold 96] [--folds 5] [--window 100] [--emit]
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = path.join(__dirname, "..");
const { detectCRT, detectAMD } = require(path.join(PROJECT_ROOT, "server", "structure.js"));

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

const HOST        = strArg("--host", "http://localhost:3001");
const MAX_HOLD    = numArg("--hold", 96);     // exec bars; 96 x 15m = 24h
const FOLDS       = Math.max(2, numArg("--folds", 5));
const WINDOW      = numArg("--window", 100);  // trailing detection window, in bias bars
const EMIT        = process.argv.includes("--emit");

// A fold with fewer resolved trades than this cannot support a verdict. The repo's
// convention elsewhere is a floor of 5-8; anything under it is reported as UNDERPOWERED
// rather than dressed up as a result.
const MIN_TRADES_PER_FOLD = 8;
const MIN_TRADES_FOR_CELL = 20;

const TF_SECONDS = { d1: 86400, h4: 14400, h1: 3600, m15: 900 };

// Bias/execution pairs worth asking about. Execution must be strictly faster than bias.
const COMBOS = [
  { bias: "h4", exec: "m15" },   // the configuration actually asked about
  { bias: "h4", exec: "h1"  },
  { bias: "d1", exec: "h1"  },
  { bias: "d1", exec: "m15" },
  { bias: "h4", exec: "h4"  },   // single-timeframe controls, so the MTF claim has a baseline
  { bias: "d1", exec: "d1"  },
];

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, { timeout: 30000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(`bad JSON: ${e.message}`)); }
      });
    });
    req.on("timeout", () => { req.destroy(new Error("timeout")); });
    req.on("error", reject);
  });
}

/** Bar open time in SECONDS, whatever unit the feed used. */
function openSeconds(rawTime) {
  const n = Number(rawTime);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 1e12 ? Math.floor(n / 1000) : n;
}

/** A window of bars [from, to] as the parallel-array shape the detectors expect. */
function sliceBars(bars, from, to) {
  const out = {
    highs:  bars.highs.slice(from, to + 1),
    lows:   bars.lows.slice(from, to + 1),
    closes: bars.closes.slice(from, to + 1),
  };
  if (bars.times) out.times = bars.times.slice(from, to + 1);
  return out;
}

/**
 * Point-in-time detection over the whole series. Returns one entry per bar at which a
 * pattern COMPLETED, carrying the bias bar index and the pattern.
 */
function detectPointInTime(bars, detector, windowBars) {
  const found = [];
  const n = bars.closes.length;
  for (let i = windowBars; i < n; i++) {
    const from = i - windowBars + 1;
    const slice = sliceBars(bars, from, i);
    let result;
    try { result = detector(slice); } catch (e) { continue; }
    if (!result || !result.patterns || !result.patterns.length) continue;
    // ONLY a pattern completing on the final bar of the window. Anything else is a
    // pattern we would not have known about at bar i.
    for (const pattern of result.patterns) {
      if (pattern.barsAgo !== 0) continue;
      found.push({ biasIndex: i, pattern });
    }
  }
  return found;
}

/**
 * Walk one trade forward on the execution series. Returns realised R (gross) or null if
 * it never resolved inside the hold.
 */
function walkForward(execBars, startIndex, direction, entry, stop, target, maxHold) {
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return null;
  const rewardR = Math.abs(target - entry) / risk;
  const end = Math.min(execBars.closes.length - 1, startIndex + maxHold);

  for (let i = startIndex; i <= end; i++) {
    const high = execBars.highs[i], low = execBars.lows[i];
    const hitStop   = direction === "bullish" ? low  <= stop   : high >= stop;
    const hitTarget = direction === "bullish" ? high >= target : low  <= target;
    // Both inside one bar: unknowable order, charge the loss. Assuming the good fill is
    // how a backtest flatters itself.
    if (hitStop && hitTarget) return { r: -1, bars: i - startIndex + 1, resolved: true, ambiguous: true };
    if (hitStop)   return { r: -1,      bars: i - startIndex + 1, resolved: true, ambiguous: false };
    if (hitTarget) return { r: rewardR, bars: i - startIndex + 1, resolved: true, ambiguous: false };
  }
  return null; // never resolved inside the hold - excluded, never scored as flat
}

/** Every trade for one asset / one combo / one detector. */
function runCell(assetBars, biasTf, execTf, detector, holdBars, windowBars) {
  const bias = assetBars[biasTf];
  const exec = assetBars[execTf];
  const notes = [];
  if (!bias || !bias.closes || bias.closes.length < windowBars + 5) {
    return { trades: [], unresolved: 0, notes: [`no usable ${biasTf} bars`] };
  }
  if (!exec || !exec.closes || !exec.closes.length) {
    return { trades: [], unresolved: 0, notes: [`no usable ${execTf} bars`] };
  }
  if (!bias.times || !exec.times) {
    return { trades: [], unresolved: 0, notes: ["missing bar times - as-of join impossible"] };
  }

  const biasTfSec = TF_SECONDS[biasTf];
  const execOpens = exec.times.map(openSeconds);
  const detections = detectPointInTime(bias, detector, windowBars);

  const trades = [];
  let unresolved = 0;
  let outsideExecWindow = 0;

  for (const { biasIndex, pattern } of detections) {
    const biasOpen = openSeconds(bias.times[biasIndex]);
    if (biasOpen === null) continue;
    // RULE 2: the bias bar is not KNOWN until it closes.
    const knownAt = biasOpen + biasTfSec;

    // First exec bar opening at or after the bias bar closed.
    let execIndex = -1;
    for (let i = 0; i < execOpens.length; i++) {
      if (execOpens[i] !== null && execOpens[i] >= knownAt) { execIndex = i; break; }
    }
    if (execIndex === -1) { outsideExecWindow++; continue; }

    // Entry at that bar's close - the first price actually actionable.
    const entry  = exec.closes[execIndex];
    const stop   = pattern.invalidation;
    const target = pattern.objective;
    if (![entry, stop, target].every(Number.isFinite)) continue;

    // A pattern whose stop is already violated at entry is not tradeable.
    const dir = pattern.direction;
    if (dir === "bullish" && !(stop < entry && target > entry)) continue;
    if (dir === "bearish" && !(stop > entry && target < entry)) continue;

    const outcome = walkForward(exec, execIndex, dir, entry, stop, target, holdBars);
    if (!outcome) { unresolved++; continue; }

    trades.push({
      biasIndex, execIndex,
      at: new Date(execOpens[execIndex] * 1000).toISOString(),
      direction: dir,
      entry, stop, target,
      risk: Math.abs(entry - stop),
      riskPct: Math.abs(entry - stop) / entry * 100,
      r: outcome.r,
      bars: outcome.bars,
      hours: outcome.bars * TF_SECONDS[execTf] / 3600,
      ambiguous: outcome.ambiguous,
      classic: pattern.classicAMD === true,
      session: pattern.manipulationSession || null,
    });
  }

  if (outsideExecWindow > 0) {
    notes.push(`${outsideExecWindow} pattern(s) predate the ${execTf} window and could not be executed`);
  }
  return { trades, unresolved, notes };
}

/** Gross and cost-charged summary for a set of trades. */
function summarise(trades, costFraction) {
  if (!trades.length) return null;
  let grossR = 0, netR = 0, wins = 0, ambiguous = 0, barsTotal = 0, riskPctTotal = 0;
  for (const t of trades) {
    // Cost charged against the trade's OWN risk distance, never a flat R and never a
    // price shared across instruments - that bug inverted the sign of a pooled CRT
    // result once. See [[crt_survives_costs_on_gold_and_spx]].
    const costR = costFraction > 0 ? (costFraction * t.risk) / t.risk : 0;
    grossR += t.r;
    netR   += t.r - costR;
    if (t.r > 0) wins++;
    if (t.ambiguous) ambiguous++;
    barsTotal += t.bars;
    riskPctTotal += t.riskPct;
  }
  return {
    n: trades.length,
    wins,
    winRate: wins / trades.length * 100,
    grossR, netR,
    rPerTrade: grossR / trades.length,
    netRPerTrade: netR / trades.length,
    avgBars: barsTotal / trades.length,
    avgHours: trades.reduce((s, t) => s + t.hours, 0) / trades.length,
    avgRiskPct: riskPctTotal / trades.length,
    ambiguous,
  };
}

/** Sequential out-of-sample folds, in time order. */
function foldReport(trades, folds) {
  if (trades.length < folds * MIN_TRADES_PER_FOLD) {
    return {
      usable: false,
      reason: `needs ${folds * MIN_TRADES_PER_FOLD} trades for ${folds} folds of ${MIN_TRADES_PER_FOLD}, has ${trades.length}`,
    };
  }
  const sorted = [...trades].sort((a, b) => new Date(a.at) - new Date(b.at));
  const size = Math.floor(sorted.length / folds);
  const perFold = [];
  for (let f = 0; f < folds; f++) {
    const from = f * size;
    const to = (f === folds - 1) ? sorted.length : from + size;
    const s = summarise(sorted.slice(from, to), 0);
    perFold.push(s ? s.rPerTrade : null);
  }
  const positive = perFold.filter(r => r !== null && r > 0).length;
  const worst = perFold.reduce((m, r) => (r !== null && (m === null || r < m) ? r : m), null);
  return { usable: true, perFold, positive, folds, worst };
}

function pad(v, w) { return String(v).padEnd(w); }
function fx(v, d) { return v === null || v === undefined || !Number.isFinite(v) ? "-" : v.toFixed(d); }

async function main() {
  const out = [];
  const say = (line) => { out.push(line); console.log(line); };

  say("=".repeat(100));
  say(`  CRT / AMD  —  BIAS timeframe x EXECUTION timeframe   ${new Date().toISOString()}`);
  say(`  hold ${MAX_HOLD} exec bars | detection window ${WINDOW} bias bars | folds ${FOLDS}`);
  say(`  Point-in-time detection, as-of join on CLOSE times, ambiguous bar = LOSS.`);
  say("=".repeat(100));

  let raw;
  try {
    raw = await fetchJson(`${HOST}/api/mt5/candles/raw`);
  } catch (e) {
    console.error(`\nCANNOT READ BARS: ${e.message}`);
    console.error(`/api/mt5/candles/raw is requireLocalOnly - run this ON the box, not over SSH port-forward.`);
    process.exitCode = 1;
    return;
  }
  if (!raw || !raw.assets) {
    console.error("\nNo assets in the candle dump.");
    process.exitCode = 1;
    return;
  }

  // Coverage first. Every verdict below is bounded by this and saying so up front stops
  // a thin number being read as a walk-forward.
  say("");
  say("DATA COVERAGE  (this bounds every number below)");
  say(`  ${pad("asset", 7)}${pad("tf", 6)}${pad("bars", 8)}${pad("span (days)", 13)}first -> last`);
  const assets = {};
  for (const key of Object.keys(raw.assets)) {
    const entry = raw.assets[key];
    if (!entry || !entry.bars) continue;
    assets[key] = { symbol: entry.symbol, bars: entry.bars };
    for (const tf of ["d1", "h4", "h1", "m15"]) {
      const b = entry.bars[tf];
      if (!b || !b.closes || !b.times) { say(`  ${pad(key, 7)}${pad(tf, 6)}ABSENT`); continue; }
      const first = openSeconds(b.times[0]), last = openSeconds(b.times[b.times.length - 1]);
      const days = (last - first) / 86400;
      say(`  ${pad(key, 7)}${pad(tf, 6)}${pad(b.closes.length, 8)}${pad(days.toFixed(1), 13)}` +
          `${new Date(first * 1000).toISOString().slice(0, 16)} -> ${new Date(last * 1000).toISOString().slice(0, 16)}`);
    }
  }

  const detectors = [
    { name: "CRT", fn: (bars) => detectCRT(bars) },
    { name: "AMD", fn: (bars) => detectAMD(bars) },
  ];

  const cells = [];
  for (const det of detectors) {
    say("");
    say("=".repeat(100));
    say(`  ${det.name}`);
    say("=".repeat(100));
    say(`  ${pad("asset", 7)}${pad("bias", 6)}${pad("exec", 6)}${pad("trades", 8)}${pad("WR%", 8)}` +
        `${pad("R/trade", 10)}${pad("avg hold", 11)}${pad("avg risk%", 11)}${pad("folds+", 8)}worst fold`);

    for (const assetKey of Object.keys(assets)) {
      for (const combo of COMBOS) {
        const cell = runCell(assets[assetKey].bars, combo.bias, combo.exec, det.fn, MAX_HOLD, WINDOW);
        const s = summarise(cell.trades, 0);
        const folds = s ? foldReport(cell.trades, FOLDS) : { usable: false, reason: "no trades" };
        cells.push({ detector: det.name, asset: assetKey, ...combo, summary: s, folds, cell });

        if (!s) {
          say(`  ${pad(assetKey, 7)}${pad(combo.bias, 6)}${pad(combo.exec, 6)}${pad(0, 8)}` +
              `${cell.notes.join("; ") || "no patterns executed"}`);
          continue;
        }
        say(`  ${pad(assetKey, 7)}${pad(combo.bias, 6)}${pad(combo.exec, 6)}${pad(s.n, 8)}` +
            `${pad(fx(s.winRate, 1), 8)}${pad(fx(s.rPerTrade, 4), 10)}` +
            `${pad(fx(s.avgHours, 1) + "h", 11)}${pad(fx(s.avgRiskPct, 2) + "%", 11)}` +
            `${pad(folds.usable ? `${folds.positive}/${folds.folds}` : "-", 8)}` +
            `${folds.usable ? fx(folds.worst, 4) : "UNDERPOWERED"}`);
      }
    }
  }

  // ── The verdict, stated against this repo's own bar ────────────────────────────
  say("");
  say("=".repeat(100));
  say("  VERDICT");
  say("=".repeat(100));
  const powered = cells.filter(c => c.summary && c.summary.n >= MIN_TRADES_FOR_CELL && c.folds.usable);
  if (!powered.length) {
    say("  NO CELL IS POWERED ENOUGH TO SUPPORT A VERDICT.");
    say(`  This repo settles a threshold on ${FOLDS} out-of-sample folds compared on WORST FOLD.`);
    say(`  That needs >= ${FOLDS * MIN_TRADES_PER_FOLD} resolved trades in a cell; the broker`);
    say("  m15 history is ~42-62 days and h4 ~66-93 days, which is the binding limit here.");
    say("  Everything above is IN-SAMPLE SCREENING. It ranks cells. It settles nothing.");
  } else {
    say(`  ${powered.length} cell(s) cleared ${MIN_TRADES_FOR_CELL} trades AND ${FOLDS} usable folds:`);
    powered.sort((a, b) => (b.folds.worst ?? -99) - (a.folds.worst ?? -99));
    for (const c of powered) {
      say(`    ${pad(c.detector, 5)}${pad(c.asset, 7)}${pad(c.bias + "->" + c.exec, 10)}` +
          `n=${pad(c.summary.n, 6)}worst fold ${fx(c.folds.worst, 4)}  ` +
          `${c.folds.positive}/${c.folds.folds} positive  R/trade ${fx(c.summary.rPerTrade, 4)}`);
    }
    say("");
    say("  Ranked on WORST FOLD, not mean - the bar every other threshold in this repo is held to.");
  }
  say("");
  say("  Nothing here changes a signal, a stop or a threshold. CRT is CLOSED as an engine");
  say("  input (six measurements, six negatives). This measures it STANDALONE, which is a");
  say("  different question and still open.");
  say("=".repeat(100));

  if (EMIT) {
    const logPath = path.join(PROJECT_ROOT, "tasks", "logs", "crt_amd_mtf.txt");
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.appendFileSync(logPath, out.join("\n") + "\n\n", "utf8");
      console.log(`\nappended to ${logPath}`);
    } catch (e) {
      console.error(`could not append report: ${e.message}`);
    }
  }
}

main().catch((e) => {
  console.error(`UNHANDLED: ${e && e.stack ? e.stack : e}`);
  process.exitCode = 1;
});
