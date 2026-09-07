"""Adds a per-symbol spread cap to mt5_bridge.py on the VPS.

A single points cap cannot work across instruments. On VantageMarkets-Demo a
perfectly normal BTCUSD spread of ~$17 reads as ~1700 ticks, while XAUUSD is 22
and SP500 is 36. The one number tuned for metals made BTC permanently untradeable:
every attempt died at the spread gate before an order was ever sent.

Backward compatible by construction - with no MAX_SPREAD_<SYMBOL> set, every
symbol resolves to the same global MAX_SPREAD_PTS it uses today.
"""
import io
import re
import sys

PATH = r"C:\ai-trading-dashboard\mt5_bridge.py"

OLD_CONFIG = 'MAX_SPREAD_PTS = int(os.environ.get("MAX_SPREAD",    "50"))      # reject trade if spread > this'

NEW_CONFIG = '''MAX_SPREAD_PTS = int(os.environ.get("MAX_SPREAD",    "50"))      # reject trade if spread > this


def max_spread_for(symbol):
    """Spread cap for one symbol, falling back to the global MAX_SPREAD.

    A single points cap cannot work across instruments with different tick sizes
    and price scales. On the VPS's Vantage feed a normal BTCUSD spread of ~$17
    reads as ~1700 ticks while XAUUSD is 22 and SP500 is 36, so a cap tuned for
    metals silently made BTC untradeable - every attempt was skipped at the gate
    before an order was ever sent, which looks identical to "no signal fired".

    Override per symbol with MAX_SPREAD_BTCUSD, MAX_SPREAD_XAUUSD, etc. Unset
    means the global value, so behaviour is unchanged wherever no override exists.
    """
    raw = os.environ.get("MAX_SPREAD_" + symbol.upper())
    if raw is None or raw.strip() == "":
        return MAX_SPREAD_PTS
    try:
        value = int(raw)
    except ValueError:
        log(f"MAX_SPREAD_{symbol.upper()}={raw!r} is not an integer - "
            f"falling back to global {MAX_SPREAD_PTS}", YELLOW)
        return MAX_SPREAD_PTS
    if value <= 0:
        log(f"MAX_SPREAD_{symbol.upper()}={value} is not positive - "
            f"falling back to global {MAX_SPREAD_PTS}", YELLOW)
        return MAX_SPREAD_PTS
    return value'''

OLD_CHECK = '''def check_spread(symbol):
    tick = mt5.symbol_info_tick(symbol)
    if not tick:
        return False, 0
    info  = mt5.symbol_info(symbol)
    spread = (tick.ask - tick.bid) / info.trade_tick_size if info else 0
    ok = spread <= MAX_SPREAD_PTS
    return ok, spread'''

NEW_CHECK = '''def check_spread(symbol):
    tick = mt5.symbol_info_tick(symbol)
    if not tick:
        return False, 0, MAX_SPREAD_PTS
    info  = mt5.symbol_info(symbol)
    spread = (tick.ask - tick.bid) / info.trade_tick_size if info else 0
    cap = max_spread_for(symbol)
    ok = spread <= cap
    return ok, spread, cap'''

OLD_CALL = '''    spread_ok, spread = check_spread(symbol)
    if not spread_ok:
        log(f"Spread too wide on {symbol}: {spread:.0f} pts (max {MAX_SPREAD_PTS}) — skipping", YELLOW)
        return False'''

NEW_CALL = '''    spread_ok, spread, spread_cap = check_spread(symbol)
    if not spread_ok:
        log(f"Spread too wide on {symbol}: {spread:.0f} pts (max {spread_cap}) — skipping", YELLOW)
        return False'''

with io.open(PATH, "r", encoding="utf-8") as fh:
    src = fh.read()

# Every call site must move together: check_spread's arity changes, so a missed
# caller is a TypeError at the exact moment a trade is being placed.
callers = len(re.findall(r"check_spread\(", src))
print("check_spread call sites found:", callers)

failed = False
for name, old in (("config", OLD_CONFIG), ("check_spread", OLD_CHECK), ("caller", OLD_CALL)):
    n = src.count(old)
    print(f"  {name}: {n} match(es)")
    if n != 1:
        failed = True

if failed:
    print("ABORT - expected exactly one match for each block; file differs from expectation")
    sys.exit(1)

src = src.replace(OLD_CONFIG, NEW_CONFIG)
src = src.replace(OLD_CHECK, NEW_CHECK)
src = src.replace(OLD_CALL, NEW_CALL)

with io.open(PATH, "w", encoding="utf-8", newline="") as fh:
    fh.write(src)

print("patched OK")
