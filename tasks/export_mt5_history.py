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

# Broker symbols as the bridge auto-detected them. Overridable so a CANDIDATE
# instrument can be exported on the broker's own bars WITHOUT touching the bridge or
# the server -- measuring a candidate must never require editing the live trading path.
#
#   python tasks/export_mt5_history.py NAS100 BAC
#
# Why this matters: measured 2026-08-30, the same index reads +0.020R/trade on Yahoo
# bars and -0.525 on broker bars over an identical window with the holding horizon
# already matched -- a feed bias of +0.545R/trade, larger than any edge being argued
# about. A candidate judged on Yahoo bars is not judged.
SYMBOLS = sys.argv[1:] or ["BTCUSD", "XAUUSD", "SP500"]

TIMEFRAMES = {
    "M15": mt5.TIMEFRAME_M15,
    "H1":  mt5.TIMEFRAME_H1,
    "H4":  mt5.TIMEFRAME_H4,
    "D1":  mt5.TIMEFRAME_D1,
}

# 9, not 5. The default was SHORTER THAN THE HISTORY ALREADY ON DISK, which made the
# hourly refresh unable to succeed even once.
#
# Measured 2026-09-17: the MT5-exported CSVs span 8.04 years (XAUUSD/BTCUSD/SP500
# D1+H4+H1 all start 2018-09-03). A 5-year request therefore returns ~62% of what is
# stored, and refresh_bars.cjs correctly calls that "a worse export, not new history"
# and rolls back:
#     XAUUSD_H4  757095 -> 471532      BTCUSD_H1 3868071 -> 2690647
#     SP500_H1  2837871 -> 1764924     (5/8 = 62.5%, matching the observed ratio)
# That ran hourly on BOTH boxes and rolled back every time. The guard was right every
# time; the window was wrong. Bars had not refreshed at all, so the daily strategy
# search kept re-testing identical history.
#
# 9 was chosen against MEASURED availability, not optimism: copy_rates_range returned
# bars at >= 10 years back for all three symbols on this terminal, so 9 clears the
# 8.04-year span with real margin while staying inside what the broker actually holds.
# CHUNK_DAYS below already walks the period in 365-day pieces, so a longer span does
# not approach the ~100k-bar per-call ceiling.
#
# If a symbol ever does hold less than the stored file, nothing is lost: refresh_bars.cjs
# backs up first, verifies, and restores on any shrink.
YEARS_BACK = int(os.environ.get("EXPORT_YEARS", "9"))

# Days per request. 730 days of M15 (~69k bars) was measured to succeed on this
# terminal while a single 5-year call failed, so stay well inside that.
CHUNK_DAYS = int(os.environ.get("EXPORT_CHUNK_DAYS", "365"))


def export(symbol, tf_name, tf_const, start, end):
    if not mt5.symbol_select(symbol, True):
        return f"{symbol} {tf_name}: symbol not available"

    # The terminal refuses any single call over roughly 100k bars ("Invalid params"),
    # which is why a 5-year M15 request returned nothing while H1 and H4 were fine.
    # Probed on this terminal: 50k works, 100k fails, and a 730-day range (~69k bars)
    # succeeds. So walk the period in chunks and stitch, rather than capping history
    # at whatever one call happens to allow.
    rates = []
    seen = set()
    chunk_start = start
    while chunk_start < end:
        chunk_end = min(chunk_start + timedelta(days=CHUNK_DAYS), end)
        part = mt5.copy_rates_range(symbol, tf_const, chunk_start, chunk_end)
        if part is not None:
            for r in part:
                t = int(r["time"])
                if t not in seen:          # chunk boundaries overlap by one bar
                    seen.add(t)
                    rates.append(r)
        chunk_start = chunk_end

    if not rates:
        return f"{symbol} {tf_name}: no data ({mt5.last_error()})"
    rates.sort(key=lambda r: r["time"])

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

    # copy_rates needs the symbol selected. Market Watch is state the live bridge
    # shares, so anything selected here is recorded and put back afterwards; the
    # bridge's own symbols are never deselected even if they appear in the list.
    bridge_owned = {"BTCUSD", "XAUUSD", "SP500"}
    selected_by_us = []
    book = {sym.name: sym for sym in (mt5.symbols_get() or [])}
    for symbol in SYMBOLS:
        if symbol in book and not book[symbol].visible:
            if mt5.symbol_select(symbol, True):
                selected_by_us.append(symbol)

    for symbol in SYMBOLS:
        for tf_name, tf_const in TIMEFRAMES.items():
            try:
                print("  " + export(symbol, tf_name, tf_const, start, end))
            except Exception as exc:
                print(f"  {symbol} {tf_name}: ERROR {exc}")

    for symbol in selected_by_us:
        if symbol in bridge_owned:
            continue
        mt5.symbol_select(symbol, False)

    mt5.shutdown()
    print(f"\nwritten to {OUT_DIR}")


if __name__ == "__main__":
    main()
