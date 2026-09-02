// CLAIMS CHECK — verify what CLAUDE.md ASSERTS against what the code and the live
// system actually DO.
//
//   node tasks/claims_check.cjs            report drift, change nothing
//   node tasks/claims_check.cjs --json     machine-readable
//
// exit 0 = every checkable claim holds
// exit 1 = at least one claim is STALE
// exit 2 = the checker itself failed (never confuse this with a clean run)
//
// WHY THIS EXISTS, AND WHY IT IS NOT THE DOCTOR
// tasks/doctor.cjs checks the CONTROL PLANE — is the server up, are bridges reporting,
// do the boxes agree. server/autohealer.js checks the DATA PLANE — is the signal fresh.
// Neither reads a single word of CLAUDE.md, and CLAUDE.md is the first thing every
// session loads. So the one input that steers every session had nothing checking it.
//
// That gap has a measured cost. Every item below was found stale on 2026-09-02 by the
// first run of this script:
//   - "The gate is 65"                 said 70 for hours after the change. The boot
//                                      file's own words: "that is the first line every
//                                      session reads".
//   - "GOLD_SQUEEZE ... index.js:3486" the constant is at :3553. Line 3486 is blank.
//   - "STRONG UPTREND (index.js:1711)" it is at :1798. Line 1711 is an ADX comment.
//   - "generateSignal :2814-2911"      generateSignal is at :1780. The MTF variant the
//                                      prose actually describes is at :2965.
//   - "h1 appears exactly TWICE"       it appears far more than twice.
//   - "GET /api/performance is the     THERE IS NO SUCH ROUTE. Only /api/fleet-performance
//      other source of truth"          and /api/checksystem exist. The same file also
//                                      says "there is no /api/performance" — it
//                                      contradicts itself, and the wrong half is the
//                                      half that tells you to go call it.
//
// A stale line number costs a minute. A stale FACT costs a session: you read "it has
// one closed fill in its whole life", conclude the thing is broken, go looking for the
// fault, and find nothing wrong — because nothing is wrong. That is the failure this
// catches.
//
// DESIGN RULE: A CHECKER THAT CRIES WOLF GETS IGNORED.
// Anything that cannot be verified right now is UNVERIFIABLE, never STALE. A server
// that is offline, a file outside this repo, a claim with no machine-readable form —
// all report as unchecked and none of them fail the run. The only way to get STALE is
// for the claim and the evidence to both be present and to disagree.
//
// SAFETY: read-only. HTTP GETs and file reads. It writes nothing, restarts nothing,
// and touches no gate, threshold, confidence value or setting. Nothing here feeds the
// signal path (rule 3).

const fs = require("fs");
const path = require("path");
const http = require("http");

const ROOT = path.join(__dirname, "..");
const CLAUDE_MD = path.join(ROOT, "CLAUDE.md");
const ENGINE = path.join(ROOT, "server", "index.js");
const AS_JSON = process.argv.includes("--json");

// A health check that hangs is its own outage.
const HTTP_TIMEOUT_MS = 3000;
const SERVER_BASE = { host: "127.0.0.1", port: 3001 };

const PASS = "PASS";
const STALE = "STALE";
const UNVERIFIABLE = "UNVERIFIABLE";

const findings = [];

function record(status, claim, expected, actual, fix) {
  findings.push({ status, claim, expected, actual, fix });
}

// ── Symbol anchors ────────────────────────────────────────────────────────────
// CLAUDE.md pins several facts to "file:line". Line numbers drift on every edit
// above them, so these rot silently and constantly. Each entry names the SYMBOL to
// search for, so the checker reports where it actually moved to rather than only
// that it moved. Add a row whenever CLAUDE.md gains a new file:line citation.
const ANCHORS = [
  {
    claim: "GOLD_SQUEEZE_MODERATE_CONFIDENCE is at server/index.js:3486",
    file: ENGINE,
    line: 3486,
    symbol: "GOLD_SQUEEZE_MODERATE_CONFIDENCE",
  },
  {
    claim: '"STRONG UPTREND" is EMA stacking at server/index.js:1711',
    file: ENGINE,
    line: 1711,
    symbol: "STRONG UPTREND",
  },
  {
    claim: "generateSignal spans server/index.js:2814-2911",
    file: ENGINE,
    line: 2814,
    symbol: "function generateSignal",
  },
];

function checkAnchors() {
  let engineLines;
  try {
    engineLines = fs.readFileSync(ENGINE, "utf8").split(/\r?\n/);
  } catch (err) {
    record(UNVERIFIABLE, "server/index.js readable", "readable",
      err.message, "check the path");
    return;
  }

  for (const anchor of ANCHORS) {
    const claimedText = engineLines[anchor.line - 1];
    if (claimedText === undefined) {
      record(STALE, anchor.claim, `line ${anchor.line} exists`,
        `file has only ${engineLines.length} lines`,
        `find ${anchor.symbol} and update CLAUDE.md`);
      continue;
    }

    if (claimedText.includes(anchor.symbol)) {
      record(PASS, anchor.claim, anchor.symbol, `found at :${anchor.line}`, null);
      continue;
    }

    // Report where it actually lives, so the fix is a copy-paste rather than a hunt.
    const realLines = [];
    for (let i = 0; i < engineLines.length; i++) {
      if (engineLines[i].includes(anchor.symbol)) realLines.push(i + 1);
      if (realLines.length >= 4) break;
    }

    record(
      STALE,
      anchor.claim,
      `${anchor.symbol} at :${anchor.line}`,
      realLines.length
        ? `line ${anchor.line} is "${claimedText.trim().slice(0, 60) || "(blank)"}"; symbol is at :${realLines.join(", :")}`
        : `symbol not found anywhere in the file`,
      realLines.length
        ? `update CLAUDE.md to :${realLines[0]}`
        : `the symbol is gone — the claim may describe removed code`
    );
  }
}

// ── Route claims ──────────────────────────────────────────────────────────────
// Every /api/... path CLAUDE.md names should be a route the server registers.
// This is the check that catches an instruction to call an endpoint that 404s —
// the most expensive kind of stale claim, because you follow it before doubting it.

// Paths that appear in CLAUDE.md as prose ABOUT a non-existent route rather than as
// an instruction to call one. Without this the checker flags the very sentence that
// documents the absence, which would train you to ignore it.
const ROUTE_CLAIM_EXCEPTIONS = new Set();

function extractRoutesFromDoc(docText) {
  const found = new Set();
  const re = /\/api\/[A-Za-z0-9_\-/]+/g;
  let m;
  while ((m = re.exec(docText)) !== null) {
    // Strip a trailing query string or punctuation that rode along from the prose.
    const clean = m[0].replace(/[?.,)`'"]+$/, "");
    found.add(clean);
  }
  return [...found].sort();
}

function extractRegisteredRoutes(engineText) {
  const found = new Set();
  const re = /app\.(?:get|post|put|patch|delete)\(\s*["'`](\/[^"'`]+)["'`]/g;
  let m;
  while ((m = re.exec(engineText)) !== null) found.add(m[1]);
  return found;
}

function checkRoutes(docText) {
  let engineText;
  try {
    engineText = fs.readFileSync(ENGINE, "utf8");
  } catch {
    record(UNVERIFIABLE, "route registrations readable", "server/index.js",
      "unreadable", "check the path");
    return;
  }

  const registered = extractRegisteredRoutes(engineText);
  if (registered.size === 0) {
    // Never report every route as missing because the parser broke.
    record(UNVERIFIABLE, "route extraction", "at least one app.get(...)",
      "parsed zero routes — the registration pattern likely changed",
      "update extractRegisteredRoutes()");
    return;
  }

  for (const route of extractRoutesFromDoc(docText)) {
    if (ROUTE_CLAIM_EXCEPTIONS.has(route)) continue;

    if (registered.has(route)) {
      record(PASS, `route ${route} exists`, "registered", "registered", null);
      continue;
    }

    // A near-miss is the usual truth: the route was renamed, not deleted.
    const near = [...registered].filter(
      (r) => r.includes(route.split("/").pop()) || route.includes(r.split("/").pop())
    );

    record(
      STALE,
      `CLAUDE.md references ${route}`,
      "a registered route",
      near.length ? `no such route; closest is ${near.slice(0, 2).join(", ")}` : "no such route",
      near.length
        ? `rename the reference to ${near[0]}, or drop it`
        : `remove the reference — nothing serves it`
    );
  }
}

// ── File claims ───────────────────────────────────────────────────────────────
// CLAUDE.md names repo files as if they exist. A missing CODE file is either a typo
// or a description of something deleted, and both send a session looking for nothing.
//
// DATA files are the opposite case and must not be flagged. tasks/jarvis-state.json,
// learning.json, the .jsonl ledgers — these are WRITTEN AT RUNTIME (jarvis-state.json
// by tasks/hooks/session-stop.ps1) and are absent on a fresh clone by design. The
// first version of this function reported that as STALE, which is precisely the
// false positive that gets a checker ignored. Extension decides: code must exist,
// data is unverifiable until the system has run.
const DATA_EXTENSIONS = new Set(["json", "jsonl"]);

function checkFiles(docText) {
  const re = /\b(?:server|tasks|dashboard)\/[A-Za-z0-9_\-./]+\.(js|cjs|py|json|jsonl|md|ps1|bat)\b/g;
  const seen = new Map();
  let m;
  while ((m = re.exec(docText)) !== null) seen.set(m[0], m[1]);

  for (const rel of [...seen.keys()].sort()) {
    const abs = path.join(ROOT, rel);
    const isData = DATA_EXTENSIONS.has(seen.get(rel));

    if (fs.existsSync(abs)) {
      record(PASS, `file ${rel} exists`, "present", "present", null);
    } else if (isData) {
      record(UNVERIFIABLE, `CLAUDE.md names ${rel}`, "runtime data file",
        "not present — written when the system runs, absent on a fresh clone",
        null);
    } else {
      record(STALE, `CLAUDE.md names ${rel}`, "file present", "not found",
        `create it, correct the path, or remove the reference`);
    }
  }
}

// ── Forbidden strings ─────────────────────────────────────────────────────────
// CLAUDE.md carries explicit "do not reintroduce X" decisions. A decision with no
// enforcement is a comment, so each one gets a check.
const FORBIDDEN = [
  {
    needle: "claude-opus-4-8",
    claim: 'CLAUDE.md: "Do not reintroduce claude-opus-4-8"',
    where: ENGINE,
  },
];

function checkForbidden() {
  for (const rule of FORBIDDEN) {
    let text;
    try {
      text = fs.readFileSync(rule.where, "utf8");
    } catch {
      record(UNVERIFIABLE, rule.claim, "file readable", "unreadable", null);
      continue;
    }
    const count = text.split(rule.needle).length - 1;
    if (count === 0) {
      record(PASS, rule.claim, "0 occurrences", "0 occurrences", null);
    } else {
      record(STALE, rule.claim, "0 occurrences", `${count} occurrence(s)`,
        `remove ${rule.needle} from ${path.relative(ROOT, rule.where)}`);
    }
  }
}

// ── Live config claims ────────────────────────────────────────────────────────
// The gate is the single most load-bearing number in the file and the one that has
// gone stale most expensively. It is read live and never hardcoded here — a checker
// carrying its own copy of the value would be the very bug it exists to catch.
function httpGetJson(pathname) {
  return new Promise((resolve) => {
    const req = http.get(
      { ...SERVER_BASE, path: pathname, timeout: HTTP_TIMEOUT_MS },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          if (res.statusCode !== 200) return resolve({ error: `HTTP ${res.statusCode}` });
          try {
            resolve({ data: JSON.parse(body) });
          } catch {
            resolve({ error: "unparseable JSON" });
          }
        });
      }
    );
    req.on("timeout", () => { req.destroy(); resolve({ error: "timeout" }); });
    req.on("error", (e) => resolve({ error: e.code || e.message }));
  });
}

function documentedGate(docText) {
  // Matches the boot file's own phrasing: "**The gate is 65.**"
  const m = docText.match(/\bThe gate is\s+(\d{2})\b/);
  return m ? Number(m[1]) : null;
}

async function checkLiveGate(docText) {
  const claimed = documentedGate(docText);
  if (claimed === null) {
    record(UNVERIFIABLE, "documented gate value", "a 'The gate is NN' line",
      "no such line found in CLAUDE.md", null);
    return;
  }

  const { data, error } = await httpGetJson("/api/strategy-settings");
  if (error) {
    // Server offline is not a stale claim. Say so plainly and pass.
    record(UNVERIFIABLE, `CLAUDE.md says the gate is ${claimed}`,
      "live confidenceThreshold", `server unreachable (${error})`,
      "start the server and re-run to verify this one");
    return;
  }

  if (data && data.settingsError) {
    record(UNVERIFIABLE, `CLAUDE.md says the gate is ${claimed}`,
      "saved config", `settingsError is set — server is on BUILT-IN DEFAULTS`,
      "resolve settingsError first; the running gate is not the saved gate");
    return;
  }

  const live = data && data.confidenceThreshold;
  if (typeof live !== "number") {
    record(UNVERIFIABLE, `CLAUDE.md says the gate is ${claimed}`,
      "numeric confidenceThreshold", `got ${JSON.stringify(live)}`, null);
    return;
  }

  if (live === claimed) {
    record(PASS, `CLAUDE.md says the gate is ${claimed}`, live, live, null);
  } else {
    record(STALE, `CLAUDE.md says the gate is ${claimed}`, `live gate ${live}`,
      `CLAUDE.md says ${claimed}`,
      `update CLAUDE.md to ${live} — every session reads that line first`);
  }
}

// ── Report ────────────────────────────────────────────────────────────────────
function report() {
  const stale = findings.filter((f) => f.status === STALE);
  const unver = findings.filter((f) => f.status === UNVERIFIABLE);
  const pass = findings.filter((f) => f.status === PASS);

  if (AS_JSON) {
    console.log(JSON.stringify({
      verdict: stale.length ? "CLAIMS STALE" : "CLAIMS HOLD",
      counts: { stale: stale.length, unverifiable: unver.length, pass: pass.length },
      findings,
    }, null, 2));
    return stale.length ? 1 : 0;
  }

  console.log("\n=== CLAUDE.md CLAIMS CHECK ===\n");

  if (stale.length) {
    console.log(`STALE (${stale.length}) — the file asserts something the code denies:\n`);
    for (const f of stale) {
      console.log(`  ✗ ${f.claim}`);
      console.log(`      expected: ${f.expected}`);
      console.log(`      actual:   ${f.actual}`);
      if (f.fix) console.log(`      fix:      ${f.fix}`);
      console.log("");
    }
  }

  if (unver.length) {
    console.log(`UNVERIFIABLE (${unver.length}) — not checkable right now, NOT a failure:\n`);
    for (const f of unver) console.log(`  ? ${f.claim} — ${f.actual}`);
    console.log("");
  }

  console.log(`PASS: ${pass.length} claim(s) verified.\n`);

  if (stale.length) {
    console.log("VERDICT: CLAIMS STALE.");
    console.log("CLAUDE.md is the first thing every session reads. A wrong fact there");
    console.log("does not cost a minute — it sets the agenda for the whole session.\n");
    return 1;
  }
  console.log("VERDICT: CLAIMS HOLD — every checkable assertion matches reality.\n");
  return 0;
}

async function main() {
  let docText;
  try {
    docText = fs.readFileSync(CLAUDE_MD, "utf8");
  } catch (err) {
    console.error(`claims_check: cannot read CLAUDE.md — ${err.message}`);
    process.exit(2);
  }

  checkAnchors();
  checkRoutes(docText);
  checkFiles(docText);
  checkForbidden();
  await checkLiveGate(docText);

  process.exit(report());
}

main().catch((err) => {
  // Never let a checker crash look like a clean run.
  console.error(`claims_check: FAILED to complete — ${err && err.stack ? err.stack : err}`);
  process.exit(2);
});
