"""Setup-fit analysis: which setups genuinely earn, which bleed, which are noise.

Reads the fact pack's raw trade list and re-derives every number with the same
cost model the evidence gate uses (COST_R per side), then adds what the
precomputed buckets cannot show: per-year and per-asset stability, a bootstrap
confidence interval on expectancyR, and a leave-one-year-out check.
"""
import json
import os
import random
from collections import defaultdict
from datetime import datetime, timezone

COST_R = 0.05
FACTS = os.path.join(os.path.dirname(__file__), "analysis", "facts-20260801-2302.json")
BOOTSTRAP_ROUNDS = 20000
random.seed(11)


def r_of(trade):
    """Realised R for one closed trade, costs included. None if still open."""
    if trade["outcome"] == "WIN":
        return trade["rr"] - COST_R
    if trade["outcome"] == "LOSS":
        return -(1.0 + COST_R)
    return None


def summarise(rows):
    values = [r for r in (r_of(t) for t in rows) if r is not None]
    if not values:
        return None
    wins = [v for v in values if v > 0]
    losses = [v for v in values if v <= 0]
    gross_win = sum(wins)
    gross_loss = -sum(losses)
    return {
        "closed": len(values),
        "winRatePct": len(wins) / len(values) * 100,
        "profitFactor": (gross_win / gross_loss) if gross_loss else float("inf"),
        "totalR": sum(values),
        "expectancyR": sum(values) / len(values),
    }


def bootstrap_ci(rows, rounds=BOOTSTRAP_ROUNDS, lo_pct=2.5, hi_pct=97.5):
    """Percentile CI on mean R per closed trade. Resampling trades, not days."""
    values = [r for r in (r_of(t) for t in rows) if r is not None]
    if len(values) < 2:
        return None
    n = len(values)
    means = sorted(sum(random.choices(values, k=n)) / n for _ in range(rounds))
    return (means[int(rounds * lo_pct / 100)], means[int(rounds * hi_pct / 100)])


def year_of(trade):
    return datetime.fromtimestamp(trade["t"], tz=timezone.utc).year


def main():
    facts = json.load(open(FACTS))
    trades = facts["trades"]
    by_setup = defaultdict(list)
    for trade in trades:
        by_setup[trade["setup"]].append(trade)

    overall = summarise(trades)
    print(f"OVERALL closed={overall['closed']} expR={overall['expectancyR']:+.3f} "
          f"totalR={overall['totalR']:+.2f} PF={overall['profitFactor']:.2f}\n")

    ranked = sorted(by_setup.items(), key=lambda kv: summarise(kv[1])["expectancyR"])
    for setup, rows in ranked:
        stats = summarise(rows)
        ci = bootstrap_ci(rows)
        ci_text = f"[{ci[0]:+.3f}, {ci[1]:+.3f}]" if ci else "n/a"
        print(f"{setup:20s} closed={stats['closed']:5d} WR={stats['winRatePct']:5.1f}% "
              f"PF={stats['profitFactor']:5.2f} totR={stats['totalR']:+8.2f} "
              f"expR={stats['expectancyR']:+.3f}  95%CI {ci_text}")

        for label, key_fn in (("year", year_of), ("asset", lambda t: t["asset"]),
                              ("tf", lambda t: t["timeframe"])):
            groups = defaultdict(list)
            for trade in rows:
                groups[key_fn(trade)].append(trade)
            parts = []
            for key in sorted(groups):
                sub = summarise(groups[key])
                if sub:
                    parts.append(f"{key}:{sub['expectancyR']:+.2f}(n{sub['closed']})")
            print(f"    {label:5s} " + "  ".join(parts))

        # leave-one-year-out: does the whole edge live in a single year?
        years = defaultdict(list)
        for trade in rows:
            years[year_of(trade)].append(trade)
        worst_drop = None
        for year in years:
            rest = [t for y, g in years.items() if y != year for t in g]
            sub = summarise(rest)
            if sub and (worst_drop is None or sub["expectancyR"] < worst_drop[1]):
                worst_drop = (year, sub["expectancyR"], sub["closed"])
        if worst_drop:
            print(f"    LOYO  worst without {worst_drop[0]}: expR={worst_drop[1]:+.3f} "
                  f"(n={worst_drop[2]})")
        print()


if __name__ == "__main__":
    main()
