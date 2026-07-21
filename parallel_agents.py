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
    import shutil
    if shutil.which("claude"):
        return "claude"
    # Common Windows install locations
    user = Path.home()
    candidates = [
        user / "AppData/Roaming/npm/claude.cmd",
        user / "AppData/Local/npm-global/claude.cmd",
        user / "AppData/Roaming/npm/claude",
        Path("C:/Program Files/nodejs/claude.cmd"),
        Path("C:/Users/User/AppData/Roaming/npm/claude.cmd"),
    ]
    for p in candidates:
        if p.exists():
            return str(p)
    raise FileNotFoundError(
        "claude CLI not found.\n"
        "Run this script from the JARVIS PowerShell terminal where 'claude' works,\n"
        "OR run: npm install -g @anthropic-ai/claude-code"
    )

CLAUDE_CMD = None  # resolved lazily on first use

def run_agent(task: dict) -> dict:
    label  = task.get("label", "Agent")
    prompt = task["prompt"]
    ctx    = task.get("context", "")

    full_prompt = f"{ctx}\n\n{prompt}".strip() if ctx else prompt

    global CLAUDE_CMD
    if CLAUDE_CMD is None:
        CLAUDE_CMD = find_claude()

    print(f"  [{label}] starting...")
    t0 = time.time()

    try:
        proc = subprocess.run(
            [CLAUDE_CMD, "-p", full_prompt,
             "--dangerously-skip-permissions",
             "--output-format", "text"],
            capture_output=True,
            text=True,
            cwd=str(WORK_DIR),
            timeout=TIMEOUT,
            env={**os.environ, "NO_COLOR": "1"}
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
    status  = "done" if success else "failed"
    print(f"  [{label}] {status} in {elapsed:.0f}s")

    return {"label": label, "output": output, "elapsed": elapsed, "success": success}


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
        planner_result = subprocess.run(
            [CLAUDE_CMD, "-p",
             f"""You are a senior engineer and architect.
Break this task into independent parallel workstreams that can be built simultaneously with NO file conflicts between them.
Output ONLY a JSON array. Each item: {{"label": "short name", "prompt": "complete self-contained task for one engineer"}}.
Max 6 workstreams. Each prompt must be 100% self-contained — the engineer has no other context.
Working directory: C:\\Users\\User\\ai-trading-dashboard

TASK: {plan_prompt}""",
             "--dangerously-skip-permissions",
             "--output-format", "text"],
            capture_output=True, text=True, cwd=str(WORK_DIR), timeout=60
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
