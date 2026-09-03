# READ-ONLY. Every magic number that has ever placed an order on the attached account,
# from MT5 itself rather than from any table in this repo. The point is to find magics
# nobody wrote down: a live executor whose magic is missing from mt5_bridge.py renders as
# a stranger's EA on every surface, and nothing errors.
import MetaTrader5 as mt5, sys
from datetime import datetime, timedelta
from collections import defaultdict

if not mt5.initialize():
    print("initialize FAILED", mt5.last_error()); sys.exit(1)
info = mt5.account_info()
print("ACCOUNT %s  %s  balance=%s equity=%s" % (info.login, info.server, info.balance, info.equity))

KNOWN = {20250101: "SmartEntry (main engine, mt5_bridge.py MAGIC_NUMBER)",
         20260902: "FVG_CONTINUATION (tasks/fvg_executor.py --model fvg)",
         20260903: "TK_SWING_PULLBACK (tasks/fvg_executor.py --model tk)",
         20260904: "CRT_FVG (tasks/fvg_executor.py --model crt)"}

open_by = defaultdict(lambda: {"n": 0, "lots": 0.0, "pnl": 0.0, "comments": set()})
for p in mt5.positions_get() or []:
    b = open_by[p.magic]; b["n"] += 1; b["lots"] += p.volume; b["pnl"] += p.profit
    b["comments"].add(p.comment)

hist_by = defaultdict(lambda: {"n": 0, "pnl": 0.0, "first": None, "last": None, "comments": set()})
deals = mt5.history_deals_get(datetime.now() - timedelta(days=120), datetime.now() + timedelta(days=1))
for d in deals or []:
    if d.entry != 1:            # DEAL_ENTRY_OUT only, so each trade counts once
        continue
    b = hist_by[d.magic]; b["n"] += 1; b["pnl"] += d.profit
    t = datetime.fromtimestamp(d.time)
    if b["first"] is None or t < b["first"]: b["first"] = t
    if b["last"] is None or t > b["last"]:   b["last"] = t
    if d.comment: b["comments"].add(d.comment)

magics = sorted(set(open_by) | set(hist_by))
print("\nDISTINCT MAGIC NUMBERS SEEN: %d\n" % len(magics))
for m in magics:
    o, h = open_by.get(m), hist_by.get(m)
    who = KNOWN.get(m)
    tag = "OURS  " if who else "FOREIGN"
    print("magic %-10s %s  %s" % (m, tag, who or "not in any table in this repo"))
    if o: print("   open   : %d position(s), %.2f lots, P/L %+.2f  comments=%s" % (o["n"], o["lots"], o["pnl"], sorted(o["comments"])))
    if h: print("   closed : %d deal(s) in 120d, P/L %+.2f, %s -> %s" % (h["n"], h["pnl"], h["first"], h["last"]))
    print()
unknown = [m for m in magics if m not in KNOWN]
print("UNRECOGNISED MAGICS: %s" % (unknown if unknown else "none"))
mt5.shutdown()
