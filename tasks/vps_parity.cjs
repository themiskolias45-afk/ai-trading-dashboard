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
  // ai_work_ledger.js requires this one. A required module that drifts or is missing
  // on one box takes that box's server down at boot, which is how server/rejection_log.js
  // killed the VPS on deploy — so it is tracked beside its caller, not left implicit.
  "server/proposal_citations.js",
  "server/evidence_register.js", "server/ai_registry.js", "server/mcp_server.js",
  // Required at index.js:117 for the near-miss census. Same reason as
  // proposal_citations.js above: a required module that drifts is invisible until the
  // box it drifted on behaves differently, and this one decides whether a setup that
  // missed by 0.7 RSI gets counted at all.
  "server/near_miss.js",
  "mt5_bridge.py",
  "dashboard/index.html", "dashboard/jarvis.html",
  "dashboard/plan.html", "dashboard/system.html",
  // The other four pages, added 2026-08-17. Only the first four were listed, and on that
  // day a scripted CSS edit mojibaked SIX pages and deployed them — command.html,
  // daily-plan.html and performance.html were among the damaged and none of the three was
  // being compared, so a repair applied to one box only would have read as ENGINES AGREE.
  // login.html is listed because it is the only page reachable without a session, which
  // makes it the one page a stranger sees.
  "dashboard/command.html", "dashboard/daily-plan.html",
  "dashboard/performance.html", "dashboard/login.html",
  // The doctor and the scanner it requires. doctor.cjs is the tool whose whole purpose is
  // reporting on BOTH boxes, so a version of it that differs between them is self-
  // defeating; and encoding_check.cjs is a hard require of it, which by the
  // proposal_citations.js rule above means missing-on-one-box takes that box's doctor out
  // entirely rather than degrading it.
  "tasks/doctor.cjs", "tasks/encoding_check.cjs",
  // The suite that proves the doctor's 39 branches actually fire. Tracked because a box
  // where it has drifted or gone missing cannot verify its own doctor, and an unverifiable
  // health tool is the thing this whole list exists to prevent.
  "tasks/doctor_selftest.cjs",
  // The 21:30 post-close job, which regenerates every measurement artifact the morning plan
  // reads and now also runs the self-test. It was never compared, despite being the job whose
  // steps failed nightly from 2026-08-13 without recording a cause - a difference here means
  // the two boxes refresh different evidence, silently.
  "tasks/postclose_analysis.ps1",
  // The TradingView drawer and its installer. Tracked NOT because the VPS runs them - it
  // has no TradingView session and tv_daily_plan.ps1 would refuse on every run - but
  // because they are the only record of WHEN the charts are drawn and why those two times
  // were chosen. A copy that silently drifted or vanished would leave no trace, which is
  // exactly how the drawer came to be scheduled nowhere in the first place.
  "tasks/tv_daily_plan.ps1", "tasks/install_tv_daily_plan.ps1",
  // The job scripts. Omitting these is how the two boxes' schedulers drifted apart
  // unnoticed: the VPS runs auto_weekly_vps.bat, which lacked the completion marker
  // its laptop twin has had since 2026-08-09, so every VPS weekly reported
  // unconfirmable completion while the scheduler recorded success. A file nothing
  // compares is a file that diverges. The _vps variants are listed BECAUSE they are
  // per-machine — MISSING on the laptop is expected and reads as such.
  "tasks/auto_weekly.bat", "tasks/auto_daily.bat", "tasks/drain_agents.bat",
  "tasks/auto_weekly_vps.bat", "tasks/auto_daily_vps.bat",
  "tasks/vps_monitor.ps1", "tasks/vps_parity.cjs",
  // The rejection ledger's middle two stages. The pipeline is write -> score -> shadow
  // -> verdict, and only the first and last were listed: rejection_log.js and
  // rejection_evidence.js were compared while the two scripts that turn rows into
  // evidence were not. That is how a broker-clock bug in the scorer sat on both boxes
  // unseen while parity reported ENGINES AGREE. Both came back identical on the first
  // widened run — learning_from_rejections.py differs by RAW hash and matches once line
  // endings are normalised, which is exactly why norm() exists and why a raw
  // Get-FileHash comparison across the two boxes is not evidence of drift. Per this
  // file's own rule: a file nothing compares is a file that diverges.
  "tasks/score_rr_rejections.py", "tasks/learning_from_rejections.py",
  // The pre-open plan and its caller, for the same reason: both are job scripts that run
  // on both boxes and neither was compared. deep_plan.cjs is where the 2026-08-16 EPERM
  // surfaced and preopen_plan.cjs is where it was thrown, so a diagnosis deployed to one
  // box and not the other would leave the box that trades still reporting a bare errno.
  "tasks/deep_plan.cjs", "tasks/preopen_plan.cjs",
  // What every agent is TOLD before it works. If this drifts, the two boxes' agents are
  // briefed differently from the same evidence register — and section 4 of it instructs
  // the reader not to re-litigate what it lists, so a difference here decides what an
  // agent is allowed to question.
  "tasks/ai_brief.cjs",
  // live_vs_replay.js is REQUIRED by index.js at boot (its catch there falls back to an
  // "not deployed on this box" stub, which is a softer failure than rejection_log.js once
  // caused but still means one box silently loses the tracker). time_heatmap.cjs is the
  // measurement whose output the pre-open plan quotes. Both were untracked while the
  // memory note still claimed the tracker was VPS-absent — it has been there since at
  // least 2026-08-17 and nothing was comparing them.
  "server/live_vs_replay.js", "tasks/time_heatmap.cjs",
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
