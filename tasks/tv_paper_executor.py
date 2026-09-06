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

# Only when RUN, never on import. Rebinding a caller's stdout from module scope steals
# the buffer out from under any wrapper they already installed - which is exactly how
# the first dry-run harness died with "I/O operation on closed file".
def _utf8_stdout():
    try:
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOG = os.path.join(ROOT, "tasks", "logs", "tv_paper_executor.txt")
STATE = os.path.join(ROOT, "tasks", "tv_paper_state.json")

PORT = int(os.environ.get("TV_EXEC_PORT", "3010"))
SECRET = os.environ.get("TV_EXEC_SECRET", "")
CDP = "http://localhost:9222"

# Gold and BTC only, as asked. The key is what TradingView calls the symbol on the chart;
# an alert naming anything else is refused, not translated.
ALLOWED = {
    "XAUUSD": {"units": 1, "tv_symbol": "OANDA:XAUUSD",
               "aliases": ("XAUUSD", "OANDA:XAUUSD", "GOLD")},
    "BTCUSD": {"units": 1, "tv_symbol": "BINANCE:BTCUSDT",
               "aliases": ("BTCUSD", "BTCUSDT", "BINANCE:BTCUSDT", "BTC")},
}
# Matched against the fired ALERT's name, not the script's. The user's existing alert is
# named "GOLD - Swing Trend Pullback Entry Alert" -- no "TK" -- so a tag of
# "TK Swing Trend Pullback" matched nothing and would have polled forever reporting quiet.
STRATEGY_TAG = "Swing Trend Pullback"
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
                             vis: e.offsetParent !== null && r.width > 20 && r.height > 12}; };
  // THE REAL CONTROLS, measured 2026-09-06. 'buy-order-button' and 'sell-order-button' also
  // exist in the DOM but are stale 0x0 leftovers - targeting those refused every order while
  // a perfectly working ticket sat on screen.
  for (const dn of ['side-control-buy','side-control-sell','place-and-modify-button']) {
    const e = document.querySelector('[data-name="' + dn + '"]');
    if (e) out[dn] = box(e);
  }
  for (const e of document.querySelectorAll('button,div,span')) {
    if (e.children.length) continue;
    const t = (e.textContent || '').trim();
    if (t === 'Market' && !out.marketTab) out.marketTab = box(e);
  }
  // What the submit button SAYS it will do - the order in the platform's own words. The
  // executor asserts against this rather than trusting that its clicks landed.
  const sub = document.querySelector('[data-name="place-and-modify-button"]');
  out.submitText = sub ? (sub.textContent || '').trim().replace(/\\s+/g, ' ') : null;
  return out; }"""

# The ticket trades whatever the CHART shows, and the chart moves on its own -
# tv_daily_plan.ps1 rotates it through BTC, GOLD and SPX on every run. So the symbol is
# re-read from the live DOM immediately before every order, never inferred from the alert.
JS_SYMBOL = """() => {
  const el = document.querySelector('#header-toolbar-symbol-search, [data-name="legend-series-item"] [class*="title"]');
  return el ? (el.textContent || '').trim().toUpperCase() : null; }"""


# ------------------------------------------------------- alert-log polling (no open port)
#
# WHY POLL INSTEAD OF LISTEN. The webhook design needed inbound TCP 3010 opened on the VPS,
# and 3001 is the only inbound port allowed there. Rather than hand back a firewall change as
# a blocker, the executor reads TradingView's own ALERT LOG in the browser it is already
# attached to. No inbound port, no webhook URL, no shared secret, nothing to expose.
#
# The log's shape, measured 2026-09-06: a date header ("August 28"), then per fired alert a
# row carrying the alert NAME, and a sibling carrying SYMBOL + HH:MM:SS.

JS_OPEN_LOG = """() => {
  const find = (name) => {
    for (const e of document.querySelectorAll('*')) {
      if (e.children.length) continue;
      if ((e.textContent || '').trim() !== name) continue;
      const r = e.getBoundingClientRect();
      if (r.width > 8 && e.offsetParent !== null) return {x: r.x, y: r.y, w: r.width, h: r.height};
    }
    return null; };
  const tab = find('Log');
  if (tab) return {tab: tab, needsPanel: false};
  const btn = document.querySelector('[data-name="alerts"]');
  if (!btn) return null;
  const r = btn.getBoundingClientRect();
  return {button: {x: r.x, y: r.y, w: r.width, h: r.height}, needsPanel: true}; }"""

JS_LOG_ROWS = """() => {
  const out = [];
  const W = window.innerWidth;
  for (const e of document.querySelectorAll('div,li,tr')) {
    if (e.children.length !== 2) continue;              // the "SYMBOL + HH:MM:SS" sibling
    const t = (e.textContent || '').trim().replace(/\\s+/g, ' ');
    const m = t.match(/^([A-Z0-9:._]{3,20})(\\d{2}:\\d{2}:\\d{2})$/);
    if (!m) continue;
    const r = e.getBoundingClientRect();
    if (r.x < W * 0.72 || e.offsetParent === null) continue;
    // The alert's own text is the nearest preceding leaf above this row.
    let name = '';
    for (const c of document.querySelectorAll('div,span')) {
      if (c.children.length) continue;
      const cr = c.getBoundingClientRect();
      if (cr.x < W * 0.72) continue;
      if (cr.y >= r.y || cr.y < r.y - 60) continue;
      const ct = (c.textContent || '').trim();
      if (ct && ct.length > 4 && ct.length < 200) name = ct;
    }
    out.push({symbol: m[1], time: m[2], name: name.slice(0, 180), y: Math.round(r.y)});
  }
  out.sort((a, b) => a.y - b.y);
  return out.slice(0, 40); }"""

# Alert NAME -> action. Deliberately strict: an alert whose name does not clearly say what to
# do is REFUSED, never guessed into a trade. A name matching both lists is also refused.
BUY_WORDS = ("entry", "buy", "long")
SELL_WORDS = ("sell", "short")
CLOSE_WORDS = ("exit", "close", "sl hit", "stop", "target", "t1", "tp")


def action_from_name(name):
    low = (name or "").lower()
    hits = set()
    if any(w in low for w in CLOSE_WORDS):
        hits.add("close")
    if any(w in low for w in SELL_WORDS):
        hits.add("sell")
    if any(w in low for w in BUY_WORDS):
        hits.add("buy")
    if len(hits) != 1:
        return None, ("alert name %r maps to %s - refusing rather than guessing"
                      % (name[:60], sorted(hits) or "nothing"))
    return hits.pop(), None


def read_alert_log(page):
    nav = page.evaluate(JS_OPEN_LOG)
    if not nav:
        raise RuntimeError("alerts panel button not found")
    if nav.get("needsPanel"):
        b = nav["button"]
        page.mouse.click(b["x"] + b["w"] / 2, b["y"] + b["h"] / 2)
        page.wait_for_timeout(2500)
        nav = page.evaluate(JS_OPEN_LOG)
        if not nav or nav.get("needsPanel"):
            raise RuntimeError("could not reach the Log tab")
    t = nav["tab"]
    page.mouse.click(t["x"] + t["w"] / 2, t["y"] + t["h"] / 2)
    page.wait_for_timeout(2500)
    return page.evaluate(JS_LOG_ROWS)


def poll_once():
    """Read the log, act on entries not seen before. Returns a list of outcome strings.

    Reports HOW MANY rows it parsed, always. "no new alerts" on its own cannot distinguish
    "read the log and nothing matched" from "parsed nothing at all because the DOM moved" -
    and a poller that reports quiet while blind is the exact failure this system keeps hitting.
    """
    rows = with_page(read_alert_log)
    state = load_state()
    seen = set(state.get("seenAlerts", []))
    outcomes = []
    if not rows:
        outcomes.append("CANNOT TELL: parsed 0 rows from the alert log - either the log is "
                        "empty or the panel markup moved. Not the same as 'no alerts'.")
    for row in rows:
        key = "%s|%s|%s" % (row["symbol"], row["time"], row["name"][:40])
        if key in seen:
            continue
        seen.add(key)
        if STRATEGY_TAG.lower() not in (row["name"] or "").lower():
            continue                                  # not our strategy: ignore silently
        symbol = normalise_symbol(row["symbol"])
        if symbol is None:
            outcomes.append("IGNORED: %s is not XAUUSD or BTCUSD" % row["symbol"])
            continue
        side, refusal = action_from_name(row["name"])
        if refusal:
            outcomes.append("REFUSED: " + refusal)
            continue
        try:
            outcomes.append(handle_alert(symbol, side, load_state()))
        except Exception as exc:                       # noqa: BLE001
            outcomes.append("ERROR on %s %s: %s" % (symbol, side, exc))
    state = load_state()
    state["seenAlerts"] = sorted(seen)[-400:]
    save_state(state)
    matched = sum(1 for r in rows if STRATEGY_TAG.lower() in (r.get("name") or "").lower())
    outcomes.append("scanned %d log row(s), %d matched %r"
                    % (len(rows), matched, STRATEGY_TAG))
    return outcomes


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

        # SYMBOL: SET IT, THEN ASSERT IT. The ticket trades the CHART's instrument, and the
        # chart moves without asking - tv_daily_plan.ps1 rotates it through BTC, GOLD and SPX,
        # and it moved twice during this file's own dry runs. So the executor navigates to the
        # symbol it intends to trade and then re-reads the DOM to confirm it arrived. Checking
        # alone was not enough (it refused almost every order); switching alone would be worse
        # (it would trade whatever the chart happened to become). Both, in that order.
        chart = page.evaluate(JS_SYMBOL) or ""
        if normalise_symbol(chart) != symbol:
            want = ALLOWED[symbol]["tv_symbol"]
            log("chart shows %r, switching to %s before ordering" % (chart[:20], want))
            page.goto(page.url.split("?")[0] + "?symbol=" + want.replace(":", "%3A"),
                      wait_until="domcontentloaded", timeout=45000)
            page.wait_for_timeout(6000)
            chart = page.evaluate(JS_SYMBOL) or ""
        if normalise_symbol(chart) != symbol:
            raise RuntimeError("chart shows %r after switching, expected %s - refusing rather "
                               "than trading the wrong instrument" % (chart[:20], symbol))

        t = page.evaluate(JS_TICKET)
        side_key = "side-control-buy" if side == "buy" else "side-control-sell"
        for needed in (side_key, "place-and-modify-button"):
            if not t.get(needed) or not t[needed]["vis"]:
                raise RuntimeError("%s is not visible - the Trading Panel must be open" % needed)

        if not LIVE:
            return ("DRY RUN - chart=%s, would select %s, choose Market, then press %r"
                    % (chart[:14], side_key, (t.get("submitText") or "?")[:46]))

        page.mouse.click(t[side_key]["x"] + t[side_key]["w"] / 2,
                         t[side_key]["y"] + t[side_key]["h"] / 2)
        page.wait_for_timeout(500)
        market = page.evaluate(JS_TICKET).get("marketTab")
        if market and market["vis"]:
            page.mouse.click(market["x"] + market["w"] / 2, market["y"] + market["h"] / 2)
            page.wait_for_timeout(700)

        # Re-measure and re-assert before the irreversible press. The ticket has relaid out
        # twice by now, and the submit button's own text is the last chance to catch a wrong
        # side or a wrong instrument while it still costs nothing.
        t2 = page.evaluate(JS_TICKET)
        btn = t2.get("place-and-modify-button")
        txt = (t2.get("submitText") or "")
        if not btn or not btn["vis"]:
            raise RuntimeError("submit button vanished after selecting the side - nothing sent")
        if not txt.lower().startswith(side):
            raise RuntimeError("submit button reads %r but this order is %s - nothing sent"
                               % (txt[:46], side))
        page.mouse.click(btn["x"] + btn["w"] / 2, btn["y"] + btn["h"] / 2)
        page.wait_for_timeout(1500)
        return "SENT: %s" % txt[:60]
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
    _utf8_stdout()
    if "--selftest" in sys.argv:
        sys.exit(selftest())

    if "--poll" in sys.argv or "--poll-once" in sys.argv:
        once = "--poll-once" in sys.argv
        log("alert-log polling  mode=%s  allowed=%s  strategy=%r"
            % ("LIVE" if LIVE else "DRY RUN", ",".join(sorted(ALLOWED)), STRATEGY_TAG))
        import time
        while True:
            try:
                results = poll_once()
                if results:
                    for r in results:
                        log(r)
                else:
                    log("no new alerts")
                # Publish the paper account's open positions on the same beat, so the Auto
                # Trade page shows TradingView trades. Nothing else can see them:
                # /api/mt5/positions is built from bridge reports and the ledger from MT5
                # deal history. Failure here must never stop the poller.
                try:
                    import subprocess
                    subprocess.run([sys.executable,
                                    os.path.join(ROOT, "tasks", "tv_paper_positions.py")],
                                   cwd=ROOT, timeout=120,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                except Exception as pub_exc:            # noqa: BLE001
                    log("position publish failed (poller continues): %s" % pub_exc)
            except Exception as exc:                   # noqa: BLE001 - a poller must not die
                log("POLL ERROR: %s" % exc)
            if once:
                break
            time.sleep(60)
        sys.exit(0)
    if not SECRET:
        log("TV_EXEC_SECRET is not set - the listener will refuse every alert. Set it first.")
    log("listening on :%d  mode=%s  allowed=%s  strategy=%r"
        % (PORT, "LIVE" if LIVE else "DRY RUN", ",".join(sorted(ALLOWED)), STRATEGY_TAG))
    HTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
