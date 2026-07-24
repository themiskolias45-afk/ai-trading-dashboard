"""
JARVIS Daily Plan Generator
Runs every morning (or on demand). Builds a full trade plan for the day.

What it does:
  1. Fetches live signals + prices + economic calendar from server
  2. Computes key S/R levels from recent price data
  3. Generates a structured daily plan JSON
  4. Saves the plan to tasks/daily_plan_YYYYMMDD.json
  5. Optionally takes TradingView chart screenshots (node tv_screenshot.js)
  6. Logs to daily notes + sends morning notification

Usage:
  python tv_daily_plan.py                # full plan + notification
  python tv_daily_plan.py --no-tv        # skip TV screenshots
  python tv_daily_plan.py --silent       # no toast
  python tv_daily_plan.py --4h           # include 4H screenshots
"""
import sys, os, json, subprocess, math
from pathlib import Path
from datetime import datetime, timezone

ROOT       = Path(__file__).parent
TASKS_DIR  = ROOT / "tasks"
SERVER_URL = "http://localhost:3001"
PYTHON     = sys.executable


def _fetch(path: str):
    import urllib.request
    try:
        with urllib.request.urlopen(f"{SERVER_URL}{path}", timeout=6) as r:
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


def _key_levels(price: float, pct: float = 0.02) -> dict:
    """Compute S/R levels as round-number zones around current price."""
    if not price:
        return {}
    step = price * pct
    # Round to nearest 'nice' number
    magnitude = 10 ** math.floor(math.log10(step))
    step = round(step / magnitude) * magnitude
    r1 = round((price + step) / step) * step
    r2 = round((price + step * 2) / step) * step
    s1 = round((price - step) / step) * step
    s2 = round((price - step * 2) / step) * step
    return {
        "R2": round(r2, 2), "R1": round(r1, 2),
        "pivot": round(price, 2),
        "S1": round(s1, 2), "S2": round(s2, 2),
    }


def build_plan():
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    now   = datetime.now(timezone.utc).isoformat()

    print(f"\n{'='*55}")
    print(f"  JARVIS DAILY PLAN — {today}")
    print(f"{'='*55}\n")

    # ── Fetch data ───────────────────────────────────────────────
    print("[plan] Fetching server data…")
    signals   = _fetch("/api/signals")
    risk      = _fetch("/api/risk-status")
    learning  = _fetch("/api/learning")
    plan_data = _fetch("/api/daily-plan")

    prices = plan_data.get("prices", {}) if isinstance(plan_data, dict) else {}
    calendar = plan_data.get("calendar", []) if isinstance(plan_data, dict) else []

    # ── Build per-asset plans ────────────────────────────────────
    assets = {}
    for sym in ["btc", "gold", "spx"]:
        sig   = (signals or {}).get(sym) or {}
        price = prices.get(sym)
        levels = _key_levels(price)

        trade_plan = None
        if sig.get("signal") and sig["signal"] != "WAIT" and sig.get("entry"):
            pnl_risk   = abs((sig.get("entry") or 0) - (sig.get("stop") or 0))
            pnl_reward = abs((sig.get("target") or 0) - (sig.get("entry") or 0))
            trade_plan = {
                "direction":  sig["signal"],
                "confidence": sig.get("confidence", 0),
                "setup":      sig.get("setup", ""),
                "regime":     sig.get("regime", ""),
                "entry":      sig.get("entry"),
                "stop":       sig.get("stop"),
                "target":     sig.get("target"),
                "rr":         sig.get("rr"),
                "risk_pts":   round(pnl_risk, 2),
                "reward_pts": round(pnl_reward, 2),
            }
            print(f"  [{sym.upper()}] {sig['signal']} conf:{sig.get('confidence',0)}% "
                  f"entry:{sig.get('entry')} stop:{sig.get('stop')} target:{sig.get('target')}")
        else:
            print(f"  [{sym.upper()}] WAIT — {sig.get('regime','no regime')}")

        assets[sym] = {
            "price":      price,
            "levels":     levels,
            "trade_plan": trade_plan,
        }

    # ── Setup health summary ─────────────────────────────────────
    setup_stats = {}
    if isinstance(learning, dict):
        raw = learning.get("setupStats") or learning.get("setups") or {}
        for name, s in raw.items():
            wr = s.get("winRate") or (s.get("wins", 0) / max(1, s.get("wins", 0) + s.get("losses", 0)) * 100)
            setup_stats[name] = {"winRate": round(wr, 1), "total": s.get("total", 0)}

    # ── High-impact calendar events ──────────────────────────────
    hv_events = [
        {"time": e.get("date", ""), "name": e.get("title") or e.get("name", ""), "currency": e.get("currency", "")}
        for e in calendar if e.get("impact", "").lower() == "high"
    ]

    # ── Risk checks ──────────────────────────────────────────────
    warnings = []
    risk_obj = risk if isinstance(risk, dict) else {}
    if risk_obj.get("halted"):
        warnings.append(f"TRADING HALTED: {risk_obj.get('haltReason', 'risk limit')}")
    if risk_obj.get("consecutiveLosses", 0) >= 2:
        warnings.append(f"⚠ {risk_obj['consecutiveLosses']} consecutive losses — reduce size")
    vix = prices.get("vix")
    if vix and vix > 25:
        warnings.append(f"⚠ VIX={vix:.1f} — high volatility, widen stops or skip")
    if hv_events:
        warnings.append(f"⚠ {len(hv_events)} high-impact events today — check calendar")

    # ── Assemble plan ────────────────────────────────────────────
    plan = {
        "date":        today,
        "generatedAt": now,
        "assets":      assets,
        "prices":      prices,
        "risk":        risk_obj,
        "setup_health": setup_stats,
        "calendar":    hv_events,
        "warnings":    warnings,
    }

    # ── Save ─────────────────────────────────────────────────────
    TASKS_DIR.mkdir(exist_ok=True)
    out = TASKS_DIR / f"daily_plan_{today}.json"
    out.write_text(json.dumps(plan, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\n[plan] Saved: {out}")

    return plan


def run_tv_screenshots(do_4h: bool = False):
    """Take TradingView screenshots using the Node.js tool."""
    node_script = ROOT / "tv_screenshot.js"
    if not node_script.exists():
        print("[plan] tv_screenshot.js not found — skipping screenshots")
        return

    import shutil
    node = shutil.which("node") or shutil.which("node.exe") or "node"
    args = [node, str(node_script)]
    if do_4h:
        args.append("--4h")

    print("[plan] Taking TradingView screenshots…")
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=120, cwd=str(ROOT))
        output = (result.stdout or result.stderr or "").strip()
        print(output[:400] if output else "  [no output]")
    except subprocess.TimeoutExpired:
        print("[plan] Screenshot timeout — charts may be slow to load")
    except Exception as e:
        print(f"[plan] Screenshot error: {e}")


def notify(plan: dict, silent: bool = False):
    if silent:
        return
    assets = plan.get("assets", {})
    signals_str = " | ".join(
        f"{sym.upper()} {a['trade_plan']['direction']} {a['trade_plan']['confidence']}%"
        if a.get("trade_plan") else f"{sym.upper()} WAIT"
        for sym, a in assets.items()
    )
    warnings = plan.get("warnings", [])
    w_str = " | " + warnings[0] if warnings else ""
    msg = f"Daily Plan ready: {signals_str}{w_str}"
    _run("notifications.py", ["alert", msg, "--title", "JARVIS Daily Plan"], timeout=15)


def log_to_notes(plan: dict):
    today = plan.get("date", "")
    assets = plan.get("assets", {})
    lines = [f"Daily Plan {today}:"]
    for sym, a in assets.items():
        tp = a.get("trade_plan")
        if tp:
            lines.append(f"  {sym.upper()} {tp['direction']} {tp['confidence']}% entry:{tp['entry']} stop:{tp['stop']} target:{tp['target']}")
        else:
            lines.append(f"  {sym.upper()} WAIT")
    for w in plan.get("warnings", []):
        lines.append(f"  {w}")
    note = " | ".join(lines)
    _run("daily_notes.py", ["log", note, "PLAN"], timeout=15)
    _run("memory.py", ["add", f"PLAN_{today.replace('-','')}", note[:200], "TRADE"], timeout=15)


def main():
    argv    = sys.argv[1:]
    silent  = "--silent" in argv
    no_tv   = "--no-tv" in argv
    do_4h   = "--4h" in argv

    plan = build_plan()

    if not no_tv:
        run_tv_screenshots(do_4h=do_4h)

    log_to_notes(plan)
    notify(plan, silent=silent)

    # Print morning briefing
    print("\nMORNING BRIEFING:")
    print("-" * 55)
    for sym, a in plan.get("assets", {}).items():
        tp = a.get("trade_plan")
        if tp:
            print(f"  {sym.upper()}: {tp['direction']} | conf:{tp['confidence']}% | "
                  f"entry:{tp['entry']} stop:{tp['stop']} target:{tp['target']} R:R 1:{tp['rr']}")
        else:
            p = a.get("price")
            print(f"  {sym.upper()}: WAIT | price:{p}")
    for w in plan.get("warnings", []):
        print(f"  {w}")
    print("-" * 55)
    print(f"\n  Dashboard: http://localhost:3001/daily-plan\n")


if __name__ == "__main__":
    main()
