"""Verifies max_spread_for resolves per-symbol overrides and falls back safely.

Imported without MetaTrader5 running - only the config block and the helper are
exercised, so this is safe to run alongside the live bridge.
"""
import os
import sys

os.environ["MAX_SPREAD_BTCUSD"] = "2500"
os.environ["MAX_SPREAD_BADVAL"] = "not-a-number"
os.environ["MAX_SPREAD_ZERO"] = "0"

sys.path.insert(0, r"C:\ai-trading-dashboard")

import importlib.util
spec = importlib.util.spec_from_file_location("bridge", r"C:\ai-trading-dashboard\mt5_bridge.py")
bridge = importlib.util.module_from_spec(spec)
try:
    spec.loader.exec_module(bridge)
except SystemExit:
    pass

cases = [
    ("BTCUSD", 2500, "explicit override applies"),
    ("XAUUSD", 50,   "no override -> global default"),
    ("SP500",  50,   "no override -> global default"),
    ("btcusd", 2500, "lookup is case-insensitive"),
    ("BADVAL", 50,   "non-integer override falls back, does not crash"),
    ("ZERO",   50,   "non-positive override falls back"),
]

failures = 0
for symbol, expected, why in cases:
    try:
        got = bridge.max_spread_for(symbol)
    except Exception as exc:
        print("FAIL  %-8s raised %r" % (symbol, exc))
        failures += 1
        continue
    ok = (got == expected)
    print("%s  %-8s -> %-5s (expected %-5s)  %s" %
          ("PASS" if ok else "FAIL", symbol, got, expected, why))
    if not ok:
        failures += 1

print()
print("global MAX_SPREAD_PTS =", bridge.MAX_SPREAD_PTS)
print("RESULT:", "ALL PASS" if failures == 0 else ("%d FAILURE(S)" % failures))
sys.exit(1 if failures else 0)
