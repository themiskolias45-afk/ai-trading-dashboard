'use strict';
/**
 * Does a proposal's evidence actually exist?
 *
 * The VPS weekly review of 2026-08-09 proposed a real change for real reasons and
 * called a −$99.10 loss two days before it closed. Then it put generateSignalMTF() at
 * index.js:1413 (really 1565), regime at :1698 (1867), finalSetup at :1714 (1883) and
 * generateSignal() at :833 (985) — all four wrong on BOTH boxes, which are
 * line-aligned, so this is not fleet drift.
 *
 * It also told you to run `tasks/_regime_xtab.cjs`. That one is REAL: it exists on the
 * VPS, dated 2026-07-31, and is simply absent from the laptop. The first pass of this
 * investigation called it fabricated on the strength of a malformed `dir` that failed
 * for an unrelated reason and reported "none". So the review cited four bad line
 * numbers and one perfectly good box-local path, and a human reading it fast got that
 * ratio backwards.
 *
 * That is the whole argument for doing this mechanically. Sound reasoning earns trust
 * that the citations then spend, and checking them by hand produces its own errors in
 * both directions — a real file called missing is as costly as a missing one called
 * real, because it discredits a proposal that deserved acting on.
 *
 * So: the same move that turned the trading gates from opinion into evidence. Log the
 * claim, check it, publish the verdict. A proposal whose references do not resolve is
 * marked before anyone acts on it, not after.
 *
 * DETERMINISTIC. No AI, no network, no tokens. READ-ONLY: it opens files to count
 * lines and locate symbols and writes nothing.
 *
 * SECURITY: proposal text is untrusted — it is LLM output that has passed through log
 * files. Every path it names is resolved and then required to stay inside the project
 * root, so a proposal cannot make this read C:\Users\...\keys.env or ../../secrets.
 * Absolute paths and traversal are reported as citations, never followed.
 *
 * RULE: nothing here feeds a gate, a threshold, confidence or sizing.
 */

const fs   = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

// Extensions worth resolving. Without a whitelist, prose decimals and abbreviations
// ("0.05R", "e.g.") parse as filenames and every proposal reports phantom breakage —
// a checker that cries wolf is one people learn to skip, which is the failure it
// exists to prevent.
// LONGEST FIRST. Alternation is first-match, so listing `js` before `json` makes
// "keys.env.json" match as "keys.env.js" — a file that does not exist — and the
// checker reports a real reference as broken. Cry-wolf is the one failure mode that
// makes this whole surface worthless.
const CODE_EXT = "jsonl|json|html|cjs|mjs|ps1|bat|js|ts|py|md";

// path/to/file.ext, optionally :LINE. Backslashes allowed so Windows-style paths in
// agent output are caught rather than silently ignored.
const PATH_RE = new RegExp(
  String.raw`(?:^|[\s(\`"'\[])((?:[\w.\-]+[\/\\])*[\w.\-]+\.(?:${CODE_EXT}))(?::(\d+))?`, "g");

// bareSymbol() — the way agents cite functions here.
const SYMBOL_RE = /\b([A-Za-z_$][\w$]*)\(\)/g;

// Bounded on purpose. A runaway log should degrade this check, never the server that
// hosts it: build() runs on an HTTP request.
const MAX_REFS_PER_PROPOSAL = 40;
const MAX_FILE_BYTES        = 4 * 1024 * 1024;
// Where a bare symbol is looked for; node_modules is excluded deliberately, since a
// match there would "resolve" a symbol the proposal never meant.
//
// dashboard/ belongs here and was missing. SEARCH_DIRS below has listed it since it
// shipped, so a proposal citing dashboard/index.html resolved the FILE and then failed
// on the function inside it: loadRiskStatus() is defined at dashboard/index.html:2923
// and came back "no definition found", stamping a correct proposal SOME REFERENCES
// BROKEN. That is precisely the cry-wolf this module exists to prevent, and it aimed it
// at the control surface - where most fixable findings actually live.
const SYMBOL_DIRS = [["server"], ["tasks"], ["dashboard"]];
// Where a bare basename is looked for, in order. "" is the project root.
const SEARCH_DIRS = ["", "server", "tasks", "dashboard"];
// .html is here for the dashboard's inline <script>: the definition patterns below
// match a function on its own line, which is how that file declares them, so no HTML
// parsing is needed to find one.
const SYMBOL_EXT  = new Set([".js", ".cjs", ".mjs", ".py", ".html"]);

/** Read a file once per build, capped. null when unreadable or oversized. */
function makeReader() {
  const cache = new Map();
  return function read(absolute) {
    if (cache.has(absolute)) return cache.get(absolute);
    let text = null;
    try {
      const stat = fs.statSync(absolute);
      if (stat.isFile() && stat.size <= MAX_FILE_BYTES) {
        text = fs.readFileSync(absolute, "utf8");
      }
    } catch (e) { text = null; }
    cache.set(absolute, text);
    return text;
  };
}

/**
 * Resolve a cited path inside the project, or explain why it cannot be.
 *
 * Returns { ok, absolute, why }. Anything that escapes ROOT is refused rather than
 * read: the caller is a status surface, not a file browser, and the input is untrusted.
 */
function resolveInsideRoot(reference) {
  const normalised = reference.replace(/\\/g, "/");
  if (path.isAbsolute(normalised) || /^[A-Za-z]:/.test(normalised)) {
    return { ok: false, why: "absolute path — not resolved, this check only reads inside the project" };
  }

  const candidates = normalised.includes("/")
    ? [normalised]
    // Agents cite bare basenames constantly — "hermes.js:125", "journal.json",
    // "index.js:1140" — all meaning the copy under server/. Resolving those literally
    // against the root reports three real files as missing, which is cry-wolf and
    // trains people to ignore the whole surface. Search the dirs this repo keeps
    // source in before concluding anything is absent.
    : SEARCH_DIRS.map(dir => (dir ? `${dir}/${normalised}` : normalised));

  for (const candidate of candidates) {
    const absolute = path.resolve(ROOT, candidate);
    const inside = absolute === ROOT || absolute.startsWith(ROOT + path.sep);
    if (!inside) return { ok: false, why: "path escapes the project root — refused" };
    try {
      if (fs.statSync(absolute).isFile()) {
        return { ok: true, absolute, resolvedAs: candidate };
      }
    } catch (e) { /* try the next candidate */ }
  }

  // Nothing matched. Re-check containment so a traversal attempt is still refused as
  // such rather than reported as a plain missing file.
  const literal = path.resolve(ROOT, normalised);
  if (!(literal === ROOT || literal.startsWith(ROOT + path.sep))) {
    return { ok: false, why: "path escapes the project root — refused" };
  }
  return { ok: false, why: normalised.includes("/")
    ? "no such file in this project"
    : `no file named ${normalised} under ${SEARCH_DIRS.filter(Boolean).join("/, ")}/ or the project root` };
}

/** Every source file a bare symbol could be defined in. Bounded, no recursion below depth 1. */
function symbolSearchFiles() {
  const out = [];
  for (const parts of SYMBOL_DIRS) {
    const dir = path.join(ROOT, ...parts);
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { continue; }
    for (const name of names) {
      // bareKeyMatch travels WITH the file rather than being re-derived at each call
      // site. It was duplicated in checkCitations and locateSymbol, which is two places
      // to remember when the next extension needs the same treatment — and the failure
      // mode of forgetting one is silent: CSS lines resolving as function definitions in
      // whichever path was missed. See findDefinition.
      if (SYMBOL_EXT.has(path.extname(name))) {
        out.push({
          rel: [...parts, name].join("/"),
          abs: path.join(dir, name),
          bareKeyMatch: !name.endsWith(".html"),
        });
      }
    }
  }
  return out;
}

/**
 * Line number (1-indexed) where `name` looks DEFINED, or null.
 *
 * `bareKeyMatch` is the last and loosest pattern — a name at the start of a line
 * followed by `:` or `(`, which catches object-literal methods and shorthand. It must
 * be OFF for HTML, because a stylesheet is full of lines like `color: #fff` and every
 * one of them answers to that shape: probing .html with it resolved color(), width(),
 * padding() and display() to CSS declarations. A confidently wrong location is worse
 * than "not found", which is the whole thesis of this module. Inline scripts declare
 * their functions as `function name(` or `const name =`, so nothing real is lost.
 */
function findDefinition(text, name, { bareKeyMatch = true } = {}) {
  if (!text) return null;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // `[ \t]*`, never `\s*`, after the ^ anchor: \s matches newlines, so `^\s*function`
  // happily starts its match on a BLANK LINE above the definition and every line
  // number comes back one low. That is the exact class of off-by-one this module
  // exists to catch, so getting it wrong here would be self-defeating.
  const patterns = [
    new RegExp(String.raw`^[ \t]*(?:async[ \t]+)?function[ \t]+${escaped}[ \t]*\(`, "m"),
    new RegExp(String.raw`^[ \t]*(?:const|let|var)[ \t]+${escaped}[ \t]*=`, "m"),
    new RegExp(String.raw`^[ \t]*def[ \t]+${escaped}[ \t]*\(`, "m"),
  ];
  if (bareKeyMatch) patterns.push(new RegExp(String.raw`^[ \t]*${escaped}[ \t]*[:(]`, "m"));
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return text.slice(0, match.index).split("\n").length;
  }
  return null;
}

/**
 * One file-read cache and one symbol-search list, shared across every proposal in a
 * single build. Callers that check more than one proposal MUST create this once and
 * pass it in; the default exists so a one-off call still works.
 */
function createContext() {
  return { read: makeReader(), searchFiles: symbolSearchFiles() };
}

/**
 * Check every reference in one proposal's text.
 *
 * `broken` is the field worth reading. A proposal with broken references is not
 * necessarily wrong — the 2026-08-09 review was right about the trade — but it cannot
 * be followed as written, and that distinction is the whole point.
 */
function checkCitations(text, context) {
  const empty = { checked: 0, resolved: 0, refs: [], broken: [], verdict: "NO REFERENCES" };
  if (!text || typeof text !== "string") return empty;

  // One cache per BUILD, not per proposal. Without this every proposal re-read every
  // file under server/ and tasks/ — index.js alone is 6,500 lines — and /api/ai-work
  // already answers slowly enough to time the MCP tool out.
  const { read, searchFiles } = context || createContext();
  const refs = [];
  const seen = new Set();

  for (const match of text.matchAll(PATH_RE)) {
    const [, reference, lineText] = match;
    const line = lineText ? Number(lineText) : null;
    const key = `path:${reference}:${line ?? ""}`;
    if (seen.has(key) || refs.length >= MAX_REFS_PER_PROPOSAL) continue;
    seen.add(key);

    const resolved = resolveInsideRoot(reference);
    if (!resolved.ok) { refs.push({ kind: "path", ref: reference, ok: false, why: resolved.why }); continue; }

    const body = read(resolved.absolute);
    if (body === null) {
      refs.push({ kind: "path", ref: reference, ok: false, why: "no such file in this project" });
      continue;
    }
    // Say where a bare basename actually landed, so "index.js" cannot quietly mean a
    // different index.js than the reader is picturing.
    const resolvedAs = resolved.resolvedAs !== reference ? resolved.resolvedAs : undefined;
    if (line === null) { refs.push({ kind: "path", ref: reference, ok: true, resolvedAs }); continue; }

    // A line citation is only useful if the line exists. Reporting the file's real
    // length turns "wrong" into "wrong, and here is the range you had to work with".
    const total = body.split("\n").length;
    if (line < 1 || line > total) {
      refs.push({ kind: "line", ref: `${reference}:${line}`, ok: false, resolvedAs,
                  why: `file has ${total} lines` });
    } else {
      refs.push({ kind: "line", ref: `${reference}:${line}`, ok: true, resolvedAs });
    }
  }

  for (const match of text.matchAll(SYMBOL_RE)) {
    const name = match[1];
    const key = `sym:${name}`;
    if (seen.has(key) || refs.length >= MAX_REFS_PER_PROPOSAL) continue;
    seen.add(key);

    let found = null;
    for (const file of searchFiles) {
      const at = findDefinition(read(file.abs), name, { bareKeyMatch: file.bareKeyMatch });
      if (at !== null) { found = `${file.rel}:${at}`; break; }
    }
    refs.push(found
      ? { kind: "symbol", ref: `${name}()`, ok: true, definedAt: found }
      : { kind: "symbol", ref: `${name}()`, ok: false,
          // Derived from SYMBOL_DIRS, not spelled out: the hardcoded version still said
          // "server/ or tasks/" after dashboard/ was searched too, which tells a reader
          // to stop looking in the one place the symbol might be.
          why: `no definition found under ${SYMBOL_DIRS.map(parts => parts.join("/")).join("/, ")}/` });
  }

  const broken = refs.filter(r => !r.ok);
  const resolved = refs.length - broken.length;
  return {
    checked: refs.length,
    resolved,
    refs,
    broken,
    verdict: refs.length === 0 ? "NO REFERENCES"
           : broken.length === 0 ? "REFERENCES RESOLVE"
           : broken.length === refs.length ? "ALL REFERENCES BROKEN"
           : "SOME REFERENCES BROKEN",
  };
}

/**
 * Where a cited symbol REALLY is, for a proposal that named the wrong line. Separate
 * from checkCitations because it answers the follow-up question — "fine, so where is
 * it" — which is what you actually need to act on a proposal worth acting on.
 */
function locateSymbol(name, context) {
  const { read, searchFiles } = context || createContext();
  for (const file of searchFiles) {
    const at = findDefinition(read(file.abs), name, { bareKeyMatch: file.bareKeyMatch });
    if (at !== null) return `${file.rel}:${at}`;
  }
  return null;
}

module.exports = { checkCitations, locateSymbol, createContext, ROOT };
