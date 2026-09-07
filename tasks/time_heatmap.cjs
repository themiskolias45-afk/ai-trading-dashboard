// WHEN does this system make and lose money? Time-of-day, weekday, session, month, year.
//
//   node tasks/time_heatmap.cjs [projRoot]
//
// THE RESOLUTION IS SIX BLOCKS A DAY, NOT TWENTY-FOUR, AND THAT IS NOT A CHOICE.
// Entries are taken on H4 bars, so every trade in the replay opens on one of exactly
// six UTC hours: 00, 04, 08, 12, 16, 20. Verified on the Gold replay — 265 trades
// across 6 distinct hours and 5 weekdays, nothing else. A 24-column hourly heat map
// would be eighteen structurally empty columns presented as data, which is worse than
// no heat map: it invents a question the engine cannot answer and then answers it.
// Each H4 block happens to open inside exactly one of the system's own UTC sessions,
// so the block view and the session view are the same measurement seen twice.
//
// WHAT A RESULT HERE DOES AND DOES NOT LICENCE
// A hot cell is a hypothesis, not a schedule. Thirty cells (6 blocks x 5 weekdays) over
// a few hundred trades means the best-looking cell is the one most likely to be noise —
// with 30 cells you should EXPECT a couple to look strong by chance. Nothing here is a
// walk-forward. Treat a standout cell as something to fold-test, never as a reason to
// stop trading a session, and read the AT THE GATE table rather than the floor one
// before drawing any conclusion about live behaviour.
//
// Deterministic — no AI, no network, no live-server reads, no config changes.
// Writes only tasks/analysis/ and appends tasks/logs/time_heatmap.txt.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { writeArtifactSync } = require("./write_artifact.cjs");
const { cappedRr } = require("./_rr_cap.cjs");

const ROOT = process.argv[2] || path.join(__dirname, "..");

const ASSETS = [
  ["XAUUSD", "GC=F"],
  ["BTCUSD", "BTC-USD"],
  ["SP500",  "^GSPC"],
];

// Same basis as cohort_walkforward.cjs, mtf_walkforward.cjs and regime_xtab.cjs so
// every R/trade in this project means the same thing.
const COST_R     = 0.05;
const CONF_FLOOR = 40;

// A cell below this says nothing. Shown, but never given a verdict and never ranked.
const MIN_CLOSED_PER_CELL = 8;

// _replay_mtf.cjs emits `t` in SECONDS. Read as milliseconds it puts every trade in
// 1970; detect the unit rather than trust it. Any real ms epoch after 1973 exceeds
// 1e11 and a seconds epoch does not reach it until the year 5138.
const MS_EPOCH_FLOOR = 1e11;

// The system's own session boundaries, from get_time_context. Every H4 open hour lands
// in exactly one of these, which is why the block table and the session table agree.
const SESSIONS = [
  ["ASIAN",       22, 7],
  ["PRE-LONDON",   7, 9],
  ["LONDON",       9, 12],
  ["OVERLAP",     12, 13],
  ["NEW YORK",    13, 17],
  ["AFTER HOURS", 17, 22],
];

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                     "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const OUT_DIR = path.join(ROOT, "tasks", "analysis");
fs.mkdirSync(OUT_DIR, { recursive: true });

function readGate() {
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
  const grossWin  = wins.reduce((a, t) => a + cappedRr(t.rr) - COST_R, 0);
  const grossLoss = losses.reduce(a => a + 1 + COST_R, 0);
  return {
    closed: closed.length,
    wr: closed.length ? (wins.length / closed.length) * 100 : 0,
    R: grossWin - grossLoss,
    rpt: closed.length ? (grossWin - grossLoss) / closed.length : 0,
  };
}

function whenOf(t) {
  if (!Number.isFinite(t)) return null;
  const date = new Date(t < MS_EPOCH_FLOOR ? t * 1000 : t);
  const year = date.getUTCFullYear();
  if (year < 2000 || year > 2100) return null;   // a shape change must show as empty, not plausible
  const hour = date.getUTCHours();
  const session = SESSIONS.find(([, from, to]) =>
    from < to ? hour >= from && hour < to : hour >= from || hour < to);
  return { year, month: date.getUTCMonth(), dow: date.getUTCDay(), hour,
           session: session ? session[0] : "UNKNOWN" };
}

function group(trades, keyOf) {
  const cells = new Map();
  for (const trade of trades) {
    const key = keyOf(trade);
    if (key === null || key === undefined) continue;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(trade);
  }
  const out = new Map();
  for (const [key, rows] of cells) out.set(key, stat(rows));
  return out;
}

// Intensity, not colour: this has to stay readable piped into a log file. The scale is
// fixed rather than relative so two runs are comparable — a relative scale would repaint
// the same numbers differently as the population grows.
function heatOf(rpt, closed) {
  if (!closed) return "  ·  ";
  if (closed < MIN_CLOSED_PER_CELL) return "  ~  ";
  if (rpt >= 0.30) return " +++ ";
  if (rpt >= 0.10) return " ++  ";
  if (rpt > 0)     return " +   ";
  if (rpt > -0.10) return " -   ";
  if (rpt > -0.30) return " --  ";
  return " --- ";
}

const { gate, source: gateSource } = readGate();
if (gate === null) {
  console.error(`time-heatmap: cannot read the live gate — ${gateSource}`);
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
    perAsset[symbol] = { error: String(err.message || err).slice(0, 300) };
    console.error(`time-heatmap: ${symbol} replay FAILED — ${perAsset[symbol].error}`);
  }
}
if (!all.length) {
  console.error("time-heatmap: no trades from any asset — nothing to measure");
  process.exit(1);
}

// A missing asset must be impossible to miss. On 2026-08-12 SP500 threw on every step
// and the failure went to STDERR while stdout carried a complete-looking heat map built
// from two assets out of three. A banner in the report itself is the only version of
// this warning that travels with the numbers.
const failedAssets = Object.entries(perAsset).filter(([, v]) => v && v.error).map(([k]) => k);
const incompleteBanner = failedAssets.length ? [
  "!".repeat(100),
  `  INCOMPLETE: ${failedAssets.join(", ")} produced NO trades — the replay failed for ${failedAssets.length} of ${ASSETS.length} assets.`,
  "  Every cell below describes the remaining assets only. Fix the replay before quoting any of it.",
  "!".repeat(100),
].join("\n") : null;
if (incompleteBanner) console.error(incompleteBanner);

const dated = all.map(t => ({ ...t, when: whenOf(t.t) })).filter(t => t.when);
if (!dated.length) {
  console.error("time-heatmap: no trade carried a readable timestamp — refusing to report");
  process.exit(3);
}

const hours = [...new Set(dated.map(t => t.when.hour))].sort((a, b) => a - b);
const days  = [...new Set(dated.map(t => t.when.dow))].sort((a, b) => a - b);

function buildViews(rows) {
  return {
    blockByDay: group(rows, t => `${t.when.hour}|${t.when.dow}`),
    block:      group(rows, t => t.when.hour),
    day:        group(rows, t => t.when.dow),
    session:    group(rows, t => t.when.session),
    month:      group(rows, t => t.when.month),
    year:       group(rows, t => t.when.year),
  };
}

const atFloor = buildViews(dated);
const atGate  = buildViews(dated.filter(t => Number.isFinite(t.conf) && t.conf >= gate));
const gateRows = dated.filter(t => Number.isFinite(t.conf) && t.conf >= gate).length;

const lines = [];
const W = 100;
const generatedAt = new Date().toISOString();

function cellLine(label, s) {
  if (!s) return "  " + label.padEnd(14) + "        —";
  const flag = s.closed < MIN_CLOSED_PER_CELL ? "  (thin)" : "";
  return "  " + label.padEnd(14) +
    String(s.closed).padStart(6) +
    (s.wr.toFixed(1) + "%").padStart(9) +
    ((s.R >= 0 ? "+" : "") + s.R.toFixed(1)).padStart(9) +
    ((s.rpt >= 0 ? "+" : "") + s.rpt.toFixed(3)).padStart(10) + flag;
}

function section(title, views, population, count) {
  lines.push("");
  lines.push("=".repeat(W));
  lines.push(`  ${title}  —  ${population} (${count} trades)`);
  lines.push("=".repeat(W));

  lines.push("");
  lines.push("  H4 BLOCK x WEEKDAY — R/trade. Six blocks is the true resolution: entries are");
  lines.push("  taken on H4 bars, so no trade can open at any other hour.");
  lines.push("");
  lines.push("      " + days.map(d => DAY_NAMES[d].padStart(5) + " ").join(""));
  for (const h of hours) {
    let row = "  " + String(h).padStart(2, "0") + "h ";
    for (const d of days) {
      const s = views.blockByDay.get(`${h}|${d}`);
      row += (s ? heatOf(s.rpt, s.closed) : "  ·  ") + " ";
    }
    const blockStat = views.block.get(h);
    row += "   " + (blockStat ? `n=${String(blockStat.closed).padStart(3)}  ${(blockStat.rpt >= 0 ? "+" : "") + blockStat.rpt.toFixed(3)}` : "");
    lines.push(row);
  }
  lines.push("");
  lines.push("  key:  +++ >=0.30   ++ >=0.10   + >0   - >-0.10   -- >-0.30   --- worse");
  lines.push(`        ~ = under ${MIN_CLOSED_PER_CELL} closed trades, no verdict    · = no trades`);

  for (const [title2, view, keys, namer] of [
    ["BY SESSION", views.session, SESSIONS.map(s => s[0]), x => x],
    ["BY WEEKDAY", views.day, days, d => DAY_NAMES[d]],
    ["BY MONTH", views.month, [...views.month.keys()].sort((a, b) => a - b), m => MONTH_NAMES[m]],
    ["BY YEAR", views.year, [...views.year.keys()].sort((a, b) => a - b), y => String(y)],
  ]) {
    lines.push("");
    lines.push(`  ${title2}`);
    lines.push("  " + "name".padEnd(14) + "closed".padStart(6) + "WR".padStart(9) + "R".padStart(9) + "R/trade".padStart(10));
    lines.push("  " + "-".repeat(W - 6));
    for (const k of keys) lines.push(cellLine(namer(k), view.get(k)));
  }
}

if (incompleteBanner) lines.push(incompleteBanner);
lines.push("=".repeat(W));
lines.push(`  WHEN THIS SYSTEM WINS AND LOSES — ${generatedAt}`);
lines.push(`  ${dated.length} trades, cost ${COST_R}R, conf floor ${CONF_FLOOR}, gate ${gate} (${gateSource})`);
lines.push(`  entry hours present: ${hours.map(h => String(h).padStart(2, "0")).join(", ")} UTC — H4 bar opens, nothing else is possible`);
lines.push("=".repeat(W));

section("CONF FLOOR", atFloor, `confidence >= ${CONF_FLOOR}`, dated.length);
if (gateRows) {
  section("AT THE LIVE GATE", atGate, `confidence >= ${gate}`, gateRows);
} else {
  lines.push("");
  lines.push("=".repeat(W));
  lines.push("  AT THE LIVE GATE — no replayed trade ever reached it, so nothing here");
  lines.push("  describes live behaviour.");
  lines.push("=".repeat(W));
}

lines.push("");
lines.push("  HOW TO READ THIS");
lines.push("  30 cells over a few hundred trades: the best-looking cell is the one most likely");
lines.push("  to be noise, and with 30 cells you should EXPECT a couple to look strong by chance.");
lines.push("  Nothing here is a walk-forward. A standout cell is something to fold-test, never a");
lines.push("  reason to switch a session off. Read the AT THE GATE table before concluding");
lines.push("  anything about live behaviour — the floor population mostly never trades.");
lines.push("=".repeat(W));

const asObject = views => Object.fromEntries(
  Object.entries(views).map(([k, m]) => [k, Object.fromEntries(m)]));
const report = {
  generatedAt,
  basis: {
    path: "generateSignalMTF via tasks/_replay_mtf.cjs",
    gate, gateSource, costR: COST_R, confFloor: CONF_FLOOR,
    minClosedPerCell: MIN_CLOSED_PER_CELL,
    entryHoursUtc: hours, weekdays: days.map(d => DAY_NAMES[d]),
    totalTrades: dated.length, atGateTrades: gateRows,
    caveat: "Entries are H4 bar opens, so hour-of-day resolution is six blocks and no "
          + "finer. 30 cells over a few hundred trades means multiple-comparisons noise "
          + "is expected; this is not a walk-forward.",
  },
  perAsset,
  atConfFloor: asObject(atFloor),
  atLiveGate: asObject(atGate),
};

const stamp = generatedAt.replace(/[-:]/g, "").slice(0, 15);
// Retried on a transient Windows lock: a bare write here discarded the whole ~2min
// run nightly on the VPS. See tasks/write_artifact.cjs.
writeArtifactSync(path.join(OUT_DIR, `time-heatmap-${stamp}.json`), JSON.stringify(report, null, 2));
writeArtifactSync(path.join(OUT_DIR, "time-heatmap-latest.json"), JSON.stringify(report, null, 2));
const text = lines.join("\n") + "\n";
fs.appendFileSync(path.join(ROOT, "tasks", "logs", "time_heatmap.txt"), text + "\n");
process.stdout.write(text);
