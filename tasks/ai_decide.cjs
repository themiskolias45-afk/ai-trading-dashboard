'use strict';
/**
 * Record a decision on something the AI proposed.
 *
 *   node tasks/ai_decide.cjs <proposal-id> implemented|rejected|ignored [note]
 *   node tasks/ai_decide.cjs <proposal-id> rejected --call right "why"
 *   node tasks/ai_decide.cjs --list
 *
 * status = what you did with the proposed FIX.
 * --call = whether the agent's DIAGNOSIS held up, which is a separate question. A
 *          proposal can be rejected and still have been right, and that combination is
 *          the most useful thing this ledger can record.
 *
 * The AI work ledger can see that a recommendation exists and that nobody has
 * responded to it. It cannot know what you decided. This is that missing half,
 * and it is deliberately a CLI rather than an HTTP POST so the server keeps no
 * write path — the same reasoning that keeps the rejection ledger's writer out
 * of the web tier.
 *
 * APPEND-ONLY. A revision is a new line; nothing is ever rewritten or removed,
 * so the history of what you thought and when survives. Last line wins.
 */

const fs   = require("fs");
const path = require("path");
const ledger = require(path.join(__dirname, "..", "server", "ai_work_ledger.js"));

const VALID = ["implemented", "rejected", "ignored"];

function list() {
  const data = ledger.build();
  if (!data.proposals.length) { console.log("No proposals found in the AI job logs."); return; }
  console.log("AI PROPOSALS — " + data.totals.unreviewed + " unreviewed of " + data.totals.proposals + "\n");
  for (const p of data.proposals) {
    console.log("  " + p.id + "   [" + p.status + "]   " + p.ageDays + "d old   " + p.file + ":" + p.line);
    console.log("     " + p.text.replace(/\s+/g, " ").slice(0, 150));
    if (p.note) console.log("     note: " + p.note);
    console.log("");
  }
  console.log("Decide with:  node tasks/ai_decide.cjs <id> " + VALID.join("|") + " [note]");
}

const [, , id, status, ...noteParts] = process.argv;

if (!id || id === "--list") { list(); process.exit(0); }

if (!VALID.includes(String(status))) {
  console.error("status must be one of: " + VALID.join(", "));
  console.error("usage: node tasks/ai_decide.cjs <proposal-id> " + VALID.join("|") + " [note] [--call right|wrong|unproven]");
  process.exit(1);
}

// Refuse an id that does not exist — a typo silently recorded against nothing is
// worse than an error, because the ledger would keep showing it as unreviewed.
const data = ledger.build();
const match = data.proposals.find(p => p.id === id);
if (!match) {
  console.error("no proposal with id " + id);
  console.error("run  node tasks/ai_decide.cjs --list  to see the ids");
  process.exit(2);
}

// Whether the agent's DIAGNOSIS was right is a different question from what you did
// with its FIX, and conflating them loses the most useful signal this ledger can carry.
//
// The 2026-08-09 weekly review is the proof. It named XAUUSD RANGE_TRADE_SHORT in
// RANGING as the week's weakness two days before that trade closed at -$99.10 — the
// call was RIGHT. Its proposed remedy was a regime veto, which a year-split
// walk-forward then showed was NOT supported: one scorable year, two positive years,
// and the only at-gate trade a winner. So the correct record is status=rejected with
// call=right, and without this field that proposal reads as simply "rejected" and the
// agent looks wrong when it was the most useful thing anyone wrote that week.
//
// Optional and append-only. Existing rows carry no call and report as unscored rather
// than being back-filled with a guess.
const VALID_CALLS = ["right", "wrong", "unproven"];
let call = null;
const callIndex = process.argv.indexOf("--call");
if (callIndex !== -1) {
  const value = String(process.argv[callIndex + 1] || "").toLowerCase();
  if (!VALID_CALLS.includes(value)) {
    console.error("--call must be one of: " + VALID_CALLS.join(", "));
    console.error("  right    = the diagnosis held up, whatever you did with the fix");
    console.error("  wrong    = the diagnosis did not hold up");
    console.error("  unproven = still untested, and saying so beats guessing");
    process.exit(1);
  }
  call = value;
  // Strip the flag and its value out of the note. noteParts is everything after the
  // status, so without this the recorded note reads "--call right Measured..." and the
  // reason is polluted by the syntax that asked for it.
  const flagAt = noteParts.indexOf("--call");
  if (flagAt !== -1) noteParts.splice(flagAt, 2);
  // The note carries WHY, and a scored call with no reason is an opinion with a label.
  if (!noteParts.length) {
    console.error("--call needs a note saying what settled it");
    process.exit(1);
  }
}

const row = {
  id,
  status,
  // What you did with the proposed fix.
  note: noteParts.join(" ").trim(),
  // Whether the agent's reading of the system was correct. Null = never scored.
  call,
  job: match.job,
  file: match.file,
  line: match.line,
  decidedAt: new Date().toISOString(),
};

try {
  fs.appendFileSync(ledger.DECISIONS, JSON.stringify(row) + "\n", "utf8");
} catch (e) {
  console.error("could not append to " + ledger.DECISIONS + ": " + e.message);
  process.exit(3);
}

console.log("recorded: " + id + " -> " + status + (call ? "  [call: " + call + "]" : "") + (row.note ? "  (" + row.note + ")" : ""));
console.log("  " + match.file + ":" + match.line);
console.log("  " + match.text.replace(/\s+/g, " ").slice(0, 140));
