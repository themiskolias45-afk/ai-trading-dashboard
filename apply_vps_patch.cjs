#!/usr/bin/env node
// Applies the 2026-08-28 /daily fixes to a box whose files differ from the laptop's
// only in line endings and pre-existing divergence. Anchors were EXTRACTED from the
// real diff, not retyped, so they cannot drift from what was actually committed.
//
// ALL-OR-NOTHING, and it asserts BEFORE it writes. A patcher that asserts after its
// write leaves the file untouched while printing green lines, and the run afterwards
// silently measures the UNPATCHED file — that has cost this project a session before.
//
// Idempotent: a hunk already applied (0 occurrences of `old`, 1 of `new`) is counted
// as satisfied rather than treated as a failure, so a re-run is safe.
//
// Usage: node apply_vps_patch.cjs <pairs.json> [--write]
//        without --write it only reports (default is CHECK, never touch).

const fs   = require("fs");
const path = require("path");
const cp   = require("child_process");

const pairsFile = process.argv[2];
const WRITE     = process.argv.includes("--write");
if (!pairsFile) { console.error("usage: apply_vps_patch.cjs <pairs.json> [--write]"); process.exit(2); }

const pairs = JSON.parse(fs.readFileSync(pairsFile, "utf8"));
const byFile = new Map();
for (const p of pairs) {
  if (!byFile.has(p.file)) byFile.set(p.file, []);
  byFile.get(p.file).push(p);
}

let hardFail = false;
const plan = [];

for (const [file, hunks] of byFile) {
  if (!fs.existsSync(file)) { console.log(`[MISS] ${file} — not present on this box`); hardFail = true; continue; }
  const raw  = fs.readFileSync(file, "utf8");
  // Remember the ORIGINAL ending so it can be restored byte for byte. Matching a raw
  // CRLF file against LF anchors finds nothing and reports "already patched" — a
  // FALSE SUCCESS, the worst possible outcome for a deploy check.
  const wasCRLF = raw.includes("\r\n");
  let body = raw.replace(/\r\n/g, "\n");

  let applied = 0, already = 0, missing = 0;
  for (const h of hunks) {
    const nOld = body.split(h.old).length - 1;
    const nNew = body.split(h.new).length - 1;
    if (nOld === 1) { body = body.replace(h.old, () => h.new); applied++; }
    else if (nOld === 0 && nNew >= 1) { already++; }
    else {
      missing++;
      console.log(`[FAIL] ${file}: anchor matched ${nOld} time(s) (need exactly 1). First 70 chars:`);
      console.log(`       ${JSON.stringify(h.old.slice(0, 70))}`);
    }
  }

  console.log(`[${missing ? "FAIL" : "OK"}] ${file}: ${applied} to apply, ${already} already applied, ${missing} unmatched (CRLF=${wasCRLF})`);
  if (missing) { hardFail = true; continue; }
  plan.push({ file, out: wasCRLF ? body.replace(/\n/g, "\r\n") : body, applied, wasCRLF });
}

if (hardFail) {
  console.log("\nABORTED — nothing was written. Every anchor must match before any file is touched.");
  process.exit(1);
}
if (!WRITE) {
  console.log(`\nCHECK ONLY — ${plan.reduce((n, p) => n + p.applied, 0)} hunk(s) would be applied. Re-run with --write.`);
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
for (const p of plan) {
  if (p.applied === 0) { console.log(`[SKIP] ${p.file} — already fully patched`); continue; }
  const bak = `${p.file}.bak-daily28-${stamp}`;
  fs.copyFileSync(p.file, bak);
  if (!fs.existsSync(bak)) { console.log(`[FAIL] backup missing for ${p.file}, refusing to write`); process.exit(1); }
  fs.writeFileSync(p.file, p.out, "utf8");
  console.log(`[WROTE] ${p.file}  (backup ${path.basename(bak)})`);
}

// Verify by RUNNING the checker, not by reasoning about it.
//
// Dispatch on EXTENSION. `node --check` on a .html file throws
// ERR_UNKNOWN_FILE_EXTENSION, so the first version printed a red [SYNTAX FAIL] after a
// write that had actually succeeded — a deploy tool crying wolf, which is the fastest
// way to train someone to ignore the one time it is right. HTML gets a real check
// instead: balanced <div> tags and every inline <script> block parsed with
// new Function(), which is what was being done by hand afterwards anyway.
let bad = 0;
for (const p of plan) {
  try {
    if (p.file.endsWith(".py")) {
      cp.execSync(`python -m py_compile "${p.file}"`, { stdio: "pipe" });
    } else if (p.file.endsWith(".html")) {
      const html  = fs.readFileSync(p.file, "utf8");
      const open  = (html.match(/<div/g)    || []).length;
      const close = (html.match(/<\/div>/g) || []).length;
      if (open !== close) throw new Error(`unbalanced <div>: ${open} open vs ${close} close`);
      const blocks = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
      blocks.forEach((src, i) => {
        try { new Function(src); }
        catch (e) { throw new Error(`inline script block ${i}: ${e.message}`); }
      });
      console.log(`[CHECK OK] ${p.file}  (div ${open}/${close}, ${blocks.length} inline script block(s) parsed)`);
      continue;
    } else {
      cp.execSync(`node --check "${p.file}"`, { stdio: "pipe" });
    }
    console.log(`[SYNTAX OK] ${p.file}`);
  } catch (e) {
    bad++;
    console.log(`[SYNTAX FAIL] ${p.file}: ${String(e.stderr || e.message).slice(0, 300)}`);
  }
}
process.exit(bad ? 1 : 0);
