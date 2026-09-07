/* ============================================================================
   WEEKLY REPORT INDEX — turn the weekly review into something a page can read
   ============================================================================

   WHY THIS EXISTS

   The weekly review is the deepest analysis this system produces. It scores its
   own past calls, ranks assets in R rather than lot-weighted dollars, and has
   caught things no dashboard did — BB_SQUEEZE_WATCH's 6.57 implied R:R turning
   out to be a $42.42 stop against a $67.24 ATR, a stop too tight to survive the
   instrument's own noise.

   It writes tasks/logs/weekly_YYYYMMDD.txt and NOTHING HAS EVER READ THE CONTENT.
   Two things touch those files and neither opens them for what they say:
   ai_work_ledger.js matches the FILENAME to prove the job ran, and
   plan_coverage.cjs counts them. A writer with no reader is the failure this
   system keeps paying for, and this is the largest instance of it left.

   WHAT IT DOES

   Reads every weekly_*.txt, parses it into structure, and writes ONE artifact:
   dashboard/weekly-latest.json. The dashboard directory is already served by
   express.static, so the page needs no route and the server needs no restart —
   which is the whole reason it is built this way rather than as an endpoint.

   IT IS READ-ONLY OVER THE LOGS. It opens them, it never writes, moves, renames
   or truncates one. The single file it creates is its own output.

   WHAT IT REFUSES TO HIDE

   - Every report carries an `outcome`, because these are four different things
     and collapsing them loses the one that matters:
       analysis — structure was found and parsed
       prose    — there IS content, in a shape this parser does not know
       parked   — the run stopped on a limit or a sign-in, and said so
       empty    — the file holds nothing but its own header
     A PARKED run is not a failed one, and a week with no analysis must look
     different from a week that was never indexed.
   - A MALFORMED date is kept and flagged. weekly_20262607.txt carries month 26;
     plan_coverage.cjs already documents it. It is reported as unparseable rather
     than coerced into a date that would silently sort wrong.
   - The RAW text of every report travels with the parse, so the page can always
     show the original. A parser that drops what it did not understand is how a
     summary starts lying about its source.

   Usage: node tasks/weekly_report_index.cjs [--out <path>] [--quiet]
   ============================================================================ */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const LOG_DIR = path.join(ROOT, "tasks", "logs");
const DEFAULT_OUT = path.join(ROOT, "dashboard", "weekly-latest.json");

function opt(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const OUT = opt("--out", DEFAULT_OUT);
const QUIET = process.argv.includes("--quiet");

/* Both shapes the weekly job has produced. The `_review` suffix is not a
   different kind of report — auto_weekly.bat records that one week's delivery
   landed there instead, and the analysis was fine. Both are indexed. */
const WEEKLY_FILE = /^weekly_(\d{8})(_review)?\.txt$/;

/** A weekly filename carries YYYYMMDD, except when it does not.
 *  Returns the ISO date, or null plus the reason — never a guess. */
function parseStamp(stamp) {
  const year = Number(stamp.slice(0, 4));
  const month = Number(stamp.slice(4, 6));
  const day = Number(stamp.slice(6, 8));
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return { iso: null, warning: `filename stamp ${stamp} is not a valid date (month ${month}, day ${day})` };
  }
  const at = new Date(Date.UTC(year, month - 1, day));
  if (isNaN(at.getTime())) return { iso: null, warning: `filename stamp ${stamp} did not parse` };
  return { iso: at.toISOString().slice(0, 10), warning: null };
}

/* "SCORED CALL: morning-hmynxq right — <verification>". The verdict is the
   agent grading its OWN earlier proposal against the code as it stands now,
   which is the part worth surfacing: a proposal nobody scored is an opinion. */
const SCORED_CALL = /^SCORED CALL:\s*(\S+)\s+(right|wrong|partly right|unproven|unscored)\b\s*[—–-]*\s*(.*)$/i;

/* Section headers. The weekly job has emitted THREE different shapes across its
   life and a parser that knows only the newest silently reports the older ones
   as empty — which this one did on its first run, calling two 2.6KB reports
   blank. All three are matched:

     "1) WEEK (2026-08-16 → 08-23): 1 closed fill …"     plain numbered
     "**1. Trade summary**"                              markdown numbered
     "## SCORED CALL"                                    markdown heading

   Sections run to the next header, the review banner, or end of file.

   A heading may carry trailing text after its closing `**` — section 3 of the
   2026-08-17 report is "**3. avgRR vs avgRealizedR** (from `/api/stats/by-setup`,
   lifetime n=4)", and anchoring the close to end-of-line dropped that whole
   section on the floor. The trailing remainder is kept and becomes the body. */
const SECTION_START = /^(\d)\)\s*(.+)$/;
const SECTION_MD_NUM = /^\*\*(\d+)[.)]\s*(.+?)\*\*\s*(.*)$/;
const SECTION_MD_HEAD = /^#{2,3}\s+(.+?)\s*$/;
const SECTION_MD_BOLD = /^\*\*(.+?)\*\*\s*(.*)$/;
const REVIEW_BANNER = /^===\s*(.+?)\s*===$/;

/* A run that stopped because the account hit its limit is PARKED, not failed —
   the distinction is load-bearing everywhere else in this system and must not
   be lost here. weekly_20260809.txt is 136 bytes and is exactly this. */
const PARKED_SIGNATURE = /(session limit|usage limit|weekly limit|rate limit|resets? \d|Claude usage|not logged in|credit balance)/i;

/** Split a section's first line into a short title and the body it introduces.
 *  The reports are not consistent about the separator — some use an em dash,
 *  some a colon, some neither — so the split is attempted in that order and
 *  falls back to using the whole line as the body with a generic title. */
function splitTitle(text) {
  for (const sep of [" — ", " – ", ": "]) {
    const at = text.indexOf(sep);
    if (at > 0 && at <= 80) {
      return { title: text.slice(0, at).trim(), body: text.slice(at + sep.length).trim() };
    }
  }
  if (text.length <= 80) return { title: text.trim(), body: "" };
  return { title: text.slice(0, 60).trim() + "…", body: text.trim() };
}

function parseReport(fileName, fullPath) {
  const stat = fs.statSync(fullPath);
  const raw = fs.readFileSync(fullPath, "utf8");
  const match = WEEKLY_FILE.exec(fileName);
  const { iso, warning } = parseStamp(match[1]);

  const lines = raw.split(/\r?\n/);
  const scoredCalls = [];
  const sections = [];
  let reviewBanner = null;
  let current = null;

  const closeCurrent = () => {
    if (!current) return;
    current.body = current.body.trim();
    sections.push(current);
    current = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();

    const call = SCORED_CALL.exec(trimmed);
    if (call) {
      closeCurrent();
      scoredCalls.push({
        id: call[1],
        verdict: call[2].toLowerCase(),
        detail: call[3].trim(),
      });
      continue;
    }

    const banner = REVIEW_BANNER.exec(trimmed);
    if (banner) {
      closeCurrent();
      // "=========" separators match nothing useful; only a titled banner counts.
      if (!/^=+$/.test(banner[1])) reviewBanner = banner[1];
      continue;
    }

    const start = SECTION_START.exec(trimmed);
    if (start) {
      closeCurrent();
      const { title, body } = splitTitle(start[2]);
      current = { number: Number(start[1]), title, body };
      continue;
    }

    const mdNum = SECTION_MD_NUM.exec(trimmed);
    if (mdNum) {
      closeCurrent();
      current = { number: Number(mdNum[1]), title: mdNum[2].trim(), body: (mdNum[3] || "").trim() };
      continue;
    }

    const mdHead = SECTION_MD_HEAD.exec(trimmed);
    if (mdHead) {
      closeCurrent();
      current = { number: null, title: mdHead[1].trim(), body: "" };
      continue;
    }

    // A lone bold line is a heading only when it is short. A bolded SENTENCE
    // inside a paragraph is emphasis, and promoting it to a section would chop
    // the analysis in half at the author's strongest claim.
    const mdBold = SECTION_MD_BOLD.exec(trimmed);
    if (mdBold && mdBold[1].length <= 60 && !current) {
      closeCurrent();
      current = { number: null, title: mdBold[1].trim(), body: (mdBold[2] || "").trim() };
      continue;
    }

    if (current) current.body += (current.body ? "\n" : "") + line;
  }
  closeCurrent();

  /* Three outcomes, and they are NOT the same thing:
       analysis — structure was found and parsed
       parked   — the run stopped on a limit or a sign-in, and said so
       empty    — the file holds nothing but its own header

     The first version of this collapsed the last two into "empty" and reported
     a 2.6KB markdown report as blank. `prose` carries the case where there IS
     content but no shape this parser recognises: the page renders the raw text
     rather than an empty panel, because unparsed is not the same as absent. */
  const bodyText = lines
    .filter(l => !/^=+\s*$/.test(l.trim()) && !/^Weekly Analysis/i.test(l.trim()))
    .join("\n").trim();

  let outcome = "analysis";
  let parkedReason = null;
  if (scoredCalls.length === 0 && sections.length === 0) {
    const parked = PARKED_SIGNATURE.exec(bodyText);
    if (parked && bodyText.length < 400) {
      outcome = "parked";
      parkedReason = bodyText;
    } else if (bodyText.length < 40) {
      outcome = "empty";
    } else {
      outcome = "prose";
    }
  }

  return {
    file: fileName,
    date: iso,
    dateWarning: warning,
    isReviewVariant: Boolean(match[2]),
    bytes: stat.size,
    modified: stat.mtime.toISOString(),
    reviewBanner,
    scoredCalls,
    sections,
    outcome,
    parkedReason,
    // Kept so a "prose" report still has something to render, and so any
    // report can be checked against what the parser made of it.
    bodyText,
    // The original, always. The page offers it so a reader can check the parse.
    raw,
  };
}

function build() {
  let names;
  try {
    names = fs.readdirSync(LOG_DIR);
  } catch (e) {
    return { generatedAt: new Date().toISOString(), available: false,
             reason: `could not read ${path.relative(ROOT, LOG_DIR)}: ${e.message}`, reports: [] };
  }

  const reports = [];
  const unreadable = [];
  for (const name of names.filter(n => WEEKLY_FILE.test(n))) {
    try {
      reports.push(parseReport(name, path.join(LOG_DIR, name)));
    } catch (e) {
      // One bad file must not cost the whole index. It is named, not dropped.
      unreadable.push({ file: name, error: e.message });
    }
  }

  // Newest first. A report whose filename date is unparseable still has an mtime,
  // which is what it is sorted by — it is never silently dropped to the bottom.
  reports.sort((a, b) => (b.date || b.modified.slice(0, 10)).localeCompare(a.date || a.modified.slice(0, 10)));

  const newest = reports[0] || null;
  const ageDays = newest
    ? Math.floor((Date.now() - Date.parse(newest.modified)) / 86400000)
    : null;

  const totals = reports.reduce((acc, r) => {
    acc.scoredCalls += r.scoredCalls.length;
    acc.right += r.scoredCalls.filter(c => c.verdict === "right").length;
    acc.wrong += r.scoredCalls.filter(c => c.verdict === "wrong").length;
    acc[r.outcome] = (acc[r.outcome] || 0) + 1;
    return acc;
  }, { scoredCalls: 0, right: 0, wrong: 0, analysis: 0, prose: 0, parked: 0, empty: 0 });

  return {
    generatedAt: new Date().toISOString(),
    available: reports.length > 0,
    source: "tasks/logs/weekly_*.txt",
    // The review runs Sunday; past 8 days the newest report describes a week
    // that has already been overtaken, and the page says so rather than
    // presenting stale analysis as current.
    staleAfterDays: 8,
    ageDays,
    totals,
    unreadable,
    reports,
    feedsTheGate: false,
  };
}

const index = build();
fs.writeFileSync(OUT, JSON.stringify(index, null, 2));
if (!QUIET) {
  console.log(`[weekly-index] ${index.reports.length} report(s), `
    + `${index.totals.scoredCalls} scored call(s) (${index.totals.right} right / ${index.totals.wrong} wrong), `
    + `${index.totals.parked} parked, ${index.totals.prose} prose, ${index.totals.empty} empty, newest ${index.ageDays}d old`);
  if (index.unreadable.length) {
    console.log(`[weekly-index] UNREADABLE: ${index.unreadable.map(u => u.file + " (" + u.error + ")").join(", ")}`);
  }
  console.log(`[weekly-index] wrote ${path.relative(ROOT, OUT)}`);
}
