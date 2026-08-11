"""Explain why a position that is no longer open has no closing deal in MT5.

READ-ONLY. Calls only account_info, positions_get, history_deals_get and
history_orders_get. There is no order_send in this file and it must never gain
one — it exists to explain trades that already closed, not to touch any.

The failure it diagnoses: reconcile_open_trades() in mt5_bridge.py finds deals for
a ticket, confirms the position is ours, and then summarize_closed_position()
returns None because no deal carries entry in (DEAL_ENTRY_OUT, DEAL_ENTRY_OUT_BY).
The journal keeps the trade OPEN with a null P&L forever and the learning engine
never sees the outcome.

The suspect is a close-by. On a hedging account an opposing pair can be closed
against each other, and MT5 files the resulting deal against the COUNTERPART's
position id (see ORDER_POSITION_BY_ID). deals_for_position() re-checks
`d.position_id == ticket` — deliberately, because account 25446287 is shared with
five foreign EAs and a dated call returns their deals too — so a close-by deal is
dropped as someone else's.

This script therefore prints three views of the same history, because the whole
question is which of them holds the closing deal:
  1. deals the strict position= query returns, unfiltered
  2. every XAUUSD-and-friends deal in a date window, whatever its position id
  3. the orders, which carry position_by_id and name the counterpart outright

Usage:  python tasks/diagnose_orphan_close.py 1713655080 1726672007
        python tasks/diagnose_orphan_close.py --days 10 1713655080
"""

import argparse
import sys
from datetime import datetime, timedelta, timezone

try:
    import MetaTrader5 as mt5
except ImportError:
    print("MetaTrader5 package not installed. Run: pip install MetaTrader5")
    sys.exit(1)

# Deals that CLOSE something. mt5_bridge.summarize_closed_position accepts only the
# first two; OUT_BY is the close-by case this script exists to catch.
DEAL_ENTRY_NAMES = {
    getattr(mt5, "DEAL_ENTRY_IN", 0):     "IN",
    getattr(mt5, "DEAL_ENTRY_OUT", 1):    "OUT",
    getattr(mt5, "DEAL_ENTRY_INOUT", 2):  "INOUT (reversal)",
    getattr(mt5, "DEAL_ENTRY_OUT_BY", 3): "OUT_BY (close-by)",
}

DEAL_TYPE_NAMES = {
    getattr(mt5, "DEAL_TYPE_BUY", 0):     "BUY",
    getattr(mt5, "DEAL_TYPE_SELL", 1):    "SELL",
    getattr(mt5, "DEAL_TYPE_BALANCE", 2): "BALANCE",
    getattr(mt5, "DEAL_TYPE_CREDIT", 3):  "CREDIT",
}

# Broker symbols as the bridge auto-detects them, used to keep the dated sweep
# readable. Deals on anything else are counted but not printed line by line.
OUR_SYMBOLS = ("XAUUSD", "BTCUSD", "SP500")


# Discovered once at startup by compare_broker_clock(). Seconds to SUBTRACT from a
# broker timestamp to get real UTC.
broker_offset_seconds = 0


def compare_broker_clock():
    """Measure how far the broker's clock runs ahead of UTC, live.

    MT5 deal and order times are BROKER SERVER epoch seconds, not UTC — a third
    clock beside this machine's local time and the API's UTC. Rendering a deal time
    as if it were UTC put this account's closes 3 hours into the future and made two
    trades that had already closed look like they closed after the bridge read them.
    Measured rather than hardcoded: brokers change offset with DST and this account
    (Vantage demo) runs UTC+3 in summer.
    """
    global broker_offset_seconds
    for symbol in OUR_SYMBOLS:
        tick = mt5.symbol_info_tick(symbol)
        if tick and tick.time:
            drift = tick.time - datetime.now(timezone.utc).timestamp()
            # Snap to a quarter hour: every real broker offset is a whole number of
            # them, and the raw difference carries tick latency.
            broker_offset_seconds = round(drift / 900) * 900
            hours = broker_offset_seconds / 3600
            print(f"broker clock: UTC{hours:+g} (measured from {symbol} tick)")
            return
    print("broker clock: could not measure — timestamps shown as broker time only")


def stamp(epoch_seconds):
    """One MT5 timestamp rendered in both the broker's clock and real UTC."""
    try:
        broker = datetime.fromtimestamp(int(epoch_seconds), tz=timezone.utc)
    except (TypeError, ValueError, OSError):
        return f"unreadable timestamp {epoch_seconds!r}"
    if not broker_offset_seconds:
        return f"{broker:%Y-%m-%d %H:%M:%S} broker"
    true_utc = broker - timedelta(seconds=broker_offset_seconds)
    return f"{broker:%Y-%m-%d %H:%M:%S} broker = {true_utc:%Y-%m-%d %H:%M:%S}Z"


def describe_deal(deal, highlight_ticket=None):
    entry_name = DEAL_ENTRY_NAMES.get(deal.entry, f"entry={deal.entry}")
    type_name = DEAL_TYPE_NAMES.get(deal.type, f"type={deal.type}")
    # The one column that decides everything: does this deal's position_id point at
    # the ticket we asked about, or somewhere else?
    if highlight_ticket is not None and deal.position_id != highlight_ticket:
        pos_note = f"position_id={deal.position_id}  <-- NOT {highlight_ticket}"
    else:
        pos_note = f"position_id={deal.position_id}"
    return (
        f"    deal #{deal.ticket}  order #{deal.order}  {pos_note}\n"
        f"      {stamp(deal.time)}  {deal.symbol}  {type_name}  {entry_name}\n"
        f"      volume {deal.volume}  price {deal.price}  profit {deal.profit}  "
        f"commission {deal.commission}  swap {deal.swap}\n"
        f"      magic {deal.magic}  comment {deal.comment!r}"
    )


def deals_by_position(ticket):
    """Raw result of the position= query — NOT re-filtered by position_id.

    mt5_bridge.deals_for_position applies that filter; this deliberately does not,
    so the two can be compared. Returns (deals, error_text).
    """
    try:
        deals = mt5.history_deals_get(position=ticket)
    except Exception as exc:
        return [], f"raised: {exc}"
    if deals is None:
        return [], f"returned None ({mt5.last_error()})"
    return list(deals), None


def orders_by_position(ticket):
    """Orders for a position. Close-by orders carry position_by_id."""
    try:
        orders = mt5.history_orders_get(position=ticket)
    except Exception as exc:
        return [], f"raised: {exc}"
    if orders is None:
        return [], f"returned None ({mt5.last_error()})"
    return list(orders), None


def report_ticket(ticket, live_tickets):
    print(f"\n{'=' * 78}")
    print(f"  POSITION #{ticket}")
    print(f"{'=' * 78}")
    print(f"  currently open: {'YES' if ticket in live_tickets else 'no'}")

    deals, err = deals_by_position(ticket)
    if err:
        print(f"  history_deals_get(position={ticket}) {err}")
        return
    print(f"\n  [1] history_deals_get(position={ticket}) -> {len(deals)} deal(s), unfiltered:")
    if not deals:
        print("      none — this terminal holds no deals for that id at all.")
    for deal in sorted(deals, key=lambda d: d.time):
        print(describe_deal(deal, highlight_ticket=ticket))

    # The exact test that made the bridge give up, reproduced here so the output
    # says plainly whether this script agrees with it.
    own = [d for d in deals if d.position_id == ticket]
    closing = [d for d in own if d.entry in (mt5.DEAL_ENTRY_OUT, mt5.DEAL_ENTRY_OUT_BY)]
    dropped = [d for d in deals if d.position_id != ticket]
    print(f"\n      after the bridge's position_id=={ticket} re-check: "
          f"{len(own)} kept, {len(dropped)} dropped")
    print(f"      closing deals among those kept: {len(closing)}"
          f"{'  <-- this is why it gave up' if not closing else ''}")
    if dropped:
        print(f"      DROPPED deals carried position ids: "
              f"{sorted({d.position_id for d in dropped})}")

    orders, order_err = orders_by_position(ticket)
    print(f"\n  [2] history_orders_get(position={ticket}) -> "
          f"{order_err if order_err else f'{len(orders)} order(s)'}:")
    for order in sorted(orders, key=lambda o: o.time_setup):
        # position_by_id is non-zero only on a close-by, and it names the counterpart.
        by_id = getattr(order, "position_by_id", 0)
        by_note = f"  position_by_id={by_id}  <-- CLOSE-BY, counterpart named" if by_id else ""
        print(f"    order #{order.ticket}  {stamp(order.time_setup)}  {order.symbol}  "
              f"type={order.type}  state={order.state}  volume {order.volume_initial}"
              f"{by_note}")
        print(f"      comment {order.comment!r}  magic {order.magic}")


def report_window(days, tickets):
    """Every deal in the window, whatever position it belongs to.

    This is the view that finds a closing deal filed under a different position id —
    the thing the strict per-position query cannot see by construction.
    """
    end = datetime.now() + timedelta(days=1)
    start = end - timedelta(days=days + 1)
    print(f"\n{'=' * 78}")
    print(f"  [3] ALL DEALS {start:%Y-%m-%d} -> {end:%Y-%m-%d} (dated sweep)")
    print(f"{'=' * 78}")

    try:
        deals = mt5.history_deals_get(start, end)
    except Exception as exc:
        print(f"  dated history_deals_get raised: {exc}")
        return
    if deals is None:
        print(f"  dated history_deals_get returned None ({mt5.last_error()})")
        return

    ours = [d for d in deals if d.symbol in OUR_SYMBOLS]
    print(f"  {len(deals)} deal(s) total, {len(ours)} on {', '.join(OUR_SYMBOLS)}.")
    print("  (the rest belong to the foreign EAs sharing this account)\n")

    for deal in sorted(ours, key=lambda d: d.time):
        flag = "  *** references a ticket we asked about" if deal.position_id in tickets else ""
        print(describe_deal(deal) + flag)


def main():
    parser = argparse.ArgumentParser(description="Read-only MT5 orphaned-close diagnostic.")
    parser.add_argument("tickets", nargs="+", type=int, help="position ids to explain")
    parser.add_argument("--days", type=int, default=10,
                        help="how far back the dated sweep looks (default 10)")
    args = parser.parse_args()

    if not mt5.initialize():
        print(f"MT5 initialize failed: {mt5.last_error()}")
        print("The terminal may be running elevated while this process is not.")
        sys.exit(1)

    try:
        account = mt5.account_info()
        if account is None:
            print(f"account_info returned None ({mt5.last_error()}) — terminal not logged in?")
            sys.exit(1)
        print(f"connected: #{account.login} {account.server}  "
              f"balance {account.balance} {account.currency}  equity {account.equity}")
        compare_broker_clock()
        # Floating P&L of exactly zero means no positions at all, which is the
        # cleanest possible proof that an 'OPEN' journal row is stale.
        print(f"floating P&L: {round(account.equity - account.balance, 2)} "
              f"(zero means the account holds nothing)")

        positions = mt5.positions_get()
        live = {p.ticket for p in positions} if positions else set()
        print(f"open positions right now: {len(live)}")
        for position in positions or []:
            print(f"    #{position.ticket} {position.symbol} {position.type} "
                  f"vol {position.volume} profit {position.profit} magic {position.magic}")

        for ticket in args.tickets:
            report_ticket(ticket, live)

        report_window(args.days, set(args.tickets))
    finally:
        # Closes only THIS process's connection. The running bridge is unaffected.
        mt5.shutdown()


if __name__ == "__main__":
    main()
