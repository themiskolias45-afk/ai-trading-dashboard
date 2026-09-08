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

// ── WHERE YOU STOPPED ────────────────────────────────────────────────────────────────
//
// WHY THIS EXISTS. Everything needed to resume was already being WRITTEN and none of it was
// being READ automatically. The session-stop hook writes tasks/jarvis-state.json, /learn
// writes tasks/jarvis_memory.json, and next_session_open_threads.md is titled "START HERE" —
// but the only thing that runs on its own at boot was the block below, which matches memories
// against DIRTY FILENAMES. So a session that began with a clean tree printed NOTHING, and a
// session that began with a dirty tree got memories about those files and still nothing about
// where the last one stopped. Continuity depended on the model choosing to walk CLAUDE.md's
// 12-step read sequence by hand, competing with the user's first message. That is why every
// session felt like it started new.
//
// PURELY ADDITIVE AND READ-ONLY. It prints three local files. It writes nothing, reads no
// network, loads no model, and touches no gate, no confidence value, no learning record and
// no signal — there is nothing here that can block anything.
//
// EVERY SOURCE IS INDIVIDUALLY GUARDED. A missing or corrupt file drops its own line and the
// rest still print. A boot helper that breaks the boot is worse than one that says nothing.
function readJsonQuiet(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return null; }
}

function ageWords(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (!isFinite(ms) || ms < 0) return "";
  const h = ms / 3600000;
  if (h < 1) return Math.round(h * 60) + "m ago";
  if (h < 48) return h.toFixed(1) + "h ago";
  return Math.round(h / 24) + "d ago";
}

function resumeLines() {
  const out = [];

  // 1. What the last session actually shipped. Written by the Stop hook, so it is present
  //    even when the session ended without anyone running /learn.
  const state = readJsonQuiet(path.join(ROOT, "tasks", "jarvis-state.json"));
  if (state && Array.isArray(state.commits) && state.commits.length) {
    out.push("LAST SESSION SHIPPED" + (state.saved ? "  (" + ageWords(state.saved) + ")" : "") + ":");
    for (const c of state.commits.slice(0, 3)) out.push("  " + String(c).slice(0, 100));
  }

  // 2. The last recorded session state. Newest entry wins; jarvis_memory.json has TWO
  //    writers, so read defensively and never assume shape.
  const mem = readJsonQuiet(path.join(ROOT, "tasks", "jarvis_memory.json"));
  const entries = mem && Array.isArray(mem.entries) ? mem.entries : [];
  // NEWEST BY TIMESTAMP, not by position. Measured 2026-09-08 on the VPS: after the two
  // boxes' memory was union-merged, the appended VPS-only rows sat AFTER the newest laptop
  // row, so entries[length-1] returned a session from days earlier and the boot block
  // confidently described the wrong session. Position stops meaning recency the moment two
  // writers merge. Undated rows cannot win, and if nothing is dated this falls back to the
  // positional last so behaviour is unchanged on a single-writer file.
  //
  // RANKED, then newest. Newest is not the same as most useful: the smartentry MCP writes
  // last-session-commits into this SAME file, so the newest row by clock is often a bare
  // commit list while the row that actually says where the work stopped sits just behind it.
  // A session summary outranks bookkeeping; ties break on the clock.
  const rank = (k) => (/^session-/.test(k) || k === "last-session-state") ? 3
                    : /session/i.test(k) ? 2 : 1;
  let last = null, bestR = 0, bestT = -Infinity;
  for (const e of entries) {
    if (!e || !e.value) continue;
    const r = rank(String(e.key || ""));
    const t = Date.parse(e.timestamp || e.time || e.updated_at || "");
    const tt = isFinite(t) ? t : -Infinity;
    if (r > bestR || (r === bestR && tt > bestT)) { bestR = r; bestT = tt; last = e; }
  }
  if (!last) {
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i] && entries[i].value) { last = entries[i]; break; }
    }
  }
  if (last && last.value) {
    out.push("");
    out.push("WHERE IT STOPPED" + (last.key ? "  [" + last.key + "]" : "") + ":");
    const text = String(last.value).replace(/\s+/g, " ");
    for (let i = 0; i < text.length && i < 900; i += 110) {
      out.push("  " + text.slice(i, i + 110));
    }
    if (text.length > 900) out.push("  ... full text: tasks/jarvis_memory.json (last entry)");
  }

  // 3. The open-threads headline. That file is titled START HERE and is the one place the
  //    unfinished work and the DO-NOT-FIX list live. Only its newest dated heading is taken:
  //    the file is ~1000 lines and the point here is a pointer, not a dump.
  try {
    const memDir = path.join(process.env.USERPROFILE || process.env.HOME || "", ".claude",
                             "projects", "C--Users-User-ai-trading-dashboard", "memory");
    const threads = path.join(memDir, "next_session_open_threads.md");
    const head = fs.readFileSync(threads, "utf8").slice(0, 4000);
    const h = head.match(/^#\s+(.+)$/m);
    if (h) {
      out.push("");
      out.push("OPEN THREADS (START HERE):  " + h[1].trim().slice(0, 100));
      out.push("  read: " + threads.split(String.fromCharCode(92)).join("/"));
    }
  } catch (e) { /* omitted, never fatal */ }

  return out;
}

function main() {
  const files = dirtyFiles();
  const lines = [];

  // 0. RESUME FIRST. This is the only section that does not depend on the working tree, so
  //    it is the only one a clean-tree session would otherwise get nothing from.
  const resume = resumeLines();
  if (resume.length) { for (const r of resume) lines.push(r); lines.push(""); }

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
  console.log("=== BOOT CONTEXT — where you stopped, and what is relevant now ===");
  for (const l of lines) console.log(l);
  console.log("=====================================================================");
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
