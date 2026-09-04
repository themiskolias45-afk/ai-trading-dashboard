# Records EVERY closed trade on the attached terminal to tasks/all_trades_ledger.jsonl.
#
# WHY THIS EXISTS. On 2026-09-04 the FVG executor placed a real XAUUSD trade (0.88 lots,
# ticket 1935787113, magic 20260902) that closed in profit. The profit was recorded
# NOWHERE in SmartEntry:
#   - mt5_bridge.py is the only writer of /api/journal, and it filters every position path
#     to magic 20250101, so an executor trade never reaches the journal.
#   - tasks/fvg_executor.py is deliberately isolated: "It never reads or writes the
#     engine's signal path, its settings, or its journal."
#   - tasks/fvg_executed.jsonl records PLACEMENT only - no exit, no P/L (server/index.js
#     :5872 says exactly this).
#   - No outcomes ledger existed for ANY executor (tk_, fvg_, crt_ - checked, none).
# So the only copy of that result was MT5's own deal history. A system cannot learn from
# trades it does not know ended.
#
# WHAT IT DOES. Sweeps MT5 deal history for EVERY magic - the bridge's, the executors',
# the chart EAs', third-party ones - groups deals into closed positions, and appends the
# ones it has not seen before.
#
# GUARANTEES, in the order they were asked for:
#   NEVER LOSES DATA   Append-only. It reads the existing ledger, keys on position id, and
#                      appends only unseen rows. It never rewrites, truncates or reorders a
#                      line it did not just write. Existing rows are never revisited.
#   NEVER DELETES      It opens exactly one file for writing - its own, in append mode -
#                      and creates it if missing. No unlink, no truncate, no os.replace
#                      over anything that already held data.
#   NEVER BLOCKS       Read-only against MT5: history only, no order, no stop, no close.
#                      It touches no gate, no threshold, no setting, no signal path and no
#                      other ledger. Nothing waits on it; if it fails, trading is unchanged.
#   RECORDS EVERY TRADE  No magic filter. The blindness being fixed here was caused by a
#                      magic filter, so this deliberately has none.
#
# Re-runnable as often as you like: a second run on unchanged history appends nothing.
#
# A bare initialize() attaches to whichever terminal answers first, so every row carries
# the login it was actually read from - a ledger that does not say which account it
# describes is worse than none.
import json, os, sys
from datetime import datetime, timezone

import MetaTrader5 as mt5

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "all_trades_ledger.jsonl")

# Magic -> what placed it. Unknown magics are still recorded, just labelled by number:
# "we do not know what this was" is a fact worth keeping, not a reason to drop the row.
KNOWN = {
    20250101: "SmartEntry_bridge",
    20260902: "FVG_CONTINUATION",
    20260903: "TK_SWING_PULLBACK",
    20260904: "CRT_FVG",
    26070401: "EA_CRT_AMD_Dashboard_v351",
    26070455: "EA_CRT_AMD_Dashboard_v355",
}

DEAL_ENTRY_IN, DEAL_ENTRY_OUT, DEAL_ENTRY_INOUT, DEAL_ENTRY_OUT_BY = 0, 1, 2, 3
EPOCH_START = datetime(2015, 1, 1, tzinfo=timezone.utc)


def seen_position_ids():
    """Position ids already in the ledger. A malformed line must not hide the good ones,
    and must never cause a re-append that would duplicate a trade."""
    seen = set()
    if not os.path.exists(OUT):
        return seen
    with open(OUT, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except ValueError:
                continue
            pid = row.get("positionId")
            if pid is not None:
                seen.add(pid)
    return seen


def build_closed_trades(deals):
    """Group raw deals into closed positions. A position counts as closed only when its
    exited volume matches its entered volume - a partially closed trade is still live and
    is deliberately NOT written, so it can be recorded once, correctly, when it finishes."""
    by_pos = {}
    for d in deals:
        by_pos.setdefault(d.position_id, []).append(d)

    out = []
    for pid, rows in by_pos.items():
        rows.sort(key=lambda r: (r.time, r.ticket))
        ins = [r for r in rows if r.entry in (DEAL_ENTRY_IN, DEAL_ENTRY_INOUT)]
        outs = [r for r in rows if r.entry in (DEAL_ENTRY_OUT, DEAL_ENTRY_OUT_BY)]
        if not ins or not outs:
            continue
        vol_in = sum(r.volume for r in ins)
        vol_out = sum(r.volume for r in outs)
        if round(vol_out, 8) < round(vol_in, 8):
            continue  # still open (or partially closed) - record it when it truly ends

        first, last = ins[0], outs[-1]
        profit = sum(r.profit for r in rows)
        swap = sum(r.swap for r in rows)
        comm = sum(r.commission for r in rows)
        magic = first.magic or next((r.magic for r in rows if r.magic), 0)
        entry_px = (sum(r.price * r.volume for r in ins) / vol_in) if vol_in else first.price
        exit_px = (sum(r.price * r.volume for r in outs) / vol_out) if vol_out else last.price

        out.append({
            "positionId": pid,
            "entryDealTicket": first.ticket,
            "exitDealTicket": last.ticket,
            "symbol": first.symbol,
            # An IN deal of type BUY(0) opened a long; SELL(1) opened a short.
            "direction": "BUY" if first.type == 0 else "SELL",
            "volume": round(vol_in, 4),
            "openTime": datetime.fromtimestamp(first.time, timezone.utc).isoformat(),
            "openPrice": first.price if len(ins) == 1 else round(entry_px, 8),
            "closeTime": datetime.fromtimestamp(last.time, timezone.utc).isoformat(),
            "closePrice": last.price if len(outs) == 1 else round(exit_px, 8),
            "partialCloses": max(0, len(outs) - 1),
            "grossProfit": round(profit, 2),
            "swap": round(swap, 2),
            "commission": round(comm, 2),
            "netProfit": round(profit + swap + comm, 2),
            "magic": magic,
            "model": KNOWN.get(magic, "unknown_magic_%s" % magic),
            "owner": ("smartentry" if magic == 20250101
                      else "executor" if magic in KNOWN
                      else "foreign"),
            "comment": (first.comment or "").strip(),
        })
    return out


def main():
    if not mt5.initialize():
        sys.stderr.write("initialize failed: %s\n" % (mt5.last_error(),))
        return 1
    try:
        info = mt5.account_info()
        login = info.login if info else None
        server = info.server if info else None
        now = datetime.now(timezone.utc)
        deals = mt5.history_deals_get(EPOCH_START, now)
        if deals is None:
            sys.stderr.write("history_deals_get returned None: %s\n" % (mt5.last_error(),))
            return 1

        trades = build_closed_trades(deals)
        seen = seen_position_ids()
        fresh = [t for t in trades if t["positionId"] not in seen]
        fresh.sort(key=lambda t: t["closeTime"])

        recorded_at = now.isoformat()
        if fresh:
            # Append mode, one line per trade. Nothing already on disk is read back into
            # this handle, so nothing already on disk can be lost by writing.
            with open(OUT, "a", encoding="utf-8") as fh:
                for t in fresh:
                    t["account"] = login
                    t["server"] = server
                    t["source"] = "mt5_history"
                    t["recordedAt"] = recorded_at
                    fh.write(json.dumps(t) + "\n")

        by_model = {}
        for t in fresh:
            by_model[t["model"]] = by_model.get(t["model"], 0) + 1
        print("account %s (%s): %d closed trades in history, %d already recorded, %d appended"
              % (login, server, len(trades), len(trades) - len(fresh), len(fresh)))
        for m, n in sorted(by_model.items(), key=lambda kv: -kv[1]):
            print("   +%-4d %s" % (n, m))
        print("ledger: %s" % OUT)
        return 0
    finally:
        mt5.shutdown()


if __name__ == "__main__":
    sys.exit(main())
