'use strict';
/**
 * Does adding CRT as an ENGINE SETUP add trades without hurting expectancy?
 *
 * WHY THIS IS THE QUESTION LEFT. Five things were measured on 2026-08-09 and four
 * came back negative: FVG has no edge, per-direction MIN_RR does not survive
 * folds, gate 70 is already the best gate (65 is 3/5), shorts-only R:R does
 * nothing. With roughly one trade a week, the current setup family is at its
 * local optimum and tweaking filters is exhausted.
 *
 * CRT is the one thing with a measured, cost-surviving edge — and unlike every
 * rejected candidate it is a NEW SOURCE OF TRADES rather than a loosened filter.
 * That attacks the binding constraint from the only direction left.
 *
 * THE EXPERIMENT IS DELIBERATELY ADDITIVE-ONLY. CRT is injected at the END of the
 * setup chain, immediately before BB_SQUEEZE_WATCH — which sets signal:"WAIT" and
 * can never open a trade — so CRT can only claim steps where the engine currently
 * produces NO trade. Every existing tradeable setup keeps priority and is
 * untouched, which means any delta is purely what CRT added. If it were inserted
 * higher it would shadow working setups and the result would be meaningless.
 *
 * Everything else is held fixed: same folds, same gate 70, same 0.05R cost, same
 * bars. Only the setup chain differs.
 *
 * REPLAY ONLY. It patches the extracted engine inside the vm sandbox.
 * server/index.js is never touched and no live setting changes.
 *
 * Usage: node tasks/crt_as_setup_walkforward.cjs [--folds 5] [--gate 70]
 */

const fs   = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
function numArg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  if (i === -1 || i + 1 >= process.argv.length) return fallback;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : fallback;
}
const FOLDS = Math.max(3, numArg("--folds", 5));
const GATE  = numArg("--gate", 70);
const CONF_FLOOR = 40;
const COST_R = 0.05;
const ASSETS = [["XAUUSD", "GC=F"], ["BTCUSD", "BTC-USD"], ["SP500", "^GSPC"]];

// A temporary project root whose only difference is the injected setup. The
// history directory is junctioned rather than copied — it is 26MB.
function buildPatchedRoot() {
  const root = path.join(require("os").tmpdir(), "crt_setup_root");
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, "server"), { recursive: true });
  fs.mkdirSync(path.join(root, "tasks", "analysis"), { recursive: true });
  fs.mkdirSync(path.join(root, "tasks", "logs"), { recursive: true });

  let src = fs.readFileSync(path.join(ROOT, "server", "index.js"), "utf8");

  // CRT, expressed against the variables already in generateSignal's scope:
  // closes / highs / lows / entry / atrVal. Same definition as
  // server/structure.js — candle i-2 sets the range, i-1 sweeps one edge and
  // CLOSES back inside, i confirms by closing past i-1.
  const INJECT = `
  // ── CRT (candle range theory) — EXPERIMENTAL, replay-injected ─────
  // Reached only when no tradeable setup above matched.
  else if (closes.length >= 3 && (() => {
    const n = closes.length - 1;
    const rangeHigh = highs[n - 2], rangeLow = lows[n - 2];
    if (!(rangeHigh > rangeLow)) return false;
    const sweepMin = atrVal ? atrVal * 0.05 : 0;
    const sweptHigh = highs[n - 1] > rangeHigh + sweepMin && closes[n - 1] < rangeHigh;
    const sweptLow  = lows[n - 1]  < rangeLow  - sweepMin && closes[n - 1] > rangeLow;
    if (sweptHigh === sweptLow) return false;                 // both or neither
    const confirmed = sweptHigh ? closes[n] < closes[n - 1] : closes[n] > closes[n - 1];
    if (!confirmed) return false;
    globalThis.__crt = {
      dir: sweptHigh ? "SELL" : "BUY",
      objective: sweptHigh ? rangeLow : rangeHigh,
      invalidation: sweptHigh ? highs[n - 1] : lows[n - 1],
    };
    return true;
  })()) {
    const c = globalThis.__crt;
    setup  = "CRT_SWEEP_REVERSAL";
    signal = c.dir;
    stop   = parseFloat(c.invalidation.toFixed(2));
    target = parseFloat(c.objective.toFixed(2));
    strength = "MODERATE";
    reasons.push("CRT: " + (c.dir === "SELL" ? "high" : "low") + " swept and reclaimed — range failure");
  }
`;

  const anchor = "  // ── BB_SQUEEZE_WATCH: tight squeeze — flag pending breakout ──────";
  const hits = src.split(anchor).length - 1;
  if (hits !== 1) {
    console.error("ABORT: injection anchor matched " + hits + " times, need exactly 1. The setup "
      + "chain has changed shape — fix this harness rather than reporting a number it did not measure.");
    process.exit(1);
  }
  src = src.replace(anchor, INJECT + anchor);
  fs.writeFileSync(path.join(root, "server", "index.js"), src);

  const settings = path.join(ROOT, "server", "strategy_settings.json");
  if (fs.existsSync(settings)) fs.copyFileSync(settings, path.join(root, "server", "strategy_settings.json"));
  fs.copyFileSync(path.join(ROOT, "tasks", "_replay_mtf.cjs"), path.join(root, "tasks", "_replay_mtf.cjs"));
  execFileSync("cmd", ["/c", "mklink", "/J", path.join(root, "tasks", "history"),
    path.join(ROOT, "tasks", "history")], { stdio: "pipe" });
  return root;
}

function replay(root, symbol, ticker) {
  const env = { ...process.env, MTF_CONF_FLOOR: String(CONF_FLOOR), MTF_EMIT_R: "1" };
  try {
    const stdout = execFileSync(process.execPath,
      [path.join(root, "tasks", "_replay_mtf.cjs"), root, symbol, ticker, String(CONF_FLOOR)],
      { env, maxBuffer: 64 * 1024 * 1024, encoding: "utf8", timeout: 900000 });
    return JSON.parse(stdout);
  } catch (e) {
    const out = ((e.stdout || "") + (e.stderr || "")).toString();
    console.error("  replay failed " + symbol + ": " + out.slice(-400));
    return [];
  }
}

function score(trades) {
  const closed = trades.filter(t => Number.isFinite(t.realisedR));
  if (!closed.length) return { n: 0, rpt: 0, wr: 0 };
  const net = closed.reduce((s, t) => s + t.realisedR - COST_R, 0);
  const wins = closed.filter(t => t.realisedR > 0).length;
  return { n: closed.length, rpt: net / closed.length, wr: (wins / closed.length) * 100 };
}

(async () => {
  console.log("CRT AS AN ENGINE SETUP — walk-forward");
  console.log(FOLDS + " folds · gate " + GATE + " · cost " + COST_R + "R/trade");
  console.log("CRT injected at the END of the setup chain, so it can ONLY claim steps where the");
  console.log("engine currently produces no trade. Existing setups keep priority and are untouched.");
  console.log("Replay only — server/index.js is not modified.\n");

  const patched = buildPatchedRoot();
  console.log("  patched root: " + patched + "\n");

  let base = [], cand = [];
  for (const [symbol, ticker] of ASSETS) {
    const b = replay(ROOT, symbol, ticker).filter(t => (t.conf ?? 0) >= GATE);
    const c = replay(patched, symbol, ticker).filter(t => (t.conf ?? 0) >= GATE);
    const crtOnly = c.filter(t => t.setup === "CRT_SWEEP_REVERSAL").length;
    console.log("  " + symbol.padEnd(8) + "baseline " + String(b.length).padStart(4)
      + "   with CRT " + String(c.length).padStart(4)
      + "   (+" + (c.length - b.length) + ", of which CRT-tagged " + crtOnly + ")");
    base = base.concat(b); cand = cand.concat(c);
  }
  base.sort((a, b2) => (a.t || 0) - (b2.t || 0));
  cand.sort((a, b2) => (a.t || 0) - (b2.t || 0));

  if (!base.length) { console.error("\nbaseline produced no trades"); process.exit(1); }

  const size = Math.floor(base.length / FOLDS);
  const bounds = [];
  for (let i = 0; i < FOLDS; i++) {
    const from = base[i * size];
    const to   = (i === FOLDS - 1) ? base[base.length - 1] : base[(i + 1) * size - 1];
    bounds.push([from.t || 0, to.t || 0]);
  }

  const slice = (arr, from, to) => arr.filter(x => (x.t || 0) >= from && (x.t || 0) <= to);
  console.log("\n  series        " + bounds.map((_, i) => ("fold" + (i + 1)).padStart(9)).join("") + "      overall");
  const rows = {};
  for (const [label, set] of [["baseline", base], ["with CRT", cand]]) {
    const cells = bounds.map(([f, t]) => {
      const s = score(slice(set, f, t));
      return (s.n < 5 ? "     n<5" : (s.rpt >= 0 ? "+" : "") + s.rpt.toFixed(3)).padStart(9);
    });
    rows[label] = bounds.map(([f, t]) => score(slice(set, f, t)));
    const o = score(set);
    console.log("  " + label.padEnd(14) + cells.join("")
      + ("   " + (o.rpt >= 0 ? "+" : "") + o.rpt.toFixed(3) + "R n=" + o.n).padStart(20));
  }

  const deltas = bounds.map((_, i) => {
    const b = rows["baseline"][i], c = rows["with CRT"][i];
    return (b.n >= 5 && c.n >= 5) ? c.rpt - b.rpt : null;
  });
  const comparable = deltas.filter(d => d !== null);
  const better = comparable.filter(d => d > 0).length;
  console.log("  " + "delta".padEnd(14)
    + deltas.map(d => (d === null ? "        -" : (d >= 0 ? "+" : "") + d.toFixed(3)).padStart(9)).join("")
    + ("   " + better + "/" + comparable.length + " better").padStart(20));

  const bo = score(base), co = score(cand);
  const dR = co.rpt - bo.rpt, dN = co.n - bo.n;
  const maxD = Math.max(...comparable.map(Math.abs), 0);
  const sumD = comparable.reduce((a, b) => a + b, 0);
  const concentrated = sumD !== 0 && (maxD / Math.abs(sumD)) > 0.6;

  console.log("\n  VERDICT");
  if (dN <= 0) {
    console.log("    NO EFFECT — CRT added " + dN + " trades at gate " + GATE + ". Its setups exist but");
    console.log("    do not clear the confidence gate, so the engine never sees them.");
  } else if (better < Math.ceil(comparable.length / 2)) {
    console.log("    REJECT — +" + dN + " trades but better in only " + better + "/" + comparable.length + " folds ("
      + (dR >= 0 ? "+" : "") + dR.toFixed(3) + "R overall).");
  } else if (concentrated) {
    console.log("    NOT PROVEN — +" + dN + " trades, " + (dR >= 0 ? "+" : "") + dR.toFixed(3)
      + "R, but " + Math.round(maxD / Math.abs(sumD) * 100) + "% of the movement is ONE fold.");
  } else if (dR < -0.02) {
    console.log("    REJECT — +" + dN + " trades but expectancy fell " + dR.toFixed(3) + "R.");
  } else {
    console.log("    CANDIDATE — +" + dN + " trades, " + (dR >= 0 ? "+" : "") + dR.toFixed(3)
      + "R/trade, better in " + better + "/" + comparable.length + " folds.");
    console.log("    This is the first thing that ADDS flow without costing expectancy. It has");
    console.log("    earned a discussion about wiring it in, not the wiring itself.");
  }
  console.log("\n  Nothing here changed a live setting.");
})().catch(e => { console.error("FAILED: " + e.message); process.exit(1); });
