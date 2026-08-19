'use strict';
/**
 * Does a nearby CRT make the engine's OWN trades better?
 *
 * WHY THIS AND NOT THE TEST THAT ALREADY FAILED. tasks/crt_as_setup_walkforward.cjs
 * asked whether CRT works as a NEW ENGINE SETUP and was rejected 0/5 folds
 * (e59157b). That commit named its own flaw: injecting CRT into the setup chain
 * sets the daily leg, which moves steps out of the H4_ONLY cohort into DAILY+H4,
 * changes confidence scoring, and DISPLACED 16 Gold trades while adding 3. It
 * concluded a truly additive test "would have to enter as its own timeframe leg".
 *
 * This is that test, in the only form that cannot displace anything: CRT as a
 * CONFIDENCE CONTRIBUTOR. It never sets a signal, never names a setup, never
 * touches cohort classification. It asks one question of the trades the engine
 * ALREADY takes:
 *
 *     given the engine fired, does a confirmed same-direction CRT nearby predict
 *     a better realised R than its absence?
 *
 * That is a pure PARTITION of the existing trade list. Both subsets come from one
 * unmodified replay, so no trade is created, moved or removed by the measurement,
 * and the displacement that invalidated the setup test is structurally impossible
 * here.
 *
 * READ-ONLY. It shells out to tasks/_replay_mtf.cjs against the real project root
 * and reads tasks/history/*.csv. server/index.js is never modified, no live
 * setting is read for writing, and nothing it does can affect trading.
 *
 * ── NO LOOK-AHEAD, in two places ─────────────────────────────────────────────
 *
 * 1. Detection is POINT-IN-TIME. detectCRT scales its sweep threshold off the
 *    average range of the LAST 20 bars it is given, so running it once over the
 *    whole series would score a 2019 pattern using 2026 volatility. Instead it is
 *    re-run on a trailing window ending at each bar, and only a pattern completing
 *    on that final bar is recorded.
 * 2. Joining is AS-OF. A trade at H4 time t is matched only against daily bars
 *    that had CLOSED by the moment the engine decided, which _replay_mtf.cjs
 *    defines as t + H4_SEC. Same rule, copied deliberately rather than
 *    re-derived — the harness it joins to had a look-ahead bug at exactly this
 *    line once (comparing OPEN times), and the two must not drift apart.
 *
 * Usage:
 *   node tasks/crt_confluence.cjs [--folds 5] [--gate 70] [--cost 0.05]
 */

const fs   = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const { detectCRT } = require(path.join(ROOT, "server", "structure.js"));

// ── contract with _replay_mtf.cjs ────────────────────────────────────────────
const D1_SEC = 86400;
const H4_SEC = 14400;

// Trailing bars handed to the detector at each step. Must comfortably exceed
// RANGE_SAMPLE_BARS (20) inside structure.js or the sweep threshold is scaled off
// too few bars; large enough to be stable, small enough that the scaling is local.
const DETECT_WINDOW = 100;

// How many daily bars back a completed CRT may be and still count as "nearby".
// Swept rather than chosen: a value picked by eye is a fitted parameter wearing a
// comment. K = 1 means the CRT completed on the last closed daily bar.
const NEARBY_BARS_SWEEP = [1, 2, 3, 5, 8];

// Below this many co-occurrences a cell reports TOO FEW TO JUDGE and is not
// wired, per tasks/CRT-CONTRIBUTOR-SPEC.md. No pooling across assets to reach it:
// cross-instrument pooling produced a sign error in this project once already.
const MIN_JOINT_SAMPLE = 30;

// Assets replayed. BTC is measured but flagged: CRT is dead there on its own
// evidence (0/5 folds at 10% cost, break-even $29.91 = 0.047% of price, inside
// ordinary crypto CFD spreads). Measuring it costs nothing and the co-occurrence
// count is informative; wiring it is not on the table whatever this prints.
const ASSETS = [
  { symbol: "XAUUSD", ticker: "GC=F",   wireable: true  },
  { symbol: "SP500",  ticker: "^GSPC",  wireable: true  },
  { symbol: "BTCUSD", ticker: "BTC-USD", wireable: false },
];

function numArg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  if (i === -1 || i + 1 >= process.argv.length) return fallback;
  const value = Number(process.argv[i + 1]);
  return Number.isFinite(value) ? value : fallback;
}

const FOLDS = Math.max(2, numArg("--folds", 5));
const GATE  = numArg("--gate", liveGate());

// Cost is charged identically to both subsets, so it cannot change the DELTA that
// decides this — it is applied only so the printed levels are comparable with the
// other MTF harnesses, which all use 0.05R. Note this is a FLAT R cost, unlike
// crt_walkforward.cjs which charges a fraction of bar range: there the stop sits at
// the sweep extreme and is often tiny, here the stop is the ENGINE's own, so the
// two cost models describe different trades and must not be swapped.
const COST_R = numArg("--cost", 0.05);

function liveGate() {
  const settingsPath = path.join(ROOT, "server", "strategy_settings.json");
  try {
    if (fs.existsSync(settingsPath)) {
      const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      if (Number.isFinite(parsed.confidenceThreshold)) return parsed.confidenceThreshold;
    }
  } catch (err) {
    process.stderr.write(`[crt-confluence] could not read strategy_settings.json (${err.message}) — using 70\n`);
  }
  return 70;
}

// ── bars ─────────────────────────────────────────────────────────────────────
// Same CSV shape and the same OPEN-time convention as _replay_mtf.cjs loadBars.
function loadDailyBars(symbol) {
  const csvPath = path.join(ROOT, "tasks", "history", `${symbol}_D1.csv`);
  if (!fs.existsSync(csvPath)) return { error: `missing ${path.relative(ROOT, csvPath)}` };

  const lines = fs.readFileSync(csvPath, "utf8").trim().split(/\r?\n/);
  if (lines.length < 2) return { error: "empty history file" };

  const header = lines[0].split(",").map(s => s.trim().toLowerCase());
  const timeCol = header.indexOf("time");
  const highCol = header.indexOf("high");
  const lowCol  = header.indexOf("low");
  const closeCol = header.indexOf("close");
  if (timeCol < 0 || highCol < 0 || lowCol < 0 || closeCol < 0) {
    return { error: "header missing time/high/low/close" };
  }

  const times = [], highs = [], lows = [], closes = [];
  for (const line of lines.slice(1)) {
    const fields = line.split(",");
    const t = Number(fields[timeCol]);
    const h = Number(fields[highCol]);
    const l = Number(fields[lowCol]);
    const c = Number(fields[closeCol]);
    if (![t, h, l, c].every(Number.isFinite)) continue;
    times.push(t); highs.push(h); lows.push(l); closes.push(c);
  }
  if (times.length < DETECT_WINDOW + 2) return { error: `only ${times.length} usable daily bars` };
  return { times, highs, lows, closes };
}

// ── point-in-time CRT detection ──────────────────────────────────────────────
// Returns an array parallel to the daily bars: entry k holds the direction of a
// confirmed CRT that COMPLETED on bar k, or null. Detection sees only bars up to
// and including k, which is what makes it usable as a live contributor at all.
function detectCompletionsPerBar(bars) {
  const completions = new Array(bars.closes.length).fill(null);
  for (let k = DETECT_WINDOW; k < bars.closes.length; k++) {
    const from = k - DETECT_WINDOW + 1;
    const windowBars = {
      highs:  bars.highs.slice(from, k + 1),
      lows:   bars.lows.slice(from, k + 1),
      closes: bars.closes.slice(from, k + 1),
    };
    // maxPatterns 1 is sufficient: patterns are returned sorted by barsAgo, so the
    // first is the newest, and only barsAgo === 0 — a pattern completing on this
    // very bar — is a new completion rather than one already recorded earlier.
    const found = detectCRT(windowBars, { maxPatterns: 1 });
    const newest = found.patterns[0];
    if (newest && newest.barsAgo === 0) completions[k] = newest.direction;
  }
  return completions;
}

// ── replay ───────────────────────────────────────────────────────────────────
// MTF_EMIT_R=1 makes _replay_mtf.cjs emit realisedR without arming the trailing
// ladder, so both subsets are scored by a MEASURED R rather than one being
// inferred from `outcome`. Comparing a derived number against a measured one is
// how a backtest flatters itself.
function replayTrades(symbol, ticker) {
  const stdout = execFileSync(
    process.execPath,
    [path.join(ROOT, "tasks", "_replay_mtf.cjs"), ROOT, symbol, ticker, String(GATE)],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, MTF_EMIT_R: "1" } }
  );
  const trades = JSON.parse(stdout);
  if (!Array.isArray(trades)) throw new Error("replay did not return an array");
  const scorable = trades.filter(t => Number.isFinite(t.realisedR) && Number.isFinite(t.t));
  if (scorable.length !== trades.length) {
    process.stderr.write(`[crt-confluence] ${symbol}: ${trades.length - scorable.length} trades lacked realisedR\n`);
  }
  return scorable;
}

// ── join ─────────────────────────────────────────────────────────────────────
// The newest daily bar that had CLOSED when the engine decided this trade. Mirrors
// the asOf rule in _replay_mtf.cjs exactly; returns -1 when no daily bar qualifies.
function newestClosedDailyIndex(times, tradeTime) {
  const asOf = tradeTime + H4_SEC;
  let index = -1;
  for (let k = 0; k < times.length; k++) {
    if (times[k] + D1_SEC <= asOf) index = k; else break;
  }
  return index;
}

function directionMatches(crtDirection, tradeDirection) {
  if (crtDirection === "bullish") return tradeDirection === "BUY";
  if (crtDirection === "bearish") return tradeDirection === "SELL";
  return false;
}

function hasNearbyCRT(completions, dailyIndex, nearbyBars, tradeDirection) {
  if (dailyIndex < 0) return false;
  const oldest = Math.max(0, dailyIndex - nearbyBars + 1);
  for (let k = dailyIndex; k >= oldest; k--) {
    if (completions[k] && directionMatches(completions[k], tradeDirection)) return true;
  }
  return false;
}

// ── scoring ──────────────────────────────────────────────────────────────────
function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

// Sequential disjoint folds over the CHRONOLOGICAL trade list. Nothing is fitted
// on one fold and tested on another — there is no parameter to fit in a partition
// — so folds measure consistency across regimes, which is the failure mode that
// matters: an "edge" that is one good stretch and four flat ones.
function splitIntoFolds(trades, foldCount) {
  const ordered = trades.slice().sort((a, b) => a.t - b.t);
  const perFold = Math.floor(ordered.length / foldCount);
  if (perFold === 0) return [];
  const folds = [];
  for (let f = 0; f < foldCount; f++) {
    const from = f * perFold;
    const to = f === foldCount - 1 ? ordered.length : from + perFold;
    folds.push(ordered.slice(from, to));
  }
  return folds;
}

function scoreCell(trades, completions, times, nearbyBars) {
  const tagged = trades.map(trade => ({
    ...trade,
    netR: trade.realisedR - COST_R,
    withCRT: hasNearbyCRT(completions, newestClosedDailyIndex(times, trade.t), nearbyBars, trade.dir),
  }));

  const agreeing = tagged.filter(t => t.withCRT);
  const absent   = tagged.filter(t => !t.withCRT);

  const folds = splitIntoFolds(tagged, FOLDS).map(fold => {
    const foldAgree  = fold.filter(t => t.withCRT).map(t => t.netR);
    const foldAbsent = fold.filter(t => !t.withCRT).map(t => t.netR);
    return {
      agreeMean: mean(foldAgree),
      absentMean: mean(foldAbsent),
      agreeCount: foldAgree.length,
      absentCount: foldAbsent.length,
    };
  });

  // A fold with no CRT-agreeing trade cannot vote. Counting it as a loss would
  // punish the hypothesis for a fold that says nothing about it, and counting it
  // as a win is obviously worse.
  const judgeable = folds.filter(f => f.agreeMean !== null && f.absentMean !== null);
  const better = judgeable.filter(f => f.agreeMean > f.absentMean).length;
  const worstAgree  = judgeable.length ? Math.min(...judgeable.map(f => f.agreeMean))  : null;
  const worstAbsent = judgeable.length ? Math.min(...judgeable.map(f => f.absentMean)) : null;

  let verdict;
  if (agreeing.length < MIN_JOINT_SAMPLE) {
    verdict = `TOO FEW TO JUDGE (${agreeing.length} < ${MIN_JOINT_SAMPLE})`;
  } else if (judgeable.length === 0) {
    verdict = "TOO FEW TO JUDGE (no fold has both subsets)";
  } else if (better > judgeable.length / 2 && worstAgree > worstAbsent) {
    verdict = `PASS — better in ${better}/${judgeable.length} folds and worst fold ahead`;
  } else if (better > judgeable.length / 2) {
    verdict = `REJECT — better in ${better}/${judgeable.length} folds but worst fold BEHIND`;
  } else {
    verdict = `REJECT — better in only ${better}/${judgeable.length} folds`;
  }

  return {
    agreeCount: agreeing.length,
    absentCount: absent.length,
    agreeMean: mean(agreeing.map(t => t.netR)),
    absentMean: mean(absent.map(t => t.netR)),
    folds, judgeable: judgeable.length, better, worstAgree, worstAbsent, verdict,
  };
}

// ── report ───────────────────────────────────────────────────────────────────
function fmt(value) {
  if (value === null || value === undefined) return "    —  ";
  return (value >= 0 ? "+" : "") + value.toFixed(3);
}

const out = [];
function say(line = "") { out.push(line); console.log(line); }

say("CRT AS A CONFIDENCE CONTRIBUTOR — confluence walk-forward");
say(`${FOLDS} folds · gate ${GATE} · cost ${COST_R}R/trade · detector window ${DETECT_WINDOW} daily bars`);
say("Partition of the engine's OWN trades. Nothing is added, moved or removed, so");
say("the displacement that invalidated crt_as_setup_walkforward.cjs cannot occur.");
say("Read-only — server/index.js is not touched and no live setting changes.");
say();

let anyCellPassed = false;
let cellsTested = 0;
const failures = [];

for (const asset of ASSETS) {
  const bars = loadDailyBars(asset.symbol);
  if (bars.error) {
    say(`  ${asset.symbol.padEnd(7)} SKIPPED — ${bars.error}`);
    failures.push(`${asset.symbol}: ${bars.error}`);
    say();
    continue;
  }

  let trades;
  try {
    trades = replayTrades(asset.symbol, asset.ticker);
  } catch (err) {
    // Never let one asset's failure read as "this asset had no trades". That exact
    // confusion hid SPX from every replay in this project for weeks.
    const detail = (err.stderr && String(err.stderr).trim().split("\n").pop()) || err.message;
    say(`  ${asset.symbol.padEnd(7)} FAILED — replay error: ${detail}`);
    failures.push(`${asset.symbol}: replay failed — ${detail}`);
    say();
    continue;
  }

  const completions = detectCompletionsPerBar(bars);
  const completionCount = completions.filter(Boolean).length;

  say(`  ${asset.symbol} (${asset.ticker})${asset.wireable ? "" : "  [NOT WIREABLE — CRT dead here on prior evidence]"}`);
  say(`    ${trades.length} engine trades · ${completionCount} confirmed CRT completions in ${bars.closes.length} daily bars`);
  say(`    nearby   withCRT  without   n(with)  n(without)  folds  verdict`);

  const cells = NEARBY_BARS_SWEEP.map(nearbyBars => scoreCell(trades, completions, bars.times, nearbyBars));
  cells.forEach((cell, index) => {
    say(`    K=${String(NEARBY_BARS_SWEEP[index]).padEnd(2)}     ${fmt(cell.agreeMean)}   ${fmt(cell.absentMean)}`
      + `    ${String(cell.agreeCount).padStart(5)}      ${String(cell.absentCount).padStart(5)}`
      + `     ${cell.better}/${cell.judgeable}   ${cell.verdict}`);
  });
  cellsTested += cells.length;

  // MULTIPLICITY. Sweeping five values of K and wiring whichever one passes is
  // fitting the parameter to the answer. A real effect does not appear at exactly
  // one window and vanish either side of it, so a lone PASS is treated as noise:
  // it counts only if an ADJACENT K passes too. This is not conservatism for its
  // own sake — with 5 windows x 2 wireable assets, one spurious PASS is the
  // EXPECTED outcome of pure noise, not a surprise.
  const stablePasses = [];
  cells.forEach((cell, index) => {
    if (!cell.verdict.startsWith("PASS")) return;
    const neighbourPasses = [cells[index - 1], cells[index + 1]]
      .some(neighbour => neighbour && neighbour.verdict.startsWith("PASS"));
    if (neighbourPasses) stablePasses.push(NEARBY_BARS_SWEEP[index]);
  });
  const lonePasses = cells
    .map((cell, index) => (cell.verdict.startsWith("PASS") ? NEARBY_BARS_SWEEP[index] : null))
    .filter(k => k !== null && !stablePasses.includes(k));

  if (lonePasses.length > 0) {
    say(`    ISOLATED PASS at K=${lonePasses.join(",")} — no adjacent window agrees, so this is`);
    say(`    read as noise from sweeping ${NEARBY_BARS_SWEEP.length} windows, not as an effect.`);
  }
  if (asset.wireable && stablePasses.length > 0) {
    anyCellPassed = true;
    say(`    STABLE PASS across K=${stablePasses.join(",")}.`);
  }
  say();
}

say("  VERDICT");
if (failures.length > 0) {
  say(`    INCOMPLETE — ${failures.length} asset(s) did not measure:`);
  for (const failure of failures) say(`      ${failure}`);
  say("    Do not read the cells above as a full picture.");
}
say(`    ${cellsTested} cells tested across ${ASSETS.length} assets.`);
say(anyCellPassed
  ? "    A wireable cell passed STABLY across adjacent windows. Phase 2 wiring may proceed for it."
  : "    No wireable cell passed stably. CRT stays observability-only and NOTHING is wired.");
say();
say("  Nothing here changed a live setting.");

const logPath = path.join(ROOT, "tasks", "logs", "crt_confluence.txt");
try {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, out.join("\n") + "\n", "utf8");
  console.log(`\n  written: ${path.relative(ROOT, logPath)}`);
} catch (err) {
  console.error(`[crt-confluence] could not write ${logPath}: ${err.message}`);
}

// Exit 1 only on a measurement that could not complete. A clean REJECT is a
// successful run — the harness did its job and the answer was no.
process.exit(failures.length > 0 ? 1 : 0);
