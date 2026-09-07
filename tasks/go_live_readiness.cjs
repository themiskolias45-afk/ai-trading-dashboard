'use strict';
/**
 * Is this system ready for real money yet?
 *
 * THE QUESTION THIS ANSWERS, and the one it refuses to answer.
 *
 * It answers: "given everything measured so far, has this system earned real
 * money?" It does NOT answer "is the strategy any good" — that is what the
 * walk-forward harnesses are for, and they run on years of bars rather than on
 * the handful of live fills this file can see.
 *
 * WHY IT EXISTS. "When can I go live" had no written answer, so it was going to
 * be decided by whoever felt confident on the day. Every other threshold in this
 * project has a number attached and a tool that watches it — the sizing trigger,
 * the evidence floor, the cohort reachability table — and the single largest
 * decision in the system had neither. A trigger nobody watches is a decision
 * made by mood.
 *
 * FIVE GATES, AND THEY ARE AND-ED, NOT SCORED. There is no "4 out of 5, close
 * enough". Each one fails for an independent reason and each one alone is
 * sufficient to lose money:
 *
 *   EDGE          the returns might be noise
 *   UPTIME        the machine might be asleep when it matters
 *   CALIBRATION   the confidence number might mean nothing
 *   RECORD        the books might be wrong about what happened
 *   REPRODUCTION  live might not be doing what the backtest promised
 *
 * A weighted score would let a strong EDGE reading paper over a box that
 * hibernates unattended, and those two risks do not offset. They compound.
 *
 * IT DECIDES NOTHING AND WRITES NOTHING. No config is read for writing, no
 * setting changes, no trade is affected, nothing is persisted. It prints a
 * verdict and the arithmetic behind it. Going live stays a human decision.
 *
 * ── What it refuses to do the easy way ──────────────────────────────────────
 *
 * 1. R COMES FROM THE SERVER'S OWN SCORER, borrowed from tasks/sizing_trigger.cjs
 *    which extracts realizedRFromPrices out of server/index.js at run time. The
 *    journal's `rr` field is the signal's PLAN and not the outcome; deriving R
 *    here with a fourth copy of the formula is how the copies drift apart.
 *
 * 2. THE CONFIDENCE BOUND USES t, NOT 1.645. On five trades the normal
 *    approximation understates the interval badly, and it errs in the direction
 *    that makes a tiny sample look trustworthy — the exact failure this file is
 *    built to prevent. Borrowed from sizing_trigger for the same no-drift reason.
 *
 * 3. UPTIME AND RECORD INTEGRITY ARE NOT RE-DERIVED. tasks/doctor.cjs already
 *    owns checkCoverageGaps and checkLearningIntegrity and its findings are the
 *    ones the rest of the project reads. A second implementation would sooner or
 *    later disagree with the doctor and there would be no way to say which was
 *    right.
 *
 * 4. IT NEVER POOLS THE TWO BOXES. journal.json is per-machine. This reports the
 *    box it runs on and names it. Pooling would also assume both boxes run the
 *    same engine, which only vps_parity.cjs can establish.
 *
 * Usage:
 *   node tasks/go_live_readiness.cjs [--json]
 */

const fs   = require("fs");
const os   = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");

const sizingTrigger = require("./sizing_trigger.cjs");
const doctor        = require("./doctor.cjs");

// ── The five thresholds ─────────────────────────────────────────────────────
// Each is a number rather than a judgement, and each is named here rather than
// inline so that changing one is a visible edit to this list.

// EDGE. The one-sided 95% lower bound on realised R per trade must be above
// zero. Not the mean — the mean of five trades is a coin. This is the same
// standard the sizing trigger applies to Gold, applied to the whole book.
const EDGE_LOWER_BOUND_MIN_R = 0;

// Costs charged flat, the house standard across every MTF harness here.
const COST_R = 0.05;

// EDGE floor. Below this many closed fills the bound is not even reported as a
// pass or fail, because with n this small the interval is wider than any
// plausible edge and "fail" would imply the test had power. It does not.
const EDGE_MIN_FILLS = 30;

// UPTIME. A hole is a stretch with no ensure_running heartbeat. Real money on a
// box that vanishes for hours is an unmanaged position, and the whole point of
// the 2026-08 sleep investigation was that these holes are invisible in the log
// unless you read the GAPS rather than the last tick.
const UPTIME_MAX_HOLES = 0;

// CALIBRATION. A confidence tier claiming 85% should win about 85% of the time.
// Below this many trades in a tier there is nothing to compare.
const CALIBRATION_MIN_TRADES_PER_TIER = 10;
// How far a tier's realised win rate may sit from the midpoint of its own band
// before the confidence number is not carrying information.
const CALIBRATION_TOLERANCE_PCT = 20;

// RECORD. Every closed fill must carry a real setup name. A fill booked as
// "WAIT" means the name was lost upstream, and a book that cannot say what it
// traded cannot be audited after a loss.
const RECORD_MAX_UNATTRIBUTED = 0;

const PASS = "PASS", FAIL = "FAIL", WAIT = "WAIT";

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return null; }
}

/**
 * Closed fills with an R derived from prices by the server's own scorer.
 *
 * A fill missing any of entry/stop/close is skipped and COUNTED as skipped
 * rather than dropped silently — a shrinking denominator nobody mentions is how
 * a book flatters itself.
 */
function closedFillsWithR(root, scorer) {
  const journalFile = path.join(root, "server", "journal.json");
  const raw = readJson(journalFile);
  if (!raw) throw new Error("cannot read server/journal.json");
  const rows = Array.isArray(raw) ? raw : (raw.journal || raw.trades || []);

  const scored = [];
  let skipped = 0;
  for (const trade of rows) {
    if (trade.status !== "CLOSED") continue;
    // Four positional args, matching server/index.js:4012 exactly. Passing the
    // trade object returns null for every row, and a scorer that silently scores
    // nothing reads as "no fills yet" rather than as a broken call.
    const r = scorer(trade.direction, trade.entry, trade.sl, trade.closePrice);
    if (!Number.isFinite(r)) { skipped++; continue; }
    scored.push({
      symbol: trade.symbol,
      setup: trade.setup,
      confidence: trade.confidence,
      r: r - COST_R,
      openTime: trade.openTime,
    });
  }
  return { scored, skipped, totalClosed: rows.filter(t => t.status === "CLOSED").length };
}

/**
 * Fills per day, measured across the whole book rather than one instrument.
 *
 * sizing_trigger refuses to give an ETA off 3 Gold fills and it is right to: a
 * rate from that few is confidently wrong. This has the whole book, which is
 * more, but it is still a handful, so the estimate is returned WITH the sample
 * it rests on and is labelled soft everywhere it is printed. A number that says
 * "12 months" reads as a plan unless it also says what it is built from.
 */
function fillRatePerDay(root) {
  const raw = readJson(path.join(root, "server", "journal.json"));
  const rows = Array.isArray(raw) ? raw : ((raw && (raw.journal || raw.trades)) || []);
  const times = rows.map(t => Date.parse(t.openTime)).filter(Number.isFinite).sort((a, b) => a - b);
  if (times.length < 2) return null;
  const spanDays = (times[times.length - 1] - times[0]) / 86400000;
  if (spanDays <= 0) return null;
  return { fills: times.length, spanDays, perDay: times.length / spanDays };
}

function meanAndBound(values) {
  const n = values.length;
  if (n < 2) return { n, mean: n ? values[0] : null, sd: null, lowerBound: null };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  const t = sizingTrigger.tCritical95OneSided(n - 1);
  return { n, mean, sd, lowerBound: mean - t * (sd / Math.sqrt(n)), t };
}

/**
 * How many more fills before the bound could clear zero, HOLDING the observed
 * mean and spread. Stated as a projection and not a promise: if the mean drifts
 * the number moves, and if the mean is negative there is no such number at all.
 */
function fillsNeeded(mean, sd) {
  if (!(mean > 0) || !(sd > 0)) return null;
  // Asymptotic form: t -> 1.645. Rounded up, then floored at the edge minimum.
  return Math.max(EDGE_MIN_FILLS, Math.ceil((1.645 * sd / mean) ** 2));
}

function gateEdge(fills, rate) {
  const rs = fills.scored.map(f => f.r);
  const stats = meanAndBound(rs);
  const needed = fillsNeeded(stats.mean, stats.sd);
  const remaining = needed === null ? null : Math.max(0, needed - stats.n);
  // Months, not days: presenting "370 days" from a 7-fill rate would be false
  // precision. The rate itself is reported beside it so the softness is visible.
  const etaMonths = (remaining !== null && rate && rate.perDay > 0)
    ? (remaining / rate.perDay) / 30.44
    : null;
  const etaText = etaMonths === null
    ? "no estimate — a negative mean has no sample size that fixes it"
    : `roughly ${etaMonths.toFixed(0)} months at the current rate of 1 fill per `
      + `${(1 / rate.perDay).toFixed(1)} days (SOFT: that rate is measured off `
      + `${rate.fills} fills over ${rate.spanDays.toFixed(0)} days)`;

  if (stats.n < EDGE_MIN_FILLS) {
    return {
      name: "EDGE", status: WAIT, stats, needed,
      detail: `${stats.n} closed fills, floor is ${EDGE_MIN_FILLS} — the interval is `
        + `wider than any plausible edge, so this is not yet a test that can fail`,
      etaMonths,
      changes: needed
        ? `about ${needed} closed fills (${remaining} more) at the current mean `
          + `(${stats.mean === null ? "n/a" : stats.mean.toFixed(3)}R) and spread `
          + `(${stats.sd === null ? "n/a" : stats.sd.toFixed(3)}R) — ${etaText}`
        : "a positive mean first — at a negative mean no sample size makes the bound clear zero",
    };
  }
  const ok = stats.lowerBound > EDGE_LOWER_BOUND_MIN_R;
  return {
    name: "EDGE", status: ok ? PASS : FAIL, stats, needed,
    detail: `95% lower bound ${stats.lowerBound.toFixed(3)}R on ${stats.n} fills `
      + `(mean ${stats.mean.toFixed(3)}R, sd ${stats.sd.toFixed(3)}R, cost ${COST_R}R)`,
    changes: ok ? "nothing — this gate is met" : `the bound rising above ${EDGE_LOWER_BOUND_MIN_R}R`,
  };
}

function gateUptime(root) {
  doctor._reset();
  try { doctor.checkCoverageGaps(root); } catch (e) {
    return { name: "UPTIME", status: WAIT, detail: `could not read the heartbeat log: ${e.message}`,
             changes: "a readable tasks/logs/ensure_running.txt" };
  }
  // A doctor finding is {severity, box, what, why, remedy}. It has no `title` and
  // no `detail`, and reading fields that do not exist tested /hole/ against the
  // string "undefined", which matches nothing — so this gate reported PASS on a
  // box that had been asleep for 6h42m the previous night. Every finding from
  // checkCoverageGaps IS a hole, so no filtering is needed or wanted: this
  // function has exactly one job and anything it reports fails the gate.
  const holes = doctor._findings();
  if (!holes.length) {
    return { name: "UPTIME", status: PASS, detail: "no heartbeat holes in the doctor's window",
             changes: "nothing — this gate is met" };
  }
  return {
    name: "UPTIME", status: FAIL,
    detail: holes.map(h => h.what).filter(Boolean).join(" | ") || "coverage gaps reported",
    changes: `${UPTIME_MAX_HOLES} holes over a subsequent window — apply tasks/SLEEP-RUNBOOK.md `
      + `and give it two days before believing it`,
  };
}

/**
 * Tiers are the same bands /api/performance reports, so the two surfaces cannot
 * disagree about what "the 85% tier" means.
 */
const TIERS = [
  { label: "65-74%", lo: 65, hi: 75, midpoint: 70 },
  { label: "75-84%", lo: 75, hi: 85, midpoint: 80 },
  { label: "85-94%", lo: 85, hi: 95, midpoint: 90 },
];

function gateCalibration(fills) {
  const rows = [];
  for (const tier of TIERS) {
    const inTier = fills.scored.filter(f => Number.isFinite(f.confidence)
      && f.confidence >= tier.lo && f.confidence < tier.hi);
    const wins = inTier.filter(f => f.r > 0).length;
    rows.push({
      tier: tier.label, trades: inTier.length, wins,
      winRatePct: inTier.length ? Math.round((wins / inTier.length) * 100) : null,
      expectedPct: tier.midpoint,
      judged: inTier.length >= CALIBRATION_MIN_TRADES_PER_TIER,
    });
  }
  const judged = rows.filter(r => r.judged);
  if (!judged.length) {
    return {
      name: "CALIBRATION", status: WAIT, rows,
      detail: `no confidence tier has ${CALIBRATION_MIN_TRADES_PER_TIER} trades yet `
        + `(best is ${Math.max(0, ...rows.map(r => r.trades))})`,
      changes: `${CALIBRATION_MIN_TRADES_PER_TIER} trades inside a single tier`,
    };
  }
  const off = judged.filter(r => Math.abs(r.winRatePct - r.expectedPct) > CALIBRATION_TOLERANCE_PCT);
  return {
    name: "CALIBRATION", status: off.length ? FAIL : PASS, rows,
    detail: off.length
      ? off.map(r => `${r.tier} claims ~${r.expectedPct}% and returns ${r.winRatePct}% over ${r.trades}`).join(" | ")
      : judged.map(r => `${r.tier}: ${r.winRatePct}% over ${r.trades}`).join(" | "),
    changes: off.length ? "the confidence score tracking realised win rate within "
      + CALIBRATION_TOLERANCE_PCT + " points" : "nothing — this gate is met",
  };
}

function gateRecord(root, fills) {
  const problems = [];

  const unattributed = fills.scored.filter(f => {
    const name = String(f.setup || "").toUpperCase();
    return !name || name === "WAIT" || name === "NONE" || name === "UNKNOWN";
  });
  if (unattributed.length > RECORD_MAX_UNATTRIBUTED) {
    problems.push(`${unattributed.length} of ${fills.scored.length} closed fills carry no real setup name`);
  }
  if (fills.skipped > 0) {
    problems.push(`${fills.skipped} closed fill(s) have no derivable R (missing entry, stop or close)`);
  }

  doctor._reset();
  try {
    doctor.checkLearningIntegrity(root);
    for (const f of doctor._findings()) if (f.what) problems.push(f.what);
  } catch (e) { problems.push(`learning integrity unreadable: ${e.message}`); }

  return {
    name: "RECORD", status: problems.length ? FAIL : PASS,
    detail: problems.length ? problems.join(" | ") : "every closed fill is attributable and the books agree",
    changes: problems.length ? "each fill carrying the setup that produced it" : "nothing — this gate is met",
  };
}

/**
 * Does live do what the replay said it would? This is the cheapest gate to
 * satisfy in principle and the one that matters most, because it is the only one
 * that tests the BACKTEST rather than the sample: years of out-of-sample bars
 * already exist, and the live book only has to show it is reproducing them.
 *
 * Read from the artefact live_vs_replay writes rather than the session-gated
 * route, so this tool keeps working without a login.
 */
function gateReproduction(root) {
  const file = path.join(root, "tasks", "logs", "live_vs_replay_last.json");
  const snap = readJson(file);
  if (!snap) {
    return {
      name: "REPRODUCTION", status: WAIT,
      detail: "no live-vs-replay snapshot on disk — the comparison exists at "
        + "/api/live-vs-replay but nothing has written its verdict where a tool can read it",
      changes: "a recorded live-vs-replay verdict, then enough firings for it to leave TOO FEW TO JUDGE",
    };
  }
  const verdict = snap.verdict || snap.rateVerdict || null;
  if (!verdict || /TOO FEW/i.test(verdict)) {
    return { name: "REPRODUCTION", status: WAIT, detail: `live vs replay: ${verdict || "no verdict"}`,
             changes: "enough live firings for the comparison to clear its own evidence floor" };
  }
  const ok = /AGREE|MATCH|WITHIN/i.test(verdict);
  return { name: "REPRODUCTION", status: ok ? PASS : FAIL, detail: `live vs replay: ${verdict}`,
           changes: ok ? "nothing — this gate is met" : "live firing at the rate and edge replay predicted" };
}

function assess(root = ROOT) {
  const scorer = sizingTrigger.loadServerScorer(root);
  const fills  = closedFillsWithR(root, scorer);

  const rate = fillRatePerDay(root);
  const gates = [
    gateEdge(fills, rate),
    gateUptime(root),
    gateCalibration(fills),
    gateRecord(root, fills),
    gateReproduction(root),
  ];

  const passed = gates.filter(g => g.status === PASS).length;
  // AND-ed, deliberately: one FAIL or one WAIT is enough. A gate that cannot be
  // evaluated is not a gate that passed, and treating WAIT as a soft pass is how
  // "we never actually checked" becomes "we checked and it was fine".
  const ready = gates.every(g => g.status === PASS);

  return {
    box: os.hostname(),
    generatedAt: new Date().toISOString(),
    ready,
    passed,
    total: gates.length,
    verdict: ready ? "READY" : "NOT YET",
    gates,
    fillRate: rate,
    sample: {
      closedFills: fills.scored.length,
      skippedNoR: fills.skipped,
      totalClosed: fills.totalClosed,
    },
    // Said in the payload so no dashboard can present this as permission.
    decides: "nothing — this is a reading, and going live stays a human decision",
  };
}

function formatReport(a) {
  const L = [];
  const bar = "=".repeat(78);
  L.push(bar);
  L.push(`  GO-LIVE READINESS — ${a.box} — ${a.generatedAt.slice(0, 16).replace("T", " ")}Z`);
  L.push(`  VERDICT: ${a.verdict} — ${a.passed} of ${a.total} gates met`);
  L.push(bar);
  L.push("");
  for (const g of a.gates) {
    L.push(`  [${g.status}] ${g.name.padEnd(13)} ${g.detail}`);
    L.push(`         ${" ".repeat(13)} what would change it: ${g.changes}`);
    L.push("");
  }
  const edge = a.gates.find(g => g.name === "EDGE");
  if (edge && edge.needed && edge.stats && Number.isFinite(edge.stats.n)) {
    L.push(`  Sample: ${a.sample.closedFills} closed fills scored`
      + (a.sample.skippedNoR ? `, ${a.sample.skippedNoR} skipped with no derivable R` : "")
      + `. Projection holds the current mean and spread; both will move.`);
    L.push("");
  }
  L.push("  These gates are AND-ed. There is no 4-of-5. Each one alone loses money.");
  L.push(`  This tool decides ${a.decides}.`);
  L.push(bar);
  return L.join("\n");
}

module.exports = { assess, formatReport, EDGE_MIN_FILLS, COST_R };

if (require.main === module) {
  try {
    const a = assess();
    if (process.argv.includes("--json")) console.log(JSON.stringify(a, null, 2));
    else console.log(formatReport(a));
    // Exit 0 on a successful MEASUREMENT whatever the verdict. "Not ready" is a
    // working run; conflating it with a broken reader would make a crashed tool
    // look like a considered no.
    process.exit(0);
  } catch (err) {
    console.error(`[go-live-readiness] could not measure: ${err.message}`);
    process.exit(1);
  }
}
