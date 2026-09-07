'use strict';
/**
 * The splices that carry server/index.js changes onto a copy this repo cannot
 * overwrite.
 *
 * WHY A SCRIPT AND NOT AN scp. The VPS copy of server/index.js is ~5KB LARGER than the
 * laptop's and carries commits this repo has never seen. Copying the file over would
 * silently delete whatever those commits added. So every block is spliced onto anchors
 * taken from the TARGET's own text, and a patch refuses to do anything at all if its
 * anchor is not found exactly once.
 *
 * WHY ONE FILE AND NOT ONE PER DEPLOY. A second copy of these guards would be a second
 * chance for them to drift apart, and the guards are the entire value here. New index.js
 * blocks go in the PATCHES registry below rather than into a new file. The filename is
 * historical — the go-live route was the first patch it carried.
 *
 * Each patch is idempotent by MARKER: a file that already carries it is skipped, so
 * running this against a half-deployed box does the right thing. It backs up before
 * writing, verifies the backup landed, and if `node --check` fails on the result it
 * restores the original and exits non-zero. Nothing is ever deleted.
 *
 * Usage:
 *   node tasks/patch_golive_route.cjs                      # every patch, applied
 *   node tasks/patch_golive_route.cjs --dry-run            # decide nothing, write nothing
 *   node tasks/patch_golive_route.cjs --patch journal-r    # just one
 *   node tasks/patch_golive_route.cjs --file <path>        # target something else
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const valueOf = (flag) => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : null;
};
const target = valueOf("--file")
  ? path.resolve(valueOf("--file"))
  : path.join(__dirname, "..", "server", "index.js");
const onlyPatch = valueOf("--patch");

// ── The registry ────────────────────────────────────────────────────────────
// name    : what to pass to --patch
// marker  : proof the patch is already present. Must be a string that appears ONLY
//           once the patch has been applied.
// edits   : [{ what, anchor, block }] — `block` is spliced in immediately AFTER
//           `anchor`. Anchors are quoted from index.js verbatim and are deliberately
//           long: matching a whole handler rather than its first line means a target
//           whose handler has drifted fails the assertion instead of taking the splice
//           in the wrong place.

const PATCHES = [
  {
    name: "golive-route",
    marker: "/api/go-live-readiness",
    describe: "GET /api/go-live-readiness + the note on why it requires lazily",
    edits: [
      {
        what: "lazy-require note",
        anchor: 'const rejectionEvidence = require("./rejection_evidence");\n',
        block: [
          "// Deliberately required lazily inside the handler instead of here: it pulls in",
          "// tasks/doctor.cjs and tasks/sizing_trigger.cjs, and sizing_trigger READS THIS FILE",
          "// off disk at call time to extract realizedRFromPrices. Requiring it at module load",
          "// would run that extraction against a half-evaluated index.js during boot.",
          "",
        ].join("\n"),
      },
      {
        what: "the route itself",
        anchor: [
          'app.get("/api/rejection-evidence", (_, res) => {',
          "  try {",
          "    res.json(rejectionEvidence.buildEvidence());",
          "  } catch (e) {",
          '    console.error("[rejection-evidence]", e.message);',
          "    res.status(500).json({ available: false, reason: e.message, gates: {}, setups: {} });",
          "  }",
          "});",
          "",
        ].join("\n"),
        block: [
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
        ].join("\n"),
      },
    ],
  },
  {
    name: "journal-r",
    marker: "realizedR: trade.closePrice == null",
    describe: "realizedR on every /api/journal row, so the dashboard never re-derives R",
    edits: [
      {
        // The whole handler is replaced rather than appended to, so the anchor IS the
        // old body and the block is the new one. spliceAfter would append; this edit
        // sets `replace: true` and swaps instead.
        what: "the /api/journal handler",
        replace: true,
        anchor: [
          '// Trade journal with optional filtering',
          'app.get("/api/journal", (req, res) => {',
          "  const limit   = Math.min(parseInt(req.query.limit, 10) || 50, 500);",
          '  const symbol  = (req.query.symbol  || "").toUpperCase();',
          '  const outcome = (req.query.outcome || "").toUpperCase();',
          "  let entries = tradeJournal;",
          '  if (symbol)  entries = entries.filter(t => (t.symbol  || "").toUpperCase() === symbol);',
          '  if (outcome) entries = entries.filter(t => (t.outcome || "").toUpperCase() === outcome);',
          "  res.json({ journal: entries.slice(0, limit) });",
          "});",
        ].join("\n"),
        block: [
          "// Trade journal with optional filtering.",
          "//",
          "// Each row is served with `realizedR` alongside its P&L. Dollars are not comparable",
          "// across this journal: one XAUUSD fill was 0.14 lots and the rest are 0.01, so the",
          "// all-time dollar total is dominated by a single trade at 14x the current size and",
          "// says more about a sizing change than about the engine. R is the unit that survives",
          "// that, and the same five fills read -$416.61 and +1.51R.",
          "//",
          "// Derived here rather than in the page. realizedRFromPrices is the server's own",
          "// scorer, shared with /api/live-vs-replay and (via tasks/sizing_trigger.cjs) with the",
          "// go-live gates; a copy in JavaScript on the dashboard would be the fifth, and the",
          "// cost of the copies drifting is a page that disagrees with the readiness verdict",
          "// printed directly above it.",
          "//",
          '// null means "cannot be scored", never 0 — an unscorable trade must not average in as',
          "// a flat outcome. The rows are MAPPED, not mutated: tradeJournal is the in-memory",
          "// journal and writing a derived field onto it would leak into what gets persisted.",
          'app.get("/api/journal", (req, res) => {',
          "  const limit   = Math.min(parseInt(req.query.limit, 10) || 50, 500);",
          '  const symbol  = (req.query.symbol  || "").toUpperCase();',
          '  const outcome = (req.query.outcome || "").toUpperCase();',
          "  let entries = tradeJournal;",
          '  if (symbol)  entries = entries.filter(t => (t.symbol  || "").toUpperCase() === symbol);',
          '  if (outcome) entries = entries.filter(t => (t.outcome || "").toUpperCase() === outcome);',
          "  const journal = entries.slice(0, limit).map(trade => ({",
          "    ...trade,",
          "    realizedR: trade.closePrice == null",
          "      ? null",
          "      : realizedRFromPrices(trade.direction, trade.entry, trade.sl, trade.closePrice),",
          "  }));",
          "  res.json({ journal });",
          "});",
        ].join("\n"),
      },
    ],
  },
];

// ── Machinery ───────────────────────────────────────────────────────────────

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

// Literal splices at the anchor offset. String.replace treats $' and $& in the
// REPLACEMENT as specials and this project has already spliced a copy of a whole file
// into itself that way, so this slices rather than replaces.
function applyEdit(text, edit, toEol) {
  const anchor = toEol(edit.anchor);
  const at = text.indexOf(anchor);
  const end = at + anchor.length;
  return edit.replace
    ? text.slice(0, at) + toEol(edit.block) + text.slice(end)
    : text.slice(0, end) + toEol(edit.block) + text.slice(end);
}

if (!fs.existsSync(target)) refuse("no such file: " + target);

const original = fs.readFileSync(target, "utf8");

// The target may be CRLF. Anchors and blocks are authored LF, so convert them to
// whatever the file already uses rather than rewriting the file's line endings — a
// wholesale EOL change would show up as a full-file diff in every parity check.
const isCrlf = countOf(original, "\r\n") > 0;
const toEol = (text) => (isCrlf ? text.replace(/\n/g, "\r\n") : text);

const selected = onlyPatch ? PATCHES.filter(p => p.name === onlyPatch) : PATCHES;
if (!selected.length) {
  refuse("no patch named '" + onlyPatch + "'. Known: " + PATCHES.map(p => p.name).join(", "));
}

console.log("target      : " + target);
console.log("line endings: " + (isCrlf ? "CRLF" : "LF"));

let patched = original;
const applied = [];
for (const patch of selected) {
  if (patched.includes(patch.marker)) {
    console.log("  [skip]  " + patch.name + " — already present");
    continue;
  }
  for (const edit of patch.edits) {
    const hits = countOf(patched, toEol(edit.anchor));
    if (hits !== 1) {
      refuse(patch.name + " / " + edit.what + ": anchor found " + hits + " times, expected exactly 1");
    }
  }
  for (const edit of patch.edits) patched = applyEdit(patched, edit, toEol);
  applied.push(patch.name);
  console.log("  [apply] " + patch.name + " — " + patch.describe);
}

if (!applied.length) {
  console.log("Nothing to do — every selected patch is already present.");
  process.exit(0);
}

console.log("size        : " + original.length + " -> " + patched.length
  + " (" + (patched.length - original.length >= 0 ? "+" : "")
  + (patched.length - original.length) + ")");

if (dryRun) {
  console.log("DRY RUN — nothing written.");
  process.exit(0);
}

// Backup first, and prove it landed before the original is touched.
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup = target + ".bak-" + applied.join("+") + "-" + stamp;
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

console.log("PATCHED (" + applied.join(", ") + "). On disk; not serving until the server restarts.");
