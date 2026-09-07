/* ============================================================================
   DURABLE STATE AUDIT — what a restart would take with it
   ============================================================================

   WHY THIS EXISTS

   On 2026-08-29 the server was restarted twice. Nine state files were backed up
   and verified by size and sha1 first, and every one came through intact. The
   thing that was lost lived in NONE of them: `tvAlerts` was `let tvAlerts = []`
   with no writer anywhere, so the whole alert feed went with the process, in
   silence. A backup of the files on disk cannot protect state that was never on
   disk.

   The same sweep then found two more of exactly that shape:
     features          six flags, reset to all-true by every restart. Two change
                       BEHAVIOUR: newsFilter gates the news blackout and can
                       block a setup that would otherwise fire, and trailingStop
                       is read by mt5_bridge.py over GET /api/features.
     manualTradeQueue  trades waiting for a human to approve them, discarded.

   So this audit takes the general case: enumerate EVERY module-level mutable
   binding in server/index.js and require each one to be classified. New state
   cannot be added without either persisting it or writing down, here, why it
   does not need to be.

   THE THREE CLASSES

     persisted    it has a loader and a saver, and this audit VERIFIES both exist
                  in the source. A classification that merely claims persistence
                  is worth nothing — that is how tvAlerts read as fine.
     regenerable  a cache or an in-flight flag. Refills itself from a live source
                  within minutes, and the entry says from WHERE.
     accepted     genuinely lost on restart, and that is a decision on record with
                  a reason, not an oversight.

   Anything not in the inventory is UNCLASSIFIED and reported — that is the whole
   point. A new `let` in index.js should make this go amber tomorrow morning.

   PROPOSES ONLY. Reads two files, writes one JSON. Never edits, never deletes,
   always exits 0, no LLM, no tokens, no network.

   Usage: node tasks/durable_state_audit.cjs [--out <path>] [--json] [--quiet]
                                             [--src <index.js>] [--selftest-only]
   ============================================================================ */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
function opt(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const SRC_FILE = opt("--src", path.join(ROOT, "server", "index.js"));
const OUT = opt("--out", path.join(ROOT, "dashboard", "durable-state.json"));
const QUIET = process.argv.includes("--quiet");
const AS_JSON = process.argv.includes("--json");
const SELFTEST_ONLY = process.argv.includes("--selftest-only");

/* ── the inventory ───────────────────────────────────────────────────────────
   Every module-level binding in server/index.js, and what happens to it when the
   process dies. `loader` and `saver` are checked against the source. */
const INVENTORY = {
  // ── persisted: survives a restart, and the functions are verified below ──
  tradeJournal:     { klass: "persisted", loader: "loadJournal", saver: "saveJournal",
                      why: "the trade record — journal.json" },
  learning:         { klass: "persisted", loader: "loadLearning", saver: "saveLearning",
                      why: "weeks of accumulated edge — learning.json" },
  tradingControl:   { klass: "persisted", loader: "loadTradingControl", saver: "saveTradingControl",
                      why: "a halt is a safety decision and must outlive the process" },
  tvAlerts:         { klass: "persisted", loader: "loadAlerts", saver: "saveAlerts",
                      why: "display buffer in tv_alerts.json, plus an append-only archive in tasks/logs/tv_alerts.jsonl" },
  features:         { klass: "persisted", loader: "loadFeatures", saver: "saveFeatures",
                      why: "newsFilter can block a setup and trailingStop is read by the bridge — a toggle that reverts itself is worse than no toggle" },
  manualTradeQueue: { klass: "persisted", loader: "loadManualQueue", saver: "saveManualQueue",
                      why: "trades awaiting human approval — losing a pending DECISION is worse than losing a log line" },

  // ── regenerable: refills from a live source, and the entry says which ──
  priceCache:            { klass: "regenerable", why: "refilled by the price poll within a minute" },
  sentimentCache:        { klass: "regenerable", why: "refilled by the sentiment poll" },
  signalCache:           { klass: "regenerable", why: "rebuilt by the next refreshSignals cycle" },
  signalHistory:         { klass: "regenerable", why: "DISPLAY buffer only, 100 cycles. The durable record is the SQLite signals table via persistSignalChanges(), and its own comment says a restart writing one row per asset is wanted" },
  mt5CandleCache:        { klass: "regenerable", why: "refilled by the next bridge bar push" },
  mt5SymbolSpecs:        { klass: "regenerable", why: "re-fetched from the bridge on demand" },
  dailyPlan:             { klass: "regenerable", why: "regenerated by generateDailyPlan()" },
  congressCache:         { klass: "regenerable", why: "re-fetched from Unusual Whales on first request" },
  flowCache:             { klass: "regenerable", why: "re-fetched from Unusual Whales on first request" },
  mt5PositionsByAccount: { klass: "regenerable", why: "the bridge re-pushes positions within ~60s; the broker is the source of truth, not this" },
  mt5Positions:          { klass: "regenerable", why: "flattened from mt5PositionsByAccount" },
  newsCache:             { klass: "regenerable", why: "re-fetched from the calendar feed" },
  riskStatus:            { klass: "regenerable", why: "the BRIDGE owns the breaker and persists it to breaker_state_<TAG>.json, then re-pushes; this copy is derived" },
  riskStatusByAccount:   { klass: "regenerable", why: "same — bridge-owned and re-pushed per account" },
  mt5LastSeenByAccount:  { klass: "regenerable", why: "rebuilt by the next bridge check-in" },
  strategySettings:      { klass: "regenerable", why: "read from strategy_settings.json at boot; the FILE is the state, this is the copy" },
  strategySettingsError: { klass: "regenerable", why: "recomputed by the same load" },
  analysisCache:         { klass: "regenerable", why: "recomputed by refreshAnalysis()" },
  backtestCache:         { klass: "regenerable", why: "recomputed on request; a 12h cache, not a record" },
  goLiveCache:           { klass: "regenerable", why: "short-lived response cache" },
  verboseTaskCache:      { klass: "regenerable", why: "short-lived response cache" },
  peerProbeCache:        { klass: "regenerable", why: "short-lived response cache" },
  doctorCache:           { klass: "regenerable", why: "short-lived response cache" },
  engineSetupNamesCache: { klass: "regenerable", why: "derived from the engine source at first use" },
  aiFilterHealth:        { klass: "regenerable", why: "counters for the current process; the durable record is the rejection ledger" },

  // ── accepted: lost on restart, on purpose, with a reason ──
  knownChatIds:          { klass: "accepted", why: "Telegram chat ids. TELEGRAM_CHAT_ID is re-seeded from keys.env at boot and any other chat re-registers on its next message" },
  lastUpdateId:          { klass: "accepted", why: "Telegram long-poll cursor; restarting re-syncs it" },
  telegramPollingStarted:{ klass: "accepted", why: "in-process guard" },
  telegramPollingChecking:{klass: "accepted", why: "in-process guard" },
  signalRefreshInFlight: { klass: "accepted", why: "in-process guard" },
  signalRefreshChain:    { klass: "accepted", why: "in-process promise chain" },
  goLiveInFlight:        { klass: "accepted", why: "in-process guard" },
  doctorInFlight:        { klass: "accepted", why: "in-process guard" },
  dailyPlanArtifactInFlight: { klass: "accepted", why: "in-process guard" },
  _lastAnalysisFingerprint: { klass: "accepted", why: "dedupe key for the current process" },
  lastNearMissMalformed: { klass: "accepted", why: "diagnostic counter for this process; the ledger file holds the data" },
  lastNearMissError:     { klass: "accepted", why: "last error string, diagnostic only" },
  lastStopVariantMalformed:{klass: "accepted", why: "diagnostic counter for this process" },
  lastStopVariantError:  { klass: "accepted", why: "last error string, diagnostic only" },
  TELEGRAM_TOKEN:        { klass: "accepted", why: "read from keys.env at boot" },
  TELEGRAM_CHAT_ID:      { klass: "accepted", why: "read from keys.env at boot" },
  UW_API_KEY:            { klass: "accepted", why: "read from keys.env at boot" },
  OPENAI_API_KEY:        { klass: "accepted", why: "read from keys.env at boot" },
  ANTHROPIC_API_KEY:     { klass: "accepted", why: "read from apikey.txt / env at boot" },
  anthropic:             { klass: "accepted", why: "SDK client, rebuilt at boot" },
};

/** Module-level `let` bindings — depth 0 only, strings and comments removed. */
function findModuleState(src) {
  const lines = src.split(/\r?\n/);
  const found = [];
  let depth = 0;
  lines.forEach((line, i) => {
    const code = line
      .replace(/\/\/.*$/, "")
      .replace(/'[^']*'|"[^"]*"|`[^`]*`/g, "");
    if (depth === 0) {
      const m = code.match(/^\s*let\s+([A-Za-z_$][\w$]*)\s*=/);
      if (m) found.push({ name: m[1], line: i + 1 });
    }
    depth += (code.split("{").length - 1) - (code.split("}").length - 1);
    if (depth < 0) depth = 0;
  });
  return found;
}

/* Line comments stripped, block comments left alone. index.js contains slashes
   inside strings and regex literals, and a whole-file block-comment strip has
   already eaten real code once today — line comments are enough here, because
   what matters is whether a CALL is commented out. */
function stripLineComments(src) {
  return src.split(/\r?\n/)
    .filter(l => !/^\s*(\/\/|\*)/.test(l))
    .map(l => l.replace(/\s\/\/.*$/, ""))
    .join("\n");
}

function audit(src) {
  const state = findModuleState(src);
  const liveCode = stripLineComments(src);
  const findings = [];
  const rows = [];

  for (const s of state) {
    const entry = INVENTORY[s.name];
    if (!entry) {
      /* The reason this file exists. Somebody added state and nobody decided
         what a restart does to it. */
      findings.push({ level: "AMBER", name: s.name, line: s.line, check: "unclassified",
        detail: "new module-level state with no entry in the inventory — decide whether a "
              + "restart may lose it, then persist it or record why it need not be" });
      rows.push({ name: s.name, line: s.line, klass: "UNCLASSIFIED", why: null });
      continue;
    }
    if (entry.klass === "persisted") {
      /* Verify, do not take the word of the table. A claim of persistence with
         no saver is exactly what tvAlerts looked like from the outside. */
      const hasLoader = new RegExp("function\\s+" + entry.loader + "\\s*\\(").test(liveCode);
      const hasSaver = new RegExp("function\\s+" + entry.saver + "\\s*\\(").test(liveCode);
      /* liveCode has comments removed. The first version searched the raw source,
         so `// loadAlerts();` counted as a call — commenting the loader out was
         invisible to the very check written to catch it. Found by mutation test,
         not by reading. */
      const loaderCalled = new RegExp("(^|[^\\w.])" + entry.loader + "\\s*\\(\\s*\\)\\s*;", "m").test(liveCode);
      const saverCalled = (liveCode.match(new RegExp("(^|[^\\w.])" + entry.saver + "\\s*\\(\\s*\\)\\s*;", "g")) || []).length;
      if (!hasLoader || !hasSaver) {
        findings.push({ level: "RED", name: s.name, line: s.line, check: "claimed-persisted-but-isnt",
          detail: "the inventory says persisted, but "
                + (!hasLoader ? entry.loader + "() " : "") + (!hasSaver ? entry.saver + "() " : "")
                + "is not defined in this file" });
      } else if (!loaderCalled) {
        findings.push({ level: "RED", name: s.name, line: s.line, check: "loader-never-called",
          detail: entry.loader + "() exists and nothing calls it, so nothing is ever restored" });
      } else if (saverCalled === 0) {
        findings.push({ level: "RED", name: s.name, line: s.line, check: "saver-never-called",
          detail: entry.saver + "() exists and nothing calls it, so nothing is ever written" });
      }
      rows.push({ name: s.name, line: s.line, klass: "persisted", why: entry.why,
                  loader: entry.loader, saver: entry.saver, saveSites: saverCalled });
      continue;
    }
    rows.push({ name: s.name, line: s.line, klass: entry.klass, why: entry.why });
  }

  /* An inventory entry for state that no longer exists is stale bookkeeping —
     harmless, but it is how a table starts lying. */
  const live = new Set(state.map(s => s.name));
  for (const name of Object.keys(INVENTORY)) {
    if (!live.has(name)) {
      findings.push({ level: "INFO", name, line: null, check: "inventory-stale",
        detail: "the inventory lists this and index.js no longer declares it" });
    }
  }

  return { state, rows, findings };
}

/* ── SELF-TEST ───────────────────────────────────────────────────────────────
   A canary source carrying each defect on purpose. The page audit's
   raw-interpolation check was dead from the day it was written and reported
   every page clean for its whole life; nothing here ships without a canary. */
function selfTest() {
  const fired = [];
  const dead = [];

  // 1. unclassified state must be caught
  const canaryNew = "let somethingBrandNew = [];\n";
  const r1 = audit(canaryNew);
  (r1.findings.some(f => f.check === "unclassified") ? fired : dead).push("unclassified");

  // 2. a persistence claim with no saver must be caught
  const canaryFake = "let tvAlerts = [];\nfunction loadAlerts() {}\nloadAlerts();\n";
  const r2 = audit(canaryFake);
  (r2.findings.some(f => f.check === "claimed-persisted-but-isnt") ? fired : dead).push("claimed-persisted-but-isnt");

  // 3. a loader that nothing calls must be caught
  const canaryUncalled = "let tvAlerts = [];\nfunction loadAlerts() {}\nfunction saveAlerts() {}\nsaveAlerts();\n";
  const r3 = audit(canaryUncalled);
  (r3.findings.some(f => f.check === "loader-never-called") ? fired : dead).push("loader-never-called");

  // 4. a saver that nothing calls must be caught
  const canaryNoSave = "let tvAlerts = [];\nfunction loadAlerts() {}\nfunction saveAlerts() {}\nloadAlerts();\n";
  const r4 = audit(canaryNoSave);
  (r4.findings.some(f => f.check === "saver-never-called") ? fired : dead).push("saver-never-called");

  // 5. the parser must not count a `let` inside a function body as module state
  const canaryNested = "function f() {\n  let notModuleState = 1;\n}\n";
  const r5 = audit(canaryNested);
  (r5.state.length === 0 ? fired : dead).push("ignores function-local let");

  // 6. and it must still FIND real module-level state
  const r6 = audit("let priceCache = {};\n");
  (r6.state.length === 1 ? fired : dead).push("finds module-level let");

  return { allChecksFire: dead.length === 0, fired, dead };
}

const test = selfTest();
if (SELFTEST_ONLY) {
  if (!QUIET) {
    console.log("[durable-state] self-test: "
      + (test.allChecksFire ? "all " + test.fired.length + " checks fire" : "FAILED: " + test.dead.join(", ")));
  }
  process.exit(0);
}

let report;
try {
  const src = fs.readFileSync(SRC_FILE, "utf8");
  const r = audit(src);
  const byClass = {};
  r.rows.forEach(x => { byClass[x.klass] = (byClass[x.klass] || 0) + 1; });
  report = {
    generatedAt: new Date().toISOString(),
    box: os.hostname(),
    available: true,
    source: path.relative(ROOT, SRC_FILE),
    stateFound: r.state.length,
    byClass,
    red: r.findings.filter(f => f.level === "RED").length,
    amber: r.findings.filter(f => f.level === "AMBER").length,
    totalFindings: r.findings.length,
    findings: r.findings,
    state: r.rows,
    selfTest: test,
    note: "Every module-level binding in the server must be classified: persisted "
        + "(verified, not claimed), regenerable (says from where), or accepted (a "
        + "decision on record). Unclassified state is the finding. PROPOSES ONLY.",
    feedsTheGate: false,
  };
} catch (e) {
  report = { generatedAt: new Date().toISOString(), box: os.hostname(), available: false,
             reason: "audit failed: " + e.message, selfTest: test, feedsTheGate: false };
}

try { fs.writeFileSync(OUT, JSON.stringify(report, null, 2)); }
catch (e) { if (!QUIET) console.error("[durable-state] could not write: " + e.message); }

if (AS_JSON) {
  console.log(JSON.stringify(report, null, 2));
} else if (!QUIET) {
  if (!report.available) {
    console.log("[durable-state] UNAVAILABLE — " + report.reason);
  } else {
    const b = report.byClass;
    console.log("[durable-state] " + report.stateFound + " module-level binding(s): "
      + (b.persisted || 0) + " persisted, " + (b.regenerable || 0) + " regenerable, "
      + (b.accepted || 0) + " accepted, " + (b.UNCLASSIFIED || 0) + " unclassified"
      + (test.allChecksFire ? "  [all " + test.fired.length + " checks verified]"
                            : "  [SELF-TEST FAILED: " + test.dead.join(", ") + "]"));
    for (const f of report.findings) {
      console.log("      " + f.level + "  " + f.name + (f.line ? ":" + f.line : "")
        + "  [" + f.check + "]  " + f.detail);
    }
  }
}

// ALWAYS 0. Knowing what a restart would cost must never fail a daily run.
process.exit(0);
