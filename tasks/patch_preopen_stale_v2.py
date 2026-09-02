"""Bring a box to the THREE-STATE Pre-Open Plan freshness test (fresh / past-open / overdue).

Supersedes tasks/patch_preopen_stale.py, whose two-state version folded past-open into
stale and would have shown the yellow banner 95.8% of the time -- a warning that is almost
never off is one you learn to skim past, which is the failure it was meant to fix.

It works from the .bak-preopen backups the v1 patcher wrote, restoring the untouched
originals before applying v2, so a box that has v1 and a box that has neither both end up
identical. The replacement blocks are EXTRACTED VERBATIM from the reference box into
tasks/_preopen_v2_blocks.json rather than retyped -- a transcription slip in a patch
script produces two boxes that look patched and behave differently, which is the exact
divergence vps_parity.cjs exists to catch.

  python tasks/patch_preopen_stale_v2.py [--check]
"""

import io
import json
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHECK = "--check" in sys.argv
MARKER = "past-open"

BLOCKS = json.load(io.open(os.path.join(ROOT, "tasks", "_preopen_v2_blocks.json"),
                           encoding="utf-8"))

ORIG_CONST = ("const PREOPEN_PLAN_STALE_MINUTES = 24 * 60;   "
              "// one trading day; the job runs daily")
ORIG_LADDER = """    res.json({
      available: true,
      ageMinutes,
      stale: !Number.isFinite(ageMinutes) || ageMinutes > PREOPEN_PLAN_STALE_MINUTES,
      staleAfterMinutes: PREOPEN_PLAN_STALE_MINUTES,"""
ORIG_REASON = ('        reason: "no plan artifact yet — runs daily at 12:00 UTC, '
               'or: node tasks/preopen_plan.cjs",')
ORIG_HEADER = "// ── /api/preopen-plan — the plan the 12:00 UTC job produced ─────────────────"
NEW_HEADER = "// ── /api/preopen-plan — the plan the daily pre-open job produced ────────────"

ORIG_BADGE = """    ageEl.innerHTML = 'built ' + escapeHtml(popAgeText(d.ageMinutes)) + ' · gate ' + p.gate
      + (d.stale ? ' · <span style="color:var(--yellow);font-weight:700">STALE</span>' : '');"""
ORIG_BANNER = """    if (d.stale) {
      out.push('<div class="pop-unavail">This plan is ' + escapeHtml(popAgeText(d.ageMinutes))
        + ' — it describes a session that has already happened. Re-run: node tasks/preopen_plan.cjs</div>');
    }"""
ORIG_RENDER_COMMENT = "// Renders the artifact written at 12:00 UTC, one hour before the NEW YORK open."
NEW_RENDER_COMMENT = (
    "// Renders the artifact written about an hour before the NEW YORK open. NOT \"12:00 UTC\":\n"
    "// tasks/reschedule_preopen.ps1 moves the trigger nightly to keep that hour clear of\n"
    "// high-impact news, so any fixed hour written here is wrong on the days it matters most.")
ORIG_FOOT = ("      + ' UTC by the 12:00 UTC job, one hour before the NEW YORK open. "
             "Every figure is read live or from '")
NEW_FOOT = ("      + ' UTC by the daily pre-open job, about an hour before the NEW YORK open — the exact '\n"
            "      + 'slot moves nightly to keep that hour clear of high-impact news. "
            "Every figure is read live or from '")

PLAN = {
    os.path.join("server", "index.js"): [
        (ORIG_HEADER, NEW_HEADER),
        (ORIG_CONST, BLOCKS["eng_const"]),
        (ORIG_LADDER, BLOCKS["eng_ladder"]),
        (ORIG_REASON, BLOCKS["eng_reason"]),
    ],
    os.path.join("dashboard", "index.html"): [
        (ORIG_RENDER_COMMENT, NEW_RENDER_COMMENT),
        (ORIG_BADGE, BLOCKS["dash_badge"]),
        (ORIG_BANNER, BLOCKS["dash_banner"]),
        (ORIG_FOOT, NEW_FOOT),
    ],
}


def restore_original(path):
    """Put the pre-v1 file back, so v2 applies to a known state. Never deletes: the v1
    file is copied aside first, so nothing that existed is unrecoverable."""
    backup = path + ".bak-preopen"
    if not os.path.exists(backup):
        return True          # never had v1; already original
    v1_kept = path + ".bak-preopen-v1"
    if not os.path.exists(v1_kept):
        shutil.copyfile(path, v1_kept)
        if not os.path.exists(v1_kept):
            print("REFUSED  could not preserve the v1 file at " + os.path.basename(v1_kept))
            return False
    shutil.copyfile(backup, path)
    return True


def apply(rel_path, hunks):
    path = os.path.join(ROOT, rel_path)
    if not os.path.exists(path):
        print("MISSING  " + rel_path)
        return 1
    if MARKER in io.open(path, encoding="utf-8").read():
        print("ALREADY  " + rel_path)
        return 0
    if not CHECK and not restore_original(path):
        return 1
    src = io.open(path, encoding="utf-8").read()
    if CHECK and MARKER not in src:
        # Report against the ORIGINAL, which is what the real run will patch.
        backup = path + ".bak-preopen"
        if os.path.exists(backup):
            src = io.open(backup, encoding="utf-8").read()
    for old, new in hunks:
        found = src.count(old)
        if found != 1:
            print("REFUSED  %s -- anchor matched %d times, expected 1:\n         %s"
                  % (rel_path, found, old.strip().splitlines()[0][:88]))
            return 1
        src = src.replace(old, new, 1)
    if CHECK:
        print("WOULD PATCH  " + rel_path)
        return 0
    io.open(path, "w", encoding="utf-8", newline="").write(src)
    print("PATCHED  " + rel_path)
    return 0


rc = 0
for rel, hunks in PLAN.items():
    rc |= apply(rel, hunks)
sys.exit(rc)
