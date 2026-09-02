#!/usr/bin/env node
'use strict';
/**
 * FLEET BUCKETS — what differs between the two boxes, bucket by bucket, and which of it
 * is SUPPOSED to.
 *
 * WHY THIS REPORTS AND DOES NOT SYNC. Asked to make buckets for everything, the way
 * 2026-09-01's full sync did (memory: fleet_sync_all_buckets_and_the_silent_backup —
 * MD/MCP/BRAIN/SKILLS/TOOLS/DATA). Measured first, and a blanket sync would have been
 * destructive:
 *
 *   SKILLS (agents)     6 same,   0 differ      already identical
 *   SKILLS (commands)  51 same,   6 differ
 *   TOOLS  (tasks)    207 same,  31 differ,  11 laptop-only
 *
 * The 31 differing tools are NOT one thing. `startup_vps.ps1`,
 * `install_vps_learning_tasks.ps1`, `vps_notify.ps1`, `ensure_running.ps1`,
 * `enable_algo.ps1` and friends differ because THE TWO BOXES ARE DIFFERENT — different
 * paths, different MT5 accounts, different scheduled work. CLAUDE.md records that the VPS
 * runs 12 scheduled tasks the laptop does not and that the boxes "differ in SCHEDULE, not
 * in code". Pushing the laptop's copies over those would break the box that trades.
 *
 * Others differ only because the laptop is ahead by a few hours. From a hash alone the two
 * are indistinguishable, and that is exactly why this prints the list instead of acting on
 * it. BRAIN is the one bucket where union-merge is provably safe — a memory is additive
 * knowledge, never box-specific configuration — and that is what brain_sync.cjs syncs.
 *
 * NEVER-SYNC IS ENFORCED IN CODE, not remembered. learning.json holds per-box observation
 * COUNTS against the same market (382 laptop / 240 VPS): summing double-counts and
 * overwriting destroys one box's record. strategy_settings.json is per-machine BY DESIGN.
 * keys.env is secrets. All three are excluded here and named, so nobody has to recall it.
 *
 *   node tasks/fleet_buckets.cjs            report every bucket
 *   node tasks/fleet_buckets.cjs --files    also list every differing file
 *
 * READ-ONLY. Writes nothing on either box, syncs nothing, deletes nothing. Exit 0 always
 * except when the VPS cannot be reached, which is reported rather than read as clean.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SHOW_FILES = process.argv.includes("--files");
const VPS_HOST = process.env.VPS_HOST || "169.58.74.133";
const VPS_USER = process.env.VPS_USER || "administrator";
const SSH_KEY = process.env.VPS_SSH_KEY || path.join(os.homedir(), ".ssh", "contabo_smartentry");
const VPS_ROOT = "C:/ai-trading-dashboard";

// NEVER SYNCED, and the reason travels with the rule so it cannot be "tidied up" later.
const NEVER_SYNC = [
  ["server/learning.json", "per-box observation COUNTS against the same market — summing double-counts, overwriting destroys one box's record"],
  ["server/strategy_settings.json", "per-machine BY DESIGN; a shared commit does not mean shared behaviour"],
  ["keys.env", "secrets"],
  ["server/apikey.txt", "secrets"],
  ["server/index.js", "the VPS is PATCHED not copied — it carries commits this repo has never seen"],
];

// Files whose difference is EXPECTED because the boxes genuinely differ. Matching here
// means "this is not a drift to fix", so the report can put the unexplained ones in front
// of the reader instead of burying them in noise.
const BOX_SPECIFIC = [
  // GENERATED PER BOX, not drift. ai_brief.md is rewritten nightly by ai_brief.cjs --write
  // from each box's own decisions, proposals and config, so the two copies SHOULD differ -
  // and syncing it would hand one box the other's briefing. It sat in the unexplained list
  // until 2026-09-02 purely because nobody had said so.
  /^ai_brief\.md$/,
  /vps/i, /^ensure_running\.ps1$/, /^startup_all\.ps1$/, /^install_autostart\.ps1$/,
  /^notify\.ps1$/, /^enable_algo\.ps1$/, /^fix_autotrading\d*\.ps1$/,
  /^count_guardians\.ps1$/, /^rotate_logs\.ps1$/, /^install_spread_probe\.ps1$/,
  /^spread_probe\.py$/, /^export_mt5_history\.py$/, /^list_broker_symbols\.py$/,
];

// A backup is not content. Comparing them made the report 228 lines of noise and buried
// the 20 differences that matter. Excluded on BOTH sides.
const IS_BACKUP = /\.(bak|vpsbak)[-.]|\.pre-|\.bak$/i;

const BUCKETS = [
  { name: "SKILLS (commands)", local: ".claude/commands", glob: /\.md$/ },
  { name: "SKILLS (agents)",   local: ".claude/agents",   glob: /\.md$/ },
  // .md INCLUDED HERE ON PURPOSE, and its absence was the second half of the same bug.
  // tasks/ holds real documentation — AGENT-BOUNDARY.md, pre-flight.md,
  // REJECTION-LEDGER-SPEC.md, SLEEP-RUNBOOK.md — which is content, not clutter. With the
  // remote filtering .md and the local not, eleven files the laptop demonstrably HAS
  // (AGENT-BOUNDARY.md was written here today) reported as "VPS-ONLY, a push would
  // DESTROY these". Both halves of a comparison must ask the same question.
  { name: "TOOLS (tasks)",     local: "tasks",            glob: /\.(cjs|py|ps1|md)$/ },
];

function ssh(cmd, timeout = 90000) {
  return execFileSync("ssh", ["-i", SSH_KEY, "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=10",
    VPS_USER + "@" + VPS_HOST, cmd],
    { encoding: "utf8", timeout, maxBuffer: 32 * 1024 * 1024 });
}

function localHashes(dir, glob) {
  const out = new Map();
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) return out;
  for (const f of fs.readdirSync(full)) {
    if (!glob.test(f)) continue;
    if (IS_BACKUP.test(f)) continue;
    try {
      out.set(f, crypto.createHash("sha256")
        .update(fs.readFileSync(path.join(full, f))).digest("hex").toUpperCase());
    } catch (e) { /* unreadable, skip */ }
  }
  return out;
}

// Written to a file on the VPS and read back. A listing this size streamed straight over
// ssh comes back as CLIXML, which CLAUDE.md records as having read like "the VPS has 2
// files" — a wrong answer that looks like a small one.
function vpsHashes(buckets) {
  const specs = buckets.map(b => "'" + VPS_ROOT + "/" + b.local + "'").join(",");
  const remote = VPS_ROOT + "/tasks/logs/fleet_buckets.txt";
  // THE REMOTE FILTER MUST MATCH THE LOCAL ONE. The first version listed EVERY file on the
  // VPS while the local side globbed .cjs/.py/.ps1/.md, so 228 .bat/.json/.jsonl files
  // reported as "VPS-ONLY — a one-way push would DESTROY these". Alarming, and entirely an
  // artifact of comparing two different questions. A comparison whose two halves ask
  // different things produces a confident wrong answer.
  ssh('powershell -NoProfile -Command "$o=@(); foreach($d in @(' + specs + ')){ if(Test-Path $d){ Get-ChildItem $d -File | Where-Object { $_.Name -match \'\\.(cjs|py|ps1|md)$\' } | ForEach-Object { $o += ($d + \'|\' + $_.Name + \'|\' + (Get-FileHash $_.FullName -Algorithm SHA256).Hash) } } }; $o | Set-Content \'' + remote + '\' -Encoding ascii"');
  const raw = ssh('powershell -NoProfile -Command "Get-Content \'' + remote + '\'"');
  const byDir = new Map();
  for (const line of raw.split(/\r?\n/)) {
    const l = line.trim();
    if (!l) continue;
    const [d, name, hash] = l.split("|");
    if (!hash) continue;
    const key = d.replace(VPS_ROOT + "/", "").replace(/\\/g, "/");
    if (!byDir.has(key)) byDir.set(key, new Map());
    byDir.get(key).set(name, hash);
  }
  return byDir;
}

function main() {
  if (!/[\\/]Users[\\/]/i.test(ROOT)) {
    console.log("[fleet-buckets] this is the VPS — the comparison runs FROM the laptop.");
    return 0;
  }
  if (!fs.existsSync(SSH_KEY)) {
    console.log("[fleet-buckets] ssh key missing at " + SSH_KEY + " — cannot compare.");
    return 1;
  }

  let remote;
  try { remote = vpsHashes(BUCKETS); }
  catch (e) {
    console.log("[fleet-buckets] VPS unreachable (" + String(e.message).split("\n")[0] + ")");
    console.log("  Reported, NOT treated as 'in sync'.");
    return 1;
  }

  console.log("");
  console.log("=== FLEET BUCKETS ===");
  console.log("  laptop vs VPS, per bucket. This REPORTS; it syncs nothing.");
  console.log("");
  console.log("  " + "bucket".padEnd(20) + "same".padStart(6) + "lap-only".padStart(10)
    + "vps-only".padStart(10) + "differ".padStart(8) + "  of which expected");

  const unexplained = [];
  const vpsOnlyAll = [];
  for (const b of BUCKETS) {
    const lap = localHashes(b.local, b.glob);
    const vps = remote.get(b.local) || new Map();
    let same = 0, differ = 0, expected = 0;
    const lapOnly = [], vpsOnly = [], diffs = [];
    for (const [f, h] of lap) {
      if (!vps.has(f)) { lapOnly.push(f); continue; }
      if (vps.get(f) === h) { same++; continue; }
      differ++;
      const isExpected = BOX_SPECIFIC.some(rx => rx.test(f));
      if (isExpected) expected++; else { diffs.push(f); unexplained.push(b.name + "  " + f); }
    }
    for (const f of vps.keys()) {
      if (IS_BACKUP.test(f)) continue;
      if (!lap.has(f)) { vpsOnly.push(f); vpsOnlyAll.push(b.name + "  " + f); }
    }

    console.log("  " + b.name.padEnd(20) + String(same).padStart(6)
      + String(lapOnly.length).padStart(10) + String(vpsOnly.length).padStart(10)
      + String(differ).padStart(8) + String(expected).padStart(20));

    if (SHOW_FILES) {
      for (const f of lapOnly) console.log("        + laptop only  " + f);
      for (const f of vpsOnly) console.log("        + VPS only     " + f);
      for (const f of diffs)   console.log("        ~ differs      " + f);
    }
  }

  console.log("");
  if (vpsOnlyAll.length) {
    // The loudest thing this can find. 2026-09-01: five memories had lived ONLY on the
    // VPS for a month. A one-way push would have destroyed them.
    console.log("  VPS-ONLY FILES — a one-way push would DESTROY these:");
    for (const f of vpsOnlyAll) console.log("    ! " + f);
    console.log("");
  } else {
    console.log("  No VPS-only files. Nothing here would be lost by a push right now,");
    console.log("  but that is a fact about TODAY, not a property of the sync.");
    console.log("");
  }

  console.log("  UNEXPLAINED DIFFERENCES (" + unexplained.length + ") — laptop ahead, or VPS diverged:");
  for (const f of unexplained.slice(0, 20)) console.log("    ~ " + f);
  if (unexplained.length > 20) console.log("    ... and " + (unexplained.length - 20) + " more");
  console.log("");
  console.log("  A hash cannot tell 'the laptop is a few hours ahead' from 'the VPS has its");
  console.log("  own patch'. That is why nothing here is synced automatically. BRAIN is the");
  console.log("  one bucket where union-merge is provably safe — a memory is additive");
  console.log("  knowledge, never box-specific config — and brain_sync.cjs handles it.");
  console.log("");
  console.log("  NEVER SYNCED, enforced in code rather than remembered:");
  for (const [f, why] of NEVER_SYNC) console.log("    x " + f.padEnd(32) + why);
  console.log("");
  console.log("=====================");
  console.log("");
  return 0;
}

try { process.exit(main()); }
catch (e) { console.error("[fleet-buckets] " + e.message); process.exit(1); }
