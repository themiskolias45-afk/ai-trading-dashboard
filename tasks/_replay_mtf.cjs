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

let code = "";
for (const marker of NEEDED) {
  const block = extractBlock(marker);
  if (!block) { console.error(`could not extract ${marker}`); process.exit(1); }
  code += block + "\n";
}

// Live strategy settings, so the confidence gate matches the running server.
let settings = { confidenceThreshold: 65, minStrength: "MODERATE" };
try {
  const p = path.join(ROOT, "server", "strategy_settings.json");
  if (fs.existsSync(p)) Object.assign(settings, JSON.parse(fs.readFileSync(p, "utf8")));
} catch (_) { /* defaults fine */ }

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
  console,
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const generateSignalMTF = sandbox.generateSignalMTF;

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
const trades = [];
let d1Ptr = 0, h1Ptr = 0;
let openUntil = -1;

for (let i = 0; i < h4.length - 1; i++) {
  const t = h4[i].t;
  while (d1Ptr + 1 < d1.length && d1[d1Ptr + 1].t <= t) d1Ptr++;
  while (h1Ptr + 1 < h1.length && h1[h1Ptr + 1].t <= t) h1Ptr++;

  if (i < 250 || d1Ptr < 250 || h1Ptr < 60) continue;
  if (i <= openUntil) continue;   // position still open

  let sig;
  try {
    sig = generateSignalMTF("replay", TICKER, slice(d1, d1Ptr), slice(h4, i), slice(h1, h1Ptr), null);
  } catch (_) { continue; }

  if (!sig || sig.signal === "WAIT") continue;
  if (sig.confidence < TRADE_THRESHOLD) continue;      // <- the banding under test
  if (sig.stop == null || sig.target == null) continue;

  const entry = sig.entry, stop = sig.stop, target = sig.target;
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) continue;
  const rr = Math.abs(target - entry) / risk;
  if (rr < 1) continue;

  let outcome = "EXPIRED";
  let exitIdx = Math.min(h4.length - 1, i + MAX_HOLD);
  for (let j = i + 1; j <= exitIdx; j++) {
    const b = h4[j];
    if (sig.signal === "BUY") {
      if (b.l <= stop)   { outcome = "LOSS"; exitIdx = j; break; }
      if (b.h >= target) { outcome = "WIN";  exitIdx = j; break; }
    } else {
      if (b.h >= stop)   { outcome = "LOSS"; exitIdx = j; break; }
      if (b.l <= target) { outcome = "WIN";  exitIdx = j; break; }
    }
  }
  openUntil = exitIdx;

  trades.push({
    t, dir: sig.signal, setup: sig.setup, conf: sig.confidence,
    strength: sig.strength, h4dir: sig.h4 ? sig.h4.signal : null,
    h4only: sig.h4 && sig.h4.signal !== "WAIT" && sig.setup != null && sig.confidence < 72,
    rr: Math.round(rr * 100) / 100, outcome,
  });
}

process.stdout.write(JSON.stringify(trades));
