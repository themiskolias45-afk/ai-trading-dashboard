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
  // A hard require of doctor.cjs, by the same rule: missing or drifted on one box takes
  // checkSizingTrigger out on that box, and the branch that would go silent is the one
  // watching the largest lever on returns in the system. It also EXTRACTS
  // realizedRFromPrices from server/index.js at run time, so a drifted copy here would
  // score Gold's record by a definition the server no longer uses.
  "tasks/sizing_trigger.cjs",
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
  // ADDED 2026-09-03. The four booleans and the list that decide WHICH SETUPS EXIST.
  // ENGINE_FNS already diffs the BODY of generateSignal, so it catches the condition at
  // :2330 — but these live at module scope OUTSIDE that body and were invisible here.
  //
  // The hazard is specific and this repo has already been bitten by its twin. The VPS is
  // HAND-PATCHED, not copied. Patch the condition across without the const and
  // generateSignal throws ReferenceError on every MOMENTUM-eligible bar, the caller
  // swallows it, SP500 reads WAIT forever — and this script prints ENGINES AGREE, exactly
  // the shape of 8a2a652 where parity compared route PATHS while a handler was 500ing.
  "MOMENTUM_MACD_EXEMPT_TICKERS", "MOMENTUM_REQUIRE_MACD_BULLISH",
  "TREND_FOLLOW_REQUIRE_MACD_BULLISH", "BUY_DIP_REQUIRE_MACD_BULLISH",
  "SELL_BOUNCE_REQUIRE_DOWNTREND",
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

// The capability surface: everything that IS a skill, an agent, an engine module or a
// tool. Deliberately not "every file" — logs, daily notes, bar archives and backups are
// expected to differ and would bury the signal.
const INVENTORY_DIRS = ["server", "tasks", ".claude/commands", ".claude/agents", "dashboard", "."];
const INVENTORY_EXT  = /\.(js|cjs|py|ps1|bat|html|css|md)$/i;
const INVENTORY_SKIP = /node_modules|[\\/]\.git[\\/]|[\\/]logs[\\/]|[\\/]daily[\\/]|[\\/]history[\\/]|[\\/]analysis[\\/]|[\\/]screenshots[\\/]|[\\/]backups?[\\/]|\.bak|[\\/]\.tmp_daily[\\/]/i;

/**
 * Every capability file present on this box, as repo-relative paths.
 *
 * WHY THIS EXISTS. TRACKED above is a HAND-MAINTAINED ALLOWLIST of 46 entries, and this
 * tool compared nothing else — so "0 files differ" only ever meant "0 of the 46 I was
 * told to look at". Measured 2026-08-28: of 278 capability files in the repo, parity
 * covered 37 and was blind to 241. Twenty-three of them, including seven skills and
 * eight analysis harnesses, were ABSENT from the VPS while this printed ENGINES AGREE
 * with no files differing. A file nobody adds to the list is invisible forever, and
 * since the VPS is deployed file-by-file (its git history diverged, so it cannot pull)
 * every new file starts out missing there by default.
 *
 * Returns { relPath: contentHash } — PRESENCE AND CONTENT, both.
 *
 * A first version returned paths only, which closed exactly half the hole: it could see a
 * file that was absent but not one that was PRESENT AND DIFFERENT. Two boxes carrying the
 * same 366 filenames with different code inside would have read as identical. Hashing is
 * cheap here — the files are small and it is one local read each, carried back over the
 * probe channel that already exists.
 */
function inventory(root) {
  const found = new Set();
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (INVENTORY_SKIP.test(full)) continue;
      if (entry.isDirectory()) { walk(full, depth + 1); continue; }
      if (!INVENTORY_EXT.test(entry.name)) continue;
      found.add(path.relative(root, full).replace(/\\/g, "/"));
    }
  };
  for (const dir of INVENTORY_DIRS) {
    const base = path.join(root, dir);
    // "." is walked at depth 3 so it reaches the named dirs too; the Set dedupes.
    walk(base, dir === "." ? 3 : 0);
  }
  // Hashed with the SAME normaliser TRACKED uses, so CRLF and trailing whitespace do not
  // make every file on a Windows-to-Windows pair look different.
  const out = {};
  for (const rel of [...found].sort()) {
    try { out[rel] = sha(fs.readFileSync(path.join(root, rel), "utf8")); }
    catch (e) { out[rel] = "UNREADABLE"; }
  }
  return out;
}

function probe(root) {
  const out = { files: {}, engine: {}, scalars: {}, routes: [], inventory: inventory(root) };
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

  // ROUTE BODIES, added 2026-09-03 after the surface check passed while a route was
  // returning HTTP 500 on the VPS.
  //
  // /api/preopen-plan there carried the lines that USE `openAt` but not the two that
  // DECLARE it - a hand-applied patch that landed the usages and dropped the
  // declarations. Every call threw "ReferenceError: openAt is not defined", the panel
  // read "Pre-open plan unavailable" for hours, and this tool reported ENGINES AGREE
  // with 116/116 identical route surface the whole time. A surface is a list of PATHS,
  // and a path is still present when its handler is broken.
  //
  // Whole-file hashing cannot substitute: the two index.js files legitimately differ in
  // length - that patch applied with offsets of -6 to -42 lines - so only per-handler
  // comparison isolates it.
  out.routeBodies = {};
  for (const rm of index.matchAll(/app\.(get|post)\("([^"]+)"/g)) {
    const key = rm[1].toUpperCase() + " " + rm[2];
    const body = routeBody(index, rm.index);
    // Whitespace-normalised because indentation legitimately shifts after a patch and
    // is not a behavioural split. Comments are KEPT: a comment that disagrees across
    // boxes is precisely how a stale claim survives a deploy.
    out.routeBodies[key] = body === null
      ? "UNPARSED"
      : crypto.createHash("sha1").update(body.replace(/\s+/g, " ").trim()).digest("hex").slice(0, 12);
  }
  return out;
}

// Returns the source of one route handler by brace-matching from its opening paren.
// Skips string literals, template literals and both comment forms, so a brace inside
// any of them cannot end the body early. Returns null if the braces never balance.
//
// Character codes rather than escape literals throughout: this function is inserted by
// a patch script, and "backslash-n" written through three layers of quoting is exactly
// how a matcher like this arrives subtly wrong.
const CH_NL = 10, CH_BACKSLASH = 92;
function routeBody(src, startIdx) {
  let i = src.indexOf("(", startIdx);
  if (i < 0) return null;
  const begin = i;
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (c === "/" && n === "/") {
      i = src.indexOf(String.fromCharCode(CH_NL), i);
      if (i < 0) return null;
      continue;
    }
    if (c === "/" && n === "*") {
      i = src.indexOf("*/", i + 2);
      if (i < 0) return null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      for (i++; i < src.length; i++) {
        if (src.charCodeAt(i) === CH_BACKSLASH) { i++; continue; }
        if (src[i] === quote) break;
      }
      continue;
    }
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") {
      depth--;
      if (depth === 0) return src.slice(begin, i + 1);
      if (depth < 0) return null;
    }
  }
  return null;
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

// The NAMES, not just the count. The count alone reached /api/system-plan and from
// there the Systems Plan and Architecture pages, where it read "8 tracked file(s)
// differ" and stopped — a number nobody could act on, because the only place the
// names existed was the terminal of whoever last ran this by hand. An alarm with no
// next step trains you to skim past it, which is the one thing this file exists to
// prevent.
const filesDiffering = [], enginesDiffering = [], scalarsDiffering = [];
let drift = 0, engineDrift = 0;

console.log("FILES");
for (const rel of TRACKED) {
  const a = local.files[rel], b = remote.files[rel];
  if (a === b) continue;
  drift++;
  filesDiffering.push(rel);
  console.log("  DIFFERS  " + rel.padEnd(34) + "local " + a + "  vps " + b);
}
if (!drift) console.log("  all " + TRACKED.length + " tracked files identical");

// PRESENCE, across the whole capability surface — not the allowlist above.
// TRACKED is hand-maintained, so a file nobody adds to it is invisible here forever.
// On 2026-08-28 that hid 23 capability files, including seven skills and eight analysis
// harnesses, that were absent from the VPS while this printed no drift at all.
const localHashes  = local.inventory  || {};
const remoteHashes = remote.inventory || {};
const localInv  = new Set(Object.keys(localHashes));
const remoteInv = new Set(Object.keys(remoteHashes));
const missingOnPeer  = [...localInv].filter(f => !remoteInv.has(f)).sort();
const missingOnLocal = [...remoteInv].filter(f => !localInv.has(f)).sort();
// Present on BOTH but not the same file. This is the half a presence-only sweep misses,
// and it is the half that can silently run different code on the box that trades.
const contentDiffers = [...localInv]
  .filter(f => remoteInv.has(f) && localHashes[f] !== remoteHashes[f])
  .sort();
console.log("\nFILE PRESENCE + CONTENT  (whole capability surface, not the tracked list)");
console.log("  local " + localInv.size + " files   vps " + remoteInv.size + " files");
const showList = (label, list) => {
  if (!list.length) return;
  console.log("  " + label + " (" + list.length + "):");
  // 40 hid the tail of the very list this exists to act on — the content-differing set
  // ran to 54 and the last 14 were "... and 14 more", which is the shape of an alarm you
  // cannot follow. --full prints everything; the default still caps the VPS-side scratch
  // dirs, which are long and expected.
  const cap = process.argv.includes("--full") ? list.length : 80;
  for (const f of list.slice(0, cap)) console.log("      " + f);
  if (list.length > cap) console.log("      ... and " + (list.length - cap) + " more  (--full to list all)");
};
showList("ON LOCAL, ABSENT ON THE VPS", missingOnPeer);
showList("ON THE VPS, ABSENT LOCALLY", missingOnLocal);
showList("PRESENT ON BOTH, CONTENT DIFFERS", contentDiffers);
if (!missingOnPeer.length && !missingOnLocal.length && !contentDiffers.length) {
  console.log("  every capability file exists on both boxes and matches");
} else if (!missingOnPeer.length && !missingOnLocal.length) {
  console.log("  every capability file exists on both boxes, but " + contentDiffers.length
    + " differ in CONTENT — same name, different code");
} else {
  // Not folded into the exit code: some absences are DELIBERATE and load-bearing.
  // tasks/bridge_tags.ps1 must stay laptop-only — the VPS carries that function inline,
  // and the missing file is what stops a wholesale ensure_running.ps1 copy starting a
  // second bridge on a one-account box. Reported so it can be judged, never auto-fixed.
  console.log("  NOTE: some absences are deliberate (bridge_tags.ps1, morning_ready.ps1,");
  console.log("  deploy_vps_catchup.ps1 and the laptop-hardware scripts). Judge, do not sync blindly.");
}

console.log("\nENGINE FUNCTIONS  (these decide whether a trade happens)");
for (const marker of ENGINE_FNS) {
  const a = local.engine[marker], b = remote.engine[marker];
  if (a === b) continue;
  engineDrift++;
  enginesDiffering.push(marker.replace("function ", "").replace("(", ""));
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
  scalarsDiffering.push(name);
  console.log("  DIFFERS  " + name.padEnd(34) + "local " + a + "   vps " + b);
}
if (!scalarDrift) console.log("  all " + SCALARS.length + " constants identical");

const onlyLocal  = local.routes.filter(r => !remote.routes.includes(r));
const onlyRemote = remote.routes.filter(r => !local.routes.includes(r));
console.log("\nROUTES  (local " + local.routes.length + ", vps " + remote.routes.length + ")");
if (!onlyLocal.length && !onlyRemote.length) console.log("  identical route surface");
onlyLocal.forEach(r  => console.log("  LOCAL ONLY  " + r));
onlyRemote.forEach(r => console.log("  VPS ONLY    " + r));

// A shared route whose HANDLER differs. This is the check that was missing on
// 2026-09-02 when /api/preopen-plan returned 500 on the VPS and the surface compared
// clean. Reported separately from the verdict rather than folded into it: a handler
// split is real, but it is not necessarily an ENGINE split.
const sharedRoutes = local.routes.filter(r => remote.routes.includes(r));
const lb = local.routeBodies || null, rb = remote.routeBodies || null;
console.log("\nROUTE BODIES  (" + sharedRoutes.length + " shared route(s))");
if (!lb || !rb) {
  console.log("  peer is running an older probe with no body hashes - NOT COMPARED");
} else {
  const bodyDrift = sharedRoutes.filter(r => lb[r] !== rb[r]);
  const unparsed = sharedRoutes.filter(r => lb[r] === "UNPARSED" || rb[r] === "UNPARSED");
  if (!bodyDrift.length) {
    console.log("  all " + sharedRoutes.length + " shared handlers identical");
  } else {
    bodyDrift.forEach(r => console.log("  HANDLER DIFFERS  " + r +
      "   local " + lb[r] + "  vps " + rb[r]));
    console.log("  A route can be PRESENT on both boxes and still be BROKEN on one.");
  }
  unparsed.forEach(r => console.log("  UNPARSED, not compared  " + r));
}


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

// ── EXPERIMENT ARMS ──────────────────────────────────────────────────────────
//
// Engine parity answers "can these boxes produce different signals from the same
// bars". It does NOT answer "are they MEANT to", and those are different questions
// with opposite correct actions.
//
// Today both boxes run identical settings, so they duplicate each other: measured
// 2026-08-26, the same SP500 signal opened 12:50:17 on one and 12:51:28 on the other.
// The fleet therefore spends two accounts to produce mostly redundant observations
// while the system's own blocking constraint is sample size. Running them as champion
// and challenger fixes that - every signal becomes a PAIRED observation on identical
// bars, which removes the between-period variance that made the RSI-ceiling verdicts
// flip between fold modes on the very same trades.
//
// But a DECLARED difference and an ACCIDENTAL one look identical in a settings diff,
// and that is the trap this section exists to avoid. An undeclared split silently
// corrupts every pooled number; a declared one is the experiment working. So the arm
// is read from each box and reported in its own right, and the pooling advice follows
// from it rather than from the file comparison.
//
// Network failures degrade to UNKNOWN and never fail the parity run - this is
// reporting, not a gate, and an unreachable server is already the loudest signal
// elsewhere in this report.
async function readArm(label, url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const response = await fetch(url + "/api/strategy-settings", { signal: controller.signal });
      if (!response.ok) return { label, arm: null, note: "HTTP " + response.status };
      const body = await response.json();
      // A server predating the arm field returns undefined. That is NOT "champion" -
      // it is a box that cannot label its own trades, which is worth saying out loud.
      return { label, arm: typeof body.arm === "string" ? body.arm : null,
               note: typeof body.arm === "string" ? "" : "no arm field (server predates it)" };
    } finally { clearTimeout(timer); }
  } catch (e) {
    return { label, arm: null, note: (e.name === "AbortError" ? "timeout" : e.message).slice(0, 60) };
  }
}

// Named, not a bare IIFE, because this file ends in process.exit() and that kills the
// process before a floating promise can resolve - the first version of this section
// simply never printed. The exit is handed to it below instead.
async function reportExperimentArms() {
  const [here, peer] = await Promise.all([
    readArm("this box", "http://localhost:3001"),
    readArm("peer",     "http://" + HOST + ":3001"),
  ]);
  console.log("\nEXPERIMENT ARMS  (which CONFIG each box's trades belong to)");
  for (const box of [here, peer]) {
    console.log("  " + box.label.padEnd(10)
      + (box.arm ? box.arm : "UNKNOWN")
      + (box.note ? "   (" + box.note + ")" : ""));
  }
  if (here.arm && peer.arm) {
    if (here.arm === peer.arm) {
      console.log("  Same arm on both boxes. Their journals may be pooled, but they are NOT");
      console.log("  independent samples: identical configs on identical bars produce the SAME");
      console.log("  trades, so pooling inflates the row count without adding information.");
    } else {
      console.log("  DECLARED SPLIT - this is an experiment, not drift. Do NOT reconcile it.");
      console.log("  Never pool these journals: filter on `arm` and compare the arms instead.");
      console.log("  Rows written before 2026-08-26 carry no arm and belong to NEITHER.");
    }
  } else {
    console.log("  At least one arm is unknown, so nothing here can say whether a settings");
    console.log("  difference is intended. Treat any pooled number as unattributable.");
  }
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
    filesDiffering, enginesDiffering, scalarsDiffering,
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

// The arms section is async, so the exit belongs to it. Exiting synchronously here
// killed the process before it could print. The exit CODE is unchanged and still
// reflects engine parity only: which arm each box runs is reporting, not a gate, and
// a declared experiment must never fail this check.
// Set the code and let Node exit on its own. Calling process.exit() here tore the
// process down while fetch's socket was still closing and libuv aborted with
// "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" - exit 127, which reads as
// a parity failure when parity had in fact passed. A check that reports a false RED
// is worse than one that reports nothing.
reportExperimentArms()
  .catch(e => console.log("\nEXPERIMENT ARMS  unreadable (" + String(e.message).slice(0, 60) + ")"))
  .finally(() => { process.exitCode = engineDrift || scalarDrift ? 2 : 0; });
