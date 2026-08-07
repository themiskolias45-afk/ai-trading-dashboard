"""
JARVIS Parallel Agent Engine
Spawns multiple Claude agents simultaneously for complex tasks.
Uses your existing Claude Pro subscription — no API key needed.

Usage:
  python parallel_agents.py "task1" "task2" "task3"
  python parallel_agents.py --file tasks.json
  python parallel_agents.py --plan "build a complete alert system with webhook + MT5 + Telegram"

Examples:
  # Run 3 analysts in parallel
  python parallel_agents.py \
    "Analyze BTC 4H structure and identify key S/R levels" \
    "Analyze GOLD daily bias and momentum" \
    "Analyze SPX market regime and risk-off signals"

  # Use a task file (JSON array of {label, prompt})
  python parallel_agents.py --file tasks/engineer_tasks.json
"""

import sys, json, subprocess, time, os
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

WORK_DIR  = Path(__file__).parent
MAX_AGENTS = 8
TIMEOUT    = 300

def find_claude() -> str:
    """Find the claude CLI executable on Windows."""
    import shutil, os
    # 1. Already on PATH
    found = shutil.which("claude") or shutil.which("claude.cmd")
    if found:
        return found
    # 2. Standard npm global install — uses %APPDATA% env var
    appdata = os.environ.get("APPDATA", "")
    if appdata:
        p = Path(appdata) / "npm" / "claude.cmd"
        if p.exists():
            return str(p)
    # 3. Hardcoded known path
    p = Path(r"C:\Users\User\AppData\Roaming\npm\claude.cmd")
    if p.exists():
        return str(p)
    raise FileNotFoundError(
        "claude CLI not found. Run: npm install -g @anthropic-ai/claude-code"
    )

CLAUDE_CMD = None  # resolved lazily on first use

def agent_env() -> dict:
    """Environment for a nested `claude` CLI call.

    ANTHROPIC_API_KEY is REMOVED, and that is the whole point. When it is set the
    CLI bills pay-as-you-go API credit and ignores the claude.ai subscription — it
    even says so on every run: "claude.ai connectors are disabled because
    ANTHROPIC_API_KEY or another auth source is set and takes precedence over your
    claude.ai login". On 2026-08-03 that credit ran out and all five analysts plus
    both synthesiser attempts died in 5-9 seconds with "Credit balance is too low",
    while the same prompt with the key unset returned normally. A whole analysis run
    was lost to a billing route nobody chose.

    The server keeps its own ANTHROPIC_API_KEY for the SDK calls in server/index.js;
    this only affects agents spawned through the CLI. Set
    SMARTENTRY_AGENT_USE_API_KEY=1 to restore the old behaviour deliberately.
    """
    env = {**os.environ, "NO_COLOR": "1"}
    if os.environ.get("SMARTENTRY_AGENT_USE_API_KEY") != "1":
        env.pop("ANTHROPIC_API_KEY", None)
    return env


def run_agent(task: dict) -> dict:
    """Run one agent.

    Optional task keys:
      cwd    — working directory for the agent. Defaults to the project, which
               means the agent loads this project's CLAUDE.md and adopts the
               JARVIS persona along with its "double-confirm before any edit"
               rule. That is correct for build agents and fatal for unattended
               ones, which then greet instead of answering and refuse to write
               their own output file. Point this outside the project to get a
               plain agent.
      add_dirs — extra directories the agent may read and write. REQUIRED whenever
               cwd is outside the project: the CLI scopes file tools to the
               working directory, so an agent moved to a temp dir to escape
               CLAUDE.md loses access to the project and answers "my file access
               here is sandboxed to the Temp directory only" instead of doing the
               work. Verified 2026-08-02: temp cwd + --add-dir <project> reads
               project files, writes its output file, and replies exactly DONE.
      system — extra system prompt, appended to the agent's own.
    """
    label    = task.get("label", "Agent")
    prompt   = task["prompt"]
    ctx      = task.get("context", "")
    cwd      = task.get("cwd") or str(WORK_DIR)
    system   = task.get("system")
    add_dirs = task.get("add_dirs") or []

    full_prompt = f"{ctx}\n\n{prompt}".strip() if ctx else prompt

    global CLAUDE_CMD
    if CLAUDE_CMD is None:
        CLAUDE_CMD = find_claude()

    print(f"  [{label}] starting...")
    t0 = time.time()

    # The prompt goes in on STDIN, never as an argv element.
    #
    # find_claude() resolves to claude.CMD, a batch wrapper. subprocess.run executes
    # a .CMD through cmd.exe, which RE-PARSES the arguments — and cmd.exe treats a
    # newline as a command separator, so everything after the first line of a
    # multi-line prompt was silently discarded. Measured 2026-08-03 with a 3-marker
    # probe: the agent received LINE_ONE_MARKER and nothing else.
    #
    # That is the whole reason the analysis pipeline has never produced output. The
    # analyst briefs put OUTPUT_FILE and the FACTS path after blank lines, so every
    # agent got only the first line of its brief: it knew the topic, never learned
    # where the data was or where to write, and replied "I don't have the data,
    # could you paste it?" — which the harness then reported as "no JSON object in
    # response". Piping on stdin verified to deliver all three markers intact.
    argv = [CLAUDE_CMD, "-p",
            "--dangerously-skip-permissions",
            "--output-format", "text"]
    if system:
        argv += ["--append-system-prompt", system]
    if add_dirs:
        argv += ["--add-dir", *[str(d) for d in add_dirs]]

    try:
        proc = subprocess.run(
            argv,
            input=full_prompt,
            capture_output=True,
            text=True,
            cwd=cwd,
            timeout=TIMEOUT,
            env=agent_env()
        )
        output  = proc.stdout.strip() or proc.stderr.strip()
        success = proc.returncode == 0
    except subprocess.TimeoutExpired:
        output  = f"[TIMEOUT after {TIMEOUT}s]"
        success = False
    except FileNotFoundError:
        output  = "[ERROR: claude CLI not found — run from JARVIS terminal]"
        success = False

    elapsed = time.time() - t0

    # A session limit is a pause, not a failure — and this path had no protection at
    # all until 2026-08-07. It is the one that most needed it: /engineer and /analysis
    # both run through here, N agents at a time, each holding a brief that took real
    # work to assemble. Running N agents concurrently is also precisely what TRIPS the
    # limit, so the most expensive runs were the likeliest to be destroyed by it.
    #
    # Parked with kind="parallel" plus this task's cwd and add_dirs, because those
    # decide whether the agent boots as JARVIS or as a plain worker. Resuming through
    # run_claude would silently swap one for the other.
    limited = False
    if not success and not task.get("_from_queue"):
        try:
            from claude_agent import looks_rate_limited, parse_reset_at, queue_job
            limited = looks_rate_limited(output, success)
            if limited:
                reset_at = parse_reset_at(output)
                queue_job(full_prompt, label, TIMEOUT, True, system, None, reset_at,
                          is_limit=True, kind="parallel",
                          extra={"cwd": cwd, "addDirs": [str(d) for d in add_dirs]})
                print(f"  [{label}] hit the subscription limit — brief saved, resumes "
                      f"after {reset_at or 'the next drain'}. Nothing was lost.")
        except Exception as exc:
            # Never let the safety net break the run it is protecting.
            print(f"  [{label}] could not park brief ({exc})")

    status = "limited" if limited else ("done" if success else "failed")
    print(f"  [{label}] {status} in {elapsed:.0f}s")

    return {"label": label, "output": output, "elapsed": elapsed,
            "success": success, "limited": limited}


def run_parallel(tasks: list) -> list:
    n = min(len(tasks), MAX_AGENTS)
    print(f"\n[PARALLEL] Launching {n} agents simultaneously...")
    wall_start = time.time()

    results = []
    with ThreadPoolExecutor(max_workers=n) as pool:
        futures = {pool.submit(run_agent, t): t for t in tasks}
        for future in as_completed(futures):
            results.append(future.result())

    wall = time.time() - wall_start
    seq  = sum(r["elapsed"] for r in results)
    saved = seq - wall
    print(f"\n[PARALLEL] All {n} agents done.")
    print(f"  Wall time: {wall:.0f}s  |  Sequential would have been: {seq:.0f}s  |  Saved: {saved:.0f}s")
    return results


def print_results(results: list):
    print("\n" + "="*60)
    print("PARALLEL AGENT RESULTS")
    print("="*60)
    for r in sorted(results, key=lambda x: x["label"]):
        marker = "✓" if r["success"] else "✗"
        print(f"\n{marker} {r['label']} ({r['elapsed']:.0f}s)")
        print("-" * 40)
        print(r["output"])
    print("\n" + "="*60)


if __name__ == "__main__":
    argv = sys.argv[1:]

    if not argv:
        print(__doc__)
        sys.exit(0)

    if argv[0] == "--file":
        if len(argv) < 2:
            print("Usage: python parallel_agents.py --file tasks.json")
            sys.exit(1)
        tasks = json.loads(Path(argv[1]).read_text(encoding="utf-8"))

    elif argv[0] == "--plan":
        # JARVIS plans the workstreams, then runs them
        plan_prompt = argv[1] if len(argv) > 1 else " ".join(argv[1:])
        print(f"[PLAN] Breaking task into parallel workstreams: {plan_prompt}")

        if CLAUDE_CMD is None:
            CLAUDE_CMD = find_claude()
        # Same stdin rule as run_agent: this prompt is multi-line, so passing it as
        # an argv element to claude.CMD meant the planner only ever received
        # "You are a senior engineer and architect." — which is why /engineer --plan
        # never produced a workstream array.
        planner_prompt = f"""You are a senior engineer and architect.
Break this task into independent parallel workstreams that can be built simultaneously with NO file conflicts between them.
Output ONLY a JSON array. Each item: {{"label": "short name", "prompt": "complete self-contained task for one engineer"}}.
Max 6 workstreams. Each prompt must be 100% self-contained — the engineer has no other context.
Working directory: C:\\Users\\User\\ai-trading-dashboard

TASK: {plan_prompt}"""
        planner_result = subprocess.run(
            [CLAUDE_CMD, "-p",
             "--dangerously-skip-permissions",
             "--output-format", "text"],
            input=planner_prompt,
            capture_output=True, text=True, cwd=str(WORK_DIR), timeout=60,
            env=agent_env()
        )

        raw = planner_result.stdout.strip()
        # Extract JSON from output
        start = raw.find("[")
        end   = raw.rfind("]") + 1
        if start == -1 or end == 0:
            print("[PLAN] Could not parse workstreams — raw output:")
            print(raw)
            sys.exit(1)

        tasks = json.loads(raw[start:end])
        print(f"[PLAN] {len(tasks)} workstreams planned:")
        for i, t in enumerate(tasks, 1):
            print(f"  {i}. {t['label']}")

    else:
        # Treat each argument as a task
        tasks = [{"label": f"Agent {i+1}", "prompt": p} for i, p in enumerate(argv)]

    results = run_parallel(tasks)
    print_results(results)
