#!/usr/bin/env node
/*
 * MIN_RR ledger composition — read-only.
 *
 * WHY THIS EXISTS. /api/rejection-evidence reports one aggregate verdict per gate, and
 * that aggregate has been misread twice on this system:
 *
 *   - [[min_rr_aggregate_verdict_is_cancellation]] 2026-08-14: MIN_RR read "COSTING
 *     MONEY" at +2.464R, and the number was BUY_OVERSOLD +21.2R almost exactly
 *     cancelling RANGE_TRADE_SHORT -21.3R. Two opposite setups. The verdict was
 *     arithmetic, not evidence.
 *   - [[one_row_sets_the_sign_of_the_ledger]] 2026-08-17: a single $4.21 Bitcoin stop
 *     carried +298.56R and set the sign of an entire 498-episode ledger.
 *
 * So before anyone acts on a gate verdict, three questions have to be answered that the
 * aggregate cannot answer: do the per-setup signs DISAGREE, is the total carried by a
 * HANDFUL OF ROWS, and is the per-episode edge DECAYING as sample grows.
 *
 * Reads tasks/rejections_scored.jsonl and prints. Writes nothing, changes no threshold,
 * admits and suppresses no signal. feedsTheGate stays false.
 *
 *   node tasks/minrr_ledger_composition.cjs [--gate MIN_RR] [--file <path>]
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const GATE = argOf("--gate", "MIN_RR");
const FILE = argOf("--file", path.join(ROOT, "tasks", "rejections_scored.jsonl"));

if (!fs.existsSync(FILE)) {
  console.error("no scored ledger at " + FILE);
  process.exit(1);
}

const rows = [];
for (const line of fs.readFileSync(FILE, "utf8").split("\n")) {
  if (!line.trim()) continue;
  let row;
  try { row = JSON.parse(line); } catch { continue; }   // a malformed line is skipped, never fatal
  if (row.gate !== GATE) continue;
  rows.push(row);
}

// A row counts toward the verdict only if it RESOLVED to a number. Pending and
// unscorable rows are reported separately rather than silently dropped: "how much of
// this gate is unjudgeable" is itself part of reading the verdict.
const resolved = rows.filter(r => Number.isFinite(Number(r.r)) && r.outcome && r.outcome !== "PENDING" && r.outcome !== "UNSCORABLE");
const pending = rows.filter(r => r.outcome === "PENDING").length;
const unscorable = rows.filter(r => r.outcome === "UNSCORABLE").length;

const sum = xs => xs.reduce((a, b) => a + b, 0);
const netR = sum(resolved.map(r => Number(r.r)));
const wins = resolved.filter(r => Number(r.r) > 0).length;

console.log(`\nGATE ${GATE} — ledger composition   (${path.relative(ROOT, FILE)})`);
console.log("=".repeat(74));
console.log(`  rows ${rows.length}   resolved ${resolved.length}   pending ${pending}   unscorable ${unscorable}`);
if (!resolved.length) { console.log("  nothing resolved — no verdict is possible"); process.exit(0); }
console.log(`  net ${netR >= 0 ? "+" : ""}${netR.toFixed(3)}R   per episode ${(netR / resolved.length >= 0 ? "+" : "")}${(netR / resolved.length).toFixed(4)}R   would-have-won ${Math.round((wins / resolved.length) * 100)}%`);

// ── 1. DO THE PER-SETUP SIGNS DISAGREE? ──────────────────────────────────────
// When they do, the aggregate is two populations cancelling and means nothing.
const bySetup = {};
for (const r of resolved) {
  const k = r.setup || "(none)";
  (bySetup[k] = bySetup[k] || { n: 0, w: 0, l: 0, r: 0 });
  bySetup[k].n++;
  bySetup[k].r += Number(r.r);
  if (Number(r.r) > 0) bySetup[k].w++; else bySetup[k].l++;
}
const setups = Object.entries(bySetup).sort((a, b) => b[1].r - a[1].r);
console.log("\n  PER SETUP — the aggregate is only meaningful if these agree in sign");
console.log("  " + "-".repeat(70));
for (const [name, s] of setups) {
  console.log(`  ${name.padEnd(20)} ${String(s.n).padStart(4)} ep  ${String(s.w).padStart(3)}W/${String(s.l).padEnd(3)}L  `
    + `${(s.r >= 0 ? "+" : "") + s.r.toFixed(2)}R`.padStart(10)
    + `   ${(s.r / s.n >= 0 ? "+" : "") + (s.r / s.n).toFixed(3)}R/ep`.padStart(14));
}
const positives = setups.filter(([, s]) => s.r > 0);
const negatives = setups.filter(([, s]) => s.r < 0);
const disagree = positives.length > 0 && negatives.length > 0;
console.log("  " + "-".repeat(70));
console.log(disagree
  ? `  *** SIGNS DISAGREE: ${positives.length} setup(s) positive, ${negatives.length} negative.\n`
    + "      The gate verdict is CANCELLATION, not evidence. It must not be read as an\n"
    + "      instruction to move the bar in either direction."
  : "  All setups agree in sign — the aggregate is at least coherent.");

// ── 2. IS THE TOTAL CARRIED BY A HANDFUL OF ROWS? ────────────────────────────
const sorted = [...resolved].sort((a, b) => Math.abs(Number(b.r)) - Math.abs(Number(a.r)));
console.log("\n  CONCENTRATION — how much of the total rests on the largest rows");
console.log("  " + "-".repeat(70));
for (const k of [1, 3, 5, 10]) {
  if (k > sorted.length) break;
  const top = sum(sorted.slice(0, k).map(r => Number(r.r)));
  const rest = netR - top;
  const share = netR !== 0 ? Math.abs(top / netR) * 100 : 0;
  const flips = (netR > 0 && rest < 0) || (netR < 0 && rest > 0);
  console.log(`  top ${String(k).padStart(2)} row(s): ${(top >= 0 ? "+" : "") + top.toFixed(2)}R  `
    + `= ${share.toFixed(0).padStart(3)}% of net   remaining ${resolved.length - k} sum `
    + `${(rest >= 0 ? "+" : "") + rest.toFixed(2)}R` + (flips ? "   *** SIGN FLIPS WITHOUT THEM ***" : ""));
}
console.log("\n  largest rows by |R| — check every one for an implausibly tight stop");
for (const r of sorted.slice(0, 5)) {
  const risk = Math.abs(Number(r.entry) - Number(r.stop));
  const pct = Number(r.entry) ? (risk / Math.abs(Number(r.entry))) * 100 : NaN;
  console.log(`    ${String(r.setup || "?").padEnd(19)} ${String(r.symbol || "?").padEnd(7)} ${String(r.timeframe || "?").padEnd(4)}`
    + ` R=${(Number(r.r) >= 0 ? "+" : "") + Number(r.r).toFixed(2)}`.padEnd(12)
    + ` risk ${risk.toFixed(2)} (${isFinite(pct) ? pct.toFixed(3) + "% of price" : "?"})  rr ${r.rr}`);
}

// ── 3. IS THE PER-EPISODE EDGE DECAYING AS SAMPLE GROWS? ─────────────────────
// The 2026-08-14 reading fell 93% as sample grew 5x. An edge that shrinks with sample
// was noise being read as signal; one that holds is worth a walk-forward.
const chron = [...resolved].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
console.log("\n  DECAY — per-episode edge as the sample grows (chronological)");
console.log("  " + "-".repeat(70));
for (const frac of [0.25, 0.5, 0.75, 1]) {
  const n = Math.max(1, Math.round(chron.length * frac));
  const slice = chron.slice(0, n);
  const r = sum(slice.map(x => Number(x.r)));
  const w = slice.filter(x => Number(x.r) > 0).length;
  console.log(`  first ${String(n).padStart(4)} episodes (${String(Math.round(frac * 100)).padStart(3)}%)  `
    + `net ${(r >= 0 ? "+" : "") + r.toFixed(2)}R`.padStart(14)
    + `   ${(r / n >= 0 ? "+" : "") + (r / n).toFixed(4)}R/ep`.padStart(14)
    + `   won ${Math.round((w / n) * 100)}%`);
}

// ── The one-line answer ──────────────────────────────────────────────────────
const topOne = Math.abs(sum(sorted.slice(0, 1).map(r => Number(r.r))) / (netR || 1)) * 100;
console.log("\n  READING");
console.log("  " + "-".repeat(70));
if (disagree)          console.log("  NOT ACTIONABLE — per-setup signs disagree; the aggregate is cancellation.");
else if (topOne > 40)  console.log("  NOT ACTIONABLE — one row carries " + topOne.toFixed(0) + "% of the net.");
else                   console.log("  COHERENT — signs agree and no single row dominates. Still a PAPER screen:\n"
                                  + "  it earns a walk-forward, it does not by itself move a threshold.");
console.log("  A walk-forward outranks this file. It has overruled this ledger three times.\n");
