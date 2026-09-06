# TRADINGVIEW PAPER POSITIONS -> dashboard/tv-paper-positions.json
#
# WHAT AND WHY. Anything opened on the TradingView paper account is invisible to every other
# surface here: /api/mt5/positions is built from BRIDGE reports and cannot see it, the ledger
# is fed from MT5 deal history, and the Auto Trade page reads both. So a trade could be open
# on TradingView and the dashboard would show nothing at all -- the same shape as the EA
# panel that printed "No open EA trades" over two live positions.
#
# READ-ONLY. It opens the Paper Trading tab (TradingView's own panel chrome) and reads the
# positions table. It clicks no order control, touches no study or strategy, and places
# nothing. feedsTheGate is false and stays false: this is observability, never an input.
#
# THE THREE STATES ARE KEPT APART, because collapsing them is how a blind panel reports calm:
#   positions: [...]  read the table, these are open
#   positions: []     read the table, TradingView says there are none
#   positions: null   could NOT read it -- never rendered as "no trades"
#
#   python tasks/tv_paper_positions.py           write the json
#   python tasks/tv_paper_positions.py --json    print it, write nothing

import io
import json
import os
import sys
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "dashboard", "tv-paper-positions.json")
CDP = "http://localhost:9222"
AS_JSON = "--json" in sys.argv

JS_TAB = """(name) => {
  for (const e of document.querySelectorAll('*')) {
    if (e.children.length) continue;
    if ((e.textContent || '').trim() !== name) continue;
    const r = e.getBoundingClientRect();
    if (r.width > 20 && e.offsetParent !== null)
      return {x: r.x, y: r.y, w: r.width, h: r.height};
  }
  return null; }"""

# Reads the grid as header + rows. TradingView renders it with ARIA roles, so this does not
# depend on class names, which are hashed and change without notice.
JS_TABLE = """() => {
  const headers = [];
  document.querySelectorAll('[role="columnheader"]').forEach(e => {
    const t = (e.textContent || '').trim();
    if (t && t.length < 30) headers.push(t);
  });
  const empty = /no open positions|no trading data/i.test(document.body.innerText || '');
  const rows = [];
  document.querySelectorAll('[role="row"]').forEach(r => {
    const cells = [];
    r.querySelectorAll('[role="gridcell"], [role="cell"]').forEach(c => {
      cells.push((c.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40));
    });
    if (cells.length >= 4) rows.push(cells);
  });
  return {headers: headers, rows: rows, emptyMessage: empty}; }"""


def read_positions():
    """Returns (positions_or_None, note). None means could not read, never 'none open'."""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return None, "playwright is not installed on this box"
    try:
        with sync_playwright() as p:
            browser = p.chromium.connect_over_cdp(CDP)
            page = next((pg for ctx in browser.contexts for pg in ctx.pages
                         if "tradingview.com" in (pg.url or "")), None)
            if page is None:
                return None, "no TradingView page is open on CDP 9222"

            tab = page.evaluate(JS_TAB, "Paper Trading")
            if tab:
                page.mouse.click(tab["x"] + tab["w"] / 2, tab["y"] + tab["h"] / 2)
                page.wait_for_timeout(2500)

            table = page.evaluate(JS_TABLE)
            headers = table.get("headers") or []
            rows = table.get("rows") or []

            if not headers and not table.get("emptyMessage"):
                return None, ("the Paper Trading table was not found - the panel may be "
                              "closed. This is not evidence that no trades are open.")

            out = []
            for cells in rows:
                rec = {}
                for i, h in enumerate(headers):
                    if i < len(cells):
                        rec[h] = cells[i]
                if rec.get("Symbol"):
                    out.append(rec)
            if not out and table.get("emptyMessage"):
                return [], "TradingView reports no open positions on the paper account"
            return out, "read %d position(s) from the Paper Trading panel" % len(out)
    except Exception as exc:                            # noqa: BLE001
        return None, "could not read the panel: %s" % exc


def main():
    positions, note = read_positions()
    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "source": "TradingView Paper Trading panel (read-only, over CDP)",
        "feedsTheGate": False,
        "account": "TradingView Paper Trading",
        "positions": positions,
        "count": None if positions is None else len(positions),
        "readable": positions is not None,
        "note": note,
        "warning": ("TradingView paper trades are invisible to /api/mt5/positions and to the "
                    "trade ledger - both are fed from MT5. This file is the only place they "
                    "appear."),
    }
    if AS_JSON:
        print(json.dumps(payload, indent=2))
        return 0
    try:
        tmp = OUT + ".tmp"
        with io.open(tmp, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=2)
        os.replace(tmp, OUT)
    except OSError as exc:
        print("  could not write %s: %s" % (OUT, exc))
        return 1
    print("")
    print("=== TRADINGVIEW PAPER POSITIONS ===")
    print("")
    if positions is None:
        print("  CANNOT READ - %s" % note)
    elif not positions:
        print("  no open positions (TradingView says so explicitly)")
    else:
        for p in positions:
            print("  %-10s %-5s %-8s @ %-12s  PnL %s"
                  % (p.get("Symbol", "?"), p.get("Side", "?"), p.get("Quantity", "?"),
                     p.get("Avg fill price", "?"), p.get("Unrealized PnL", "?")))
    print("  written: %s" % OUT)
    print("")
    return 0


if __name__ == "__main__":
    try:
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass
    sys.exit(main())
