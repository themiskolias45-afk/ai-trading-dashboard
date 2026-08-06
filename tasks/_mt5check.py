import MetaTrader5 as mt5, sys

if not mt5.initialize():
    print("INIT FAILED", mt5.last_error())
    sys.exit(1)

ti = mt5.terminal_info()
ai = mt5.account_info()
print("trade_allowed        :", ti.trade_allowed)
print("connected            :", ti.connected)
print("terminal_path        :", ti.path)
print("data_path            :", ti.data_path)
if ai:
    print("account              :", ai.login, ai.server, "balance", ai.balance, "equity", ai.equity)
    print("account trade_allowed:", ai.trade_allowed)
else:
    print("account              : NONE -", mt5.last_error())

pos = mt5.positions_get()
print("open_positions       :", 0 if pos is None else len(pos))
if pos:
    for p in pos:
        print("    ", p.ticket, p.symbol, p.volume, p.profit, "magic", p.magic)

for s in ("BTCUSD", "XAUUSD", "SP500"):
    si = mt5.symbol_info(s)
    if si:
        print("%s: spread=%s point=%s bid=%s vol_min=%s trade_mode=%s" %
              (s, si.spread, si.point, si.bid, si.volume_min, si.trade_mode))
    else:
        print(s, ": symbol_info NONE")

mt5.shutdown()
