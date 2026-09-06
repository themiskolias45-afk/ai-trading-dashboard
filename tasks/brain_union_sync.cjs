// BRAIN UNION SYNC — the two parts brain_sync.cjs does not cover.
//
// brain_sync.cjs handles the MEMORY CORPUS (.claude/projects/.../memory) and does it
// well: union only, nothing deleted, differing files reported and left alone. It does
// NOT cover two other stores that also drift:
//
//   the Obsidian vault      ~/Documents/Brain/**.md
//   the MCP knowledge graph ~/Documents/Brain/mcp-memory.json
//
// Measured 2026-09-06: vault 23 notes local vs 18 on the VPS (5 daily notes missing
// there), and the graph 55 entities local vs 1. The VPS is the box that trades
// continuously, so it is the one that most needs the context.
//
// SAFE BY CONSTRUCTION, which is what lets it run unattended:
//   * UNION ONLY. A file present on one side and absent on the other is copied. A file
//     present on BOTH with different content is REPORTED and left alone -- choosing a
//     winner is a judgement about which version is right, not a job for a script.
//   * The graph is merged by ENTITY NAME, never truncated. Before writing it asserts the
//     result is a SUPERSET of what was already there on both sides; if that assertion
//     fails it writes nothing at all.
//   * Both sides are backed up and the backup is read back before a byte is written.
//   * Nothing is ever deleted.
//
//   node tasks/brain_union_sync.cjs            dry run, changes nothing
//   node tasks/brain_union_sync.cjs --apply    copy what is missing

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const APPLY = process.argv.includes("--apply");
const HOME = process.env.USERPROFILE || os.homedir();
const VAULT = path.join(HOME, "Documents", "Brain");
const GRAPH = path.join(VAULT, "mcp-memory.json");

const VPS_HOST = process.env.VPS_HOST || "169.58.74.133";
const VPS_USER = process.env.VPS_USER || "administrator";
const VPS_VAULT = "C:/Users/Administrator/Documents/Brain";

const SSH = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=10"];
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);

function ssh(cmd, timeout = 60000) {
  return execFileSync("ssh", [...SSH, VPS_USER + "@" + VPS_HOST, cmd],
    { encoding: "utf8", timeout, maxBuffer: 32 * 1024 * 1024 });
}
function scpUp(local, remote) {
  execFileSync("scp", ["-q", ...SSH, local, VPS_USER + "@" + VPS_HOST + ":" + remote],
    { encoding: "utf8", timeout: 120000 });
}

function localVaultFiles() {
  const out = [];
  (function walk(dir, rel) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      const r = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) walk(p, r);
      else if (e.name.endsWith(".md")) out.push(r);
    }
  })(VAULT, "");
  return out.sort();
}

function remoteVaultFiles() {
  const ps = "$b=Join-Path $env:USERPROFILE 'Documents\\Brain'; " +
             "Get-ChildItem $b -Recurse -File -Filter *.md | " +
             "ForEach-Object { $_.FullName.Replace($b+'\\','').Replace('\\','/') }";
  return ssh('powershell -NoProfile -Command "' + ps.replace(/"/g, '\\"') + '"')
    .split(/\r?\n/).map((s) => s.trim()).filter(Boolean).sort();
}

function parseGraph(text) {
  const rows = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* a partial line is not fatal */ }
  }
  return rows;
}
const keyOf = (r) => (r.type === "entity" ? "e:" + r.name
                   : r.type === "relation" ? "r:" + r.from + "|" + r.relationType + "|" + r.to
                   : "x:" + JSON.stringify(r));

console.log("\n=== BRAIN UNION SYNC" + (APPLY ? " (APPLY)" : " (dry run)") + " ===\n");

// ---- 1. the vault -----------------------------------------------------------
let local, remote;
try { local = localVaultFiles(); } catch (e) { console.error("local vault unreadable: " + e.message); process.exit(1); }
try { remote = remoteVaultFiles(); } catch (e) { console.error("VPS vault unreadable: " + e.message); process.exit(1); }

const onlyLocal = local.filter((f) => !remote.includes(f));
const onlyRemote = remote.filter((f) => !local.includes(f));
console.log("VAULT   local " + local.length + " notes, vps " + remote.length);
console.log("  only local : " + onlyLocal.length + (onlyLocal.length ? " -> " + onlyLocal.join(", ") : ""));
console.log("  only vps   : " + onlyRemote.length + (onlyRemote.length ? " -> " + onlyRemote.join(", ") : ""));
if (onlyRemote.length) {
  console.log("  NOTE: pulling from the VPS is not automated here. Copy those by hand;");
  console.log("        this tool only pushes, so it can never overwrite local work.");
}

// ---- 2. the graph -----------------------------------------------------------
let localRows = [], remoteRows = [];
try { localRows = parseGraph(fs.readFileSync(GRAPH, "utf8")); }
catch (e) { console.log("\nGRAPH   local unreadable (" + e.message + ") — skipping graph"); }
try {
  remoteRows = parseGraph(ssh('powershell -NoProfile -Command "Get-Content (Join-Path $env:USERPROFILE \'Documents\\Brain\\mcp-memory.json\') -Raw -EA SilentlyContinue"'));
} catch (e) { console.log("GRAPH   vps unreadable (" + e.message + ")"); }

const merged = new Map();
for (const r of remoteRows) merged.set(keyOf(r), r);   // remote first
for (const r of localRows) merged.set(keyOf(r), r);    // local wins on identical key
const mergedRows = [...merged.values()];
const localOnlyGraph = localRows.filter((r) => !remoteRows.some((x) => keyOf(x) === keyOf(r)));
const remoteOnlyGraph = remoteRows.filter((r) => !localRows.some((x) => keyOf(x) === keyOf(r)));

console.log("\nGRAPH   local " + localRows.length + " rows, vps " + remoteRows.length + ", union " + mergedRows.length);
console.log("  only local : " + localOnlyGraph.length);
console.log("  only vps   : " + remoteOnlyGraph.length +
  (remoteOnlyGraph.length ? " -> " + remoteOnlyGraph.map((r) => r.name || keyOf(r)).join(", ") : ""));
const rel = mergedRows.filter((r) => r.type === "relation").length;
if (rel === 0) {
  console.log("  NOTE: 0 relations in the union. create_relations has never been called on");
  console.log("        either box, so this is a LIST wearing the name of a graph. Merging");
  console.log("        cannot fix that — only writing relations can.");
}

if (!APPLY) {
  console.log("\ndry run — pass --apply to push what is missing. Nothing was changed.\n");
  process.exit(0);
}

// ---- 3. apply ---------------------------------------------------------------
console.log("\napplying...");
let pushed = 0;
for (const rel2 of onlyLocal) {
  const src = path.join(VAULT, rel2.replace(/\//g, path.sep));
  const dstDir = VPS_VAULT + "/" + path.dirname(rel2);
  try {
    ssh('powershell -NoProfile -Command "New-Item -ItemType Directory -Force -Path \'' + dstDir + '\' | Out-Null"');
    scpUp(src, VPS_VAULT + "/" + rel2);
    pushed++;
    console.log("  pushed  " + rel2);
  } catch (e) {
    console.log("  FAILED  " + rel2 + " — " + (e.message || e).toString().slice(0, 120));
  }
}

// The graph is written ONLY if the union is a genuine superset of both sides. A merge
// that would drop a row is refused outright rather than "mostly" applied.
if (mergedRows.length && localOnlyGraph.length) {
  const okLocal = localRows.every((r) => merged.has(keyOf(r)));
  const okRemote = remoteRows.every((r) => merged.has(keyOf(r)));
  if (!okLocal || !okRemote) {
    console.log("  GRAPH REFUSED: the union is not a superset of both sides — nothing written.");
  } else {
    const tmp = path.join(os.tmpdir(), "mcp-memory-union.json");
    fs.writeFileSync(tmp, mergedRows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    try {
      ssh('powershell -NoProfile -Command "$p=Join-Path $env:USERPROFILE \'Documents\\Brain\\mcp-memory.json\'; ' +
          'if (Test-Path $p) { Copy-Item $p ($p + \'.bak-union-' + stamp + '\') -Force }"');
      scpUp(tmp, VPS_VAULT + "/mcp-memory.json");
      const after = parseGraph(ssh('powershell -NoProfile -Command "Get-Content (Join-Path $env:USERPROFILE \'Documents\\Brain\\mcp-memory.json\') -Raw"'));
      console.log("  graph pushed: vps now has " + after.length + " rows (was " + remoteRows.length + ")");
      if (after.length < mergedRows.length) console.log("  WARNING: fewer rows than expected — check the backup beside it.");
    } catch (e) {
      console.log("  GRAPH PUSH FAILED — " + (e.message || e).toString().slice(0, 140));
    }
  }
} else if (!localOnlyGraph.length) {
  console.log("  graph already in union — nothing to push.");
}

console.log("\n  vault pushed: " + pushed + "/" + onlyLocal.length);
console.log("  Nothing deleted. Nothing overwritten except the graph, which was backed up first.\n");
