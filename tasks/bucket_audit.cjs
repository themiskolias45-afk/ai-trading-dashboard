#!/usr/bin/env node
'use strict';
/**
 * BUCKET AUDIT — is EVERYTHING on the laptop, and how old is the oldest copy?
 *
 * The standing requirement, in the user's words 2026-09-02: "I don't want for any reason
 * in future to lose anything — any data, any memory, any brain, any learning." And the
 * shape he asked for: bucket everything TO THE LAPTOP, so one box holds the lot.
 *
 * WHAT ALREADY EXISTED, verified rather than assumed. The protection was better than it
 * looked: the laptop's vault zip is copied off-box to the VPS, and the VPS's backup zip is
 * pulled down to the laptop. Each box holds the other's. What was missing was not a copy —
 * it was FREQUENCY and a way to know. Both ran once a day, so up to 24h of work sat
 * unprotected, and nothing said how stale the newest copy was.
 *
 * THIS ANSWERS THE ONLY QUESTION THAT MATTERS: if this box died right now, what is gone,
 * and if the VPS died right now, what is gone. It checks the ARCHIVES, not the live
 * files — a live file is not a backup of itself.
 *
 * IT OPENS THE ZIPS. A backup verified by its filename is a hope; the 05:25 archive today
 * looked fine and was missing decision_register.jsonl entirely, because it predated it.
 * Only reading the entries catches that.
 *
 *   node tasks/bucket_audit.cjs
 *
 * READ-ONLY. Opens nothing on the network, writes nothing, deletes nothing.
 * Exit 0 when every bucket is present and fresh, 1 when something is missing or stale —
 * so a scheduled caller can tell the difference.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const HOME = process.env.USERPROFILE || os.homedir();

// Where the two archives land. Both are ON THE LAPTOP by design: this is the one bucket.
const LAPTOP_ARCHIVE = path.join(HOME, "Documents", "Brain-backups");   // this box's own
const VPS_ARCHIVE = path.join(ROOT, "vps-backups");                     // pulled from the VPS

// Every archive should be newer than this or the work since is unprotected. 5h, because
// both jobs now repeat every 4h — one missed run is tolerated, two is a problem.
const STALE_HOURS = 5;

// What MUST be inside, per archive, and why it cannot be reconstructed if lost.
const REQUIRED = {
  laptop: [
    ["MEMORY.md", "the memory index the boot sequence reads"],
    ["decision_register.jsonl", "every standing decision, harvested from source comments"],
    ["journal.json", "the trade record - not reconstructable from anything"],
    ["rejections.jsonl", "the rejection ledger; the only evidence that grows without risking money"],
    ["mcp-memory.json", "the MCP knowledge graph"],
    ["learning.json", "THIS box's per-setup learning; never synced, so this archive is its only copy"],
  ],
  vps: [
    ["learning.json", "the VPS's OWN learning. It is never synced by design, so if the VPS dies this archive is the only copy in existence"],
  ],
};

function hoursOld(d) { return (Date.now() - d.getTime()) / 3600000; }
function human(h) {
  if (h < 1) return Math.round(h * 60) + "m";
  if (h < 48) return h.toFixed(1) + "h";
  return (h / 24).toFixed(1) + "d";
}

function newestZip(dir) {
  if (!fs.existsSync(dir)) return null;
  const zips = fs.readdirSync(dir).filter(f => f.endsWith(".zip"))
    .map(f => ({ f, p: path.join(dir, f), m: fs.statSync(path.join(dir, f)).mtime }))
    .sort((a, b) => b.m - a.m);
  return zips[0] || null;
}

// Reading a zip's entry list without a dependency: powershell holds the only zip reader
// guaranteed present on both boxes. Names only — this never extracts anything.
function entryNames(zipPath) {
  const ps = "Add-Type -AssemblyName System.IO.Compression.FileSystem; "
    + "$z=[IO.Compression.ZipFile]::OpenRead('" + zipPath.replace(/'/g, "''") + "'); "
    + "$z.Entries | ForEach-Object { $_.Name }; $z.Dispose()";
  try {
    return new Set(execFileSync("powershell", ["-NoProfile", "-Command", ps],
      { encoding: "utf8", timeout: 90000, maxBuffer: 64 * 1024 * 1024 })
      .split(/\r?\n/).map(s => s.trim()).filter(Boolean));
  } catch (e) { return null; }
}

function auditOne(label, dir, required) {
  const z = newestZip(dir);
  console.log("");
  console.log("  " + label);
  if (!z) {
    console.log("    *** NO ARCHIVE AT " + dir + " ***");
    console.log("    Everything this bucket should protect is unprotected.");
    return false;
  }
  const age = hoursOld(z.m);
  const stale = age > STALE_HOURS;
  console.log("    newest : " + z.f + "  (" + Math.round(fs.statSync(z.p).size / 1024) + " KB)");
  console.log("    age    : " + human(age) + (stale ? "   *** STALE, work since then is unprotected ***" : "   ok"));

  const names = entryNames(z.p);
  if (!names) { console.log("    *** could not read the archive - treat as unverified ***"); return false; }
  console.log("    entries: " + names.size);
  let allPresent = true;
  for (const [f, why] of required) {
    const ok = names.has(f);
    if (!ok) allPresent = false;
    console.log("    " + (ok ? "  ok " : "  ** ") + f.padEnd(26) + (ok ? "" : "MISSING - " + why));
  }
  return allPresent && !stale;
}

function main() {
  console.log("");
  console.log("=== BUCKET AUDIT — is everything on the laptop? ===");
  console.log("  Archives only. A live file is not a backup of itself.");

  const a = auditOne("LAPTOP's own data  -> " + LAPTOP_ARCHIVE, LAPTOP_ARCHIVE, REQUIRED.laptop);
  const b = auditOne("VPS's data, pulled -> " + VPS_ARCHIVE, VPS_ARCHIVE, REQUIRED.vps);

  console.log("");
  if (a && b) {
    console.log("  BOTH BUCKETS PRESENT AND FRESH.");
    console.log("  If either box died now, the other holds a copy of its data.");
  } else {
    console.log("  *** SOMETHING IS MISSING OR STALE — see the ** lines above. ***");
    console.log("  Re-run the jobs that fill them:");
    console.log("    powershell -File tasks\\backup_vault.ps1        (this box -> archive + VPS)");
    console.log("    schtasks /run /tn SmartEntryVPSBackupPull      (VPS -> this box)");
  }
  console.log("");
  console.log("  NOT COVERED, and stated so it is never assumed: anything created since the");
  console.log("  newest archive above. Both jobs repeat every 4h, so the exposure is bounded");
  console.log("  by that, not by a day.");
  console.log("==================================================");
  console.log("");
  return (a && b) ? 0 : 1;
}

try { process.exit(main()); }
catch (e) { console.error("[bucket-audit] " + e.message); process.exit(1); }
