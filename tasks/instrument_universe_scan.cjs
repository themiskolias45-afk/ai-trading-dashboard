// Ranks candidate instruments by what the LIVE engine would actually have done on
// them, with the selection bias made visible instead of hidden.
//
//   node tasks/instrument_universe_scan.cjs
//   node tasks/instrument_universe_scan.cjs --dir tasks/history_yahoo --cost 0.05
//
// WHY THE TRAIN/HOLDOUT SPLIT IS NOT OPTIONAL
//
// Scanning ~45 instruments and reporting the best one is a search, and a search over
// enough candidates always returns something that looks excellent. The engine has NO
// per-instrument parameters — the gate, the setups and the stops are global and were
// fixed before this scan existed — so replaying the full series leaks nothing by
// itself. The overfitting risk lives entirely in the SELECTION step: me choosing which
// symbol to believe.
//
// So the split is on the one thing being fitted. Rank on the TRAIN period only, then
// report what those same names did in a HOLDOUT period the ranking never saw. A name
// that leads on train and collapses on holdout was noise. The summary prints the
// survival rate of the top names, which is the number that says whether ANY of this
// is real.
//
// WHAT THIS IS NOT: these are paper trades. _replay_engine.cjs walks bars forward to
// a stop or target with no spread, no slippage, no commission, no borrow, no gap
// through the stop, and a fixed MAX_HOLD horizon. --cost subtracts a flat per-trade R
// so the ranking can be stress-tested, but a real fill is worse than a modelled one.
// Same standing caveat as the rejection ledger: a screening signal, never realised P&L.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const REPLAY = path.join(__dirname, "_replay_engine.cjs");

// Fraction of each instrument's trade history used to RANK. The remainder is the
// holdout the ranking never sees.
const TRAIN_FRACTION = 0.7;
// Below this a per-instrument expectancy is noise. The project's walk-forward work
// uses >=40 trades per fold; this is a single split, so the floor is lower, but a
// handful of trades must never reach a league table.
const MIN_TRADES_TO_RANK = 25;
const MIN_HOLDOUT_TRADES = 8;
const DEFAULT_COST_R = 0.05;   // matches the 0.05R cost used in the MTF walk-forwards

function parseArgs(argv) {
  const args = { dir: path.join(__dirname, "history_yahoo"), cost: DEFAULT_COST_R };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--dir" && argv[i + 1]) { args.dir = argv[++i]; continue; }
    if (argv[i] === "--cost" && argv[i + 1]) {
      const parsed = Number(argv[++i]);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`--cost must be a non-negative number, got "${argv[i]}"`);
      }
      args.cost = parsed;
    }
  }
  return args;
}

// One trade's result in R. A WIN returns its planned R:R, a LOSS returns -1, and an
// EXPIRED trade returns 0 — it reached neither stop nor target inside MAX_HOLD, so it
// is a flat scratch, not a win. Counting EXPIRED as a win is the single easiest way to
// make any strategy look profitable, which is why it is spelled out here.
function tradeResultR(trade, costR) {
  if (trade.outcome === "WIN") return trade.rr - costR;
  if (trade.outcome === "LOSS") return -1 - costR;
  return -costR;
}

function summarise(trades, costR) {
  if (trades.length === 0) {
    return { trades: 0, wins: 0, losses: 0, expired: 0, winRate: 0, totalR: 0, expectancy: 0 };
  }
  let wins = 0, losses = 0, expired = 0, totalR = 0;
  for (const trade of trades) {
    if (trade.outcome === "WIN") wins++;
    else if (trade.outcome === "LOSS") losses++;
    else expired++;
    totalR += tradeResultR(trade, costR);
  }
  const decided = wins + losses;
  return {
    trades: trades.length,
    wins, losses, expired,
    winRate: decided > 0 ? wins / decided : 0,
    totalR,
    expectancy: totalR / trades.length,
  };
}

function replayInstrument(csvPath) {
  // stdout is a JSON trade array by contract; stderr carries the DEGRADED warning.
  // A degraded run is NOT silently ranked — an incomplete trade list that looks like
  // a clean one is the failure mode _replay_engine.cjs explicitly warns about.
  let stdout, stderr = "";
  try {
    stdout = execFileSync(process.execPath, [REPLAY, csvPath], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    return { error: (err.stderr || err.message || "replay failed").trim().split("\n")[0] };
  }

  let trades;
  try {
    trades = JSON.parse(stdout);
  } catch {
    return { error: "replay did not return parseable JSON" };
  }
  if (!Array.isArray(trades)) return { error: "replay returned a non-array" };

  return { trades, degraded: stderr.includes("REPLAY DEGRADED") };
}

function main() {
  const args = parseArgs(process.argv);

  if (!fs.existsSync(args.dir)) {
    console.error(`No such directory: ${args.dir}`);
    process.exit(1);
  }

  const csvFiles = fs.readdirSync(args.dir).filter(f => f.toLowerCase().endsWith(".csv")).sort();
  if (csvFiles.length === 0) {
    console.error(`No CSVs in ${args.dir} — run tasks/fetch_yahoo_history.cjs first.`);
    process.exit(1);
  }

  const rows = [];
  const skipped = [];

  for (const file of csvFiles) {
    const symbol = file.replace(/_D1\.csv$/i, "").replace(/\.csv$/i, "");
    const outcome = replayInstrument(path.join(args.dir, file));

    if (outcome.error) { skipped.push({ symbol, why: outcome.error }); continue; }

    const trades = outcome.trades.slice().sort((a, b) => a.t - b.t);
    if (trades.length < MIN_TRADES_TO_RANK) {
      skipped.push({ symbol, why: `only ${trades.length} trades, need ${MIN_TRADES_TO_RANK}` });
      continue;
    }

    const splitIndex = Math.floor(trades.length * TRAIN_FRACTION);
    const trainTrades = trades.slice(0, splitIndex);
    const holdoutTrades = trades.slice(splitIndex);

    if (holdoutTrades.length < MIN_HOLDOUT_TRADES) {
      skipped.push({ symbol, why: `holdout only ${holdoutTrades.length} trades` });
      continue;
    }

    rows.push({
      symbol,
      degraded: outcome.degraded,
      splitAt: new Date(holdoutTrades[0].t * 1000).toISOString().slice(0, 10),
      train: summarise(trainTrades, args.cost),
      holdout: summarise(holdoutTrades, args.cost),
      all: summarise(trades, args.cost),
    });
  }

  if (rows.length === 0) {
    console.error("Nothing rankable. Every candidate was skipped:");
    for (const s of skipped) console.error(`  ${s.symbol}: ${s.why}`);
    process.exit(2);
  }

  rows.sort((a, b) => b.train.expectancy - a.train.expectancy);

  const pct = n => (n * 100).toFixed(1) + "%";
  const r3 = n => (n >= 0 ? "+" : "") + n.toFixed(3);

  console.log(`\nINSTRUMENT SCAN — live engine replayed, cost ${args.cost}R/trade`);
  console.log(`Ranked on TRAIN (first ${Math.round(TRAIN_FRACTION * 100)}% of each name's trades). `
            + `HOLDOUT was never used to rank.\n`);
  console.log("rank symbol      | train n   exp/trade  win%  | HOLDOUT n  exp/trade  win%   totalR  | verdict");
  console.log("-".repeat(112));

  rows.forEach((row, i) => {
    const heldUp = row.holdout.expectancy > 0;
    const verdict = row.train.expectancy <= 0 ? "train negative"
                  : heldUp ? "HELD UP" : "collapsed out-of-sample";
    console.log(
      String(i + 1).padStart(3) + " " +
      (row.symbol + (row.degraded ? "*" : "")).padEnd(12) + " | " +
      String(row.train.trades).padStart(5) + "  " + r3(row.train.expectancy).padStart(9) + "  " +
      pct(row.train.winRate).padStart(5) + " | " +
      String(row.holdout.trades).padStart(7) + "  " + r3(row.holdout.expectancy).padStart(9) + "  " +
      pct(row.holdout.winRate).padStart(5) + "  " + r3(row.holdout.totalR).padStart(7) + "  | " +
      verdict
    );
  });

  // The number that decides whether the whole exercise means anything.
  const TOP_N = Math.min(10, rows.length);
  const top = rows.slice(0, TOP_N);
  const survivors = top.filter(r => r.holdout.expectancy > 0);
  const allPositiveHoldout = rows.filter(r => r.holdout.expectancy > 0).length;

  console.log("\n" + "=".repeat(112));
  console.log(`SELECTION CHECK — the only line that says whether this is edge or noise`);
  console.log(`  Top ${TOP_N} by train expectancy: ${survivors.length}/${TOP_N} stayed positive on holdout `
            + `(${pct(survivors.length / TOP_N)})`);
  console.log(`  Whole universe: ${allPositiveHoldout}/${rows.length} positive on holdout `
            + `(${pct(allPositiveHoldout / rows.length)}) — the base rate`);
  if (survivors.length / TOP_N <= allPositiveHoldout / rows.length) {
    console.log(`  READ THIS: the top ranks did NOT beat the base rate. The ranking carries no`);
    console.log(`  information out-of-sample — picking the "best" name here is picking noise.`);
  } else {
    console.log(`  The top ranks beat the base rate, so the ranking carries SOME signal.`);
    console.log(`  Survivors, in train order: ${survivors.map(s => s.symbol).join(", ")}`);
  }

  if (skipped.length > 0) {
    console.log(`\nSkipped ${skipped.length}: ` + skipped.map(s => `${s.symbol} (${s.why})`).join(", "));
  }
  if (rows.some(r => r.degraded)) {
    console.log(`\n* DEGRADED — the engine threw on some bars; that name's trade list is INCOMPLETE.`);
  }

  console.log(`\nPaper trades: no spread, slippage, commission, borrow or gap-through-stop, fixed`);
  console.log(`MAX_HOLD horizon. A screening signal for what to investigate, never realised P&L.`);
}

main();
