"""Export historical OHLC from the MT5 terminal to CSV for backtesting.

Yahoo caps 15-minute history at ~60 days, which is far too little to judge a
setup — the 15m CRT tests came out with 11-18 trades, a sample that cannot
support any conclusion. MT5 holds years of intraday data for the same symbols
the bridge actually trades, so backtests can use the broker's own bars rather
than a free API's truncated ones.

Run on the machine whose MT5 terminal is logged in. Writes CSV to tasks/history/.
"""

import os
import sys
from datetime import datetime, timedelta

try:
    import MetaTrader5 as mt5
except ImportError:
    print("MetaTrader5 package not installed. Run: pip install MetaTrader5")
    sys.exit(1)

TERMINAL_PATH = os.environ.get("MT5_TERMINAL_PATH", "")
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "history")

# Broker symbols as the bridge auto-detected them.
SYMBOLS = ["BTCUSD", "XAUUSD", "SP500"]

TIMEFRAMES = {
    "M15": mt5.TIMEFRAME_M15,
    "H1":  mt5.TIMEFRAME_H1,
    "H4":  mt5.TIMEFRAME_H4,
    "D1":  mt5.TIMEFRAME_D1,
}

YEARS_BACK = int(os.environ.get("EXPORT_YEARS", "5"))


def export(symbol, tf_name, tf_const, start, end):
    if not mt5.symbol_select(symbol, True):
        return f"{symbol} {tf_name}: symbol not available"

    rates = mt5.copy_rates_range(symbol, tf_const, start, end)

    # A multi-year range request fails on lower timeframes ("Invalid params") because
    # the terminal will not serve that many bars in one call. Falling back to a
    # position-based pull gets the most recent N bars instead, which is what the
    # lower timeframes actually need.
    if rates is None or len(rates) == 0:
        rates = mt5.copy_rates_from_pos(symbol, tf_const, 0, MAX_BARS)
        if rates is None or len(rates) == 0:
            return f"{symbol} {tf_name}: no data ({mt5.last_error()})"

    path = os.path.join(OUT_DIR, f"{symbol}_{tf_name}.csv")
    with open(path, "w", encoding="ascii", newline="") as fh:
        fh.write("time,open,high,low,close,tick_volume\n")
        for r in rates:
            fh.write("%d,%.5f,%.5f,%.5f,%.5f,%d\n" % (
                r["time"], r["open"], r["high"], r["low"], r["close"], r["tick_volume"]))

    first = datetime.utcfromtimestamp(int(rates[0]["time"])).date()
    last = datetime.utcfromtimestamp(int(rates[-1]["time"])).date()
    return f"{symbol} {tf_name}: {len(rates):>7} bars  {first} -> {last}  -> {os.path.basename(path)}"


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    ok = mt5.initialize(path=TERMINAL_PATH) if TERMINAL_PATH else mt5.initialize()
    if not ok:
        print(f"MT5 initialize failed: {mt5.last_error()}")
        sys.exit(1)

    acc = mt5.account_info()
    print(f"connected: #{acc.login if acc else '?'}  terminal: {TERMINAL_PATH or 'auto'}")

    end = datetime.now()
    start = end - timedelta(days=365 * YEARS_BACK)
    print(f"requesting {YEARS_BACK}y: {start.date()} -> {end.date()}\n")

    for symbol in SYMBOLS:
        for tf_name, tf_const in TIMEFRAMES.items():
            try:
                print("  " + export(symbol, tf_name, tf_const, start, end))
            except Exception as exc:
                print(f"  {symbol} {tf_name}: ERROR {exc}")

    mt5.shutdown()
    print(f"\nwritten to {OUT_DIR}")


if __name__ == "__main__":
    main()
