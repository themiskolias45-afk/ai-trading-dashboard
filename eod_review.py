"""
JARVIS End-of-Day Review
Runs automatically at 10 PM UTC (Mon-Fri) via server cron, or manually any time.

What it does:
  1. Fetches today's closed trades from /api/journal
  2. Computes P&L, win rate, best/worst trade
  3. Identifies which setups fired today
  4. Calls Claude for a short insight (Haiku — cheap, fast)
  5. Saves to daily notes + memory
  6. Sends notification with day summary

Usage:
  python eod_review.py
  python eod_review.py --silent    # no toast notification
  python eod_review.py --date 2026-07-24  # review a specific date
"""
import sys, os, json, subprocess
from pathlib import Path
from datetime import datetime, timezone

ROOT       = Path(__file__).parent
TASKS_DIR  = ROOT / "tasks"
SERVER_URL = "http://localhost:3001"
PYTHON     = sys.executable


def _fetch(path: str):
    import urllib.request
    try:
        with urllib.request.urlopen(f"{SERVER_URL}{path}", timeout=5) as r:
            return json.loads(r.read().decode())
    except Exception as e:
        return {"_error": str(e)}


def _run(script: str, args: list = [], timeout: int = 30) -> str:
    try:
        result = subprocess.run(
            [PYTHON, str(ROOT / script)] + args,
            capture_output=True, text=True, timeout=timeout,
            cwd=str(ROOT), env={**os.environ, "NO_COLOR": "1"},
        )
        return (result.stdout or result.stderr or "").strip()
    except Exception as e:
        return f"[ERROR: {e}]"


def _call_claude(prompt: str) -> str:
    import shutil
    claude = shutil.which("claude") or shutil.which("claude.cmd") or ""
    if not claude:
        return "[claude CLI not found]"
    try:
        result = subprocess.run(
            [claude, "-p", prompt, "--dangerously-skip-permissions", "--output-format", "text"],
            capture_output=True, text=True, timeout=60,
            cwd=str(ROOT), env={**os.environ, "NO_COLOR": "1"},
        )
        return (result.stdout or result.stderr or "").strip()
    except Exception as e:
        return f"[ERROR: {e}]"


def review(target_date: str = None, silent: bool = False):
    today = target_date or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    print(f"\n{'='*55}")
    print(f"  JARVIS EOD REVIEW — {today}")
    print(f"{'='*55}")

    # ── Fetch today's closed trades ──────────────────────────────
    raw = _fetch("/api/journal?limit=500")
    all_trades = raw.get("journal", []) if isinstance(raw, dict) else []

    today_trades = [
        t for t in all_trades
        if t.get("status") == "CLOSED"
        and (t.get("closeTime") or t.get("openTime") or "").startswith(today)
    ]

    print(f"\n  Trades closed today: {len(today_trades)}")

    if not today_trades:
        print("  No trades to review.")
        msg = f"EOD {today}: No trades today — rest day."
        _run("notifications.py", ["alert", msg, "--title", "JARVIS EOD"], timeout=15)
        _run("daily_notes.py", ["log", msg, "EOD"], timeout=15)
        return

    # ── Compute stats ────────────────────────────────────────────
    wins   = [t for t in today_trades if (t.get("pnl") or 0) > 0]
    losses = [t for t in today_trades if (t.get("pnl") or 0) < 0]
    be     = [t for t in today_trades if (t.get("pnl") or 0) == 0]

    total    = len(today_trades)
    gross    = sum(t.get("pnl") or 0 for t in today_trades)
    win_rate = round(len(wins) / total * 100, 1) if total else 0

    best  = max(today_trades, key=lambda t: t.get("pnl") or 0)
    worst = min(today_trades, key=lambda t: t.get("pnl") or 0)

    setups = {}
    for t in today_trades:
        s = t.get("setup") or "UNKNOWN"
        if s not in setups:
            setups[s] = {"wins": 0, "losses": 0, "pnl": 0}
        if (t.get("pnl") or 0) > 0:
            setups[s]["wins"] += 1
        else:
            setups[s]["losses"] += 1
        setups[s]["pnl"] += t.get("pnl") or 0

    print(f"  W:{len(wins)} L:{len(losses)} BE:{len(be)} | WR:{win_rate}% | P&L:${gross:+.2f}")
    print(f"  Best:  {best.get('symbol')} ${best.get('pnl',0):+.2f}")
    print(f"  Worst: {worst.get('symbol')} ${worst.get('pnl',0):+.2f}")

    # ── Fetch learning state for context ────────────────────────
    learning = _fetch("/api/learning")
    setup_stats = {}
    if isinstance(learning, dict):
        setup_stats = learning.get("setupStats", {}) or learning.get("setups", {})

    # ── AI insight (Haiku — fast + cheap) ───────────────────────
    print("\n  Generating EOD insight…")
    setup_summary = "\n".join(
        f"  {s}: W{v['wins']} L{v['losses']} ${v['pnl']:+.2f}" for s, v in setups.items()
    )
    overall_setups = "\n".join(
        f"  {s}: {d.get('winRate',0)}% WR ({d.get('total',0)} total)"
        for s, d in list(setup_stats.items())[:6]
    ) if setup_stats else "  No setup history yet."

    prompt = (
        "You are JARVIS, a trading system AI. Give a sharp 3-sentence EOD insight.\n\n"
        f"DATE: {today}\n"
        f"RESULT: {total} trades | {win_rate}% WR | ${gross:+.2f} P&L\n"
        f"TODAY'S SETUPS:\n{setup_summary}\n"
        f"OVERALL SETUP HISTORY:\n{overall_setups}\n\n"
        "Format:\n"
        "TODAY: [one sentence on what happened]\n"
        "PATTERN: [one sentence — what setup/behaviour to repeat or avoid]\n"
        "TOMORROW: [one sentence on what to watch or do differently]"
    )
    insight = _call_claude(prompt)
    if "[claude CLI" in insight or "[ERROR" in insight:
        insight = f"WR {win_rate}% | P&L ${gross:+.2f} | {len(wins)}W {len(losses)}L — no AI insight available."

    print(f"\n  INSIGHT:\n  {insight}")

    # ── Save to daily notes ──────────────────────────────────────
    note = f"EOD {today}: {total} trades | {win_rate}% WR | ${gross:+.2f} | {insight[:120]}"
    _run("daily_notes.py", ["log", note, "EOD"], timeout=15)

    # ── Save to memory ───────────────────────────────────────────
    _run("memory.py", ["add",
        f"EOD_{today.replace('-','')}",
        f"Trades:{total} WR:{win_rate}% PnL:{gross:+.2f} {insight[:100]}",
        "LEARNING"
    ], timeout=15)

    # ── Save report JSON ─────────────────────────────────────────
    TASKS_DIR.mkdir(exist_ok=True)
    report_dir = TASKS_DIR / "eod_reports"
    report_dir.mkdir(exist_ok=True)
    report = {
        "date": today,
        "total": total, "wins": len(wins), "losses": len(losses),
        "win_rate": win_rate, "gross_pnl": round(gross, 2),
        "best":  {"symbol": best.get("symbol"),  "pnl": best.get("pnl")},
        "worst": {"symbol": worst.get("symbol"), "pnl": worst.get("pnl")},
        "setups": setups, "insight": insight,
    }
    out = report_dir / f"eod_{today}.json"
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")

    # ── Notify ───────────────────────────────────────────────────
    if not silent:
        sign  = "🟢" if gross > 0 else "🔴" if gross < 0 else "⚪"
        title = "JARVIS EOD Report"
        msg   = f"{sign} {today}: {total} trades | {win_rate}% WR | ${gross:+.2f}"
        _run("notifications.py", ["alert", msg, "--title", title], timeout=15)

    print(f"\n  Report saved: {out}")
    print(f"{'='*55}\n")
    return report


if __name__ == "__main__":
    argv   = sys.argv[1:]
    silent = "--silent" in argv
    date   = None
    if "--date" in argv:
        idx = argv.index("--date")
        if idx + 1 < len(argv):
            date = argv[idx + 1]
    review(target_date=date, silent=silent)
