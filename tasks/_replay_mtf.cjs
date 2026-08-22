// Replays exported MT5 bars through generateSignalMTF - the multi-timeframe path
// that actually runs live - rather than through generateSignal alone.
//
// tasks/_replay_engine.cjs only extracts generateSignal, so it measures single
// timeframe entries. evaluate_change.py says as much at lines 45-48: anything
// living in generateSignalMTF "cannot be seen" by that replay. The strength
// banding change lives exactly there, so it needs this.
//
//   node mtf_replay.cjs <proj-root> <SYMBOL> <ticker> <tradeThreshold>
//
// Prints JSON: the trades AUTO mode would have opened when a signal must reach
// `tradeThreshold` confidence to carry a tradeable strength.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const [, , ROOT, SYMBOL, TICKER, THRESH_RAW] = process.argv;
if (!ROOT || !SYMBOL || !TICKER || !THRESH_RAW) {
  console.error("usage: node mtf_replay.cjs <root> <SYMBOL> <ticker> <tradeThreshold>");
  process.exit(1);
}
const TRADE_THRESHOLD = Number(THRESH_RAW);

// ── extract the engine out of server/index.js ────────────────────────────────
const serverSrc = fs.readFileSync(path.join(ROOT, "server", "index.js"), "utf8");

function extractBlock(startMarker) {
  const start = serverSrc.indexOf(startMarker);
  if (start === -1) return "";
  let i = serverSrc.indexOf("{", start);
  let depth = 0;
  for (let j = i; j < serverSrc.length; j++) {
    if (serverSrc[j] === "{") depth++;
    else if (serverSrc[j] === "}") {
      depth--;
      if (depth === 0) return serverSrc.slice(start, j + 1);
    }
  }
  return "";
}

const NEEDED = [
  "function emaSeries", "function calcRSI", "function calcBB", "function calcMACD",
  "function atr(", "function wilderSmooth", "function calcADX",
  "function findSwingLow", "function findSwingHigh",
  "function calcPivots", "function getCurrentSession",
  "function generateSignal(", "function generateSignalMTF(",
];

// Top-level scalar consts the extracted functions REFERENCE but that live outside
// every block in NEEDED. extractBlock() brace-matches, so it cannot pick these up:
// `const X = 75;` has no braces and matching from it would run to the next unrelated
// `{` and capture garbage.
//
// Missing one is not a small problem. SIZING_BOOST_MIN_CONFIDENCE is read at
// index.js:1271 inside generateSignalMTF, on Gold's isDailyNeutralH4 branch. Without
// it in the sandbox that branch threw ReferenceError, the caller's catch swallowed
// it, and 1131 of 6225 Gold steps vanished from every replay - 18% of the asset's
// history, and precisely the cohort the code comment calls "largest cohort in the
// system". BTC and SPX were unaffected because `ticker === "GC=F"` short-circuits
// first, so the harness looked healthy on two assets out of three. The signature was
// tasks/analysis/walkforward-latest.json reporting exactly 260 Gold trades.
//
// Read from source rather than hardcoded on purpose: a literal copied to here would
// silently drift the day someone retunes the server, reintroducing the same class of
// bug with no error.
const SCALAR_CONSTS = [
  "SIZING_BOOST_MIN_CONFIDENCE",
  "STRUCTURAL_STOP_MIN_ATR",
  "GOLD_SQUEEZE_MODERATE_CONFIDENCE",
  // Added 2026-08-09 with the EMA seeding guard. emaSeries reads it, so omitting
  // it threw on every step of all three assets — 6225/9101/6211 — and the
  // DEGRADED banner below is the only reason that surfaced instead of reading as
  // "no trades produced". Exactly the failure this list exists to prevent.
  "EMA_SMA_SEED_MIN_MULTIPLE",
  // Added 2026-08-12. index.js:1849 reads it unconditionally on the SPX H4-only
  // branch, so its absence threw on 1114 SP500 steps and the asset dropped OUT of
  // every replay entirely — cohort_walkforward, regime_xtab and the time heatmap all
  // silently measured two assets out of three. Nothing in their headline output said
  // so: the failure went to stderr while stdout carried a complete-looking table.
  // Third occurrence of this exact bug, which is why the list is read from source and
  // why callers must check perAsset for an `error` key rather than trusting the total.
  "SPX_H4_ONLY_BLOCKED_FLOOR",
];

let code = "";
for (const name of SCALAR_CONSTS) {
  const m = serverSrc.match(new RegExp(`^const\\s+${name}\\s*=\\s*([^;]+);`, "m"));
  if (!m) {
    console.error(`could not extract const ${name} from server/index.js — refusing to ` +
                  `replay, because a missing const throws inside the engine and the ` +
                  `result silently looks like "this cohort never traded".`);
    process.exit(1);
  }
  code += `const ${name} = ${m[1].trim()};\n`;
}
for (const marker of NEEDED) {
  const block = extractBlock(marker);
  if (!block) { console.error(`could not extract ${marker}`); process.exit(1); }
  code += block + "\n";
}

// Live strategy settings, so the confidence gate matches the running server.
let settings = { confidenceThreshold: 65, minStrength: "MODERATE", minEntryRsi: 0 };
try {
  const p = path.join(ROOT, "server", "strategy_settings.json");
  if (fs.existsSync(p)) Object.assign(settings, JSON.parse(fs.readFileSync(p, "utf8")));
} catch (_) { /* defaults fine */ }

// MEASUREMENT-ONLY override. Nothing on disk is touched; this only changes the
// copy handed to the sandbox for this one replay.
//
// Without it the harness cannot see below the live gate at all. generateSignalMTF
// returns signal:"WAIT" for anything under strategySettings.confidenceThreshold
// (index.js:1276), so the `tradeThreshold` argument can only ever make the gate
// STRICTER than 65 - every value below it produces an identical trade list. That
// makes the sub-65 cohorts, which is where the "why does it never fire" question
// lives, permanently invisible. Lower this to expose them, e.g. MTF_CONF_FLOOR=40.
if (process.env.MTF_CONF_FLOOR) {
  const floor = Number(process.env.MTF_CONF_FLOOR);
  if (Number.isFinite(floor)) settings.confidenceThreshold = floor;
}

// MEASUREMENT-ONLY override for the entry-RSI floor, same contract as the gate
// above: nothing on disk changes, only this replay's copy.
//
// This one CANNOT be applied by filtering the resulting trade list, which is how
// mtf_walkforward.cjs sweeps confidence. The gate lives inside generateSignal and
// therefore runs on the daily AND 4H signals independently, so raising it does not
// merely delete rows — it changes which multi-timeframe combinations form at all.
// A daily signal suppressed by the floor turns an agreeing pair into an H4-only
// entry with different levels. Sweeping it honestly means re-running the replay per
// value, which is what tasks/rsi_walkforward.cjs does.
if (process.env.MTF_MIN_ENTRY_RSI) {
  const floor = Number(process.env.MTF_MIN_ENTRY_RSI);
  if (Number.isFinite(floor)) settings.minEntryRsi = floor;
}

// MEASUREMENT-ONLY override for the two RSI CEILINGS, same contract again: nothing on
// disk changes, only this replay's copy of the settings object.
//
// These are the bars MOMENTUM and TREND_FOLLOW must sit UNDER, and until now no harness
// could move them: they were literals inside generateSignal, so the single condition
// that blocks more setups than anything else on this engine — 24 of 24 near-misses on
// 2026-08-22, the closest by 1.5 points — could not be tested at all.
//
// Swept by re-replaying, never by filtering the output, for the same reason as the floor
// directly above: the ceiling is inside generateSignal and runs on the daily and 4H
// signals independently, so changing it changes which multi-timeframe combinations form,
// not merely which rows survive.
if (process.env.MTF_MOMENTUM_RSI_MAX) {
  const ceiling = Number(process.env.MTF_MOMENTUM_RSI_MAX);
  if (Number.isFinite(ceiling)) settings.momentumRsiMax = ceiling;
}
if (process.env.MTF_TREND_FOLLOW_RSI_MAX) {
  const ceiling = Number(process.env.MTF_TREND_FOLLOW_RSI_MAX);
  if (Number.isFinite(ceiling)) settings.trendFollowRsiMax = ceiling;
}

// MEASUREMENT-ONLY override for the DAILY_ONLY_H4_NEUTRAL cohort floor.
//
// Unlike minEntryRsi this one COULD be approximated by filtering the output — it
// applies at the final gate in generateSignalMTF, after the cohort is already
// decided, so it only ever removes rows. It is still swept by re-replaying,
// because removing a trade frees the occupancy window (`openUntil`) and lets a
// later signal through that was previously blocked. Filtering afterwards would
// miss those, and on this engine they are not rare: the census reports 2270 steps
// blocked by an open position on BTC and 2549 on SPX.
if (process.env.MTF_DAILY_ONLY_MIN_CONF) {
  const floor = Number(process.env.MTF_DAILY_ONLY_MIN_CONF);
  if (Number.isFinite(floor)) settings.dailyOnlyMinConfidence = floor;
}

// MEASUREMENT-ONLY override for the ADX trending floor. Same contract: nothing on
// disk changes, only this replay's copy of the settings.
//
// Re-replayed rather than filtered, because adxTrendingMin does not delete rows —
// it decides which setups are allowed to form and whether one is STRONG or
// MODERATE, and strength feeds confidence, which feeds the gate. There is no field
// on the emitted trade that a filter could reconstruct that from.
if (process.env.MTF_ADX_TRENDING_MIN) {
  const floor = Number(process.env.MTF_ADX_TRENDING_MIN);
  if (Number.isFinite(floor)) settings.adxTrendingMin = floor;
}

// MEASUREMENT-ONLY override for the minimum R:R bar.
//
// This one cannot go through `settings`, because MIN_RR is not a setting. It is a
// literal, and there are TWO of them in the engine: `const MIN_RR = 1.5` inside
// generateSignal, which rejects the setup outright, and a bare `refinedRR < 1.5` in
// generateSignalMTF, which decides whether the pivot-refined stop and target are
// kept. (sizing.js holds a third and the AI-filter prompt a fourth, but neither is
// on this replay's path.) Rewriting only the first would measure a lower bar that
// still discards its own refined levels — a different engine from the one the
// number is supposed to describe.
//
// So the substitution is textual, on the extracted source, before it is compiled.
// It is verified rather than trusted: each pattern must match EXACTLY once or the
// replay refuses to run. A silently failed substitution is the dangerous outcome
// here — it reports the baseline under a different label, which reads as "the R:R
// bar makes no difference" when in fact it was never moved.
// PER-DIRECTION R:R bar. A global MIN_RR move was already measured and rejected
// (lowering to 1.35 buys 3 trades in 4 years and costs 6.6R), but the rejection
// ledger says the constraint is wrong in ONE DIRECTION ONLY: on the VPS sample of
// 86 resolved episodes, RANGE_TRADE_LONG rejections would have gone 59W/11L and
// BUY_OVERSOLD 8W/0L, while RANGE_TRADE_SHORT went 0W/8L. Rejecting longs costs
// money; rejecting shorts saves it. A blanket change takes both, which is very
// likely why the global sweep came out negative.
//
// Substituted at the USE sites rather than the declarations, because that is where
// the direction is in scope: `signal` at the generateSignal check, `daily.signal`
// at the pivot-refine check. Same discipline as MTF_MIN_RR below — each pattern
// must match EXACTLY once or the replay refuses, because a silently failed
// substitution reports the baseline under a candidate's label.
//
// REPLAY ONLY. server/index.js is untouched; this measures a split bar without
// shipping one.
if (process.env.MTF_MIN_RR_LONG || process.env.MTF_MIN_RR_SHORT) {
  if (process.env.MTF_MIN_RR) {
    console.error("MTF_MIN_RR cannot be combined with MTF_MIN_RR_LONG/SHORT — " +
                  "one would silently overwrite the other.");
    process.exit(1);
  }
  const longRr  = Number(process.env.MTF_MIN_RR_LONG);
  const shortRr = Number(process.env.MTF_MIN_RR_SHORT);
  if (!Number.isFinite(longRr) || longRr <= 0 || !Number.isFinite(shortRr) || shortRr <= 0) {
    console.error(`MTF_MIN_RR_LONG=${process.env.MTF_MIN_RR_LONG} / ` +
                  `MTF_MIN_RR_SHORT=${process.env.MTF_MIN_RR_SHORT} must both be positive numbers.`);
    process.exit(1);
  }
  const dirPatterns = [
    { name: "generateSignal calcRR check", re: /calcRR < MIN_RR/g,
      to: `calcRR < (signal === "SELL" ? ${shortRr} : ${longRr})` },
    { name: "generateSignalMTF pivot refine", re: /refinedRR < ([\d.]+)/g,
      to: `refinedRR < (daily.signal === "SELL" ? ${shortRr} : ${longRr})` },
  ];
  for (const p of dirPatterns) {
    const matches = [...code.matchAll(p.re)];
    if (matches.length !== 1) {
      console.error(`MTF_MIN_RR_LONG/SHORT: expected exactly one "${p.name}" in the extracted ` +
                    `engine, found ${matches.length}. Fix this harness rather than reporting ` +
                    `a number it did not measure.`);
      process.exit(1);
    }
    code = code.replace(p.re, p.to);
  }
}

if (process.env.MTF_MIN_RR) {
  const wanted = Number(process.env.MTF_MIN_RR);
  if (!Number.isFinite(wanted) || wanted <= 0) {
    console.error(`MTF_MIN_RR=${process.env.MTF_MIN_RR} is not a positive number — refusing ` +
                  `to replay. Ignoring it would report the baseline under this label.`);
    process.exit(1);
  }

  const patterns = [
    { name: "generateSignal const MIN_RR", re: /const MIN_RR = ([\d.]+);/g, to: `const MIN_RR = ${wanted};` },
    { name: "generateSignalMTF pivot refine", re: /refinedRR < ([\d.]+)/g, to: `refinedRR < ${wanted}` },
  ];
  const found = [];
  for (const p of patterns) {
    const matches = [...code.matchAll(p.re)];
    if (matches.length !== 1) {
      console.error(`MTF_MIN_RR: expected exactly one "${p.name}" in the extracted engine, ` +
                    `found ${matches.length}. The engine has changed shape; fix this harness ` +
                    `rather than reporting a number it did not measure.`);
      process.exit(1);
    }
    found.push(Number(matches[0][1]));
    code = code.replace(p.re, p.to);
  }
  if (found[0] !== found[1]) {
    console.error(`MTF_MIN_RR: the two copies of the R:R bar in server/index.js disagree ` +
                  `(${found[0]} vs ${found[1]}). That is a live bug, not a harness one — ` +
                  `report it before trusting any sweep of this parameter.`);
  }
  settings.minRrReplayed = wanted;
}

// MEASUREMENT-ONLY minimum distance between entry and a PIVOT-refined stop.
//
// generateSignal already floors the OTHER stop-tightening path: a structural swing
// stop is only adopted when it is at least STRUCTURAL_STOP_MIN_ATR (0.5) ATR from
// entry, because without that floor "one SPX trade came out at R/R 55.24 and
// contributed +55.2R of a +39.5R cohort total" — a division artifact that flipped the
// cohort's sign. That reasoning was never carried across to the pivot refinement in
// generateSignalMTF, which adopts pivots.s1/r1 with no lower bound at all. Observed
// live 2026-08-14: Gold entry 4334.84, ATR 94.69, the setup's own stop 4192.80
// (1.5 ATR) replaced by pivot S1 4312.85 — a 21.99pt stop, 0.23 ATR, below even the
// floor the structural path already enforces, with the reported R:R going 2.0 -> 3.8.
//
// The engine's own guard cannot catch this: `refinedRR < 1.5` reverts the refinement
// only when the ratio is too LOW, and tightening the stop RAISES the ratio. It
// protects against target-shortening and nothing else.
//
// Cannot be swept by filtering the output. Stop distance sets `risk`, which sets `rr`,
// which decides both the `rr < 1` drop and the WIN/LOSS walk forward — and every taken
// trade occupies the symbol via openUntil, so refusing one tightening lets a different
// signal through later. Each value needs its own replay.
//
// "inf" / "off" means no pivot stop is ever adopted, i.e. the refinement's stop half
// disabled — the honest "what if we never tightened" baseline. A null daily.atr leaves
// behaviour UNCHANGED, so this knob can only ever refuse a tightening it can measure.
//
// REPLAY ONLY. server/index.js is untouched; unset leaves the extracted source
// byte-identical, which is what keeps the two-box output-hash check valid.
if (process.env.MTF_PIVOT_MIN_ATR) {
  const raw = String(process.env.MTF_PIVOT_MIN_ATR).trim().toLowerCase();
  const wanted = (raw === "inf" || raw === "off") ? Infinity : Number(raw);
  if (!(wanted >= 0)) {
    console.error(`MTF_PIVOT_MIN_ATR=${process.env.MTF_PIVOT_MIN_ATR} must be a ` +
                  `non-negative number, or "inf"/"off" to disable the pivot stop ` +
                  `entirely — refusing to replay, because ignoring it would report ` +
                  `the baseline under this label.`);
    process.exit(1);
  }
  const floorExpr = wanted === Infinity ? "Infinity" : String(wanted);
  const pivotPatterns = [
    { name: "generateSignalMTF BUY pivot stop",
      re: /if \(pivots\.s1 > daily\.stop && pivots\.s1 < daily\.entry\) refinedStop = pivots\.s1;/g,
      to: `if (pivots.s1 > daily.stop && pivots.s1 < daily.entry && ` +
          `(daily.atr === null || daily.atr === undefined || ` +
          `Math.abs(daily.entry - pivots.s1) >= daily.atr * ${floorExpr})) refinedStop = pivots.s1;` },
    { name: "generateSignalMTF SELL pivot stop",
      re: /if \(pivots\.r1 < daily\.stop && pivots\.r1 > daily\.entry\) refinedStop = pivots\.r1;/g,
      to: `if (pivots.r1 < daily.stop && pivots.r1 > daily.entry && ` +
          `(daily.atr === null || daily.atr === undefined || ` +
          `Math.abs(daily.entry - pivots.r1) >= daily.atr * ${floorExpr})) refinedStop = pivots.r1;` },
  ];
  for (const p of pivotPatterns) {
    const matches = [...code.matchAll(p.re)];
    if (matches.length !== 1) {
      console.error(`MTF_PIVOT_MIN_ATR: expected exactly one "${p.name}" in the extracted ` +
                    `engine, found ${matches.length}. The engine has changed shape; fix this ` +
                    `harness rather than reporting a number it did not measure.`);
      process.exit(1);
    }
    code = code.replace(p.re, p.to);
  }
  settings.pivotMinAtrReplayed = wanted === Infinity ? "inf" : wanted;
}

// Macro caches are empty and the learning boost is zero. Historical DXY/VIX/
// Fear-and-Greed readings are not in the export, and setupStats is {} on the live
// box anyway - so this measures the engine's own confidence, unmodified. Stated
// plainly because it means the +/-5..12 macro adjustments are NOT simulated.
const sandbox = {
  strategySettings: settings,
  priceCache: {},
  sentimentCache: {},
  signalCache: {},
  getLearningBoost: () => 0,
  // The rejection ledger, stubbed out. generateSignal and generateSignalMTF call
  // logGateRejection on every killed setup and noteGatePass on every survivor, but
  // the real ones live in server/rejection_log.js — outside every block this
  // harness extracts, closing over fs, path and module-level Maps, none of which
  // exist in this sandbox. Without these stubs each call is a ReferenceError, the
  // catch below swallows it, and the step disappears from the replay.
  //
  // This has already happened twice and cost real measurements. Measured
  // 2026-08-06 on the predecessor of this stub (logRrRejection): 1006 dropped steps
  // on XAUUSD alone — exactly the population whose R:R was marginal, the one any
  // sweep of MIN_RR is trying to measure. Before that, a missing
  // SIZING_BOOST_MIN_CONFIDENCE deleted 1131 Gold steps, 18% of the asset's
  // history. The engine's call sites are additionally typeof-guarded so a missing
  // binding degrades to a no-op rather than a deletion, but that guard is a safety
  // net, not a substitute for stubbing: keep these in step with the engine.
  //
  // noteGatePass matters MORE than the rejection stub, not less. It runs on the
  // PASS path, i.e. on nearly every step that forms a setup, so an unstubbed
  // version would not shave a marginal cohort — it would gut the whole replay.
  //
  // No-ops are correct, not shortcuts: the replay must never append to the live
  // evidence file. Writing there would contaminate real rejections with thousands
  // of synthetic ones and destroy the dataset's provenance. The counters are
  // equally worthless here — a census of 5 years of replayed steps says nothing
  // about whether a gate is live right now.
  logGateRejection: () => false,
  noteGatePass: () => {},
  console,
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const generateSignalMTF = sandbox.generateSignalMTF;
// Also needed to label WHICH branch of the confidence ladder produced a step.
// generateSignalMTF computes the daily and 4H signals internally but does not
// expose which one it used, and that is the whole question when the engine fires
// once a fortnight.
const generateSignal = sandbox.generateSignal;

// ── bars ─────────────────────────────────────────────────────────────────────
function loadBars(tf) {
  const p = path.join(ROOT, "tasks", "history", `${SYMBOL}_${tf}.csv`);
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, "utf8").trim().split(/\r?\n/);
  const head = lines[0].split(",").map(s => s.trim().toLowerCase());
  const idx = name => head.indexOf(name);
  const iT = idx("time"), iO = idx("open"), iH = idx("high"), iL = idx("low"), iC = idx("close");
  const iV = head.findIndex(h => h.includes("volume"));
  return lines.slice(1).map(line => {
    const f = line.split(",");
    return {
      t: +f[iT], o: +f[iO], h: +f[iH], l: +f[iL], c: +f[iC],
      v: iV >= 0 ? +f[iV] : 0,
    };
  }).filter(b => Number.isFinite(b.t) && Number.isFinite(b.c));
}

const d1 = loadBars("D1");
const h4 = loadBars("H4");
const h1 = loadBars("H1");
if (d1.length < 250 || h4.length < 300 || h1.length < 100) {
  console.error(`${SYMBOL}: not enough bars (D1=${d1.length} H4=${h4.length} H1=${h1.length})`);
  process.exit(1);
}

const WINDOW   = 400;   // trailing bars per timeframe; EMA200 needs ~210
const MAX_HOLD = 40;    // H4 bars, same as tasks/_replay_engine.cjs

// ── Trailing-stop ladder, OFF by default ──────────────────────────────────────
//
// The live ladder in mt5_bridge.py arms at 1R and then trails 1R behind price in
// 0.5R steps. It went live on 2026-08-07 unmeasured, which is the open question it
// was shipped with: tightening a trail buys a higher win rate and pays for it by
// capping the runners, and nothing here had ever scored that trade-off.
//
// Gated on MTF_TRAIL_LADDER so the DEFAULT run stays byte-identical. Both boxes are
// verified equal by comparing this script's output hash, and silently changing the
// baseline would destroy that check.
//
// Values mirror TRAIL_ARM_R / TRAIL_STEP_R / TRAIL_GIVEBACK_R in mt5_bridge.py.
const TRAIL_LADDER   = process.env.MTF_TRAIL_LADDER === "1";
// Emit realisedR without arming the ladder, so the fixed-stop baseline and the
// trailed run are scored by the same field instead of one being inferred from
// `outcome` and the other measured. Comparing a derived number against a measured
// one is how a trailing backtest flatters itself.
const EMIT_R         = TRAIL_LADDER || process.env.MTF_EMIT_R === "1";
const TRAIL_ARM_R    = Number(process.env.MTF_TRAIL_ARM_R      || "1.0");
const TRAIL_STEP_R   = Number(process.env.MTF_TRAIL_STEP_R     || "0.5");
// 0.5 to match the shipped bridge default — see the walk-forward table in
// mt5_bridge.py. A harness whose default disagrees with the engine measures a
// configuration nothing is running.
const TRAIL_GIVEBACK = Number(process.env.MTF_TRAIL_GIVEBACK_R || "0.5");
const TRAIL_EPSILON  = 1e-9;   // same float-dust guard as the bridge

if (TRAIL_LADDER && !(TRAIL_STEP_R > 0)) {
  console.error(`MTF_TRAIL_STEP_R=${process.env.MTF_TRAIL_STEP_R} must be positive — refusing to run`);
  process.exit(1);
}

// Where the ladder puts the stop for a trade currently `profitR` in front. Returns
// null below the arm level. Floored, so it only ever locks in profit already made.
function ladderStop(entry, risk, profitR, isBuy) {
  if (profitR < TRAIL_ARM_R - TRAIL_EPSILON) return null;
  const steps  = Math.floor((profitR - TRAIL_ARM_R) / TRAIL_STEP_R + TRAIL_EPSILON);
  const locked = Math.max(steps * TRAIL_STEP_R + TRAIL_ARM_R - TRAIL_GIVEBACK, 0);
  return isBuy ? entry + locked * risk : entry - locked * risk;
}

// Bar durations, used to turn a stored OPEN timestamp into a CLOSE timestamp.
// Everything below advances on close times. The previous version compared OPEN
// times (`d1[d1Ptr + 1].t <= h4[i].t`), which put the pointer on the daily bar
// that had merely STARTED - so an 08:00 H4 step read a daily close, high and low
// covering the rest of that same day. That is look-ahead, and it landed hardest
// on the daily-driven cohorts, which are exactly the 72-95 confidence ones.
const D1_SEC = 86400, H4_SEC = 14400, H1_SEC = 3600;

function slice(bars, endIdx) {
  const from = Math.max(0, endIdx - WINDOW + 1);
  const w = bars.slice(from, endIdx + 1);
  return { closes: w.map(b => b.c), highs: w.map(b => b.h), lows: w.map(b => b.l), volumes: w.map(b => b.v) };
}

// ── replay ───────────────────────────────────────────────────────────────────
// One position per symbol at a time: a new signal cannot open while the previous
// trade is still running. This matters because the two bandings are compared by
// re-running the whole loop - a trade the lower band opens occupies the asset and
// blocks a later entry, so the two runs are NOT filterable from one list.
// Census of every step the replay could have traded on, grouped by which branch
// of the confidence ladder produced it. Without this the harness can only answer
// "what would threshold X have traded", never "why is the engine silent".
const census = {};
let stepsBlockedByOpenPosition = 0;
// A step where the engine itself threw. Reported, never hidden — see the catch below.
let engineThrows = 0;
let firstEngineThrow = "";

function noteStep(cohort, conf, fired) {
  const c = census[cohort] || (census[cohort] = {
    steps: 0, fired: 0, maxConf: 0, sumConf: 0,
    hist: { "0": 0, "1-39": 0, "40-49": 0, "50-59": 0, "60-64": 0, "65-74": 0, "75-89": 0, "90+": 0 },
  });
  c.steps++;
  if (fired) c.fired++;
  if (conf > c.maxConf) c.maxConf = conf;
  c.sumConf += conf;
  const b = conf === 0 ? "0" : conf < 40 ? "1-39" : conf < 50 ? "40-49" : conf < 60 ? "50-59"
          : conf < 65 ? "60-64" : conf < 75 ? "65-74" : conf < 90 ? "75-89" : "90+";
  c.hist[b]++;
}

function cohortOf(dailySig, h4Sig) {
  const dWait = !dailySig || dailySig.signal === "WAIT";
  const hWait = !h4Sig   || h4Sig.signal   === "WAIT";
  if (!dWait && !hWait) return dailySig.signal === h4Sig.signal ? "DAILY+H4_AGREE" : "DAILY+H4_CONFLICT";
  if (!dWait &&  hWait) return "DAILY_ONLY_H4_NEUTRAL";
  if ( dWait && !hWait) return "H4_ONLY";
  return "BOTH_WAIT";
}

// Read a field from whichever timeframe actually produced the entry. On an H4_ONLY
// cohort the daily signal is WAIT by definition, so its indicators describe a signal
// that was never taken — the same principle entry/stop/target already follow.
// Returns null rather than undefined so the value survives JSON.stringify and shows
// up as a real "missing" bucket downstream instead of vanishing from the object.
function pickTf(cohort, dailySig, h4Sig, read) {
  const source = cohort === "H4_ONLY" ? h4Sig : dailySig;
  if (!source) return null;
  let value;
  try { value = read(source); } catch (_) { return null; }
  if (value === undefined || value === null) return null;
  return typeof value === "number" && !Number.isFinite(value) ? null : value;
}

const trades = [];
let d1Ptr = 0, h1Ptr = 0;
let openUntil = -1;

for (let i = 0; i < h4.length - 1; i++) {
  // The step happens at the CLOSE of this H4 bar - that is the moment the live
  // server would have recomputed - so every other timeframe may only contribute
  // bars that have also closed by then.
  const asOf = h4[i].t + H4_SEC;
  while (d1Ptr + 1 < d1.length && d1[d1Ptr + 1].t + D1_SEC <= asOf) d1Ptr++;
  while (h1Ptr + 1 < h1.length && h1[h1Ptr + 1].t + H1_SEC <= asOf) h1Ptr++;

  if (i < 250 || d1Ptr < 250 || h1Ptr < 60) continue;
  // The pointers land on the newest CLOSED bar, but on a ragged feed even that
  // one may still be open - drop the step rather than peek at a live bar.
  if (d1[d1Ptr].t + D1_SEC > asOf) continue;
  if (h1[h1Ptr].t + H1_SEC > asOf) continue;
  const dailyWin = slice(d1, d1Ptr), h4Win = slice(h4, i), h1Win = slice(h1, h1Ptr);

  let sig, dailySig = null, h4Sig = null;
  try {
    dailySig = generateSignal("replay", TICKER, dailyWin.closes, dailyWin.highs, dailyWin.lows, dailyWin.volumes);
    h4Sig    = generateSignal("replay", TICKER, h4Win.closes,    h4Win.highs,    h4Win.lows,    h4Win.volumes);
    sig = generateSignalMTF("replay", TICKER, dailyWin, h4Win, h1Win, null);
  } catch (err) {
    // Never silent again. This catch hid a ReferenceError for the entire life of the
    // harness and turned a broken cohort into a plausible-looking "it just never
    // traded". Count them, keep the first message, and refuse to report a clean
    // result at the end if any step threw.
    engineThrows++;
    if (!firstEngineThrow) firstEngineThrow = String(err && err.message || err);
    continue;
  }
  if (!sig) continue;

  const cohort = cohortOf(dailySig, h4Sig);
  const conf = sig.confidence ?? 0;
  const fired = sig.signal !== "WAIT" && conf >= TRADE_THRESHOLD
             && sig.stop != null && sig.target != null;
  // Counted on EVERY step, including ones where a position is already open.
  // Gating the census on being flat would describe only the market states that
  // happen to follow a closed trade - and since the high-confidence cohorts hold
  // longest, they would be the most under-counted, which is backwards.
  noteStep(cohort, conf, fired);

  if (!fired) continue;                                // <- the banding under test
  if (i <= openUntil) { stepsBlockedByOpenPosition++; continue; }   // position still open

  const entry = sig.entry, stop = sig.stop, target = sig.target;
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) continue;
  const rr = Math.abs(target - entry) / risk;
  if (rr < 1) continue;

  const isBuy = sig.signal === "BUY";
  let outcome = "EXPIRED";
  let exitIdx = Math.min(h4.length - 1, i + MAX_HOLD);
  // Realised R. Fixed-stop trades are ±1 / +rr and the reader can derive that from
  // `outcome`, but a trailed exit lands anywhere between, so it has to be carried.
  let realisedR = null;
  let liveStop  = stop;

  for (let j = i + 1; j <= exitIdx; j++) {
    const b = h4[j];

    // ORDER MATTERS, and it is the whole reason a trailed backtest can lie.
    //
    // One H4 bar gives a high and a low with no way to know which came first, so
    // the stop is tested against the ADVERSE extreme BEFORE the ladder is allowed
    // to see the favourable one. Ratcheting first would let the stop climb on the
    // strength of a high that may have happened after the low already took the
    // trade out — the trail would be reading the future inside its own bar and
    // every result would come back flatteringly good.
    if (isBuy) {
      if (b.l <= liveStop) {
        outcome   = liveStop > stop ? "TRAILED" : "LOSS";
        realisedR = (liveStop - entry) / risk;
        exitIdx = j; break;
      }
      if (b.h >= target) { outcome = "WIN"; realisedR = rr; exitIdx = j; break; }
    } else {
      if (b.h >= liveStop) {
        outcome   = liveStop < stop ? "TRAILED" : "LOSS";
        realisedR = (entry - liveStop) / risk;
        exitIdx = j; break;
      }
      if (b.l <= target) { outcome = "WIN"; realisedR = rr; exitIdx = j; break; }
    }

    if (TRAIL_LADDER) {
      // Survived the bar — now the favourable extreme may move the stop up.
      const profitR = isBuy ? (b.h - entry) / risk : (entry - b.l) / risk;
      const wanted  = ladderStop(entry, risk, profitR, isBuy);
      if (wanted !== null) {
        liveStop = isBuy ? Math.max(liveStop, wanted) : Math.min(liveStop, wanted);
      }
    }
  }

  if (realisedR === null) {
    // EXPIRED — closed at the last bar's close rather than scored as a full loss,
    // which is what the fixed-stop path already implies by leaving outcome EXPIRED.
    const last = h4[exitIdx];
    realisedR = isBuy ? (last.c - entry) / risk : (entry - last.c) / risk;
  }
  openUntil = exitIdx;

  trades.push({
    t: h4[i].t, dir: sig.signal, setup: sig.setup, conf: sig.confidence,
    strength: sig.strength, h4dir: sig.h4 ? sig.h4.signal : null,
    // Kept as-is so existing readers of this field keep working. `cohort` below
    // is the accurate one - it comes from the daily and 4H signals themselves
    // rather than inferring the branch from a confidence cutoff.
    h4only: sig.h4 && sig.h4.signal !== "WAIT" && sig.setup != null && sig.confidence < 72,
    cohort,
    dailyDir: dailySig ? dailySig.signal : null,
    dailyStrength: dailySig ? dailySig.strength : null,
    h4Strength: h4Sig ? h4Sig.strength : null,
    // Entry RSI, recorded per timeframe and resolved to the one that actually
    // produced the entry. Without this nothing downstream can check an RSI-shaped
    // claim against the LIVE path: the 2026-08-03 analysis found entries below RSI
    // 50 cost -78.4R, but it measured tasks/_replay_engine.cjs — single-timeframe
    // generateSignal — so its population was not the one the MTF gate trades.
    // `rsi` follows the signal timeframe for the same reason entry/stop/target do:
    // on an H4-only cohort the daily is WAIT by definition and its RSI describes a
    // signal that was never taken.
    rsiDaily: dailySig && Number.isFinite(dailySig.indicators?.rsi) ? dailySig.indicators.rsi : null,
    rsiH4:    h4Sig    && Number.isFinite(h4Sig.indicators?.rsi)    ? h4Sig.indicators.rsi    : null,
    rsi: pickTf(cohort, dailySig, h4Sig, s => s.indicators?.rsi),
    // The remaining dimensions the fact pack groups by, resolved to the same
    // timeframe as the entry. tasks/_replay_engine.cjs supplies these today, but it
    // replays single-timeframe generateSignal — a path the live MTF gate can never
    // take — so every regime/ADX/trend conclusion drawn from it describes a
    // different population than the one that trades. Carrying them here is what
    // lets the fact pack move onto the live path without losing dimensions.
    // regime is computed in generateSignalMTF, not in the per-timeframe signal, so
    // it comes off the MTF result. Resolving it through pickTf returned null on
    // every row — caught by checking the populated count rather than assuming.
    regime:    sig.regime ?? null,
    trend:     pickTf(cohort, dailySig, h4Sig, s => s.trend),
    adx:       pickTf(cohort, dailySig, h4Sig, s => s.indicators?.adx),
    bandwidth: pickTf(cohort, dailySig, h4Sig, s => s.indicators?.bb?.bandwidth),
    volRatio:  pickTf(cohort, dailySig, h4Sig, s => s.volume?.ratio),
    rr: Math.round(rr * 100) / 100, outcome,
    // Only under the ladder. Adding a field to the default run would change the
    // output hash the two-box parity check compares, for no benefit to a fixed-stop
    // trade whose R is already implied by `outcome`.
    ...(EMIT_R ? { realisedR: Math.round(realisedR * 1000) / 1000 } : {}),
  });
}

// stdout stays a bare trades array: tasks/compare_banding.py does
// json.loads(out.stdout) and would break on any other shape. The census is
// diagnostic, so it goes to stderr, which that caller reads only when the exit
// code is non-zero.
for (const c of Object.values(census)) {
  c.avgConf = c.steps ? Math.round((c.sumConf / c.steps) * 10) / 10 : 0;
  delete c.sumConf;
}
process.stderr.write("MTF_CENSUS " + JSON.stringify({
  symbol: SYMBOL,
  ticker: TICKER,
  tradeThreshold: TRADE_THRESHOLD,
  confidenceThreshold: settings.confidenceThreshold,
  minStrength: settings.minStrength,
  // Stated on every run so a stored census can never be mistaken for the baseline.
  // null means "engine default, untouched".
  minEntryRsi: settings.minEntryRsi ?? null,
  adxTrendingMin: settings.adxTrendingMin ?? null,
  minRrReplayed: settings.minRrReplayed ?? null,
  pivotMinAtrReplayed: settings.pivotMinAtrReplayed ?? null,
  stubbed: ["priceCache.dxy", "priceCache.vix", "sentimentCache.fearGreed",
            "signalCache (cross-asset)", "getLearningBoost -> 0"],
  windowBars: WINDOW,
  stepsBlockedByOpenPosition,
  engineThrows,
  firstEngineThrow,
  tradesTaken: trades.length,
  census,
}) + "\n");

// A replay where the engine threw is not a measurement — it is a measurement with an
// unknown slice deleted, which reads exactly like "that cohort does not trade". Exit
// non-zero so a caller that checks its exit code cannot mistake it for a clean run.
// The census and trades are still emitted so the failure can be diagnosed.
if (engineThrows > 0) {
  console.error(`MTF_REPLAY DEGRADED: the engine threw on ${engineThrows} step(s). ` +
                `First error: ${firstEngineThrow}. These steps are MISSING from the ` +
                `result below — do not treat it as a complete measurement.`);
}

process.stdout.write(JSON.stringify(trades));

if (engineThrows > 0) process.exitCode = 3;
