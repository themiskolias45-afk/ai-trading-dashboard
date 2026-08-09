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

// ── 3. Settled questions ────────────────────────────────────────────────────
line("## 3. Already MEASURED — do not re-litigate without new evidence");
line();
if (!register) line("_evidence register unavailable_");
else {
  for (const c of register.getRegister().claims) {
    line("- **" + c.title + "** — " + c.status + (c.feedsTheGate ? "  _(feeds the gate)_" : "  _(no vote)_"));
    line("  - evidence: " + c.evidence.replace(/\s+/g, " "));
    line("  - would change the answer: " + c.changesTheAnswer.replace(/\s+/g, " "));
  }
  line();
  line("A claim marked MEASURED — NO EDGE has been tested and failed. Proposing to");
  line("use it anyway needs an argument about the MEASUREMENT, not about the idea.");
}
line();

// ── 4. The configuration actually in force ──────────────────────────────────
line("## 4. Live configuration — never assume these numbers");
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

// ── 5. How much evidence you actually have ──────────────────────────────────
line("## 5. Evidence available to reason from");
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
line("They are evidence about SETUPS, not realised P&L. The real journal has one");
line("closed fill in the system's history — if you are asked about performance and");
line("there are too few closed trades to support a conclusion, say exactly that and");
line("stop. Inventing one is the worst thing you can do here.");
line();

// ── 6. House rules ──────────────────────────────────────────────────────────
line("## 6. How to report");
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
