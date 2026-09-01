"use strict";
/**
 * Add the two RSI-ceiling keys to STRATEGY_LIMITS on this box.
 *
 * Runs ON the VPS. That index.js is PATCHED, never copied - its git history carries
 * commits this repo has never seen - so this makes the same additive edit the laptop
 * received rather than shipping a file over the top of it.
 *
 * LINE ENDINGS. The VPS file is CRLF and the laptop LF, so the anchors are matched
 * against an LF-normalised copy and the original ending is restored before writing.
 * Matching raw would fail to find the anchor and report "already patched" - a false
 * success, which is the worst possible outcome for a deploy check.
 *
 * Idempotent. Backs up first and VERIFIES the backup before writing a byte. Refuses
 * unless each anchor appears exactly once.
 */
const fs = require("fs");
const FILE = process.argv[2];
const BLOCKS = process.argv[3];
if (!FILE || !BLOCKS) {
  console.error("usage: node patch_ceiling_keys.cjs <index.js> <ceiling_blocks.json>");
  process.exit(1);
}
const b = JSON.parse(fs.readFileSync(BLOCKS, "utf8"));
const raw = fs.readFileSync(FILE, "utf8");
const wasCRLF = raw.indexOf("\r\n") !== -1;
let s = raw.split("\r\n").join("\n");

if (s.indexOf("momentumRsiMax:    { min:") !== -1) {
  console.log("ALREADY PATCHED - momentumRsiMax is already in STRATEGY_LIMITS. No change.");
  process.exit(0);
}
for (const pair of [[b.anchorA, "STRATEGY_LIMITS anchor"], [b.anchorB, "initialiser anchor"]]) {
  const n = s.split(pair[0]).length - 1;
  if (n !== 1) {
    console.error("REFUSING: " + pair[1] + " found " + n + " times, expected exactly 1");
    process.exit(2);
  }
}
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
const bak = FILE + ".bak-ceilkeys-" + stamp;
fs.copyFileSync(FILE, bak);
if (!fs.existsSync(bak) || fs.statSync(bak).size !== Buffer.byteLength(raw, "utf8")) {
  console.error("REFUSING: backup not verified at " + bak);
  process.exit(3);
}
console.log("backup verified: " + bak + " (" + fs.statSync(bak).size + " bytes)");

s = s.split(b.anchorA).join(b.newA).split(b.anchorB).join(b.newB);
const out = wasCRLF ? s.split("\n").join("\r\n") : s;
fs.writeFileSync(FILE, out, "utf8");
console.log("patched. CRLF restored: " + wasCRLF);
console.log("  momentumRsiMax in LIMITS:    " + (out.indexOf("momentumRsiMax:    { min: 56") !== -1));
console.log("  trendFollowRsiMax in LIMITS: " + (out.indexOf("trendFollowRsiMax: { min: 52") !== -1));
console.log("  initialiser seeded:          " + (out.indexOf("STRATEGY_LIMITS.momentumRsiMax.def") !== -1));
