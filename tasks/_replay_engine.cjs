// Replays exported MT5 bars through the LIVE signal engine and prints the trades
// it would have taken, as JSON.
//
// It loads generateSignal out of server/index.js rather than reimplementing the
// setups. A Python copy of the strategy would drift the first time either side
// changed, and then the evidence gate would be measuring something that is not
// what runs live — which is worse than no gate at all.
//
//   node tasks/_replay_engine.js tasks/history/XAUUSD_H4.csv
//
// OVERRIDE_SETTING / OVERRIDE_VALUE let one strategy setting be changed for the
// run, so a variant can be compared against the current configuration.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const csvPath = process.argv[2];
if (!csvPath) {
  console.error("usage: node _replay_engine.js <bars.csv>");
  process.exit(1);
}

// ── Pull generateSignal out of server/index.js without booting the server ──
// Requiring index.js would start express, cron jobs and the MT5 polling loop.
// The function is self-contained, so extract and evaluate just what it needs.
const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server", "index.js"), "utf8");

function extractBlock(startMarker) {
  const start = serverSrc.indexOf(startMarker);
  if (start === -1) return "";
  // walk braces from the first { after the marker to find the function end
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
  "function findSwingLow", "function findSwingHigh", "function generateSignal(",
];

// Top-level scalar consts generateSignal REFERENCES but that live outside every
// block in NEEDED. extractBlock() brace-matches, so it cannot pick these up.
//
// Missing one is silent and total: generateSignal throws ReferenceError on EVERY
// bar, the catch in the replay loop swallows it, and the run reports "0 trades" as
// though the strategy simply never fired. That happened the day
// STRUCTURAL_STOP_MIN_ATR was added - this harness returned [] for all six
// symbol/timeframe combinations and parallel_analysis.py stopped with "No trades
// replayed", which reads like missing history rather than a broken sandbox.
//
// Read from source rather than hardcoded: a literal copied here would drift the day
// someone retunes the server, reintroducing the same class of bug with no error.
const SCALAR_CONSTS = [
  "STRUCTURAL_STOP_MIN_ATR",
  // Added 2026-08-24. emaSeries (in NEEDED above) reads it, so its absence threw a
  // ReferenceError on EVERY bar of EVERY file — 7639 of 7639 on XAUUSD_H4 — and this
  // harness had been returning [] for every caller. The sibling tasks/_replay_mtf.cjs
  // got this same constant on 2026-08-09 and the fix was never mirrored here, so the
  // two harnesses silently disagreed about whether the engine runs at all.
  //
  // FOURTH occurrence of this one bug class; _replay_mtf.cjs documents the other three.
  // The pattern to watch: the loop below REFUSES when a listed const cannot be
  // extracted, but nothing can refuse for a const that was never listed. Whenever
  // server/index.js gains a top-level const that generateSignal or any function in
  // NEEDED reads, it has to be added here too.
  "EMA_SMA_SEED_MIN_MULTIPLE",
];

let code = "";
for (const name of SCALAR_CONSTS) {
  const m = serverSrc.match(new RegExp(`^const\\s+${name}\\s*=\\s*([^;]+);`, "m"));
  if (!m) {
    console.error(`could not extract const ${name} from server/index.js — refusing to ` +
                  `replay, because without it generateSignal throws on every bar and ` +
                  `the result would silently be an empty trade list.`);
    process.exit(1);
  }
  code += `const ${name} = ${m[1]};\n`;
}

for (const marker of NEEDED) {
  const block = extractBlock(marker);
  if (!block) {
    console.error(`could not extract ${marker} from server/index.js`);
    process.exit(1);
  }
  code += block + "\n";
}

// strategySettings is referenced by the confidence gate inside generateSignal.
const override = process.env.OVERRIDE_SETTING;
const settingsPath = path.join(__dirname, "..", "server", "strategy_settings.json");
let settings = { confidenceThreshold: 65, minStrength: "STRONG" };
try {
  if (fs.existsSync(settingsPath)) {
    Object.assign(settings, JSON.parse(fs.readFileSync(settingsPath, "utf8")));
  }
} catch (_) { /* defaults are fine */ }
if (override) {
  const raw = process.env.OVERRIDE_VALUE;
  const num = Number(raw);
  settings[override] = Number.isFinite(num) ? num : raw;
}

const sandbox = { strategySettings: settings, console, module: {}, exports: {} };
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const generateSignal = sandbox.generateSignal;

// ── bars ──
const rows = fs.readFileSync(csvPath, "utf8").trim().split(/\r?\n/).slice(1);
const bars = rows.map(line => {
  const [t, o, h, l, c, v] = line.split(",");
  return { t: +t, o: +o, h: +h, l: +l, c: +c, v: +v };
});

// ── replay ──
// Only STRONG/MODERATE are tradeable; which of those actually trades live is
// decided by minStrength, applied here so the replay matches the bridge.
const allowed = settings.minStrength === "MODERATE" ? ["STRONG", "MODERATE"] : ["STRONG"];
// Which timeframe these bars ARE. generateSignal takes it on barSource and several
// setups are scoped to one timeframe -- SWING_PULLBACK_H4, EMA_REVERSAL_H1 and
// M15_MOMENTUM all test it -- so a harness that never sets it makes those setups
// UNREACHABLE and silently reports that they never fire. That is measurement saying
// "no edge" when it means "never ran", which is the worse of the two failures.
//
// Derived from the filename (XAUUSD_H4.csv -> "H4") because every file in
// tasks/history and tasks/history_yahoo is named that way; REPLAY_TIMEFRAME overrides
// it for a file that is not. Null when it cannot be derived, which is exactly the old
// behaviour, so every existing caller is unaffected.
const REPLAY_TIMEFRAME = (() => {
  const override = (process.env.REPLAY_TIMEFRAME || "").trim().toUpperCase();
  if (override) return override;
  const m = path.basename(csvPath).match(/_(D1|H4|H1|M15)\.csv$/i);
  return m ? m[1].toUpperCase() : null;
})();

// Bars handed to the engine per cycle, per timeframe -- the SAME counts
// BAR_COUNT_BY_TIMEFRAME in mt5_bridge.py pushes live. Anything not recognised falls
// back to the largest, so an unusual file is never given LESS history than live would.
const LIVE_BAR_COUNTS = { D1: 600, H4: 400, H1: 1200, M15: 4000 };

const WARMUP = 210;      // EMA200 needs history before any signal means anything
const REPLAY_WINDOW = LIVE_BAR_COUNTS[REPLAY_TIMEFRAME] || 1200;
const MAX_HOLD = 40;

// Regime thresholds, kept identical to generateSignalMTF in server/index.js so a
// replayed trade is labelled the same way the live dashboard would label it.
const SQUEEZE_BANDWIDTH_PCT  = 8;
const VOLATILE_BANDWIDTH_PCT = 25;

const trades = [];
let lastKey = null;

// An engine throw used to `continue` in silence. A missing sandbox constant throws
// on every bar, so the run produced an empty trade list that was indistinguishable
// from "the strategy never fired" - and every downstream analyst then reasoned about
// a strategy that had simply not been executed. Counted and reported instead.
let engineThrows = 0;
let firstEngineThrow = "";

for (let i = WARMUP; i < bars.length - 1; i++) {
  // TRAILING WINDOW, matching what the bridge actually pushes. This used to be
  // bars.slice(0, i + 1) -- the ENTIRE history, re-sliced and re-mapped four times on
  // every bar, which is O(n^2): 102,011 M15 bars cost ~5.2 BILLION element operations
  // and the run took hours rather than minutes.
  //
  // Speed is the smaller half. The bigger half is FIDELITY: live never sees the full
  // history. mt5_bridge.py pushes exactly {d1:600, h4:400, h1:1200, m15:4000}, so a
  // replay computing EMA200 over 102,011 bars was computing a DIFFERENT indicator than
  // production computes over 4,000 -- and EMA200 on this system is documented as
  // seed-sensitive. Windowing to the live bar counts makes the backtest match live
  // instead of merely being faster.
  const from = Math.max(0, i + 1 - REPLAY_WINDOW);
  const w = bars.slice(from, i + 1);
  let sig;
  try {
    sig = generateSignal("replay", "REPLAY",
      w.map(b => b.c), w.map(b => b.h), w.map(b => b.l), w.map(b => b.v),
      // `opens` rides on barSource rather than as a new positional argument, so
      // generateSignal's signature is untouched and every other caller is unaffected.
      // SWING_PULLBACK_H4 needs it: the Pine it mirrors requires a bullish entry bar
      // (close > open), and that is not derivable from closes/highs/lows.
      null, { timeframe: REPLAY_TIMEFRAME, opens: w.map(b => b.o) });
  } catch (err) {
    engineThrows++;
    if (!firstEngineThrow) firstEngineThrow = err.message;
    continue;
  }

  if (!sig || sig.signal === "WAIT" || sig.stop == null || sig.target == null) { lastKey = null; continue; }
  if (!allowed.includes(sig.strength)) { lastKey = null; continue; }

  const key = `${sig.signal}_${sig.setup}`;
  if (key === lastKey) continue;      // don't re-enter the same standing setup
  lastKey = key;

  const entry = sig.entry, stop = sig.stop, target = sig.target;
  const risk = Math.abs(entry - stop);
  if (risk <= 0) continue;
  const rr = Math.abs(target - entry) / risk;
  if (rr < 1) continue;

  let outcome = "EXPIRED";
  for (let j = i + 1; j < Math.min(bars.length, i + 1 + MAX_HOLD); j++) {
    const b = bars[j];
    if (sig.signal === "BUY") {
      if (b.l <= stop) { outcome = "LOSS"; break; }
      if (b.h >= target) { outcome = "WIN"; break; }
    } else {
      if (b.h >= stop) { outcome = "LOSS"; break; }
      if (b.l <= target) { outcome = "WIN"; break; }
    }
  }
  // Market context at entry. Purely additive — evaluate_change.py reads only
  // t/rr/outcome — but without it any analysis of WHY a setup loses has nothing
  // to work with except the setup name, which is the question, not the answer.
  const bandwidth = sig.indicators?.bb?.bandwidth;
  const regime =
    (sig.trend === "STRONG UPTREND" || sig.trend === "STRONG DOWNTREND") ? "TRENDING" :
    (bandwidth != null && bandwidth < SQUEEZE_BANDWIDTH_PCT)  ? "SQUEEZE"  :
    (bandwidth != null && bandwidth > VOLATILE_BANDWIDTH_PCT) ? "VOLATILE" : "RANGING";

  trades.push({ t: bars[i].t, setup: sig.setup, dir: sig.signal,
                strength: sig.strength, rr: Math.round(rr * 100) / 100, outcome,
                regime,
                trend:     sig.trend ?? null,
                rsi:       sig.indicators?.rsi ?? null,
                adx:       sig.indicators?.adx ?? null,
                bandwidth: bandwidth ?? null,
                volRatio:  sig.volume?.ratio ?? null });
}

// stdout stays exactly a JSON trade array — the callers parse it directly. The
// warning goes to stderr so it reaches a human without breaking any of them.
if (engineThrows > 0) {
  console.error(
    `REPLAY DEGRADED: the engine threw on ${engineThrows} of ${bars.length - WARMUP - 1} ` +
    `bars in ${path.basename(csvPath)}. First error: ${firstEngineThrow}. Those bars are ` +
    `MISSING from the trade list below — do not treat it as a complete measurement. ` +
    `A constant missing from SCALAR_CONSTS throws on every bar and yields [].`);
}

process.stdout.write(JSON.stringify(trades));
