// Cross-tab of SETUP x REGIME, split BY YEAR, out of sample.
//
//   node tasks/regime_xtab.cjs [projRoot]
//
// WHY THIS EXISTS
// The VPS weekly review of 2026-08-09 proposed vetoing RANGE_TRADE_SHORT whenever
// regime is RANGING, and named its own precondition: n=24 is thin, short-side bans
// are usually bull-sample bias, so split by year AND setup and ship only if it stays
// negative across years. It prescribed `tasks/_regime_xtab.cjs` — a file that has
// never existed on either box. This is that check, actually written.
//
// The proposal deserves the work: it named journal trade XAUUSD RANGE_TRADE_SHORT in
// RANGING (opened 2026-08-07) as the week's weakness two days before that trade closed
// at -$99.10, and the rejection ledger independently has RANGE_TRADE_SHORT at 0W/12L,
// the only setup on the board with zero wins.
//
// WHAT A RESULT HERE DOES AND DOES NOT LICENCE
// A cell that is negative in EVERY scorable year is evidence a veto would not simply
// be fitting one bull sample. That is the precondition for proposing the veto — it is
// not the veto, and it is not permission to edit the gate. A cell negative in only
// some years is exactly the bias the review warned about and must NOT be shipped.
//
// Two populations are reported and they are not interchangeable:
//   - CONF FLOOR: everything the engine formed down to confidence 40. Large, so the
//     geometry is measurable, but most of it is below the live gate and never trades.
//   - AT THE GATE: only setups that would clear the live confidenceThreshold. This is
//     the population a veto would actually change. It is usually thin. A verdict read
//     off the floor population and applied to the gate is the same category error as
//     reading the paper ledger as realised P&L.
//
// Deterministic — no AI, no network, no live-server reads, no config changes.
// Writes only tasks/analysis/ and appends tasks/logs/regime_xtab.txt.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = process.argv[2] || path.join(__dirname, "..");

const ASSETS = [
  ["XAUUSD", "GC=F"],
  ["BTCUSD", "BTC-USD"],
  ["SP500",  "^GSPC"],
];

// Same basis as tasks/cohort_walkforward.cjs and tasks/mtf_walkforward.cjs so numbers
// from all three are comparable. Changing one without the others silently makes them
// incomparable while every report keeps printing R/trade as if it meant the same thing.
const COST_R     = 0.05;
const CONF_FLOOR = 40;

// A year with fewer closed trades than this says nothing about that year, and letting
// it vote is how one thin stretch decides a verdict.
const MIN_CLOSED_PER_YEAR = 8;
// Below two scorable years the whole question — "does it hold ACROSS years" — is
// unanswerable, whatever the pooled number looks like.
const MIN_SCORABLE_YEARS = 2;

// The regime field comes off the MTF result, not off a per-timeframe signal. Resolving
// it through pickTf once returned null on EVERY row and was only caught by counting
// populated values instead of trusting the field (see _replay_mtf.cjs:570). A
// cross-tab keyed on a null column would print a clean, confident, meaningless table,
// so this refuses below the threshold rather than reporting one.
const MIN_REGIME_POPULATED_PCT = 80;

const OUT_DIR = path.join(ROOT, "tasks", "analysis");
fs.mkdirSync(OUT_DIR, { recursive: true });

function readGate() {
  // The gate the "AT THE GATE" population is defined by. Read from the saved config,
  // never hardcoded — a file whose purpose is arguing about thresholds is the worst
  // possible place to bake one in.
  const file = path.join(ROOT, "server", "strategy_settings.json");
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")).confidenceThreshold;
    if (Number.isFinite(value)) return { gate: value, source: "server/strategy_settings.json" };
    return { gate: null, source: `confidenceThreshold missing or not a number in ${file}` };
  } catch (err) {
    return { gate: null, source: `unreadable: ${file} (${err.message})` };
  }
}

function replay(symbol, ticker) {
  const stdout = execFileSync(
    process.execPath,
    [path.join(ROOT, "tasks", "_replay_mtf.cjs"), ROOT, symbol, ticker, String(CONF_FLOOR)],
    { env: { ...process.env, MTF_CONF_FLOOR: String(CONF_FLOOR) },
      maxBuffer: 64 * 1024 * 1024, encoding: "utf8", timeout: 900000 }
  );
  return JSON.parse(stdout);
}

function stat(trades) {
  const closed = trades.filter(t => t.outcome !== "EXPIRED");
  const wins   = closed.filter(t => t.outcome === "WIN");
  const losses = closed.filter(t => t.outcome === "LOSS");
  const grossWin  = wins.reduce((a, t) => a + t.rr - COST_R, 0);
  const grossLoss = losses.reduce(a => a + 1 + COST_R, 0);
  return {
    closed: closed.length,
    wr: closed.length ? (wins.length / closed.length) * 100 : 0,
    R: grossWin - grossLoss,
    rpt: closed.length ? (grossWin - grossLoss) / closed.length : 0,
  };
}

// _replay_mtf.cjs emits `t` as a UNIX timestamp in SECONDS (verified: the Gold replay
// spans 1658836800 -> 2026-07-22, the 4-year window the proposal cites). Reading it as
// milliseconds put every trade in 1970, and the only reason that surfaced as an empty
// per-year table instead of one confident bogus row is the sanity range below. Detect
// the unit rather than hardcode it: any real millisecond epoch after 1973 exceeds 1e11,
// and a seconds epoch does not reach 1e11 until the year 5138, so the split is
// unambiguous for any date this system will ever replay.
const MS_EPOCH_FLOOR = 1e11;

function yearOf(t) {
  if (!Number.isFinite(t)) return null;
  const ms = t < MS_EPOCH_FLOOR ? t * 1000 : t;
  const year = new Date(ms).getUTCFullYear();
  // Still range-checked. A field that changes shape again must produce a visibly
  // empty table, never a plausible wrong one.
  return year >= 2000 && year <= 2100 ? year : null;
}

// The question is stability across years, not an average of them. A cell is only
// evidence for a veto when every year that can be scored agrees.
function verdictOf(scorableYears, negativeYears) {
  if (scorableYears < MIN_SCORABLE_YEARS) return "TOO FEW YEARS";
  if (negativeYears === scorableYears)    return "NEGATIVE EVERY YEAR";
  if (negativeYears === 0)                return "POSITIVE EVERY YEAR";
  return "MIXED BY YEAR";
}

function cellsFrom(trades, keyOf) {
  const cells = new Map();
  for (const t of trades) {
    const key = keyOf(t);
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(t);
  }
  const out = [];
  for (const [key, rows] of cells) {
    const pooled = stat(rows);
    const byYear = new Map();
    for (const row of rows) {
      const year = yearOf(row.t);
      if (year === null) continue;
      if (!byYear.has(year)) byYear.set(year, []);
      byYear.get(year).push(row);
    }
    const years = [...byYear.entries()]
      .map(([year, rows2]) => ({ year, ...stat(rows2) }))
      .sort((a, b) => a.year - b.year);
    const scorable = years.filter(y => y.closed >= MIN_CLOSED_PER_YEAR);
    const negative = scorable.filter(y => y.rpt < 0);
    out.push({
      key,
      trades: rows.length,
      pooled: {
        closed: pooled.closed, wr: +pooled.wr.toFixed(1),
        R: +pooled.R.toFixed(1), rpt: +pooled.rpt.toFixed(3),
      },
      years: years.map(y => ({
        year: y.year, closed: y.closed, wr: +y.wr.toFixed(1),
        R: +y.R.toFixed(1), rpt: +y.rpt.toFixed(3),
        scorable: y.closed >= MIN_CLOSED_PER_YEAR,
      })),
      scorableYears: scorable.length,
      negativeYears: negative.length,
      verdict: verdictOf(scorable.length, negative.length),
    });
  }
  return out.sort((a, b) => a.pooled.rpt - b.pooled.rpt);
}

const { gate, source: gateSource } = readGate();
if (gate === null) {
  // Refuse rather than assume: the entire "AT THE GATE" population is defined by this
  // number, and guessing it would let the report state a confident falsehood.
  console.error(`regime-xtab: cannot read the live gate — ${gateSource}`);
  process.exit(2);
}

const all = [];
const perAsset = {};
for (const [symbol, ticker] of ASSETS) {
  try {
    const trades = replay(symbol, ticker);
    perAsset[symbol] = { trades: trades.length };
    for (const t of trades) all.push({ ...t, sym: symbol });
  } catch (err) {
    // A replay that throws must be loud. A silently missing asset reads exactly like
    // "that asset never forms this setup", which would quietly answer the question
    // wrongly — the failure this whole family of tools exists to stop.
    perAsset[symbol] = { error: String(err.message || err).slice(0, 300) };
    console.error(`regime-xtab: ${symbol} replay FAILED — ${perAsset[symbol].error}`);
  }
}

if (all.length === 0) {
  console.error("regime-xtab: no trades from any asset — nothing to measure");
  process.exit(1);
}

all.sort((a, b) => a.t - b.t);

const withRegime = all.filter(t => t.regime != null && t.regime !== "");
const regimePct = (withRegime.length / all.length) * 100;
if (regimePct < MIN_REGIME_POPULATED_PCT) {
  console.error(
    `regime-xtab: regime is populated on only ${withRegime.length}/${all.length} ` +
    `(${regimePct.toFixed(1)}%) of trades, below the ${MIN_REGIME_POPULATED_PCT}% floor. ` +
    `A cross-tab keyed on a mostly-null column would look clean and mean nothing — ` +
    `see _replay_mtf.cjs:570, where this exact field once read null on every row. ` +
    `Refusing to report.`);
  process.exit(3);
}

const keyOf = t => `${t.setup ?? "NONE"} x ${t.regime}`;
const atFloor = cellsFrom(withRegime, keyOf);
const atGate  = cellsFrom(withRegime.filter(t => Number.isFinite(t.conf) && t.conf >= gate), keyOf);
const atGateByKey = new Map(atGate.map(c => [c.key, c]));

const generatedAt = new Date().toISOString();
const report = {
  generatedAt,
  basis: {
    path: "generateSignalMTF via tasks/_replay_mtf.cjs",
    gate, gateSource, costR: COST_R, confFloor: CONF_FLOOR,
    minClosedPerYear: MIN_CLOSED_PER_YEAR, minScorableYears: MIN_SCORABLE_YEARS,
    totalTrades: all.length,
    regimePopulated: `${withRegime.length}/${all.length} (${regimePct.toFixed(1)}%)`,
    caveat: "rr artifacts are NOT capped; years are calendar years, so a partial "
          + "first or last year is thinner by construction and may fall below the "
          + "per-year floor; the CONF FLOOR population is mostly below the live gate "
          + "and never trades",
  },
  perAsset,
  atConfFloor: atFloor,
  atLiveGate: atGate,
};

const lines = [];
const W = 108;
lines.push("=".repeat(W));
lines.push(`  SETUP x REGIME, SPLIT BY YEAR — ${generatedAt}`);
lines.push(`  ${all.length} trades, cost ${COST_R}R, conf floor ${CONF_FLOOR}, gate ${gate} (${gateSource})`);
lines.push(`  regime populated on ${withRegime.length}/${all.length} (${regimePct.toFixed(1)}%)`);
lines.push("=".repeat(W));
lines.push("");
lines.push(`  POPULATION: CONF FLOOR ${CONF_FLOOR} — the geometry. Most of this never reaches the live gate.`);
lines.push("");
lines.push("  setup x regime                             closed   R/trade   yrs-   verdict");
lines.push("  " + "-".repeat(W - 4));
for (const c of atFloor) {
  lines.push(
    "  " + c.key.padEnd(42) +
    String(c.pooled.closed).padStart(6) +
    ((c.pooled.rpt >= 0 ? "+" : "") + c.pooled.rpt.toFixed(3)).padStart(10) +
    `${c.negativeYears}/${c.scorableYears}`.padStart(7) + "   " + c.verdict
  );
}
lines.push("");
lines.push(`  yrs- = years with R/trade below zero, out of years with >= ${MIN_CLOSED_PER_YEAR} closed trades`);
lines.push("");
lines.push("=".repeat(W));
lines.push(`  POPULATION: AT THE LIVE GATE (conf >= ${gate}) — what a veto would actually change.`);
lines.push("=".repeat(W));
if (!atGate.length) {
  lines.push("");
  lines.push("  No replayed setup ever reached the live gate. A veto here would change nothing");
  lines.push("  that trades, and no verdict about the live gate can be drawn from this run.");
} else {
  lines.push("");
  lines.push("  setup x regime                             closed   R/trade   yrs-   verdict");
  lines.push("  " + "-".repeat(W - 4));
  for (const c of atGate) {
    lines.push(
      "  " + c.key.padEnd(42) +
      String(c.pooled.closed).padStart(6) +
      ((c.pooled.rpt >= 0 ? "+" : "") + c.pooled.rpt.toFixed(3)).padStart(10) +
      `${c.negativeYears}/${c.scorableYears}`.padStart(7) + "   " + c.verdict
    );
  }
}

// The cell the proposal is about, spelled out year by year in both populations. A
// pooled number cannot answer the question the review actually asked.
const FOCUS = "RANGE_TRADE_SHORT x RANGING";
lines.push("");
lines.push("=".repeat(W));
lines.push(`  THE PROPOSAL: ${FOCUS}`);
lines.push("=".repeat(W));
for (const [label, cell] of [["CONF FLOOR", atFloor.find(c => c.key === FOCUS)],
                             ["AT THE GATE", atGateByKey.get(FOCUS)]]) {
  lines.push("");
  lines.push(`  ${label}:`);
  if (!cell) {
    lines.push(`    no trades in this cell — the proposal cannot be evaluated on this population`);
    continue;
  }
  lines.push(`    pooled: ${cell.pooled.closed} closed, ${cell.pooled.wr}% WR, `
    + `${cell.pooled.R >= 0 ? "+" : ""}${cell.pooled.R}R, `
    + `${cell.pooled.rpt >= 0 ? "+" : ""}${cell.pooled.rpt.toFixed(3)}R/trade`);
  lines.push("    year   closed     WR        R    R/trade   counted?");
  for (const y of cell.years) {
    lines.push("    " + String(y.year).padEnd(7) + String(y.closed).padStart(6)
      + (y.wr.toFixed(1) + "%").padStart(8)
      + ((y.R >= 0 ? "+" : "") + y.R.toFixed(1)).padStart(9)
      + ((y.rpt >= 0 ? "+" : "") + y.rpt.toFixed(3)).padStart(11)
      + (y.scorable ? "   yes" : "   no (thin)"));
  }
  lines.push(`    verdict: ${cell.verdict} `
    + `(${cell.negativeYears} of ${cell.scorableYears} scorable years negative)`);
}
lines.push("");
lines.push("  HOW TO READ THIS");
lines.push("  NEGATIVE EVERY YEAR at the gate is the only result that supports the veto, and it");
lines.push("  supports PROPOSING it, not shipping it. MIXED BY YEAR is precisely the bull-sample");
lines.push("  bias the review warned about — do not ship on a pooled number that hides it.");
lines.push("  Changing this gate touches signal generation, so it is stop-and-show regardless.");
lines.push("=".repeat(W));

const stamp = generatedAt.replace(/[-:]/g, "").slice(0, 15);
fs.writeFileSync(path.join(OUT_DIR, `regime-xtab-${stamp}.json`), JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(OUT_DIR, "regime-xtab-latest.json"), JSON.stringify(report, null, 2));
const text = lines.join("\n") + "\n";
fs.appendFileSync(path.join(ROOT, "tasks", "logs", "regime_xtab.txt"), text + "\n");
process.stdout.write(text);
