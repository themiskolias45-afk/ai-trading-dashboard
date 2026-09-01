"use strict";
/**
 * Apply a list of {find, replace} pairs to a file on this box.
 *
 * Written for the VPS, whose dashboard/index.html DIFFERS from the laptop's. Copying
 * the laptop file over it would replace content nobody diffed; patching by anchor
 * changes only the five regions that were actually reviewed.
 *
 * LINE ENDINGS. The VPS is CRLF and the laptop LF. Anchors are matched against an
 * LF-normalised copy and the original ending is restored before writing. Matching raw
 * would fail to find the anchor and report "already patched" - a FALSE SUCCESS.
 *
 * REFUSES unless every anchor appears exactly once. Backs up first and verifies the
 * backup before writing. Idempotent via a sentinel the caller supplies.
 */
const fs = require("fs");
const [, , FILE, BLOCKS, SENTINEL] = process.argv;
if (!FILE || !BLOCKS || !SENTINEL) {
  console.error("usage: node patch_by_anchor.cjs <file> <blocks.json> <sentinel>");
  process.exit(1);
}
const pairs = JSON.parse(fs.readFileSync(BLOCKS, "utf8"));
const raw = fs.readFileSync(FILE, "utf8");
const wasCRLF = raw.indexOf("\r\n") !== -1;
let s = raw.split("\r\n").join("\n");

if (s.indexOf(SENTINEL) !== -1) {
  console.log("ALREADY PATCHED (sentinel '" + SENTINEL + "' present). No change.");
  process.exit(0);
}
let refused = false;
for (const p of pairs) {
  const n = s.split(p.find).length - 1;
  if (n !== 1) { console.error("REFUSING: anchor '" + p.label + "' appears " + n + " times, expected 1"); refused = true; }
}
if (refused) process.exit(2);

const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
const bak = FILE + ".bak-" + SENTINEL + "-" + stamp;
fs.copyFileSync(FILE, bak);
if (!fs.existsSync(bak) || fs.statSync(bak).size !== Buffer.byteLength(raw, "utf8")) {
  console.error("REFUSING: backup not verified at " + bak);
  process.exit(3);
}
console.log("backup verified: " + bak + " (" + fs.statSync(bak).size + " bytes)");

for (const p of pairs) s = s.replace(p.find, () => p.replace);
const out = wasCRLF ? s.split("\n").join("\r\n") : s;
fs.writeFileSync(FILE, out, "utf8");
console.log("patched " + pairs.length + " region(s). CRLF restored: " + wasCRLF);
console.log("  sentinel now present: " + (out.indexOf(SENTINEL) !== -1));
