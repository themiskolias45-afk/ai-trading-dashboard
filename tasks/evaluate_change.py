"""Evidence gate for autonomous improvement.

The problem this solves: an agent that edits the trading engine every morning
makes the system worse, because most changes are worse and nothing measures them.
Today alone, ADX + structural stops measured better and were kept; symmetric short
setups measured worse and were reverted. The difference was measurement, not
judgement.

So no change reaches the live engine unless it beats the current configuration on
data it was not chosen on.

    python tasks/evaluate_change.py --setting confidenceThreshold --values 55,60,65,70

Reads the exported MT5 bars (tasks/export_mt5_history.py), replays the engine's own
setup logic through server/index.js via node, and reports each variant against the
current baseline on a train/test split. Verdict is decided on the TEST half only.

Exit code 0 = a variant beat baseline out-of-sample. 1 = nothing did, keep current.
"""

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HIST = os.path.join(ROOT, "tasks", "history")
LOG = os.path.join(ROOT, "tasks", "logs", "improvement_log.jsonl")

SYMBOLS = [("BTCUSD", "BTC"), ("XAUUSD", "Gold"), ("SP500", "SPX")]

# A change must clear this margin on the test half to be worth the risk of
# touching a working system. Small wins are usually noise.
MIN_PF_IMPROVEMENT = 0.10
COST_R = 0.05

# Settings this may change on its own.
#
# Deliberately excludes fixedLotSize and maxLotSize: those decide how much money
# is at risk per trade, and an unattended process should not size positions. The
# ones here only decide WHICH trades qualify, and every value is clamped
# server-side, so the worst case is a config inside a range you already approved.
AUTO_TUNABLE = {"confidenceThreshold", "maxConcurrentPositions", "maxTradesPerDay"}

SETTINGS_PATH = os.path.join(ROOT, "server", "strategy_settings.json")


def load_bars(symbol, tf):
    path = os.path.join(HIST, f"{symbol}_{tf}.csv")
    if not os.path.exists(path):
        return []
    import csv
    with open(path, newline="") as fh:
        return [{"t": int(r["time"]), "o": float(r["open"]), "h": float(r["high"]),
                 "l": float(r["low"]), "c": float(r["close"])} for r in csv.DictReader(fh)]


def summarise(trades):
    wins = [t for t in trades if t["outcome"] == "WIN"]
    losses = [t for t in trades if t["outcome"] == "LOSS"]
    closed = len(wins) + len(losses)
    if closed == 0:
        return {"n": len(trades), "wr": 0.0, "pf": 0.0, "R": 0.0, "rpt": 0.0}
    gross_win = sum(t["rr"] - COST_R for t in wins)
    gross_loss = sum(1.0 + COST_R for t in losses)
    total = gross_win - gross_loss
    return {"n": len(trades),
            "wr": len(wins) / closed * 100,
            "pf": (gross_win / gross_loss) if gross_loss else float("inf"),
            "R": total,
            "rpt": total / closed}


def replay(symbol, tf, setting, value):
    """Run the real engine over historical bars with one setting overridden.

    Uses server/index.js so the thing being measured is the code that will run
    live — not a Python re-implementation that can drift away from it.
    """
    script = os.path.join(ROOT, "tasks", "_replay_engine.cjs")
    env = dict(os.environ)
    if setting:
        env["OVERRIDE_SETTING"] = setting
        env["OVERRIDE_VALUE"] = str(value)
    try:
        out = subprocess.run(
            ["node", script, os.path.join(HIST, f"{symbol}_{tf}.csv")],
            capture_output=True, text=True, timeout=300, env=env, cwd=ROOT)
        if out.returncode != 0:
            return None, (out.stderr or "").strip()[:200]
        return json.loads(out.stdout), None
    except subprocess.TimeoutExpired:
        return None, "replay timed out"
    except Exception as exc:
        return None, str(exc)[:200]


def evaluate(setting, values, tf):
    print(f"Evaluating {setting} over {values}   timeframe {tf}")
    print("Verdict decided on the TEST half only — the half no variant was chosen on.\n")

    results = {}
    for symbol, label in SYMBOLS:
        bars = load_bars(symbol, tf)
        if len(bars) < 300:
            print(f"  {label}: not enough bars — run tasks/export_mt5_history.py first")
            continue
        split_t = bars[0]["t"] + int((bars[-1]["t"] - bars[0]["t"]) * 0.6)

        print(f"  {label}")
        print(f"    {'value':<12}{'trades':<9}{'TRAIN pf':<11}{'TEST pf':<10}{'TEST wr':<10}{'TEST R'}")
        for value in values:
            trades, err = replay(symbol, tf, setting, value)
            if trades is None:
                print(f"    {str(value):<12}replay failed: {err}")
                continue
            train = summarise([t for t in trades if t["t"] < split_t])
            test = summarise([t for t in trades if t["t"] >= split_t])
            results.setdefault(value, []).append((label, train, test))
            print(f"    {str(value):<12}{len(trades):<9}{train['pf']:<11.2f}"
                  f"{test['pf']:<10.2f}{test['wr']:<10.1f}{test['R']:+.1f}")
        print()
    return results


def decide(results, baseline_value):
    """A variant wins only if it beats baseline on the TEST half on a MAJORITY of
    assets. One asset improving while two get worse is not an improvement."""
    if baseline_value not in results:
        return None, "baseline not evaluated"

    base = {label: test["pf"] for label, _, test in results[baseline_value]}
    best, best_score = None, 0

    for value, rows in results.items():
        if value == baseline_value:
            continue
        better = sum(1 for label, _, test in rows
                     if test["pf"] >= base.get(label, 0) + MIN_PF_IMPROVEMENT)
        worse = sum(1 for label, _, test in rows if test["pf"] < base.get(label, 0))
        if better > worse and better > len(rows) / 2 and better > best_score:
            best, best_score = value, better

    if best is None:
        return None, "no variant beat the current setting on a majority of assets"
    return best, f"beat baseline on {best_score}/{len(results[best])} assets"


def apply_setting(setting, value):
    """Write one setting into strategy_settings.json.

    Only ever touches the named key, so a concurrent dashboard edit to a different
    setting is preserved. The server clamps on load, so an out-of-range value
    cannot widen a limit beyond what is already permitted.
    """
    try:
        current = {}
        if os.path.exists(SETTINGS_PATH):
            with open(SETTINGS_PATH, encoding="utf-8-sig") as fh:
                current = json.load(fh)
        num = float(value)
        current[setting] = int(num) if num.is_integer() else num
        current["updatedAt"] = datetime.utcnow().isoformat() + "Z"
        current["updatedBy"] = "auto-tune"
        tmp = SETTINGS_PATH + ".tmp"
        with open(tmp, "w", encoding="ascii") as fh:
            json.dump(current, fh)
        os.replace(tmp, SETTINGS_PATH)
        return True, None
    except Exception as exc:
        return False, str(exc)[:200]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--setting", required=True)
    ap.add_argument("--values", required=True, help="comma separated")
    ap.add_argument("--baseline", help="current live value (defaults to first)")
    ap.add_argument("--tf", default="H4")
    ap.add_argument("--apply", action="store_true",
                    help="write a passing recommendation to strategy_settings.json")
    args = ap.parse_args()

    values = [v.strip() for v in args.values.split(",") if v.strip()]
    baseline = args.baseline or values[0]

    results = evaluate(args.setting, values, args.tf)
    if not results:
        print("No results — nothing to decide.")
        return 1

    winner, reason = decide(results, baseline)
    print("=" * 70)
    if winner and args.apply and args.setting in AUTO_TUNABLE:
        applied, err = apply_setting(args.setting, winner)
        if applied:
            print(f"APPLIED {args.setting}: {baseline} -> {winner}   ({reason})")
            print("Restart the server task for it to take effect.")
        else:
            print(f"RECOMMEND {args.setting} = {winner} but apply FAILED: {err}")
    elif winner and args.apply:
        print(f"RECOMMEND {args.setting} = {winner}   ({reason})")
        print(f"NOT auto-applied: {args.setting} is not in the auto-tunable set "
              f"({', '.join(sorted(AUTO_TUNABLE))}).")
    elif winner:
        print(f"RECOMMEND {args.setting} = {winner}   ({reason})")
        print(f"Current is {baseline}. Run with --apply to write it.")
    else:
        print(f"KEEP {args.setting} = {baseline}   ({reason})")
    print("=" * 70)

    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    with open(LOG, "a", encoding="ascii") as fh:
        fh.write(json.dumps({
            "at": datetime.utcnow().isoformat() + "Z",
            "setting": args.setting, "tested": values, "baseline": baseline,
            "winner": winner, "reason": reason,
        }) + "\n")

    return 0 if winner else 1


if __name__ == "__main__":
    sys.exit(main())
