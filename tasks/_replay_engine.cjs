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
const SCALAR_CONSTS = ["STRUCTURAL_STOP_MIN_ATR"];

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
const WARMUP = 210;      // EMA200 needs history before any signal means anything
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
  const w = bars.slice(0, i + 1);
  let sig;
  try {
    sig = generateSignal("replay", "REPLAY",
      w.map(b => b.c), w.map(b => b.h), w.map(b => b.l), w.map(b => b.v));
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
