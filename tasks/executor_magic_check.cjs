#!/usr/bin/env node
// Fails if mt5_bridge.py's EXECUTOR_MAGICS and tasks/fvg_executor.py's MODELS disagree.
//
// WHY THIS EXISTS. The bridge needs to know which magic numbers belong to this system's
// own executors so a surface can say "your TK swing pullback" rather than filing it beside
// a third-party EA. It cannot import fvg_executor.py -- that module parses argv at import
// time and can sys.exit -- so the table is duplicated. A duplicated table that nobody
// checks is the exact shape of every silent divergence in this repo: add a fourth model to
// the executor and its live trades quietly render as "foreign" on every page, with no
// error anywhere.
//
// A rule enforced by remembering is enforced by nothing. This is the check behind the rule.
//
//   node tasks/executor_magic_check.cjs          exit 0 agree, 1 disagree, 2 cannot read
const fs = require("fs");
const path = require("path");
const ROOT = path.dirname(__dirname);

function read(p) {
  try { return fs.readFileSync(path.join(ROOT, p), "utf8"); }
  catch (e) { console.error(`cannot read ${p}: ${e.message}`); process.exit(2); }
}

// fvg_executor.py MODELS: entries look like  "magic": 20260903, "label": "TK_SWING_PULLBACK",
const execSrc = read(path.join("tasks", "fvg_executor.py"));
const fromExecutor = new Map();
for (const m of execSrc.matchAll(/"magic":\s*(\d+),\s*"label":\s*"([A-Z0-9_]+)"/g)) {
  fromExecutor.set(Number(m[1]), m[2]);
}

// mt5_bridge.py EXECUTOR_MAGICS: entries look like  20260903: "TK_SWING_PULLBACK",
const bridgeSrc = read("mt5_bridge.py");
const block = bridgeSrc.match(/EXECUTOR_MAGICS\s*=\s*\{([\s\S]*?)\}/);
if (!block) { console.error("EXECUTOR_MAGICS not found in mt5_bridge.py"); process.exit(2); }
const fromBridge = new Map();
for (const m of block[1].matchAll(/(\d+)\s*:\s*"([A-Z0-9_]+)"/g)) {
  fromBridge.set(Number(m[1]), m[2]);
}

if (fromExecutor.size === 0) { console.error("parsed ZERO models out of fvg_executor.py — the shape changed, refusing to report agreement"); process.exit(2); }
if (fromBridge.size === 0)   { console.error("parsed ZERO magics out of mt5_bridge.py — the shape changed, refusing to report agreement"); process.exit(2); }

const problems = [];
for (const [magic, label] of fromExecutor) {
  if (!fromBridge.has(magic)) problems.push(`executor has ${magic} (${label}) — the bridge does NOT, so its live trades render as a stranger's`);
  else if (fromBridge.get(magic) !== label) problems.push(`${magic}: executor calls it ${label}, bridge calls it ${fromBridge.get(magic)}`);
}
for (const [magic, label] of fromBridge) {
  if (!fromExecutor.has(magic)) problems.push(`bridge has ${magic} (${label}) — no executor model claims it`);
}

console.log(`executor models: ${[...fromExecutor].map(([m, l]) => `${m}=${l}`).join(", ")}`);
console.log(`bridge magics  : ${[...fromBridge].map(([m, l]) => `${m}=${l}`).join(", ")}`);
if (problems.length) {
  console.error("\nEXECUTOR MAGIC TABLES DISAGREE:");
  for (const p of problems) console.error("  - " + p);
  console.error("\nFix mt5_bridge.py EXECUTOR_MAGICS to match tasks/fvg_executor.py MODELS.");
  process.exit(1);
}
console.log(`\nAGREE — ${fromBridge.size} executor magic(s), both tables identical.`);
