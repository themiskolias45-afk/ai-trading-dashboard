// DUPLICATE CHECK — warn, at the moment of writing, when the thing being written
// already exists.
//
//   node tasks/duplicate_check.cjs --input <tool_input.json>   (hook use)
//   node tasks/duplicate_check.cjs --selftest                  (verify it still works)
//
// Always exits 0. This WARNS and never blocks: a false block stops good work, and
// rule 3's spirit is that no guard may suppress something legitimate. Its power is
// not authority, it is TIMING — "send_slack already exists at notifications.py:266"
// arriving as you type beats "always check what exists first" sitting in a doc.
//
// WHY THIS EXISTS
// "duplicate" appears in 67 commit messages in this repo. The clearest is 0f943e1:
// "I built a duplicate stop-variant scorer — tasks/score_stop_variants.cjs already
// existed". CLAUDE.md has carried the rule "Always check what exists first" the whole
// time, and on 2026-09-02 Claude wrote send_slack_api() into notifications.py while
// send_slack() already sat 90 lines below it — having read that rule earlier in the
// same session.
//
// That is the lesson this repo already learned once, in fb8b4f9: "The mojibake check
// only ran when I remembered it, which is how it got past me." A rule enforced by
// remembering is enforced by nothing. The mojibake stopped recurring when a check
// started running on its own. This is that, for duplicates.
//
// SAFETY: read-only. Reads the pending edit and greps the tree. Writes nothing,
// changes no setting, and cannot fail an edit.

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

// Bounded so a pre-edit hook never becomes the reason an edit feels slow.
const SEARCH_DIRS = ["server", "tasks", "."];
const SEARCH_EXT = new Set([".js", ".cjs", ".py"]);
const MAX_FILES = 400;
const MAX_SYMBOLS_CHECKED = 25;

// Suffixes a second, redundant implementation tends to carry. send_slack -> send_slack_api
// is the exact shape of the 2026-09-02 mistake.
const REDUNDANT_SUFFIXES = [
  "_api", "_v2", "_v3", "_new", "_2", "2", "_impl", "_helper", "_ext", "_alt", "_old",
];

function listSearchFiles() {
  const out = [];
  for (const dir of SEARCH_DIRS) {
    const abs = path.join(ROOT, dir);
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (!SEARCH_EXT.has(path.extname(e.name))) continue;
      out.push(path.join(abs, e.name));
      if (out.length >= MAX_FILES) return out;
    }
  }
  return out;
}

// Symbols DECLARED by a chunk of source. Deliberately narrow: a call site is not a
// declaration, and flagging calls would bury the real signal in noise.
function declaredSymbols(source) {
  const found = new Set();
  const patterns = [
    /\bfunction\s+([A-Za-z_$][\w$]*)/g,
    /\bdef\s+([A-Za-z_][\w]*)/g,
    /\bclass\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>)/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(source)) !== null) found.add(m[1]);
  }
  return [...found];
}

function baseName(symbol) {
  for (const suf of REDUNDANT_SUFFIXES) {
    if (symbol.length > suf.length + 2 && symbol.toLowerCase().endsWith(suf)) {
      return symbol.slice(0, symbol.length - suf.length).replace(/_$/, "");
    }
  }
  return null;
}

// Source text with string literals blanked and comment lines dropped.
//
// Without this the scanner reads its own selftest fixture — the literal
// "function zzqqUniqueThing() {}" — as a real declaration, and any file carrying
// example code in a comment or string becomes a false positive. A guard that fires
// on documentation is one you switch off.
function stripNonCode(line) {
  if (/^\s*(\/\/|#|\*|\/\*)/.test(line)) return "";
  return line
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

// Where a symbol is DECLARED across the tree.
//
// The file being edited is SEARCHED, not skipped. Skipping it was the first version's
// bug and it would have missed the very mistake this exists for: send_slack_api was
// written INTO notifications.py, ninety lines from the send_slack it duplicated.
// Only an EXACT match inside that same file is ignored — that is you editing the
// function you already have, which is not duplication. A NEAR match in the same file
// is the real signal.
function findDeclarations(symbols, targetAbs) {
  const hits = [];
  const files = listSearchFiles();
  const wanted = new Set(symbols);
  const bases = new Map();
  for (const s of symbols) {
    const b = baseName(s);
    if (b) bases.set(b, s);
  }
  if (wanted.size === 0 && bases.size === 0) return hits;

  const target = targetAbs ? path.resolve(targetAbs) : null;

  for (const file of files) {
    const isTarget = target !== null && path.resolve(file) === target;
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const code = stripNonCode(lines[i]);
      if (!code) continue;
      for (const sym of declaredSymbols(code)) {
        if (wanted.has(sym)) {
          if (isTarget) continue; // editing the function you already have
          hits.push({ kind: "exact", symbol: sym, file, line: i + 1, existing: sym });
        } else if (bases.has(sym)) {
          hits.push({ kind: "near", symbol: bases.get(sym), file, line: i + 1, existing: sym });
        }
      }
    }
  }
  return hits;
}

// A NEW file whose name closely matches one already present. This is the
// tasks/score_stop_variants.cjs case from 0f943e1.
function findSimilarFiles(targetPath) {
  if (!targetPath) return [];
  const abs = path.isAbsolute(targetPath) ? targetPath : path.join(ROOT, targetPath);
  if (fs.existsSync(abs)) return []; // editing something that exists is not duplication

  const base = path.basename(abs, path.extname(abs)).toLowerCase();
  const tokens = new Set(base.split(/[_\-.]/).filter((t) => t.length > 2));
  if (tokens.size === 0) return [];

  const out = [];
  for (const file of listSearchFiles()) {
    const other = path.basename(file, path.extname(file)).toLowerCase();
    if (other === base) {
      out.push({ file, why: "same name" });
      continue;
    }
    const otherTokens = new Set(other.split(/[_\-.]/).filter((t) => t.length > 2));
    let shared = 0;
    for (const t of tokens) if (otherTokens.has(t)) shared++;
    // Every meaningful word already used by an existing file.
    if (shared > 0 && shared === tokens.size) {
      out.push({ file, why: `shares every significant word (${[...tokens].join(", ")})` });
    }
  }
  return out;
}

function analyze(filePath, newContent) {
  const symbols = declaredSymbols(newContent || "").slice(0, MAX_SYMBOLS_CHECKED);
  const abs = filePath
    ? path.isAbsolute(filePath) ? filePath : path.join(ROOT, filePath)
    : null;
  return {
    symbolHits: findDeclarations(symbols, abs),
    fileHits: findSimilarFiles(filePath),
  };
}

function report({ symbolHits, fileHits }) {
  if (!symbolHits.length && !fileHits.length) return false;

  const rel = (f) => path.relative(ROOT, f).replace(/\\/g, "/");
  console.log("");
  console.log("!!! DUPLICATE WARNING — this may already exist (edit is NOT blocked)");

  for (const h of fileHits) {
    console.log(`  FILE:   ${rel(h.file)} — ${h.why}`);
  }
  const seen = new Set();
  for (const h of symbolHits) {
    const key = `${h.symbol}|${h.existing}|${h.file}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (h.kind === "exact") {
      console.log(`  SYMBOL: ${h.symbol}() already declared at ${rel(h.file)}:${h.line}`);
    } else {
      console.log(`  SYMBOL: you are writing ${h.symbol}() but ${h.existing}() already exists at ${rel(h.file)}:${h.line}`);
    }
  }
  console.log("  Extend the existing one, or say in the code why a second is needed.");
  console.log("");
  return true;
}

// ── Self-test ─────────────────────────────────────────────────────────────────
// Runs against the real mistake of 2026-09-02. A guard with no test is a guard you
// find out about only when it fails to fire.
function selftest() {
  let failures = 0;
  const check = (name, cond) => {
    console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}`);
    if (!cond) failures++;
  };

  console.log("duplicate_check selftest:\n");

  // The actual regression: send_slack_api written while send_slack exists.
  const a = analyze("notifications.py", "def send_slack_api(text, color):\n    pass\n");
  check(
    "catches send_slack_api when send_slack exists",
    a.symbolHits.some((h) => h.kind === "near" && h.existing === "send_slack")
  );

  // A genuinely new symbol must stay silent, or the warning becomes noise.
  const b = analyze("tasks/whatever.cjs", "function zzqqUniqueThing() {}\n");
  check("silent on a genuinely new symbol", b.symbolHits.length === 0);

  // Editing an existing file is not file-duplication.
  const c = findSimilarFiles("notifications.py");
  check("existing file is not flagged as a duplicate file", c.length === 0);

  // No content, no crash.
  const d = analyze("tasks/nothing_here.cjs", "");
  check("empty content does not crash", Array.isArray(d.symbolHits));

  console.log(`\n${failures === 0 ? "SELFTEST PASSED" : `SELFTEST FAILED (${failures})`}`);
  return failures === 0 ? 0 : 1;
}

function main() {
  if (process.argv.includes("--selftest")) process.exit(selftest());

  const i = process.argv.indexOf("--input");
  if (i === -1 || !process.argv[i + 1]) process.exit(0);

  let toolInput;
  try {
    toolInput = JSON.parse(fs.readFileSync(process.argv[i + 1], "utf8"));
  } catch {
    process.exit(0); // A hook that cannot parse its input must not obstruct the edit.
  }

  const ti = toolInput.tool_input || {};
  const filePath = ti.file_path;
  // Write carries `content`; Edit carries `new_string`.
  const newContent = ti.content || ti.new_string || "";
  if (!filePath && !newContent) process.exit(0);

  try {
    report(analyze(filePath, newContent));
  } catch {
    // Never let the guard become the failure.
  }
  process.exit(0);
}

// Exported so the logic can be exercised directly; main() runs only when this file is
// the entry point, never on require.
module.exports = { declaredSymbols, baseName, findDeclarations, findSimilarFiles, analyze };

if (require.main === module) main();
