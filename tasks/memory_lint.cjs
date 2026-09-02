#!/usr/bin/env node
'use strict';
/**
 * MEMORY LINT — keeps the brain's own wiring honest.
 *
 * The memory corpus is the most important layer in this system and it is the one with no
 * checker. claims_check.cjs guards CLAUDE.md, config_drift.cjs guards copied settings,
 * encoding_check.cjs guards mojibake, decisions.cjs guards standing decisions. Nothing
 * guarded the 332 memories, and SYSTEM-MAP has said since 2026-08-29 that the schema
 * "degrades recall over time" without anyone being able to say by how much.
 *
 * Measured 2026-09-02, first run: 1,124 wikilinks across 364 unique targets, of which
 * 31 resolved NOWHERE and one concept was written FOUR different ways.
 *
 * WHAT IT REPORTS, and the distinction matters:
 *
 *   BACKLOG      [[a-link]] with no file yet. NOT an error — the memory instructions say
 *                so explicitly: "a [[name]] that doesn't match an existing memory yet is
 *                fine; it marks something worth writing later". Counting these as
 *                failures would train you to ignore the report. They are a to-write list,
 *                ranked by how many memories are asking for them.
 *
 *   ALIASES      THE REAL DEFECT. The same concept linked under several spellings, e.g.
 *                [[a setting with no reader is decoration]], [[a-setting-with-no-reader]],
 *                [[a-setting-with-no-reader-is-decoration]] and
 *                [[a_setting_with_no_reader_is_decoration]] all appear and none resolve.
 *                Write that memory under any one name and THREE of the four links stay
 *                dead forever. A backlog item resolves itself when someone writes the
 *                file; an alias cluster does not.
 *
 *   CONVENTION   `name:` in kebab-case against a snake_case filename. 183 of 332 carry
 *                this. It is survivable only because resolution accepts either, and it is
 *                the reason alias clusters form in the first place.
 *
 *   SCHEMA       missing description (the RAG's recall surface), missing or invalid
 *                metadata.type, absent frontmatter.
 *
 *   ORPHANS      a memory no index links to. The loader truncates MEMORY.md by BYTES at
 *                24576 and that has already silently dropped 17% of it once.
 *
 *   node tasks/memory_lint.cjs [--backlog] [--json]
 *
 * READ-ONLY. Reports; fixes nothing, deletes nothing, writes nothing. Exit 0 always —
 * this is a health report, and a linter that fails a build is a linter people route
 * around.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const JSON_OUT = process.argv.includes("--json");
const SHOW_BACKLOG = process.argv.includes("--backlog");
const VALID_TYPES = new Set(["user", "feedback", "project", "reference"]);
const INDEXES = ["MEMORY.md", "MEMORY-FULL.md"];
const MEMORY_MD_BYTE_CAP = 24576;   // the loader truncates by BYTES, not lines

function memoryDir() {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  const d = path.join(home, ".claude", "projects",
                      "C--Users-User-ai-trading-dashboard", "memory");
  return fs.existsSync(d) ? d : null;
}

// Two spellings of one idea are the same idea. Collapsing to letters and digits is what
// makes the alias clusters visible at all — they differ only in separators and case.
const canon = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

function main() {
  const dir = memoryDir();
  if (!dir) {
    console.log("memory dir not found on this box — nothing to lint");
    return 0;
  }

  const all = fs.readdirSync(dir).filter(f => f.endsWith(".md"));
  const memFiles = all.filter(f => !INDEXES.includes(f));
  const stems = new Set(memFiles.map(f => f.slice(0, -3)));
  const names = new Set();
  const schema = { noFrontmatter: [], noName: [], noDesc: [], noType: [], badType: [], mismatch: [] };
  const links = [];          // { from, target }

  for (const f of memFiles) {
    let txt;
    try { txt = fs.readFileSync(path.join(dir, f), "utf8"); }
    catch (e) { schema.noFrontmatter.push(f); continue; }

    const fm = txt.startsWith("---") ? txt.split("---", 3)[1] || "" : "";
    if (!fm) schema.noFrontmatter.push(f);
    const name = (fm.match(/^name:\s*(.+)$/m) || [])[1];
    const desc = (fm.match(/^description:\s*(.+)$/m) || [])[1];
    const type = (fm.match(/^\s*type:\s*(.+)$/m) || [])[1];
    if (!name) schema.noName.push(f); else names.add(name.trim());
    if (!desc) schema.noDesc.push(f);
    if (!type) schema.noType.push(f);
    else if (!VALID_TYPES.has(type.trim().replace(/^["']|["']$/g, ""))) schema.badType.push(f);
    if (name && name.trim() !== f.slice(0, -3)) schema.mismatch.push(f);

    for (const m of txt.matchAll(/\[\[([^\]\n]{2,120})\]\]/g)) {
      links.push({ from: f, target: m[1].trim() });
    }
  }

  // Resolution accepts EITHER convention, because both are in use and a link written in
  // good faith under either one is a working link.
  const resolves = (t) => stems.has(t) || names.has(t);
  const unresolved = links.filter(l => !resolves(l.target));
  const uniqueTargets = new Set(links.map(l => l.target));
  const uniqueUnresolved = [...new Set(unresolved.map(l => l.target))];

  // ALIAS CLUSTERS. Group every target — resolved or not — by its canonical form. A group
  // with more than one distinct spelling is a cluster, and it is only harmful when the
  // group contains at least one spelling that does NOT resolve.
  const byCanon = new Map();
  for (const t of uniqueTargets) {
    const c = canon(t);
    if (!byCanon.has(c)) byCanon.set(c, new Set());
    byCanon.get(c).add(t);
  }
  const clusters = [...byCanon.entries()]
    .filter(([, set]) => set.size > 1 && [...set].some(t => !resolves(t)))
    .map(([c, set]) => ({ canon: c, spellings: [...set], anyResolves: [...set].some(resolves) }));

  // Orphans + the byte cap that has failed before.
  const linked = new Set();
  let memoryMdBytes = 0;
  for (const idx of INDEXES) {
    const p = path.join(dir, idx);
    if (!fs.existsSync(p)) continue;
    const t = fs.readFileSync(p, "utf8");
    if (idx === "MEMORY.md") memoryMdBytes = Buffer.byteLength(t, "utf8");
    for (const m of t.matchAll(/\]\(([A-Za-z0-9_\-]+\.md)\)/g)) linked.add(m[1].slice(0, -3));
  }
  const orphans = memFiles.map(f => f.slice(0, -3)).filter(s => !linked.has(s));

  // How many memories are asking for each missing target — the ranking that turns a list
  // of broken links into a to-write list worth acting on.
  const demand = new Map();
  for (const l of unresolved) demand.set(l.target, (demand.get(l.target) || 0) + 1);

  const report = {
    memories: memFiles.length,
    links: links.length,
    uniqueTargets: uniqueTargets.size,
    unresolvedLinks: unresolved.length,
    unresolvedTargets: uniqueUnresolved.length,
    aliasClusters: clusters.length,
    orphans: orphans.length,
    memoryMdBytes, memoryMdCap: MEMORY_MD_BYTE_CAP,
    schema: Object.fromEntries(Object.entries(schema).map(([k, v]) => [k, v.length])),
  };

  if (JSON_OUT) { console.log(JSON.stringify({ ...report, clusters, orphans }, null, 1)); return 0; }

  console.log("\n=== MEMORY LINT ===\n");
  console.log("  " + report.memories + " memories, " + report.links + " wikilinks, "
    + report.uniqueTargets + " unique targets");
  console.log("  MEMORY.md " + memoryMdBytes + " / " + MEMORY_MD_BYTE_CAP + " bytes"
    + (memoryMdBytes > MEMORY_MD_BYTE_CAP
        ? "   !! OVER CAP - the tail is silently NOT loading"
        : "   (" + (MEMORY_MD_BYTE_CAP - memoryMdBytes) + " headroom)"));
  console.log("");

  const s = report.schema;
  const schemaBad = s.noFrontmatter + s.noName + s.noDesc + s.noType + s.badType;
  console.log("SCHEMA: " + (schemaBad === 0 ? "clean" : schemaBad + " problem(s)"));
  if (s.noDesc) console.log("  ! " + s.noDesc + " with NO description - invisible to semantic recall");
  if (s.noFrontmatter) console.log("  ! " + s.noFrontmatter + " with no frontmatter");
  if (s.noName) console.log("  ! " + s.noName + " with no name:");
  if (s.noType) console.log("  ! " + s.noType + " with no metadata.type");
  if (s.badType) console.log("  ! " + s.badType + " with an invalid type");
  console.log("  - " + s.mismatch + " where name: differs from the filename (both resolve; "
    + "this is what lets alias clusters form)");
  console.log("");

  console.log("ORPHANS: " + orphans.length + (orphans.length ? "  (no index links these)" : ""));
  for (const o of orphans.slice(0, 8)) console.log("  ! " + o);
  console.log("");

  // The headline. Clusters are the defect; the backlog is not.
  if (clusters.length) {
    console.log("ALIAS CLUSTERS: " + clusters.length + "  <- THE ACTUAL DEFECT");
    console.log("  One concept linked under several spellings. Writing the memory under ONE");
    console.log("  of them leaves the others dead forever.");
    for (const c of clusters.slice(0, 6)) {
      console.log("   " + (c.anyResolves ? "PARTIAL" : "ALL DEAD") + ":");
      for (const sp of c.spellings) console.log("      [[" + sp + "]]" + (resolves(sp) ? "  (resolves)" : ""));
    }
    if (clusters.length > 6) console.log("   ... and " + (clusters.length - 6) + " more");
    console.log("");
  } else {
    console.log("ALIAS CLUSTERS: none\n");
  }

  console.log("BACKLOG: " + report.unresolvedTargets + " target(s) linked but not yet written");
  console.log("  NOT errors. The memory instructions say a [[name]] with no file yet marks");
  console.log("  something worth writing. Ranked by how many memories ask for it:");
  const ranked = [...demand.entries()].sort((a, b) => b[1] - a[1]);
  for (const [t, n] of ranked.slice(0, SHOW_BACKLOG ? 40 : 8)) {
    console.log("   " + String(n).padStart(2) + "x  [[" + t + "]]");
  }
  if (!SHOW_BACKLOG && ranked.length > 8) {
    console.log("   ... " + (ranked.length - 8) + " more, see --backlog");
  }
  console.log("\n===================\n");
  return 0;
}

try { process.exit(main()); }
catch (e) { console.error("[memory-lint] " + e.message); process.exit(0); }
