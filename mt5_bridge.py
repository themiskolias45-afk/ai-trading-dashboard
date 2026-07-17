"""
SmartEntry MT5 Bridge v1
Polls SmartEntry Pro signals and executes trades on MetaTrader 5.

Requirements:
    pip install MetaTrader5 requests colorama

Usage:
    python mt5_bridge.py           # semi-auto (confirm each trade)
    python mt5_bridge.py --auto    # full-auto (execute STRONG signals instantly)
"""

import sys
import os
import time
import json
import requests
from datetime import datetime

try:
    import MetaTrader5 as mt5
except ImportError:
    print("ERROR: MetaTrader5 not installed. Run: pip install MetaTrader5")
    sys.exit(1)

try:
    from colorama import init, Fore, Style
    init(autoreset=True)
    GREEN  = Fore.GREEN
    RED    = Fore.RED
    YELLOW = Fore.YELLOW
    CYAN   = Fore.CYAN
    BOLD   = Style.BRIGHT
    RESET  = Style.RESET_ALL
except ImportError:
    GREEN = RED = YELLOW = CYAN = BOLD = RESET = ""

# ── Configuration ─────────────────────────────────────────────────────────────
SERVER_URL     = os.environ.get("SMARTENTRY_URL", "http://localhost:3001")
RISK_PERCENT   = float(os.environ.get("RISK_PERCENT", "1.0"))   # % of balance per trade
MAX_SPREAD_PTS = int(os.environ.get("MAX_SPREAD",    "50"))      # reject trade if spread > this
POLL_INTERVAL  = int(os.environ.get("POLL_INTERVAL", "60"))      # seconds between signal checks
MAGIC_NUMBER   = 20250101                                         # unique ID for SmartEntry orders
AUTO_MODE      = "--auto" in sys.argv

# MT5 symbol map: SmartEntry ticker → MT5 symbol name
SYMBOL_MAP = {
    "BTC-USD": "BTCUSD",
    "GC=F":    "XAUUSD",
    "SPY":     None,        # equities not available on most MT5 brokers — skip
}

# Minimum lots per symbol (broker-specific — adjust if needed)
MIN_LOT = {
    "BTCUSD": 0.01,
    "XAUUSD": 0.01,
}

# ── State ─────────────────────────────────────────────────────────────────────
executed_signals  = {}   # key → signal updatedAt string (deduplication)
known_positions   = set()  # set of open SmartEntry position tickets
position_initial_r = {}  # ticket → initial risk (|entry - original_sl|) for trailing stop logic
position_partial_taken = set()  # tickets where 50% has already been closed at 1R

# ── Risk circuit breaker ───────────────────────────────────────
daily_pnl        = 0.0      # cumulative P&L today
daily_loss_limit = float(os.environ.get("DAILY_LOSS_PCT", "3.0"))  # % of balance
consecutive_losses = 0
MAX_CONSECUTIVE_LOSSES = int(os.environ.get("MAX_CONSEC_LOSSES", "3"))
trading_halted   = False
halt_reason      = ""

# ── Helpers ───────────────────────────────────────────────────────────────────

def check_circuit_breaker():
    global trading_halted, halt_reason
    if trading_halted:
        return True
    acc = mt5.account_info()
    if not acc:
        return False
    # Daily loss limit
    if acc.balance > 0:
        loss_pct = (-daily_pnl / acc.balance) * 100
        if loss_pct >= daily_loss_limit:
            trading_halted = True
            halt_reason = f"Daily loss limit hit: -{loss_pct:.1f}% (limit {daily_loss_limit}%)"
            log(f"🛑 CIRCUIT BREAKER: {halt_reason}", RED + BOLD)
            return True
    # Consecutive losses
    if consecutive_losses >= MAX_CONSECUTIVE_LOSSES:
        trading_halted = True
        halt_reason = f"{consecutive_losses} consecutive losses — pausing"
        log(f"🛑 CIRCUIT BREAKER: {halt_reason}", RED + BOLD)
        return True
    return False


def log(msg, color=""):
    ts = datetime.now().strftime("%H:%M:%S")
    print(f"{color}[{ts}] {msg}{RESET}")


def fetch_signals():
    try:
        res = requests.get(f"{SERVER_URL}/api/signals", timeout=10)
        res.raise_for_status()
        return res.json()
    except Exception as e:
        log(f"Signal fetch failed: {e}", RED)
        return None


def connect_mt5():
    if not mt5.initialize():
        log(f"MT5 initialize() failed — error: {mt5.last_error()}", RED)
        log("Make sure MetaTrader 5 is open and logged into your broker account.", YELLOW)
        return False
    info = mt5.terminal_info()
    acc  = mt5.account_info()
    if info and acc:
        log(f"MT5 connected: {acc.name} @ {info.company}", GREEN)
        log(f"Balance: ${acc.balance:.2f}  |  Equity: ${acc.equity:.2f}  |  Leverage: 1:{acc.leverage}", CYAN)
    return True


def get_lot_size(symbol, entry, stop):
    acc = mt5.account_info()
    if not acc:
        return MIN_LOT.get(symbol, 0.01)

    balance      = acc.balance
    risk_amount  = balance * RISK_PERCENT / 100
    stop_distance = abs(entry - stop)
    if stop_distance == 0:
        return MIN_LOT.get(symbol, 0.01)

    sym_info = mt5.symbol_info(symbol)
    if not sym_info:
        return MIN_LOT.get(symbol, 0.01)

    tick_value  = sym_info.trade_tick_value   # $ per tick
    tick_size   = sym_info.trade_tick_size    # price per tick
    if tick_size == 0:
        return MIN_LOT.get(symbol, 0.01)

    pips_at_risk    = stop_distance / tick_size
    value_per_lot   = pips_at_risk * tick_value
    if value_per_lot == 0:
        return MIN_LOT.get(symbol, 0.01)

    raw_lots = risk_amount / value_per_lot
    step     = sym_info.volume_step
    lots     = round(raw_lots / step) * step
    lots     = max(lots, sym_info.volume_min)
    lots     = min(lots, sym_info.volume_max)
    return round(lots, 2)


def check_spread(symbol):
    tick = mt5.symbol_info_tick(symbol)
    if not tick:
        return False, 0
    info  = mt5.symbol_info(symbol)
    spread = (tick.ask - tick.bid) / info.trade_tick_size if info else 0
    ok = spread <= MAX_SPREAD_PTS
    return ok, spread


def place_order(symbol, signal_type, entry, stop, target):
    spread_ok, spread = check_spread(symbol)
    if not spread_ok:
        log(f"Spread too wide on {symbol}: {spread:.0f} pts (max {MAX_SPREAD_PTS}) — skipping", YELLOW)
        return False

    order_type = mt5.ORDER_TYPE_BUY if signal_type == "BUY" else mt5.ORDER_TYPE_SELL
    tick       = mt5.symbol_info_tick(symbol)
    price      = tick.ask if signal_type == "BUY" else tick.bid
    lots       = get_lot_size(symbol, entry, stop)

    request = {
        "action":        mt5.TRADE_ACTION_DEAL,
        "symbol":        symbol,
        "volume":        lots,
        "type":          order_type,
        "price":         price,
        "sl":            stop,
        "tp":            target,
        "deviation":     20,
        "magic":         MAGIC_NUMBER,
        "comment":       "SmartEntry",
        "type_time":     mt5.ORDER_TIME_GTC,
        "type_filling":  mt5.ORDER_FILLING_IOC,
    }

    result = mt5.order_send(request)
    if result.retcode == mt5.TRADE_RETCODE_DONE:
        log(f"ORDER PLACED: {signal_type} {lots} lot {symbol} @ {price:.2f}  SL:{stop}  TP:{target}", GREEN + BOLD)
        log(f"Ticket: #{result.order}", GREEN)
        # Notify server so it can generate commentary and log the trade
        try:
            requests.post(f"{SERVER_URL}/api/trade-opened", json={
                "ticket": result.order,
                "symbol": symbol,
                "type":   signal_type,
                "price":  round(price, 5),
                "sl":     stop,
                "tp":     target,
                "volume": lots,
            }, timeout=5)
        except Exception as e:
            log(f"Could not POST trade-opened to server: {e}", YELLOW)
        known_positions.add(result.order)
        return True
    else:
        log(f"Order failed (retcode {result.retcode}): {result.comment}", RED)
        return False


def prompt_confirm(sig, symbol):
    direction  = sig["signal"]
    entry      = sig.get("entry")
    stop       = sig.get("stop")
    target     = sig.get("target")
    rr         = sig.get("rr")
    rsi        = sig.get("indicators", {}).get("rsi")
    trend      = sig.get("trend", "")
    strength   = sig.get("strength", "")
    setup      = sig.get("setup", "").replace("_", " ")

    color = GREEN if direction == "BUY" else RED

    print()
    print(f"{color}{BOLD}{'='*60}{RESET}")
    print(f"{color}{BOLD}  {sig['label']} — {strength} {direction} ({setup}){RESET}")
    print(f"{color}{'='*60}{RESET}")
    print(f"  Trend:    {trend}")
    print(f"  Price:    ${sig['price']:,.2f}")
    print(f"  Entry:    ${entry:,.2f}")
    print(f"  Stop:     ${stop:,.2f}")
    print(f"  Target:   ${target:,.2f}")
    if rr:
        print(f"  R/R:      1:{rr}  {'✓ Good' if rr >= 2 else '⚠ Tight'}")
    print(f"  RSI:      {rsi}")
    print(f"  MT5 sym:  {symbol}")
    acc = mt5.account_info()
    if acc:
        lots = get_lot_size(symbol, entry, stop)
        risk_usd = acc.balance * RISK_PERCENT / 100
        print(f"  Lots:     {lots}  (${risk_usd:.2f} risk at {RISK_PERCENT}% of ${acc.balance:.2f})")
    print(f"{color}{'='*60}{RESET}")

    if AUTO_MODE:
        log(f"AUTO-MODE: executing {direction} on {symbol}", YELLOW)
        return True

    answer = input(f"\n{BOLD}Execute this trade? [y/N]: {RESET}").strip().lower()
    return answer in ("y", "yes")


def process_signal(key, sig):
    if check_circuit_breaker():
        log(f"Trading halted: {halt_reason}", RED)
        return
    if not sig:
        return
    direction = sig.get("signal")
    strength  = sig.get("strength")
    ticker    = sig.get("ticker")
    updated   = sig.get("updatedAt", "")

    # Only act on non-WAIT signals
    if direction == "WAIT":
        return

    # Deduplicate — only trade each unique signal once
    cache_key = f"{key}_{direction}_{updated}"
    if executed_signals.get(key) == cache_key:
        return

    # In semi-auto: act on any BUY/SELL. In auto: only STRONG signals.
    if AUTO_MODE and strength != "STRONG":
        return

    symbol = SYMBOL_MAP.get(ticker)
    if not symbol:
        log(f"No MT5 symbol for {ticker} — skipping", YELLOW)
        executed_signals[key] = cache_key
        return

    # Check news blackout before executing
    blackout, blackout_reason = check_news_blackout()
    if blackout:
        log(f"NEWS BLACKOUT — skipping {ticker}: {blackout_reason}", YELLOW)
        return

    # Check symbol is tradeable
    if not mt5.symbol_select(symbol, True):
        log(f"Cannot select {symbol} in MT5 — check symbol name for your broker", RED)
        return

    entry  = sig.get("entry")
    stop   = sig.get("stop")
    target = sig.get("target")

    if not entry or not stop or not target:
        log(f"Incomplete levels for {key} — skipping", YELLOW)
        executed_signals[key] = cache_key
        return

    # Claude AI approval (only in AUTO mode — in semi-auto the human decides)
    if AUTO_MODE:
        ai_ok = claude_approves_trade(sig, symbol, entry, stop, target)
        if not ai_ok:
            log(f"Trade BLOCKED by Claude AI filter — {ticker}", RED)
            executed_signals[key] = cache_key  # mark so we don't retry same signal
            return

    confirmed = prompt_confirm(sig, symbol)
    if confirmed:
        ok = place_order(symbol, direction, entry, stop, target)
        if ok:
            executed_signals[key] = cache_key
    else:
        log(f"Trade on {symbol} skipped by user", YELLOW)
        executed_signals[key] = cache_key  # mark so we don't prompt again this signal


def report_positions():
    """Send open MT5 positions to SmartEntry server so the dashboard can display them."""
    try:
        positions = mt5.positions_get()
        if positions is None:
            return
        data = []
        for p in positions:
            if p.magic != MAGIC_NUMBER:
                continue  # only SmartEntry trades
            data.append({
                "ticket":  p.ticket,
                "symbol":  p.symbol,
                "type":    "BUY" if p.type == 0 else "SELL",
                "volume":  p.volume,
                "price":   p.price_open,
                "sl":      p.sl,
                "tp":      p.tp,
                "profit":  round(p.profit, 2),
                "openTime": datetime.fromtimestamp(p.time).strftime("%H:%M:%S"),
            })
        requests.post(f"{SERVER_URL}/api/mt5/positions", json={"positions": data}, timeout=5)
    except Exception:
        pass


def print_status(signals):
    now   = datetime.now().strftime("%H:%M:%S")
    parts = []
    for k, label in [("btc", "BTC"), ("gold", "Gold"), ("spx", "SPY")]:
        s = signals.get(k)
        if s:
            sig = s.get("signal", "?")
            rsi = s.get("indicators", {}).get("rsi", "?")
            color = GREEN if sig == "BUY" else RED if sig == "SELL" else YELLOW
            parts.append(f"{color}{label}:{sig}(RSI {rsi}){RESET}")
    print(f"[{now}] {' | '.join(parts)}")


def check_news_blackout():
    """Ask the server if we're inside a 30-min news blackout window."""
    try:
        res = requests.get(f"{SERVER_URL}/api/newsfilter", timeout=5)
        data = res.json()
        return data.get("blackout", False), data.get("reason", None)
    except Exception:
        return False, None  # fail open — don't block trades if server unreachable


def claude_approves_trade(sig, symbol, entry, stop, target):
    """Ask Claude Opus to approve or reject this trade before execution."""
    try:
        res = requests.post(
            f"{SERVER_URL}/api/claude-approve-trade",
            json={"signal": sig, "symbol": symbol, "entry": entry, "stop": stop, "target": target},
            timeout=25
        )
        data = res.json()
        approved = data.get("approved", True)
        reason   = data.get("reason", "")
        risk     = data.get("risk", "MEDIUM")
        color = GREEN if approved else RED
        log(f"Claude AI: {'APPROVED' if approved else 'REJECTED'} [{risk}] — {reason}", color)
        return approved
    except Exception as e:
        log(f"AI approval unavailable ({e}) — proceeding", YELLOW)
        return True  # fail open so network issues don't block all trades


def manage_trailing_stops():
    """Move SL to breakeven at 1R profit; trail to entry+1R at 2R profit."""
    try:
        res  = requests.get(f"{SERVER_URL}/api/features", timeout=5)
        feat = res.json().get("features", {})
        if not feat.get("trailingStop", True):
            return
    except Exception:
        pass  # if server unreachable, run anyway (trailing stops are safety-critical)

    positions = mt5.positions_get()
    if not positions:
        return

    for p in positions:
        if p.magic != MAGIC_NUMBER:
            continue

        ticket = p.ticket
        entry  = p.price_open
        sl     = p.sl
        tp     = p.tp
        price  = p.price_current
        is_buy = (p.type == 0)
        symbol = p.symbol

        # Record initial R on first encounter with this position
        if ticket not in position_initial_r and sl != 0:
            r = abs(entry - sl)
            if r > 0:
                position_initial_r[ticket] = r

        r = position_initial_r.get(ticket)
        if not r or r == 0:
            continue

        new_sl = None
        if is_buy:
            # 1R profit → move SL to breakeven
            if price >= entry + r and sl < entry - 0.0001:
                new_sl = round(entry, 5)
                log(f"Breakeven triggered: #{ticket} {symbol} SL → {new_sl}", CYAN)
            # 2R profit → trail SL to entry + 1R (lock in 1R)
            elif price >= entry + 2 * r and sl < round(entry + r, 5) - 0.0001:
                new_sl = round(entry + r, 5)
                log(f"Trail 2R: #{ticket} {symbol} SL → {new_sl}", CYAN)
        else:  # SELL
            # 1R profit → move SL to breakeven
            if price <= entry - r and sl > entry + 0.0001:
                new_sl = round(entry, 5)
                log(f"Breakeven triggered: #{ticket} {symbol} SL → {new_sl}", CYAN)
            # 2R profit → trail SL to entry - 1R
            elif price <= entry - 2 * r and sl > round(entry - r, 5) + 0.0001:
                new_sl = round(entry - r, 5)
                log(f"Trail 2R: #{ticket} {symbol} SL → {new_sl}", CYAN)

        if new_sl is not None:
            req = {
                "action":   mt5.TRADE_ACTION_SLTP,
                "position": ticket,
                "symbol":   symbol,
                "sl":       new_sl,
                "tp":       tp,
                "magic":    MAGIC_NUMBER,
            }
            result = mt5.order_send(req)
            if result.retcode == mt5.TRADE_RETCODE_DONE:
                log(f"SL updated to {new_sl} for #{ticket}", GREEN)
            else:
                log(f"SL update failed #{ticket}: {result.comment}", RED)


def take_partial_profit():
    """At 1R profit: close 50% of the position, move SL to breakeven."""
    positions = mt5.positions_get()
    if not positions:
        return

    for p in positions:
        if p.magic != MAGIC_NUMBER:
            continue
        ticket = p.ticket
        if ticket in position_partial_taken:
            continue  # already done for this trade

        r = position_initial_r.get(ticket)
        if not r or r == 0:
            continue

        entry  = p.price_open
        price  = p.price_current
        is_buy = (p.type == 0)

        at_1r = (is_buy and price >= entry + r) or (not is_buy and price <= entry - r)
        if not at_1r:
            continue

        # Close 50% of the position
        sym_info = mt5.symbol_info(p.symbol)
        if not sym_info:
            continue
        half_vol = round(p.volume / 2 / sym_info.volume_step) * sym_info.volume_step
        half_vol = max(half_vol, sym_info.volume_min)
        if half_vol >= p.volume:
            continue  # too small to split

        tick       = mt5.symbol_info_tick(p.symbol)
        close_type = mt5.ORDER_TYPE_SELL if is_buy else mt5.ORDER_TYPE_BUY
        close_price = tick.bid if is_buy else tick.ask

        close_req = {
            "action":       mt5.TRADE_ACTION_DEAL,
            "position":     ticket,
            "symbol":       p.symbol,
            "volume":       half_vol,
            "type":         close_type,
            "price":        close_price,
            "deviation":    20,
            "magic":        MAGIC_NUMBER,
            "comment":      "SmartEntry partial 1R",
            "type_filling": mt5.ORDER_FILLING_IOC,
        }
        result = mt5.order_send(close_req)
        if result.retcode == mt5.TRADE_RETCODE_DONE:
            position_partial_taken.add(ticket)
            log(f"PARTIAL PROFIT: Closed 50% of #{ticket} {p.symbol} @ {close_price:.2f} (+1R)", GREEN + BOLD)
            # Move SL to breakeven
            be_req = {
                "action":   mt5.TRADE_ACTION_SLTP,
                "position": ticket,
                "symbol":   p.symbol,
                "sl":       round(entry, 5),
                "tp":       p.tp,
                "magic":    MAGIC_NUMBER,
            }
            be_result = mt5.order_send(be_req)
            if be_result.retcode == mt5.TRADE_RETCODE_DONE:
                log(f"SL moved to breakeven for #{ticket}", CYAN)
        else:
            log(f"Partial close failed #{ticket}: {result.comment}", RED)


def track_closed_positions():
    """Detect positions that closed since last check and POST to /api/trade-closed."""
    global known_positions

    positions = mt5.positions_get()
    current_tickets = set()
    if positions:
        for p in positions:
            if p.magic == MAGIC_NUMBER:
                current_tickets.add(p.ticket)

    closed_tickets = known_positions - current_tickets

    for ticket in closed_tickets:
        pnl         = None
        close_price = None
        try:
            from datetime import timedelta
            deals = mt5.history_deals_get(
                datetime.now() - timedelta(days=1),
                datetime.now(),
                position=ticket
            )
            if deals:
                for deal in deals:
                    if deal.entry == mt5.DEAL_ENTRY_OUT:
                        pnl         = round(deal.profit, 2)
                        close_price = deal.price
                        break
        except Exception:
            pass

        global daily_pnl, consecutive_losses
        if pnl is not None:
            daily_pnl += pnl
            if pnl < 0:
                consecutive_losses += 1
            else:
                consecutive_losses = 0

        try:
            requests.post(f"{SERVER_URL}/api/trade-closed", json={
                "ticket":     ticket,
                "pnl":        pnl,
                "closePrice": close_price,
                "closeTime":  datetime.now().isoformat(),
            }, timeout=5)
            color = GREEN if pnl and pnl > 0 else RED
            log(f"Trade closed #{ticket}  P&L ${pnl}", color)
        except Exception as e:
            log(f"Could not POST trade-closed #{ticket}: {e}", RED)

        try:
            requests.post(f"{SERVER_URL}/api/risk-status", json={
                "dailyPnl": round(daily_pnl, 2),
                "consecutiveLosses": consecutive_losses,
                "halted": trading_halted,
                "haltReason": halt_reason
            }, timeout=3)
        except Exception:
            pass

        position_initial_r.pop(ticket, None)

    known_positions = current_tickets


# ── Main loop ─────────────────────────────────────────────────────────────────

def main():
    print(f"\n{CYAN}{BOLD}SmartEntry MT5 Bridge v1{RESET}")
    print(f"Mode: {'AUTO (STRONG signals only)' if AUTO_MODE else 'SEMI-AUTO (confirm each trade)'}")
    print(f"Risk per trade: {RISK_PERCENT}%  |  Max spread: {MAX_SPREAD_PTS} pts")
    print(f"Server: {SERVER_URL}")
    print(f"Poll interval: {POLL_INTERVAL}s\n")

    if not connect_mt5():
        sys.exit(1)

    log("Bridge started — watching for signals…", GREEN)

    while True:
        try:
            data = fetch_signals()
            if data:
                print_status(data)
                for key in ["btc", "gold"]:   # SPY skipped — not on MT5
                    process_signal(key, data.get(key))
            report_positions()
            manage_trailing_stops()
            take_partial_profit()
            track_closed_positions()
        except KeyboardInterrupt:
            log("Shutting down MT5 bridge…", YELLOW)
            mt5.shutdown()
            sys.exit(0)
        except Exception as e:
            log(f"Loop error: {e}", RED)

        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
