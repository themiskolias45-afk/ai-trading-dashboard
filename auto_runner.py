"""
JARVIS Daily Auto-Runner
Runs every morning automatically. Does 6 things in sequence:

  1. System health check       — catch any broken routes, syntax errors, secrets
  2. Performance analysis      — identify today's weakest setup / worst pattern
  3. Web research              — search for improvements to the weakest area
  4. Code scan                 — find real code issues (self_improve.py)
  5. AI improvement proposal   — Opus generates specific fix with evidence
  6. Save + notify             — report to tasks/, memory, daily notes, toast

Usage:
  python auto_runner.py                 # run full cycle
  python auto_runner.py --health-only   # just system check
  python auto_runner.py --silent        # no toast notification
"""
import sys, os, json, time, subprocess
from pathlib import Path
from datetime import datetime, timezone

from claude_agent import make_console_utf8
make_console_utf8()

ROOT       = Path(__file__).parent
TASKS_DIR  = ROOT / "tasks"
SERVER_URL = "http://localhost:3001"
PYTHON     = sys.executable


def _fetch(path: str):
    import urllib.request
    try:
        with urllib.request.urlopen(f"{SERVER_URL}{path}", timeout=5) as r:
            return json.loads(r.read().decode())
    except Exception as exc:
        return {"_error": str(exc)}


def _run(script: str, args: list = [], timeout: int = 120) -> str:
    try:
        result = subprocess.run(
            [PYTHON, str(ROOT / script)] + args,
            capture_output=True, text=True, timeout=timeout,
            cwd=str(ROOT), env={**os.environ, "NO_COLOR": "1"},
        )
        return (result.stdout or result.stderr or "").strip()
    except subprocess.TimeoutExpired:
        return f"[TIMEOUT after {timeout}s]"
    except Exception as exc:
        return f"[ERROR: {exc}]"


def _call_claude(prompt: str, timeout: int = 90) -> str:
    """
    Ask an agent for the daily proposal.

    Delegated to claude_agent.run_claude. The old inline version passed the prompt
    as an argv element, which cmd.exe truncated at the first newline, so the agent
    received the opening line and none of the health, performance or research data
    underneath it — and it kept ANTHROPIC_API_KEY, billing credit that ran dry.
    """
    from claude_agent import run_claude
    result = run_claude(prompt, timeout=timeout, label="daily-proposal")
    return result["output"]




def _brave_search(query: str) -> str:
    """Search web using Brave API if configured."""
    api_key = os.environ.get("BRAVE_API_KEY", "")
    if not api_key:
        return "[Brave API key not set — skipping web search]"
    import urllib.request, urllib.parse
    try:
        url = f"https://api.search.brave.com/res/v1/web/search?q={urllib.parse.quote(query)}&count=5"
        req = urllib.request.Request(url, headers={
            "Accept": "application/json",
            "Accept-Encoding": "gzip",
            "X-Subscription-Token": api_key,
        })
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.loads(r.read())
        results = data.get("web", {}).get("results", [])
        if not results:
            return "[No search results]"
        lines = []
        for r in results[:5]:
            lines.append(f"- {r.get('title','')}: {r.get('description','')[:150]}")
        return "\n".join(lines)
    except Exception as exc:
        return f"[Search error: {exc}]"


# ── Phase 1: System health ─────────────────────────────────────────────────

def phase_health() -> dict:
    print("\n[AUTO] Phase 1: System health check...")
    output = _run("check_errors.py", timeout=60)
    healer = _fetch("/api/healer")
    healthy = healer.get("healthy", False)
    failures = [l for l in output.splitlines() if "FAIL" in l]
    warnings = [l for l in output.splitlines() if "WARN" in l]
    return {
        "server_healthy": healthy,
        "failures": failures,
        "warnings": warnings,
        "raw": output,
    }


# ── Phase 2: Performance analysis ─────────────────────────────────────────

def phase_performance() -> dict:
    print("[AUTO] Phase 2: Performance analysis...")
    journal  = _fetch("/api/journal?limit=100")
    learning = _fetch("/api/learning")
    stats    = _fetch("/api/stats/by-setup")

    trades = journal if isinstance(journal, list) else []
    wins   = [t for t in trades if t.get("outcome") == "WIN"]
    losses = [t for t in trades if t.get("outcome") == "LOSS"]
    total  = len(wins) + len(losses)
    wr     = round(len(wins) / total * 100, 1) if total else 0

    # Find worst setup
    worst_setup = None
    worst_wr    = 100.0
    setups = (learning.get("setups", {}) if isinstance(learning, dict) else {})
    for setup, data in setups.items():
        w = data.get("wins", 0)
        l = data.get("losses", 0)
        t = w + l
        if t >= 3:
            s_wr = round(w / t * 100, 1)
            if s_wr < worst_wr:
                worst_wr    = s_wr
                worst_setup = setup

    pnls    = [t.get("pnl", 0) or 0 for t in trades]
    net_pnl = round(sum(pnls), 2)

    return {
        "total_trades": total,
        "win_rate":     wr,
        "net_pnl":      net_pnl,
        "worst_setup":  worst_setup,
        "worst_wr":     worst_wr,
    }


# ── Phase 3: Web research ──────────────────────────────────────────────────

def phase_research(worst_setup: str) -> str:
    print("[AUTO] Phase 3: Web research...")
    if not worst_setup:
        query = "best algorithmic trading signal improvement techniques 2025"
    else:
        setup_clean = worst_setup.replace("_", " ")
        query = f"improve {setup_clean} trading setup win rate algorithmic"

    return _brave_search(query)


# ── Phase 4: Code scan ─────────────────────────────────────────────────────

def phase_code_scan() -> dict:
    print("[AUTO] Phase 4: Code scan...")
    output = _run("self_improve.py", ["scan", "--save"], timeout=60)
    high   = [l for l in output.splitlines() if "[HIGH]" in l or "HIGH" in l]
    return {"high_issues": high, "raw": output}


# ── Phase 5: AI proposal ───────────────────────────────────────────────────

def phase_ai_proposal(perf: dict, health: dict, scan: dict, research: str) -> str:
    print("[AUTO] Phase 5: AI improvement proposal (Opus)...")

    prompt = (
        "You are JARVIS, a trading system AI engineer. "
        "Analyze these daily findings and give ONE specific improvement to implement today.\n\n"
        f"PERFORMANCE:\n"
        f"  Win rate: {perf['win_rate']}% | Net P&L: ${perf['net_pnl']} | Trades: {perf['total_trades']}\n"
        f"  Worst setup: {perf.get('worst_setup', 'none')} ({perf.get('worst_wr', 'N/A')}% WR)\n\n"
        f"SYSTEM HEALTH:\n"
        f"  Server healthy: {health['server_healthy']}\n"
        f"  Failures: {len(health['failures'])}\n"
        + (f"  Issues: {chr(10).join(health['failures'][:3])}\n" if health['failures'] else "") +
        f"\nCODE SCAN HIGH ISSUES: {len(scan['high_issues'])}\n"
        + (f"  {chr(10).join(scan['high_issues'][:3])}\n" if scan['high_issues'] else "") +
        f"\nWEB RESEARCH FINDINGS:\n{research[:600]}\n\n"
        "Give ONE specific improvement:\n"
        "PROBLEM: [one sentence]\n"
        "ROOT CAUSE: [one sentence]\n"
        "FIX: [exact code snippet or parameter change]\n"
        "EXPECTED IMPACT: [measurable outcome]\n"
        "RISK: [what could break]\n"
        "IMPLEMENT NOW: YES or NO (YES only if safe and high impact)"
    )

    return _call_claude(prompt, timeout=120)


# ── Phase 6: Save + notify ─────────────────────────────────────────────────

def phase_save(report: dict) -> Path:
    TASKS_DIR.mkdir(exist_ok=True)
    out_dir = TASKS_DIR / "auto_runner_reports"
    out_dir.mkdir(exist_ok=True)
    ts   = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    path = out_dir / f"report_{ts}.json"
    path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    return path


def phase_notify(report: dict, silent: bool = False):
    if silent:
        return
    perf    = report.get("performance", {})
    health  = report.get("health", {})
    status  = "HEALTHY" if health.get("server_healthy") else "DEGRADED"
    message = (
        f"Daily check: {status} | "
        f"WR {perf.get('win_rate', '?')}% | "
        f"P&L ${perf.get('net_pnl', '?')} | "
        f"Worst: {perf.get('worst_setup', 'none')}"
    )
    _run("notifications.py", ["alert", message, "--title", "JARVIS Daily Report"], timeout=15)


def phase_memory(report: dict):
    perf = report.get("performance", {})
    proposal = (report.get("proposal", "") or "")[:200]
    _run("memory.py", ["add",
        f"DAILY_REPORT_{datetime.now(timezone.utc).strftime('%Y%m%d')}",
        f"WR={perf.get('win_rate')}% PnL=${perf.get('net_pnl')} worst={perf.get('worst_setup')} proposal={proposal}",
        "LEARNING"
    ])
    _run("daily_notes.py", ["auto"])
    _run("daily_notes.py", ["log",
        f"Auto-runner: WR={perf.get('win_rate')}% | P&L=${perf.get('net_pnl')} | {proposal[:100]}",
        "AUTO"
    ])


# ── Main ───────────────────────────────────────────────────────────────────

def main():
    argv   = sys.argv[1:]
    silent = "--silent" in argv
    health_only = "--health-only" in argv

    start = time.time()
    print(f"\n{'='*60}")
    print(f"  JARVIS AUTO-RUNNER — {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}")
    print(f"{'='*60}")

    report = {"run_at": datetime.now(timezone.utc).isoformat()}

    # Phase 1 — always run
    health = phase_health()
    report["health"] = health
    if health["failures"]:
        print(f"  ⚠ {len(health['failures'])} failure(s) found")
    else:
        print(f"  ✓ System healthy")

    if health_only:
        _save_and_print(report, start, silent)
        return

    # Phase 2
    perf = phase_performance()
    report["performance"] = perf
    print(f"  ✓ Performance: WR={perf['win_rate']}% | P&L=${perf['net_pnl']} | Worst={perf.get('worst_setup','none')}")

    # Phase 3
    research = phase_research(perf.get("worst_setup"))
    report["research"] = research
    print(f"  ✓ Web research: {len(research)} chars")

    # Phase 4
    scan = phase_code_scan()
    report["code_scan"] = {"high_count": len(scan["high_issues"]), "issues": scan["high_issues"]}
    print(f"  ✓ Code scan: {len(scan['high_issues'])} HIGH issues")

    # Phase 5
    proposal = phase_ai_proposal(perf, health, scan, research)
    report["proposal"] = proposal
    print(f"  ✓ AI proposal generated ({len(proposal)} chars)")

    # Phase 6
    path = phase_save(report)
    phase_memory(report)
    phase_notify(report, silent)

    elapsed = round(time.time() - start, 1)
    print(f"\n{'='*60}")
    print(f"  AUTO-RUNNER COMPLETE in {elapsed}s")
    print(f"  Report: {path}")
    print(f"{'='*60}\n")

    # Print proposal
    if proposal and "[claude CLI" not in proposal:
        print("\nTODAY'S IMPROVEMENT PROPOSAL:")
        print("-" * 60)
        print(proposal)
        print("-" * 60)


def _save_and_print(report, start, silent):
    path = phase_save(report)
    phase_notify(report, silent)
    elapsed = round(time.time() - start, 1)
    print(f"\nDone in {elapsed}s — {path}")


if __name__ == "__main__":
    main()
