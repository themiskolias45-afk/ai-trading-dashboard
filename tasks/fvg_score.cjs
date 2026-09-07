#!/usr/bin/env node
'use strict';
/**
 * SCORE THE SHADOW ROWS -- did the live model do what the backtest said it would?
 *
 * tasks/fvg_runner.cjs records what FVG continuation WOULD have taken. This walks each
 * row forward on real bars and scores it under exactly the convention the measurement
 * used, so the two numbers are comparable:
 *
 *   stop first on an ambiguous bar   one bar holding both stop and target is unresolvable,
 *                                    and assuming the good one is how a backtest flatters
 *                                    itself
 *   target capped at 5R              as measured
 *   unresolved is MARKED TO MARKET   never scored as a flat scratch -- that truncation is
 *                                    the bias that made every verdict in this repo read low
 *   spread charged per trade         costR = spread / |entry - stop|, measured 2026-09-02
 *
 * REFERENCE, from 1,246 archive trades: +0.4075 gross, 0.1824 cost, +0.2252 NET, 23.6% win
 * rate, 5 folds of 5 positive.
 *
 *   node tasks/fvg_score.cjs                     score the live shadow ledger
 *   node tasks/fvg_score.cjs --backfill 4000     generate rows from the archive tail and
 *                                                score those instead
 *
 * WHY --backfill EXISTS. The live ledger starts empty and fills at roughly six setups a
 * week, so on day one there is nothing to score and no way to tell a working scorer from
 * a broken one. Backfill runs the RUNNER'S OWN evaluate() over the archive tail and scores
 * the result, which does two jobs: it proves this scorer reproduces the reference numbers,
 * and it reports what the model did in the most recent ~60 days rather than across five
 * years. Rows produced this way are labelled BACKFILL and are never written to the live
 * ledger.
 *
 * READ-ONLY. Reads the ledger and the archive, prints. Places nothing, writes nothing.
 */

const fs   = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const { evaluate, MAX_RR, EXEC_WINDOW } = require(path.join(ROOT, "tasks", "fvg_runner.cjs"));

const LEDGER = path.join(ROOT, "tasks", "fvg_shadow.jsonl");
const HOLD_BARS = 960;   // as measured

// Live terminal, 2026-09-02. Spread only: commission, swap and slippage are real and
// none is modelled here.
const SPREAD = { XAUUSD: 0.22, BTCUSD: 17.00, SP500: 0.36 };
const ASSET_SYMBOL = { gold: "XAUUSD", btc: "BTCUSD", spx: "SP500" };

function numArg(f, d) { const i = process.argv.indexOf(f); if (i === -1) return d; const v = Number(process.argv[i + 1]); return Number.isFinite(v) ? v : d; }
const BACKFILL = process.argv.includes("--backfill") ? numArg("--backfill", 4000) : 0;

function load(symbol, tf) {
  const file = path.join(ROOT, "tasks", "history", symbol + "_" + tf + ".csv");
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  lines.shift();
  const times = [], highs = [], lows = [], closes = [];
  for (const raw of lines) {
    const p = raw.trim().split(",");
    if (p.length < 5) continue;
    const t = Number(p[0]), h = Number(p[2]), l = Number(p[3]), c = Number(p[4]);
    if (!(Number.isFinite(t) && Number.isFinite(h) && Number.isFinite(l) && Number.isFinite(c))) continue;
    times.push(t); highs.push(h); lows.push(l); closes.push(c);
  }
  return { times, highs, lows, closes };
}
const upTo = (b, end) => ({
  times: b.times.slice(0, end + 1), highs: b.highs.slice(0, end + 1),
  lows: b.lows.slice(0, end + 1), closes: b.closes.slice(0, end + 1),
});

/** Walk one recorded setup forward from its entry bar. */
function resolve(exec, startIdx, row) {
  const bull = row.direction === "BUY";
  const risk = Math.abs(row.entry - row.stop);
  if (!(risk > 0)) return null;
  const limit = Math.min(startIdx + HOLD_BARS, exec.closes.length - 1);
  for (let i = startIdx + 1; i <= limit; i++) {
    const hitStop   = bull ? exec.lows[i] <= row.stop    : exec.highs[i] >= row.stop;
    const hitTarget = bull ? exec.highs[i] >= row.target : exec.lows[i] <= row.target;
    if (hitStop) return { outcome: "LOSS", r: -1, bars: i - startIdx };
    if (hitTarget) return { outcome: "WIN", r: Math.abs(row.target - row.entry) / risk, bars: i - startIdx };
  }
  if (limit <= startIdx) return { outcome: "PENDING", r: null, bars: 0 };
  const last = exec.closes[limit];
  const move = bull ? last - row.entry : row.entry - last;
  // Still running at the end of the data: marked to market and LABELLED, so a pending row
  // can never be silently counted as a resolved one.
  return { outcome: limit === exec.closes.length - 1 ? "OPEN" : "EXPIRED",
    r: move / risk, bars: limit - startIdx };
}

function readLedger() {
  if (!fs.existsSync(LEDGER)) return [];
  const rows = [];
  for (const raw of fs.readFileSync(LEDGER, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try { rows.push(JSON.parse(line)); }
    catch (e) { console.error("  [corrupt row skipped] " + line.slice(0, 100)); }
  }
  return rows;
}

function buildBackfill(tailBars) {
  const rows = [];
  for (const [assetKey, symbol] of Object.entries(ASSET_SYMBOL)) {
    const bias = load(symbol, "H4"), exec = load(symbol, "M15");
    if (!bias || !exec) continue;
    const from = Math.max(EXEC_WINDOW + 3, exec.closes.length - tailBars);
    let biasCursor = 0, lastEntry = null;
    const seen = new Set();
    for (let i = from; i < exec.closes.length; i++) {
      const tNow = exec.times[i];
      while (biasCursor + 1 < bias.times.length && bias.times[biasCursor + 1] + 14400 <= tNow) biasCursor++;
      if (biasCursor < 200) continue;
      const s = evaluate(assetKey, symbol, upTo(bias, biasCursor), upTo(exec, i), lastEntry);
      if (s && !seen.has(s.key)) { seen.add(s.key); s.backfill = true; rows.push(s); lastEntry = exec.times[i]; }
    }
  }
  return rows;
}

const pad = (v, w) => String(v).padEnd(w);
const num = (v, d) => Number.isFinite(v) ? (v >= 0 ? "+" : "") + v.toFixed(d) : "-";

const rows = BACKFILL ? buildBackfill(BACKFILL) : readLedger();
console.log("=".repeat(104));
console.log("  FVG CONTINUATION -- shadow rows scored on real bars"
  + (BACKFILL ? "   [BACKFILL: archive tail " + BACKFILL + " bars, NOT the live ledger]" : ""));
console.log("  " + new Date().toISOString());
console.log("  Reference from 1,246 archive trades: +0.4075 gross | 0.1824 cost | +0.2252 NET | 23.6% WR");
console.log("=".repeat(104));

if (!rows.length) {
  console.log("");
  console.log("  The live shadow ledger is empty. The runner records roughly six setups a week");
  console.log("  across the three assets, so this is expected until it has been running a while.");
  console.log("  Run `node tasks/fvg_score.cjs --backfill 4000` to score the archive tail instead.");
  process.exit(0);
}

const byAsset = {};
let pendingCount = 0;
for (const row of rows) {
  const symbol = row.symbol && SPREAD[row.symbol] ? row.symbol : ASSET_SYMBOL[row.asset];
  const exec = load(symbol, "M15");
  if (!exec) continue;
  const idx = exec.times.indexOf(row.entryBarTime);
  if (idx === -1) {
    // The entry bar is not in the archive -- a live row newer than the last export. Not
    // an error and not scored: counted and reported so the totals stay honest.
    pendingCount++;
    continue;
  }
  const res = resolve(exec, idx, row);
  if (!res || res.r === null) { pendingCount++; continue; }
  const spread = SPREAD[symbol];
  const cost = spread && row.risk > 0 ? spread / row.risk : null;
  const bucket = byAsset[symbol] || (byAsset[symbol] = { n: 0, wins: 0, gross: 0, cost: 0, open: 0 });
  bucket.n++;
  if (res.r > 0) bucket.wins++;
  bucket.gross += res.r;
  if (cost !== null) bucket.cost += cost;
  if (res.outcome === "OPEN" || res.outcome === "EXPIRED") bucket.open++;
}

console.log("");
console.log("  " + pad("symbol", 9) + pad("scored", 8) + pad("WR%", 8) + pad("unresolved", 12)
  + pad("gross R/t", 11) + pad("costR", 9) + pad("NET R/t", 10) + "net total R");
let tn = 0, tw = 0, tg = 0, tc = 0, to = 0;
for (const [symbol, b] of Object.entries(byAsset)) {
  tn += b.n; tw += b.wins; tg += b.gross; tc += b.cost; to += b.open;
  console.log("  " + pad(symbol, 9) + pad(b.n, 8) + pad((b.wins / b.n * 100).toFixed(1), 8)
    + pad(b.open + " (" + (b.open / b.n * 100).toFixed(0) + "%)", 12)
    + pad(num(b.gross / b.n, 4), 11) + pad((b.cost / b.n).toFixed(4), 9)
    + pad(num((b.gross - b.cost) / b.n, 4), 10) + num(b.gross - b.cost, 2));
}
console.log("  " + "-".repeat(96));
if (tn) {
  console.log("  " + pad("POOLED", 9) + pad(tn, 8) + pad((tw / tn * 100).toFixed(1), 8)
    + pad(to + " (" + (to / tn * 100).toFixed(0) + "%)", 12)
    + pad(num(tg / tn, 4), 11) + pad((tc / tn).toFixed(4), 9)
    + pad(num((tg - tc) / tn, 4), 10) + num(tg - tc, 2));
}
if (pendingCount) {
  console.log("");
  console.log("  " + pendingCount + " row(s) not scored -- entry bar newer than the archive. Re-export with");
  console.log("  `python tasks/export_mt5_history.py XAUUSD BTCUSD SP500` to bring them into range.");
}
console.log("");
console.log("  A gap between NET R/t here and the +0.2252 reference is the number that decides");
console.log("  whether the backtest transfers. Unresolved rows are marked to market, so a high");
console.log("  unresolved share means this table is provisional, not a verdict.");
