'use strict';
/**
 * One-shot patch: add the /api/go-live-readiness route to a server/index.js that
 * this repo cannot simply overwrite.
 *
 * WHY A SCRIPT AND NOT AN scp. The VPS copy of server/index.js is ~5KB LARGER than
 * the laptop's and carries commits this repo has never seen. Copying the file over
 * would silently delete whatever those commits added. So the two blocks are spliced
 * onto anchors taken from the TARGET's own text, and the script refuses to do
 * anything at all if either anchor is not found exactly once.
 *
 * It is idempotent: a file that already carries the route is left untouched. It
 * backs up before writing, verifies the backup landed, and if `node --check` fails
 * on the result it restores the original and exits non-zero. Nothing is deleted.
 *
 * Usage:  node tasks/patch_golive_route.cjs [--file <path>] [--dry-run]
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const fileArg = args.indexOf("--file");
const target = fileArg >= 0
  ? path.resolve(args[fileArg + 1])
  : path.join(__dirname, "..", "server", "index.js");

const ROUTE_MARKER = "/api/go-live-readiness";

// The comment explaining why the readiness module is NOT required at module scope.
// Anchored on the require line immediately above where it belongs.
const ANCHOR_REQUIRE = 'const rejectionEvidence = require("./rejection_evidence");\n';
const BLOCK_REQUIRE = [
  "// Deliberately required lazily inside the handler instead of here: it pulls in",
  "// tasks/doctor.cjs and tasks/sizing_trigger.cjs, and sizing_trigger READS THIS FILE",
  "// off disk at call time to extract realizedRFromPrices. Requiring it at module load",
  "// would run that extraction against a half-evaluated index.js during boot.",
  "",
].join("\n");

// The whole rejection-evidence handler is the insertion point. Matching the entire
// handler rather than just its first line means a target whose handler has drifted
// fails the assertion instead of taking the splice in the wrong place.
const ANCHOR_ROUTE = [
  'app.get("/api/rejection-evidence", (_, res) => {',
  "  try {",
  "    res.json(rejectionEvidence.buildEvidence());",
  "  } catch (e) {",
  '    console.error("[rejection-evidence]", e.message);',
  "    res.status(500).json({ available: false, reason: e.message, gates: {}, setups: {} });",
  "  }",
  "});",
  "",
].join("\n");

const BLOCK_ROUTE = [
  "",
  "// Is this system ready for real money? Five gates, AND-ed. See",
  "// tasks/go_live_readiness.cjs for what each one means and why none of them is",
  "// weighted against the others.",
  "//",
  "// SESSION-GATED ON PURPOSE, and it is the one evidence surface that is. The",
  "// aggregate numbers are no more revealing than /api/journal, which is public -",
  "// but the UPTIME gate carries the doctor's verbatim finding, and that names which",
  "// components were down and for how long. That is an operational detail about the",
  "// machine rather than a fact about the trading record, so it stays behind the",
  "// login, consistent with the standing decision to keep this stack gated until it",
  "// is stable.",
  "//",
  "// Cached, and single-flighted. tasks/doctor.cjs accumulates its findings in a",
  "// MODULE-LEVEL array that callers reset before use, so two overlapping requests",
  "// would interleave into each other's results and report a mix of the two. The",
  "// in-flight promise makes concurrent callers share one run rather than race it.",
  "let goLiveCache = { at: 0, payload: null };",
  "let goLiveInFlight = null;",
  "const GO_LIVE_TTL_MS = 60_000;",
  "",
  'app.get("/api/go-live-readiness", async (_, res) => {',
  "  try {",
  "    if (goLiveCache.payload && Date.now() - goLiveCache.at < GO_LIVE_TTL_MS) {",
  "      return res.json(goLiveCache.payload);",
  "    }",
  "    if (!goLiveInFlight) {",
  "      goLiveInFlight = (async () => {",
  "        // Required here, not at module scope - see the note by the",
  "        // rejection_evidence require for why.",
  '        const readiness = require("../tasks/go_live_readiness.cjs");',
  "        const payload = readiness.assess();",
  "        goLiveCache = { at: Date.now(), payload };",
  "        return payload;",
  "      })().finally(() => { goLiveInFlight = null; });",
  "    }",
  "    res.json(await goLiveInFlight);",
  "  } catch (e) {",
  '    console.error("[go-live-readiness]", e.message);',
  '    // available:false rather than a bare 500, so the page can say "could not',
  '    // measure" instead of rendering an empty checklist that reads as "all clear".',
  "    res.status(500).json({ available: false, reason: e.message, ready: false, gates: [] });",
  "  }",
  "});",
  "",
].join("\n");

function countOf(haystack, needle) {
  let found = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return found;
    found++;
    from = at + needle.length;
  }
}

function refuse(message) {
  console.error("REFUSED: " + message);
  process.exit(2);
}

if (!fs.existsSync(target)) refuse("no such file: " + target);

const original = fs.readFileSync(target, "utf8");

// The target may be CRLF. Anchors and blocks are authored LF, so convert them to
// whatever the file already uses rather than rewriting the file's line endings — a
// wholesale EOL change would show up as a full-file diff in every parity check.
const isCrlf = countOf(original, "\r\n") > 0;
const toEol = (text) => (isCrlf ? text.replace(/\n/g, "\r\n") : text);

if (original.includes(ROUTE_MARKER)) {
  console.log("ALREADY PATCHED: " + target + " carries " + ROUTE_MARKER + " — nothing to do.");
  process.exit(0);
}

const anchorRequire = toEol(ANCHOR_REQUIRE);
const anchorRoute = toEol(ANCHOR_ROUTE);

const requireHits = countOf(original, anchorRequire);
const routeHits = countOf(original, anchorRoute);
if (requireHits !== 1) refuse("require anchor found " + requireHits + " times, expected exactly 1");
if (routeHits !== 1) refuse("rejection-evidence handler anchor found " + routeHits + " times, expected exactly 1");

// Literal splices at the two anchor offsets. String.replace treats $' and $& in the
// REPLACEMENT as specials and this project has already lost a file to that, so the
// insert is done by slicing rather than by replace.
function spliceAfter(text, anchor, block) {
  const at = text.indexOf(anchor);
  const end = at + anchor.length;
  return text.slice(0, end) + block + text.slice(end);
}

let patched = spliceAfter(original, anchorRequire, toEol(BLOCK_REQUIRE));
patched = spliceAfter(patched, anchorRoute, toEol(BLOCK_ROUTE));

console.log("target      : " + target);
console.log("line endings: " + (isCrlf ? "CRLF" : "LF"));
console.log("size        : " + original.length + " -> " + patched.length
  + " (+" + (patched.length - original.length) + ")");

if (dryRun) {
  console.log("DRY RUN — nothing written.");
  process.exit(0);
}

// Backup first, and prove it landed before the original is touched.
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup = target + ".bak-golive-" + stamp;
fs.writeFileSync(backup, original, "utf8");
if (!fs.existsSync(backup) || fs.readFileSync(backup, "utf8") !== original) {
  refuse("backup did not verify: " + backup);
}
console.log("backup      : " + backup);

fs.writeFileSync(target, patched, "utf8");

try {
  execFileSync(process.execPath, ["--check", target], { stdio: "pipe" });
  console.log("node --check: OK");
} catch (e) {
  fs.writeFileSync(target, original, "utf8");
  console.error(String((e && e.stderr) || (e && e.message) || e));
  refuse("node --check failed on the patched file — original restored, backup kept at " + backup);
}

console.log("PATCHED. The route is on disk; it is not serving until the server restarts.");
