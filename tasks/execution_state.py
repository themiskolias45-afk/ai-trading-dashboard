# EXECUTION STATE -> dashboard/execution-state.json
#
# Everything that decides WHETHER a trade happens and HOW BIG it is, on one page, because
# until now it was spread across six surfaces and no single one of them was complete:
#
#   * /api/mt5/positions      shows only the BRIDGE's own magic - it held one SP500 trade
#                             while MT5 held eight, so the EA's positions were invisible
#                             to the dashboard BY CONSTRUCTION
#   * the trade ledger        is built from MT5 deal history, so it cannot see TradingView
#   * the weekly review       is the EA only, deliberately
#   * strategy settings       give percentages, not the LOTS those percentages produce
#   * the halt routes         are two separate systems that must BOTH be checked
#
# So a reader could not answer the only questions that matter before a trade fires: can it
# trade right now, what can place an order, and how big can one get?
#
# READ-ONLY. Reads MT5, the settings API and the ledger; writes one JSON file. It places no
# order, changes no setting, arms and disarms nothing. feedsTheGate is false and stays false.
#
# UNKNOWN IS NEVER ZERO. Every section can be None, meaning "could not read", and the panel
# renders that differently from empty. This whole file exists because things that could not
# be seen were reported as fine.
#
#   python tasks/execution_state.py           write the json
#   python tasks/execution_state.py --json    print it, write nothing

import io
import json
import os
import sys
from datetime import datetime, timezone, timedelta

try:
    import urllib.request as _url
except ImportError:                                   # pragma: no cover
    _url = None

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "dashboard", "execution-state.json")
LEDGER = os.path.join(ROOT, "tasks", "all_trades_ledger.jsonl")
SERVER = "http://localhost:3001"
AS_JSON = "--json" in sys.argv

# SCOPE, SET BY THE OWNER AND DELIBERATELY NARROW: SmartEntry (the bridge and its own
# executors) and the CRT chart EA. Nothing else.
#
# Other magics on this account belong to the user's own separate EAs, which he runs
# knowingly and which this system does not manage, measure or reason about. Reporting them
# as "UNIDENTIFIED" was wrong twice over - they are identified, just not ours, and an alarm
# that fires on something deliberate is the alarm you learn to skip past.
#
# The panel STATES this scope rather than implying coverage it does not have. That matters
# more than the filtering: a reader must never mistake "not shown" for "not there".
OWNERS = {
    20250101: "SmartEntry bridge",
    20260902: "FVG_CONTINUATION executor",
    20260903: "TK_SWING_PULLBACK executor",
    20260904: "CRT_FVG executor",
    26070401: "EA_CRT_AMD v3.51 (chart EA)",
    26070402: "EA_CRT_AMD v3.51 twin (chart EA)",
    26070455: "EA_CRT_AMD v3.55/56 (chart EA)",
}
# Which owners a halt can actually reach. Traced 2026-09-06: the Python paths check BOTH
# halt systems and fail closed; the chart EAs run inside MetaTrader and call no route at all.
HALT_REACHES = {
    20250101: True, 20260902: True, 20260903: True, 20260904: True,
    26070401: False, 26070402: False, 26070455: False,
}


def get_json(path, timeout=6):
    if _url is None:
        return None
    try:
        with _url.urlopen(SERVER + path, timeout=timeout) as r:
            if r.status != 200:
                return None
            return json.loads(r.read().decode("utf-8", "replace"))
    except Exception:                                  # noqa: BLE001
        return None


def read_mt5():
    """Account, positions and per-symbol contract values. None when MT5 cannot be asked."""
    try:
        import MetaTrader5 as mt5
    except Exception:                                  # noqa: BLE001
        return None
    try:
        if not mt5.initialize():
            return None
    except Exception:                                  # noqa: BLE001
        return None
    try:
        acc = mt5.account_info()
        if acc is None:
            return None
        out = {
            "login": acc.login,
            "server": acc.server,
            "balance": round(acc.balance, 2),
            "equity": round(acc.equity, 2),
            "currency": acc.currency,
            "marginFree": round(acc.margin_free, 2),
            "positions": [],
            "symbols": {},
        }
        for pos in (mt5.positions_get() or []):
            if pos.magic not in OWNERS:
                out["outOfScope"] = out.get("outOfScope", 0) + 1
                continue          # another of the owner's EAs - not this system's business
            out["positions"].append({
                "ticket": pos.ticket, "symbol": pos.symbol,
                "side": "BUY" if pos.type == 0 else "SELL",
                "volume": pos.volume, "price": pos.price_open,
                "sl": pos.sl or None, "tp": pos.tp or None,
                "profit": round(pos.profit, 2), "magic": pos.magic,
                "owner": OWNERS[pos.magic],
                "haltReaches": HALT_REACHES.get(pos.magic, None),
                "hasStop": bool(pos.sl),
            })
        for sym in ("XAUUSD", "BTCUSD", "SP500"):
            info = mt5.symbol_info(sym)
            tick = mt5.symbol_info_tick(sym)
            if not info or not tick:
                continue
            price = tick.bid or tick.ask or 0
            out["symbols"][sym] = {
                "price": price,
                "contractSize": info.trade_contract_size,
                "notionalPerLot": round(info.trade_contract_size * price, 2),
                "volumeMin": info.volume_min,
                "volumeStep": info.volume_step,
            }
        return out
    except Exception:                                  # noqa: BLE001
        return None
    finally:
        try:
            mt5.shutdown()
        except Exception:                              # noqa: BLE001
            pass


def sizing_table(settings, mt5d):
    """What the CURRENT settings actually permit, in lots, per symbol.

    A percentage is not an answer to "how big can this get". Two ceilings apply - a flat lot
    cap and a notional cap - and which one binds differs per symbol because contract values
    differ by 57x. This resolves both into the number that will really be sent.
    """
    if not settings or not mt5d or not mt5d.get("symbols"):
        return None
    max_lot = float(settings.get("maxLotSize") or 0)
    # THE SERVER MAY NOT SERVE THIS KEY YET while the bridge already defaults to 25, so the
    # two disagree until the server restarts. Showing 0 would claim "no notional cap" when
    # the bridge is in fact applying one; showing 25 silently would hide that the server is
    # behind. The source is reported alongside the number.
    raw_pct = settings.get("maxNotionalPct")
    pct_from_server = isinstance(raw_pct, (int, float))
    pct = float(raw_pct) if pct_from_server else 25.0
    balance = mt5d.get("balance") or 0
    rows = {}
    for sym, s in mt5d["symbols"].items():
        per_lot = s["notionalPerLot"]
        notional_lots = (balance * pct / 100.0 / per_lot) if (pct > 0 and per_lot > 0) else None
        caps = [c for c in (max_lot or None, notional_lots) if c]
        effective = min(caps) if caps else None
        rows[sym] = {
            "notionalPctSource": "server" if pct_from_server else "bridge default (server not restarted)",
            "notionalPct": pct,
            "notionalPerLot": per_lot,
            "maxLotCap": max_lot or None,
            "notionalCap": round(notional_lots, 3) if notional_lots else None,
            "effectiveMaxLots": round(effective, 3) if effective else None,
            "bindingCap": (None if effective is None else
                           ("notional" if notional_lots and effective == notional_lots
                            else "maxLotSize")),
            "maxExposure": (round(effective * per_lot, 2) if effective else None),
            "leverageAtCap": (round(effective * per_lot / balance, 2)
                              if effective and balance else None),
            "volumeMin": s["volumeMin"],
        }
    return rows


def todays_fills():
    """Closed trades recorded today, by owner. None when the ledger cannot be read."""
    if not os.path.exists(LEDGER):
        return None
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    out = []
    try:
        with io.open(LEDGER, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if str(r.get("closeTime", ""))[:10] != today:
                    continue
                out.append({
                    "closeTime": str(r.get("closeTime"))[:16],
                    "symbol": r.get("symbol"), "direction": r.get("direction"),
                    "volume": r.get("volume"), "netProfit": r.get("netProfit"),
                    "magic": r.get("magic"),
                    "owner": OWNERS.get(r.get("magic"), "magic %s" % r.get("magic")),
                })
    except OSError:
        return None
    return out


def main():
    settings = get_json("/api/strategy-settings")
    risk = get_json("/api/risk-status")
    # /api/mt5/control IS DESTRUCTIVE TO READ, which nothing about its name suggests.
    #
    # It carries `restartRequested`, and the handler CLEARS THE FLAG ON READ so that exactly
    # one bridge acts on one request. That is correct when the bridge is the only reader.
    # It is not: nine files in this repo poll this endpoint, and on 2026-09-06 a restart
    # request posted for the bridge was consumed by an observability read instead - proved
    # by POSTing the flag and then seeing `restartRequested: true` in a plain curl.
    #
    # This panel is observability. It must never be able to swallow a restart request meant
    # for the bridge, so it reads the halt state from /api/risk-status only and reports the
    # kill switch as UNKNOWN rather than stealing the flag to find out. Unknown is the honest
    # answer here and it is rendered as such; a correct kill-switch reading is not worth
    # silently eating an operator's restart.
    control = None
    mt5d = read_mt5()

    # BOTH halt systems, and unreadable is never treated as "not halted".
    breaker_open = None if not isinstance(risk, dict) else bool(risk.get("halted"))
    kill_engaged = None
    if isinstance(control, dict):
        kill_engaged = bool(control.get("enabled") is False
                            or control.get("tradingEnabled") is False
                            or control.get("halted") is True)
    halted = (breaker_open is True) or (kill_engaged is True)
    halt_unknown = breaker_open is None or kill_engaged is None

    positions = None if not mt5d else mt5d.get("positions")
    # THREE STATES, NOT TWO. haltReaches is True (a halt stops it), False (it is a chart EA
    # and a halt provably does not), or None - an UNKNOWN magic, where we cannot say either
    # way. The first version counted only False while the printout marked None the same as
    # False, so the summary said "2" beside five flagged lines. An unknown order path is not
    # a covered one and it is not a proven gap either: it is the thing to go and identify.
    unreachable = ([p for p in positions if p.get("haltReaches") is False]
                   if positions is not None else None)
    halt_unknown_pos = ([p for p in positions if p.get("haltReaches") is None]
                        if positions is not None else None)
    no_stop = ([p for p in positions if not p.get("hasStop")]
               if positions is not None else None)

    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "feedsTheGate": False,
        "host": os.environ.get("COMPUTERNAME"),
        "canTradeNow": {
            "halted": halted,
            "unknown": halt_unknown,
            "circuitBreakerOpen": breaker_open,
            "killSwitchEngaged": kill_engaged,
            "detail": ("one or both halt systems could not be read - unknown is not safe"
                       if halt_unknown else
                       "HALTED" if halted else "trading permitted"),
        },
        "account": None if not mt5d else {
            k: mt5d[k] for k in ("login", "server", "balance", "equity", "currency", "marginFree")
        },
        "settings": None if not settings else {
            k: settings.get(k) for k in
            ("confidenceThreshold", "riskPercent", "fixedLotSize", "maxLotSize",
             "maxNotionalPct", "maxConcurrentPositions", "maxTradesPerDay", "minStrength")
        },
        "settingsError": None if not settings else settings.get("settingsError"),
        "sizing": sizing_table(settings, mt5d),
        "positions": positions,
        "positionCount": None if positions is None else len(positions),
        "positionsHaltCannotReach": None if unreachable is None else len(unreachable),
        "positionsHaltUnknown": None if halt_unknown_pos is None else len(halt_unknown_pos),
        "scope": "SmartEntry (bridge + its executors) and the CRT chart EA only. Other "
                 "magics on this account are the owner's separate EAs and are deliberately "
                 "not monitored here - not shown does not mean not there.",
        "outOfScopePositions": None if not mt5d else mt5d.get("outOfScope", 0),
        "positionsWithoutStop": None if no_stop is None else len(no_stop),
        "todaysFills": todays_fills(),
        "note": ("Read-only. Places no order, changes no setting. Every section is null when "
                 "it could not be read - that is rendered differently from empty."),
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

    c = payload["canTradeNow"]
    print("")
    print("=== EXECUTION STATE ===")
    print("")
    print("  can trade now     %s" % c["detail"])
    print("    circuit breaker %s   kill switch %s"
          % ("unreadable" if c["circuitBreakerOpen"] is None else
             ("OPEN" if c["circuitBreakerOpen"] else "closed"),
             "unreadable" if c["killSwitchEngaged"] is None else
             ("ENGAGED" if c["killSwitchEngaged"] else "off")))
    if payload["account"]:
        a = payload["account"]
        print("  account           %s @ %s   balance %.2f %s"
              % (a["login"], a["server"], a["balance"], a["currency"]))
    s = payload["settings"] or {}
    npct = s.get("maxNotionalPct")
    npct_txt = ("%s%%" % npct) if isinstance(npct, (int, float)) else "25% (bridge default - server has not restarted)"
    print("  gate %s   risk %s%%   fixedLot %s   maxLot %s   maxNotional %s"
          % (s.get("confidenceThreshold"), s.get("riskPercent"), s.get("fixedLotSize"),
             s.get("maxLotSize"), npct_txt))
    print("")
    if payload["sizing"] is None:
        print("  sizing            CANNOT READ")
    else:
        print("  %-8s %-14s %-11s %-11s %-11s %s"
              % ("symbol", "notional/lot", "maxLot cap", "notional cap", "EFFECTIVE", "binding"))
        for sym, r in payload["sizing"].items():
            print("  %-8s %-14s %-11s %-11s %-11s %s"
                  % (sym, "{:,.0f}".format(r["notionalPerLot"]),
                     r["maxLotCap"], r["notionalCap"], r["effectiveMaxLots"], r["bindingCap"]))
    print("")
    if positions is None:
        print("  positions         CANNOT READ - not the same as none open")
    else:
        print("  positions         %d open, %d a halt CANNOT reach, %d halt status UNKNOWN, "
              "%d without a stop"
              % (len(positions), payload["positionsHaltCannotReach"],
                 payload["positionsHaltUnknown"], payload["positionsWithoutStop"]))
        if payload.get("outOfScopePositions"):
            print("    (%d further position(s) belong to other EAs - out of scope by design)"
                  % payload["outOfScopePositions"])
        for p in positions:
            print("    %-8s %-4s %-6s %-10s SL %-10s %+9.2f  %s%s"
                  % (p["symbol"], p["side"], p["volume"], p["price"], p["sl"] or "NONE",
                     p["profit"], p["owner"],
                     "" if p["haltReaches"] is True else
                     ("  [HALT CANNOT REACH]" if p["haltReaches"] is False
                      else "  [HALT STATUS UNKNOWN]")))
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
