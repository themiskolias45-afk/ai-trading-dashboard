/* ============================================================================
   PAGE QUALITY AUDIT — the defects this system actually ships, found daily
   ============================================================================

   WHY THIS EXISTS

   Every check below is a bug that was really found on these pages, most of them
   on 2026-08-29 alone. They are not style opinions; each one produced a page that
   stated something untrue:

     ABSENT-AS-ZERO   Number(null) is 0 and Number.isFinite(0) is true, so a
                      MISSING gate was accepted as zero and every asset rendered
                      "at or above the gate" in green. Found on the fleet page,
                      then again on /daily-plan, then again on the chart chip.
     DEFERRED RACE    freshness.js is loaded with `defer`, so it has NOT run when
                      an inline end-of-body script fires. First paint rendered
                      every age as "unknown" until the refresh quietly fixed it.
     RAW INTERPOLATION  calendar titles come from a third-party feed and were
                      dropped into innerHTML unescaped.
     ORPHAN STYLE     .no-screenshot was styled and never rendered by anything,
                      so a missing chart looked identical to a page that never
                      had one.
     LONE INCLUDE     a page missing theme.css carries its own dead palette and
                      teaches the wrong colours to whoever reads it next.

   IT PROPOSES, IT NEVER EDITS. Not one byte of any page is written. That is
   deliberate and matches how every other self-improvement path here works — the
   auto-tuner proposes and never writes a threshold, for the same reason: a job
   that edits unattended is a job that breaks a page at 07:30 with nobody
   watching.

   IT CANNOT BLOCK. Always exits 0. A quality finding must never fail a daily run
   or delay a step after it.

   IT DELETES NOTHING. Read-only over dashboard/*.html; writes one JSON artifact.

   DETERMINISTIC — no LLM, no tokens, no network. The Claude ceiling has closed
   before and killed every agent job at once; an audit that cannot run on that day
   is not a daily audit.

   Usage: node tasks/page_quality_audit.cjs [--out <path>] [--json] [--quiet]
   ============================================================================ */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");

function opt(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
/* --dir exists so the checks can be run against a CANARY page holding each defect
   on purpose. Tightening a check to kill false positives can silently kill the
   check itself, and a check that reports nothing looks exactly like clean pages —
   the failure this whole file is about. --dir with --out proves it still fires
   without touching the live pages or the live artifact. */
const PAGES_DIR = opt("--dir", path.join(ROOT, "dashboard"));
const OUT = opt("--out", path.join(ROOT, "dashboard", "page-quality.json"));
const QUIET = process.argv.includes("--quiet");
const AS_JSON = process.argv.includes("--json");

/* Pages that are deliberately not part of the dashboard shell. login.html has no
   nav by design — a rail on a login screen links to pages you cannot open. */
const EXEMPT_FROM_SHELL = new Set(["login.html"]);

/** Line number of an index into the source, for a finding you can navigate to. */
function lineOf(src, index) {
  return src.slice(0, index).split("\n").length;
}

/** Everything inside <script> blocks, with offsets preserved. */
function scriptBlocks(src) {
  const out = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(src)) !== null) out.push({ code: m[1], at: m.index + m[0].indexOf(m[1]) });
  return out;
}

const CHECKS = [
  {
    id: "absent-as-zero",
    title: "A missing value could be coerced to zero",
    why: "Number(null) is 0 and Number.isFinite(0) is true, so a guard written this way "
       + "accepts an ABSENT value as a real zero. This exact line shape rendered every "
       + "asset green and 'at or above the gate' when the gate could not be read.",
    fix: "Check for null/undefined/'' BEFORE coercing, then Number() the survivor.",
    run(src) {
      const hits = [];
      for (const block of scriptBlocks(src)) {
        const re = /Number\.isFinite\(\s*Number\(/g;
        let m;
        while ((m = re.exec(block.code)) !== null) {
          const lineStart = block.code.lastIndexOf("\n", m.index) + 1;
          let lineEnd = block.code.indexOf("\n", m.index);
          if (lineEnd === -1) lineEnd = block.code.length;
          const line = block.code.slice(lineStart, lineEnd);
          // The window is the STATEMENT, not the line. A wrapped condition puts the
          // absence test on the line above:
          //     const gate = (raw === null || raw === undefined || raw === ''
          //                   || !Number.isFinite(Number(raw))) ? null : Number(raw);
          // Reading line 2 alone reported that — correct code, written specifically to
          // prevent this bug — as the bug itself. A check that flags a correct fix is
          // the cry-wolf failure this audit exists to avoid.
          const stmtStart = Math.max(
            block.code.lastIndexOf(";", m.index),
            block.code.lastIndexOf("{", m.index)) + 1;
          let stmtEnd = block.code.indexOf(";", m.index);
          if (stmtEnd === -1) stmtEnd = block.code.length;
          // Any mention of null/undefined in the statement means absence is already
          // being handled — including the safe `Number.isFinite(Number(x)) ? Number(x)
          // : null` shape, which the first version flagged 5 times on index.html alone.
          if (/null|undefined|\?\?/.test(block.code.slice(stmtStart, stmtEnd))) continue;
          // A COMMENT describing the bug is not the bug. The first version flagged
          // its own explanatory comment on daily-plan.html twice.
          if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
          hits.push({ line: lineOf(src, block.at + m.index), excerpt: line.trim().slice(0, 120) });
        }
      }
      return hits;
    },
  },
  {
    id: "deferred-race",
    title: "Inline script may run before freshness.js has loaded",
    why: "freshness.js is loaded with `defer`, which executes AFTER the parser reaches an "
       + "inline end-of-body script but BEFORE DOMContentLoaded. A page that calls its "
       + "loader immediately draws its FIRST paint with window.SEFresh undefined, so every "
       + "age renders as unknown until the next refresh quietly hides it.",
    fix: "Wrap the first load in the same guard freshness.js uses on itself: "
       + "if (document.readyState === 'loading') addEventListener('DOMContentLoaded', load); else load();",
    run(src) {
      if (src.indexOf("freshness.js") === -1) return [];
      const uses = /SEFresh/.test(src);
      if (!uses) return [];
      const guarded = /readyState\s*===\s*["']loading["']/.test(src)
                   || /DOMContentLoaded/.test(src);
      return guarded ? [] : [{ line: null, excerpt: "page uses SEFresh with no DOMContentLoaded guard" }];
    },
  },
  {
    id: "raw-interpolation",
    title: "External text may reach innerHTML unescaped",
    why: "Calendar titles, analyst text and log lines come from feeds and files this system "
       + "does not control. Interpolated into innerHTML without escaping, they are an "
       + "injection surface — and one was found live in the daily-plan calendar.",
    fix: "Escape at the boundary: esc(value) / escapeHtml(value) before concatenating.",
    run(src) {
      const hits = [];
      for (const block of scriptBlocks(src)) {
        // A template literal placed into innerHTML whose expression has no escaper.
        const re = /innerHTML\s*=\s*`[^`]*`/g;
        let m;
        while ((m = re.exec(block.code)) !== null) {
          const chunk = m[0];
          const exprs = chunk.match(/\$\{[^}]+\}/g) || [];
          // Only fields that carry text this system does not control. The first
          // version flagged ${RAIL_WIDTH}, ${years} and ${e.message} — internal
          // values that can never contain markup — and buried the one real hit.
          const EXTERNAL = /\.(title|name|event|country|currency|setup|label|detail|reason|haltReason|message|text|comment|note)\b/;
          const bare = exprs.filter(e => EXTERNAL.test(e)
            && !/esc\(|escapeHtml\(|encodeURI|toFixed|\.length|Number\(/.test(e));
          if (bare.length) {
            hits.push({ line: lineOf(src, block.at + m.index),
                        excerpt: bare.slice(0, 2).join(" ").slice(0, 120) });
          }
        }
      }
      return hits;
    },
  },
  {
    id: "orphan-style",
    title: "A CSS class is defined and never used",
    why: "A styled element nothing renders is a state the page cannot reach. .no-screenshot "
       + "was styled for months while a missing chart rendered as nothing at all, which is "
       + "indistinguishable from a page that never had charts.",
    fix: "Either render the state the class was written for, or note in the CSS why it is kept.",
    run(src) {
      // Strip CSS comments FIRST. A comment explaining why a selector was corrected
      // names the old class, and the scanner read that as a fresh definition — so
      // fixing .lvl-table and .main-col and writing down why re-reported both the
      // next morning. Third time a check has flagged its own prose.
      const styles = (src.match(/<style[^>]*>([\s\S]*?)<\/style>/g) || [])
        .join("\n").replace(/\/\*[\s\S]*?\*\//g, " ");
      if (!styles) return [];
      const defined = new Set();
      const re = /\.([a-z][a-z0-9_-]{3,})\s*(?=[{,:.\s])/gi;
      let m;
      while ((m = re.exec(styles)) !== null) defined.add(m[1]);
      const body = src.replace(/<style[^>]*>[\s\S]*?<\/style>/g, "");
      // Class names built from DATA are invisible to a text scan: the calendar emits
      // String(e.impact).toLowerCase(), so .medium is live and unfindable, while .high
      // and .low look used only because those words happen to appear in the code. On a
      // page that concatenates class names at all, a single un-hyphenated word cannot
      // be PROVEN dead — and an unprovable claim reported as a defect is how a daily
      // audit trains you to skim past it. Hyphenated orphans are still reported: those
      // are the ones that found a real dead mobile fix on two pages.
      const buildsClassNames = /class="[^"]*'\s*\+|className\s*=\s*[^;]*\+/.test(body);
      const hits = [];
      for (const cls of defined) {
        if (buildsClassNames && cls.indexOf("-") === -1) continue;
        // Referenced anywhere outside the stylesheet counts — markup or a JS string.
        if (body.indexOf(cls) !== -1) continue;
        // Classes are routinely BUILT: "sev-" + severity, "p-" + level, "bias-" + dir.
        // A prefix present in the body means the class is reachable, so .sev-high and
        // .p-idle are uses, not orphans — the first version reported 8 of them.
        const parts = cls.split("-");
        let reachable = false;
        for (let n = 1; n < parts.length; n++) {
          if (body.indexOf(parts.slice(0, n).join("-") + "-") !== -1) { reachable = true; break; }
        }
        if (!reachable) hits.push({ line: null, excerpt: "." + cls });
      }
      // Only report when the count is small enough to act on; a long list is a
      // refactor, not a daily improvement, and would read as noise every morning.
      return hits.length && hits.length <= 12 ? hits : [];
    },
  },
  {
    id: "shell-includes",
    title: "Page is missing a shared shell include",
    why: "theme.css carries the one palette and nav.css/nav.js the one rail. A page without "
       + "them renders its own colours and cannot be navigated to from anywhere — which is "
       + "how /architecture ended up with exactly one inbound link in the whole product.",
    fix: "Add the standard <head> block: theme.css, nav.css, nav.js defer, freshness.*",
    run(src, name) {
      if (EXEMPT_FROM_SHELL.has(name)) return [];
      const missing = [];
      if (src.indexOf("theme.css") === -1) missing.push("theme.css");
      if (src.indexOf("nav.js") === -1) missing.push("nav.js");
      return missing.length ? [{ line: null, excerpt: "missing " + missing.join(", ") }] : [];
    },
  },
];

function audit() {
  let files;
  try {
    files = fs.readdirSync(PAGES_DIR).filter(n => n.endsWith(".html")).sort();
  } catch (e) {
    return { generatedAt: new Date().toISOString(), available: false,
             reason: "could not read dashboard/: " + e.message, pages: [] };
  }

  const pages = files.map(name => {
    let src = "";
    try { src = fs.readFileSync(path.join(PAGES_DIR, name), "utf8"); }
    catch (e) { return { page: name, unreadable: e.message, findings: [] }; }

    const findings = [];
    for (const check of CHECKS) {
      let hits = [];
      // A check that throws must not take the audit down with it — but a swallowed
      // error must not read as a clean page either. That is the whole failure class
      // this file is about, and it was sitting in this very catch: the error is now
      // RECORDED as a finding against the audit itself.
      try { hits = check.run(src, name) || []; }
      catch (e) {
        hits = [{ line: null, excerpt: "check threw: " + e.message }];
      }
      for (const hit of hits.slice(0, 5)) {
        findings.push({ check: check.id, title: check.title, why: check.why,
                        fix: check.fix, line: hit.line, excerpt: hit.excerpt });
      }
    }
    return { page: name, bytes: src.length, findings };
  });

  const byCheck = {};
  pages.forEach(p => p.findings.forEach(f => { byCheck[f.check] = (byCheck[f.check] || 0) + 1; }));
  const total = pages.reduce((n, p) => n + p.findings.length, 0);

  return {
    generatedAt: new Date().toISOString(),
    box: os.hostname(),
    available: true,
    pagesChecked: pages.length,
    totalFindings: total,
    byCheck,
    checks: CHECKS.map(c => ({ id: c.id, title: c.title, why: c.why, fix: c.fix })),
    pages: pages.filter(p => p.findings.length || p.unreadable),
    clean: pages.filter(p => !p.findings.length && !p.unreadable).map(p => p.page),
    note: "PROPOSES ONLY — not one byte of any page is written by this audit. Every check "
        + "here is a defect that really shipped on these pages, not a style opinion.",
    feedsTheGate: false,
  };
}

/* ── SELF-TEST ───────────────────────────────────────────────────────────────
   A canary page carrying one of each defect ON PURPOSE. Every check must fire on
   it, and the result rides in the artifact so a dead check is visible on the page
   instead of reading as "all clean".

   This is not hypothetical. raw-interpolation was DEAD from the day it was
   written: its regex ended in byte 0x08 — a literal BACKSPACE — where `\b` was
   meant, because the line was once written through a shell that ate the escape.
   It matched nothing, ever, and reported every page clean. Tightening the other
   three checks to kill false positives could have done the same silently. A check
   that cannot fire is indistinguishable from a page with no defects. */
const CANARY = [
  '<!DOCTYPE html><html><head><style>',
  '.qq-orphan { color: red; }',
  '</style>',
  '<script src="/dashboard/freshness.js" defer><\/script>',
  '</head><body><script>',
  'const gate = Number.isFinite(Number(d.gate)) ? Number(d.gate) : 0;',
  'host.innerHTML = `<b>${ev.title}</b> in ${ev.country}`;',
  'function load(){ window.SEFresh.ago(x); }',
  'load();',
  '<\/script></body></html>',
].join("\n");

function selfTest() {
  const fired = [];
  const dead = [];
  for (const check of CHECKS) {
    let hits = [];
    try { hits = check.run(CANARY, "canary.html") || []; } catch (e) { hits = []; }
    (hits.length ? fired : dead).push(check.id);
  }
  return { allChecksFire: dead.length === 0, fired, dead };
}

const report = audit();
report.selfTest = selfTest();
try {
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
} catch (e) {
  if (!QUIET) console.error("[page-quality] could not write: " + e.message);
}

if (AS_JSON) {
  console.log(JSON.stringify(report, null, 2));
} else if (!QUIET) {
  if (!report.available) {
    console.log("[page-quality] UNAVAILABLE — " + report.reason);
  } else {
    console.log(`[page-quality] ${report.pagesChecked} page(s), ${report.totalFindings} finding(s)`
      + (report.clean.length ? `, ${report.clean.length} clean` : "")
      + (report.selfTest.allChecksFire
          ? `, all ${report.selfTest.fired.length} checks verified live`
          : `, SELF-TEST FAILED — dead check(s): ${report.selfTest.dead.join(", ")}`));
    for (const p of report.pages) {
      if (p.unreadable) { console.log(`  ${p.page}: UNREADABLE ${p.unreadable}`); continue; }
      console.log(`  ${p.page}`);
      p.findings.forEach(f => console.log(`      ${f.check}${f.line ? ":" + f.line : ""}  ${f.excerpt}`));
    }
  }
}

// ALWAYS 0. A quality finding must never fail a daily run.
process.exit(0);
