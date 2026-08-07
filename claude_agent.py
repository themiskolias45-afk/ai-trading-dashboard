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

import os
import shutil
import subprocess
import sys
import tempfile
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
               require=None):
    """
    Run one agent and return {output, success, elapsed}.

    needs_project — True (default) gives the agent read/write access to the repo
        via --add-dir while still running outside it, which is what almost every
        job here wants: analyse the codebase without becoming JARVIS. Set False
        for agents whose prompt already carries all their context.
    require — a string that must appear in the output for the run to count as a
        success. A clean exit code proves nothing: the debate agents all exited 0
        while answering "I don't have the trade to analyse".
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

    return {
        "label": label,
        "output": output,
        "success": success,
        "elapsed": time.time() - started,
    }
