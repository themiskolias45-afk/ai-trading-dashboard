// ATOMIC FORWARD SCORER - mark every recorded verdict against what price actually did.
//
// The ledger (tasks/atomic_ledger.cjs) records what ATOMIC said and at what price. This
// says whether it was right, at fixed horizons, with no tuning and no opinion. Together
// they answer the only question that matters about a third-party indicator: does its
// verdict have an edge, and is its agreement worth anything to us?
//
// THE SOURCE LEDGER IS NEVER MODIFIED. Scores are appended to a SEPARATE file keyed by row
// id. Rewriting the sample to add a column is how a sample gets lost, and the sample is the
// scarce thing here - 16 closed trades against thousands of these observations.
//
// NORMALISED IN R, NOT IN DOLLARS OR PIPS. Each row carries the ATR at the time it was
// written, so a move is expressed as a fraction of that bar's own volatility. Gold moving
// 20 and SP500 moving 20 are not the same event, and pooling them in price units produces
// a number that means nothing. This repo already has the scar: "R is the unit, not dollars".
//
// WAIT IS SCORED TOO, AND SCORED DIFFERENTLY. A WAIT that is followed by a big move is a
// miss; a WAIT followed by nothing is a hit. Dropping WAIT rows would score only the rows
// where the indicator committed, which flatters any indicator that commits rarely.
//
//   node tasks/atomic_score.cjs           score everything now due, write the summary
//   node tasks/atomic_score.cjs --dry     compute and report, write nothing
//
// Exit 0 always - this is evidence, not a health check.

const fs   = require("fs");
const path = require("path");

const DRY  = process.argv.includes("--dry");
const ROOT = path.join(__dirname, "..");

// PATHS ARE OVERRIDABLE SO THE MATHS CAN BE PROVED WITHOUT WAITING AN HOUR.
// Every row this scorer writes is "not due yet" until its horizon elapses, which means on
// a fresh install the arithmetic has never run when you most want to know it is right.
// --ledger/--scored/--summary point it at a fixture instead. Nothing else changes: the
// same code path computes the same numbers, which is the point of a fixture over a mock.
function argPath(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return (i !== -1 && process.argv[i + 1]) ? path.resolve(process.argv[i + 1]) : fallback;
}
const LEDGER  = argPath("--ledger",  path.join(ROOT, "tasks", "atomic_verdict_ledger.jsonl"));
const SCORED  = argPath("--scored",  path.join(ROOT, "tasks", "atomic_scored.jsonl"));
const SUMMARY = argPath("--summary", path.join(ROOT, "dashboard", "atomic-ledger.json"));
const TEXT    = argPath("--text",    path.join(ROOT, "tasks", "analysis", "atomic-edge-latest.txt"));
const HISTORY_DIR = path.join(ROOT, "tasks", "history");

// Horizons in minutes. H1 and H4 are the timeframes the engine itself reasons on; D1 is
// there because a verdict that is right in an hour and wrong by the close is not an edge.
const HORIZONS = [
  { name: "h1",  minutes: 60 },
  { name: "h4",  minutes: 240 },
  { name: "d1",  minutes: 1440 },
];

// A WAIT is "correct" when price went nowhere. Nowhere is defined against the row's own
// ATR rather than a fixed number of points, for the same reason the returns are in R.
const WAIT_QUIET_R = 0.5;

function readJsonl(file) {
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

// Bars for one symbol, ascending by epoch. Cached per run: the scorer touches the same
// three files thousands of times and re-reading a 100k-row CSV each time would make a
// five-second job a five-minute one.
const barCache = new Map();
function bars(symbol) {
  if (barCache.has(symbol)) return barCache.get(symbol);
  const csv = path.join(HISTORY_DIR, symbol + "_M15.csv");
  let rows = [];
  try {
    const lines = fs.readFileSync(csv, "utf8").split(/\r?\n/);
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i]) continue;
      const p = lines[i].split(",");
      const t = Number(p[0]), c = Number(p[4]);
      if (Number.isFinite(t) && Number.isFinite(c)) rows.push({ t, c });
    }
  } catch { rows = []; }
  barCache.set(symbol, rows);
  return rows;
}

// The close of the last bar at or before `epoch`. Binary search, because a linear scan per
// row per horizon over 100k bars is the difference between seconds and minutes.
function closeAt(symbol, epoch) {
  const rows = bars(symbol);
  if (!rows.length) return null;
  if (epoch < rows[0].t) return null;
  let lo = 0, hi = rows.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].t <= epoch) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return best >= 0 ? rows[best].c : null;
}

function newestBar(symbol) {
  const rows = bars(symbol);
  return rows.length ? rows[rows.length - 1].t : 0;
}

function pct(n, d) { return d > 0 ? Number(((n / d) * 100).toFixed(1)) : null; }
function avg(a) { return a.length ? Number((a.reduce((s, x) => s + x, 0) / a.length).toFixed(4)) : null; }

function main() {
  console.log("");
  console.log("=== ATOMIC FORWARD SCORER " + (DRY ? "[DRY]" : "") + " ===");

  const ledger = readJsonl(LEDGER);
  if (!ledger.length) {
    console.log("  ledger is empty - run tasks/atomic_ledger.cjs first");
    return 0;
  }
  const already = new Set(readJsonl(SCORED).map((r) => r.id + "|" + r.horizon));
  const nowSec = Math.floor(Date.now() / 1000);

  const fresh = [];
  let notDue = 0, unscoreable = 0;

  for (const row of ledger) {
    if (!Number.isFinite(row.price) || !Number.isFinite(row.epoch)) { unscoreable++; continue; }
    const atr = Number.isFinite(row.atr) && row.atr > 0 ? row.atr : null;

    for (const h of HORIZONS) {
      const id = row.id + "|" + h.name;
      if (already.has(id)) continue;
      const target = row.epoch + h.minutes * 60;
      // NOT DUE is not a failure. The bar has to exist before the question can be asked,
      // and "the horizon has not elapsed" must never be recorded as a miss.
      if (target > nowSec || target > newestBar(row.symbol)) { notDue++; continue; }

      const then = closeAt(row.symbol, target);
      if (!Number.isFinite(then)) { unscoreable++; continue; }

      const move  = then - row.price;
      const moveR = atr ? move / atr : null;
      const dir   = row.direction === "BUY" ? 1 : (row.direction === "SELL" ? -1 : 0);

      let hit = null, signedR = null;
      if (dir !== 0) {
        signedR = moveR === null ? null : Number((moveR * dir).toFixed(4));
        hit = signedR === null ? null : signedR > 0;
      } else {
        // WAIT: right when nothing happened.
        signedR = moveR === null ? null : Number(Math.abs(moveR).toFixed(4));
        hit = signedR === null ? null : signedR < WAIT_QUIET_R;
      }

      fresh.push({
        id: row.id, horizon: h.name, horizonMinutes: h.minutes,
        box: row.box, symbol: row.symbol, direction: row.direction,
        finalConsensus: row.finalConsensus, confidence: row.confidence,
        mtfAligned: row.mtfAligned, trailDirection: row.trailDirection,
        decisionAgreesWithConsensus: row.decisionAgreesWithConsensus,
        priceThen: row.price, priceAfter: then, atr,
        move: Number(move.toFixed(6)), moveR: moveR === null ? null : Number(moveR.toFixed(4)),
        signedR, hit,
        scoredAt: new Date().toISOString(),
        feedsTheGate: false,
      });
    }
  }

  console.log("  ledger rows " + ledger.length + ", already scored " + already.size +
              ", newly scored " + fresh.length + ", not due yet " + notDue +
              ", unscoreable " + unscoreable);

  if (fresh.length && !DRY) {
    try { fs.appendFileSync(SCORED, fresh.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8"); }
    catch (e) { console.log("  APPEND FAILED: " + e.message); return 0; }
  }

  //--- summary, over everything scored so far ----------------------
  const all = DRY ? readJsonl(SCORED).concat(fresh) : readJsonl(SCORED);
  const buckets = new Map();
  const push = (name, r) => {
    if (!buckets.has(name)) buckets.set(name, []);
    buckets.get(name).push(r);
  };
  for (const r of all) {
    if (r.hit === null) continue;
    push("ALL|" + r.horizon, r);
    push(r.symbol + "|" + r.horizon, r);
    push("dir:" + String(r.direction) + "|" + r.horizon, r);
    push("box:" + String(r.box) + "|" + r.horizon, r);
    // The two features worth a column of their own: does the panel's own internal
    // agreement predict anything, and does MTF alignment?
    if (r.decisionAgreesWithConsensus === true)  push("agrees|" + r.horizon, r);
    if (r.decisionAgreesWithConsensus === false) push("disagrees|" + r.horizon, r);
    if (r.mtfAligned === true)  push("mtfAligned|" + r.horizon, r);
    if (r.mtfAligned === false) push("mtfMixed|" + r.horizon, r);
  }

  const table = {};
  for (const [name, rows] of buckets) {
    const hits = rows.filter((r) => r.hit).length;
    const rs   = rows.map((r) => r.signedR).filter((x) => Number.isFinite(x));
    table[name] = { n: rows.length, hits, hitRate: pct(hits, rows.length), avgR: avg(rs) };
  }

  // SAMPLE SIZE IS STATED BESIDE EVERY NUMBER, and a verdict is refused below a floor.
  // A 100% hit rate on 3 observations is the shape of every false discovery this system
  // has had, and a reader who sees only the percentage will believe it.
  const MIN_N = 30;
  const headline = [];
  for (const h of HORIZONS) {
    const b = table["ALL|" + h.name];
    if (!b) continue;
    headline.push({
      horizon: h.name, n: b.n, hitRate: b.hitRate, avgR: b.avgR,
      verdict: b.n < MIN_N ? "TOO FEW - need " + MIN_N + ", have " + b.n
             : (b.avgR > 0.05 ? "positive" : (b.avgR < -0.05 ? "negative" : "flat")),
    });
  }

  const summary = {
    source: "atomic_score.cjs",
    generatedAt: new Date().toISOString(),
    feedsTheGate: false,
    note: "Evidence only. ATOMIC is an unvalidated third-party indicator; nothing here is " +
          "wired into confidence, the gate, position size or a stop. Every figure carries " +
          "its own n, and a bucket under " + MIN_N + " observations gets no verdict.",
    minSampleForVerdict: MIN_N,
    ledgerRows: ledger.length,
    scoredRows: all.length,
    notDueYet: notDue,
    unscoreable,
    horizons: HORIZONS.map((h) => h.name),
    headline,
    table,
  };

  if (!DRY) {
    try { fs.writeFileSync(SUMMARY, JSON.stringify(summary, null, 2), "utf8"); }
    catch (e) { console.log("  summary write failed: " + e.message); }
    try {
      fs.mkdirSync(path.dirname(TEXT), { recursive: true });
      const lines = [];
      lines.push("ATOMIC EDGE - " + summary.generatedAt);
      lines.push("EVIDENCE ONLY. feedsTheGate=false. Nothing here touches the signal path.");
      lines.push("ledger rows " + ledger.length + ", scored " + all.length +
                 ", not due yet " + notDue + ", unscoreable " + unscoreable);
      lines.push("");
      lines.push("bucket".padEnd(28) + "n".padStart(7) + "hit%".padStart(8) + "avgR".padStart(9));
      const names = Object.keys(table).sort();
      for (const n of names) {
        const b = table[n];
        lines.push(n.padEnd(28) + String(b.n).padStart(7) +
                   String(b.hitRate === null ? "-" : b.hitRate).padStart(8) +
                   String(b.avgR === null ? "-" : b.avgR).padStart(9) +
                   (b.n < MIN_N ? "   (too few for a verdict)" : ""));
      }
      lines.push("");
      for (const h of headline) {
        lines.push("ALL " + h.horizon + ": n=" + h.n + " hit=" + h.hitRate + "% avgR=" + h.avgR +
                   "  -> " + h.verdict);
      }
      fs.writeFileSync(TEXT, lines.join("\n") + "\n", "utf8");
    } catch (e) { console.log("  text write failed: " + e.message); }
  }

  for (const h of headline) {
    console.log("  ALL " + h.horizon.padEnd(3) + " n=" + String(h.n).padStart(5) +
                "  hit=" + String(h.hitRate).padStart(5) + "%" +
                "  avgR=" + String(h.avgR).padStart(8) + "   " + h.verdict);
  }
  if (!DRY) console.log("\n  wrote dashboard/atomic-ledger.json and tasks/analysis/atomic-edge-latest.txt");
  return 0;
}

process.exit(main());
