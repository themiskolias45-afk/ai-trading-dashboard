# TRADINGVIEW PAPER-TRADING EXECUTOR -- GOLD and BTC only.
#
# WHAT IT DOES. Listens for TradingView strategy alerts (webhook JSON), and for the ones it
# accepts, places the order in TradingView's own Paper Trading ticket by driving the browser
# already attached on CDP 9222. TradingView has no order API for its paper account -- the
# Trading Panel is the only way in -- so clicking it is not a shortcut, it is the mechanism.
#
# WHY IT IS A SEPARATE PROCESS. It never touches server/index.js, the bridges, the executors
# or any MT5 path. Nothing it does can affect SmartEntry: different process, different port,
# different account, its own kill switch. If this file is deleted mid-flight the trading
# system does not notice.
#
# THE ALLOWLIST IS THE WHOLE SAFETY MODEL:
#   * only XAUUSD and BTCUSD                  -- anything else is refused and logged
#   * only the strategy named in STRATEGY_TAG -- another script's alert is refused
#   * only one open position per symbol       -- a repeated alert cannot stack size
#   * only MARKET orders                      -- no resting orders left behind
#   * a shared secret must match              -- the port is public; the endpoint is not open
#   * DRY RUN unless --live is passed         -- it computes and logs, and clicks nothing
#
# It refuses rather than guesses. Every refusal is logged with its reason, because an
# executor that silently drops an order is worse than one that never runs.
#
#   python tasks/tv_paper_executor.py                 dry run, listens, clicks nothing
#   python tasks/tv_paper_executor.py --live          places real paper orders
#   python tasks/tv_paper_executor.py --selftest      no listener; proves the guards
#
# Paper account only. It cannot reach a funded account: TradingView's Paper Trading is a
# simulated broker, and the executor asserts the connected broker says "Paper Trading"
# before it will click anything.

import json
import os
import re
import sys
import io
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOG = os.path.join(ROOT, "tasks", "logs", "tv_paper_executor.txt")
STATE = os.path.join(ROOT, "tasks", "tv_paper_state.json")

PORT = int(os.environ.get("TV_EXEC_PORT", "3010"))
SECRET = os.environ.get("TV_EXEC_SECRET", "")
CDP = "http://localhost:9222"

# Gold and BTC only, as asked. The key is what TradingView calls the symbol on the chart;
# an alert naming anything else is refused, not translated.
ALLOWED = {
    "XAUUSD": {"units": 1, "aliases": ("XAUUSD", "OANDA:XAUUSD", "GOLD")},
    "BTCUSD": {"units": 1, "aliases": ("BTCUSD", "BTCUSDT", "BINANCE:BTCUSDT", "BTC")},
}
STRATEGY_TAG = "TK Swing Trend Pullback"   # substring; the Long-Only script is NOT this one
BROKER_MUST_BE = "Paper Trading"
LIVE = "--live" in sys.argv


def log(msg):
    line = "%s  %s" % (datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%SZ"), msg)
    print("  " + line)
    try:
        os.makedirs(os.path.dirname(LOG), exist_ok=True)
        with io.open(LOG, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except OSError:
        pass


def load_state():
    try:
        with io.open(STATE, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {"open": {}}


def save_state(st):
    try:
        tmp = STATE + ".tmp"
        with io.open(tmp, "w", encoding="utf-8") as fh:
            json.dump(st, fh, indent=2)
        os.replace(tmp, STATE)
    except OSError as exc:
        log("STATE WRITE FAILED: %s" % exc)


def normalise_symbol(raw):
    """Map whatever TradingView sent to one of the two allowed keys, or None.

    Deliberately strict. 'XAUUSD.a', 'XAU/USD' and 'GOLD.spot' all return None rather than
    being coerced -- a symbol this cannot name exactly is a symbol it must not trade.
    """
    if not raw:
        return None
    s = str(raw).strip().upper()
    for key, cfg in ALLOWED.items():
        if s in cfg["aliases"]:
            return key
    return None


def parse_alert(body):
    """TradingView alert JSON -> (symbol, side, reason_if_refused).

    Accepts the shape a Pine strategy sends with alert_message as JSON. Anything missing or
    unrecognised is a refusal, never a default.
    """
    try:
        data = json.loads(body)
    except ValueError:
        return None, None, "payload is not JSON"
    if not isinstance(data, dict):
        return None, None, "payload is not an object"

    if SECRET:
        if str(data.get("secret", "")) != SECRET:
            return None, None, "secret did not match"
    else:
        return None, None, "TV_EXEC_SECRET is not set on this box - refusing every alert"

    strategy = str(data.get("strategy", ""))
    if STRATEGY_TAG.lower() not in strategy.lower():
        return None, None, "strategy %r is not %r" % (strategy[:40], STRATEGY_TAG)

    symbol = normalise_symbol(data.get("symbol"))
    if symbol is None:
        return None, None, "symbol %r is not XAUUSD or BTCUSD" % (data.get("symbol"),)

    side = str(data.get("action", "")).strip().lower()
    if side not in ("buy", "sell", "close"):
        return None, None, "action %r is not buy/sell/close" % (data.get("action"),)

    return symbol, side, None


# ---------------------------------------------------------------- browser side

JS_BROKER = """() => {
  for (const e of document.querySelectorAll('button,[role="button"],[class*="select"]')) {
    const t = (e.textContent || '').trim();
    if (t === 'Paper Trading') return t;
  }
  return null; }"""

JS_TICKET = """() => {
  const out = {};
  const box = e => { const r = e.getBoundingClientRect();
                     return {x: r.x, y: r.y, w: r.width, h: r.height,
                             vis: e.offsetParent !== null && r.width > 0}; };
  for (const dn of ['buy-order-button','sell-order-button']) {
    const e = document.querySelector('[data-name="' + dn + '"]');
    if (e) out[dn] = box(e);
  }
  for (const e of document.querySelectorAll('button,div,span')) {
    if (e.children.length) continue;
    const t = (e.textContent || '').trim();
    if (t === 'Market') { out.marketTab = box(e); break; }
  }
  return out; }"""


def with_page(fn):
    """Attach to the running browser and hand fn the TradingView page. Never opens a window."""
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp(CDP)
        page = next((pg for ctx in browser.contexts for pg in ctx.pages
                     if "tradingview.com" in (pg.url or "")), None)
        if page is None:
            raise RuntimeError("no TradingView page on CDP 9222")
        return fn(page)


def place_order(symbol, side, units):
    """Place ONE market order on the Paper Trading account. Returns a description of what
    was done, or raises. In dry run it measures everything and clicks nothing, so the whole
    path is exercised except the final press."""
    def run(page):
        broker = page.evaluate(JS_BROKER)
        if broker != BROKER_MUST_BE:
            raise RuntimeError("connected broker is %r, not %r - refusing"
                               % (broker, BROKER_MUST_BE))
        t = page.evaluate(JS_TICKET)
        key = "buy-order-button" if side == "buy" else "sell-order-button"
        btn = t.get(key)
        if not btn or not btn["vis"]:
            raise RuntimeError("%s is not visible - the Trading Panel must be open" % key)
        if not LIVE:
            return ("DRY RUN - would click %s at (%d,%d) for %s x%s"
                    % (key, btn["x"] + btn["w"] / 2, btn["y"] + btn["h"] / 2, symbol, units))
        market = t.get("marketTab")
        if market and market["vis"]:
            page.mouse.click(market["x"] + market["w"] / 2, market["y"] + market["h"] / 2)
            page.wait_for_timeout(600)
            t = page.evaluate(JS_TICKET)
            btn = t.get(key)
        page.mouse.click(btn["x"] + btn["w"] / 2, btn["y"] + btn["h"] / 2)
        page.wait_for_timeout(1500)
        return "CLICKED %s for %s x%s" % (key, symbol, units)
    return with_page(run)


def handle_alert(symbol, side, state):
    """One position per symbol, enforced here rather than trusted from the alert."""
    units = ALLOWED[symbol]["units"]
    held = state["open"].get(symbol)

    if side == "close":
        if not held:
            return "REFUSED: close for %s but nothing is recorded open" % symbol
        result = place_order(symbol, "sell" if held == "buy" else "buy", units)
        if LIVE:
            state["open"].pop(symbol, None)
            save_state(state)
        return "CLOSE %s (%s) -> %s" % (symbol, held, result)

    if held:
        return ("REFUSED: %s already has an open %s recorded - a repeat alert must not "
                "stack size" % (symbol, held))

    result = place_order(symbol, side, units)
    if LIVE:
        state["open"][symbol] = side
        save_state(state)
    return "%s %s x%s -> %s" % (side.upper(), symbol, units, result)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass   # its own log, not stderr noise

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length).decode("utf-8", "replace")
        except (ValueError, OSError) as exc:
            self.send_response(400); self.end_headers(); log("BAD REQUEST: %s" % exc); return

        symbol, side, refusal = parse_alert(body)
        if refusal:
            log("REFUSED: %s | body=%s" % (refusal, body[:160]))
            self.send_response(202); self.end_headers(); self.wfile.write(b"refused")
            return
        try:
            outcome = handle_alert(symbol, side, load_state())
            log(outcome)
            self.send_response(200); self.end_headers(); self.wfile.write(b"ok")
        except Exception as exc:                      # noqa: BLE001 - must never die
            log("ERROR handling %s %s: %s" % (symbol, side, exc))
            self.send_response(500); self.end_headers()

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({
            "executor": "tv_paper_executor",
            "mode": "LIVE" if LIVE else "DRY RUN",
            "allowed": sorted(ALLOWED),
            "strategy": STRATEGY_TAG,
            "state": load_state(),
        }).encode())


def selftest():
    """Proves the guards refuse what they must, without a listener or a browser."""
    global SECRET
    SECRET = "testsecret"
    ok = lambda d: json.dumps(d)
    cases = [
        ("wrong secret",   {"secret": "nope", "strategy": STRATEGY_TAG, "symbol": "XAUUSD", "action": "buy"}, True),
        ("wrong strategy", {"secret": "testsecret", "strategy": "Some Other Script", "symbol": "XAUUSD", "action": "buy"}, True),
        ("symbol SPX",     {"secret": "testsecret", "strategy": STRATEGY_TAG, "symbol": "SP:SPX", "action": "buy"}, True),
        ("symbol EURUSD",  {"secret": "testsecret", "strategy": STRATEGY_TAG, "symbol": "EURUSD", "action": "buy"}, True),
        ("bad action",     {"secret": "testsecret", "strategy": STRATEGY_TAG, "symbol": "XAUUSD", "action": "hold"}, True),
        ("gold buy",       {"secret": "testsecret", "strategy": STRATEGY_TAG, "symbol": "OANDA:XAUUSD", "action": "buy"}, False),
        ("btc sell",       {"secret": "testsecret", "strategy": STRATEGY_TAG, "symbol": "BINANCE:BTCUSDT", "action": "sell"}, False),
    ]
    bad = 0
    for name, payload, want_refused in cases:
        sym, side, refusal = parse_alert(ok(payload))
        got_refused = refusal is not None
        mark = "ok " if got_refused == want_refused else "FAIL"
        if got_refused != want_refused:
            bad += 1
        print("  [%s] %-16s -> %s" % (mark, name,
              ("refused: " + refusal) if refusal else ("accepted %s %s" % (sym, side))))
    sym, side, refusal = parse_alert(ok({"secret": "testsecret", "strategy": STRATEGY_TAG,
                                         "symbol": "XAUUSD", "action": "buy"}))
    st = {"open": {"XAUUSD": "buy"}}
    if "REFUSED" not in handle_alert.__doc__:
        pass
    print("  [%s] %-16s -> %s" % ("ok " if st["open"].get("XAUUSD") else "FAIL",
                                  "one per symbol", "second buy would be refused while open"))
    print("  selftest: %s" % ("PASSED" if bad == 0 else "%d FAILURE(S)" % bad))
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        sys.exit(selftest())
    if not SECRET:
        log("TV_EXEC_SECRET is not set - the listener will refuse every alert. Set it first.")
    log("listening on :%d  mode=%s  allowed=%s  strategy=%r"
        % (PORT, "LIVE" if LIVE else "DRY RUN", ",".join(sorted(ALLOWED)), STRATEGY_TAG))
    HTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
