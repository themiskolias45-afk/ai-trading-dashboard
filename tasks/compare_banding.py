"""Compare the OLD strength banding against the NEW one on the MTF path.

OLD: finalStrength = MODERATE only at conf >= 70, so AUTO trades conf >= 70.
NEW: MODERATE at conf >= confidenceThreshold (65), so AUTO trades conf >= 65.

Metric conventions copied from tasks/evaluate_change.py so the numbers are
comparable to what the auto-tuner prints: COST_R 0.05, 60/40 time split,
verdict read off the TEST half only.
"""
import json
import os
import statistics
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

SYMBOLS = [("BTCUSD", "BTC-USD", "BTC"), ("XAUUSD", "GC=F", "Gold"), ("SP500", "^GSPC", "SPX")]
COST_R = 0.05
MIN_PF_IMPROVEMENT = 0.10


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


def run(symbol, ticker, threshold):
    out = subprocess.run(
        ["node", os.path.join(HERE, "_replay_mtf.cjs"), ROOT, symbol, ticker, str(threshold)],
        capture_output=True, text=True, timeout=900)
    if out.returncode != 0:
        return None, (out.stderr or "").strip()[:300]
    return json.loads(out.stdout), None


def fmt(s):
    pf = "inf" if s["pf"] == float("inf") else f"{s['pf']:.2f}"
    return f"n={s['n']:<4} wr={s['wr']:5.1f}%  pf={pf:<6} R={s['R']:+8.1f}  R/trade={s['rpt']:+.3f}"


print("=" * 78)
print("  STRENGTH BANDING — MTF replay (generateSignalMTF, the live path)")
print("  OLD = AUTO trades conf>=70    NEW = AUTO trades conf>=65")
print("=" * 78)

verdict_rows = []
for symbol, ticker, label in SYMBOLS:
    print(f"\n### {label} ({symbol})")
    per = {}
    for thresh in (70, 65):
        trades, err = run(symbol, ticker, thresh)
        if trades is None:
            print(f"  threshold {thresh}: FAILED {err}")
            per[thresh] = None
            continue
        per[thresh] = trades

    if per.get(70) is None or per.get(65) is None:
        continue

    all_t = per[65]
    if all_t:
        split_t = min(t["t"] for t in all_t) + int((max(t["t"] for t in all_t) - min(t["t"] for t in all_t)) * 0.6)
    else:
        split_t = 0

    for thresh in (70, 65):
        tr = per[thresh]
        train = summarise([t for t in tr if t["t"] < split_t])
        test = summarise([t for t in tr if t["t"] >= split_t])
        tag = "OLD" if thresh == 70 else "NEW"
        print(f"  {tag} (>={thresh})  ALL   {fmt(summarise(tr))}")
        print(f"  {tag} (>={thresh})  TRAIN {fmt(train)}")
        print(f"  {tag} (>={thresh})  TEST  {fmt(test)}")
        if thresh == 65:
            verdict_rows.append((label, summarise([t for t in per[70] if t['t'] >= split_t]), test))

    # the band the change actually unlocks
    band = [t for t in per[65] if 65 <= t["conf"] < 70]
    print(f"  --- unlocked band (conf 65-69): {fmt(summarise(band))}")
    if band:
        rrs = sorted(t["rr"] for t in band)
        print(f"      rr  median={statistics.median(rrs):.2f}  max={max(rrs):.2f}  "
              f">5R={sum(1 for r in rrs if r > 5)}/{len(rrs)}")
        outc = {}
        for t in band:
            outc[t["outcome"]] = outc.get(t["outcome"], 0) + 1
        print(f"      outcomes={outc}")
        # PF of the band with rr capped, to show how much of it is R:R inflation
        capped = [dict(t, rr=min(t["rr"], 3.0)) for t in band]
        print(f"      with rr capped at 3R: {fmt(summarise(capped))}")

print("\n" + "=" * 78)
print("  VERDICT — TEST half only, majority-of-assets rule (MIN_PF_IMPROVEMENT 0.10)")
print("=" * 78)
better = worse = 0
for label, old_test, new_test in verdict_rows:
    old_pf, new_pf = old_test["pf"], new_test["pf"]
    mark = "="
    if new_pf >= old_pf + MIN_PF_IMPROVEMENT:
        mark = "BETTER"; better += 1
    elif new_pf < old_pf:
        mark = "WORSE"; worse += 1
    op = "inf" if old_pf == float("inf") else f"{old_pf:.2f}"
    np_ = "inf" if new_pf == float("inf") else f"{new_pf:.2f}"
    print(f"  {label:<5} TEST pf  OLD {op:<6} -> NEW {np_:<6}  "
          f"(n {old_test['n']} -> {new_test['n']})   {mark}")
print()
if better > worse and better > len(verdict_rows) / 2:
    print(f"  RESULT: NEW banding wins on {better}/{len(verdict_rows)} assets — change is justified.")
else:
    print(f"  RESULT: NEW banding does NOT clear the bar ({better} better, {worse} worse) — do not ship as-is.")
print("=" * 78)
