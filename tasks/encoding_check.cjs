#!/usr/bin/env node
// Catch mojibake in the dashboard pages before it reaches a browser.
//
// Why this exists: on 2026-08-17 a PowerShell one-liner lifted a CSS token across seven
// pages with `Get-Content -Raw` + `[System.IO.File]::WriteAllText(..., UTF8Encoding)`.
// PowerShell 5.1's `Get-Content -Raw` decodes with the system ANSI codepage, NOT UTF-8,
// so every multi-byte sequence came back as separate cp1252 characters and was then
// written out faithfully as UTF-8. 28 emoji on system.html, 39 on jarvis.html and 97
// em-dashes and box-drawing characters on plan.html turned into visible garbage on both
// boxes. Nothing failed, nothing logged, and the syntax check passed.
//
// The damage is NOT detectable as invalid UTF-8 afterwards - the file is well-formed,
// it just holds the wrong characters. So detection has to look for the CHARACTERS a
// mis-decode produces, and it has to cover both cp1252 and Latin-1, because the two
// produce different sequences for the same original bytes:
//   "-" U+2014 = E2 80 94 -> cp1252 gives U+00E2 U+20AC U+201D ("a EUR ")
//                         -> Latin-1 gives U+00E2 U+0080 U+0094
// Only the Latin-1 form was checked the first time, which is why plan.html was called
// clean while 97 of its characters were destroyed.
//
// Usage:  node tasks/encoding_check.cjs [--dir <path>] [--quiet]
// Exit 0 = clean, 1 = mojibake found, 2 = could not run.
//
// Also required as a module by tasks/doctor.cjs, so scanDir() must never throw and
// nothing outside the require.main block may print or exit - requiring a script that
// calls process.exit at load time would kill the server that serves /api/doctor.

const fs = require("fs");
const path = require("path");

// A mis-decoded multi-byte sequence always starts with a C1-range lead byte rendered as
// a Latin-1 character: U+00C2..U+00F4. What follows differs by codepage, so match the
// lead plus any continuation that is itself a cp1252 punctuation glyph or a C1 control.
const MOJIBAKE = new RegExp(
  "[\\u00c2-\\u00f4]" +
  "[\\u0080-\\u009f\\u00a0-\\u00bf\\u2013\\u2014\\u2018\\u2019\\u201a\\u201c\\u201d" +
  "\\u201e\\u2020\\u2021\\u2022\\u2026\\u2030\\u2039\\u203a\\u20ac\\u2122\\u0152" +
  "\\u0153\\u0160\\u0161\\u0178\\u017d\\u017e\\u0192\\u02c6\\u02dc]",
  "g");

// U+FFFD means a decoder already gave up - unrecoverable without the original. Written as
// an escape on purpose: a literal here would itself be at risk from the bug this detects.
const REPLACEMENT = new RegExp("\\ufffd", "g");

const SCANNED_EXTENSIONS = /\.(html|css|js)$/i;
const LINES_REPORTED = 3;   // enough to identify the damage; the fix is per FILE anyway

// Report the line so the fix is `git checkout <clean-sha> -- <file>`, not a hunt. A fresh
// RegExp per call: `g` regexes carry lastIndex, and a shared one skips matches on reuse.
function firstDamagedLines(text, limit) {
  const re = new RegExp(MOJIBAKE.source, "g");
  const hits = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length && hits.length < limit; i++) {
    re.lastIndex = 0;
    if (re.test(lines[i])) hits.push({ line: i + 1, text: lines[i].trim().slice(0, 90) });
  }
  return hits;
}

/**
 * Scan one directory. Returns { dir, rows, damaged } or { dir, error } - never throws and
 * never prints, because the doctor calls this inside diagnose() and a rejected promise
 * there would turn /api/doctor into a 500 over a cosmetic check.
 */
function scanDir(dir) {
  let names;
  try {
    names = fs.readdirSync(dir).filter(f => SCANNED_EXTENSIONS.test(f)).sort();
  } catch (err) {
    return { dir, error: "cannot read " + dir + " - " + err.message, rows: [], damaged: 0 };
  }
  if (!names.length) {
    return { dir, error: "no html/css/js files in " + dir, rows: [], damaged: 0 };
  }

  const rows = [];
  for (const name of names) {
    let buf;
    try { buf = fs.readFileSync(path.join(dir, name)); }
    catch (err) { rows.push({ name, note: "unreadable - " + err.message, bad: 0 }); continue; }

    const text = buf.toString("utf8");
    const mojibake = (text.match(MOJIBAKE) || []).length;
    const replacement = (text.match(REPLACEMENT) || []).length;
    // A UTF-8 BOM is not corruption, but it breaks some strict parsers - worth naming.
    const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
    const bad = mojibake + replacement;
    rows.push({
      name, mojibake, replacement, bom, bad,
      lines: bad > 0 ? firstDamagedLines(text, LINES_REPORTED) : [],
    });
  }
  return { dir, rows, damaged: rows.filter(r => r.bad > 0).length };
}

// The remedy, in one place, because the CLI prints it and the doctor reports it.
const REMEDY_LINES = [
  "git log --oneline -5 -- <file>   then   git checkout <sha> -- <file>   per file",
  "Re-apply the intended edit with an editor, never a PowerShell read/write pair.",
  "If it must be scripted: [System.IO.File]::ReadAllText($p) honours UTF-8;",
  "Get-Content -Raw does NOT on PowerShell 5.1.",
];

function runCli() {
  const argv = process.argv.slice(2);
  const quiet = argv.includes("--quiet");
  const dirFlag = argv.indexOf("--dir");
  const dir = dirFlag !== -1 && argv[dirFlag + 1]
    ? argv[dirFlag + 1]
    : path.join(__dirname, "..", "dashboard");

  const result = scanDir(dir);
  if (result.error) {
    console.error("encoding_check: " + result.error);
    process.exit(2);
  }

  if (!quiet) {
    console.log("ENCODING CHECK - " + result.dir);
    for (const r of result.rows) {
      if (r.note) { console.log("  " + r.name.padEnd(22) + r.note); continue; }
      const verdict = r.bad > 0 ? "MOJIBAKE" : r.bom ? "clean (has BOM)" : "clean";
      console.log("  " + r.name.padEnd(22) +
        "mojibake=" + String(r.mojibake).padStart(4) +
        "  U+FFFD=" + String(r.replacement).padStart(3) +
        "  " + verdict);
      for (const hit of r.lines) console.log("      line " + hit.line + ": " + hit.text);
    }
    console.log("");
  }

  if (result.damaged > 0) {
    console.log("RESULT: " + result.damaged + " file(s) hold mis-decoded text.");
    console.log("FIX: restore each from the last commit BEFORE the damage -");
    for (const line of REMEDY_LINES) console.log("     " + line);
    process.exit(1);
  }
  console.log("RESULT: all " + result.rows.length + " file(s) clean.");
  process.exit(0);
}

if (require.main === module) runCli();

module.exports = { scanDir, REMEDY_LINES, MOJIBAKE_SOURCE: MOJIBAKE.source };
