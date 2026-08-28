"""
One way to call the `claude` CLI from this project.

There were five call sites and four of them were broken, each in the same ways.
This module exists so the three lessons below live in exactly one place:

1. THE PROMPT GOES ON STDIN, NEVER IN ARGV.
   `claude` resolves to claude.cmd, a batch file, so Python launches it through
   cmd.exe — which truncates a multi-line argument at the first newline. Agents
   received their one-line topic and none of the data, then replied "I don't have
   the data, could you paste it?". That single bug silenced the debate engine, the
   analysis pipeline, the daily runner, the EOD review and self-improve.

2. ANTHROPIC_API_KEY IS REMOVED.
   When set, the CLI bills pay-as-you-go credit and ignores the claude.ai
   subscription. On 2026-08-03 that credit ran out and every agent died in 5-9
   seconds with "Credit balance is too low". Set SMARTENTRY_AGENT_USE_API_KEY=1 to
   opt back in deliberately. The server keeps its own key for the SDK calls in
   server/index.js; this only affects agents spawned through the CLI.

3. UNATTENDED AGENTS RUN OUTSIDE THE PROJECT, WITH --add-dir POINTING BACK IN.
   Claude Code walks up from cwd looking for CLAUDE.md. Started in the project an
   agent boots as JARVIS — persona, welcome line, and a double-confirm-before-edit
   rule — so it greets instead of answering and refuses to write its output file.
   But the CLI also scopes file tools to cwd, so an agent moved to a temp dir
   without --add-dir loses the repo and says its access is sandboxed. Both are
   needed together.

Verified end to end 2026-08-07.
"""

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta
from pathlib import Path


def make_console_utf8():
    """
    Stop a display character from killing a run.

    Agents answer in prose and use unicode freely — minus signs, em dashes, stars,
    arrows. A Windows console defaults to cp1252 and raises UnicodeEncodeError on
    all of them. `self_improve.py scan --save` died printing a star BEFORE it wrote
    its report, so the report never existed and `propose` could never run; the
    debate engine lost a full three-agent run the same way. Call this at the top of
    any script that prints agent output.
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

PROJECT_DIR = Path(__file__).parent
DEFAULT_TIMEOUT = 300

_CLAUDE_CMD = None

# ── Lesson 4: a subscription limit is a PAUSE, not a failure ──────────────────
#
# Hitting the claude.ai session limit used to destroy the job. run_claude returned
# success=False, the caller printed the error and moved on, and the brief — which is
# the expensive part, assembled from the journal, the learning file and live prices —
# was gone. The next scheduled run rebuilt it from scratch and, if the limit was still
# in force, threw it away again. Whole days of agent output were lost this way while
# every component reported itself healthy.
#
# A limited run now parks its FULL brief here and says when it can be retried.
AGENT_QUEUE_PATH = PROJECT_DIR / "tasks" / "agent_queue.jsonl"

# Phrases the CLI uses when the subscription window is exhausted. Matched only
# alongside the length check below.
#
# The weekly/monthly/daily entries are not hypothetical. On 2026-08-12 the VPS morning
# agent died on "You've hit your weekly limit - resets Aug 13, 11am (Europe/Berlin)"
# and NONE of the original markers matched it: the list only knew "session limit", and
# "resets Aug" is not "resets at". So park() refused, called a subscription ceiling a
# hard failure, and destroyed the brief — the exact bug the queue was built to fix,
# surviving in the one wording nobody had seen yet. The lesson is that this list is a
# guess about someone else's copy: keep it broad and let LIMIT_NOTICE_MAX_CHARS do the
# discriminating, because a short body is the reliable signal and the phrasing is not.
LIMIT_MARKERS = (
    "session limit",
    "usage limit",
    "rate limit",
    "weekly limit",
    "monthly limit",
    "daily limit",
    "hit your limit",
    "limit reached",
    "limit will reset",
    "resets at",
    "try again later",
    "too many requests",
)

# A limit notice is a short line. An agent that actually did its work and happened to
# discuss rate limiting in prose is not limited, and parking that output would lose a
# real answer — the opposite of the bug being fixed. Nothing longer than this is ever
# treated as a limit notice.
LIMIT_NOTICE_MAX_CHARS = 400

# Stop a permanently broken job from being retried forever. This counts REAL failures
# only — a run that came back rate-limited never got to do the work, so it must not
# burn an attempt. Counting limit hits here would have been the original bug wearing a
# different hat: six limits across a couple of days on Pro is ordinary, and the job
# would have gone permanently un-due without ever failing at anything.
MAX_QUEUE_ATTEMPTS = 6

# A brief is a snapshot of a market. Resuming a three-day-old daily proposal would
# answer a question about prices that have since moved, confidently and wrongly, so an
# expired brief is dropped rather than run. Not losing work is the goal; producing
# stale analysis and calling it work is not the same thing.
MAX_JOB_AGE_DAYS = 2

# The queue is a safety net, not a database. If it ever grows past this something is
# wrong upstream and silently hoarding briefs would hide it.
MAX_QUEUED_JOBS = 200


def looks_rate_limited(output: str, success: bool) -> bool:
    """True when this run was stopped by the subscription window rather than failing.

    Requires BOTH a known marker and a short body: a successful agent essay that
    mentions rate limiting must never be mistaken for a limit notice.
    """
    if success or not output:
        return False
    if len(output) > LIMIT_NOTICE_MAX_CHARS:
        return False
    lowered = output.lower()
    return any(marker in lowered for marker in LIMIT_MARKERS)


# A 529 is not a limit and not a broken job. It is Anthropic's servers being busy for
# a few seconds, and it is the ONLY reason both morning jobs died on 2026-08-24: the
# morning agent at 07:00 and the daily check at 07:33 each got "API Error: 529
# Overloaded", fell through to the park gate, were correctly judged "not a session
# limit", and were dropped. A whole day of the AI employee's work lost to a blip that
# would have succeeded on a retry ninety seconds later.
#
# The park gate's instinct was right — parking a genuinely broken job would retry it
# forever and hide the breakage. The gap was that it only knew two categories, limit
# and broken, and a transient upstream outage is neither.
TRANSIENT_MARKERS = (
    "api error: 529",
    "overloaded",
    "api error: 500",
    "api error: 502",
    "api error: 503",
    "api error: 504",
    "internal server error",
    "bad gateway",
    "service unavailable",
    "gateway timeout",
    "connection reset",
    "econnreset",
    "etimedout",
)

# Long enough that a busy window has passed, short enough that the morning brief is
# still about this morning. The hourly drain paces the real retry anyway; this only
# stops the very next drain from hammering an API that just said it was overloaded.
TRANSIENT_RETRY_MINUTES = 25

# The CLI cannot authenticate at all. A THIRD class, and it is neither of the other two.
#
# On 2026-08-28 the VPS daily check and morning agent both died on "Failed to
# authenticate: OAuth session expired and could not be refreshed". park() looked at that,
# found no limit marker and no transient marker, correctly said "that run was not stopped
# by the session limit" and DESTROYED THE BRIEF — which is precisely the failure the queue
# was built to prevent, surviving in the one wording nobody had seen yet. The same lesson
# as the weekly-limit gap of 2026-08-12: this list is a guess about someone else's copy.
#
# It differs from a limit in the thing that matters: a limit clears ON ITS OWN and an auth
# expiry NEVER DOES. It waits on a human. So it parks on a slow cadence rather than a
# tight one, and the message must name the action instead of saying "try later", which
# would be a lie.
AUTH_MARKERS = (
    "failed to authenticate",
    "oauth session expired",
    "could not be refreshed",
    "please run /login",
    "not logged in",
    "authentication failed",
    "invalid api key",
    "unauthorized",
)

# Six hours, not the transient 25 minutes. Nothing the machine does will fix this, so a
# tight retry would only burn attempts and fill the log while the state cannot change.
AUTH_RETRY_HOURS = 6


def looks_transient_upstream(output: str, success: bool) -> bool:
    """True when the run died on a temporary upstream fault rather than a real error.

    Same short-body discipline as looks_rate_limited and for the same reason: an agent
    that finished its work and happened to write the word "overloaded" in an essay
    about a server has not failed, and parking that output would destroy a real answer.
    """
    if success or not output:
        return False
    if len(output) > LIMIT_NOTICE_MAX_CHARS:
        return False
    lowered = output.lower()
    return any(marker in lowered for marker in TRANSIENT_MARKERS)


def looks_auth_expired(output: str, success: bool) -> bool:
    """True when the CLI could not authenticate, so no work was possible at all.

    Same short-body discipline as the two above, and for the same reason: an agent that
    finished its work and happened to discuss authentication in prose has not failed, and
    parking that output would destroy a real answer.
    """
    if success or not output:
        return False
    if len(output) > LIMIT_NOTICE_MAX_CHARS:
        return False
    lowered = output.lower()
    return any(marker in lowered for marker in AUTH_MARKERS)


MONTH_NAMES = {"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
               "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12}


def _reset_from_dated(output: str, now):
    """Reset time from a notice that names a DATE as well as a clock time.

    A weekly ceiling says "resets Aug 13, 11am" where a session one says "resets 11am".
    The time-only pattern cannot read the first form — it wants digits straight after
    "resets" and finds a month name — so without this a weekly limit parked with no
    reset time and the drain retried it hourly for a day and a half.
    """
    match = re.search(
        r"reset[a-z]*\s*(?:at\s*)?([A-Za-z]{3,9})\s+(\d{1,2})\s*,?\s*"
        r"(\d{1,2})(?::(\d{2}))?\s*(am|pm)?",
        output, re.IGNORECASE)
    if not match:
        return None
    month = MONTH_NAMES.get(match.group(1)[:3].lower())
    if not month:
        return None

    day, hour = int(match.group(2)), int(match.group(3))
    minute = int(match.group(4) or 0)
    meridiem = (match.group(5) or "").lower()
    if not 1 <= day <= 31 or not 0 <= hour <= 23 or not 0 <= minute <= 59:
        return None
    if meridiem == "pm" and hour < 12:
        hour += 12
    elif meridiem == "am" and hour == 12:
        hour = 0

    for year in (now.year, now.year + 1):
        try:
            reset = datetime(year, month, day, hour, minute)
        except ValueError:
            return None          # 31 February and friends
        if reset > now:
            return reset.isoformat()
    return None


def parse_reset_at(output: str, now=None):
    """Best-effort reset time from a limit notice, as an ISO string. None if absent.

    Two shapes, because the CLI uses both: "resets Aug 13, 11am" for a weekly ceiling
    and "resets 10:10am" for a session one. The dated form is tried first; a time
    already past today means tomorrow. Returns None rather than guessing when nothing
    parses — the drain pass then falls back to its own retry delay.
    """
    if not output:
        return None
    now = now or datetime.now()

    dated = _reset_from_dated(output, now)
    if dated:
        return dated

    # "resets tomorrow at 11am" — a word between the verb and the time, which the
    # strict pattern below cannot cross. Anchored on a literal "at" on purpose: let it
    # wander over arbitrary words without that anchor and it will happily read the 5 in
    # "limit reached, 5 attempts" as an hour. A WRONG reset time is worse than none,
    # because none simply falls back to the drain's own retry delay.
    match = re.search(
        r"reset[a-z]*\s+(?:\w+\s+){1,2}at\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?",
        output, re.IGNORECASE)
    if not match:
        match = re.search(r"reset[a-z]*\s*(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?",
                          output, re.IGNORECASE)
    if not match:
        return None

    hour = int(match.group(1))
    minute = int(match.group(2) or 0)
    meridiem = (match.group(3) or "").lower()

    if not 0 <= hour <= 23 or not 0 <= minute <= 59:
        return None
    if meridiem == "pm" and hour < 12:
        hour += 12
    elif meridiem == "am" and hour == 12:
        hour = 0

    reset = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if reset <= now:
        reset += timedelta(days=1)
    return reset.isoformat()


def _job_id(label: str, prompt: str) -> str:
    """Stable id for one brief, so a repeated run updates its row instead of adding one."""
    digest = hashlib.sha256(prompt.encode("utf-8", "replace")).hexdigest()[:16]
    return f"{label}:{digest}"


def load_queue():
    """Every parked job. [] when the file is absent or unreadable.

    A corrupt LINE is skipped, never the whole file: one bad row must not discard
    every other brief waiting behind it.
    """
    if not AGENT_QUEUE_PATH.exists():
        return []
    jobs = []
    try:
        with open(AGENT_QUEUE_PATH, "r", encoding="utf-8") as queue_file:
            for line in queue_file:
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(row, dict) and row.get("id"):
                    jobs.append(row)
    except OSError as exc:
        print(f"[agent-queue] unreadable ({exc}) — treating as empty")
        return []
    return jobs


def _write_queue(jobs):
    """Replace the queue file. Never raises — losing the net must not stop the job."""
    try:
        AGENT_QUEUE_PATH.parent.mkdir(parents=True, exist_ok=True)
        # Write-then-replace, so a crash mid-write cannot truncate the queue to nothing.
        temp_path = AGENT_QUEUE_PATH.with_suffix(".jsonl.tmp")
        with open(temp_path, "w", encoding="utf-8") as queue_file:
            for job in jobs[-MAX_QUEUED_JOBS:]:
                queue_file.write(json.dumps(job) + "\n")
        os.replace(temp_path, AGENT_QUEUE_PATH)
        return True
    except OSError as exc:
        print(f"[agent-queue] could not save ({exc}) — this brief is not protected")
        return False


def queue_job(prompt, label, timeout, needs_project, system, require, reset_at,
              is_limit=True, kind="claude", extra=None):
    """Park one brief so the limit costs a delay instead of the work. Returns the id.

    is_limit — True when the run was rate-limited (the normal case). False when it
        failed for a real reason, which is the only thing that counts toward
        MAX_QUEUE_ATTEMPTS.
    kind — which runner reproduces this brief. "claude" is run_claude here.
        "parallel" is parallel_agents.run_agent, which /engineer and /analysis use
        and which takes a per-task cwd and add_dirs that run_claude has no concept
        of: a build agent runs INSIDE the project on purpose so it boots as JARVIS,
        while an analyst runs outside so it does not. Resuming one through the wrong
        runner would silently change what the agent is.
    extra — kind-specific fields carried through the queue so the resumed run is the
        same run, not an approximation of it.
    """
    jobs = load_queue()
    job_id = _job_id(label, prompt)
    now_iso = datetime.now().isoformat()

    for job in jobs:
        if job["id"] == job_id:
            if is_limit:
                job["limitHits"] = int(job.get("limitHits", 0)) + 1
            else:
                job["attempts"] = int(job.get("attempts", 0)) + 1
            job["resetAt"] = reset_at
            job["lastSeen"] = now_iso
            _write_queue(jobs)
            return job_id

    jobs.append({
        "id":           job_id,
        "label":        label,
        "kind":         kind,
        "prompt":       prompt,
        "timeout":      timeout,
        "needsProject": needs_project,
        "system":       system,
        "require":      require,
        "extra":        extra or {},
        "resetAt":      reset_at,
        "attempts":     0 if is_limit else 1,
        "limitHits":    1 if is_limit else 0,
        "queuedAt":     now_iso,
        "lastSeen":     now_iso,
    })
    _write_queue(jobs)
    return job_id


def job_is_stale(job, now=None):
    """Has this brief aged past the market it describes?"""
    now = now or datetime.now()
    try:
        queued = datetime.fromisoformat(job.get("queuedAt", ""))
    except (TypeError, ValueError):
        return False   # unparseable timestamp is not evidence of staleness
    return (now - queued) > timedelta(days=MAX_JOB_AGE_DAYS)


def drop_job(job_id):
    """Remove one finished brief from the queue."""
    jobs = [job for job in load_queue() if job["id"] != job_id]
    _write_queue(jobs)


def job_is_due(job, now=None):
    """Is this brief allowed to run yet?"""
    now = now or datetime.now()
    if int(job.get("attempts", 0)) >= MAX_QUEUE_ATTEMPTS:
        return False
    reset_at = job.get("resetAt")
    if not reset_at:
        return True  # nothing parsed a time — let the caller's schedule pace it
    try:
        return datetime.fromisoformat(reset_at) <= now
    except (TypeError, ValueError):
        return True


def _resume(job):
    """Re-run one parked brief through the runner that produced it.

    A /engineer build agent and an /analysis analyst both come from
    parallel_agents.run_agent and carry a cwd and add_dirs that decide whether the
    agent boots as JARVIS or as a plain worker. Resuming those through run_claude
    would quietly turn one into the other, so they go back the way they came.
    """
    kind = job.get("kind", "claude")

    if kind == "parallel":
        extra = job.get("extra") or {}
        # Imported here, not at module scope: parallel_agents imports this module for
        # the queue, so a top-level import would be circular.
        try:
            from parallel_agents import run_agent
        except ImportError as exc:
            return {"label": job["label"], "output": f"[cannot resume: {exc}]",
                    "success": False, "elapsed": 0.0, "limited": False, "resetAt": None}
        result = run_agent({
            "label":    job["label"],
            "prompt":   job["prompt"],
            "cwd":      extra.get("cwd"),
            "add_dirs": extra.get("addDirs") or [],
            "system":   job.get("system"),
            "_from_queue": True,      # stop it re-parking itself; drain owns the row
        })
        output = result.get("output", "")
        success = bool(result.get("success"))
        limited = looks_rate_limited(output, success)
        return {**result,
                "limited": limited,
                "resetAt": parse_reset_at(output) if limited else None}

    return run_claude(
        job["prompt"],
        timeout=int(job.get("timeout") or DEFAULT_TIMEOUT),
        needs_project=bool(job.get("needsProject", True)),
        system=job.get("system"),
        label=job["label"],
        require=job.get("require"),
        persist_on_limit=False,      # drain owns the row; run_claude must not duplicate it
    )


def drain_queue(verbose=True):
    """Re-run every parked brief that is due. Returns a per-job summary.

    Called by the scheduled runner. A job that succeeds leaves the queue; one that is
    limited again stays with a fresh reset time; one that fails for any other reason
    keeps its attempt count and is dropped once MAX_QUEUE_ATTEMPTS is reached, because
    at that point it is not a limit and retrying forever hides a real fault.
    """
    jobs = load_queue()
    if not jobs:
        if verbose:
            print("[agent-queue] empty — nothing to resume")
        return []

    summary = []
    for job in list(jobs):
        if job_is_stale(job):
            drop_job(job["id"])
            summary.append({"label": job["label"], "status": "stale-dropped",
                            "queuedAt": job.get("queuedAt")})
            print(f"[agent-queue] {job['label']} was queued {job.get('queuedAt')} and is "
                  f"older than {MAX_JOB_AGE_DAYS} days — dropped rather than answering a "
                  f"question about prices that have since moved.")
            continue

        if not job_is_due(job):
            summary.append({"label": job["label"], "status": "waiting",
                            "resetAt": job.get("resetAt"),
                            "attempts": job.get("attempts", 0)})
            continue

        if verbose:
            print(f"[agent-queue] resuming {job['label']} "
                  f"(attempt {int(job.get('attempts', 0)) + 1})")

        result = _resume(job)

        if result["success"]:
            drop_job(job["id"])
            summary.append({"label": job["label"], "status": "done",
                            "elapsed": result["elapsed"],
                            "output": result["output"]})
            continue

        attempts = int(job.get("attempts", 0)) + 1
        if result.get("limited"):
            # Still limited: refresh the reset time, do NOT burn an attempt. The job
            # never ran, so it has not failed at anything.
            queue_job(job["prompt"], job["label"], job.get("timeout"),
                      job.get("needsProject", True), job.get("system"),
                      job.get("require"), result.get("resetAt"), is_limit=True,
                      kind=job.get("kind", "claude"), extra=job.get("extra"))
            summary.append({"label": job["label"], "status": "still-limited",
                            "resetAt": result.get("resetAt")})
        elif attempts >= MAX_QUEUE_ATTEMPTS:
            drop_job(job["id"])
            summary.append({"label": job["label"], "status": "abandoned",
                            "attempts": attempts, "output": result["output"][:200]})
            print(f"[agent-queue] {job['label']} failed {attempts}x and is NOT a limit "
                  f"— dropped. Last error: {result['output'][:200]}")
        else:
            job["attempts"] = attempts
            job["lastSeen"] = datetime.now().isoformat()
            _write_queue(jobs)
            summary.append({"label": job["label"], "status": "retry-later",
                            "attempts": attempts})

    return summary


def find_claude() -> str:
    """Locate the claude CLI — PATH first, then the standard npm global install."""
    found = shutil.which("claude") or shutil.which("claude.cmd")
    if found:
        return found

    appdata = os.environ.get("APPDATA", "")
    if appdata:
        candidate = Path(appdata) / "npm" / "claude.cmd"
        if candidate.exists():
            return str(candidate)

    fallback = Path(r"C:\Users\User\AppData\Roaming\npm\claude.cmd")
    if fallback.exists():
        return str(fallback)

    raise FileNotFoundError(
        "claude CLI not found. Run: npm install -g @anthropic-ai/claude-code"
    )


def claude_cmd() -> str:
    global _CLAUDE_CMD
    if _CLAUDE_CMD is None:
        _CLAUDE_CMD = find_claude()
    return _CLAUDE_CMD


def agent_env() -> dict:
    """Environment for a nested CLI call — see lesson 2 above."""
    env = {**os.environ, "NO_COLOR": "1"}
    if os.environ.get("SMARTENTRY_AGENT_USE_API_KEY") != "1":
        env.pop("ANTHROPIC_API_KEY", None)
    return env


def neutral_cwd() -> str:
    """A working directory outside the project, so no CLAUDE.md is found."""
    path = Path(tempfile.gettempdir()) / "smartentry_agents"
    path.mkdir(parents=True, exist_ok=True)
    return str(path)


def run_claude(prompt,
               timeout=DEFAULT_TIMEOUT,
               needs_project=True,
               system=None,
               label="agent",
               require=None,
               persist_on_limit=True):
    """
    Run one agent and return {output, success, elapsed, limited, resetAt}.

    needs_project — True (default) gives the agent read/write access to the repo
        via --add-dir while still running outside it, which is what almost every
        job here wants: analyse the codebase without becoming JARVIS. Set False
        for agents whose prompt already carries all their context.
    require — a string that must appear in the output for the run to count as a
        success. A clean exit code proves nothing: the debate agents all exited 0
        while answering "I don't have the trade to analyse".
    persist_on_limit — park the brief in the queue when the subscription window is
        exhausted, so the limit costs a delay and not the work. See lesson 4.
    """
    import time
    started = time.time()

    argv = [claude_cmd(), "-p",
            "--dangerously-skip-permissions",
            "--output-format", "text"]
    if system:
        argv += ["--append-system-prompt", system]
    if needs_project:
        argv += ["--add-dir", str(PROJECT_DIR)]

    try:
        proc = subprocess.run(
            argv,
            input=prompt,                 # lesson 1 — never argv
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            cwd=neutral_cwd(),            # lesson 3
            timeout=timeout,
            env=agent_env(),              # lesson 2
        )
        output = (proc.stdout or "").strip() or (proc.stderr or "").strip()
        success = proc.returncode == 0
    except subprocess.TimeoutExpired:
        output, success = f"[TIMEOUT after {timeout}s]", False
    except FileNotFoundError:
        output, success = "[ERROR: claude CLI not found]", False

    if success and require and require.upper() not in output.upper():
        success = False
        output = f"[INCOMPLETE: no {require!r} in response]\n\n{output}"

    # A subscription limit is a pause, not a failure. Park the brief before returning,
    # because the caller's next move is to discard it.
    limited = looks_rate_limited(output, success)
    reset_at = parse_reset_at(output) if limited else None
    if limited and persist_on_limit:
        queue_job(prompt, label, timeout, needs_project, system, require, reset_at)
        when = reset_at or "unknown — will retry on the next drain"
        print(f"[agent-queue] {label} hit the subscription limit. Brief saved, "
              f"resumes after {when}. Nothing was lost.")

    return {
        "label": label,
        "output": output,
        "success": success,
        "elapsed": time.time() - started,
        "limited": limited,
        "resetAt": reset_at,
    }


def _print_status():
    """What is parked, and when each brief can run again."""
    jobs = load_queue()
    if not jobs:
        print("Agent queue empty — no work is waiting.")
        return
    print(f"{len(jobs)} brief(s) parked:")
    now = datetime.now()
    for job in jobs:
        if job_is_stale(job, now):
            due = f"STALE (queued {job.get('queuedAt')}) — will be dropped on next drain"
        elif job_is_due(job, now):
            due = "DUE NOW"
        else:
            due = f"waits until {job.get('resetAt')}"
        print(f"  {job['label']:<20} limits={job.get('limitHits', 0)} "
              f"failures={job.get('attempts', 0)}/{MAX_QUEUE_ATTEMPTS}  {due}"
              f"  ({len(job.get('prompt', ''))} chars of brief held)")


if __name__ == "__main__":
    make_console_utf8()
    command = sys.argv[1] if len(sys.argv) > 1 else "status"

    if command in ("--status", "status"):
        _print_status()
    elif command in ("--drain", "drain"):
        results = drain_queue()
        for entry in results:
            print(f"  {entry['label']:<20} {entry['status']}")
        if not results:
            print("Nothing was due.")
    elif command in ("--park", "park"):
        # Park a brief that a scheduled .bat could not finish because the
        # subscription window closed. queue_job has existed since 2026-08-06 and
        # nothing outside this file could reach it, so the weekly review has been
        # writing a 136-byte "You've hit your session limit" stub and exiting 1 —
        # the work simply lost, once a week, with the queue sitting right there.
        #
        # The prompt arrives on STDIN, never argv: cmd.exe truncates an argument at
        # the first newline, which is the single cause of every dead AI job on this
        # machine, and run_claude feeds its own prompts the same way for the same
        # reason.
        label = sys.argv[2] if len(sys.argv) > 2 else "unlabelled brief"
        output_path = None
        if "--output-file" in sys.argv:
            idx = sys.argv.index("--output-file")
            if idx + 1 < len(sys.argv):
                output_path = sys.argv[idx + 1]

        prompt = sys.stdin.read().strip()
        if not prompt:
            print("park: nothing on stdin — a brief with no prompt cannot be resumed")
            sys.exit(1)

        run_output = ""
        if output_path:
            try:
                with open(output_path, "r", encoding="utf-8", errors="replace") as handle:
                    run_output = handle.read()
            except OSError as exc:
                print(f"park: could not read {output_path} ({exc})")

        # Only park a genuine limit or a transient upstream fault. Parking a real
        # failure would retry a broken job forever and hide the breakage, which is the
        # opposite of the point.
        is_limit_run = looks_rate_limited(run_output, success=False)
        is_transient = (not is_limit_run) and looks_transient_upstream(
            run_output, success=False)
        is_auth = (not is_limit_run) and (not is_transient) and looks_auth_expired(
            run_output, success=False)

        if output_path and not is_limit_run and not is_transient and not is_auth:
            print("park: that run was not stopped by the session limit — not queued")
            sys.exit(2)

        # A transient fault burns an attempt where a limit does not. Six of them and
        # MAX_QUEUE_ATTEMPTS stops the job, because at that point "temporary" was the
        # wrong diagnosis and something really is broken.
        if is_transient:
            reset_at = (datetime.now()
                        + timedelta(minutes=TRANSIENT_RETRY_MINUTES)).isoformat()
        elif is_auth:
            reset_at = (datetime.now() + timedelta(hours=AUTH_RETRY_HOURS)).isoformat()
        else:
            reset_at = parse_reset_at(run_output)

        job_id = queue_job(
            prompt=prompt,
            label=label,
            timeout=DEFAULT_TIMEOUT,
            needs_project=True,
            system=None,
            require=None,
            reset_at=reset_at,
            # is_limit spares the attempt counter. An auth expiry is like a limit in that
            # respect - nothing the machine does is wrong, so burning attempts toward
            # MAX_QUEUE_ATTEMPTS would abandon a perfectly good brief for waiting.
            is_limit=not is_transient,
        )
        why = ("upstream was overloaded" if is_transient
               else "the CLI could not authenticate" if is_auth
               else "the session limit was hit")
        print(f"park: queued {label} as {job_id} — {why}; the next drain resumes it")

        if is_auth:
            # SAVE THE WORK, KEEP THE ALARM. Exiting 0 here would let auto_daily's
            # `if not errorlevel 1 set CLAUDE_RC=0` clear the task to green, and the box
            # would report healthy while having no AI at all - the exact "green check
            # over a dead component" this project keeps being bitten by. A limit clears
            # itself and deserves the green; this does not and must not get it.
            print("park: AUTHENTICATION EXPIRED - no agent can run on this box until a "
                  "human re-authenticates. The brief is SAVED, not lost.")
            print(f"park: fix it by running `claude` on this machine and signing in; "
                  f"the queued brief resumes on the next drain after that.")
            print("park: exiting 3 so the scheduled task stays RED - this needs a person, "
                  "not a retry.")
            sys.exit(3)
    else:
        print("Usage: python claude_agent.py [status|drain|park <label> [--output-file PATH]]")
        sys.exit(1)
