# Writes EVERY open position on the attached terminal to tasks/mt5_positions_snapshot.json.
# READ-ONLY against MT5: it opens a connection, reads positions, and shuts down. It places
# no order, moves no stop and closes nothing.
#
# WHY THIS EXISTS. mt5_bridge.py filters every position path to magic 20250101, so the
# four third-party positions on account 11581419 reach no surface at all. Teaching the
# bridge to send them needs a bridge restart, and that has been unavailable. This does not
# touch the bridge: it is a separate short-lived reader and the server just reads the file.
#
# The snapshot carries its own `at` and the login it actually read, because a bare
# initialize() attaches to whichever terminal answers first - on a box with two terminals
# that is not necessarily the one you meant, and a snapshot that does not say which
# account it describes is worse than none.
import json, os, sys
from datetime import datetime, timezone

import MetaTrader5 as mt5

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mt5_positions_snapshot.json")
KNOWN = {20250101: "SmartEntry", 20260902: "FVG_CONTINUATION",
         20260903: "TK_SWING_PULLBACK", 20260904: "CRT_FVG"}


def write(payload):
    tmp = OUT + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=1)
    os.replace(tmp, OUT)          # atomic: a reader never sees a half-written file


def main():
    if not mt5.initialize():
        write({"at": datetime.now(timezone.utc).isoformat(), "ok": False,
               "error": "initialize failed: %s" % (mt5.last_error(),), "positions": []})
        return 1
    try:
        info = mt5.account_info()
        positions = mt5.positions_get()
        if positions is None:
            write({"at": datetime.now(timezone.utc).isoformat(), "ok": False,
                   "error": "positions_get returned None: %s" % (mt5.last_error(),), "positions": []})
            return 1
        rows = []
        for p in positions:
            rows.append({
                "ticket": p.ticket, "symbol": p.symbol,
                "type": "BUY" if p.type == 0 else "SELL",
                "volume": p.volume, "price": p.price_open,
                "sl": p.sl, "tp": p.tp, "profit": round(p.profit, 2),
                "magic": p.magic, "comment": p.comment,
                "owner": "smartentry" if p.magic == 20250101
                         else ("executor" if p.magic in KNOWN else "foreign"),
                "model": KNOWN.get(p.magic),
                "openTime": datetime.fromtimestamp(p.time).strftime("%H:%M:%S"),
            })
        write({"at": datetime.now(timezone.utc).isoformat(), "ok": True,
               "login": info.login if info else None,
               "server": info.server if info else None,
               "equity": round(info.equity, 2) if info else None,
               "balance": round(info.balance, 2) if info else None,
               "count": len(rows), "positions": rows})
        print("wrote %d position(s) for login %s" % (len(rows), info.login if info else "?"))
        return 0
    finally:
        mt5.shutdown()


if __name__ == "__main__":
    sys.exit(main())
