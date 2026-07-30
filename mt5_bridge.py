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
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

# Force UTF-8 stdout/stderr regardless of how this process is launched — Task
# Scheduler and some non-console launch paths fall back to the system's legacy
# codepage (cp1252 on Windows), which can't encode characters like the arrow
# used in log lines below and crashes the whole bridge on the very first log call.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

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
TERMINAL_PATH  = os.environ.get("MT5_TERMINAL_PATH", "")          # pin to one MT5 install when running multiple terminals
ACCOUNT_TAG    = os.environ.get("ACCOUNT_TAG", "")                # identifies this instance in logs + server posts (dual-account setups)

# Refuse to trade unless the connected terminal holds this exact login.
#
# MT5_TERMINAL_PATH pins a bridge to one *install*, which is not the same as
# pinning it to one *account*. Two terminals can hold the same login, and if they
# do, both bridges poll the same signals and both execute against the same
# account: every trade placed twice, at double the intended risk. That is not
# redundancy, it is accidental 2x leverage, and nothing in this file used to
# prevent it — the mirrored dual-account setup only ever worked because the two
# terminals happened to hold different accounts.
#
# Leave unset to keep the old behaviour (connect to whatever the terminal holds).
# Set it per bridge and a mis-pointed terminal fails loudly at startup instead of
# silently doubling exposure.
EXPECTED_LOGIN = os.environ.get("MT5_EXPECTED_LOGIN", "").strip()

# MT5 symbol map: SmartEntry Yahoo ticker → candidate MT5 symbol names (checked in order)
SYMBOL_CANDIDATES = {
    "BTC-USD": ["BTCUSD", "BTC/USD", "BITCOIN", "BTCUSDT"],
    "GC=F":    ["XAUUSD", "GOLD", "XAUUSDm", "GOLDm"],
    "^GSPC":   ["SP500", "US500", "SPX500", "US.500", "SPY"],
}

# Assets AUTO mode may open positions on. All three trade.
#
# Kept as one named tuple rather than three hardcoded submit() calls so an asset
# can be taken out later by editing this line alone. Worth knowing when that day
# comes: replayed through generateSignalMTF - the live multi-timeframe path, not
# the single-timeframe replay the standard harness runs - SPX scores PF 0.32 over
# the full sample and 0.00 on the held-out test half. It trades anyway; the
# learning engine cannot calibrate on an asset it never sees closed trades from.
TRADABLE_KEYS = ("btc", "gold", "spx")

# Resolved at startup by auto_detect_symbols()
SYMBOL_MAP = {}

# Minimum lots per symbol (broker-specific — auto-detected at startup)
MIN_LOT = {}

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

# Remote halt set from the dashboard. Separate from the local circuit breakers
# because the two mean different things: a circuit breaker is the bridge deciding
# it has lost enough for today, a remote halt is a human deciding to stop.
# Reported separately too, so "why is nothing trading" always has a clear answer.
remote_halted = False
remote_halt_reason = ""


def check_remote_control():
    """Poll the server's kill switch. Returns True when trading is remotely halted.

    Deliberately fail-OPEN on a network error: the server being briefly
    unreachable is not an instruction to stop, and the local circuit breakers
    still protect the account. A halt that latches on every dropped packet would
    train you to ignore it.
    """
    global remote_halted, remote_halt_reason
    try:
        res = requests.get(f"{SERVER_URL}/api/mt5/control", timeout=5)
        res.raise_for_status()
        control = res.json()
        halted = bool(control.get("halted"))
        reason = control.get("reason") or "halted from dashboard"
        if halted and not remote_halted:
            log(f"REMOTE HALT: {reason} — will not open new trades.", RED + BOLD)
        elif not halted and remote_halted:
            log("Remote halt lifted — trading enabled again.", GREEN)
        remote_halted = halted
        remote_halt_reason = reason if halted else ""
        return remote_halted
    except Exception as exc:
        log(f"Could not read remote control ({exc}) — leaving trading as-is.", YELLOW)
        return remote_halted


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
    prefix = f"[{ACCOUNT_TAG}] " if ACCOUNT_TAG else ""
    print(f"{color}[{ts}] {prefix}{msg}{RESET}")


def fetch_signals():
    try:
        res = requests.get(f"{SERVER_URL}/api/signals", timeout=10)
        res.raise_for_status()
        return res.json()
    except Exception as e:
        log(f"Signal fetch failed: {e}", RED)
        return None


def auto_detect_symbols():
    """Auto-detect available MT5 symbols by checking broker's symbol list."""
    global SYMBOL_MAP, MIN_LOT
    all_symbols = {s.name for s in (mt5.symbols_get() or [])}
    log(f"Broker has {len(all_symbols)} symbols available — auto-detecting...", CYAN)

    for se_ticker, candidates in SYMBOL_CANDIDATES.items():
        for candidate in candidates:
            if candidate in all_symbols:
                info = mt5.symbol_info(candidate)
                if info:
                    mt5.symbol_select(candidate, True)
                    SYMBOL_MAP[se_ticker] = candidate
                    MIN_LOT[candidate] = info.volume_min
                    log(f"  {se_ticker:12s} → {candidate:12s} (min lot: {info.volume_min})", GREEN)
                    break
        else:
            log(f"  {se_ticker:12s} → NOT FOUND on this broker (skipping)", YELLOW)

    if not SYMBOL_MAP:
        log("No tradeable symbols found — check broker symbol names.", RED)
        return False
    log(f"Auto-detect complete: {len(SYMBOL_MAP)} asset(s) ready to trade.", GREEN)
    return True


# ── MT5 → server candle feed ──────────────────────────────────────────────────
# Until this existed, every bar the signal engine read came from Yahoo Finance
# (GC=F, BTC-USD, ^GSPC) while every fill happened on the broker's own symbols
# (XAUUSD, BTCUSD, SP500). Those are different instruments: different price,
# different sessions, different bars. Entry/stop/target were computed on a
# continuous futures series and then sent to a broker quoting spot, so the levels
# did not exist on the chart the trade lived on, and Gold's volume ratio read ~18x
# because it compared a contract's volume against a continuous series' average.
#
# The bridge is the only process that can see MT5, so it is the only place these
# bars can come from. SYMBOL_MAP is already resolved by auto_detect_symbols(), so
# this reuses the mapping the executor itself trades on — the feed and the fill can
# never drift apart.
BAR_COUNT_BY_TIMEFRAME = {"d1": 300, "h4": 400, "h1": 400}

# Pushed on its own clock rather than every poll: 1100 bars x 3 symbols is a real
# payload, and the daily bar the signal engine cares about only closes once a day.
CANDLE_PUSH_INTERVAL_SEC = 300
_last_candle_push_at = 0.0


def _rates_to_bars(rates):
    """Convert an MT5 rates array to the {closes,highs,lows,volumes} shape the
    server's signal engine already consumes. Returns None if unusable.

    tick_volume, not real_volume: brokers leave real_volume at 0 on CFDs and
    synthetic symbols, and a series of zeros would make every volume ratio null
    and silently disable every volume-confirmed setup.
    """
    if rates is None or len(rates) == 0:
        return None
    try:
        bars = {
            "closes":  [float(r["close"])       for r in rates],
            "highs":   [float(r["high"])        for r in rates],
            "lows":    [float(r["low"])         for r in rates],
            "volumes": [float(r["tick_volume"]) for r in rates],
        }
    except (KeyError, ValueError, TypeError) as exc:
        log(f"Rate conversion failed: {exc}", YELLOW)
        return None
    # A NaN or inf reaching the indicators poisons every comparison downstream and
    # produces a confident-looking signal from garbage. Drop the whole timeframe.
    for series in bars.values():
        if not all(v == v and v not in (float("inf"), float("-inf")) for v in series):
            log("Rate series contained NaN/inf — discarding timeframe", YELLOW)
            return None
    return bars


def push_candles(force=False):
    """Push native D1/H4/H1 bars for every mapped symbol to the server.

    Failure here must never stop trading: the server keeps the Yahoo path as its
    fallback, so a push that does not land degrades the data source rather than
    halting the bridge.
    """
    global _last_candle_push_at
    if not SYMBOL_MAP:
        return
    now = time.time()
    if not force and now - _last_candle_push_at < CANDLE_PUSH_INTERVAL_SEC:
        return

    timeframes = {"d1": mt5.TIMEFRAME_D1, "h4": mt5.TIMEFRAME_H4, "h1": mt5.TIMEFRAME_H1}
    assets = {}
    for se_ticker, mt5_symbol in SYMBOL_MAP.items():
        bars_by_tf = {}
        for tf_name, tf_const in timeframes.items():
            try:
                rates = mt5.copy_rates_from_pos(mt5_symbol, tf_const, 0, BAR_COUNT_BY_TIMEFRAME[tf_name])
            except Exception as exc:
                log(f"copy_rates {mt5_symbol} {tf_name} raised: {exc}", YELLOW)
                continue
            converted = _rates_to_bars(rates)
            if converted:
                bars_by_tf[tf_name] = converted
        if bars_by_tf:
            assets[se_ticker] = {"symbol": mt5_symbol, "bars": bars_by_tf}

    if not assets:
        log("No MT5 bars available to push — server stays on its Yahoo fallback.", YELLOW)
        return

    try:
        res = requests.post(
            f"{SERVER_URL}/api/mt5/candles",
            json={"account": ACCOUNT_TAG or "default", "assets": assets},
            timeout=20,
        )
        res.raise_for_status()
        accepted = res.json().get("accepted", {})
        _last_candle_push_at = now
        summary = ", ".join(
            f"{se}->{assets[se]['symbol']}:{len(assets[se]['bars'])}tf"
            for se in assets
        )
        log(f"Pushed MT5 candles ({summary}) — server accepted {accepted}", CYAN)
    except Exception as exc:
        log(f"Candle push failed ({exc}) — server stays on its Yahoo fallback.", YELLOW)


def connect_mt5():
    init_ok = mt5.initialize(path=TERMINAL_PATH) if TERMINAL_PATH else mt5.initialize()
    if not init_ok:
        log(f"MT5 initialize() failed — error: {mt5.last_error()}", RED)
        log("Make sure MetaTrader 5 is open and logged into your broker account.", YELLOW)
        return False
    info = mt5.terminal_info()
    acc  = mt5.account_info()

    if acc is None:
        log("MT5 initialize() succeeded but account_info() is empty — the terminal is "
            "running but not logged into an account.", RED)
        log("Log the terminal into its broker account, then restart this bridge.", YELLOW)
        mt5.shutdown()
        return False

    # Wrong account is worse than no account: it trades, just not where you think.
    if EXPECTED_LOGIN and str(acc.login) != EXPECTED_LOGIN:
        log(f"REFUSING TO TRADE — terminal is logged into #{acc.login} but this bridge "
            f"({ACCOUNT_TAG or 'untagged'}) expects #{EXPECTED_LOGIN}.", RED)
        log("Two bridges on one account would place every trade twice at double risk. "
            "Fix the terminal login or MT5_EXPECTED_LOGIN before restarting.", YELLOW)
        mt5.shutdown()
        return False

    if info:
        log(f"MT5 connected: {acc.name} #{acc.login} @ {info.company}  (terminal: {info.path})", GREEN)
    else:
        log(f"MT5 connected: {acc.name} #{acc.login}", GREEN)
    log(f"Balance: ${acc.balance:.2f}  |  Equity: ${acc.equity:.2f}  |  Leverage: 1:{acc.leverage}", CYAN)
    return auto_detect_symbols()


def get_lot_size(symbol, entry, stop, risk_amount=None):
    """Convert a dollar risk budget into broker lots.

    risk_amount defaults to the flat RISK_PERCENT of balance. The server's risk
    engine passes an explicit budget instead, which is how the 6% portfolio cap and
    the correlation penalty reach live trades. The dollars->lots conversion stays
    here on purpose: it needs tick_value/tick_size from this broker's symbol, and
    the server's `suggestedSize` is a raw unit count, not lots. Treating that number
    as lots would mis-size every position.
    """
    acc = mt5.account_info()
    if not acc:
        return MIN_LOT.get(symbol, 0.01)

    balance      = acc.balance
    if risk_amount is None:
        risk_amount = balance * RISK_PERCENT / 100
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

    # Fixed lot size overrides the risk maths entirely. This is what you want when
    # you would rather trade a known, small size than let a percentage of a large
    # balance decide - e.g. always 0.01 lots on gold regardless of the stop.
    fixed = float(strategy_settings.get("fixedLotSize", 0) or 0)
    if fixed > 0:
        raw_lots = fixed

    # Ceiling applies either way, so a wide stop on a big balance can never quietly
    # produce an enormous position.
    max_lots = float(strategy_settings.get("maxLotSize", 0) or 0)
    if max_lots > 0 and raw_lots > max_lots:
        log(f"Lot size capped: {raw_lots:.2f} → {max_lots:.2f} (maxLotSize)", YELLOW)
        raw_lots = max_lots

    step     = sym_info.volume_step
    lots     = round(raw_lots / step) * step
    # The broker's own floor and ceiling always win - asking for 0.005 where the
    # minimum is 0.01 would be rejected outright.
    lots     = max(lots, sym_info.volume_min)
    lots     = min(lots, sym_info.volume_max)
    return round(lots, 2)


# Last rejection reason per asset, so a standing rejection is logged once instead of
# once per poll. Same reasoning as the remote-halt transition logging: an alarm that
# repeats every cycle is one you stop reading.
last_rejection = {}


def open_positions_for_risk_engine():
    """Open SmartEntry positions in the shape server/sizing.js expects.

    calcPortfolioRisk needs entry, stop and lots per position to total up real
    money at risk, plus symbol and direction to spot correlated exposure.
    """
    out = []
    try:
        positions = mt5.positions_get()
        if not positions:
            return out
        for p in positions:
            if p.magic != MAGIC_NUMBER:
                continue
            out.append({
                "symbol":    p.symbol,
                "direction": "BUY" if p.type == 0 else "SELL",
                "entry":     float(p.price_open),
                "stop":      float(p.sl) if p.sl else float(p.price_open),
                "lots":      float(p.volume),
            })
    except Exception as exc:
        log(f"Could not read positions for risk check: {exc}", YELLOW)
    return out


def request_trade_approval(symbol, direction, entry, stop, target, confidence):
    """Ask the server's risk engine to approve and budget this trade.

    server/sizing.js holds the portfolio risk cap (6%), the single-trade cap (3%),
    the minimum R:R, a duplicate-position guard and a correlation penalty for being
    long or short several correlated markets at once. It was fully written and
    tested but nothing in the live path ever called it, so none of it applied to a
    real trade - the same way conviction sizing was dead code back in July.

    Returns (approved: bool, reason: str, risk_amount_usd: float or None).

    Fails CLOSED: no answer means no trade. That costs nothing, because signals come
    from this same server - if it cannot be reached there is no signal to act on
    anyway - and silently trading unguarded is the exact failure this closes.
    """
    acc = mt5.account_info()
    if not acc:
        return False, "no account info", None

    payload = {
        "accountBalance": float(acc.balance),
        "signal": {
            "symbol":     symbol,
            "direction":  direction,
            "entry":      float(entry),
            "stop":       float(stop),
            "target":     float(target),
            "confidence": float(confidence) if confidence is not None else 0.0,
        },
        "openPositions": open_positions_for_risk_engine(),
    }

    try:
        res = requests.post(f"{SERVER_URL}/api/size", json=payload, timeout=8)
        res.raise_for_status()
        verdict = res.json()
    except Exception as exc:
        return False, f"risk engine unreachable ({exc})", None

    if not verdict.get("approved"):
        return False, verdict.get("reason") or "rejected by risk engine", None

    # suggestedSize is riskAmount / stopDistance, so multiplying back gives the
    # dollar budget the engine approved - portfolio-aware, unlike a flat percentage.
    stop_distance = abs(float(entry) - float(stop))
    suggested     = float(verdict.get("suggestedSize") or 0)
    risk_amount   = suggested * stop_distance

    if risk_amount <= 0:
        return False, "risk engine approved a zero budget", None

    return True, verdict.get("reason") or "approved", risk_amount


# Strategy limits fetched from the server each cycle. Defaults match the server's
# own defaults so a bridge that cannot reach the server still behaves sanely.
strategy_settings = {
    "confidenceThreshold": 65,
    "maxConcurrentPositions": 3,
    "maxTradesPerDay": 5,
    "fixedLotSize": 0.0,   # 0 = size from risk; above 0 = always trade exactly this
    "maxLotSize": 10.0,    # hard ceiling regardless of what the risk maths asks for
    "minStrength": "MODERATE",  # lowest signal strength AUTO mode will take
}

# Trades opened today, reset on date change. Counted here rather than server-side
# because this bridge is what actually opens them.
trades_opened_today = 0
trades_count_date = datetime.now().date()


def refresh_strategy_settings():
    """Pull the current strategy limits. Keeps the last known values on failure."""
    global strategy_settings
    try:
        res = requests.get(f"{SERVER_URL}/api/strategy-settings", timeout=5)
        res.raise_for_status()
        data = res.json()
        for name in ("confidenceThreshold", "maxConcurrentPositions", "maxTradesPerDay"):
            if isinstance(data.get(name), (int, float)):
                strategy_settings[name] = int(data[name])
        # Lot sizes stay floats — int() here would make 0.01 become 0.
        for name in ("fixedLotSize", "maxLotSize"):
            if isinstance(data.get(name), (int, float)):
                strategy_settings[name] = float(data[name])
        if data.get("minStrength") in ("MODERATE", "STRONG"):
            strategy_settings["minStrength"] = data["minStrength"]
    except Exception:
        pass


def count_open_positions():
    try:
        positions = mt5.positions_get()
        if not positions:
            return 0
        return len([p for p in positions if p.magic == MAGIC_NUMBER])
    except Exception:
        return 0


def check_strategy_limits():
    """Enforce the slot and daily-trade caps. Returns (allowed, reason).

    Neither of these limits existed before: nothing capped concurrent positions,
    so the system could hold every asset at once, and nothing capped trades per
    day, so a choppy session could churn the account. The portfolio risk engine
    bounds total money at risk, which is related but not the same thing — three
    small positions can pass a risk cap and still be three ways of making the same
    bet.
    """
    global trades_opened_today, trades_count_date

    today = datetime.now().date()
    if today != trades_count_date:
        trades_count_date = today
        trades_opened_today = 0

    max_positions = strategy_settings.get("maxConcurrentPositions", 3)
    open_count = count_open_positions()
    if open_count >= max_positions:
        return False, f"{open_count} positions already open (limit {max_positions})"

    max_trades = strategy_settings.get("maxTradesPerDay", 5)
    if trades_opened_today >= max_trades:
        return False, f"{trades_opened_today} trades opened today (limit {max_trades})"

    return True, ""


def check_spread(symbol):
    tick = mt5.symbol_info_tick(symbol)
    if not tick:
        return False, 0
    info  = mt5.symbol_info(symbol)
    spread = (tick.ask - tick.bid) / info.trade_tick_size if info else 0
    ok = spread <= MAX_SPREAD_PTS
    return ok, spread


def build_order_comment(setup, confidence):
    """Name the trade so it is identifiable in the MT5 terminal.

    Every SmartEntry order used to carry the same static "SmartEntry" comment, so
    the terminal's Comment column said nothing about WHICH setup opened a position
    — you had to cross-reference the bridge log by timestamp to find out. MT5
    truncates this field (31 chars is the safe limit) and some brokers overwrite
    it entirely on partial fills, so it is a convenience, never the source of
    truth: MAGIC_NUMBER is what actually identifies our positions.
    """
    if not setup:
        return "SmartEntry"
    try:
        pct = int(round(float(confidence)))
    except (TypeError, ValueError, OverflowError):
        # Never invent a number here — a comment reading "SE MOMENTUM 0" would put
        # a fabricated 0% confidence in front of you in the terminal. Drop the
        # figure instead and keep the setup name, which is the useful part.
        return f"SE {setup}"[:31]
    # "SE " + setup + " " + up to 3 digits. RANGE_TRADE_SHORT is the longest setup
    # name at 17 chars, giving 24 worst case, so [:31] never cuts the name.
    return f"SE {setup} {pct}"[:31]


def place_order(symbol, signal_type, entry, stop, target, risk_amount=None,
                setup=None, confidence=None):
    """Place a market order. risk_amount is the dollar budget the server's risk
    engine approved; without it the flat RISK_PERCENT is used, which ignores how
    much of the portfolio is already exposed."""
    spread_ok, spread = check_spread(symbol)
    if not spread_ok:
        log(f"Spread too wide on {symbol}: {spread:.0f} pts (max {MAX_SPREAD_PTS}) — skipping", YELLOW)
        return False

    order_type = mt5.ORDER_TYPE_BUY if signal_type == "BUY" else mt5.ORDER_TYPE_SELL
    tick       = mt5.symbol_info_tick(symbol)
    price      = tick.ask if signal_type == "BUY" else tick.bid
    lots       = get_lot_size(symbol, entry, stop, risk_amount=risk_amount)
    if risk_amount is not None:
        log(f"Sizing from risk-engine budget ${risk_amount:.2f} → {lots} lots", CYAN)

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
        "comment":       build_order_comment(setup, confidence),
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
                "account": ACCOUNT_TAG or "default",
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

    # In semi-auto: act on any BUY/SELL. In auto: whatever minStrength allows.
    #
    # This was hardcoded to STRONG, which is why the self-learning engine never had
    # data: learning needs 5 closed trades per setup before it adjusts anything, and
    # STRONG-only fires roughly once a month. Allowing MODERATE raises that to about
    # one signal every 2.4 days. On a demo account that trade-off is worth making —
    # you cannot learn from a trade you never took.
    if AUTO_MODE:
        allowed = ("STRONG",) if strategy_settings["minStrength"] == "STRONG" else ("STRONG", "MODERATE")
        if strength not in allowed:
            return

    # Halt checks sit HERE, after we know there is a real, actionable, not-yet-taken
    # signal. Checked earlier they fired on every WAIT for every asset every cycle —
    # thousands of log lines a day announcing that nothing was blocked, which buries
    # the one line that matters. Now a halt is logged only when it actually stopped a
    # trade, and the signal is not marked executed, so it can still be taken if the
    # halt is lifted while the setup is live.
    #
    # Remote halt is reported separately from the local circuit breakers so the log
    # always says WHICH one stopped it. Neither touches open positions.
    if remote_halted:
        log(f"Remote halt active: {remote_halt_reason} — NOT opening {direction} on {ticker}.", RED)
        return
    if check_circuit_breaker():
        log(f"Circuit breaker active: {halt_reason} — NOT opening {direction} on {ticker}.", RED)
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

    # Slot and daily-trade caps. Cheapest checks first — both are local counts.
    limits_ok, limits_reason = check_strategy_limits()
    if not limits_ok:
        if last_rejection.get(key) != limits_reason:
            log(f"STRATEGY LIMIT blocked {direction} {symbol}: {limits_reason}", YELLOW)
            last_rejection[key] = limits_reason
        return

    # Portfolio risk gate. Runs BEFORE the AI filter so a trade that breaches the
    # portfolio cap never costs an Anthropic call, and so the cheaper deterministic
    # check is what rejects it.
    #
    # Deliberately does NOT mark the signal executed on rejection: "portfolio at 6%"
    # and "already holding BTCUSD BUY" are temporary states, and the same setup
    # should be tradeable once a position closes. Permanent problems with this
    # signal (bad R:R, confidence too low) simply keep failing harmlessly.
    approved, risk_reason, approved_risk_usd = request_trade_approval(
        symbol, direction, entry, stop, target, sig.get("confidence")
    )
    if not approved:
        if last_rejection.get(key) != risk_reason:
            log(f"RISK ENGINE blocked {direction} {symbol}: {risk_reason}", RED)
            last_rejection[key] = risk_reason
        return
    if last_rejection.pop(key, None):
        log(f"Risk engine now allows {symbol} — {risk_reason}", GREEN)

    # Claude AI approval (only in AUTO mode — in semi-auto the human decides)
    if AUTO_MODE:
        ai_ok = claude_approves_trade(sig, symbol, entry, stop, target)
        if not ai_ok:
            log(f"Trade BLOCKED by Claude AI filter — {ticker}", RED)
            executed_signals[key] = cache_key  # mark so we don't retry same signal
            return

    confirmed = prompt_confirm(sig, symbol)
    if confirmed:
        ok = place_order(symbol, direction, entry, stop, target, risk_amount=approved_risk_usd,
                         setup=sig.get("setup"), confidence=sig.get("confidence"))
        if ok:
            executed_signals[key] = cache_key
            global trades_opened_today
            trades_opened_today += 1
            log(f"Trades opened today: {trades_opened_today}/{strategy_settings.get('maxTradesPerDay', 5)}", CYAN)
    else:
        log(f"Trade on {symbol} skipped by user", YELLOW)
        executed_signals[key] = cache_key  # mark so we don't prompt again this signal


def report_risk_status():
    """Push this bridge's risk state and the limits it actually enforces, every cycle.

    This used to be sent only when a trade CLOSED, so on an account with no closed
    trades the dashboard never learned the real limits and the circuit-breaker cards
    had nothing to show. The limits are the whole point of the panel: they need to be
    visible before the first trade, not after it.
    """
    try:
        requests.post(f"{SERVER_URL}/api/risk-status", json={
            "dailyPnl": round(daily_pnl, 2),
            "consecutiveLosses": consecutive_losses,
            "halted": trading_halted or remote_halted,
            "haltReason": halt_reason or remote_halt_reason,
            "account": ACCOUNT_TAG or "default",
            "config": {
                "riskPercent":     RISK_PERCENT,
                "dailyLossPct":    daily_loss_limit,
                "maxConsecLosses": MAX_CONSECUTIVE_LOSSES,
                "maxSpreadPts":    MAX_SPREAD_PTS,
                "autoMode":        AUTO_MODE,
                "expectedLogin":   EXPECTED_LOGIN or None,
                "remoteHalted":    remote_halted,
            },
        }, timeout=3)
    except Exception:
        # Reporting is telemetry, never a reason to interrupt trading.
        pass


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
        requests.post(f"{SERVER_URL}/api/mt5/positions", json={"positions": data, "account": ACCOUNT_TAG or "default"}, timeout=5)
    except Exception:
        pass


def print_status(signals):
    now   = datetime.now().strftime("%H:%M:%S")
    parts = []
    for k, label in [("btc", "BTC"), ("gold", "Gold"), ("spx", "SP500")]:
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


def process_all_signals(data):
    """Process every tradable asset's signal in parallel threads."""
    # max(1, ...) so emptying TRADABLE_KEYS gates all trading rather than raising
    # ValueError out of ThreadPoolExecutor on every poll.
    with ThreadPoolExecutor(max_workers=max(1, len(TRADABLE_KEYS))) as executor:
        futures = {executor.submit(process_signal, key, data.get(key)): key
                   for key in TRADABLE_KEYS}
        for future in futures:
            try:
                future.result(timeout=30)
            except Exception as e:
                log(f"Signal processing error ({futures[future]}): {e}", RED)


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
                "account":    ACCOUNT_TAG or "default",
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
                "haltReason": halt_reason,
                "account": ACCOUNT_TAG or "default",
                # The real limits this bridge is running with. The Auto Trade page
                # used to hardcode these numbers in HTML, so changing the env vars
                # left the dashboard confidently displaying the old ones.
                "config": {
                    "riskPercent":      RISK_PERCENT,
                    "dailyLossPct":     daily_loss_limit,
                    "maxConsecLosses":  MAX_CONSECUTIVE_LOSSES,
                    "maxSpreadPts":     MAX_SPREAD_PTS,
                    "autoMode":         AUTO_MODE,
                    "expectedLogin":    EXPECTED_LOGIN or None,
                },
            }, timeout=3)
        except Exception:
            pass

        position_initial_r.pop(ticket, None)

    known_positions = current_tickets


# ── Main loop ─────────────────────────────────────────────────────────────────

def main():
    print(f"\n{CYAN}{BOLD}SmartEntry MT5 Bridge v1{RESET}")
    print(f"Mode: {'AUTO (min strength: ' + strategy_settings['minStrength'] + ')' if AUTO_MODE else 'SEMI-AUTO (confirm each trade)'}")
    print(f"Risk per trade: {RISK_PERCENT}%  |  Max spread: {MAX_SPREAD_PTS} pts")
    print(f"Server: {SERVER_URL}")
    print(f"Poll interval: {POLL_INTERVAL}s")
    if ACCOUNT_TAG:
        print(f"Account tag: {ACCOUNT_TAG}")
    print(f"Terminal: {TERMINAL_PATH or '(auto-detect — unsafe with more than one MT5 terminal running)'}\n")

    # On a cold boot (auto-logon just fired, terminal launched seconds ago), MT5 can take
    # longer to become IPC-ready than a warm restart — a single failed attempt used to kill
    # the whole bridge permanently, with nothing (not even the watchdog) able to bring it
    # back, since "never connected yet" is deliberately not treated as a failure state.
    CONNECT_RETRIES = 6
    CONNECT_RETRY_DELAY_S = 15
    connected = False
    for attempt in range(1, CONNECT_RETRIES + 1):
        if connect_mt5():
            connected = True
            break
        if attempt < CONNECT_RETRIES:
            log(f"Connect attempt {attempt}/{CONNECT_RETRIES} failed — retrying in {CONNECT_RETRY_DELAY_S}s (MT5 may still be starting up)…", YELLOW)
            time.sleep(CONNECT_RETRY_DELAY_S)

    if not connected:
        log(f"Could not connect after {CONNECT_RETRIES} attempts — giving up.", RED)
        sys.exit(1)

    log("Bridge started — watching for signals…", GREEN)

    # Push once before the first signal fetch so the server's very first refresh
    # already has MT5 bars rather than spending a cycle on the Yahoo fallback.
    push_candles(force=True)

    while True:
        try:
            # Read the kill switch BEFORE looking at signals, so a halt takes effect
            # on the very next cycle rather than one cycle late. Existing positions
            # are still managed below either way — a halt stops new entries, it does
            # not abandon open trades.
            check_remote_control()
            refresh_strategy_settings()
            # Before fetching signals, so the bars the server is about to compute
            # from are the freshest this bridge has seen.
            push_candles()
            data = fetch_signals()
            if data:
                print_status(data)
                process_all_signals(data)
            report_positions()
            report_risk_status()
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
