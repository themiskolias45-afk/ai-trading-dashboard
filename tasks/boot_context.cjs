#!/usr/bin/env node
'use strict';
/**
 * BOOT CONTEXT — surface what is relevant to the work in front of you, at session start,
 * without being asked.
 *
 * THE GAP THIS CLOSES. Every recall in this project is pull: `rag_query.py`,
 * `decisions.cjs check`, opening a memory file. All of it works and none of it fires on
 * its own. Measured 2026-09-02: an agent spent an afternoon rediscovering a decision that
 * was written down five days earlier, and a query for "is it ok to add price level lines"
 * returns the memory describing that exact incident AT THE TOP — indexed, one command
 * away, the whole time. The knowledge was never missing. Nobody asked.
 *
 * SYSTEM-MAP.md lists "context injection at boot" as the last unbuilt piece of the RAG
 * stage. This is it.
 *
 * WHY THERE IS NO EMBEDDING HERE, deliberately. The SessionStart hook has a 10-second
 * budget and loading all-MiniLM-L6-v2 alone exceeds it. A boot check that times out is a
 * boot check that silently does nothing — the failure this repo keeps finding. So this is
 * fast and deterministic: it derives the topic from what you are ACTUALLY touching (the
 * source files dirty in git) and matches against stores it can read directly.
 * Semantic depth stays one printed command away.
 *
 * WHAT IT SURFACES, in priority order:
 *   1. STANDING DECISIONS in files you have uncommitted changes in. Highest value and
 *      zero ambiguity: you are editing a file that already decided something.
 *   2. MEMORIES whose description matches those files.
 *   3. The exact semantic query to run for depth.
 *
 *   node tasks/boot_context.cjs [--quiet] [--limit N]
 *
 * READ-ONLY. Opens no network, writes no file, changes no state. Exit 0 ALWAYS — a
 * context helper must never be the reason a session fails to start.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const REGISTER = path.join(ROOT, "tasks", "decision_register.jsonl");
const QUIET = process.argv.includes("--quiet");
const LIMIT = (() => {
  const i = process.argv.indexOf("--limit");
  const n = i === -1 ? NaN : Number(process.argv[i + 1]);
  return Number.isFinite(n) && n > 0 ? n : 4;
})();

// Words that carry no topic. Matching on these turns every boot into a wall of hits,
// which is the "alarm always on" failure — you learn to skim it and then it may as well
// not run.
const STOP = new Set([
  "the", "and", "for", "was", "were", "with", "that", "this", "from", "into", "not",
  "but", "its", "it", "is", "are", "has", "have", "had", "a", "an", "of", "to", "in",
  "on", "at", "by", "or", "be", "as", "it's", "fix", "add", "update", "new", "run",
  "tasks", "server", "index", "js", "cjs", "py", "ps1", "md", "json", "jsonl", "test",
]);

function git(args) {
  try {
    return execFileSync("git", ["-C", ROOT, ...args], {
      encoding: "utf8", timeout: 4000, stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (e) {
    return "";   // no git, detached, or a repo problem — never fatal here
  }
}

// The files you are actually working on. Modified-but-uncommitted is the strongest
// available signal of intent at session start, far better than "recently opened".
function dirtyFiles() {
  const out = git(["status", "--porcelain"]);
  const files = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const p = line.slice(3).trim().replace(/^"|"$/g, "");
    if (!p || p.endsWith("/")) continue;
    // SOURCE ONLY. The first version filtered a few known-noisy directories and still
    // derived its topic from generated data: measured on the live tree, 20 dirty files
    // produced the terms "agent auth analysis latest content quality" — every one of them
    // from dashboard/*.json and server/*.json artifacts the pipelines rewrite on every
    // tick. It surfaced four memories about scheduled-task audits while the actual work
    // was a decision register. Relevance derived from churn is worse than no relevance,
    // because it looks like an answer.
    //
    // This repo keeps roughly 90 generated .json/.jsonl files permanently dirty, so an
    // extension allow-list is the honest cut: those are the files a person edits.
    const norm = p.replace(/\\/g, "/");
    if (!/\.(js|cjs|mjs|py|ps1|bat|md|html|css|pine)$/i.test(norm)) continue;
    if (/^(node_modules|tasks\/logs|tasks\/analysis|tasks\/history)\//.test(norm)) continue;
    if (/\.(bak|junk|preexisting)/.test(norm)) continue;
    files.push(norm);
  }
  return files;
}


function readRegister() {
  if (!fs.existsSync(REGISTER)) return [];
  const byKey = new Map();
  for (const raw of fs.readFileSync(REGISTER, "utf8").split(/\r?\n/)) {
    const l = raw.trim();
    if (!l) continue;
    try { const r = JSON.parse(l); byKey.set(r.key, r); } catch (e) { /* skip */ }
  }
  return [...byKey.values()];
}

// Memory frontmatter only — 337 files, and reading each in full at boot would blow the
// 10s budget for no gain: the `description:` line is the recall surface the memory system
// was designed around and is what the index itself matches on.
function memoryDescriptions() {
  const candidates = [
    path.join(process.env.USERPROFILE || process.env.HOME || "", ".claude", "projects",
              "C--Users-User-ai-trading-dashboard", "memory"),
  ];
  const dir = candidates.find(d => d && fs.existsSync(d));
  if (!dir) return [];
  const out = [];
  let files;
  try { files = fs.readdirSync(dir).filter(f => f.endsWith(".md")); } catch (e) { return []; }
  for (const f of files) {
    if (f === "MEMORY.md" || f === "MEMORY-FULL.md") continue;
    let head;
    try {
      const fd = fs.openSync(path.join(dir, f), "r");
      const buf = Buffer.alloc(1024);
      const n = fs.readSync(fd, buf, 0, 1024, 0);
      fs.closeSync(fd);
      head = buf.slice(0, n).toString("utf8");
    } catch (e) { continue; }
    const m = head.match(/^description:\s*(.+)$/m);
    if (m) out.push({ file: f, description: m[1].trim().replace(/^["']|["']$/g, "") });
  }
  return out;
}

// Topic terms come from DIRTY FILENAMES ONLY.
//
// Commit subjects were in here and had to come out. Measured on the live tree: subjects
// contributed "boot", "context", "system", "wrong", "about", "seven" — generic enough
// that four unrelated memories cleared the 2-term bar, and they surfaced IDENTICALLY
// whether the tree was clean or had tradingview_bot.py open. A section that prints the
// same four rows regardless of what you are doing is not context, it is furniture, and
// you stop reading it by the third session.
//
// A dirty filename is a much narrower claim: someone is editing this, right now, and has
// not committed it. When nothing source-like is dirty there is no topic, and the honest
// output is silence rather than four plausible-looking rows.
function terms(files) {
  const t = new Set();
  for (const f of files) {
    for (const part of path.basename(f).split(/[._\-\/]/)) {
      const w = part.toLowerCase();
      // >= 3, not > 3. The domain's most specific terms are three letters -- crt, fvg,
      // rsi, atr, macd, ema -- and a 4-char floor silently dropped every one. Measured:
      // tasks/crt_runner.cjs surfaced NOTHING because "crt" was filtered out.
      if (w.length >= 3 && !STOP.has(w)) t.add(w);
    }
  }
  return [...t];
}

function score(haystack, termList) {
  const h = haystack.toLowerCase();
  let n = 0;
  for (const t of termList) if (h.includes(t)) n++;
  return n;
}

function main() {
  const files = dirtyFiles();
  const lines = [];

  // 1. DECISIONS IN FILES YOU ARE EDITING — the highest-signal thing available, and the
  //    one that would have prevented 2026-09-02. No scoring, no threshold: you either
  //    have uncommitted changes in a file carrying a decision or you do not.
  const register = readRegister();
  const dirtySet = new Set(files);
  const hits = register.filter(r => r.file && dirtySet.has(r.file));
  if (hits.length) {
    lines.push("STANDING DECISIONS in files you have uncommitted changes in:");
    const byFile = new Map();
    for (const h of hits) {
      if (!byFile.has(h.file)) byFile.set(h.file, []);
      byFile.get(h.file).push(h);
    }
    for (const [f, ds] of byFile) {
      for (const d of ds.sort((a, b) => a.line - b.line).slice(0, 3)) {
        lines.push("  ! " + f + ":" + d.line + "  " + d.title.slice(0, 88));
      }
      if (ds.length > 3) lines.push("    ... and " + (ds.length - 3) + " more in this file");
    }
    lines.push("  full text: node tasks/decisions.cjs guard <file>");
    lines.push("");
  }

  // 2. MEMORIES matching the topic. Ranked, capped, and silent below 2 matching terms —
  //    a single shared word is a coincidence, not relevance.
  const termList = terms(files);
  if (termList.length) {
    const mem = memoryDescriptions()
      .map(m => ({ ...m, s: score(m.file + " " + m.description, termList) }))
      .filter(m => m.s >= 2)
      .sort((a, b) => b.s - a.s)
      .slice(0, LIMIT);
    if (mem.length) {
      lines.push("MEMORY that matches what you are touching:");
      for (const m of mem) {
        lines.push("  - " + m.file.replace(/\.md$/, ""));
        lines.push("      " + m.description.slice(0, 110));
      }
      lines.push("");
    }
  }

  if (!lines.length) {
    if (!QUIET) console.log("[boot-context] nothing specific to surface "
      + "(" + files.length + " dirty file(s), " + register.length + " decisions known)");
    return 0;
  }

  // 3. The semantic path, printed rather than run: it needs an embedding model and the
  //    SessionStart budget is 10 seconds.
  const topic = termList.slice(0, 6).join(" ");
  lines.push("For depth (semantic, slower):");
  lines.push("  python tasks/rag_query.py \"" + topic + "\"");

  console.log("");
  console.log("=== BOOT CONTEXT — relevant to your working tree ===");
  for (const l of lines) console.log(l);
  console.log("===================================================");
  console.log("");
  return 0;
}

try {
  process.exit(main());
} catch (e) {
  // NEVER fatal. A context helper that breaks a session start is worse than one that
  // says nothing, and this runs before anything has been checked.
  if (!QUIET) console.error("[boot-context] skipped: " + e.message);
  process.exit(0);
}
