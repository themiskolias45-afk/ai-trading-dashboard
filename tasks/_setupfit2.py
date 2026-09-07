"""Second pass on setup fit: how concentrated each setup's R is in a handful of
outlier winners, and whether the candidate setup|regime / setup|strength cells
hold up year by year rather than only in aggregate.
"""
import json
import os
from collections import defaultdict
from datetime import datetime, timezone

from _setupfit import FACTS, bootstrap_ci, r_of, summarise, year_of

TOP_N = 3


def concentration(rows):
    """Share of a setup's positive R that comes from its few biggest winners."""
    values = sorted((r for r in (r_of(t) for t in rows) if r is not None), reverse=True)
    total = sum(values)
    top = sum(values[:TOP_N])
    return total, top, values[:TOP_N]


def cell_report(label, rows):
    stats = summarise(rows)
    if not stats:
        print(f"{label:38s} no closed trades")
        return
    ci = bootstrap_ci(rows)
    ci_text = f"[{ci[0]:+.3f}, {ci[1]:+.3f}]" if ci else "n/a"
    years = defaultdict(list)
    for trade in rows:
        years[year_of(trade)].append(trade)
    per_year = []
    negative_years = 0
    for year in sorted(years):
        sub = summarise(years[year])
        if sub:
            per_year.append(f"{year}:{sub['expectancyR']:+.2f}(n{sub['closed']})")
            negative_years += sub["expectancyR"] < 0
    print(f"{label:38s} n={stats['closed']:4d} expR={stats['expectancyR']:+.3f} "
          f"totR={stats['totalR']:+7.2f} CI {ci_text}  neg-years {negative_years}/{len(per_year)}")
    print(f"    {'  '.join(per_year)}")


def main():
    facts = json.load(open(FACTS))
    trades = facts["trades"]

    print("=== R concentration (top %d winners) ===" % TOP_N)
    by_setup = defaultdict(list)
    for trade in trades:
        by_setup[trade["setup"]].append(trade)
    for setup, rows in sorted(by_setup.items(), key=lambda kv: -summarise(kv[1])["totalR"]):
        total, top, values = concentration(rows)
        share = (top / total * 100) if total > 0 else float("nan")
        print(f"{setup:20s} totR={total:+8.2f}  top{TOP_N}={top:+7.2f} "
              f"({share:5.1f}% of total)  biggest={[round(v, 2) for v in values]}")

    print("\n=== candidate cells, year by year ===")
    cells = {
        "RANGE_TRADE_LONG|SQUEEZE": lambda t: t["setup"] == "RANGE_TRADE_LONG" and t["regime"] == "SQUEEZE",
        "RANGE_TRADE_LONG|RANGING": lambda t: t["setup"] == "RANGE_TRADE_LONG" and t["regime"] == "RANGING",
        "RANGE_TRADE_SHORT|RANGING": lambda t: t["setup"] == "RANGE_TRADE_SHORT" and t["regime"] == "RANGING",
        "RANGE_TRADE_SHORT|SQUEEZE": lambda t: t["setup"] == "RANGE_TRADE_SHORT" and t["regime"] == "SQUEEZE",
        "BREAKOUT|MODERATE": lambda t: t["setup"] == "BREAKOUT" and t["strength"] == "MODERATE",
        "BREAKOUT|STRONG": lambda t: t["setup"] == "BREAKOUT" and t["strength"] == "STRONG",
        "SQUEEZE_BREAKOUT|STRONG": lambda t: t["setup"] == "SQUEEZE_BREAKOUT" and t["strength"] == "STRONG",
        "SQUEEZE_BREAKOUT|MODERATE": lambda t: t["setup"] == "SQUEEZE_BREAKOUT" and t["strength"] == "MODERATE",
        "SQUEEZE_BREAKOUT|SQUEEZE": lambda t: t["setup"] == "SQUEEZE_BREAKOUT" and t["regime"] == "SQUEEZE",
        "BUY_OVERSOLD|non-Gold": lambda t: t["setup"] == "BUY_OVERSOLD" and t["asset"] != "Gold",
        "BUY_OVERSOLD|Gold": lambda t: t["setup"] == "BUY_OVERSOLD" and t["asset"] == "Gold",
        "BUY_OVERSOLD|RANGING": lambda t: t["setup"] == "BUY_OVERSOLD" and t["regime"] == "RANGING",
        "RANGE_TRADE_LONG|STRONG": lambda t: t["setup"] == "RANGE_TRADE_LONG" and t["strength"] == "STRONG",
        "TREND_FOLLOW|SQUEEZE": lambda t: t["setup"] == "TREND_FOLLOW" and t["regime"] == "SQUEEZE",
    }
    for label, predicate in cells.items():
        cell_report(label, [t for t in trades if predicate(t)])

    print("\n=== what removing each losing block does to the whole book ===")
    blocks = {
        "SELL_BOUNCE (all)": lambda t: t["setup"] == "SELL_BOUNCE",
        "RANGE_TRADE_LONG (all)": lambda t: t["setup"] == "RANGE_TRADE_LONG",
        "RANGE_TRADE_LONG|SQUEEZE": lambda t: t["setup"] == "RANGE_TRADE_LONG" and t["regime"] == "SQUEEZE",
        "RANGE_TRADE_SHORT|RANGING": lambda t: t["setup"] == "RANGE_TRADE_SHORT" and t["regime"] == "RANGING",
        "BREAKOUT|MODERATE": lambda t: t["setup"] == "BREAKOUT" and t["strength"] == "MODERATE",
        "all four above": lambda t: (
            t["setup"] == "SELL_BOUNCE"
            or (t["setup"] == "RANGE_TRADE_LONG" and t["regime"] == "SQUEEZE")
            or (t["setup"] == "RANGE_TRADE_SHORT" and t["regime"] == "RANGING")
            or (t["setup"] == "BREAKOUT" and t["strength"] == "MODERATE")),
    }
    base = summarise(trades)
    for label, predicate in blocks.items():
        kept = [t for t in trades if not predicate(t)]
        removed = summarise([t for t in trades if predicate(t)])
        after = summarise(kept)
        print(f"{label:28s} drops {removed['closed']:4d} closed  "
              f"totR {base['totalR']:+.2f} -> {after['totalR']:+.2f}  "
              f"expR {base['expectancyR']:+.3f} -> {after['expectancyR']:+.3f}  "
              f"PF {base['profitFactor']:.2f} -> {after['profitFactor']:.2f}")


if __name__ == "__main__":
    main()
