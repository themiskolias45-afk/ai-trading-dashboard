#!/usr/bin/env node
'use strict';
/**
 * TIMELINE — what actually happened yesterday, today, or on any day.
 *
 * THE GAP. The brain records WHAT and never answers WHEN. 333 memories, every one of them
 * carrying a date somewhere in its text and 66% in frontmatter, and no way to ask "what
 * did we do yesterday". Recall is by topic: rag_query needs a subject, decisions.cjs needs
 * a topic, boot_context keys off the files you have open. All of it answers "tell me about
 * X". None of it answers "tell me about Tuesday".
 *
 * That matters more than it sounds for a system worked on in sessions. A session opens
 * with no idea what the last one did unless someone wrote it down in the right place, and
 * the operational record — commits, decisions, memories, trades, daily notes — is spread
 * across five stores that share no index and no clock.
 *
 * THE CLOCK IS THE WHOLE PROBLEM, so it is stated rather than assumed. On 2026-08-10 a
 * bridge log reading 16:17 against an API reading 13:38Z was investigated as a corrupt
 * file; the difference was BST. This project stores LOCAL time in its logs and filenames
 * and UTC in every API and timestamp. A timeline that mixes them silently is wrong by an
 * hour in summer and right in winter, which is the worst kind of wrong.
 *
 * So: DAY BOUNDARIES ARE LOCAL, because that is what a person means by "yesterday" and
 * what tasks/daily/YYYY-MM-DD.json is keyed by. Every source is converted INTO local
 * before it is bucketed, and each line says which clock it came from where it could
 * matter. The header prints both clocks and the offset so the reader can check.
 *
 *   node tasks/timeline.cjs              today
 *   node tasks/timeline.cjs yesterday
 *   node tasks/timeline.cjs week         the last 7 local days
 *   node tasks/timeline.cjs 2026-08-30
 *
 * READ-ONLY. Opens no network, writes nothing, changes nothing. Exit 0 always.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");

// Local YYYY-MM-DD for a Date. NOT toISOString().slice(0,10) — that is the UTC day, and
// between midnight and 01:00 BST it names YESTERDAY. This is the exact class of error the
// header warns about, so it must not appear in the tool that warns about it.
function localDay(d) {
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}
function addDays(day, n) {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(y, m - 1, d + n);
  return localDay(dt);
}

function git(args) {
  try {
    return execFileSync("git", ["-C", ROOT, ...args], {
      encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (e) { return ""; }
}

function memoryDir() {
  const override = process.env.JARVIS_BRAIN_PATH;
  if (override && fs.existsSync(override)) return override;
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  const projects = path.join(home, ".claude", "projects");
  if (!fs.existsSync(projects)) return null;
  const hint = ROOT.replace(/:/g, "-").replace(/[\\/]/g, "-");
  let best = null;
  for (const e of fs.readdirSync(projects, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const mem = path.join(projects, e.name, "memory");
    if (!fs.existsSync(mem)) continue;
    let c = 0;
    try { c = fs.readdirSync(mem).filter(f => f.endsWith(".md")).length; } catch (x) { continue; }
    if (!c) continue;
    if (e.name.toLowerCase() === hint.toLowerCase()) return mem;
    if (!best || c > best.c) best = { dir: mem, c };
  }
  return best ? best.dir : null;
}

// ── the five stores, each converted into LOCAL days ──────────────────────────

// git: %cI is ISO-8601 WITH the committer's offset, so new Date() lands on the right
// instant and localDay() then buckets it correctly. %cd with a format string would not.
function commitsBetween(from, to) {
  const raw = git(["log", "--since", from + "T00:00:00", "--until", to + "T23:59:59",
                   "--format=%cI\x1f%h\x1f%s"]);
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [iso, hash, subject] = line.split("\x1f");
    out.push({ day: localDay(new Date(iso)), hash, subject });
  }
  return out;
}

// Memory FILE MTIME is local filesystem time already. Frontmatter `modified` is UTC ISO.
// mtime is used for bucketing because 100% of files have it and only 66% carry the field,
// and a store that silently covers two thirds of the corpus is not a timeline.
function memoriesBetween(from, to) {
  const dir = memoryDir();
  if (!dir) return { dir: null, rows: [] };
  const rows = [];
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith(".md"))) {
    if (f === "MEMORY.md" || f === "MEMORY-FULL.md") continue;
    let st;
    try { st = fs.statSync(path.join(dir, f)); } catch (e) { continue; }
    const day = localDay(st.mtime);
    if (day < from || day > to) continue;
    let desc = "";
    try {
      const head = fs.readFileSync(path.join(dir, f), "utf8").slice(0, 1200);
      desc = (head.match(/^description:\s*(.+)$/m) || [])[1] || "";
      desc = desc.trim().replace(/^["']|["']$/g, "");
    } catch (e) { /* description is a nicety, not a reason to drop the row */ }
    rows.push({ day, file: f.replace(/\.md$/, ""), desc });
  }
  return { dir, rows };
}

// recordedAt is UTC ISO.
function decisionsBetween(from, to) {
  const f = path.join(ROOT, "tasks", "decision_register.jsonl");
  if (!fs.existsSync(f)) return [];
  const byKey = new Map();
  for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
    const l = line.trim();
    if (!l) continue;
    try { const r = JSON.parse(l); byKey.set(r.key, r); } catch (e) { /* skip */ }
  }
  return [...byKey.values()]
    .filter(r => r.recordedAt)
    .map(r => ({ day: localDay(new Date(r.recordedAt)), where: r.file ? r.file + ":" + r.line : "explicit",
                 title: r.title || "" }))
    .filter(r => r.day >= from && r.day <= to);
}

// Daily notes are keyed by LOCAL day in the filename, which is why local boundaries are
// the right choice for this whole tool rather than a preference.
function dailyNote(day) {
  const f = path.join(ROOT, "tasks", "daily", day + ".json");
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return null; }
}

function main() {
  const arg = (process.argv[2] || "today").toLowerCase();
  const now = new Date();
  const today = localDay(now);
  let from, to, label;
  if (arg === "today") { from = to = today; label = "today"; }
  else if (arg === "yesterday") { from = to = addDays(today, -1); label = "yesterday"; }
  else if (arg === "week") { from = addDays(today, -6); to = today; label = "the last 7 days"; }
  else if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) { from = to = arg; label = arg; }
  else {
    console.log("usage: node tasks/timeline.cjs [today|yesterday|week|YYYY-MM-DD]");
    return 0;
  }

  const offsetMin = -now.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const off = sign + String(Math.floor(Math.abs(offsetMin) / 60)).padStart(2, "0")
            + ":" + String(Math.abs(offsetMin) % 60).padStart(2, "0");

  console.log("");
  console.log("=== TIMELINE — " + label + "  (" + from + (from === to ? "" : " .. " + to) + ") ===");
  console.log("  now  local " + now.toLocaleString() + "  |  UTC " + now.toISOString());
  console.log("  day boundaries are LOCAL (UTC" + off + "). Logs and filenames here are local; "
    + "APIs are UTC.");
  console.log("");

  const commits = commitsBetween(from, to);
  const { dir, rows: mems } = memoriesBetween(from, to);
  const decs = decisionsBetween(from, to);

  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);

  for (const day of days) {
    const c = commits.filter(x => x.day === day);
    const m = mems.filter(x => x.day === day);
    const dd = decs.filter(x => x.day === day);
    const note = dailyNote(day);
    const trades = note && Array.isArray(note.trades) ? note.trades : [];
    const entries = note && Array.isArray(note.entries) ? note.entries : [];

    if (!c.length && !m.length && !dd.length && !trades.length && !entries.length) {
      if (days.length > 1) console.log(day + "   (nothing recorded)");
      else console.log("Nothing recorded for " + day + " in commits, memories, decisions, "
        + "trades or the daily note.");
      continue;
    }

    console.log(day + (day === today ? "   [today]" : ""));
    if (trades.length) {
      console.log("  TRADES: " + trades.length);
      for (const t of trades.slice(0, 6)) {
        console.log("    - " + JSON.stringify(t).slice(0, 120));
      }
    }
    if (m.length) {
      console.log("  LEARNED (" + m.length + " memor" + (m.length === 1 ? "y" : "ies") + "):");
      for (const x of m.slice(0, 10)) {
        console.log("    - " + x.file);
        if (x.desc) console.log("        " + x.desc.slice(0, 104));
      }
      if (m.length > 10) console.log("    ... and " + (m.length - 10) + " more");
    }
    if (dd.length) {
      console.log("  DECIDED (" + dd.length + "):");
      for (const x of dd.slice(0, 6)) console.log("    - " + x.where + "  " + x.title.slice(0, 80));
      if (dd.length > 6) console.log("    ... and " + (dd.length - 6) + " more");
    }
    if (entries.length) {
      console.log("  NOTES (" + entries.length + "):");
      for (const e of entries.slice(0, 4)) {
        console.log("    - " + String(typeof e === "string" ? e : (e.text || JSON.stringify(e))).slice(0, 110));
      }
    }
    if (c.length) {
      console.log("  BUILT (" + c.length + " commit" + (c.length === 1 ? "" : "s") + "):");
      for (const x of c.slice(0, 12)) console.log("    " + x.hash + "  " + x.subject.slice(0, 92));
      if (c.length > 12) console.log("    ... and " + (c.length - 12) + " more");
    }
    console.log("");
  }

  if (!dir) {
    console.log("NOTE: no memory dir found on this box, so LEARNED is empty for a reason "
      + "that is not 'nothing was learned'.");
  }
  console.log("===============================================");
  console.log("");
  return 0;
}

try { process.exit(main()); }
catch (e) { console.error("[timeline] " + e.message); process.exit(0); }
