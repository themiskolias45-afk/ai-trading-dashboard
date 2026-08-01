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
2 = the sweep measured nothing and its verdict is not evidence (see DEGENERATE).
"""

import argparse
import json
import math
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

# Exit codes. The third one exists because "no variant won" and "the harness
# could not see this parameter at all" produced the same output for weeks, and a
# caller cannot act on a verdict it cannot distinguish from a broken run.
EXIT_VARIANT_WINS = 0
EXIT_KEEP_CURRENT = 1
EXIT_SWEEP_DEGENERATE = 2

# A sweep needs at least two variants before "they all agree" means anything.
MIN_VALUES_FOR_DEGENERACY_CHECK = 2

# Settings this may change on its own.
#
# Deliberately excludes fixedLotSize and maxLotSize: those decide how much money
# is at risk per trade, and an unattended process should not size positions. The
# ones here only decide WHICH trades qualify, and every value is clamped
# server-side, so the worst case is a config inside a range you already approved.
# Only adxTrendingMin is currently measurable: it lives inside generateSignal,
# which is what the replay runs. confidenceThreshold sits in generateSignalMTF and
# the position/trade caps are enforced in the bridge, so the replay cannot see
# them - testing those would silently return KEEP every time.
AUTO_TUNABLE = {"adxTrendingMin"}

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


def variant_fingerprint(rows):
    """Collapse one variant's per-asset results into a comparable signature.

    Deliberately includes the trade counts as well as the metrics: two variants
    that took the same number of trades but placed them differently are a real
    measurement, while two that match on both took literally the same trades.
    """
    return [(label, train["n"], train["pf"], train["R"],
             test["n"], test["pf"], test["wr"], test["R"])
            for label, train, test in rows]


def is_degenerate(results):
    """True when every tested value produced an identical trade set on every asset.

    A threshold sweep that does not move a single trade has not measured the
    parameter — it has replayed one configuration N times. The verdict that comes
    out is then a statement about the harness, not about the setting, and it is
    printed in exactly the same words as a real one. That is how the weekly job
    reported a confident KEEP every week while measuring nothing at all.

    Conservative by construction: any difference anywhere, including one asset
    whose replay failed under only some variants, makes the fingerprints differ
    and leaves the normal verdict path alone.
    """
    if len(results) < MIN_VALUES_FOR_DEGENERACY_CHECK:
        return False
    fingerprints = [variant_fingerprint(rows) for rows in results.values()]
    return all(fp == fingerprints[0] for fp in fingerprints[1:])


def beats_baseline(variant_pf, baseline_pf):
    """Whether a variant's profit factor is a real improvement on the baseline's.

    Infinity needs its own case. A test half with zero losses scores pf = inf, and
    `inf >= inf + MIN_PF_IMPROVEMENT` is True in IEEE arithmetic — so a variant
    that is byte-identical to the baseline would score as beating it, and with
    --apply that writes a config change backed by nothing.
    """
    if not math.isfinite(variant_pf) or not math.isfinite(baseline_pf):
        return variant_pf > baseline_pf
    return variant_pf >= baseline_pf + MIN_PF_IMPROVEMENT


def decide(results, baseline_value):
    """A variant wins only if it beats baseline on the TEST half on a MAJORITY of
    assets. One asset improving while two get worse is not an improvement."""
    if baseline_value not in results:
        return None, "baseline not evaluated"

    base = {label: test["pf"] for label, _, test in results[baseline_value]}
    best, best_score, best_total = None, 0, 0

    for value, rows in results.items():
        if value == baseline_value:
            continue
        # Only assets the BASELINE was actually measured on can be compared. A
        # missing baseline used to read as pf 0.0, which made every variant look
        # like a winner on precisely the assets there was no evidence for.
        comparable = [(label, test) for label, _, test in rows if label in base]
        if not comparable:
            continue
        better = sum(1 for label, test in comparable if beats_baseline(test["pf"], base[label]))
        worse = sum(1 for label, test in comparable if test["pf"] < base[label])
        if better > worse and better > len(comparable) / 2 and better > best_score:
            best, best_score, best_total = value, better, len(comparable)

    if best is None:
        return None, "no variant beat the current setting on a majority of assets"
    return best, f"beat baseline on {best_score}/{best_total} assets"


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


def write_log(setting, values, baseline, winner, reason, degenerate):
    """Append one line to the improvement log. Never lets a logging failure mask
    the verdict the caller actually ran for."""
    try:
        os.makedirs(os.path.dirname(LOG), exist_ok=True)
        with open(LOG, "a", encoding="ascii") as fh:
            fh.write(json.dumps({
                "at": datetime.utcnow().isoformat() + "Z",
                "setting": setting, "tested": values, "baseline": baseline,
                "winner": winner, "reason": reason, "degenerate": degenerate,
            }) + "\n")
    except Exception as exc:
        print(f"WARNING: could not write {LOG}: {str(exc)[:200]}")


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
        return EXIT_KEEP_CURRENT

    # Checked before any verdict is formed, so a meaningless sweep can never
    # reach --apply and write a config change it has no evidence for.
    if is_degenerate(results):
        # Say how many variants actually replayed. Claiming "every tested value"
        # when half the sweep crashed would be the same overconfidence this guard
        # exists to stop.
        reason = (f"all {len(results)} of {len(values)} replayed values produced an "
                  f"identical trade set on every asset — {args.setting} moved nothing")
        print("=" * 70)
        print(f"DEGENERATE SWEEP — no verdict. ({reason})")
        print("This run measured the harness, not the setting. A KEEP printed")
        print("here would be indistinguishable from one backed by real evidence.")
        print(f"Check that {args.setting} gates trade SELECTION in the replayed")
        print("path: a setting that only relabels a signal the replay already")
        print("accepts cannot move a single trade, however far you sweep it.")
        print("=" * 70)
        write_log(args.setting, values, baseline, None, reason, True)
        return EXIT_SWEEP_DEGENERATE

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

    write_log(args.setting, values, baseline, winner, reason, False)

    return EXIT_VARIANT_WINS if winner else EXIT_KEEP_CURRENT


if __name__ == "__main__":
    sys.exit(main())
