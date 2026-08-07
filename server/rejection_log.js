/**
 * Universal rejection ledger — tasks/rejections.jsonl
 *
 * Every gate that kills a fully-priced setup leaves a row here. A rejection is a
 * complete paper trade: entry, stop and target are all computed before any gate
 * fires, so each row can be scored against what price actually did, at zero risk.
 * The binding constraint on this system is sample size (2 lifetime trades) — this
 * is the only route that manufactures evidence without funding the experiment.
 *
 * Contract: tasks/REJECTION-LEDGER-SPEC.md. The bridge writes the same rows through
 * POST /api/rejections, so the schema below is shared with mt5_bridge.py and with
 * the scorers in tasks/.
 *
 * THIS IS OBSERVABILITY. It must never change what trades and it must never be able
 * to take signal generation down: every path here swallows its own failure into a
 * console line and returns false. Callers inside the engine additionally guard on
 * `typeof logGateRejection === "function"`, because the replay harnesses extract the
 * engine textually into a bare vm sandbox where these bindings do not exist.
 *
 * tasks/rr_rejected.jsonl is FROZEN, not migrated. It holds 11 real rows written
 * under the old schema; the scorer reads both files and normalises. Nothing in this
 * codebase appends to it any more.
 */

const fs   = require("fs");
const path = require("path");

const REJECTIONS_PATH = path.join(__dirname, "..", "tasks", "rejections.jsonl");

// The closed set of gates. A row with any other gate is dropped with a warning
// rather than written, so a typo in the bridge cannot quietly create a phantom
// gate that then reads as "healthy, never fires".
const GATE_NAMES = Object.freeze([
  "MIN_RR", "ENTRY_RSI", "CONFIDENCE", "COHORT_FLOOR", "SPREAD",
  "AI_FILTER", "NEWS_BLACKOUT", "STALE_SOURCE", "DUPLICATE", "MAX_POSITIONS",
]);
const GATE_NAME_SET = new Set(GATE_NAMES);

const SIDE_ENGINE = "engine";
const SIDE_BRIDGE = "bridge";

// Kill/pass counters per gate, in memory, reset on restart. Rejections alone
// cannot tell you a gate is dead — you need the denominator. A gate with a healthy
// kill count and ZERO passes is the alarm: Gold's DAILY_ONLY_H4_NEUTRAL cohort was
// capped at confidence 74 while its floor demanded 75 for 1131 steps with nothing
// reporting it.
//
// Seeded with every gate rather than created on first use, so a gate that has never
// fired at all shows as 0/0 instead of being absent from the payload — "missing"
// and "silent" are different facts and only one of them is an alarm.
const gateStats = {};
for (const gate of GATE_NAMES) gateStats[gate] = { killed: 0, passed: 0 };

const countersStartedAt = new Date().toISOString();

// Last level-signature written per `gate|sourceSymbol|timeframe`. Gates re-fire on
// every refresh and once per timeframe: today's MIN_RR log wrote 7 near-identical
// rows for one drifting Gold short in four hours, and the confidence gate alone
// would write thousands a day. This is a volume control, not a correctness
// mechanism, so it lives in memory and a restart legitimately re-writes one row.
const lastSignatureByScope = new Map();

function finiteOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function trimmedOrNull(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

// Fields are written in this order, and every one is always present. `null` rather
// than an omitted key on purpose: a missing value has to survive into the scorer as
// a real bucket instead of vanishing.
function normaliseRow(record) {
  return {
    ts:           trimmedOrNull(record.ts) ?? new Date().toISOString(),
    gate:         record.gate,
    side:         record.side === SIDE_BRIDGE ? SIDE_BRIDGE : SIDE_ENGINE,
    ticker:       trimmedOrNull(record.ticker),
    label:        trimmedOrNull(record.label),
    dataSource:   trimmedOrNull(record.dataSource),
    // The instrument the levels were priced on. NEVER score off `ticker`: it is
    // always the Yahoo symbol regardless of which feed supplied the bars, and GC=F
    // futures sat ~$60 from XAUUSD spot when the first rows were written.
    sourceSymbol: trimmedOrNull(record.sourceSymbol),
    timeframe:    trimmedOrNull(record.timeframe),
    setup:        trimmedOrNull(record.setup),
    direction:    trimmedOrNull(record.direction),
    entry:        finiteOrNull(record.entry),
    stop:         finiteOrNull(record.stop),
    target:       finiteOrNull(record.target),
    rr:           finiteOrNull(record.rr),
    confidence:   finiteOrNull(record.confidence),
    strength:     trimmedOrNull(record.strength),
    // The number that killed it, and the number that failed.
    threshold:    finiteOrNull(record.threshold),
    actual:       finiteOrNull(record.actual),
    trend:        trimmedOrNull(record.trend),
    rsi:          finiteOrNull(record.rsi),
    // Bridge rows only.
    account:      trimmedOrNull(record.account),
  };
}

// Spec §3.1 — log only a setup that FORMED and was then killed. A step where no
// setup formed is a non-event: XAUUSD alone has 3799 BOTH_WAIT steps in a 5-year
// replay, and logging those would bury the signal and answer nothing.
//
// Returns null when the row is loggable, or the reason it is not.
function unscorableReason(row) {
  if (!row.setup) return "no setup name";
  if (row.direction !== "BUY" && row.direction !== "SELL") return `direction ${row.direction ?? "missing"} is not BUY/SELL`;
  if (row.entry === null || row.stop === null || row.target === null) return "entry/stop/target incomplete";
  if (row.entry === row.stop) return "stop equals entry — risk is zero, nothing to score";
  return null;
}

function signatureOf(row) {
  return [row.setup, row.direction, row.entry, row.stop, row.target].join("|");
}

function scopeOf(row) {
  return `${row.gate}|${row.sourceSymbol}|${row.timeframe}`;
}

/**
 * Record one gate rejection. Returns true when a line was appended.
 *
 * A `false` return is normal and means "deduped", "unscorable" or "the write
 * failed" — never a reason for the caller to change what it does next.
 */
function logGateRejection(record) {
  try {
    if (!record || typeof record !== "object") {
      console.error("[rejections] ignored a non-object record");
      return false;
    }
    if (!GATE_NAME_SET.has(record.gate)) {
      console.error(`[rejections] unknown gate "${record.gate}" — dropped rather than written as junk`);
      return false;
    }

    // Counted before the dedupe and before the write: `killed` is the honest count
    // of kill EVENTS, which is what `passed` is comparable against. Counting only
    // written rows would make a busy gate look quiet purely because its levels were
    // stable.
    gateStats[record.gate].killed++;

    const row = normaliseRow(record);
    const reason = unscorableReason(row);
    if (reason) {
      console.error(`[rejections] ${row.gate} row not scorable (${reason}) — not written`);
      return false;
    }

    const scope     = scopeOf(row);
    const signature = signatureOf(row);
    if (lastSignatureByScope.get(scope) === signature) return false;
    lastSignatureByScope.set(scope, signature);

    fs.mkdirSync(path.dirname(REJECTIONS_PATH), { recursive: true });
    fs.appendFileSync(REJECTIONS_PATH, JSON.stringify(row) + "\n");
    return true;
  } catch (e) {
    // Never let a logging fault reach signal generation — this is observability,
    // not a trading path.
    console.error("[rejections] could not record rejection:", e.message);
    return false;
  }
}

/**
 * Record that a setup faced `gate` and survived it. Call this ONLY when the gate
 * actually evaluated a real candidate — a disarmed gate (minEntryRsi 0) must count
 * neither a kill nor a pass, or the zero-pass alarm becomes unreadable.
 */
function noteGatePass(gate) {
  try {
    if (!GATE_NAME_SET.has(gate)) {
      console.error(`[rejections] unknown gate "${gate}" in noteGatePass — ignored`);
      return;
    }
    gateStats[gate].passed++;
  } catch (e) {
    console.error("[rejections] could not count gate pass:", e.message);
  }
}

module.exports = {
  logGateRejection,
  noteGatePass,
  gateStats,
  GATE_NAMES,
  REJECTIONS_PATH,
  countersStartedAt,
};
