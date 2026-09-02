#!/usr/bin/env node
'use strict';
/**
 * BRAIN SYNC — keep the two boxes' memory corpora from drifting apart.
 *
 * WHY THIS IS A LOOP PROBLEM AND NOT A DATA PROBLEM. The brains were synced by hand on
 * 2026-09-01 (memory: fleet_sync_all_buckets_and_the_silent_backup — "the VPS had 6
 * memories vs 311"). By 2026-09-02 they were 315 against 333 and had to be synced by hand
 * again. Two manual syncs in two days is not a fix; it is a symptom. Memories are written
 * on whichever box a session ran on, so they diverge every single day, and the VPS — the
 * box that trades continuously — is the one that ends up behind.
 *
 * Found by asking the corpus about a DAY rather than a topic (tasks/timeline.cjs). It
 * would not have surfaced from any topic search.
 *
 * SAFE BY CONSTRUCTION, which is what lets this run unattended:
 *   - UNION ONLY. A file present on one box is copied to the other. Nothing is deleted,
 *     ever, on either side.
 *   - A file that exists on BOTH with DIFFERENT content is REPORTED AND LEFT ALONE.
 *     Choosing a winner is a judgement about which memory is right, and that is not a
 *     thing a scheduled job should decide. The indexes (MEMORY.md, MEMORY-FULL.md) are
 *     the exception people will expect to differ; they are reported separately.
 *   - Both sides are BACKED UP to a timestamped directory before a single file is written,
 *     and the backup is verified to exist and to be non-trivial first.
 *   - Runs from the LAPTOP only. CLAUDE.md records that the laptop cannot be reached from
 *     outside, so the VPS could never initiate this.
 *
 *   node tasks/brain_sync.cjs            report the divergence, change nothing
 *   node tasks/brain_sync.cjs --apply    copy the missing files BOTH ways
 *
 * Exit 0 on success or on a clean no-op. Exit 1 only if it refused for safety, so a
 * nightly caller can tell "nothing to do" from "would not touch this".
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const APPLY = process.argv.includes("--apply");

const VPS_HOST = process.env.VPS_HOST || "169.58.74.133";
const VPS_USER = process.env.VPS_USER || "administrator";
const SSH_KEY = process.env.VPS_SSH_KEY
  || path.join(os.homedir(), ".ssh", "contabo_smartentry");
const VPS_MEM = "C:/Users/Administrator/.claude/projects/C--ai-trading-dashboard/memory";
const INDEXES = new Set(["MEMORY.md", "MEMORY-FULL.md"]);

function localMemoryDir() {
  const override = process.env.JARVIS_BRAIN_PATH;
  if (override && fs.existsSync(override)) return override;
  const projects = path.join(os.homedir(), ".claude", "projects");
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

function ssh(command, timeout = 60000) {
  return execFileSync("ssh", ["-i", SSH_KEY, "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=10",
    VPS_USER + "@" + VPS_HOST, command],
    { encoding: "utf8", timeout, maxBuffer: 32 * 1024 * 1024 });
}

function sha256(file) {
  return require("crypto").createHash("sha256")
    .update(fs.readFileSync(file)).digest("hex").toUpperCase();
}

function localHashes(dir) {
  const out = new Map();
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith(".md"))) {
    try { out.set(f, sha256(path.join(dir, f))); } catch (e) { /* unreadable, skip */ }
  }
  return out;
}

// Written to a file on the VPS and read back in one go. A large listing streamed straight
// over ssh comes back as CLIXML once it grows, and CLAUDE.md records that reading as
// "the VPS has 2 files" — a wrong answer that looks like a small one.
function vpsHashes() {
  const remote = "C:/ai-trading-dashboard/tasks/logs/brain_hashes_sync.txt";
  ssh('powershell -NoProfile -Command "Get-ChildItem \'' + VPS_MEM +
      '\' -Filter *.md | ForEach-Object { $_.Name + \' \' + (Get-FileHash $_.FullName -Algorithm SHA256).Hash } | Set-Content \'' +
      remote + '\' -Encoding ascii"');
  const raw = ssh('powershell -NoProfile -Command "Get-Content \'' + remote + '\'"');
  const out = new Map();
  for (const line of raw.split(/\r?\n/)) {
    const l = line.trim();
    if (!l) continue;
    const i = l.lastIndexOf(" ");
    if (i > 0) out.set(l.slice(0, i), l.slice(i + 1));
  }
  return out;
}

function backupLocal(dir) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
  const dest = dir + ".bak-sync-" + stamp;
  fs.mkdirSync(dest, { recursive: true });
  let n = 0;
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith(".md"))) {
    fs.copyFileSync(path.join(dir, f), path.join(dest, f)); n++;
  }
  return { dest, n };
}

function main() {
  const dir = localMemoryDir();
  if (!dir) { console.log("[brain-sync] no local memory dir — nothing to do"); return 0; }
  if (!fs.existsSync(SSH_KEY)) {
    console.log("[brain-sync] ssh key not found at " + SSH_KEY + " — cannot reach the VPS. "
      + "Reported, not silently skipped.");
    return 1;
  }

  const lap = localHashes(dir);
  let vps;
  try { vps = vpsHashes(); }
  catch (e) {
    console.log("[brain-sync] VPS unreachable (" + String(e.message).split("\n")[0] + ")");
    console.log("  Not a clean result: the brains may be diverging and this could not check.");
    return 1;
  }

  const onlyLocal = [...lap.keys()].filter(f => !vps.has(f)).sort();
  const onlyVps = [...vps.keys()].filter(f => !lap.has(f)).sort();
  const differ = [...lap.keys()].filter(f => vps.has(f) && vps.get(f) !== lap.get(f)).sort();
  const differNonIndex = differ.filter(f => !INDEXES.has(f));
  const differIndex = differ.filter(f => INDEXES.has(f));

  console.log("");
  console.log("=== BRAIN SYNC ===");
  console.log("  laptop " + lap.size + " file(s)   VPS " + vps.size + " file(s)");
  console.log("  only on laptop : " + onlyLocal.length);
  console.log("  only on VPS    : " + onlyVps.length);
  console.log("  content differs: " + differNonIndex.length + " memor"
    + (differNonIndex.length === 1 ? "y" : "ies")
    + (differIndex.length ? " (+ " + differIndex.length + " index file(s), expected)" : ""));

  for (const f of onlyLocal.slice(0, 10)) console.log("    -> VPS   " + f);
  if (onlyLocal.length > 10) console.log("    ... " + (onlyLocal.length - 10) + " more");
  for (const f of onlyVps.slice(0, 10)) console.log("    -> laptop " + f);
  if (onlyVps.length > 10) console.log("    ... " + (onlyVps.length - 10) + " more");

  if (differNonIndex.length) {
    console.log("");
    console.log("  LEFT ALONE — same name, different content. Choosing a winner is a");
    console.log("  judgement about which memory is right, not a job for a scheduled task:");
    for (const f of differNonIndex.slice(0, 8)) console.log("    ~ " + f);
  }

  if (!onlyLocal.length && !onlyVps.length) {
    console.log("\n  brains are in union sync" + (differNonIndex.length ? " (content differences above)" : "") + ".");
    console.log("==================\n");
    return 0;
  }
  if (!APPLY) {
    console.log("\n  dry run — pass --apply to copy the missing files BOTH ways.");
    console.log("  Nothing is ever deleted; a differing file is never overwritten.");
    console.log("==================\n");
    return 0;
  }

  // Backup BEFORE the first write, verified, on both sides.
  const b = backupLocal(dir);
  if (!fs.existsSync(b.dest) || b.n < 10) {
    console.log("[brain-sync] REFUSING: local backup looks wrong (" + b.n + " files)");
    return 1;
  }
  console.log("\n  laptop backup: " + path.basename(b.dest) + " (" + b.n + " files)");
  try {
    const out = ssh('powershell -NoProfile -Command "$m=\'' + VPS_MEM + '\'; $b=$m + \'.bak-sync-\' + (Get-Date -Format yyyyMMdd_HHmmss); Copy-Item $m $b -Recurse; if(Test-Path $b){ \'vps backup: \' + (Get-ChildItem $b -Filter *.md).Count + \' files\' } else { \'BACKUP FAILED\' }"');
    console.log("  " + out.trim());
    if (/BACKUP FAILED/.test(out)) { console.log("[brain-sync] REFUSING: VPS backup failed"); return 1; }
  } catch (e) {
    console.log("[brain-sync] REFUSING: VPS backup errored — " + String(e.message).split("\n")[0]);
    return 1;
  }

  let pushed = 0, pulled = 0;
  for (const f of onlyLocal) {
    try {
      execFileSync("scp", ["-q", "-i", SSH_KEY, "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=no", path.join(dir, f),
        VPS_USER + "@" + VPS_HOST + ":" + VPS_MEM + "/" + f], { timeout: 30000 });
      pushed++;
    } catch (e) { console.log("    push FAILED " + f + " — " + String(e.message).split("\n")[0]); }
  }
  for (const f of onlyVps) {
    try {
      execFileSync("scp", ["-q", "-i", SSH_KEY, "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=no",
        VPS_USER + "@" + VPS_HOST + ":" + VPS_MEM + "/" + f, path.join(dir, f)],
        { timeout: 30000 });
      pulled++;
    } catch (e) { console.log("    pull FAILED " + f + " — " + String(e.message).split("\n")[0]); }
  }

  console.log("\n  pushed to VPS: " + pushed + "/" + onlyLocal.length);
  console.log("  pulled to laptop: " + pulled + "/" + onlyVps.length);
  console.log("  Nothing deleted. Differing files untouched.");
  console.log("  Re-index after a sync:  python tasks/rag_index.py --source brain");
  console.log("==================\n");
  return 0;
}

try { process.exit(main()); }
catch (e) { console.error("[brain-sync] " + e.message); process.exit(1); }
