#!/usr/bin/env node
"use strict";
// Catches the ONE cmd.exe defect that has actually cost this project work: an
// unescaped parenthesis inside a parenthesised block.
//
// On 2026-08-29 commit 1a7154a added this to the park fallback of both VPS agents:
//
//   echo ... the market is simply closed (Gold and SPX do not trade at the
//   weekend, BTC does), which is NOT a frozen feed ...
//
// It sits inside `if not "%CLAUDE_RC%"=="0" ( ... )`. The bare `)` closes the block
// early, cmd aborts with "which was unexpected at this time", and the batch never
// reaches `del "%RUNOUT%"` or `echo [exit %CLAUDE_RC%]`. Both VPS agents reported 255
// to the Task Scheduler for SEVEN DAYS while doing their work correctly -- what was
// silently lost was the park safety net, so a subscription limit would have thrown
// the day's brief away instead of queueing it.
//
// Nothing caught it because tasks/hooks/post-edit-check.ps1 syntax-checks .js with
// `node --check` and .py with `py_compile`, and cmd.exe has no equivalent. This is
// that equivalent, narrowed to the defect that really happens.
//
// Deliberately NOT a general cmd parser. It reports one thing, with no false
// positives on the corpus: a parenthesis inside a block that cmd will act on rather
// than print. `^(` and `^)` are correct and pass; `%~dp0`, quoted paths and
// `%VAR:(=%` are untouched because only echo/REM payloads are inspected.
//
// Usage:  node tasks/batch_syntax_check.cjs [file.bat ...]   (default: tasks/*.bat)
//         node tasks/batch_syntax_check.cjs --selftest
// Exit 0 clean, 1 findings, 2 selftest failed.

const fs = require("fs");
const path = require("path");

// A line that opens a block ends with an unescaped `(` after stripping quoted text.
// A line that closes one starts with `)` (optionally followed by a pipe/redirect).
const OPENS = /\($/;
const CLOSES = /^\)/;

function stripQuoted(line) {
  // Text inside double quotes is data to cmd, not syntax.
  return line.replace(/"[^"]*"/g, '""');
}

function unescapedParens(text) {
  // Remove `^(` and `^)` -- correctly escaped, they are literals and are the fix.
  return text.replace(/\^[()]/g, "");
}

function scan(file) {
  const findings = [];
  let src;
  try {
    src = fs.readFileSync(file, "utf8");
  } catch (err) {
    return [{ line: 0, text: `could not read: ${err.message}`, unreadable: true }];
  }
  const lines = src.split(/\r?\n/);
  let depth = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed) continue;

    const bare = stripQuoted(trimmed);

    // Only the PAYLOAD of an echo can carry prose parens. REM is not parsed for
    // parens by cmd inside a block, but an echo payload absolutely is.
    const echo = /^echo[ .]/i.test(trimmed) ? trimmed.replace(/^echo[ .]/i, "") : null;

    if (depth > 0 && echo !== null) {
      const risky = unescapedParens(stripQuoted(echo));
      if (/[()]/.test(risky)) {
        findings.push({
          line: i + 1,
          text: trimmed.length > 150 ? trimmed.slice(0, 150) + " ..." : trimmed,
        });
      }
    }

    if (CLOSES.test(bare)) depth = Math.max(0, depth - 1);
    if (OPENS.test(unescapedParens(bare))) depth++;
  }
  return findings;
}

// ---- selftest: the historical defect must FAIL and its fix must PASS -----------
function selftest() {
  const tmp = path.join(require("os").tmpdir(), `batchcheck_selftest_${process.pid}.bat`);
  const mk = (payload) =>
    ['@echo off', 'set RC=1', 'if not "%RC%"=="0" (', "  (", `    echo ${payload}`,
     '  ) > "%TEMP%\\selftest_out.txt"', ')', "echo END"].join("\r\n");

  const cases = [
    { name: "1a7154a's actual line", payload:
      "closed (Gold and SPX do not trade at the weekend, BTC does), which is NOT a frozen feed", expect: 1 },
    { name: "the applied fix", payload:
      "closed ^(Gold and SPX do not trade at the weekend, BTC does^), which is NOT a frozen feed", expect: 0 },
    { name: "prose with no parens", payload: "a plain brief line with no parentheses", expect: 0 },
    { name: "parens inside quotes are data", payload: '"a (quoted) path"', expect: 0 },
  ];

  let failed = 0;
  for (const c of cases) {
    fs.writeFileSync(tmp, mk(c.payload), "utf8");
    const got = scan(tmp).length;
    const ok = got === c.expect;
    if (!ok) failed++;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${c.name} -- expected ${c.expect} finding(s), got ${got}`);
  }
  fs.unlinkSync(tmp);

  // A checker that cannot fail is decoration. Prove the detector really fires.
  if (failed === 0) console.log("selftest: OK -- the detector fires on the real defect and clears its fix");
  else console.log(`selftest: ${failed} case(s) wrong -- this check cannot be trusted`);
  return failed === 0 ? 0 : 2;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--selftest")) process.exit(selftest());

  let files = args.filter((a) => !a.startsWith("--"));
  if (files.length === 0) {
    const dir = path.join(__dirname);
    files = fs.readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(".bat"))
      .map((f) => path.join(dir, f));
  }

  let total = 0;
  for (const f of files) {
    const findings = scan(f);
    if (findings.length === 0) continue;
    total += findings.length;
    console.log(`\n${path.relative(process.cwd(), f)}`);
    for (const x of findings) {
      console.log(`  line ${x.line}: unescaped parenthesis inside a ( ) block`);
      console.log(`    ${x.text}`);
      if (!x.unreadable) {
        console.log(`    cmd will treat the ) as the end of the block and abort the batch.`);
        console.log(`    Fix: write ^( and ^) so they reach the payload as literals.`);
      }
    }
  }

  if (total === 0) {
    console.log(`batch syntax: OK -- ${files.length} file(s), no unescaped parens inside blocks`);
    process.exit(0);
  }
  console.log(`\nbatch syntax: ${total} finding(s). A batch that aborts mid-run still ` +
              `reports its work as done, and loses everything after the abort.`);
  process.exit(1);
}

main();
