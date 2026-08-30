"""Lists the broker's tradeable symbols matching a pattern. READ-ONLY.

    python tasks/list_broker_symbols.py NAS US TEC NDX

Why this is safe to run while a bridge is live on the same terminal:

  - It calls mt5.symbols_get() and mt5.symbol_info() ONLY. Both are reads.
  - It never calls symbol_select(). That would add the symbol to Market Watch,
    which is terminal STATE shared with the running bridge, and this script has no
    business changing what the trading process sees.
  - It never calls order_send, positions_get or account_info.

A symbol that is not in Market Watch usually returns None from symbol_info(). That
is reported as "not in Market Watch" rather than "unavailable" -- the difference
matters, because the bridge's own auto_detect_symbols() selects what it needs at
startup and would pick this symbol up the same way if it were added to
SYMBOL_CANDIDATES.
"""

import sys

try:
    import MetaTrader5 as mt5
except ImportError:
    print("MetaTrader5 package not installed for this interpreter.")
    sys.exit(1)


def main():
    patterns = [a.upper() for a in sys.argv[1:]] or ["NAS", "US100", "USTEC", "NDX", "TECH"]

    if not mt5.initialize():
        print(f"mt5.initialize() failed: {mt5.last_error()}")
        sys.exit(1)

    try:
        every_symbol = mt5.symbols_get() or []
        print(f"broker book: {len(every_symbol)} symbols")
        print(f"matching on: {', '.join(patterns)}\n")

        matches = [s for s in every_symbol if any(p in s.name.upper() for p in patterns)]

        if not matches:
            print("NO MATCHES. The broker does not list anything under these patterns.")
            return

        print(f"{'symbol':<18}{'min lot':>9}{'step':>8}{'digits':>8}  {'spread':>7}  description")
        print("-" * 100)
        for symbol in sorted(matches, key=lambda s: s.name):
            info = mt5.symbol_info(symbol.name)
            if info is None:
                print(f"{symbol.name:<18}{'—':>9}{'—':>8}{'—':>8}  {'—':>7}  (not in Market Watch; "
                      f"path {symbol.path})")
                continue
            print(f"{info.name:<18}{info.volume_min:>9}{info.volume_step:>8}{info.digits:>8}"
                  f"  {info.spread:>7}  {info.description}")
    finally:
        mt5.shutdown()


if __name__ == "__main__":
    main()
