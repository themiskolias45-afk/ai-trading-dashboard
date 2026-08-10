'use strict';
/**
 * Do the two boxes actually run the same trading engine?
 *
 * Nothing has ever answered this. On 2026-08-09 alone the VPS needed SEVEN
 * hand-written surgical patches to server/index.js and accumulated NINE
 * index.js.bak-* files, because its git history carries commits this repo has
 * never seen (HEAD ba1077b does not exist locally) and a wholesale copy would
 * destroy them. Every patch is a place the two engines can silently diverge, and
 * when they do, the learning data is a blend of two systems and no result is
 * attributable to either.
 *
 * WHY NOT A FILE HASH. index.js will never hash-match: the VPS is CRLF, the
 * laptop is LF, and the boxes legitimately differ in per-machine config. A hash
 * says "different" every time and teaches you to ignore it. This compares the
 * ENGINE FUNCTIONS — the ones that decide whether a trade happens — after
 * normalising line endings, so the answer means something.
 *
 * The same probe runs on both sides, so the methodology cannot differ between
 * them. That is the whole reason it is one file rather than two.
 *
 * READ-ONLY on both boxes by default. Opens files, hashes them, prints. Restarts
 * nothing, changes no setting. The one exception is opt-in: --emit additionally
 * writes the verdict to tasks/logs/vps_parity_last.json so /api/system-plan can
 * show it on the Systems Plan page. Without that flag it still writes nothing —
 * the write is opt-in precisely so this tool's read-only promise stays true for
 * anyone who runs it the way the line above describes.
 *
 * Usage:
 *   node tasks/vps_parity.cjs                 compare this box against the VPS
 *   node tasks/vps_parity.cjs --emit          ...and record the verdict for the page
 *   node tasks/vps_parity.cjs --probe         emit this box's fingerprint as JSON
 *   node tasks/vps_parity.cjs --host H --key K --user U
 */

const fs   = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");

function opt(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const HOST = opt("--host", "169.58.74.133");
const USER = opt("--user", "administrator");
const KEY  = opt("--key",  "C:\\Users\\User\\.ssh\\contabo_smartentry");
const REMOTE_ROOT = opt("--remote-root", "C:\\ai-trading-dashboard");

// Files whose content decides behaviour. strategy_settings.json is deliberately
// absent: it is per-machine and untracked BY DESIGN, so flagging it would train
// you to ignore the report.
const TRACKED = [
  "server/index.js", "server/sizing.js", "server/hermes.js", "server/cohort_table.js",
  "server/fvg.js", "server/structure.js", "server/rejection_log.js",
  "server/rejection_evidence.js", "server/learning_growth.js", "server/ai_work_ledger.js",
  "server/evidence_register.js", "server/ai_registry.js", "server/mcp_server.js",
  "mt5_bridge.py",
  "dashboard/index.html", "dashboard/jarvis.html",
];

// The functions that decide whether a trade happens. If these agree, the two
// boxes will produce the same signal from the same bars — which is the question
// this tool exists to answer.
const ENGINE_FNS = [
  "function generateSignal(", "function generateSignalMTF(",
  "function emaSeries", "function calcRSI", "function calcBB", "function calcMACD",
  "function atr(", "function calcADX", "function calcPivots",
  "function findSwingLow", "function findSwingHigh",
];

// Scalars that silently change behaviour if they drift.
const SCALARS = [
  "SIZING_BOOST_MIN_CONFIDENCE", "STRUCTURAL_STOP_MIN_ATR",
  "GOLD_SQUEEZE_MODERATE_CONFIDENCE", "EMA_SMA_SEED_MIN_MULTIPLE",
  "DAILY_RANGE_DEFAULT", "MT5_MIN_BARS", "JSON_BODY_LIMIT",
];

// Normalise line endings AND trailing whitespace before hashing. Otherwise every
// file differs and the report is noise.
const norm = s => s.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "");
const sha  = s => crypto.createHash("sha256").update(norm(s), "utf8").digest("hex").slice(0, 16);

/** Brace-match a function body out of source, the same way the replay does. */
function extractBlock(src, marker) {
  const start = src.indexOf(marker);
  if (start === -1) return null;
  const open = src.indexOf("{", start);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

function probe(root) {
  const out = { files: {}, engine: {}, scalars: {}, routes: [] };
  for (const rel of TRACKED) {
    try {
      out.files[rel] = sha(fs.readFileSync(path.join(root, rel), "utf8"));
    } catch (e) { out.files[rel] = "MISSING"; }
  }
  let index = "";
  try { index = fs.readFileSync(path.join(root, "server", "index.js"), "utf8"); } catch (e) {}
  for (const marker of ENGINE_FNS) {
    const block = extractBlock(index, marker);
    out.engine[marker] = block ? sha(block) : "MISSING";
  }
  for (const name of SCALARS) {
    const m = index.match(new RegExp("^const\\s+" + name + "\\s*=\\s*([^;]+);", "m"));
    out.scalars[name] = m ? m[1].trim() : "MISSING";
  }
  // Route surface: a route present on one box and not the other is a real split.
  out.routes = [...index.matchAll(/app\.(get|post)\("([^"]+)"/g)]
    .map(m => m[1].toUpperCase() + " " + m[2]).sort();
  return out;
}

if (process.argv.includes("--probe")) {
  process.stdout.write(JSON.stringify(probe(ROOT)));
  process.exit(0);
}

// ── compare ──────────────────────────────────────────────────────────────────
console.log("VPS PARITY — do the two boxes run the same engine?");
console.log("local " + ROOT + "   vs   " + USER + "@" + HOST + ":" + REMOTE_ROOT);
console.log("Line endings and trailing whitespace normalised; strategy_settings.json is");
console.log("excluded because it is per-machine BY DESIGN.\n");

const local = probe(ROOT);

let remote;
try {
  const psCmd = "cd " + REMOTE_ROOT + "; node tasks\\vps_parity.cjs --probe";
  const raw = execFileSync("ssh",
    ["-i", KEY, "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", USER + "@" + HOST,
     'powershell -NoProfile -Command "' + psCmd + '"'],
    { encoding: "utf8", timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  remote = JSON.parse(raw.slice(raw.indexOf("{")));
} catch (e) {
  console.error("Could not probe the VPS: " + (e.stderr || e.message || "").toString().slice(-300));
  console.error("\nIs tasks/vps_parity.cjs deployed there? scp it across and retry.");
  process.exit(1);
}

let drift = 0, engineDrift = 0;

console.log("FILES");
for (const rel of TRACKED) {
  const a = local.files[rel], b = remote.files[rel];
  if (a === b) continue;
  drift++;
  console.log("  DIFFERS  " + rel.padEnd(34) + "local " + a + "  vps " + b);
}
if (!drift) console.log("  all " + TRACKED.length + " tracked files identical");

console.log("\nENGINE FUNCTIONS  (these decide whether a trade happens)");
for (const marker of ENGINE_FNS) {
  const a = local.engine[marker], b = remote.engine[marker];
  if (a === b) continue;
  engineDrift++;
  console.log("  DIFFERS  " + marker.replace("function ", "").replace("(", "").padEnd(22)
    + "local " + a + "  vps " + b);
}
if (!engineDrift) console.log("  all " + ENGINE_FNS.length + " engine functions identical");

console.log("\nBEHAVIOURAL CONSTANTS");
let scalarDrift = 0;
for (const name of SCALARS) {
  const a = local.scalars[name], b = remote.scalars[name];
  if (a === b) continue;
  scalarDrift++;
  console.log("  DIFFERS  " + name.padEnd(34) + "local " + a + "   vps " + b);
}
if (!scalarDrift) console.log("  all " + SCALARS.length + " constants identical");

const onlyLocal  = local.routes.filter(r => !remote.routes.includes(r));
const onlyRemote = remote.routes.filter(r => !local.routes.includes(r));
console.log("\nROUTES  (local " + local.routes.length + ", vps " + remote.routes.length + ")");
if (!onlyLocal.length && !onlyRemote.length) console.log("  identical route surface");
onlyLocal.forEach(r  => console.log("  LOCAL ONLY  " + r));
onlyRemote.forEach(r => console.log("  VPS ONLY    " + r));

const agree = !engineDrift && !scalarDrift;

console.log("\nVERDICT");
if (agree) {
  console.log("  ENGINES AGREE — same signal from the same bars.");
  if (drift) console.log("  " + drift + " non-engine file(s) differ (dashboards, tooling). Cosmetic or pending deploy.");
} else {
  console.log("  ENGINES DIVERGE — " + engineDrift + " function(s) and " + scalarDrift
    + " constant(s) differ.");
  console.log("  The two boxes can produce DIFFERENT signals from identical bars, which makes");
  console.log("  the combined journal and learning data unattributable. Reconcile before");
  console.log("  drawing any conclusion that pools both boxes.");
}

// Opt-in only. An answer that lives solely in a terminal is an answer nobody
// re-reads: this is what puts the verdict on /plan, with its own age attached so a
// stale check cannot pass itself off as a current one.
if (process.argv.includes("--emit")) {
  const outPath = path.join(ROOT, "tasks", "logs", "vps_parity_last.json");
  const record = {
    ranAt: new Date().toISOString(),
    host: HOST,
    engineDrift, scalarDrift, fileDrift: drift,
    routesOnlyLocal: onlyLocal,
    routesOnlyRemote: onlyRemote,
    verdict: agree ? "ENGINES AGREE" : "ENGINES DIVERGE",
  };
  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(record, null, 2), "utf8");
    console.log("\n  recorded -> " + outPath);
  } catch (e) {
    console.error("\n  could not record verdict: " + e.message);
  }
}

process.exit(engineDrift || scalarDrift ? 2 : 0);
