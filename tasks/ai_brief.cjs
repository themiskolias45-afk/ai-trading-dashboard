'use strict';
/**
 * The briefing an AI agent should have READ before it starts work.
 *
 * On 2026-08-09 the weekly review proposed a fix to /api/trade-opened that had
 * already been implemented, more thoroughly than it asked for. It was not wrong
 * — the reasoning was sound and code-cited — it was UNBRIEFED. It had no way to
 * see what it had proposed before, what was decided, or what had already been
 * measured. It also emitted the same finding three times across two files.
 *
 * That is the difference between a capable contractor and a professional
 * colleague: the colleague knows what has already been tried.
 *
 * This assembles that context from what the project already records:
 *
 *   - decisions on its own past proposals   tasks/ai_decisions.jsonl
 *   - proposals still awaiting review        the AI work ledger
 *   - what has been MEASURED and settled     server/evidence_register.js
 *   - the live configuration and gate        server/strategy_settings.json
 *   - how much evidence exists to reason on  the scored rejection ledger
 *
 * Usage:
 *   node tasks/ai_brief.cjs            print to stdout
 *   node tasks/ai_brief.cjs --write    also write tasks/ai_brief.md
 *
 * READ-ONLY except for --write, which writes exactly one file it owns.
 */

const fs   = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
function load(rel) {
  try { return require(path.join(ROOT, rel)); } catch (e) { return null; }
}
function readJson(rel) {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8")); } catch (e) { return null; }
}

const workLedger  = load("server/ai_work_ledger.js");
const register    = load("server/evidence_register.js");
const growth      = load("server/learning_growth.js");
const settings    = readJson("server/strategy_settings.json");

const out = [];
const line = s => out.push(s === undefined ? "" : s);

line("# AI BRIEFING — read this before proposing anything");
line();
line("Generated " + new Date().toISOString() + " by tasks/ai_brief.cjs.");
line("You are not starting from zero. Everything below is already known.");
line();

// ── 1. Do not re-propose ────────────────────────────────────────────────────
line("## 1. Proposals already decided — DO NOT REPEAT THESE");
line();
let decided = [];
try {
  const decisions = workLedger ? workLedger.readDecisions() : {};
  decided = Object.values(decisions);
} catch (e) { /* no decisions yet */ }

if (!decided.length) {
  line("_Nothing decided yet._");
} else {
  line("| status | what | note |");
  line("|---|---|---|");
  for (const d of decided) {
    const note = (d.note || "").replace(/\|/g, "\\|");
    line("| **" + d.status + "** | " + d.file + ":" + d.line + " | "
      + (note.length > 220 ? note.slice(0, 217) + "…" : note) + " |");
  }
  line();
  line("**If your finding matches one of these, say so and move on.** Re-raising a");
  line("closed item costs a review cycle and makes the rest of your work look careless.");
}
line();

// ── 2. Still open ───────────────────────────────────────────────────────────
line("## 2. Your own proposals still awaiting review");
line();
try {
  const work = workLedger ? workLedger.build() : null;
  const open = work ? work.proposals.filter(p => p.status === "UNREVIEWED") : [];
  if (!open.length) line("_None — you are clear to propose._");
  else {
    for (const p of open) {
      line("- `" + p.id + "` (" + p.ageDays + "d old) " + p.file + ":" + p.line);
      line("  > " + p.text.replace(/\s+/g, " ").slice(0, 200));
    }
    line();
    line("**Do not restate these.** If new evidence changes one, reference its id.");
  }
} catch (e) { line("_work ledger unavailable_"); }
line();

// ── 3. Track record, and the calls nobody has graded ────────────────────────
//
// The ledger has always had a `call` field — whether a proposal's DIAGNOSIS held
// up, separate from what was done with its fix — and ai_decide.cjs has always
// accepted --call. It went unused for every proposal ever made, because scoring
// depended on a human remembering an optional flag and nothing ever showed the
// gap. An agent that is never told whether it was right cannot get better, and
// raising its output rate without that signal just manufactures unread work.
//
// Listing the unscored ones HERE is what lets the agent close its own loop.
line("## 3. Your track record — and the calls still ungraded");
line();
// `deferred` is spelled out here rather than left to be inferred from section 1, because
// section 1 is headed DO NOT REPEAT THESE and a deferred item is genuinely still open.
// Without this paragraph an agent reads its own accepted-but-unapplied proposal as closed
// and stops mentioning it — or worse, re-derives it from scratch, which is what happened
// on 2026-08-16 when the morning agent rewrote its own cb-losses proposal verbatim.
try {
  const deferredRows = decided.filter(d => d.status && String(d.status).trim().toLowerCase() === "deferred");
  // ASCII only in these strings, same reason as section 4: the console is cp1252 and a
  // briefing that cannot be printed is a briefing nobody reads.
  line("A status of **deferred** means: your diagnosis was RIGHT, the fix was ACCEPTED, and");
  line("it has NOT been applied yet. It is not a rejection and it is not done - the work is");
  line("still owed. Do not re-derive a deferred proposal from scratch; reference its id and");
  line("add only what is new.");
  line();
  if (deferredRows.length) {
    line("**Accepted but not yet applied - " + deferredRows.length + " open:**");
    line();
    for (const d of deferredRows) {
      line("- `" + d.id + "` " + (d.file || "?") + ":" + (d.line === undefined ? "?" : d.line)
        + (d.note ? " - " + String(d.note).replace(/\s+/g, " ").slice(0, 160) : ""));
    }
    line();
  }
} catch (e) { line("_deferred proposals unavailable_"); }
try {
  const scored = decided.filter(d => d.call);
  const right    = scored.filter(d => d.call === "right").length;
  const wrong    = scored.filter(d => d.call === "wrong").length;
  const unproven = scored.filter(d => d.call === "unproven").length;
  if (!decided.length) {
    line("_No decided proposals yet, so nothing to score._");
  } else {
    line("Graded calls: **" + right + " right**, " + wrong + " wrong, " + unproven + " unproven"
      + "  (of " + decided.length + " decided).");
    line();
    // A call is scorable once someone acted on the proposal. An UNREVIEWED one is
    // not ungraded work, it is undecided work, and belongs in section 2.
    const unscored = decided.filter(d => !d.call);
    if (!unscored.length) {
      line("**Every decided proposal has a graded call.** Nothing to do here.");
    } else {
      line("**These were acted on but never graded — grade them before proposing anything new:**");
      line();
      for (const d of unscored) {
        line("- `" + d.id + "` (" + d.status + ") " + d.file + ":" + d.line);
      }
      line();
      line("For each, decide whether the DIAGNOSIS held up — not whether the fix was");
      line("taken. A proposal can be rejected and still have been right. Report each as");
      line("a line of the form:");
      line();
      line("    SCORED CALL: <id> right|wrong|unproven — <the evidence that settles it>");
      line();
      line("Do not run any command; a human records it with");
      line("`node tasks/ai_decide.cjs <id> <status> \"note\" --call <verdict>`.");
    }
  }
} catch (e) { line("_call history unavailable_"); }
line();

// ── 4. Settled questions ────────────────────────────────────────────────────
line("## 4. Already MEASURED — do not re-litigate without new evidence");
line();
if (!register) line("_evidence register unavailable_");
else {
  for (const c of register.getRegister().claims) {
    line("- **" + c.title + "** — " + c.status + (c.feedsTheGate ? "  _(feeds the gate)_" : "  _(no vote)_"));
    // getRegister() attaches `staleness` to any claim whose declared sample has moved, and
    // this section USED TO DROP IT — printing the stale evidence under a heading that says
    // "do not re-litigate". That is the one place a stale number does real damage: it does
    // not merely mislead, it instructs the reader not to check. MIN_RR's evidence said "86
    // resolved" here for five days while the ledger held 394.
    //
    // ASCII only in these strings. daily_notes.py died on a U+2212 today because the
    // console is cp1252, and a briefing that cannot be printed is a briefing nobody reads.
    if (c.staleness) {
      line("  - !! SAMPLE HAS MOVED - treat the numbers below as UNVERIFIED: "
        + c.staleness.drifted.join("; "));
      if (c.staleness.sampleFrom) {
        line("    - written against: " + c.staleness.sampleFrom);
      }
      line("    - This claim is the EXCEPTION to the rule at the end of this section. Its own");
      line("      evidence has expired, so re-measuring it needs no new argument - it IS the");
      line("      argument. Re-curate server/evidence_register.js rather than citing this.");
    }
    line("  - evidence: " + c.evidence.replace(/\s+/g, " "));
    line("  - would change the answer: " + c.changesTheAnswer.replace(/\s+/g, " "));
  }
  line();
  line("A claim marked MEASURED — NO EDGE has been tested and failed. Proposing to");
  line("use it anyway needs an argument about the MEASUREMENT, not about the idea —");
  line("UNLESS it carries a SAMPLE HAS MOVED warning above. For those, the numbers are");
  line("stale and proposing a re-measurement is the correct thing to do.");
}
line();

// ── 5. The configuration actually in force ──────────────────────────────────
line("## 5. Live configuration — never assume these numbers");
line();
if (!settings) line("_strategy_settings.json not readable on this box — read GET /api/strategy-settings and check settingsError._");
else {
  line("- confidence gate: **" + settings.confidenceThreshold + "**");
  line("- minStrength: " + settings.minStrength + "   ·   maxTradesPerDay: " + settings.maxTradesPerDay);
  line("- fixedLotSize: " + settings.fixedLotSize + "   ·   maxLotSize: " + settings.maxLotSize);
  line("- adxTrendingMin: " + settings.adxTrendingMin + "   ·   minEntryRsi: " + settings.minEntryRsi
    + (Number(settings.minEntryRsi) === 0 ? " _(disarmed)_" : ""));
  line();
  line("This file is PER-MACHINE and untracked. The other box may differ.");
}
line();

// ── 6. How much evidence you actually have ──────────────────────────────────
line("## 6. Evidence available to reason from");
line();
try {
  const g = growth ? growth.build() : null;
  if (g && g.available) {
    line("- resolved paper episodes: **" + g.totals.resolved + "**  (" + g.totals.pending + " pending)");
    line("- setups above the " + g.learningThreshold + "-episode threshold: "
      + g.totals.usableSetups + " of " + g.totals.setupsTracked);
    for (const s of g.setups) {
      line("  - `" + s.setup + "` " + s.resolved + " resolved, " + s.winRate + "% win, netR "
        + (s.netR >= 0 ? "+" : "") + s.netR + (s.usable ? "  **usable**" : "  _(needs " + s.stillNeeded + " more)_"));
    }
  } else line("_no scored ledger yet_");
} catch (e) { line("_growth unavailable_"); }
line();
line("These are forgone PAPER trades: no spread, no slippage, entries never filled.");
line("They are evidence about SETUPS, not realised P&L.");
line();
// Counted from the journal, never written down. This sentence used to say "the real
// journal has one closed fill in the system's history"; by the time anyone noticed it
// was four, and it was being handed to every agent on every run as a fact. A hardcoded
// count is a claim with an expiry date and no alarm on it — the same decoration
// problem as a setting with no reader.
try {
  const journal = readJson("server/journal.json");
  if (Array.isArray(journal)) {
    const closed = journal.filter(t => t && t.status === "CLOSED").length;
    const open   = journal.filter(t => t && t.status === "OPEN").length;
    line("The real journal holds **" + closed + " closed fill" + (closed === 1 ? "" : "s")
      + "** and " + open + " open, counted live at brief time.");
  } else {
    line("The real journal could not be read on this box — say so rather than guessing.");
  }
} catch (e) { line("The real journal could not be read on this box — say so rather than guessing."); }
line();
line("If you are asked about performance and there are too few closed trades to support");
line("a conclusion, say exactly that and stop. Inventing one is the worst thing you can");
line("do here.");
line();

// ── 7. House rules ──────────────────────────────────────────────────────────
line("## 7. How to report");
line();
line("- One finding, the most important one. A list of five is a list of none.");
line("- Cite file:line and the evidence. \"Seems risky\" is not a finding.");
line("- Mark a recommendation with `PROPOSED FIX:` on its own line so it can be tracked.");
line("- Say what would CHANGE YOUR MIND. A claim with no falsifier is an opinion.");
line("- If the honest answer is \"not enough data\", that IS the deliverable.");
line("- Never edit source, never commit, never change a setting.");
line("- Where a paper ledger contradicts a walk-forward, the walk-forward wins.");

const text = out.join("\n") + "\n";

if (process.argv.includes("--write")) {
  const dest = path.join(ROOT, "tasks", "ai_brief.md");
  fs.writeFileSync(dest, text, "utf8");
  console.log("wrote " + path.relative(ROOT, dest).replace(/\\/g, "/") + "  (" + text.length + " bytes)");
} else {
  process.stdout.write(text);
}
