"""Cost/benefit of minStrength=MODERATE: significance of the gap, and the
learning-rate it buys. Answers two questions the cross-tab leaves open:
  1. Are the strength expectancy differences distinguishable from noise?
  2. How many months until the self-learning engine has enough closed trades
     under each candidate gate?
"""

import json
import math
import os
import random
import sys
from collections import defaultdict
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tasks"))
from evaluate_change import COST_R, summarise  # noqa: E402

FACTS = os.path.join(ROOT, "tasks", "analysis", "facts-20260731-2303.json")
CF_DIR = os.path.join(ROOT, "tasks", "analysis", "_tmp_strengthgate")
CF_FILES = [("BTC", "D1", "BTCUSD_D1"), ("BTC", "H4", "BTCUSD_H4"),
            ("Gold", "D1", "XAUUSD_D1"), ("Gold", "H4", "XAUUSD_H4"),
            ("SPX", "D1", "SP500_D1"), ("SPX", "H4", "SP500_H4")]
LEARN_THRESHOLD = 30   # closed trades per setup before stats mean anything
BOOTSTRAP = 20000
random.seed(7)


def year_of(trade):
    return datetime.fromtimestamp(trade["t"], tz=timezone.utc).year


def rs(rows):
    """Per-trade R, defined exactly as summarise() computes the book total."""
    return [(t["rr"] - COST_R) if t["outcome"] == "WIN" else -(1.0 + COST_R)
            for t in rows if t["outcome"] in ("WIN", "LOSS")]


def boot_diff(a_rows, b_rows):
    """P(expectancy(a) <= expectancy(b)) by bootstrap resampling."""
    a, b = rs(a_rows), rs(b_rows)
    if len(a) < 2 or len(b) < 2:
        return None, None, None
    diffs = []
    for _ in range(BOOTSTRAP):
        sa = sum(random.choice(a) for _ in a) / len(a)
        sb = sum(random.choice(b) for _ in b) / len(b)
        diffs.append(sa - sb)
    diffs.sort()
    point = sum(a) / len(a) - sum(b) / len(b)
    lo, hi = diffs[int(0.025 * BOOTSTRAP)], diffs[int(0.975 * BOOTSTRAP)]
    p_worse = sum(1 for d in diffs if d <= 0) / BOOTSTRAP
    return point, (lo, hi), p_worse


def span_months(rows):
    ts = [r["t"] for r in rows]
    return (max(ts) - min(ts)) / (365.25 * 24 * 3600) * 12


def main():
    with open(FACTS, encoding="utf-8") as fh:
        facts = json.load(fh)
    live = facts["trades"]
    counterfactual = []
    for asset, tf, stem in CF_FILES:
        with open(os.path.join(CF_DIR, f"{stem}.json"), encoding="utf-8") as fh:
            for trade in json.load(fh):
                trade["asset"], trade["timeframe"] = asset, tf
                counterfactual.append(trade)

    moderate = [t for t in live if t["strength"] == "MODERATE"]
    strong = [t for t in live if t["strength"] == "STRONG"]
    months = span_months(live)

    print(f"### A. Is the strength gap real? bootstrap {BOOTSTRAP}x, "
          "95% CI on expectancy difference (R/trade) ###")
    tests = [
        ("MODERATE vs STRONG, all years", moderate, strong),
        ("MODERATE vs STRONG, ex-2024",
         [t for t in moderate if year_of(t) != 2024],
         [t for t in strong if year_of(t) != 2024]),
        ("MODERATE adx>=20 vs STRONG, all",
         [t for t in moderate if t.get("adx") is not None and t["adx"] >= 20], strong),
        ("MODERATE adx>=20 vs STRONG, ex-2024",
         [t for t in moderate if t.get("adx") is not None and t["adx"] >= 20
          and year_of(t) != 2024],
         [t for t in strong if year_of(t) != 2024]),
        ("MODERATE adx<20 vs STRONG, all",
         [t for t in moderate if t.get("adx") is not None and t["adx"] < 20], strong),
    ]
    for label, a, b in tests:
        point, ci, p_worse = boot_diff(a, b)
        if point is None:
            continue
        verdict = "SIGNIFICANT" if (ci[0] > 0 or ci[1] < 0) else "noise"
        print(f"{label:<38} diff={point:+7.3f}  CI[{ci[0]:+.3f},{ci[1]:+.3f}]  "
              f"P(MOD<=STR)={p_worse:.2f}  {verdict}")

    print("\n### B. Per-setup: MODERATE vs STRONG, is the difference distinguishable? ###")
    print(f"{'setup':<20} {'nMOD':>5} {'nSTR':>5} {'expMOD':>8} {'expSTR':>8} "
          f"{'diff':>8} {'95% CI':>20}  verdict")
    for setup in sorted({t["setup"] for t in live}):
        a = [t for t in moderate if t["setup"] == setup]
        b = [t for t in strong if t["setup"] == setup]
        point, ci, _ = boot_diff(a, b)
        if point is None:
            continue
        verdict = "MOD better" if ci[0] > 0 else ("MOD worse" if ci[1] < 0 else "indistinguishable")
        print(f"{setup:<20} {len(rs(a)):>5} {len(rs(b)):>5} "
              f"{summarise(a)['rpt']:>8.3f} {summarise(b)['rpt']:>8.3f} "
              f"{point:>+8.3f} [{ci[0]:>+7.3f},{ci[1]:>+7.3f}]  {verdict}")

    print(f"\n### C. Learning rate: months to {LEARN_THRESHOLD} closed trades "
          f"(replay spans {months:.0f} months, 3 assets x 2 TF) ###")
    survivors = ["MOMENTUM", "SQUEEZE_BREAKOUT"]
    gates = {
        "A. STRONG only (revert)": strong,
        "B. MODERATE everywhere (today)": live,
        "C. STRONG + MODERATE on MOM+SQZ": strong + [t for t in moderate if t["setup"] in survivors],
        "D. C minus RANGE_TRADE_LONG":
            [t for t in strong if t["setup"] != "RANGE_TRADE_LONG"]
            + [t for t in moderate if t["setup"] in survivors],
    }
    for label, rows in gates.items():
        closed = len(rs(rows))
        per_month = closed / months
        whole = summarise(rows)
        ex24 = summarise([t for t in rows if year_of(t) != 2024])
        setups_ok = sum(1 for s in {t["setup"] for t in rows}
                        if len(rs([t for t in rows if t["setup"] == s])) / months * 12 >= LEARN_THRESHOLD)
        print(f"{label:<34} closed/mo={per_month:>5.1f}  "
              f"mo_to_{LEARN_THRESHOLD}={LEARN_THRESHOLD / per_month:>4.1f}  "
              f"setups>={LEARN_THRESHOLD}/yr={setups_ok}  "
              f"R={whole['R']:>7.2f} exp={whole['rpt']:>+.3f}  "
              f"ex24 R={ex24['R']:>7.2f} exp={ex24['rpt']:>+.3f}")

    print("\n### D. Cost of the extra volume, priced in R at 1% risk/trade ###")
    base = summarise(strong)
    for label, rows in gates.items():
        stats, ex24 = summarise(rows), summarise([t for t in rows if year_of(t) != 2024])
        n_yr = len(rs(rows)) / months * 12
        print(f"{label:<34} trades/yr={n_yr:>5.0f}  "
              f"R/yr(all)={stats['R'] / months * 12:>+7.2f}  "
              f"R/yr(ex24)={ex24['R'] / (months - 12) * 12:>+7.2f}")
    print(f"\n(STRONG baseline exp={base['rpt']:+.3f}; ex-2024 is the honest "
          "estimate — 2024 is MODERATE's outlier year)")


if __name__ == "__main__":
    main()
