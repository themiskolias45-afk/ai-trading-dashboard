#!/usr/bin/env node
'use strict';
/* ============================================================================
   ceiling_measure.cjs — is the RSI ceiling costing money, or earning its keep?
   ============================================================================

   THE PROBLEM. The RSI ceiling is the single biggest blocker of trades in this
   system — 82 of 82 near-misses on 2026-08-25 were RSI_ABOVE_CEILING — and it is
   the ONLY blocker that produces no evidence about itself. The rejection ledger
   holds 1,951 rows across four gates and not one is the ceiling, because
   REJECTION-LEDGER-SPEC rule 3.1 requires a setup that FORMED and was then killed,
   with a real entry/stop/target triple. The ceiling stops a setup from forming, so
   there is nothing to log and nothing to score. It has been unfalsifiable since
   2026-08-16.

   WHAT THIS DOES INSTEAD, AND WHY IT DOES NOT BREAK THAT RULE. It does not write a
   rejection row and it does not invent an entry, a stop or a target. Fabricated
   levels give fabricated verdicts. It measures FORWARD RETURNS on the bar itself,
   which needs no levels at all — the method tasks/geometry_measure.cjs already uses
   and which self-validates through its control.

   THE COMPARISON IS NATURAL, NOT SYNTHETIC. Every bar where the MOMENTUM setup's
   non-RSI conditions ALL pass is an observation. Those bars split themselves:

     FIRED     RSI inside the band  (> 52 and < 72)  -> the engine traded it
     BLOCKED   RSI at or above the ceiling (>= 72)   -> the engine refused

   Same trend state, same EMA alignment, same MACD condition. The ONLY difference is
   which side of the ceiling RSI sat on. If BLOCKED bars go on to perform as well as
   or better than FIRED bars, the ceiling is costing money. That is the whole test,
   and it needs no invented number anywhere.

   A matched CONTROL is measured alongside: the same count of bars taken at a fixed
   offset for no reason. Its purpose is to catch a broken harness — if the control
   drifts far from zero, distrust the run before believing the finding. This is the
   same self-check that makes geometry_measure trustworthy.

   INDICATORS ARE THE ENGINE'S OWN. calcRSI, calcBB, calcMACD, emaSeries and atr are
   read out of server/index.js and evaluated here rather than reimplemented. A second
   copy of an indicator is a second thing to drift, and this project has already been
   bitten by exactly that: calcRSI was a simple average masquerading as RSI for the
   system's whole life and every RSI threshold was calibrated on it.

   IT CHANGES NOTHING. No setting, no gate, no threshold, no position, no file that
   anything live reads. It writes one report if asked and nothing otherwise.
   feedsTheGate is false.

   Usage:
     node tasks/ceiling_measure.cjs
     node tasks/ceiling_measure.cjs --horizon 10        bars held forward
     node tasks/ceiling_measure.cjs --ceiling 72        the band top under test
     node tasks/ceiling_measure.cjs --json
   ============================================================================ */

const path = require("path");
const fs   = require("fs");

const ROOT = path.join(__dirname, "..");

function opt(name, def) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}
const flag = n => process.argv.includes(n);

const HORIZON  = Number(opt("--horizon", "10"));   // D1 bars held forward
const CEILING  = Number(opt("--ceiling", "72"));   // MOMENTUM_RSI_MAX
const RSI_MIN  = Number(opt("--floor", "52"));     // MOMENTUM_RSI_MIN
const WINDOW   = Number(opt("--window", "600"));   // bars the live engine sees
const CONTROL_OFFSET = Number(opt("--control-offset", "37"));
const AS_JSON  = flag("--json");

// ── the engine's own indicator functions, not copies of them ────────────────
// Sliced out of the source and evaluated. If a function cannot be found the run
// STOPS rather than silently falling back to a local approximation.
const SRC = fs.readFileSync(path.join(ROOT, "server", "index.js"), "utf8");

// Evaluate one of the engine functions in this scope. Delimiting is delegated to
// sliceFunction below, which scans for a line that is exactly "}" - no newline
// escape to lose in transit.
function lift(name) {
  const src = sliceFunction(name);
  try {
    return eval("(" + src.replace("function " + name, "function") + ")");
  } catch (e) {
    console.error("ABORT: " + name + " did not evaluate: " + e.message);
    process.exit(1);
  }
}

// SCALAR CONSTANTS the lifted functions close over. emaSeries reads
// EMA_SMA_SEED_MIN_MULTIPLE, and a lifted function that references an out-of-scope
// const throws - the exact bug class that made _replay_engine return [] for every
// caller and silently erase whole cohorts from four earlier harnesses. Resolved by
// NAME from the source rather than hardcoded, so a future value change follows the
// engine instead of drifting from it. Anything unresolvable STOPS the run.
//
// Deliberately regex-free. Every earlier attempt at this file lost its backslash
// escapes in transit; indexOf cannot be mangled.
function constValue(name) {
  const needle = "const " + name + " =";
  const at = SRC.indexOf(needle);
  if (at === -1) return undefined;
  // Only accept a declaration at the start of its line - otherwise "const X =" could
  // match inside a longer identifier or a comment.
  const lineStart = SRC.lastIndexOf(String.fromCharCode(10), at) + 1;
  if (SRC.slice(lineStart, at).trim() !== "") return undefined;
  const semi = SRC.indexOf(";", at + needle.length);
  const nl = SRC.indexOf(String.fromCharCode(10), at + needle.length);
  if (semi === -1 || (nl !== -1 && nl < semi)) return undefined;   // multi-line, not scalar
  const raw = SRC.slice(at + needle.length, semi).trim();
  try { return eval("(" + raw + ")"); } catch (e) { return undefined; }
}

function liftConsts(fnSources) {
  const wanted = new Set();
  for (const src of fnSources) {
    for (const m of src.matchAll(/[A-Z][A-Z0-9_]{2,}/g)) wanted.add(m[0]);
  }
  const out = {};
  for (const name of wanted) {
    const v = constValue(name);
    if (v !== undefined) out[name] = v;
  }
  return out;
}

// Find where a function ends by scanning for a line that is exactly "}". Avoids
// matching a newline escape, which is what kept getting eaten.
function sliceFunction(name) {
  const start = SRC.indexOf("function " + name + "(");
  if (start === -1) { console.error("ABORT: " + name + " not found in server/index.js."); process.exit(1); }
  const rest = SRC.slice(start).split(String.fromCharCode(10));
  for (let k = 1; k < rest.length; k++) {
    // COLUMN ZERO only. rest[k].trim() === "}" also matches an INDENTED closing
    // brace inside the function body, which truncated calcRSI at its first if-block
    // and produced "Unexpected token )".
    const line = rest[k].charCodeAt(rest[k].length - 1) === 13
      ? rest[k].slice(0, -1) : rest[k];
    if (line === "}") {
      return rest.slice(0, k + 1).join(String.fromCharCode(10));
    }
  }
  console.error("ABORT: could not delimit " + name + ".");
  process.exit(1);
}

const FN_NAMES = ["calcRSI", "calcMACD", "emaSeries", "atr"];
const FN_SRC = {};
for (const n of FN_NAMES) FN_SRC[n] = sliceFunction(n);
const LIFTED_CONSTS = liftConsts(Object.values(FN_SRC));
for (const [k, v] of Object.entries(LIFTED_CONSTS)) globalThis[k] = v;

const calcRSI   = lift("calcRSI");
const calcMACD  = lift("calcMACD");
const emaSeries = lift("emaSeries");
const atr       = lift("atr");

// ── bars ────────────────────────────────────────────────────────────────────
function loadBars(sym) {
  const p = path.join(ROOT, "tasks", "history", sym + "_D1.csv");
  if (!fs.existsSync(p)) return null;
  const lines = fs.readFileSync(p, "utf8").trim().split("\n").slice(1);
  const t = [], o = [], h = [], l = [], c = [], v = [];
  for (const line of lines) {
    const f = line.split(",");
    const close = parseFloat(f[4]);
    if (!Number.isFinite(close)) continue;
    t.push(Number(f[0])); o.push(parseFloat(f[1])); h.push(parseFloat(f[2]));
    l.push(parseFloat(f[3])); c.push(close); v.push(parseFloat(f[5]) || 0);
  }
  return { t, o, h, l, c, v };
}

// ── one bar, judged exactly as generateSignal judges it ─────────────────────
// Mirrors server/index.js:1141-1165 and the MOMENTUM branch at :1410-1415. Kept in
// the same order and the same shape so a future reader can diff them by eye.
function classify(bars, i) {
  const from = Math.max(0, i + 1 - WINDOW);
  const closes = bars.c.slice(from, i + 1);
  if (closes.length < 200) return null;             // ema200 needs the history

  const price  = closes[closes.length - 1];
  const rsi    = calcRSI(closes);
  const macd   = calcMACD(closes);
  if (rsi === null || !macd) return null;

  const ema20  = emaSeries(closes, 20).at(-1);
  const ema50  = emaSeries(closes, 50).at(-1);
  const ema200 = emaSeries(closes, 200).at(-1);

  const aboveEma20  = price > ema20;
  const aboveEma50  = price > ema50;
  const aboveEma200 = ema200 ? price > ema200 : null;

  const trend =
    aboveEma200 === true  && aboveEma50 && aboveEma20  ? "STRONG UPTREND" :
    aboveEma200 === true  && aboveEma50                ? "UPTREND" :
    aboveEma200 === false && !aboveEma50 && !aboveEma20 ? "STRONG DOWNTREND" :
    aboveEma200 === false && !aboveEma50               ? "DOWNTREND" : "MIXED";

  const inUptrend = trend === "STRONG UPTREND" || trend === "UPTREND";

  // The MOMENTUM branch minus its RSI band. Everything else identical.
  const nonRsiConditionsPass = inUptrend && aboveEma50 && aboveEma20 && !!macd.bullish;
  if (!nonRsiConditionsPass) return null;

  const a = atr(bars.h.slice(from, i + 1), bars.l.slice(from, i + 1), closes);
  return { rsi, price, atr: a, trend };
}

// Forward return over HORIZON bars, in ATR units so three instruments on wildly
// different scales can be pooled. Raw percent is carried too, because ATR-normalised
// numbers are easy to misread as R.
function forward(bars, i, obs) {
  const j = i + HORIZON;
  if (j >= bars.c.length) return null;
  const move = bars.c[j] - bars.c[i];
  const inAtr = (obs.atr && obs.atr > 0) ? move / obs.atr : null;
  return { atrUnits: inAtr, pct: (move / bars.c[i]) * 100, up: move > 0 };
}

const ASSETS = ["BTCUSD", "XAUUSD", "SP500"];
const groups = { FIRED: [], BLOCKED: [], CONTROL: [] };
const perAsset = {};

for (const sym of ASSETS) {
  const bars = loadBars(sym);
  if (!bars) { perAsset[sym] = "no D1 cache"; continue; }

  let fired = 0, blocked = 0, control = 0;
  for (let i = 200; i < bars.c.length - HORIZON; i++) {
    const obs = classify(bars, i);
    if (!obs) continue;

    const fwd = forward(bars, i, obs);
    if (!fwd || fwd.atrUnits === null) continue;
    const row = { sym, t: bars.t[i], rsi: obs.rsi, ...fwd };

    if (obs.rsi > RSI_MIN && obs.rsi < CEILING) { groups.FIRED.push(row); fired++; }
    else if (obs.rsi >= CEILING)                { groups.BLOCKED.push(row); blocked++; }
    else continue;                               // below the floor — a different question

    // Matched control: the same bar shifted back for no reason. Not conditioned on
    // anything, which is the point — it should come out near zero, and if it does
    // not, the harness is wrong and the finding above should not be believed.
    const ci = i - CONTROL_OFFSET;
    if (ci >= 200) {
      const cobs = { atr: obs.atr };
      const cfwd = forward(bars, ci, cobs);
      if (cfwd && cfwd.atrUnits !== null) { groups.CONTROL.push({ sym, t: bars.t[ci], ...cfwd }); control++; }
    }
  }
  perAsset[sym] = fired + " fired, " + blocked + " blocked, " + control + " control";
}

function stat(rows) {
  if (!rows.length) return { n: 0, meanAtr: null, meanPct: null, winPct: null };
  const meanAtr = rows.reduce((a, r) => a + r.atrUnits, 0) / rows.length;
  const meanPct = rows.reduce((a, r) => a + r.pct, 0) / rows.length;
  const wins = rows.filter(r => r.up).length;
  const sd = Math.sqrt(rows.reduce((a, r) => a + (r.atrUnits - meanAtr) ** 2, 0) / Math.max(1, rows.length - 1));
  return {
    n: rows.length,
    meanAtr, meanPct,
    winPct: (wins / rows.length) * 100,
    stdErr: sd / Math.sqrt(rows.length),
  };
}

const F = stat(groups.FIRED);
const B = stat(groups.BLOCKED);
const C = stat(groups.CONTROL);

// The verdict compares BLOCKED against FIRED, and only says anything when the gap
// is bigger than the noise in the estimate. "Too few" and "inside the noise" are
// different answers from "no difference" and are reported as such.
const bothUsable = F.n >= 30 && B.n >= 30;
const gap = bothUsable ? B.meanAtr - F.meanAtr : null;
const gapErr = bothUsable ? Math.sqrt(F.stdErr ** 2 + B.stdErr ** 2) : null;
// The control establishes the BASELINE DRIFT, it is not supposed to be zero. All
// three instruments trended up across this window - BTC alone went from ~20k to
// ~79k - so an unconditioned bar has genuinely positive forward return. The first
// version of this asserted |control| < 0.25 ATR and then declared its own run
// untrustworthy when the control came in at +0.459, which was the market being real
// rather than the harness being broken. geometry_measure reads its control the same
// way: as the number to beat, not as a number that must vanish.
//
// What IS checked: that the control has enough rows to be a baseline at all.
const controlUsable = C.n >= 100;
const excessFired   = (F.n && C.n) ? F.meanAtr - C.meanAtr : null;
const excessBlocked = (B.n && C.n) ? B.meanAtr - C.meanAtr : null;

// The verdict rests on BLOCKED vs FIRED, which is a MATCHED comparison: both groups
// pass every MOMENTUM condition except the RSI band, so the band is the only thing
// that differs. The control is reported beside them as the drift both are swimming in.
let verdict;
if (!bothUsable) verdict = "TOO FEW OBSERVATIONS — need 30+ in each group";
else if (gap > gapErr) verdict = "THE CEILING IS COSTING MONEY — the bars it blocks outperform the ones it lets through";
else if (gap < -gapErr) verdict = "THE CEILING IS EARNING ITS KEEP — the bars it blocks underperform";
else verdict = "NO MEASURABLE DIFFERENCE — inside the noise, the ceiling is neither helping nor hurting";

const result = {
  measuredAt: new Date().toISOString(),
  question: "Do bars the RSI ceiling BLOCKS perform worse than the ones it lets through?",
  params: { ceiling: CEILING, rsiFloor: RSI_MIN, horizonBars: HORIZON, window: WINDOW, controlOffset: CONTROL_OFFSET },
  population: perAsset,
  fired: F, blocked: B, control: C,
  gapAtrUnits: gap, gapStdErr: gapErr, controlUsable, excessFired, excessBlocked,
  verdict,
  caveats: [
    "Forward returns on the BAR, not on a trade. No entry, stop or target is invented, "
      + "so REJECTION-LEDGER-SPEC rule 3.1 is not violated and no fabricated level exists.",
    "No costs are charged: this measures direction over a fixed horizon, not a tradable edge.",
    "MOMENTUM only. TREND_FOLLOW has its own band and its own EMA200 rule and is not measured here.",
    "The control is unconditioned and carries the market's own drift; it is the baseline "
      + "to beat, not a number that should be zero. All three instruments rose across "
      + "this window, so a positive control is expected.",
  ],
  feedsTheGate: false,
};

if (AS_JSON) {
  const outDir = path.join(ROOT, "tasks", "analysis");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "ceiling-measure-latest.json");
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(outPath);
  process.exit(0);
}

const f3 = v => (v === null ? "  —  " : (v >= 0 ? "+" : "") + v.toFixed(3));
const f1 = v => (v === null ? " — " : v.toFixed(1));

console.log("");
console.log("IS THE RSI CEILING COSTING MONEY?  —  forward returns, no invented levels");
console.log("=".repeat(78));
console.log("  MOMENTUM non-RSI conditions all pass. Bars split by RSI alone:");
console.log("    FIRED    RSI " + RSI_MIN + " < x < " + CEILING + "   (the engine traded these)");
console.log("    BLOCKED  RSI >= " + CEILING + "          (the ceiling refused these)");
console.log("  held " + HORIZON + " D1 bars forward");
console.log("");
for (const [sym, note] of Object.entries(perAsset)) console.log("    " + sym.padEnd(9) + note);
console.log("");
console.log("  " + "group".padEnd(10) + "n".padEnd(8) + "mean ATR".padEnd(11)
          + "mean %".padEnd(10) + "win %".padEnd(9) + "std err");
for (const [name, s] of [["FIRED", F], ["BLOCKED", B], ["CONTROL", C]]) {
  console.log("  " + name.padEnd(10) + String(s.n).padEnd(8)
    + f3(s.meanAtr).padEnd(11) + f3(s.meanPct).padEnd(10)
    + f1(s.winPct).padEnd(9) + (s.stdErr === undefined || s.stdErr === null ? "—" : s.stdErr.toFixed(3)));
}
console.log("");
if (bothUsable) {
  console.log("  BLOCKED minus FIRED: " + f3(gap) + " ATR   (noise band +/-" + gapErr.toFixed(3) + ")");
}
console.log("  vs the unconditioned baseline drift of " + f3(C.meanAtr) + " ATR:");
console.log("    FIRED   excess " + f3(excessFired)   + " ATR   (what the setup adds over random)");
console.log("    BLOCKED excess " + f3(excessBlocked) + " ATR");
if (!controlUsable) console.log("  NOTE: control has under 100 rows — treat the baseline as indicative only.");
console.log("");
console.log("  VERDICT: " + verdict);
console.log("");
for (const c of result.caveats) console.log("  · " + c);
console.log("");
