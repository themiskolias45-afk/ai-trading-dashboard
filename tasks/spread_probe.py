"""Samples live broker spreads so an instrument decision rests on measured cost.

    python tasks/spread_probe.py            # take one sample, append to the log
    python tasks/spread_probe.py --report   # summarise everything sampled so far

Written for one question: SP500 -> NAS100. The scan that proposed that swap measured
PRICE behaviour and charged a flat 0.05R; it knew nothing about what this broker
actually charges to get in. A spread that eats the edge, or that trips MAX_SPREAD,
settles the question regardless of what the replay said.

TWO THINGS THIS DOES CAREFULLY

1. Market Watch is state the live bridge shares. A symbol outside it returns no tick,
   so a spread reading REQUIRES symbol_select(). This records which symbols were
   already visible, selects only the ones that were not, and deselects ONLY those at
   the end. The bridge's own symbols are never deselected even if this script somehow
   selected them -- BRIDGE_OWNED is refused explicitly rather than by luck.

2. A closed market still answers symbol_info(). It returns the LAST spread, not a
   live one, and on a weekend that number is meaningless. Every sample records
   `trade_allowed` and the tick age, and --report separates live samples from stale
   ones instead of averaging them together into a number that looks like evidence.
"""

import json
import os
import sys
import time
from datetime import datetime, timezone

try:
    import MetaTrader5 as mt5
except ImportError:
    print("MetaTrader5 package not installed for this interpreter.")
    sys.exit(1)

HERE = os.path.dirname(os.path.abspath(__file__))
LOG_PATH = os.path.join(HERE, "logs", "spread_probe.jsonl")

# The candidate, its future, and the incumbent it would replace. SP500 is the whole
# point of the comparison: a NAS100 spread only means something beside it.
PROBE_SYMBOLS = ["NAS100", "NAS100ft", "SP500", "XAUUSD", "BTCUSD", "SMH", "BAC"]

# Never deselected by this script, whatever else happens. The bridge selected these
# at startup and trades them.
BRIDGE_OWNED = {"BTCUSD", "XAUUSD", "SP500"}

# From the account risk config (maxSpreadPts). Recorded with every sample so a later
# reader does not have to guess which cap was in force at the time.
MAX_SPREAD_POINTS = 50

# A tick older than this is not a live quote. Used only to label samples, never to
# discard them -- a stale reading is evidence about market hours.
LIVE_TICK_MAX_AGE_S = 120


def take_sample():
    if not mt5.initialize():
        return {"error": f"mt5.initialize failed: {mt5.last_error()}"}

    selected_by_us = []
    samples = []

    try:
        book = {s.name: s for s in (mt5.symbols_get() or [])}

        for name in PROBE_SYMBOLS:
            if name not in book:
                samples.append({"symbol": name, "error": "not in broker book"})
                continue

            if not book[name].visible:
                if mt5.symbol_select(name, True):
                    selected_by_us.append(name)
                else:
                    samples.append({"symbol": name, "error": "symbol_select failed"})
                    continue

            info = mt5.symbol_info(name)
            tick = mt5.symbol_info_tick(name)
            if info is None:
                samples.append({"symbol": name, "error": "symbol_info returned None"})
                continue

            tick_age = None
            if tick is not None and tick.time:
                tick_age = max(0.0, time.time() - tick.time)

            point = info.point or 0
            spread_price = (info.ask - info.bid) if (info.ask and info.bid) else None

            samples.append({
                "symbol": name,
                "spread_points": info.spread,
                "spread_price": round(spread_price, 6) if spread_price is not None else None,
                "bid": info.bid,
                "ask": info.ask,
                "point": point,
                "digits": info.digits,
                "volume_min": info.volume_min,
                # trade_mode 0 == SYMBOL_TRADE_MODE_DISABLED. Anything else is some
                # form of tradeable, which is what distinguishes "market shut" from
                # "instrument not available to this account".
                "trade_mode": info.trade_mode,
                "tick_age_s": round(tick_age, 1) if tick_age is not None else None,
                "live": tick_age is not None and tick_age <= LIVE_TICK_MAX_AGE_S,
                "over_cap": info.spread > MAX_SPREAD_POINTS,
            })

        return {
            "at": datetime.now(timezone.utc).isoformat(),
            "max_spread_points": MAX_SPREAD_POINTS,
            "samples": samples,
        }

    finally:
        for name in selected_by_us:
            if name in BRIDGE_OWNED:
                continue          # belt and braces: never hide a traded symbol
            mt5.symbol_select(name, False)
        mt5.shutdown()


def append_log(record):
    os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
    with open(LOG_PATH, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(record) + "\n")


def report():
    if not os.path.exists(LOG_PATH):
        print(f"No samples yet at {LOG_PATH}")
        return

    by_symbol = {}
    total_records = 0
    with open(LOG_PATH, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue          # a torn final line must not lose the whole file
            if "samples" not in record:
                continue
            total_records += 1
            for sample in record["samples"]:
                if "spread_points" not in sample:
                    continue
                entry = by_symbol.setdefault(sample["symbol"], {"live": [], "stale": []})
                entry["live" if sample.get("live") else "stale"].append(sample["spread_points"])

    if not by_symbol:
        print(f"{total_records} records, but no usable spread readings yet.")
        return

    print(f"SPREAD PROBE - {total_records} samples, cap {MAX_SPREAD_POINTS} points\n")
    print(f"{'symbol':<12}{'live n':>7}{'median':>8}{'min':>7}{'max':>7}"
          f"{'vs cap':>14}   {'stale n':>8}")
    print("-" * 64)

    for name in PROBE_SYMBOLS:
        if name not in by_symbol:
            continue
        live = sorted(by_symbol[name]["live"])
        stale = by_symbol[name]["stale"]
        if not live:
            print(f"{name:<12}{0:>7}{'-':>8}{'-':>7}{'-':>7}{'no live tick':>14}   {len(stale):>8}")
            continue
        median = live[len(live) // 2]
        verdict = "OVER CAP" if median > MAX_SPREAD_POINTS else f"{100*median/MAX_SPREAD_POINTS:.0f}% of cap"
        print(f"{name:<12}{len(live):>7}{median:>8}{live[0]:>7}{live[-1]:>7}{verdict:>14}   {len(stale):>8}")

    print("\nlive = tick under 120s old. stale readings are the last quote before the")
    print("market shut and are NOT averaged in - a weekend number is not a cost.")


def main():
    if "--report" in sys.argv:
        report()
        return

    record = take_sample()
    if "error" in record:
        append_log({"at": datetime.now(timezone.utc).isoformat(), "error": record["error"]})
        print(f"sample failed: {record['error']}")
        sys.exit(1)

    append_log(record)
    live = [s for s in record["samples"] if s.get("live")]
    print(f"sampled {len(record['samples'])} symbols, {len(live)} live")
    for sample in record["samples"]:
        if "spread_points" in sample:
            flag = "LIVE" if sample.get("live") else "stale"
            cap = " OVER-CAP" if sample.get("over_cap") else ""
            print(f"  {sample['symbol']:<10} {sample['spread_points']:>6} pts  {flag}{cap}")
        else:
            print(f"  {sample['symbol']:<10} {sample.get('error')}")


if __name__ == "__main__":
    main()
