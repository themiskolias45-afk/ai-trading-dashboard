"""EVERY trade this account has taken, from the BROKER, compared to the journal.

WHY: the journal is a derived record and this system has lost closes to it before
(mt5_close_detection_loses_trades; the doctor reports "journal 8, learning 7"). Any
answer about performance drawn from the journal alone is an answer about the journal.
The broker's deal history is the only authoritative source.

SAFETY - this is READ-ONLY and touches nothing:
  * mt5.initialize() with NO login/server/password: it ATTACHES to the terminal the
    bridge already has open, it does not re-login and cannot switch the account.
  * only history_deals_get() and account_info() are called. No order_send, no
    position_modify, no position_close. Nothing is placed, moved or closed.
  * mt5.shutdown() at the end closes only THIS process's handle. The bridge's own
    connection and every broker-side SL/TP are untouched.

  python tasks/audit_all_trades.py [--days 120]
"""
import json, sys, os
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).parent.parent
for _s in (sys.stdout, sys.stderr):
    try: _s.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError, OSError): pass

try:
    import MetaTrader5 as mt5
except ImportError:
    print("MetaTrader5 module not installed in this interpreter."); raise SystemExit(2)

days = 120
if "--days" in sys.argv:
    i = sys.argv.index("--days")
    if i + 1 < len(sys.argv): days = int(sys.argv[i + 1])

# WHICH TERMINAL. This box runs more than one, on DIFFERENT accounts (25446287 here,
# 11581419 is the VPS's). A bare initialize() attaches to whichever answers first, and
# comparing one account's deals against the other's journal shows ZERO overlap, which
# reads exactly like catastrophic data loss. Pass --terminal to be explicit.
_term = None
if "--terminal" in sys.argv:
    _i = sys.argv.index("--terminal")
    if _i + 1 < len(sys.argv): _term = sys.argv[_i + 1]
if not (mt5.initialize(path=_term) if _term else mt5.initialize()):
    print(f"MT5 attach failed: {mt5.last_error()}  (is the terminal open?)"); raise SystemExit(3)

acc = mt5.account_info()
print(f"account {acc.login}  {acc.server}  balance {acc.balance} {acc.currency}")

to_  = datetime.now(timezone.utc) + timedelta(days=1)
from_ = datetime.now(timezone.utc) - timedelta(days=days)
deals = mt5.history_deals_get(from_, to_)
if deals is None:
    print(f"history_deals_get returned None: {mt5.last_error()}"); mt5.shutdown(); raise SystemExit(4)

# Group by position: entry deal(s) + exit deal(s) make one round trip.
by_pos = {}
for d in deals:
    if d.position_id == 0:            # balance ops, credits - not trades
        continue
    by_pos.setdefault(d.position_id, []).append(d)

trades = []
for pos, ds in by_pos.items():
    ds.sort(key=lambda x: x.time)
    ins  = [d for d in ds if d.entry == mt5.DEAL_ENTRY_IN]
    outs = [d for d in ds if d.entry in (mt5.DEAL_ENTRY_OUT, mt5.DEAL_ENTRY_OUT_BY)]
    if not ins:
        continue
    first = ins[0]
    pnl = sum(d.profit + d.commission + d.swap for d in ds)
    trades.append({
        "position": pos,
        "magic":    first.magic,
        "symbol":   first.symbol,
        "dir":      "BUY" if first.type == mt5.DEAL_TYPE_BUY else "SELL",
        "volume":   sum(d.volume for d in ins),
        "openTime": datetime.fromtimestamp(first.time, timezone.utc).isoformat()[:19],
        "closeTime": datetime.fromtimestamp(outs[-1].time, timezone.utc).isoformat()[:19] if outs else None,
        "openPrice": first.price,
        "closePrice": outs[-1].price if outs else None,
        "pnl":      round(pnl, 2),
        "closed":   bool(outs),
        "partials": len(outs),
        "comment":  (first.comment or "").strip(),
    })
mt5.shutdown()

trades.sort(key=lambda t: t["openTime"])

# THE ACCOUNT IS SHARED. Third-party EAs trade it too - TKM3, LyraAI, V10 and others
# were all found here. MAGIC_NUMBER 20250101 is what identifies a SmartEntry order
# (mt5_bridge.py:102), and the bridge itself filters on magic everywhere. Any
# performance number taken from this account WITHOUT this filter is measuring
# somebody else's system.
SMARTENTRY_MAGIC = 20250101
from collections import Counter
owners = Counter(t["magic"] for t in trades)
print("\n  WHO OWNS THE TRADES ON THIS ACCOUNT (by magic):")
for m, n in owners.most_common():
    tag = "  <-- SmartEntry" if m == SMARTENTRY_MAGIC else ""
    sample = next(t["comment"][:26] for t in trades if t["magic"] == m)
    print(f"    magic {m:<12} {n:>5} position(s)   e.g. {sample!r}{tag}")

if "--all" not in sys.argv:
    trades = [t for t in trades if t["magic"] == SMARTENTRY_MAGIC]
    print(f"\n  FILTERED TO SMARTENTRY ONLY (magic {SMARTENTRY_MAGIC}) - pass --all to see every EA")

closed = [t for t in trades if t["closed"]]
open_  = [t for t in trades if not t["closed"]]

print(f"\nBROKER TRUTH — last {days} days: {len(trades)} position(s), {len(closed)} closed, {len(open_)} open\n")
print(f"  {'openTime':20} {'sym':8} {'dir':5} {'vol':>5} {'pnl':>10}  {'closeTime':20} parts comment")
for t in trades:
    print(f"  {t['openTime']:20} {t['symbol']:8} {t['dir']:5} {t['volume']:>5} {t['pnl']:>10}  "
          f"{str(t['closeTime'] or 'OPEN'):20} {t['partials']:>4}  {t['comment'][:22]}")

wins = [t for t in closed if t["pnl"] > 0]; losses = [t for t in closed if t["pnl"] <= 0]
gross = sum(t["pnl"] for t in closed)
print(f"\n  CLOSED: {len(closed)}   wins {len(wins)}   losses {len(losses)}   "
      f"win% {100*len(wins)/len(closed):.1f}" if closed else "\n  CLOSED: 0")
if closed:
    print(f"  NET REALISED: {gross:+.2f} {acc.currency}")
    bd = [t for t in closed if t['dir']=='BUY']; sd = [t for t in closed if t['dir']=='SELL']
    print(f"  BUY  n={len(bd):3} net {sum(t['pnl'] for t in bd):+10.2f}")
    print(f"  SELL n={len(sd):3} net {sum(t['pnl'] for t in sd):+10.2f}")

# ---- compare with the journal ----
jp = ROOT / "server" / "journal.json"
try:
    raw = json.loads(jp.read_text(encoding="utf-8"))
    jrows = raw if isinstance(raw, list) else raw.get("journal", [])
    jtickets = {str(r.get("ticket")) for r in jrows if r.get("ticket")}
    btickets = {str(t["position"]) for t in trades}
    missing = btickets - jtickets
    extra   = jtickets - btickets
    print(f"\n  JOURNAL RECONCILIATION: broker {len(btickets)} positions, journal {len(jtickets)} tickets")
    print(f"    IN BROKER, NOT IN JOURNAL: {len(missing)}")
    for m in sorted(missing):
        t = next(x for x in trades if str(x['position']) == m)
        print(f"      {m}  {t['symbol']:8} {t['dir']:5} pnl {t['pnl']:>9}  opened {t['openTime']}  {'CLOSED' if t['closed'] else 'OPEN'}")
    print(f"    IN JOURNAL, NOT IN BROKER: {len(extra)}  {sorted(extra) if extra else ''}")
except Exception as exc:
    print(f"\n  journal comparison failed: {exc}")
