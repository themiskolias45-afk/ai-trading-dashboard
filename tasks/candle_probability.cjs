'use strict';
/**
 * WHAT IS THE PROBABILITY OF THE NEXT CANDLE — measured, per timeframe, folded.
 *
 * WHY THIS EXISTS. The request was a daily Gold read on the 1D and 4H candle, with the
 * belief that 4H is the more powerful timeframe. Both halves are testable and neither
 * had ever been measured here, so this measures them BEFORE anything reports them
 * daily. A daily figure with no edge behind it is worse than no figure: it looks like
 * information, gets acted on, and cannot be told apart from a real one.
 *
 * WHAT IT ASKS. For each bar, it records the state at that bar's CLOSE, then the
 * outcome of the NEXT bar. Two outcomes:
 *
 *   GREEN      next close > next open. The plain question, and a weak one — a green
 *              candle can still be unprofitable, and this base rate drifts with any
 *              instrument in a long uptrend.
 *   ATR REACH  did the next bar trade +REACH_ATR of ATR above its open BEFORE it traded
 *              the same distance below? That is the question a trade actually asks.
 *
 * THE ATR-REACH LIMITATION, STATED UP FRONT. A bar gives open/high/low/close and NOT
 * the order in which the high and low were made. When a bar reaches both thresholds,
 * which came first is unknowable from this data. Those bars are counted as AMBIGUOUS
 * and EXCLUDED from the ratio rather than guessed — guessing would bias the result in
 * whichever direction the guess leans, and on a trending instrument that bias is not
 * small. The excluded count is always reported, because a 60% win rate on 20% of the
 * sample is not a 60% win rate.
 *
 * FOLDED, AND JUDGED ON THE WORST FOLD. Five sequential out-of-sample periods, the same
 * standard the confidence gate and the R:R bar are held to here. A conditional cell that
 * is spectacular in one window and useless in the others has a fine average and does not
 * survive a new market. A cell must beat its own timeframe's base rate in MOST folds.
 *
 * READ-ONLY. Reads tasks/history/*.csv, writes one report under tasks/analysis. Touches
 * no gate, no threshold, no signal, no order. Nothing here can change what trades.
 *
 * Usage:
 *   node tasks/candle_probability.cjs                 XAUUSD, D1 and H4
 *   node tasks/candle_probability.cjs BTCUSD SP500    other symbols
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const HISTORY = path.join(ROOT, "tasks", "history");
const OUT_DIR = path.join(ROOT, "tasks", "analysis");

const SYMBOLS = process.argv.slice(2).filter(a => !a.startsWith("-"));
const ASSETS = SYMBOLS.length ? SYMBOLS : ["XAUUSD"];
const TIMEFRAMES = ["D1", "H4"];

const FOLDS = 5;
// How far the next bar must travel from its open, in ATR, for the move to count.
// 0.5 is deliberately modest: at 1.0+ most bars reach neither and the sample collapses.
const REACH_ATR = 0.5;
// A cell below this many resolved cases in a fold is not reported for that fold. Small
// cells are where spurious 100%s come from.
const MIN_PER_FOLD = 12;
// A conditional cell must clear its timeframe's own base rate by more than this to be
// called anything but noise. Base rates here sit near 50%, and a couple of points is
// what resampling alone moves them by.
const EDGE_PP = 3;

function readBars(symbol, tf) {
  const file = path.join(HISTORY, `${symbol}_${tf}.csv`);
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, "utf8").trim().split(/\r?\n/).slice(1);
  const bars = [];
  for (const line of lines) {
    const [t, o, h, l, c, v] = line.split(",");
    const bar = { t: +t, o: +o, h: +h, l: +l, c: +c, v: +v };
    if ([bar.t, bar.o, bar.h, bar.l, bar.c].every(Number.isFinite)) bars.push(bar);
  }
  return bars;
}

// ── Indicators. Self-contained on purpose: this measures the BARS, not the engine, so
// borrowing generateSignal would make the answer depend on the engine's current tuning
// and stop being a property of the instrument. ────────────────────────────────────────
function ema(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let seed = 0;
  for (let i = 0; i < Math.min(period, values.length); i++) seed += values[i];
  if (values.length < period) return out;
  out[period - 1] = seed / period;
  for (let i = period; i < values.length; i++) out[i] = values[i] * k + out[i - 1] * (1 - k);
  return out;
}

function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  let gain = 0, loss = 0;
  for (let i = 1; i <= period && i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= period; loss /= period;
  if (closes.length > period) out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + (d > 0 ? d : 0)) / period;
    loss = (loss * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

function atr(bars, period = 14) {
  const out = new Array(bars.length).fill(null);
  const tr = bars.map((b, i) => i === 0 ? b.h - b.l
    : Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c)));
  let sum = 0;
  for (let i = 0; i < Math.min(period, tr.length); i++) sum += tr[i];
  if (tr.length < period) return out;
  out[period - 1] = sum / period;
  for (let i = period; i < tr.length; i++) out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
  return out;
}

function bandwidthPct(closes, i, period = 20) {
  if (i < period - 1) return null;
  const win = closes.slice(i - period + 1, i + 1);
  const mean = win.reduce((a, b) => a + b, 0) / period;
  const sd = Math.sqrt(win.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
  return mean === 0 ? null : ((4 * sd) / mean) * 100;
}

/* The state of a bar at its CLOSE — only things knowable at that moment. Nothing here
   peeks at the next bar, which is the whole point. */
function stateOf(bars, i, ind) {
  const b = bars[i];
  const e20 = ind.ema20[i], e50 = ind.ema50[i], r = ind.rsi[i], bw = ind.bw[i];
  if (e20 == null || e50 == null || r == null || bw == null) return null;

  const trend = e20 > e50 ? "UP" : "DOWN";
  const rsiBand = r >= 70 ? "RSI>=70" : r >= 55 ? "RSI55-70" : r >= 45 ? "RSI45-55"
                : r >= 30 ? "RSI30-45" : "RSI<30";
  const squeeze = bw < 8 ? "SQUEEZE" : bw > 25 ? "WIDE" : "NORMAL";
  const body = b.c >= b.o ? "prevGREEN" : "prevRED";
  return { trend, rsiBand, squeeze, body };
}

/* Outcome of bar i+1, judged from bar i's ATR. Returns null when unknowable. */
function outcomeOf(bars, i, atrAtI) {
  const n = bars[i + 1];
  if (!n || !Number.isFinite(atrAtI) || atrAtI <= 0) return null;
  const green = n.c > n.o;
  const reach = REACH_ATR * atrAtI;
  const hitUp = (n.h - n.o) >= reach;
  const hitDown = (n.o - n.l) >= reach;

  // BOTH sides reached: the order is not in the data. Counted, never guessed.
  let atrReach = null;
  if (hitUp && hitDown) atrReach = "AMBIGUOUS";
  else if (hitUp) atrReach = "UP";
  else if (hitDown) atrReach = "DOWN";
  else atrReach = "NEITHER";
  return { green, atrReach };
}

function pct(n, d) { return d > 0 ? (n / d) * 100 : null; }

function analyse(symbol, tf) {
  const bars = readBars(symbol, tf);
  if (!bars || bars.length < 400) return { symbol, tf, error: `only ${bars ? bars.length : 0} bars` };

  const closes = bars.map(b => b.c);
  const ind = {
    ema20: ema(closes, 20), ema50: ema(closes, 50), rsi: rsi(closes, 14),
    atr: atr(bars, 14), bw: bars.map((_, i) => bandwidthPct(closes, i)),
  };

  const rows = [];
  for (let i = 60; i < bars.length - 1; i++) {
    const st = stateOf(bars, i, ind);
    const oc = outcomeOf(bars, i, ind.atr[i]);
    if (st && oc) rows.push({ t: bars[i].t, ...st, ...oc });
  }
  if (rows.length < 200) return { symbol, tf, error: `only ${rows.length} usable rows` };

  const size = Math.floor(rows.length / FOLDS);
  const folds = [];
  for (let f = 0; f < FOLDS; f++) {
    folds.push(rows.slice(f * size, f === FOLDS - 1 ? rows.length : (f + 1) * size));
  }

  const score = (set) => {
    const green = set.filter(r => r.green).length;
    const dir = set.filter(r => r.atrReach === "UP" || r.atrReach === "DOWN");
    const up = dir.filter(r => r.atrReach === "UP").length;
    return {
      n: set.length,
      greenPct: pct(green, set.length),
      resolved: dir.length,
      ambiguous: set.filter(r => r.atrReach === "AMBIGUOUS").length,
      neither: set.filter(r => r.atrReach === "NEITHER").length,
      upPct: pct(up, dir.length),
    };
  };

  const overall = score(rows);
  const perFold = folds.map(score);

  // Conditional cells, over the dimensions the engine already reasons in.
  const dims = {
    trend: r => r.trend, rsiBand: r => r.rsiBand, squeeze: r => r.squeeze, body: r => r.body,
    "trend+rsi": r => `${r.trend} ${r.rsiBand}`,
  };
  const cells = [];
  for (const [dimName, keyOf] of Object.entries(dims)) {
    const keys = [...new Set(rows.map(keyOf))];
    for (const key of keys) {
      const all = rows.filter(r => keyOf(r) === key);
      const s = score(all);
      if (s.resolved < MIN_PER_FOLD * FOLDS) continue;
      const foldScores = folds.map(f => score(f.filter(r => keyOf(r) === key)));
      const judged = foldScores.filter(fs => fs.resolved >= MIN_PER_FOLD);
      const beat = judged.filter(fs => fs.upPct != null && overall.upPct != null
        && Math.abs(fs.upPct - overall.upPct) > EDGE_PP
        && Math.sign(fs.upPct - overall.upPct) === Math.sign(s.upPct - overall.upPct)).length;
      cells.push({
        dim: dimName, key, ...s,
        liftPP: s.upPct != null && overall.upPct != null ? s.upPct - overall.upPct : null,
        foldsJudged: judged.length,
        foldsAgreeing: beat,
        foldUpPct: foldScores.map(fs => fs.resolved >= MIN_PER_FOLD ? Math.round(fs.upPct * 10) / 10 : null),
      });
    }
  }
  cells.sort((a, b) => Math.abs(b.liftPP || 0) - Math.abs(a.liftPP || 0));
  return { symbol, tf, bars: bars.length, rows: rows.length, overall, perFold, cells };
}

/* ── TODAY'S READ ───────────────────────────────────────────────────────────────────
 * The daily half. Takes the state of the LAST CLOSED bar on each timeframe, finds that
 * exact cell in the measurement above, and reports what it was worth historically.
 *
 * The state is computed from the SAME bars and the SAME functions as the measurement,
 * never from /api/signals. The engine's RSI and trend are tuned for the gate and can
 * legitimately differ; reading a cell under one definition that was measured under
 * another is how a number stops meaning what it says.
 *
 * MOST DAYS THE ANSWER IS "NO READ", and that is the point. A cell only speaks when its
 * lift clears the timeframe's own fold-to-fold spread AND most folds agree on the
 * direction. Anything else is reported as INSIDE NOISE, in those words, so a quiet
 * morning cannot be mistaken for a signal.
 * ------------------------------------------------------------------------------- */
function todayRead(analysis) {
  if (analysis.error) return { symbol: analysis.symbol, tf: analysis.tf, error: analysis.error };
  const bars = readBars(analysis.symbol, analysis.tf);
  const closes = bars.map(b => b.c);
  const ind = {
    ema20: ema(closes, 20), ema50: ema(closes, 50), rsi: rsi(closes, 14),
    atr: atr(bars, 14), bw: bars.map((_, i) => bandwidthPct(closes, i)),
  };
  const i = bars.length - 1;                 // the last CLOSED bar
  const st = stateOf(bars, i, ind);
  if (!st) return { symbol: analysis.symbol, tf: analysis.tf, error: "state not computable" };

  const base = analysis.overall.upPct;
  const spread = Math.max(...analysis.perFold.map(f => f.upPct || 0))
               - Math.min(...analysis.perFold.map(f => f.upPct || 0));
  const key = `${st.trend} ${st.rsiBand}`;
  const cell = analysis.cells.find(c => c.dim === "trend+rsi" && c.key === key) || null;

  let verdict = "NO READ — this state has too few resolved cases to judge";
  if (cell) {
    const clearsNoise = Math.abs(cell.liftPP) > spread;
    const foldsAgree = cell.foldsJudged > 0 && cell.foldsAgreeing > cell.foldsJudged / 2;
    // A cell judged on fewer than 4 folds had too few resolved cases in the rest, so
    // its agreement is over a short window. Said out loud rather than folded into one
    // word: D1 carries a 7.8-9.5pp noise bar on every asset, so a D1 "READ" resting on
    // 2 of 3 folds is not the same object as an H4 read over 5.
    const thin = cell.foldsJudged < 4;
    verdict = clearsNoise && foldsAgree
      ? `READ${thin ? " (THIN — judged on only " + cell.foldsJudged + " folds)" : ""} — `
        + `${cell.upPct.toFixed(1)}% up (${cell.liftPP >= 0 ? "+" : ""}${cell.liftPP.toFixed(1)}pp, `
        + `${cell.foldsAgreeing}/${cell.foldsJudged} folds), lift clears the ${spread.toFixed(1)}pp noise bar`
      : `INSIDE NOISE — ${cell.upPct.toFixed(1)}% up is ${cell.liftPP >= 0 ? "+" : ""}${cell.liftPP.toFixed(1)}pp `
        + `against a ${spread.toFixed(1)}pp fold spread` + (foldsAgree ? "" : `, and only ${cell.foldsAgreeing}/${cell.foldsJudged} folds agree`);
  }
  return {
    symbol: analysis.symbol, tf: analysis.tf,
    asOf: new Date(bars[i].t * 1000).toISOString(),
    state: key, squeeze: st.squeeze, prevBody: st.body,
    baseUpPct: base == null ? null : +base.toFixed(1),
    noiseBarPP: +spread.toFixed(1),
    cellUpPct: cell ? +cell.upPct.toFixed(1) : null,
    liftPP: cell ? +cell.liftPP.toFixed(1) : null,
    resolved: cell ? cell.resolved : 0,
    foldsAgreeing: cell ? cell.foldsAgreeing : null,
    foldsJudged: cell ? cell.foldsJudged : null,
    thinFolds: cell ? cell.foldsJudged < 4 : null,
    actionable: !!(cell && Math.abs(cell.liftPP) > spread
                   && cell.foldsJudged > 0 && cell.foldsAgreeing > cell.foldsJudged / 2),
    verdict,
  };
}

// ── Report ─────────────────────────────────────────────────────────────────────────
const lines = [];
const say = (s = "") => { lines.push(s); console.log(s); };

say("=".repeat(100));
say(`  NEXT-CANDLE PROBABILITY — ${new Date().toISOString()}`);
say(`  ${FOLDS} sequential out-of-sample folds · reach = ${REACH_ATR} ATR · min ${MIN_PER_FOLD}/fold · edge bar ${EDGE_PP}pp`);
say("=".repeat(100));
say("");
say("  ATR REACH asks: did the next bar travel +0.5 ATR from its open BEFORE it travelled");
say("  -0.5 ATR? When a bar reaches BOTH, the order is not in the data — those are counted");
say("  as AMBIGUOUS and EXCLUDED, never guessed. `resolved` is the real sample.");
say("");

const results = [];
for (const symbol of ASSETS) {
  for (const tf of TIMEFRAMES) {
    const r = analyse(symbol, tf);
    results.push(r);
    if (r.error) { say(`  ${symbol} ${tf}: ${r.error}`); continue; }
    const o = r.overall;
    say("-".repeat(100));
    say(`  ${symbol} ${tf}   ${r.rows} usable bars of ${r.bars}`);
    say(`    next candle GREEN      ${o.greenPct.toFixed(1)}%   (n=${o.n})`);
    say(`    next candle reaches UP ${o.upPct.toFixed(1)}%   resolved=${o.resolved}`
      + `  ambiguous=${o.ambiguous} (${(o.ambiguous / o.n * 100).toFixed(0)}% of bars)  neither=${o.neither}`);
    say(`    per fold UP%: ${r.perFold.map(f => f.upPct == null ? "-" : f.upPct.toFixed(1)).join("  ")}`);
    const spread = Math.max(...r.perFold.map(f => f.upPct || 0)) - Math.min(...r.perFold.map(f => f.upPct || 0));
    say(`    fold-to-fold spread ${spread.toFixed(1)}pp  <- any "edge" smaller than this is noise`);
    say("");
    say(`    conditional cells, ranked by |lift| over this timeframe's own ${o.upPct.toFixed(1)}% base:`);
    say(`      ${"cell".padEnd(26)} ${"UP%".padStart(6)} ${"lift".padStart(7)} ${"resolved".padStart(9)}`
      + `  folds agreeing   per-fold UP%`);
    for (const c of r.cells.slice(0, 12)) {
      say(`      ${(c.dim + ": " + c.key).padEnd(26)} ${c.upPct.toFixed(1).padStart(6)}`
        + ` ${(c.liftPP >= 0 ? "+" : "") + c.liftPP.toFixed(1)}pp`.padStart(8)
        + ` ${String(c.resolved).padStart(9)}       ${c.foldsAgreeing}/${c.foldsJudged}`
        + `        ${c.foldUpPct.map(v => v == null ? "  -  " : v.toFixed(1)).join(" ")}`);
    }
    say("");
  }
}

say("-".repeat(100));
say("  HOW TO READ THIS");
say("    A cell is only interesting if its lift exceeds the fold-to-fold spread above AND");
say("    most folds agree on the direction of that lift. A big lift with 1/5 folds agreeing");
say("    is one lucky window. Nothing here is wired to anything: it changes no gate, no");
say("    threshold and no signal, and it is not a trading instruction.");
say("=".repeat(100));

// TODAY'S READ, per asset per timeframe — what the daily plan and the chart consume.
const today = results.map(todayRead);
say("");
say("=".repeat(100));
say("  TODAY'S READ — the state of the last CLOSED bar, priced against the table above");
say("=".repeat(100));
for (const t of today) {
  if (t.error) { say(`  ${t.symbol} ${t.tf}: ${t.error}`); continue; }
  const mark = t.actionable ? ">>" : "  ";
  say(`${mark} ${t.symbol} ${t.tf.padEnd(3)} state ${t.state.padEnd(16)} squeeze=${t.squeeze.padEnd(7)} as of ${t.asOf.slice(0, 16).replace("T", " ")}`);
  say(`     ${t.verdict}`);
  if (t.cellUpPct != null) say(`     sample ${t.resolved} resolved · timeframe base ${t.baseUpPct}% · noise bar ${t.noiseBarPP}pp`);
}
const live = today.filter(t => t.actionable);
say("");
say(live.length
  ? `  ${live.length} actionable read(s) right now: ` + live.map(t => `${t.symbol} ${t.tf} ${t.cellUpPct}%`).join(", ")
  : "  NO actionable read right now — every current state sits inside its own noise bar.");
say("  That is the expected answer on most days and is not a fault.");
say("=".repeat(100));

fs.mkdirSync(OUT_DIR, { recursive: true });
const txt = path.join(OUT_DIR, "candle-probability-latest.txt");
const json = path.join(OUT_DIR, "candle-probability-latest.json");
const todayJson = path.join(OUT_DIR, "candle-today.json");
fs.writeFileSync(txt, lines.join("\n") + "\n", "utf8");
fs.writeFileSync(json, JSON.stringify({ generatedAt: new Date().toISOString(), reachAtr: REACH_ATR, folds: FOLDS, results }, null, 2), "utf8");
// Small, stable, and the only file a consumer needs — the full table is for a human.
fs.writeFileSync(todayJson, JSON.stringify({
  generatedAt: new Date().toISOString(), reachAtr: REACH_ATR, folds: FOLDS,
  note: "Bar geometry measured out-of-sample. NOT a trading instruction: no spread, no "
      + "slippage, and a bar's high/low order is unknowable so both-sides bars are excluded.",
  reads: today,
}, null, 2), "utf8");
console.log(`\n  written -> ${path.relative(ROOT, txt)}, .json, and candle-today.json`);
