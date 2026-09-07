# TRADINGVIEW PAPER ACCOUNT -> dashboard/tv-paper-account.json
#
# The full picture of the TradingView paper account: open positions, the account summary,
# and realised P&L bucketed by day / week / month from the Balance history table.
#
# WHY IT EXISTS. Nothing else here can see this account. /api/mt5/positions is assembled
# from BRIDGE reports; the trade ledger is built from MT5 deal history. A position could be
# open on TradingView, and thousands in realised P&L could have accrued, with every surface
# on the dashboard showing nothing - which is exactly what was happening: the account holds
# a realised -3,607.90 that appeared on no page anywhere.
#
# READ-ONLY. Opens the Paper Trading panel and its sub-tabs - TradingView's own chrome - and
# reads tables. It clicks no order control, touches no study, strategy or alert, and places
# nothing. feedsTheGate is false and stays false.
#
# UNKNOWN IS NOT ZERO. Every section can come back None, meaning "could not read", and that
# is rendered differently from an empty table. Collapsing those two is how a blind panel
# reports calm - the failure this system keeps repeating.
#
#   python tasks/tv_paper_account.py           write the json
#   python tasks/tv_paper_account.py --json    print it, write nothing

import io
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "dashboard", "tv-paper-account.json")
CDP = "http://localhost:9222"
AS_JSON = "--json" in sys.argv

SUMMARY_LABELS = ("Account balance", "Equity", "Realized PnL", "Unrealized PnL",
                  "Available funds", "Orders margin", "Margin buffer")

# A tab may wrap its label in child nodes, so match on trimmed text at any depth and take the
# SMALLEST matching box - the innermost element that is still the clickable row.
JS_TAB = """(name) => {
  let best = null;
  for (const e of document.querySelectorAll('button,[role="tab"],div,span')) {
    const t = (e.textContent || '').trim();
    if (t !== name) continue;
    const r = e.getBoundingClientRect();
    if (r.width < 20 || r.height < 10 || e.offsetParent === null) continue;
    const area = r.width * r.height;
    if (!best || area < best.area)
      best = {x: r.x + r.width/2, y: r.y + r.height/2, area: area};
  }
  return best; }"""

JS_SUMMARY = """(labels) => {
  const out = {};
  for (const want of labels) {
    for (const e of document.querySelectorAll('*')) {
      if (e.children.length) continue;
      if ((e.textContent || '').trim() !== want) continue;
      const lr = e.getBoundingClientRect();
      if (lr.width < 5 || e.offsetParent === null) continue;
      let best = null;
      for (const c of document.querySelectorAll('*')) {
        if (c.children.length) continue;
        const t = (c.textContent || '').trim();
        if (!t || t.length > 24 || !/[0-9]/.test(t)) continue;
        const cr = c.getBoundingClientRect();
        if (cr.y <= lr.y || cr.y > lr.y + 44) continue;
        if (Math.abs(cr.x - lr.x) > 60) continue;
        if (!best || cr.y < best.y) best = {t: t, y: cr.y};
      }
      if (best) out[want] = best.t;
      break;
    }
  }
  return out; }"""

# TWO TABLE IMPLEMENTATIONS, and they are not interchangeable. Positions is an ARIA grid
# (role=columnheader / role=row); Balance history is a real <table> with <th>/<tr>. Reading
# only the ARIA form returned 0 headers and 0 rows on Balance history while the table was
# plainly on screen - and that read as "no P&L" rather than "wrong reader". So: try ARIA,
# then fall back to real tables, and report which one answered.
JS_TABLE = """() => {
  const clean = e => (e.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40);

  const ariaHeaders = [];
  document.querySelectorAll('[role="columnheader"]').forEach(e => {
    const t = clean(e); if (t && t.length < 30) ariaHeaders.push(t);
  });
  const ariaRows = [];
  document.querySelectorAll('[role="row"]').forEach(r => {
    const cells = [];
    r.querySelectorAll('[role="gridcell"],[role="cell"]').forEach(c => cells.push(clean(c)));
    if (cells.length >= 3) ariaRows.push(cells);
  });
  if (ariaHeaders.length || ariaRows.length) {
    return {headers: Array.from(new Set(ariaHeaders)).slice(0,20),
            rows: ariaRows.slice(0,400), empty: false, via: 'aria'};
  }

  // Real <table>: pick the one with the most body rows, so a small unrelated table cannot win.
  let best = null;
  document.querySelectorAll('table').forEach(tb => {
    if (tb.getBoundingClientRect().height < 10) return;
    const n = tb.querySelectorAll('tbody tr').length;
    if (!best || n > best.n) best = {tb: tb, n: n};
  });
  const headers = [], rows = [];
  if (best) {
    best.tb.querySelectorAll('th').forEach(e => {
      const t = clean(e); if (t && t.length < 30) headers.push(t);
    });
    best.tb.querySelectorAll('tbody tr').forEach(tr => {
      const cells = [];
      tr.querySelectorAll('td,th').forEach(c => cells.push(clean(c)));
      if (cells.length >= 3) rows.push(cells);
    });
  }
  const empty = /no open positions|no trading data|nothing to show/i.test(document.body.innerText || '');
  return {headers: Array.from(new Set(headers)).slice(0,20),
          rows: rows.slice(0,400), empty: empty, via: best ? 'table' : 'none'}; }"""


def to_number(text):
    """'−3,607.90' / '+1 234.5' / '96,392.10 USD' -> float, or None.

    Handles the UNICODE MINUS (U+2212) TradingView renders, which a plain float() silently
    fails on - and a silent failure here would report every loss as unreadable.
    """
    if text is None:
        return None
    s = str(text).replace("−", "-").replace("–", "-")
    s = s.replace(",", "").replace(" ", " ").replace(" ", "")
    m = re.search(r"-?\d+(?:\.\d+)?", s)
    if not m:
        return None
    try:
        return float(m.group(0))
    except ValueError:
        return None


def parse_time(text):
    """TradingView balance-history timestamps -> aware datetime, or None."""
    if not text:
        return None
    s = str(text).strip().replace(" ", " ")
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%d %b '%y %H:%M:%S",
                "%d %b '%y %H:%M", "%a %d %b '%y %H:%M:%S", "%a %d %b '%y %H:%M",
                "%d %b %Y %H:%M:%S", "%d %b %Y %H:%M"):
        try:
            return datetime.strptime(s, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


def bucket_pnl(rows, headers):
    """Realised P&L for today / this week / this month / all time, from Balance history.

    Returns None when the table cannot be interpreted - never 0.0, because "no profit" and
    "could not read the table" are different facts and only one of them is reassuring.
    """
    if not rows or not headers:
        return None
    idx_time = next((i for i, h in enumerate(headers) if h.strip().lower().startswith("time")), None)
    idx_real = next((i for i, h in enumerate(headers) if "realized" in h.strip().lower()), None)
    if idx_time is None or idx_real is None:
        return None

    now = datetime.now(timezone.utc)
    start_day = now.replace(hour=0, minute=0, second=0, microsecond=0)
    start_week = start_day - timedelta(days=start_day.weekday())
    start_month = start_day.replace(day=1)

    out = {"today": 0.0, "week": 0.0, "month": 0.0, "allTime": 0.0,
           "rowsParsed": 0, "rowsUnparsedTime": 0}
    for cells in rows:
        if idx_time >= len(cells) or idx_real >= len(cells):
            continue
        val = to_number(cells[idx_real])
        if val is None:
            continue
        out["allTime"] += val
        out["rowsParsed"] += 1
        ts = parse_time(cells[idx_time])
        if ts is None:
            out["rowsUnparsedTime"] += 1
            continue
        if ts >= start_day:
            out["today"] += val
        if ts >= start_week:
            out["week"] += val
        if ts >= start_month:
            out["month"] += val
    for k in ("today", "week", "month", "allTime"):
        out[k] = round(out[k], 2)
    return out


def open_tab(page, name):
    box = page.evaluate(JS_TAB, name)
    if not box:
        return False
    page.mouse.click(box["x"], box["y"])
    page.wait_for_timeout(2800)
    return True


def read_account():
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

            # The Paper Trading tab is a TOGGLE: look before clicking, or a click on an
            # already-open panel closes it and the reader then reports it as unreadable.
            probe = page.evaluate(JS_TABLE)
            if not (probe["headers"] or probe["empty"]):
                open_tab(page, "Paper Trading")

            data = {"summary": page.evaluate(JS_SUMMARY, list(SUMMARY_LABELS)) or None}

            if open_tab(page, "Positions"):
                t = page.evaluate(JS_TABLE)
                if t["headers"] or t["empty"]:
                    positions = []
                    for cells in t["rows"]:
                        rec = {h: cells[i] for i, h in enumerate(t["headers"]) if i < len(cells)}
                        if rec.get("Symbol"):
                            positions.append(rec)
                    data["positions"] = positions
                else:
                    data["positions"] = None
            else:
                data["positions"] = None

            if open_tab(page, "Balance history"):
                t = page.evaluate(JS_TABLE)
                data["balanceHeaders"] = t["headers"] or None
                data["balanceRows"] = len(t["rows"])
                data["balanceVia"] = t.get("via")
                data["pnl"] = bucket_pnl(t["rows"], t["headers"])
            else:
                data["balanceHeaders"] = None
                data["balanceRows"] = None
                data["balanceVia"] = None
                data["pnl"] = None

            return data, "read the Paper Trading panel"
    except Exception as exc:                             # noqa: BLE001
        return None, "could not read the panel: %s" % exc


def main():
    data, note = read_account()
    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "source": "TradingView Paper Trading panel (read-only, over CDP)",
        "feedsTheGate": False,
        "account": "TradingView Paper Trading",
        "readable": data is not None,
        "note": note,
        "summary": (data or {}).get("summary"),
        "positions": (data or {}).get("positions"),
        "positionCount": None if not data or data.get("positions") is None
                         else len(data["positions"]),
        "pnl": (data or {}).get("pnl"),
        "balanceHeaders": (data or {}).get("balanceHeaders"),
        "balanceRows": (data or {}).get("balanceRows"),
        "balanceVia": (data or {}).get("balanceVia"),
        "warning": ("Invisible to /api/mt5/positions and to the trade ledger - both are fed "
                    "from MT5. This file is the only place this account appears."),
    }

    # CROSS-CHECK: the P&L summed out of Balance history must equal the Realized PnL that
    # TradingView reports for the account. Two independent readings of the same fact - if
    # they disagree, the bucketing is wrong and every daily/weekly figure built on it is too.
    # Noticing this agreement by eye is not a check; asserting it is.
    summed = (payload["pnl"] or {}).get("allTime")
    reported = to_number((payload["summary"] or {}).get("Realized PnL"))
    if summed is None or reported is None:
        payload["crossCheck"] = {"agree": None,
                                 "detail": "one side unreadable - cannot compare"}
    else:
        delta = round(summed - reported, 2)
        payload["crossCheck"] = {
            "agree": abs(delta) <= 0.05,
            "summedFromHistory": summed,
            "reportedByTradingView": reported,
            "delta": delta,
            "detail": ("balance history sums to the account's own Realized PnL"
                       if abs(delta) <= 0.05 else
                       "MISMATCH of %.2f - the day/week/month figures cannot be trusted"
                       % delta),
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
    print("=== TRADINGVIEW PAPER ACCOUNT ===")
    print("")
    s = payload["summary"] or {}
    for k in SUMMARY_LABELS:
        if k in s:
            print("  %-18s %s" % (k, s[k]))
    pnl = payload["pnl"]
    print("")
    if pnl is None:
        print("  realised P&L      CANNOT READ the balance history - not the same as zero")
    else:
        print("  realised today    %+.2f" % pnl["today"])
        print("  realised week     %+.2f" % pnl["week"])
        print("  realised month    %+.2f" % pnl["month"])
        print("  realised all time %+.2f   (%d row(s), %d with an unparsed time)"
              % (pnl["allTime"], pnl["rowsParsed"], pnl["rowsUnparsedTime"]))
    cc = payload.get("crossCheck") or {}
    if cc.get("agree") is True:
        print("  cross-check       OK - %s" % cc["detail"])
    elif cc.get("agree") is False:
        print("  cross-check       FAILED - %s" % cc["detail"])
    else:
        print("  cross-check       %s" % cc.get("detail", "not run"))
    print("")
    pos = payload["positions"]
    if pos is None:
        print("  positions         CANNOT READ - not the same as none open")
    elif not pos:
        print("  positions         none open")
    else:
        for p in pos:
            print("  %-10s %-5s %-8s @ %-12s PnL %s"
                  % (p.get("Symbol", "?"), p.get("Side", "?"), p.get("Quantity", "?"),
                     p.get("Avg fill price", "?"), p.get("Unrealized PnL", "?")))
    print("")
    print("  written: %s" % OUT)
    print("")
    return 0


if __name__ == "__main__":
    try:
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass
    sys.exit(main())
