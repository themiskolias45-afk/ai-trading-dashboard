// BRAIN STATS — publish the memory and cognition layer so a page can render it.
//
// WHY THIS EXISTS. The System Map and Architecture pages were binding to /api/rag,
// /api/cognition, /api/brain-status and /api/jarvis. NONE OF THOSE ROUTES EXIST. I
// concluded they did because they answered 401 — but this server's auth middleware
// returns 401 for EVERY /api/* path, including a nonsense one, so a 401 proves nothing
// about whether a route is registered. Probing the negative case (a deliberately fake
// endpoint) is what settles it, and I did not do that first.
//
// So those cards could only ever render "?", which is why the brain layer looked empty.
//
// WHY A FILE AND NOT A ROUTE. Adding a route to server/index.js needs a server restart
// to take effect, and there are open positions. express.static already serves
// dashboard/*.json — that is exactly how dashboard/mt5-runtime-status.json reaches the
// UI — so writing an artifact needs no restart, no route, and no risk to anything live.
//
// READ-ONLY over things that already exist. Counts files, reads two JSON stores, asks
// the RAG index for its own total. Writes exactly one file. Starts nothing, spawns no
// agent, spends no tokens, and touches no gate, threshold or position.
//
//   node tasks/brain_stats.cjs            write dashboard/brain-stats.json
//   node tasks/brain_stats.cjs --print    print it, write nothing

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "dashboard", "brain-stats.json");
const PRINT_ONLY = process.argv.includes("--print");

// DERIVE the memory directory, never hardcode it. Claude names the project folder after
// the project PATH with separators and colons replaced by "-", so it differs per box:
//   C:\Users\User\ai-trading-dashboard  ->  C--Users-User-ai-trading-dashboard
//   C:\ai-trading-dashboard             ->  C--ai-trading-dashboard
// The first version hardcoded the laptop's name, so the VPS reported "memory directory
// not found" -- which on a page reads as a brain with no memories rather than as a wrong
// path on my side. When it still cannot be found, the path TRIED is reported, so the next
// reader is not guessing.
const HOME = process.env.USERPROFILE || process.env.HOME || "C:\\Users\\User";
// EACH separator becomes one dash, not each RUN of them. "C:\" is two characters and
// must become two dashes -- C--Users-User-... -- so the greedy + was wrong and produced
// C-Users-User-..., which matches no directory on either box.
function projectSlug(dir) { return dir.replace(/[\\/:]/g, "-"); }
const MEMORY_CANDIDATES = [
  path.join(HOME, ".claude", "projects", projectSlug(path.resolve(ROOT)), "memory"),
  path.join(HOME, ".claude", "projects", projectSlug(ROOT), "memory")
];
const MEMORY_DIR = MEMORY_CANDIDATES.find(function (d) { return fs.existsSync(d); })
                || MEMORY_CANDIDATES[0];
const VAULT_DIR = path.join(
  process.env.USERPROFILE || process.env.HOME || "C:\\Users\\User", "Documents", "Brain"
);
const MCP_GRAPH = path.join(VAULT_DIR, "mcp-memory.json");
const JARVIS_MEM = path.join(ROOT, "tasks", "jarvis_memory.json");
const RAG_DB = path.join(ROOT, "tasks", "rag_db");
const CLAUDE_MD = path.join(ROOT, "CLAUDE.md");
const VAULT_INDEX = path.join(VAULT_DIR, "VAULT-INDEX.md");

// Every field carries its own "could this be read" answer. A count of 0 and a count that
// could not be taken must never look the same — that distinction is the whole reason the
// pages show "?" in grey rather than a green zero.
function safe(fn, fallback) {
  try { return fn(); } catch (e) { return fallback === undefined ? { error: e.message } : fallback; }
}

function countMemoryFiles() {
  if (!fs.existsSync(MEMORY_DIR)) return { ok: false, why: "no memory dir at " + MEMORY_DIR, tried: MEMORY_CANDIDATES };
  const all = fs.readdirSync(MEMORY_DIR).filter((f) => f.endsWith(".md"));
  // MEMORY.md and MEMORY-FULL.md are INDEXES over the memories, not memories themselves.
  const indexes = all.filter((f) => /^MEMORY(-FULL)?\.md$/.test(f));
  const files = all.filter((f) => !/^MEMORY(-FULL)?\.md$/.test(f));
  let newest = null;
  for (const f of files) {
    const m = fs.statSync(path.join(MEMORY_DIR, f)).mtime.toISOString();
    if (!newest || m > newest) newest = m;
  }
  return { ok: true, count: files.length, indexes: indexes.length, newestAt: newest };
}

function countRagChunks() {
  if (!fs.existsSync(RAG_DB)) return { ok: false, why: "rag_db not present" };
  // chromadb keeps its rows in chroma.sqlite3. Reading the count without a sqlite driver
  // is not worth a dependency, so report the store's SIZE and AGE, which is what actually
  // answers "is the index being rebuilt" — and say plainly that it is not a chunk count.
  const db = path.join(RAG_DB, "chroma.sqlite3");
  if (!fs.existsSync(db)) return { ok: false, why: "chroma.sqlite3 not present" };
  const st = fs.statSync(db);
  return {
    ok: true,
    storeBytes: st.size,
    rebuiltAt: st.mtime.toISOString(),
    note: "store size and rebuild time; not a chunk count — that needs a sqlite read"
  };
}

function readGraph() {
  if (!fs.existsSync(MCP_GRAPH)) return { ok: false, why: "mcp-memory.json not found" };
  const txt = fs.readFileSync(MCP_GRAPH, "utf8");
  let entities = 0, relations = 0;
  for (const line of txt.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line);
      if (j.type === "entity") entities++;
      else if (j.type === "relation") relations++;
    } catch { /* a partial line is not a fatal read */ }
  }
  return {
    ok: true, entities, relations,
    // A graph with entities and NO relations is a list wearing the name of a graph.
    // Saying so here means the page does not have to infer it.
    verdict: relations === 0 ? "entities only — no relations have ever been written" : "linked"
  };
}

function readJarvisMemory() {
  if (!fs.existsSync(JARVIS_MEM)) return { ok: false, why: "jarvis_memory.json not found" };
  const j = JSON.parse(fs.readFileSync(JARVIS_MEM, "utf8"));
  const entries = Array.isArray(j) ? j : (j.entries || []);
  return { ok: true, entries: entries.length, lastUpdated: j.last_updated || null };
}

function fileFact(p, label) {
  if (!fs.existsSync(p)) return { ok: false, why: label + " not found" };
  const st = fs.statSync(p);
  return { ok: true, bytes: st.size, modifiedAt: st.mtime.toISOString() };
}

const stats = {
  generatedAt: new Date().toISOString(),
  host: process.env.COMPUTERNAME || "unknown",
  // Nothing here can change a trade. Stated in the payload so a reader never has to
  // wonder whether an observability surface is on the trade path.
  feedsTheGate: false,
  memories: safe(countMemoryFiles),
  rag: safe(countRagChunks),
  graph: safe(readGraph),
  jarvisMemory: safe(readJarvisMemory),
  bootConfig: safe(() => fileFact(CLAUDE_MD, "CLAUDE.md")),
  vaultIndex: safe(() => fileFact(VAULT_INDEX, "VAULT-INDEX.md")),
  note: "Written by tasks/brain_stats.cjs. Read-only over files that already exist; " +
        "served as a static artifact because adding an /api route would need a server restart."
};

if (PRINT_ONLY) {
  console.log(JSON.stringify(stats, null, 2));
  process.exit(0);
}

// Write atomically: a page polling every 30s must never read a half-written file.
const tmp = OUT + ".tmp";
fs.writeFileSync(tmp, JSON.stringify(stats, null, 2), "utf8");
fs.renameSync(tmp, OUT);

console.log("brain-stats written: " + path.relative(ROOT, OUT));
console.log("  memories      " + (stats.memories.ok ? stats.memories.count : stats.memories.why));
console.log("  graph         " + (stats.graph.ok ? stats.graph.entities + " entities, " + stats.graph.relations + " relations" : stats.graph.why));
console.log("  jarvis memory " + (stats.jarvisMemory.ok ? stats.jarvisMemory.entries + " entries" : stats.jarvisMemory.why));
console.log("  rag store     " + (stats.rag.ok ? Math.round(stats.rag.storeBytes / 1048576) + " MB, rebuilt " + stats.rag.rebuiltAt : stats.rag.why));
