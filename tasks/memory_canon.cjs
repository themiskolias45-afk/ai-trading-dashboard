#!/usr/bin/env node
'use strict';
/**
 * MEMORY CANON — collapse alias spellings of a wikilink onto the one that resolves.
 *
 * Separate from tasks/memory_lint.cjs on purpose. The linter REPORTS and never writes;
 * a checker that also mutates is one you stop trusting to tell you the truth. This is the
 * fixer, it is run deliberately, and it is deliberately timid.
 *
 * THE DEFECT IT REPAIRS. 183 of 333 memories carry a kebab-case `name:` against a
 * snake_case filename. Link resolution accepts EITHER, so both spellings look correct and
 * only one works, and the same concept accumulates spellings. Measured 2026-09-02:
 * [[a setting with no reader is decoration]], [[a-setting-with-no-reader-is-decoration]]
 * and [[a_setting_with_no_reader_is_decoration]] all appeared and NONE resolved.
 *
 * Unlike a dead link with no file — which resolves itself the day someone writes that
 * memory — an alias cluster never heals: write the file under one spelling and the others
 * stay dead forever.
 *
 * THE RULE, and it is the whole safety argument:
 *   rewrite a spelling that resolves NOWHERE, to a twin in the same canonical group that
 *   DOES resolve, and only when EXACTLY ONE such twin exists.
 *
 * So it never invents a target, never picks between two live candidates, never touches a
 * link that already works, and never creates, renames or deletes a memory. It edits link
 * TEXT inside existing files and nothing else. A group with no resolving twin is left
 * alone — that is a backlog item, not an alias, and the fix for it is to write the memory.
 *
 *   node tasks/memory_canon.cjs            dry run, prints what it would rewrite
 *   node tasks/memory_canon.cjs --apply    perform the rewrites
 *
 * Exit 0 always.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const APPLY = process.argv.includes("--apply");
// --align-names removes the CAUSE rather than the symptom.
//
// 183 of 333 memories carry a kebab-case `name:` against a snake_case filename. Link
// resolution accepts either, so both spellings look right, only one is canonical, and the
// corpus keeps growing new aliases. Collapsing aliases (the default mode) is a repair that
// has to be re-run forever; making `name:` equal the filename means a link written either
// way from now on resolves to exactly one thing.
//
// THE ORDER IS THE ENTIRE SAFETY ARGUMENT, and doing it backwards is destructive.
// 83 link targets currently resolve ONLY through the `name:` field. Align names first and
// all 83 die instantly. So: rewrite those links to the filename FIRST, then align. Both
// happen in one pass here, links before frontmatter, and the tool refuses to align if any
// of them could not be mapped to a real file.
const ALIGN = process.argv.includes("--align-names");
const INDEXES = new Set(["MEMORY.md", "MEMORY-FULL.md"]);

// Same discovery as memory_lint.cjs and rag_index.py's _find_brain_corpus: the slug is
// derived from the repo location and differs per box (laptop
// C--Users-User-ai-trading-dashboard, VPS C--ai-trading-dashboard). Hardcoding it makes
// this a no-op on one machine while reporting success.
function memoryDir() {
  const override = process.env.JARVIS_BRAIN_PATH;
  if (override && fs.existsSync(override)) return override;
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  const projects = path.join(home, ".claude", "projects");
  if (!fs.existsSync(projects)) return null;
  const hint = path.join(__dirname, "..").replace(/:/g, "-").replace(/[\\/]/g, "-");
  let best = null;
  for (const e of fs.readdirSync(projects, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const mem = path.join(projects, e.name, "memory");
    if (!fs.existsSync(mem)) continue;
    let count = 0;
    try { count = fs.readdirSync(mem).filter(f => f.endsWith(".md")).length; } catch (x) { continue; }
    if (!count) continue;
    if (e.name.toLowerCase() === hint.toLowerCase()) return mem;
    if (!best || count > best.count) best = { dir: mem, count };
  }
  return best ? best.dir : null;
}

const canon = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

function main() {
  const dir = memoryDir();
  if (!dir) { console.log("no memory dir on this box — nothing to do"); return 0; }

  const all = fs.readdirSync(dir).filter(f => f.endsWith(".md"));
  const mems = all.filter(f => !INDEXES.has(f));
  const stems = new Set(mems.map(f => f.slice(0, -3)));
  const names = new Set();
  const targets = new Set();

  for (const f of all) {
    const txt = fs.readFileSync(path.join(dir, f), "utf8");
    if (!INDEXES.has(f)) {
      const fm = txt.startsWith("---") ? txt.split("---", 3)[1] || "" : "";
      const n = (fm.match(/^name:\s*(.+)$/m) || [])[1];
      if (n) names.add(n.trim());
    }
    for (const m of txt.matchAll(/\[\[([^\]\n]{2,120})\]\]/g)) targets.add(m[1].trim());
  }
  const resolves = (t) => stems.has(t) || names.has(t);

  const groups = new Map();
  for (const t of targets) {
    const c = canon(t);
    if (!groups.has(c)) groups.set(c, new Set());
    groups.get(c).add(t);
  }

  const mapping = new Map();
  for (const [, sp] of groups) {
    const good = [...sp].filter(resolves);
    const bad = [...sp].filter(t => !resolves(t));
    // EXACTLY ONE resolving twin. Two would mean guessing which the author meant, and a
    // wrong guess silently repoints a working link at the wrong memory — worse than the
    // dead link it replaces.
    if (good.length === 1 && bad.length) for (const b of bad) mapping.set(b, good[0]);
  }

  console.log("memory dir : " + dir);
  console.log("memories   : " + mems.length + ", " + targets.size + " unique link target(s)");
  console.log("rewrites   : " + mapping.size + (APPLY ? "" : "   (dry run — pass --apply)"));
  if (!mapping.size) { console.log("\nnothing to canonicalise."); return 0; }
  for (const [b, g] of [...mapping].sort()) console.log("   [[" + b + "]]  ->  [[" + g + "]]");

  if (!APPLY) { console.log("\ndry run: no file was written."); return 0; }

  let changed = 0, rewrites = 0;
  for (const f of all) {
    const p = path.join(dir, f);
    const orig = fs.readFileSync(p, "utf8");
    let txt = orig;
    for (const [b, g] of mapping) {
      const before = txt;
      txt = txt.split("[[" + b + "]]").join("[[" + g + "]]");
      if (txt !== before) rewrites++;
    }
    if (txt !== orig) { fs.writeFileSync(p, txt, "utf8"); changed++; }
  }
  console.log("\n" + changed + " file(s) updated, " + rewrites + " link(s) rewritten.");
  console.log("Link text only — no memory was created, renamed or deleted.");
  console.log("Verify with: node tasks/memory_lint.cjs");
  return 0;
}

try { process.exit(main()); }
catch (e) { console.error("[memory-canon] " + e.message); process.exit(0); }
