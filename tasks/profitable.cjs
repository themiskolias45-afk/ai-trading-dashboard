#!/usr/bin/env node
'use strict';
/**
 * THE PROFITABLE LEDGER -- nothing measured positive is ever lost again.
 *
 * WHY THIS EXISTS, in the project's own history:
 *   - The SELL_BOUNCE walk-forward answer was measured 2026-09-01, written into the VPS's
 *     copy of a comment, and never came back. The laptop carried the QUESTION for a day
 *     after the ANSWER was known, and the same run was nearly commissioned twice.
 *   - On 2026-09-01 five measured findings turned out to have been sitting on the other
 *     box for a month, unknown here.
 *   - Most "no edge" verdicts in this repo were produced at MTF_MAX_HOLD=40, a horizon the
 *     harness itself documents as biasing every result DOWNWARD. Re-run at the live
 *     horizon, XAGUSD went -0.259 -> +0.033 and the engine baseline went +0.119 -> +0.366.
 *
 * A finding that lives in a terminal, a commit message or one box's file comment is a
 * finding the next session cannot act on. This is one append-only file, in the repo, that
 * every profitable measurement lands in with the command that reproduces it.
 *
 *   node tasks/profitable.cjs list                    every finding, best first
 *   node tasks/profitable.cjs list --live             only what is actually trading
 *   node tasks/profitable.cjs add --name "..." --rpt 0.551 --n 105 --folds 5/5 \
 *        --harness "node tasks/..." --status MEASURED --note "..."
 *
 * APPEND ONLY. Rule 6 of the standing rules: nothing is deleted. A superseded finding is
 * appended again with a later date and a note saying what replaced it; the old row stays
 * so the record of the change survives the change.
 *
 * READ-ONLY with respect to trading. It touches no gate, threshold, position or setting,
 * and nothing in the engine reads this file. It is a record for humans and for the next
 * session, not an input to the signal path.
 */

const fs   = require("fs");
const path = require("path");

const LEDGER = path.join(__dirname, "profitable_findings.jsonl");

function readAll() {
  if (!fs.existsSync(LEDGER)) return [];
  const out = [];
  for (const raw of fs.readFileSync(LEDGER, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    // A corrupt row is REPORTED and skipped, never silently dropped: a ledger that
    // quietly loses a row is the thing this file exists to prevent.
    try { out.push(JSON.parse(line)); }
    catch (e) { console.error("  [corrupt row skipped] " + line.slice(0, 120)); }
  }
  return out;
}

function strArg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return (i === -1 || i + 1 >= process.argv.length) ? fallback : process.argv[i + 1];
}

function add() {
  const name = strArg("--name", null);
  if (!name) { console.error("--name is required"); process.exit(1); }
  const rptRaw = strArg("--rpt", null);
  const row = {
    at: new Date().toISOString(),
    name,
    rpt: rptRaw === null ? null : Number(rptRaw),
    n: Number(strArg("--n", 0)) || null,
    folds: strArg("--folds", null),
    control: strArg("--control", null),
    edge: strArg("--edge", null),
    // MEASURED         a walk-forward or matched-control screen says it is positive
    // NEEDS_COST_CHECK positive gross, not yet shown to survive spread and slippage
    // LIVE             actually trading in the engine right now
    // SUPERSEDED       replaced by a later row, kept because nothing is deleted
    status: strArg("--status", "MEASURED"),
    harness: strArg("--harness", null),
    note: strArg("--note", null),
    feedsTheGate: false,
  };
  fs.appendFileSync(LEDGER, JSON.stringify(row) + "\n", "utf8");
  console.log("recorded: " + name + "  " + (row.rpt === null ? "" : row.rpt) + "  [" + row.status + "]");
}

function list() {
  const rows = readAll();
  if (!rows.length) { console.log("ledger is empty"); return; }
  const onlyLive = process.argv.includes("--live");
  const shown = onlyLive ? rows.filter(r => r.status === "LIVE") : rows;
  const sorted = [...shown].sort((a, b) => (b.rpt ?? -999) - (a.rpt ?? -999));
  const pad = (v, w) => String(v === null || v === undefined ? "-" : v).padEnd(w);
  console.log("=".repeat(120));
  console.log("  PROFITABLE LEDGER -- " + rows.length + " finding(s), best R/trade first");
  console.log("=".repeat(120));
  console.log("  " + pad("finding", 34) + pad("R/trade", 10) + pad("n", 7) + pad("folds", 8)
    + pad("control", 10) + pad("edge", 9) + pad("status", 18) + "measured");
  for (const r of sorted) {
    console.log("  " + pad(r.name, 34)
      + pad(r.rpt === null ? "-" : (r.rpt >= 0 ? "+" : "") + r.rpt.toFixed(4), 10)
      + pad(r.n, 7) + pad(r.folds, 8) + pad(r.control, 10) + pad(r.edge, 9)
      + pad(r.status, 18) + String(r.at).slice(0, 10));
  }
  console.log("");
  for (const r of sorted) {
    if (!r.harness && !r.note) continue;
    console.log("  " + r.name);
    if (r.note)    console.log("      " + r.note);
    if (r.harness) console.log("      reproduce: " + r.harness);
  }
  console.log("");
  console.log("  Nothing in the engine reads this file. It is the record, not an input.");
}

const cmd = process.argv[2];
if (cmd === "add") add();
else if (cmd === "list" || cmd === undefined) list();
else { console.error("usage: node tasks/profitable.cjs [list [--live] | add --name ... ]"); process.exit(1); }
