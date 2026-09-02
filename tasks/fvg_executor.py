"""FVG CONTINUATION EXECUTOR -- turns the validated model into real orders.

The model has been measured to death: disp 1.0 / 8R / retest 80, +0.6655 net R per trade
after the measured broker spread, 5 folds of 5 on XAUUSD, BTCUSD and SP500, better in the
last 90 days than over the full window, and only 4% of its gross R in the top five rows.
tasks/fvg_runner.cjs finds those setups live and writes them to tasks/fvg_shadow.jsonl.
Nothing turned them into trades. This does.

WHY A SEPARATE PROCESS AND A SEPARATE MAGIC NUMBER
mt5_bridge.py executes the engine's own signals under magic 20250101. This runs under its
own magic so every order it places is attributable, so the engine's position accounting is
untouched, and so it can be stopped without touching the bridge. It never reads or writes
the engine's signal path, its settings, or its journal.

THE GUARDS, ALL OF WHICH REFUSE BY DEFAULT
  --execute required   dry run otherwise. Nothing is placed by simply running this.
  freshness            a setup older than one execution bar is DEAD. The model enters on
                       the retest bar; by the next bar the price it wanted is gone, and
                       filling late is a different trade from the one measured.
  halt respected       reads /api/risk-status. If the circuit breaker is open for the
                       account, nothing is placed -- the breaker exists because three
                       consecutive losses happened.
  own position cap     at most MAX_OPEN positions under this magic, and never two on the
                       same symbol. Concurrency was never modelled in the backtest, so it
                       is bounded here rather than assumed away.
  spread sanity        the stop must be at least 3x the current spread, the same rule the
                       measurement applies. A stop inside the spread is not a trade.
  broker-side SL/TP    every order carries its stop and target with it, so a crash or a
                       restart cannot leave a position unprotected.

  python tasks/fvg_executor.py                 dry run, prints what it would do
  python tasks/fvg_executor.py --execute       places orders

Reads:  tasks/fvg_shadow.jsonl (append-only, written by the runner)
Writes: tasks/fvg_executed.jsonl (append-only) -- never modifies the shadow ledger, so the
        measurement record and the execution record cannot corrupt each other.
"""

import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone

try:
    import MetaTrader5 as mt5
except ImportError:
    print("MetaTrader5 package not installed. Run: pip install MetaTrader5")
    sys.exit(1)

ROOT       = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# One executor, either model. --model picks the ledger and the magic number, so the two
# strategies keep separate order attribution and separate execution records while sharing
# one guarded code path -- two copies of order-placing code is two places for a guard to
# go missing.
MODELS = {
    # max_age is ONE BAR OF THE MODEL'S OWN EXECUTION TIMEFRAME. FVG enters on a 15-minute
    # retest, so a setup is dead in 15 minutes. TK enters on a closed 4-hour bar and stays
    # valid for that bar. A shared 900s window would silently discard every TK setup 15
    # minutes after it appeared -- a guard that throws away the trades it is meant to
    # protect is worse than no guard.
    "fvg": {"shadow": "fvg_shadow.jsonl", "executed": "fvg_executed.jsonl",
            "magic": 20260902, "label": "FVG_CONTINUATION", "max_age": 900},
    "tk":  {"shadow": "tk_shadow.jsonl",  "executed": "tk_executed.jsonl",
            "magic": 20260903, "label": "TK_SWING_PULLBACK", "max_age": 14400},
}
_model_key = "tk" if "--model" in sys.argv and sys.argv[sys.argv.index("--model") + 1] == "tk" else "fvg"
_M = MODELS[_model_key]
SHADOW     = os.path.join(ROOT, "tasks", _M["shadow"])
EXECUTED   = os.path.join(ROOT, "tasks", _M["executed"])
SERVER     = os.environ.get("SMARTENTRY_HOST", "http://localhost:3001")

MAGIC      = _M["magic"]       # this model's own orders, never the engine's 20250101
MAX_OPEN   = int(os.environ.get("FVG_MAX_OPEN", "2"))
RISK_PCT   = float(os.environ.get("FVG_RISK_PCT", "0.15"))   # % of equity per trade
MAX_AGE_S  = int(os.environ.get("FVG_MAX_AGE_S", str(_M["max_age"])))  # one bar of this model
MIN_STOP_SPREADS = 3.0

EXECUTE = "--execute" in sys.argv
VERBOSE = "--verbose" in sys.argv

ASSET_SYMBOL = {"gold": "XAUUSD", "btc": "BTCUSD", "spx": "SP500"}


def log(msg):
    print("[" + _model_key + "-exec] " + msg, flush=True)


def read_jsonl(path):
    if not os.path.exists(path):
        return []
    rows = []
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                # Reported, never silently dropped: a ledger that quietly loses a row is
                # the failure this project keeps finding.
                log("corrupt row skipped: " + line[:80])
    return rows


def server_json(path):
    try:
        with urllib.request.urlopen(SERVER + path, timeout=6) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception as e:
        return {"_error": str(e)}


def trading_halted(account_key="A"):
    """True when the breaker is open, and TRUE ALSO when the server cannot be reached.

    Refusing on an unknown state is the only safe default: the breaker is what stops a
    losing streak, and 'I could not check' is not 'it is fine'.
    """
    st = server_json("/api/risk-status")
    if "_error" in st:
        log("cannot read risk-status (" + st["_error"] + ") -- refusing to trade on an unknown halt state")
        return True
    if st.get("halted"):
        return True
    acct = (st.get("accounts") or {}).get(account_key) or {}
    return bool(acct.get("halted"))


def main():
    setups = read_jsonl(SHADOW)
    done_keys = {r.get("key") for r in read_jsonl(EXECUTED)}
    now = time.time()

    fresh = []
    for s in setups:
        if s.get("key") in done_keys:
            continue
        seen = s.get("seenAt")
        if not seen:
            continue
        try:
            age = now - datetime.fromisoformat(seen.replace("Z", "+00:00")).timestamp()
        except ValueError:
            continue
        if age > MAX_AGE_S:
            if VERBOSE:
                log("stale by %.0fs, skipping %s %s" % (age, s.get("symbol"), s.get("direction")))
            continue
        fresh.append(s)

    if not fresh:
        log("no fresh setups (%d in ledger, %d already executed)" % (len(setups), len(done_keys)))
        return 0

    if trading_halted():
        log("TRADING HALTED -- %d fresh setup(s) not placed" % len(fresh))
        return 0

    if not mt5.initialize():
        log("MT5 initialize failed: %s" % (mt5.last_error(),))
        return 1
    try:
        positions = mt5.positions_get() or []
        mine = [p for p in positions if p.magic == MAGIC]
        held_symbols = {p.symbol for p in mine}
        log("%d open under magic %d, %d fresh setup(s)" % (len(mine), MAGIC, len(fresh)))

        account = mt5.account_info()
        equity = account.equity if account else None

        for s in fresh:
            symbol = s.get("symbol") or ASSET_SYMBOL.get(s.get("asset"))
            direction = s.get("direction")
            entry, stop, target = s.get("entry"), s.get("stop"), s.get("target")
            tag = "%s %s" % (symbol, direction)

            if len(mine) >= MAX_OPEN:
                log("SKIP %s -- already at MAX_OPEN=%d for this model" % (tag, MAX_OPEN))
                continue
            if symbol in held_symbols:
                log("SKIP %s -- this model already holds %s" % (tag, symbol))
                continue
            if not mt5.symbol_select(symbol, True):
                log("SKIP %s -- symbol not available" % tag)
                continue

            info = mt5.symbol_info(symbol)
            tick = mt5.symbol_info_tick(symbol)
            if not info or not tick or not tick.bid or not tick.ask:
                log("SKIP %s -- no live quote" % tag)
                continue

            spread = tick.ask - tick.bid
            risk_dist = abs(entry - stop)
            if spread > 0 and risk_dist < MIN_STOP_SPREADS * spread:
                log("SKIP %s -- stop %.5f is under %gx the spread %.5f"
                    % (tag, risk_dist, MIN_STOP_SPREADS, spread))
                continue

            is_buy = direction == "BUY"
            price = tick.ask if is_buy else tick.bid
            # The model enters at the FVG edge. If price has already run past the stop
            # side, the setup is gone -- filling here is a worse trade than the one
            # measured, not the same one late.
            if (is_buy and price <= stop) or (not is_buy and price >= stop):
                log("SKIP %s -- price %.5f is already through the stop %.5f" % (tag, price, stop))
                continue

            lots = None
            if equity and risk_dist > 0:
                tick_value = info.trade_tick_value or 0
                tick_size = info.trade_tick_size or 0
                if tick_value > 0 and tick_size > 0:
                    value_per_unit = (risk_dist / tick_size) * tick_value
                    if value_per_unit > 0:
                        lots = (equity * RISK_PCT / 100.0) / value_per_unit
            if lots is None:
                log("SKIP %s -- cannot size the position from this symbol's tick data" % tag)
                continue
            step = info.volume_step or 0.01
            lots = max(info.volume_min, min(info.volume_max, round(lots / step) * step))
            lots = round(lots, 2)

            plan = ("%s %.2f lots @ %.5f  SL %.5f  TP %.5f  risk %.2f%%"
                    % (tag, lots, price, stop, target, RISK_PCT))
            if not EXECUTE:
                log("DRY RUN would place: " + plan)
                continue

            request = {
                "action":       mt5.TRADE_ACTION_DEAL,
                "symbol":       symbol,
                "volume":       lots,
                "type":         mt5.ORDER_TYPE_BUY if is_buy else mt5.ORDER_TYPE_SELL,
                "price":        price,
                "sl":           float(stop),
                "tp":           float(target),
                "deviation":    20,
                "magic":        MAGIC,
                "comment":      _M["label"][:16],
                "type_time":    mt5.ORDER_TIME_GTC,
                "type_filling": mt5.ORDER_FILLING_IOC,
            }
            result = mt5.order_send(request)
            ok = result is not None and result.retcode == mt5.TRADE_RETCODE_DONE
            log(("PLACED " if ok else "REJECTED ") + plan
                + ("  ticket %s" % result.order if ok else "  retcode %s" % (result.retcode if result else "none")))

            # Recorded either way. A rejected order that leaves no trace is how the same
            # setup gets retried forever.
            with open(EXECUTED, "a", encoding="utf-8") as fh:
                fh.write(json.dumps({
                    "key": s.get("key"), "at": datetime.now(timezone.utc).isoformat(),
                    "symbol": symbol, "direction": direction, "lots": lots,
                    "price": price, "sl": stop, "tp": target, "magic": MAGIC,
                    "placed": ok,
                    "retcode": (result.retcode if result else None),
                    "ticket": (result.order if ok else None),
                    "model": _M["label"],
                }) + "\n")
            if ok:
                mine.append(type("P", (), {"symbol": symbol, "magic": MAGIC})())
                held_symbols.add(symbol)
    finally:
        mt5.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
