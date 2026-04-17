"""
MT5 Bridge - Python Flask API for MetaTrader 5 integration.
Run this on a Windows machine with MT5 terminal installed and running.
Usage: python mt5_bridge.py
"""

import threading
import time
import datetime

try:
    import MetaTrader5 as mt5
    MT5_AVAILABLE = True
except ImportError:
    MT5_AVAILABLE = False
    print("WARNING: MetaTrader5 package not found. Install with: pip install MetaTrader5")

from flask import Flask, jsonify, request
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

_connected = False

auto_trade_state = {
    "enabled": False,
    "symbol": "EURUSD",
    "lot": 0.01,
    "sl_pips": 50,
    "tp_pips": 100,
    "max_trades": 3,
    "strategy": "ma_crossover",
    "last_signal": None,
    "trades_today": 0,
}
_trade_thread = None


# ── helpers ──────────────────────────────────────────────────────────────────

def _ensure_connected():
    if not MT5_AVAILABLE:
        return False, "MetaTrader5 package not installed"
    if not _connected:
        return False, "Not connected to MT5"
    return True, None


def _account_dict(a):
    return {
        "login": a.login,
        "name": a.name,
        "server": a.server,
        "balance": round(a.balance, 2),
        "equity": round(a.equity, 2),
        "margin": round(a.margin, 2),
        "free_margin": round(a.margin_free, 2),
        "profit": round(a.profit, 2),
        "currency": a.currency,
        "leverage": a.leverage,
    }


def _position_dict(p):
    return {
        "ticket": p.ticket,
        "symbol": p.symbol,
        "type": "BUY" if p.type == 0 else "SELL",
        "volume": p.volume,
        "open_price": p.price_open,
        "current_price": p.price_current,
        "sl": p.sl,
        "tp": p.tp,
        "profit": round(p.profit, 2),
        "time": p.time,
        "comment": p.comment,
    }


# ── auto trading ──────────────────────────────────────────────────────────────

def _ma_crossover_signal(symbol):
    """Returns 'BUY', 'SELL', or None based on MA20/MA50 crossover on M15."""
    rates = mt5.copy_rates_from_pos(symbol, mt5.TIMEFRAME_M15, 0, 52)
    if rates is None or len(rates) < 52:
        return None
    closes = [r["close"] for r in rates]
    ma20 = sum(closes[-20:]) / 20
    ma50 = sum(closes[-50:]) / 50
    # Require 0.02% separation to avoid noise
    if ma20 > ma50 * 1.0002:
        return "BUY"
    if ma20 < ma50 * 0.9998:
        return "SELL"
    return None


def _rsi_signal(symbol, period=14):
    """Returns 'BUY' (oversold <30), 'SELL' (overbought >70), or None."""
    rates = mt5.copy_rates_from_pos(symbol, mt5.TIMEFRAME_H1, 0, period + 2)
    if rates is None or len(rates) < period + 1:
        return None
    closes = [r["close"] for r in rates]
    gains, losses = [], []
    for i in range(1, len(closes)):
        diff = closes[i] - closes[i - 1]
        gains.append(max(diff, 0))
        losses.append(max(-diff, 0))
    avg_gain = sum(gains[-period:]) / period
    avg_loss = sum(losses[-period:]) / period
    if avg_loss == 0:
        return None
    rs = avg_gain / avg_loss
    rsi = 100 - (100 / (1 + rs))
    if rsi < 30:
        return "BUY"
    if rsi > 70:
        return "SELL"
    return None


def _send_market_order(symbol, action, lot, sl_pips, tp_pips, comment="AI Trade"):
    sym = mt5.symbol_info(symbol)
    if not sym:
        return None, f"Symbol {symbol} not found"
    if not sym.visible:
        mt5.symbol_select(symbol, True)
        time.sleep(0.1)
        sym = mt5.symbol_info(symbol)

    tick = mt5.symbol_info_tick(symbol)
    if not tick:
        return None, "Cannot get tick"

    point = sym.point
    if action == "BUY":
        order_type = mt5.ORDER_TYPE_BUY
        price = tick.ask
        sl = price - sl_pips * point if sl_pips else 0.0
        tp = price + tp_pips * point if tp_pips else 0.0
    else:
        order_type = mt5.ORDER_TYPE_SELL
        price = tick.bid
        sl = price + sl_pips * point if sl_pips else 0.0
        tp = price - tp_pips * point if tp_pips else 0.0

    req = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": symbol,
        "volume": float(lot),
        "type": order_type,
        "price": price,
        "sl": sl,
        "tp": tp,
        "deviation": 20,
        "magic": 234001,
        "comment": comment,
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    }
    result = mt5.order_send(req)
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        return None, f"Order failed ({result.retcode}): {result.comment}"
    return result.order, None


def _auto_trading_loop():
    while auto_trade_state["enabled"]:
        try:
            symbol = auto_trade_state["symbol"]
            strategy = auto_trade_state["strategy"]
            positions = mt5.positions_get(symbol=symbol) or []

            if len(positions) < auto_trade_state["max_trades"]:
                if strategy == "ma_crossover":
                    signal = _ma_crossover_signal(symbol)
                elif strategy == "rsi":
                    signal = _rsi_signal(symbol)
                else:
                    signal = None

                if signal and signal != auto_trade_state["last_signal"]:
                    ticket, err = _send_market_order(
                        symbol,
                        signal,
                        auto_trade_state["lot"],
                        auto_trade_state["sl_pips"],
                        auto_trade_state["tp_pips"],
                        comment="AutoTrade AI",
                    )
                    if ticket:
                        auto_trade_state["last_signal"] = signal
                        auto_trade_state["trades_today"] += 1
                        print(f"[AutoTrade] {signal} {symbol} ticket={ticket}")
                    else:
                        print(f"[AutoTrade] Error: {err}")
        except Exception as exc:
            print(f"[AutoTrade] Exception: {exc}")

        time.sleep(30)


# ── routes ───────────────────────────────────────────────────────────────────

@app.route("/api/connect", methods=["POST"])
def connect():
    global _connected

    if not MT5_AVAILABLE:
        return jsonify({"success": False, "error": "MetaTrader5 package not installed. Run: pip install MetaTrader5"}), 500

    if not mt5.initialize():
        return jsonify({"success": False, "error": f"MT5 init failed: {mt5.last_error()}. Make sure MT5 terminal is running."}), 500

    data = request.json or {}
    login = data.get("login")
    password = data.get("password")
    server = data.get("server")

    if login and password and server:
        ok = mt5.login(int(login), password=str(password), server=str(server))
        if not ok:
            return jsonify({"success": False, "error": f"Login failed: {mt5.last_error()}"}), 401

    account = mt5.account_info()
    if not account:
        return jsonify({"success": False, "error": "Not logged in to MT5. Provide login/password/server or open MT5 terminal first."}), 401

    _connected = True
    return jsonify({"success": True, "account": _account_dict(account)})


@app.route("/api/disconnect", methods=["POST"])
def disconnect():
    global _connected
    auto_trade_state["enabled"] = False
    _connected = False
    if MT5_AVAILABLE:
        mt5.shutdown()
    return jsonify({"success": True})


@app.route("/api/account", methods=["GET"])
def account():
    ok, err = _ensure_connected()
    if not ok:
        return jsonify({"error": err}), 503
    a = mt5.account_info()
    if not a:
        return jsonify({"error": "Cannot get account info"}), 503
    return jsonify(_account_dict(a))


@app.route("/api/positions", methods=["GET"])
def positions():
    ok, err = _ensure_connected()
    if not ok:
        return jsonify([])
    pos = mt5.positions_get() or []
    return jsonify([_position_dict(p) for p in pos])


@app.route("/api/prices", methods=["GET"])
def prices():
    ok, _ = _ensure_connected()
    if not ok:
        return jsonify({})
    symbols = request.args.get("symbols", "EURUSD,GBPUSD,USDJPY,XAUUSD,BTCUSD").split(",")
    result = {}
    for sym in symbols:
        sym = sym.strip()
        tick = mt5.symbol_info_tick(sym)
        if tick:
            result[sym] = {"bid": tick.bid, "ask": tick.ask, "time": tick.time}
    return jsonify(result)


@app.route("/api/trade", methods=["POST"])
def trade():
    ok, err = _ensure_connected()
    if not ok:
        return jsonify({"success": False, "error": err}), 503

    data = request.json or {}
    symbol = data.get("symbol", "EURUSD")
    action = data.get("action", "BUY").upper()
    lot = float(data.get("lot", 0.01))
    sl_pips = float(data.get("sl_pips", 50))
    tp_pips = float(data.get("tp_pips", 100))

    ticket, err = _send_market_order(symbol, action, lot, sl_pips, tp_pips, comment="Manual AI Dashboard")
    if err:
        return jsonify({"success": False, "error": err}), 400
    return jsonify({"success": True, "ticket": ticket})


@app.route("/api/close", methods=["POST"])
def close_position():
    ok, err = _ensure_connected()
    if not ok:
        return jsonify({"success": False, "error": err}), 503

    ticket = int((request.json or {}).get("ticket", 0))
    pos_list = mt5.positions_get(ticket=ticket)
    if not pos_list:
        return jsonify({"success": False, "error": "Position not found"}), 404

    p = pos_list[0]
    tick = mt5.symbol_info_tick(p.symbol)
    if not tick:
        return jsonify({"success": False, "error": "Cannot get tick"}), 400

    if p.type == mt5.ORDER_TYPE_BUY:
        order_type = mt5.ORDER_TYPE_SELL
        price = tick.bid
    else:
        order_type = mt5.ORDER_TYPE_BUY
        price = tick.ask

    req = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": p.symbol,
        "volume": p.volume,
        "type": order_type,
        "position": ticket,
        "price": price,
        "deviation": 20,
        "magic": 234001,
        "comment": "Close by AI Dashboard",
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    }
    result = mt5.order_send(req)
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        return jsonify({"success": False, "error": f"Close failed ({result.retcode}): {result.comment}"}), 400
    return jsonify({"success": True})


@app.route("/api/autotrade", methods=["GET", "POST"])
def autotrade():
    global _trade_thread

    ok, err = _ensure_connected()
    if not ok and request.method == "POST":
        return jsonify({"success": False, "error": err}), 503

    if request.method == "GET":
        return jsonify(auto_trade_state)

    data = request.json or {}
    auto_trade_state.update({k: v for k, v in data.items() if k in auto_trade_state})

    if auto_trade_state["enabled"]:
        if _trade_thread is None or not _trade_thread.is_alive():
            _trade_thread = threading.Thread(target=_auto_trading_loop, daemon=True)
            _trade_thread.start()
            print("[AutoTrade] Started")
    else:
        print("[AutoTrade] Stopped")

    return jsonify(auto_trade_state)


@app.route("/api/history", methods=["GET"])
def history():
    ok, _ = _ensure_connected()
    if not ok:
        return jsonify([])

    days = int(request.args.get("days", 7))
    from_dt = datetime.datetime.now() - datetime.timedelta(days=days)
    to_dt = datetime.datetime.now()

    deals = mt5.history_deals_get(from_dt, to_dt) or []
    result = []
    for d in deals:
        if d.symbol:  # skip balance/deposit entries
            result.append({
                "ticket": d.ticket,
                "symbol": d.symbol,
                "type": "BUY" if d.type == 0 else "SELL",
                "volume": d.volume,
                "price": d.price,
                "profit": round(d.profit, 2),
                "time": d.time,
                "comment": d.comment,
            })
    return jsonify(result[-100:])


@app.route("/api/status", methods=["GET"])
def status():
    if not MT5_AVAILABLE or not _connected:
        return jsonify({"connected": False})
    a = mt5.account_info()
    if not a:
        return jsonify({"connected": False})
    return jsonify({
        "connected": True,
        "login": a.login,
        "balance": round(a.balance, 2),
        "equity": round(a.equity, 2),
        "server": a.server,
    })


@app.route("/api/symbols", methods=["GET"])
def symbols():
    ok, _ = _ensure_connected()
    if not ok:
        return jsonify([])
    all_syms = mt5.symbols_get() or []
    # Return common ones first
    common = ["EURUSD", "GBPUSD", "USDJPY", "USDCHF", "AUDUSD", "USDCAD",
              "NZDUSD", "XAUUSD", "XAGUSD", "BTCUSD", "ETHUSD",
              "US30", "NAS100", "SPX500"]
    available = {s.name for s in all_syms}
    ordered = [s for s in common if s in available]
    others = sorted(s.name for s in all_syms if s.name not in set(common) and s.visible)
    return jsonify(ordered + others[:50])


if __name__ == "__main__":
    print("=" * 50)
    print("  AI Trading Dashboard — MT5 Bridge")
    print("=" * 50)
    if not MT5_AVAILABLE:
        print("  ERROR: MetaTrader5 not installed")
        print("  Run: pip install MetaTrader5 flask flask-cors")
    else:
        print(f"  MT5 package found")
        if mt5.initialize():
            a = mt5.account_info()
            if a:
                print(f"  Auto-connected: {a.name} @ {a.server}")
                _connected = True
            else:
                print("  MT5 running but not logged in — use /api/connect")
        else:
            print("  MT5 terminal not running — start it then use /api/connect")
    print(f"  API listening on http://localhost:5000")
    print("=" * 50)
    app.run(host="0.0.0.0", port=5000, debug=False, use_reloader=False)
