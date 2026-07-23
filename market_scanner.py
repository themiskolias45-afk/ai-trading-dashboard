"""
JARVIS Market Scanner
Parallel scan of multiple assets simultaneously — finds the best opportunity right now.

Usage:
  python market_scanner.py                  # scan BTC, GOLD, SPX (default)
  python market_scanner.py --all            # scan all 6 tracked assets
  python market_scanner.py BTC GOLD ETH    # scan specific assets
  python market_scanner.py --debate        # auto-run debate on any live signal found
"""
import sys, json, time
from pathlib import Path
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor, as_completed
import urllib.request

ROOT       = Path(__file__).parent
SERVER_URL = "http://localhost:3001"

DEFAULT_ASSETS = ["BTC", "GOLD", "SPX"]
ALL_ASSETS     = ["BTC", "GOLD", "SPX", "ETH", "NASDAQ", "OIL"]


def _fetch(path: str, timeout: int = 5):
    try:
        with urllib.request.urlopen(f"{SERVER_URL}{path}", timeout=timeout) as r:
            return json.loads(r.read().decode())
    except Exception as exc:
        return {"_error": str(exc)}


def _scan_asset(symbol: str, signals: dict, learning: dict, journal: list) -> dict:
    key         = symbol.lower()
    signal_data = signals.get(key, {}) if isinstance(signals, dict) else {}

    sig    = signal_data.get("signal", "WAIT")
    conf   = float(signal_data.get("confidence", 0))
    entry  = float(signal_data.get("entry", 0) or 0)
    stop_p = float(signal_data.get("stop", 0) or 0)
    target = float(signal_data.get("target", 0) or 0)
    setup  = signal_data.get("setup", "")
    reason = signal_data.get("reason", "")

    # Risk:Reward
    rr = 0.0
    if entry and stop_p and target and sig not in ("WAIT", "NONE", None):
        if sig == "LONG":
            risk_pts, reward_pts = entry - stop_p, target - entry
        else:
            risk_pts, reward_pts = stop_p - entry, entry - target
        if risk_pts > 0:
            rr = round(reward_pts / risk_pts, 2)

    # Win rate from learning data
    setups    = learning.get("setups", {}) if isinstance(learning, dict) else {}
    setup_obj = setups.get(setup, {})
    wins      = setup_obj.get("wins", 0)
    losses    = setup_obj.get("losses", 0)
    total     = wins + losses
    wr        = round(wins / total * 100, 1) if total > 0 else None

    # Recent performance on this symbol from journal
    sym_trades  = [t for t in journal if (t.get("symbol","")).upper() == symbol.upper()]
    recent_5    = sym_trades[:5]
    recent_wins = sum(1 for t in recent_5 if t.get("outcome") == "WIN")

    # Opportunity score (0–100): confidence + R:R + historical WR + recent form
    score = 0.0
    if sig not in ("WAIT", "NONE", None, ""):
        score += min(conf * 0.5, 50)                    # up to 50 pts
        score += min(rr * 5, 20)                        # up to 20 pts
        score += min(recent_wins * 4, 20)               # up to 20 pts
        if wr is not None:
            score += min(max((wr - 50) / 5, 0), 10)    # up to 10 pts

    return {
        "symbol":        symbol,
        "signal":        sig or "WAIT",
        "confidence":    conf,
        "setup":         setup,
        "reason":        reason,
        "entry":         entry,
        "stop":          stop_p,
        "target":        target,
        "rr":            rr,
        "win_rate":      wr,
        "setup_trades":  total,
        "recent_wins":   recent_wins,
        "score":         round(score, 1),
        "debate_verdict": None,
    }


def scan_assets(assets: list, run_debate: bool = False) -> list:
    print(f"\n[SCAN] Fetching server data...")
    signals  = _fetch("/api/signals")
    learning = _fetch("/api/learning")
    journal  = _fetch("/api/journal") if not isinstance(_fetch("/api/journal"), dict) else []

    if not isinstance(journal, list):
        journal = []

    print(f"[SCAN] Scanning {len(assets)} assets in parallel...")
    t0 = time.time()

    results_map = {}
    with ThreadPoolExecutor(max_workers=min(len(assets), 8)) as pool:
        futures = {
            pool.submit(_scan_asset, sym, signals, learning, journal): sym
            for sym in assets
        }
        for future in as_completed(futures):
            sym = futures[future]
            try:
                results_map[sym] = future.result()
            except Exception as exc:
                results_map[sym] = {
                    "symbol": sym, "signal": "ERROR", "score": 0,
                    "error": str(exc), "confidence": 0, "rr": 0,
                }

    ranked  = sorted(results_map.values(), key=lambda r: r.get("score", 0), reverse=True)
    elapsed = round(time.time() - t0, 1)
    print(f"[SCAN] Done in {elapsed}s")

    if run_debate:
        for r in ranked:
            if (
                r.get("signal") not in ("WAIT", "NONE", "ERROR", None, "")
                and r.get("confidence", 0) >= 65
                and r.get("entry") and r.get("stop") and r.get("target")
            ):
                try:
                    from debate_agents import debate_signal, format_debate
                    print(f"\n[SCAN] Debating {r['symbol']} {r['signal']}...")
                    debate = debate_signal(
                        r["symbol"], r["signal"], r["confidence"],
                        r["entry"], r["stop"], r["target"],
                    )
                    print(format_debate(debate))
                    r["debate_verdict"] = debate["verdict"]
                except ImportError:
                    r["debate_verdict"] = "debate_agents.py not found"

    return ranked


def format_scan(results: list) -> str:
    actionable = [r for r in results if r.get("signal") not in ("WAIT", "NONE", "ERROR", None, "")]
    waiting    = [r for r in results if r.get("signal") in ("WAIT", "NONE", None, "")]

    lines = [
        "",
        "=" * 68,
        f"  JARVIS MARKET SCAN — {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}",
        f"  Assets scanned: {len(results)}  |  Signals ready: {len(actionable)}",
        "=" * 68,
    ]

    if actionable:
        lines.append("\n  SIGNALS READY (ranked by opportunity score):")
        lines.append("  " + "─" * 66)
        for r in actionable:
            debate_str = f"  → {r['debate_verdict']}" if r.get("debate_verdict") else ""
            wr_str     = f"WR {r['win_rate']}%" if r.get("win_rate") is not None else "WR -"
            lines.append(
                f"  ★ {r['symbol']:7s} {r['signal']:5s} {r['confidence']:3.0f}%  "
                f"Entry {r['entry']}  Stop {r['stop']}  Target {r['target']}  "
                f"R:R {r['rr']}:1  {wr_str}  [score {r['score']}]{debate_str}"
            )
            if r.get("setup"):
                lines.append(f"           Setup: {r['setup']}")
            if r.get("reason"):
                lines.append(f"           Reason: {r['reason'][:120]}")

    if waiting:
        lines.append("\n  WAITING:")
        for r in waiting:
            lines.append(f"  · {r['symbol']:7s} — no signal")

    if not actionable:
        lines.append("\n  No active signals — all assets in WAIT state")
        lines.append("  Check again after the next signal refresh (every 5 min)")
    else:
        top = actionable[0]
        lines.append(
            f"\n  TOP PICK: {top['symbol']} {top['signal']} | "
            f"Score {top['score']} | Conf {top['confidence']}% | R:R {top['rr']}:1"
        )

    lines.append("\n" + "=" * 68 + "\n")
    return "\n".join(lines)


def main():
    argv        = sys.argv[1:]
    run_debate  = "--debate" in argv
    scan_all    = "--all" in argv

    symbols = [a for a in argv if not a.startswith("-") and a.upper() == a and a.isalpha()]

    if symbols:
        assets = [s.upper() for s in symbols]
    elif scan_all:
        assets = ALL_ASSETS
    else:
        assets = DEFAULT_ASSETS

    results = scan_assets(assets, run_debate=run_debate)
    print(format_scan(results))

    # Save to tasks/
    out_dir  = ROOT / "tasks"
    out_dir.mkdir(exist_ok=True)
    ts       = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    out_path = out_dir / f"scan_{ts}.json"
    out_path.write_text(json.dumps(results, indent=2), encoding="utf-8")
    print(f"[SCAN] Saved: {out_path}")

    # Exit 0 if any signal is ready
    sys.exit(0 if any(r.get("signal") not in ("WAIT","NONE","ERROR",None,"") for r in results) else 1)


if __name__ == "__main__":
    main()
