// ATOMIC x ENGINE JOIN - does ATOMIC's agreement predict anything about OUR decisions?
//
// THE SAFEST POSSIBLE SHAPE, and the shape was chosen before the question was asked.
// This script is a pure OBSERVER. It reads two files that already exist and writes a
// third. It is called by nothing that decides anything; it adds no reader to the signal
// path; it runs strictly AFTER the fact, so there is no moment at which it could delay,
// veto or alter a decision.
//
//   It cannot block confidence  - it never runs before a confidence value is computed,
//                                 and server/index.js gains no call to it.
//   It cannot block learning    - it only appends to its own file. It writes nothing the
//                                 learning engine, the journal or the calibration record
//                                 reads.
//   It cannot block a good signal - it has no suppression path at all. Nothing consults
//                                 its output before firing, so the firing set is
//                                 unchanged by construction, not by promise.
//
// The alternative - stamping ATOMIC onto a trade record at fill time - would put a
// third-party read inside the journal writer. That is on the decision path, it needs a
// server restart on the box that trades, and the medic already refused the same class of
// change for the same reason. This does the same job from outside.
//
// WHY REJECTIONS AND NOT TRADES. tasks/rejections_scored.jsonl holds every episode the
// engine EVALUATED, with the gate that stopped it, the confidence it had, and - already
// computed by the existing rejection scorer - the outcome and the R it would have made.
// 357 episodes against 16 closed trades. The interesting question is answerable there and
// nowhere else at this sample size.
//
// THE HONEST LIMIT, stated up front because it will make the first runs look empty:
// ATOMIC has no history. Its indicator overwrote its own file every 60 seconds until
// 2026-09-10, so there is nothing to back-fill and the overlap starts at zero and grows
// from today. A joined row can only exist where BOTH ledgers cover the same moment.
//
//   node tasks/atomic_join.cjs          join what can be joined, write the summary
//   node tasks/atomic_join.cjs --dry    report, write nothing
//
// Exit 0 always.

const fs   = require("fs");
const path = require("path");

const DRY  = process.argv.includes("--dry");
const ROOT = path.join(__dirname, "..");
// PATHS ARE OVERRIDABLE SO THE JOIN CAN BE PROVED BEFORE IT HAS ANYTHING TO JOIN.
// ATOMIC's history starts today, so on a real run this produces zero rows for a while -
// which is the correct answer and also means the joining, the agreement rule and the
// arithmetic would all be unexercised at exactly the moment someone wants to trust them.
function argPath(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return (i !== -1 && process.argv[i + 1]) ? path.resolve(process.argv[i + 1]) : fallback;
}
const ENGINE  = argPath("--engine",  path.join(ROOT, "tasks", "rejections_scored.jsonl"));
const ATOMIC  = argPath("--atomic",  path.join(ROOT, "tasks", "atomic_verdict_ledger.jsonl"));
const JOINED  = argPath("--joined",  path.join(ROOT, "tasks", "atomic_join.jsonl"));
const SUMMARY = argPath("--summary", path.join(ROOT, "dashboard", "atomic-join.json"));
const TEXT    = argPath("--text",    path.join(ROOT, "tasks", "analysis", "atomic-join-latest.txt"));

// How far back an ATOMIC row may be and still describe the same moment. The indicator
// writes at most once a minute and the ledger records changes plus a 60-minute heartbeat,
// so the newest row at or before the episode is never more than an hour old. Beyond that
// it is a different market and pairing them would invent a relationship.
const MAX_LOOKBACK_MIN = 60;
// FORWARD PAIRING IS FORBIDDEN. An ATOMIC row written AFTER the engine's decision knows
// something the engine could not, and joining on "nearest in time" in both directions is
// exactly how a look-ahead result gets manufactured. At or before, never after.
const MIN_N = 30;

function readJsonl(file) {
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

function pct(n, d) { return d > 0 ? Number(((n / d) * 100).toFixed(1)) : null; }
function avg(a) { return a.length ? Number((a.reduce((s, x) => s + x, 0) / a.length).toFixed(4)) : null; }

function main() {
  console.log("");
  console.log("=== ATOMIC x ENGINE JOIN " + (DRY ? "[DRY]" : "") + " ===");

  const engine = readJsonl(ENGINE);
  const atomic = readJsonl(ATOMIC);
  console.log("  engine episodes " + engine.length + ", atomic rows " + atomic.length);
  if (!engine.length || !atomic.length) {
    console.log("  nothing to join yet - both ledgers must cover the same moment");
    return 0;
  }

  // Index ATOMIC rows per symbol, ascending, so the lookup is a binary search rather than
  // a scan per episode.
  const bySymbol = new Map();
  for (const a of atomic) {
    if (!a.symbol || !Number.isFinite(a.epoch)) continue;
    if (!bySymbol.has(a.symbol)) bySymbol.set(a.symbol, []);
    bySymbol.get(a.symbol).push(a);
  }
  for (const rows of bySymbol.values()) rows.sort((x, y) => x.epoch - y.epoch);

  function atomicAt(symbol, epoch) {
    const rows = bySymbol.get(symbol);
    if (!rows || !rows.length) return null;
    let lo = 0, hi = rows.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid].epoch <= epoch) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    if (best < 0) return null;
    const row = rows[best];
    const ageMin = (epoch - row.epoch) / 60;
    return ageMin <= MAX_LOOKBACK_MIN ? { row, ageMin } : null;
  }

  const already = new Set(readJsonl(JOINED).map((r) => r.joinId));
  const fresh = [];
  let noAtomic = 0, noTime = 0;

  for (const e of engine) {
    const ts = Date.parse(e.ts);
    if (!Number.isFinite(ts)) { noTime++; continue; }
    const epoch = Math.floor(ts / 1000);
    const joinId = String(e.symbol) + "|" + String(e.episode) + "|" + e.ts;
    if (already.has(joinId)) continue;

    const hit = atomicAt(e.symbol, epoch);
    if (!hit) { noAtomic++; continue; }
    const a = hit.row;

    // AGREEMENT IS ONLY DEFINED WHEN BOTH COMMITTED TO A SIDE. An ATOMIC WAIT is neither
    // agreement nor disagreement, and folding it into "disagrees" would make a cautious
    // indicator look predictive of every loss.
    const agrees = (a.direction === "BUY" || a.direction === "SELL") &&
                   (e.direction === "BUY" || e.direction === "SELL")
                 ? (a.direction === e.direction) : null;

    fresh.push({
      joinId,
      joinedAt: new Date().toISOString(),
      lookbackMinutes: Number(hit.ageMin.toFixed(2)),
      engine: {
        ts: e.ts, episode: e.episode, symbol: e.symbol, timeframe: e.timeframe,
        setup: e.setup, direction: e.direction, gate: e.gate, gateClass: e.gateClass,
        confidence: e.confidence, threshold: e.threshold,
        outcome: e.outcome, r: e.r,
      },
      atomic: {
        at: a.at, direction: a.direction, finalConsensus: a.finalConsensus,
        confidence: a.confidence, mtfAligned: a.mtfAligned,
        trailDirection: a.trailDirection,
        decisionAgreesWithConsensus: a.decisionAgreesWithConsensus,
        box: a.box, priceSource: a.priceSource,
      },
      agrees,
      // Carried so no reader has to go and check. This file decides nothing.
      feedsTheGate: false,
    });
  }

  console.log("  new joins " + fresh.length +
              ", no atomic row within " + MAX_LOOKBACK_MIN + "min " + noAtomic +
              ", unparseable timestamp " + noTime);

  if (fresh.length && !DRY) {
    try { fs.appendFileSync(JOINED, fresh.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8"); }
    catch (e) { console.log("  APPEND FAILED: " + e.message); return 0; }
  }

  //--- the actual question -----------------------------------------
  const all = DRY ? readJsonl(JOINED).concat(fresh) : readJsonl(JOINED);
  // Only episodes the rejection scorer has already settled. PENDING rows carry r:null and
  // including them as zeros would drag every average toward nothing.
  const settled = all.filter((r) => r.engine && Number.isFinite(r.engine.r));

  const bucket = (rows) => {
    const rs = rows.map((r) => r.engine.r);
    const wins = rows.filter((r) => r.engine.r > 0).length;
    return { n: rows.length, winRate: pct(wins, rows.length), avgR: avg(rs) };
  };

  const table = {
    settledTotal: bucket(settled),
    atomicAgrees:    bucket(settled.filter((r) => r.agrees === true)),
    atomicDisagrees: bucket(settled.filter((r) => r.agrees === false)),
    atomicWait:      bucket(settled.filter((r) => r.agrees === null)),
    atomicMtfAligned: bucket(settled.filter((r) => r.atomic && r.atomic.mtfAligned === true)),
    atomicMtfMixed:   bucket(settled.filter((r) => r.atomic && r.atomic.mtfAligned === false)),
  };

  const ag = table.atomicAgrees, dis = table.atomicDisagrees;
  let verdict;
  if (ag.n < MIN_N || dis.n < MIN_N) {
    verdict = "NO VERDICT - need " + MIN_N + " settled episodes in BOTH arms, have " +
              ag.n + " agree / " + dis.n + " disagree";
  } else {
    const edge = (ag.avgR || 0) - (dis.avgR || 0);
    verdict = "agree avgR " + ag.avgR + " vs disagree " + dis.avgR +
              "  ->  difference " + edge.toFixed(4) + "R" +
              (Math.abs(edge) < 0.05 ? " (flat - no usable signal)" : "");
  }

  const summary = {
    source: "atomic_join.cjs",
    generatedAt: new Date().toISOString(),
    feedsTheGate: false,
    note: "Observer only. Reads tasks/rejections_scored.jsonl and tasks/atomic_verdict_ledger.jsonl " +
          "and writes its own file. It is called by nothing that decides anything, adds no reader to " +
          "the signal path, and runs only after the fact - so it cannot block confidence, learning or " +
          "a signal. Nothing here may be wired into the gate without a walk-forward that clears it.",
    minSampleForVerdict: MIN_N,
    maxLookbackMinutes: MAX_LOOKBACK_MIN,
    engineEpisodes: engine.length,
    atomicRows: atomic.length,
    joinedRows: all.length,
    settledRows: settled.length,
    pendingRows: all.length - settled.length,
    noAtomicRowInWindow: noAtomic,
    overlapNote: "ATOMIC has no history before 2026-09-10 - its indicator overwrote its own file " +
                 "every 60 seconds, so nothing can be back-filled and the overlap grows from today.",
    table,
    verdict,
  };

  if (!DRY) {
    try { fs.writeFileSync(SUMMARY, JSON.stringify(summary, null, 2), "utf8"); }
    catch (e) { console.log("  summary write failed: " + e.message); }
    try {
      fs.mkdirSync(path.dirname(TEXT), { recursive: true });
      const L = [];
      L.push("ATOMIC x ENGINE - " + summary.generatedAt);
      L.push("OBSERVER ONLY. feedsTheGate=false. Blocks nothing - it runs after the fact.");
      L.push("engine episodes " + engine.length + ", atomic rows " + atomic.length +
             ", joined " + all.length + " (settled " + settled.length + ", pending " +
             summary.pendingRows + ")");
      L.push(summary.overlapNote);
      L.push("");
      L.push("bucket".padEnd(20) + "n".padStart(7) + "win%".padStart(8) + "avgR".padStart(10));
      for (const k of Object.keys(table)) {
        const b = table[k];
        L.push(k.padEnd(20) + String(b.n).padStart(7) +
               String(b.winRate === null ? "-" : b.winRate).padStart(8) +
               String(b.avgR === null ? "-" : b.avgR).padStart(10) +
               (b.n < MIN_N ? "   (too few)" : ""));
      }
      L.push("");
      L.push("VERDICT: " + verdict);
      fs.writeFileSync(TEXT, L.join("\n") + "\n", "utf8");
    } catch (e) { console.log("  text write failed: " + e.message); }
  }

  for (const k of Object.keys(table)) {
    const b = table[k];
    console.log("  " + k.padEnd(18) + " n=" + String(b.n).padStart(5) +
                "  win=" + String(b.winRate).padStart(5) + "%  avgR=" + String(b.avgR).padStart(8) +
                (b.n < MIN_N ? "  (too few)" : ""));
  }
  console.log("");
  console.log("  " + verdict);
  return 0;
}

process.exit(main());
