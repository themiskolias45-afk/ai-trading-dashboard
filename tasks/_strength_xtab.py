"""Cross-tab the strength gate: is MODERATE really worse than STRONG?

Reads the archived fact pack (minStrength=MODERATE replay) and the STRONG-only
counterfactual replay in tasks/analysis/_tmp_strengthgate/, and slices the
strength axis by setup, year, asset, timeframe and ADX band.

Single-axis buckets are what mislead: MODERATE is not "a weaker signal", it is
genuinely-moderate signals PLUS every STRONG signal demoted by the ADX gate in
server/index.js. Any comparison that ignores that is comparing regimes, not
signal quality.
"""

import json
import os
import sys
from collections import defaultdict
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tasks"))
from evaluate_change import summarise  # noqa: E402

FACTS = os.path.join(ROOT, "tasks", "analysis", "facts-20260731-2303.json")
CF_DIR = os.path.join(ROOT, "tasks", "analysis", "_tmp_strengthgate")
CF_FILES = [("BTC", "D1", "BTCUSD_D1"), ("BTC", "H4", "BTCUSD_H4"),
            ("Gold", "D1", "XAUUSD_D1"), ("Gold", "H4", "XAUUSD_H4"),
            ("SPX", "D1", "SP500_D1"), ("SPX", "H4", "SP500_H4")]
MIN_SAMPLE = 5


def line(label, rows, width=32):
    stats = summarise(rows)
    closed = sum(1 for r in rows if r["outcome"] in ("WIN", "LOSS"))
    pf = "inf" if stats["pf"] == float("inf") else f"{stats['pf']:.2f}"
    flag = "  <MIN_SAMPLE" if closed < MIN_SAMPLE else ""
    print(f"{label:<{width}} n={stats['n']:>5} closed={closed:>5} "
          f"WR={stats['wr']:>5.1f} PF={pf:>5} R={stats['R']:>8.2f} "
          f"exp={stats['rpt']:>7.3f}{flag}")


def table(title, rows, key_fn, width=32):
    print(f"\n=== {title} ===")
    groups = defaultdict(list)
    for row in rows:
        key = key_fn(row)
        if key is not None:
            groups[key].append(row)
    for key in sorted(groups, key=lambda k: -len(groups[k])):
        line(str(key), groups[key], width)


def year_of(trade):
    return datetime.fromtimestamp(trade["t"], tz=timezone.utc).year


def main():
    with open(FACTS, encoding="utf-8") as fh:
        facts = json.load(fh)
    live = facts["trades"]

    counterfactual = []
    for asset, tf, stem in CF_FILES:
        path = os.path.join(CF_DIR, f"{stem}.json")
        with open(path, encoding="utf-8") as fh:
            for trade in json.load(fh):
                trade["asset"], trade["timeframe"] = asset, tf
                counterfactual.append(trade)

    print("### 1. Whole-book: gate at MODERATE vs gate at STRONG "
          "(true counterfactual, both re-replayed) ###")
    line("minStrength=MODERATE (live)", live)
    line("minStrength=STRONG (counterfac)", counterfactual)
    moderate_only = [t for t in live if t["strength"] == "MODERATE"]
    strong_in_live = [t for t in live if t["strength"] == "STRONG"]
    line("  of which MODERATE rows", moderate_only)
    line("  of which STRONG rows", strong_in_live)

    print("\n### 2. Is the ADX demotion the whole story? "
          "(STRONG only survives when ADX is trending) ###")
    for label, rows in (("MODERATE", moderate_only), ("STRONG", strong_in_live)):
        adx = [t["adx"] for t in rows if t.get("adx") is not None]
        if adx:
            print(f"{label:<10} adx min={min(adx):.1f} max={max(adx):.1f} "
                  f"mean={sum(adx)/len(adx):.1f}  n_with_adx={len(adx)}")

    table("3. strength x year", live,
          lambda t: f"{year_of(t)} {t['strength']}")

    table("4. strength x asset", live,
          lambda t: f"{t['asset']:<5} {t['strength']}")

    table("5. strength x timeframe", live,
          lambda t: f"{t['timeframe']:<3} {t['strength']}")

    print("\n### 6. Per-setup MODERATE edge, by year "
          "(does the MODERATE advantage repeat, or is it one year?) ###")
    for setup in ("MOMENTUM", "SQUEEZE_BREAKOUT", "BUY_OVERSOLD", "BREAKOUT",
                  "RANGE_TRADE_SHORT", "RANGE_TRADE_LONG", "TREND_FOLLOW"):
        rows = [t for t in live if t["setup"] == setup]
        if not rows:
            continue
        print(f"\n-- {setup} --")
        table_rows = defaultdict(list)
        for t in rows:
            table_rows[f"{year_of(t)} {t['strength']}"].append(t)
        for key in sorted(table_rows):
            line("  " + key, table_rows[key])

    print("\n### 7. MODERATE book with the known-bad setups removed ###")
    line("MODERATE all", moderate_only)
    for drop in (["RANGE_TRADE_LONG"],
                 ["RANGE_TRADE_LONG", "BREAKOUT"],
                 ["RANGE_TRADE_LONG", "BREAKOUT", "RANGE_TRADE_SHORT"],
                 ["RANGE_TRADE_LONG", "BREAKOUT", "RANGE_TRADE_SHORT", "SELL_BOUNCE"]):
        kept = [t for t in moderate_only if t["setup"] not in drop]
        line("  minus " + "+".join(s[:12] for s in drop), kept, 40)
    print("\nMODERATE restricted to the setups where it beats STRONG:")
    winners = ["MOMENTUM", "SQUEEZE_BREAKOUT", "BUY_OVERSOLD", "TREND_FOLLOW"]
    line("  MOMENTUM+SQUEEZE+OVERSOLD+TREND",
         [t for t in moderate_only if t["setup"] in winners], 40)
    print("\nWhole book under that restriction (STRONG everywhere + MODERATE on winners):")
    line("  combined", strong_in_live +
         [t for t in moderate_only if t["setup"] in winners], 40)

    print("\n### 8. Leave-2024-out: does the MODERATE edge survive without its best year? ###")
    for label, rows in (("MODERATE", moderate_only), ("STRONG", strong_in_live)):
        line(f"{label} all years", rows, 40)
        line(f"{label} excluding 2024",
             [t for t in rows if year_of(t) != 2024], 40)

    print("\n### 9. Per setup: years positive out of years with >=MIN_SAMPLE closed,"
          " and ex-2024 expectancy ###")
    print(f"{'setup|strength':<28} {'yrs+':>6} {'exp all':>9} {'exp ex24':>9} {'R ex24':>9}")
    for setup in sorted({t["setup"] for t in live}):
        for strength in ("MODERATE", "STRONG"):
            rows = [t for t in live
                    if t["setup"] == setup and t["strength"] == strength]
            if not rows:
                continue
            by_year = defaultdict(list)
            for t in rows:
                by_year[year_of(t)].append(t)
            judged = [y for y, r in by_year.items()
                      if sum(1 for x in r if x["outcome"] in ("WIN", "LOSS")) >= MIN_SAMPLE]
            positive = sum(1 for y in judged if summarise(by_year[y])["R"] > 0)
            ex24 = [t for t in rows if year_of(t) != 2024]
            all_stats, ex_stats = summarise(rows), summarise(ex24)
            print(f"{setup + '|' + strength:<28} {positive:>3}/{len(judged):<2} "
                  f"{all_stats['rpt']:>9.3f} {ex_stats['rpt']:>9.3f} {ex_stats['R']:>9.2f}")

    print("\n### 10. ADX-matched: STRONG vs MODERATE that was NOT demoted (adx >= 20) ###")
    # STRONG cannot exist below adx 20 - the trend gate demotes it. So the only
    # like-for-like signal-quality comparison is against MODERATE rows that also
    # cleared the ADX floor; MODERATE rows below it contain the demoted STRONGs.
    adx_floor = 20
    line("STRONG (all, adx>=20 by construction)", strong_in_live, 40)
    line("MODERATE, adx>=20 (never demoted)",
         [t for t in moderate_only
          if t.get("adx") is not None and t["adx"] >= adx_floor], 40)
    line("MODERATE, adx<20 (mixed w/ demoted)",
         [t for t in moderate_only
          if t.get("adx") is not None and t["adx"] < adx_floor], 40)

    print("\n### 11. Candidate gates, scored on all years AND ex-2024 ###")
    # A gate that only works with 2024 in the sample is a gate fitted to 2024.
    survivors = ["MOMENTUM", "SQUEEZE_BREAKOUT"]
    candidates = {
        "A. minStrength=STRONG (revert)": strong_in_live,
        "B. minStrength=MODERATE (today)": live,
        "C. MODERATE on MOMENTUM+SQUEEZE only":
            strong_in_live + [t for t in moderate_only if t["setup"] in survivors],
        "D. C, and no RANGE_TRADE_LONG at all":
            [t for t in strong_in_live if t["setup"] != "RANGE_TRADE_LONG"]
            + [t for t in moderate_only if t["setup"] in survivors],
    }
    for label, rows in candidates.items():
        line(label, rows, 40)
        line("     ex-2024", [t for t in rows if year_of(t) != 2024], 40)


if __name__ == "__main__":
    main()
