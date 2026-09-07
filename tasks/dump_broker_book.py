"""Dumps the broker's ENTIRE symbol book to JSON. READ-ONLY.

    python tasks/dump_broker_book.py [out.json]

This is the system's real tradeable universe. Any "best instrument" answer drawn from
a hand-picked list is answering a question about the list, not about the market -- so
the candidate set starts here, from what this account can actually trade.

Never calls symbol_select: Market Watch is state the live bridge shares, and adding
1186 symbols to it to satisfy a query would be a far larger footprint than the question
justifies. Everything below comes from symbols_get(), which reads the book without
touching what the terminal displays.

`path` is the broker's own category tree (e.g. "Stocks\\US\\Technology"), which is how
equities get separated from indices, FX and commodities without guessing from names.
"""

import json
import os
import sys

try:
    import MetaTrader5 as mt5
except ImportError:
    print("MetaTrader5 package not installed for this interpreter.")
    sys.exit(1)

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_OUT = os.path.join(HERE, "analysis", "broker-book.json")

# SYMBOL_TRADE_MODE_FULL. Anything less is long-only, short-only, close-only or
# disabled, none of which this engine can trade normally, so the dump records the
# raw value and lets the consumer decide rather than filtering here.
TRADE_MODE_FULL = 4


def main():
    out_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_OUT

    if not mt5.initialize():
        print(f"mt5.initialize failed: {mt5.last_error()}")
        sys.exit(1)

    try:
        book = mt5.symbols_get() or []
        rows = []
        for symbol in book:
            rows.append({
                "name": symbol.name,
                "path": symbol.path,
                "description": symbol.description,
                "tradeMode": symbol.trade_mode,
                "tradeable": symbol.trade_mode == TRADE_MODE_FULL,
                "volumeMin": symbol.volume_min,
                "volumeStep": symbol.volume_step,
                "digits": symbol.digits,
                "currencyProfit": symbol.currency_profit,
                "visible": symbol.visible,
            })

        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        with open(out_path, "w", encoding="utf-8") as handle:
            json.dump({"count": len(rows), "symbols": rows}, handle, indent=1)

        # The category breakdown is the useful summary: it says how much of the book is
        # actually equities before anyone tries to fetch history for all of it.
        groups = {}
        for row in rows:
            top = (row["path"] or "").split("\\")[0] or "(none)"
            groups[top] = groups.get(top, 0) + 1

        print(f"wrote {out_path}  ({len(rows)} symbols)")
        print(f"{'top-level group':<28}{'count':>7}")
        print("-" * 36)
        for name, count in sorted(groups.items(), key=lambda kv: -kv[1]):
            print(f"{name:<28}{count:>7}")

    finally:
        mt5.shutdown()


if __name__ == "__main__":
    main()
