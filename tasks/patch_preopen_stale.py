"""Apply the session-aware Pre-Open Plan staleness test to a box, IDEMPOTENTLY.

Same reasoning as tasks/patch_tf_macd_flag.py: the VPS's server/index.js is PATCHED, not
copied, so an scp would silently revert whatever exists only there. Applies by exact
string match, refuses unless each anchor matches exactly once, backs up first and verifies
the backup, and no-ops if already applied.

  python tasks/patch_preopen_stale.py [--check]
"""

import io
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHECK = "--check" in sys.argv
MARKER = "staleReason"

ENGINE_HUNKS = [
    ("const PREOPEN_PLAN_STALE_MINUTES = 24 * 60;   // one trading day; the job runs daily",
     "// AN AGE-ONLY STALENESS TEST ON THIS ARTIFACT COULD NEVER FIRE. It was 24*60 while the\n"
     "// job that writes the artifact runs every 24 hours, so the age tops out around 1439\n"
     "// minutes and never crosses 1440. The STALE banner was dead code in normal operation,\n"
     "// and a day the job FAILED looked exactly like a fresh plan.\n"
     "//\n"
     "// Worse in practice: the laptop task is Interactive with WakeToRun false, so a missed\n"
     "// 13:00 local start is fired LATE by StartWhenAvailable -- measured 2026-09-02, plans\n"
     "// landed at 14:22Z, 16:07Z and 17:05Z on four days, AFTER the 13:00Z New York open.\n"
     "// A pre-open plan produced after the open is not a pre-open plan, and the old test\n"
     "// showed every one of them as fresh.\n"
     "//\n"
     "// A plan is valid until the open it precedes. After that it is history however\n"
     "// recently the file was written, so the test is the SESSION it was built for, with age\n"
     "// kept only as a backstop for a plan whose own timestamp is unusable.\n"
     "const PREOPEN_PLAN_STALE_MINUTES = 24 * 60;   // backstop only; the session test does the work"),
    ("""    const ageMinutes = Math.round((Date.now() - Date.parse(plan.generatedAt)) / 60000);
    res.json({
      available: true,
      ageMinutes,
      stale: !Number.isFinite(ageMinutes) || ageMinutes > PREOPEN_PLAN_STALE_MINUTES,
      staleAfterMinutes: PREOPEN_PLAN_STALE_MINUTES,""",
     """    const ageMinutes = Math.round((Date.now() - Date.parse(plan.generatedAt)) / 60000);

    // The session test, and the REASON, because "STALE" with no cause tells the reader
    // nothing they can act on. Ordered most specific first.
    const openAt = Date.parse(plan.nextNewYorkOpen);
    const minutesSinceOpen = Number.isFinite(openAt)
      ? Math.round((Date.now() - openAt) / 60000) : null;
    let staleReason = null;
    if (!Number.isFinite(ageMinutes)) {
      staleReason = "the plan carries no usable generatedAt";
    } else if (ageMinutes > PREOPEN_PLAN_STALE_MINUTES) {
      staleReason = "today's 12:00 UTC run did not produce a plan — this one is "
                  + Math.round(ageMinutes / 60) + "h old";
    } else if (!Number.isFinite(openAt)) {
      // Reported, not swallowed: without this field the session test cannot run at all,
      // and silently falling back to the age test is how the dead check survived.
      staleReason = "the plan carries no nextNewYorkOpen, so it cannot be checked "
                  + "against the session it was built for";
    } else if (minutesSinceOpen > 0) {
      staleReason = "the NEW YORK open it was built for was " + minutesSinceOpen
                  + " minutes ago — this describes a session already under way";
    }

    res.json({
      available: true,
      ageMinutes,
      stale: staleReason !== null,
      staleReason,
      minutesSinceOpen,
      staleAfterMinutes: PREOPEN_PLAN_STALE_MINUTES,"""),
]

DASH_HUNKS = [
    ("""      out.push('<div class="pop-unavail">This plan is ' + escapeHtml(popAgeText(d.ageMinutes))
        + ' — it describes a session that has already happened. Re-run: node tasks/preopen_plan.cjs</div>');""",
     """      // The REASON, not just the word. The endpoint now distinguishes "today's run never
      // happened" from "the open it was built for has passed" -- two different problems
      // with two different responses, and the old text asserted the second for both.
      out.push('<div class="pop-unavail">This plan is ' + escapeHtml(popAgeText(d.ageMinutes))
        + (d.staleReason ? ' — ' + escapeHtml(d.staleReason) : '')
        + '. Re-run: node tasks/preopen_plan.cjs</div>');"""),
]


def apply(rel_path, hunks):
    path = os.path.join(ROOT, rel_path)
    if not os.path.exists(path):
        print("MISSING  " + rel_path)
        return 1
    src = io.open(path, encoding="utf-8").read()
    if MARKER in src:
        print("ALREADY  " + rel_path)
        return 0
    for old, new in hunks:
        found = src.count(old)
        if found != 1:
            print("REFUSED  %s -- anchor matched %d times, expected 1:\n         %s"
                  % (rel_path, found, old.strip().splitlines()[0][:90]))
            return 1
        src = src.replace(old, new, 1)
    if CHECK:
        print("WOULD PATCH  " + rel_path)
        return 0
    backup = path + ".bak-preopen"
    if not os.path.exists(backup):
        io.open(backup, "w", encoding="utf-8", newline="").write(
            io.open(path, encoding="utf-8").read())
        if not os.path.exists(backup):
            print("REFUSED  " + rel_path + " -- backup could not be written")
            return 1
    io.open(path, "w", encoding="utf-8", newline="").write(src)
    print("PATCHED  " + rel_path + "  (backup: " + os.path.basename(backup) + ")")
    return 0


rc = 0
rc |= apply(os.path.join("server", "index.js"), ENGINE_HUNKS)
rc |= apply(os.path.join("dashboard", "index.html"), DASH_HUNKS)
sys.exit(rc)
