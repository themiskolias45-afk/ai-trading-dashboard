'use strict';
/**
 * Record a decision on something the AI proposed.
 *
 *   node tasks/ai_decide.cjs <proposal-id> implemented|rejected|ignored [note]
 *   node tasks/ai_decide.cjs --list
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
  console.error("usage: node tasks/ai_decide.cjs <proposal-id> " + VALID.join("|") + " [note]");
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

const row = {
  id,
  status,
  note: noteParts.join(" ").trim(),
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

console.log("recorded: " + id + " -> " + status + (row.note ? "  (" + row.note + ")" : ""));
console.log("  " + match.file + ":" + match.line);
console.log("  " + match.text.replace(/\s+/g, " ").slice(0, 140));
