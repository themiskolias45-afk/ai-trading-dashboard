# READ-ONLY. Lists EVERY open position on the attached terminal regardless of magic.
# mt5_bridge.py filters to magic 20250101 in every position path, so anything opened by
# another EA -- or by our own TK/FVG/CRT executors, which carry their own magics -- is
# invisible to the journal, the API and every dashboard. This is the only thing on either
# box that sees the whole book.
import MetaTrader5 as mt5, sys
if not mt5.initialize():
    print("initialize FAILED", mt5.last_error()); sys.exit(1)
info = mt5.account_info()
print("ATTACHED LOGIN: %s  server=%s  balance=%s equity=%s" % (info.login, info.server, info.balance, info.equity))
pos = mt5.positions_get()
if pos is None:
    print("positions_get returned None", mt5.last_error()); mt5.shutdown(); sys.exit(1)
print("TOTAL OPEN POSITIONS: %d" % len(pos))
KNOWN = {20250101: "SmartEntry", 20260902: "FVG_CONTINUATION", 20260903: "TK_SWING_PULLBACK", 20260904: "CRT_FVG"}
for p in pos:
    who = KNOWN.get(p.magic, "FOREIGN")
    print("  %-10s %-4s vol=%-6s open=%-12s sl=%-12s tp=%-12s profit=%-9s ticket=%s  magic=%s %s  comment=%r"
          % (p.symbol, "BUY" if p.type == 0 else "SELL", p.volume, p.price_open, p.sl, p.tp,
             p.profit, p.ticket, p.magic, who, p.comment))
mt5.shutdown()
