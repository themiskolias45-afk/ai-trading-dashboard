# WEEKLY REVIEW of EA_CRT_AMD_Dashboard - profitability and stability. Nothing else.
#
# SCOPE, deliberately narrow. This looks at the chart EA ONLY, by magic. It never reads,
# reports on or averages in SmartEntry, its bridge or its executors. The two are separate
# systems: pooling them makes a number that describes neither, and an EA problem would
# hide inside SmartEntry's totals. If a magic is not the EA's, this file ignores it.
#
# READ-ONLY AND UNABLE TO BLOCK. Reads the trade ledger and the MT5 expert log, writes one
# report. No order, no stop, no close, no gate, no threshold, no setting, no signal path,
# no journal, no other ledger, nothing deleted. If it fails, nothing changes anywhere.
#
# WHAT IT CHECKS, and why each one is here rather than being a generic metric. Every
# check below is a failure this EA has actually had, measured 2026-09-04:
#
#   SIZING ANOMALY   One 0.13-lot trade lost -436.85 in the July trial while every other
#                    trade was 0.01 - 95% of the entire loss from a single oversized fill.
#                    Cause: InpUseFixedLot=true in the saved .set. This is the single most
#                    expensive failure the EA has had, so it is checked first.
#   EXITS CLIPPING    A healthy win rate with average win < average loss on a 2R design is
#                    the trailing-stop signature. Backtested: trail ON -15.28, trail OFF
#                    +536.27 over 13 months of real ticks.
#   CONFIG DRIFT      The EA's own CONFIG SENTRY prints the live inputs at attach. If the
#                    line does not say TRAIL OFF, the losing configuration is running.
#   DUPLICATE COPIES  On 2026-09-04 four copies were attached at once, all sharing magic
#                    26070401, each running position management over the others' trades.
#   SYMBOL DRIFT      Measured gold-only: XAUUSD +536, BTCUSD +51, XAGUSD -8.58,
#                    EURUSD -513. Trades on anything but gold are worth knowing about.
import json, os, re, glob
from collections import defaultdict
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
LEDGER = os.path.join(HERE, "all_trades_ledger.jsonl")
OUT = os.path.join(HERE, "ea_crt_weekly_review.json")
DASH_OUT = os.path.join(HERE, "..", "dashboard", "ea-crt-weekly-review.json")
MT5_LOGS = os.path.join(os.environ.get("APPDATA", ""), "MetaQuotes", "Terminal",
                        "5B9C24F117C34D03F25BA926243C77EB", "MQL5", "Logs")

EA_MAGICS = {26070401, 26070402, 26070455}

# The two MT5 data folders on this box. Checked for one thing only: whether MetaQuotes'
# bundled AI assistant is allowed to place orders. This is NOT an EA performance metric -
# it is the environment the EA runs inside, reported in its own section and never mixed
# into the EA's trading record.
TERMINAL_DIRS = {
    "11581419": "5B9C24F117C34D03F25BA926243C77EB",
    "25446287": "D0E8209F77C8CF37AD8BF550E51FF075",
}
LOOKBACK_DAYS = 7
# A fill this many times the median size is an anomaly worth naming, not noise. The July
# loss was 13x the median and would have tripped this on the day it happened.
SIZE_ANOMALY_MULTIPLE = 3.0
EXPECTED_SYMBOL = "XAUUSD"


def load_ea_trades():
    rows = []
    if not os.path.exists(LEDGER):
        return rows
    with open(LEDGER, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except ValueError:
                continue          # one bad row must not hide the rest
            if r.get("magic") in EA_MAGICS:
                rows.append(r)
    return rows


def summarise(rows):
    if not rows:
        return None
    nets = [r.get("netProfit") or 0.0 for r in rows]
    wins = [x for x in nets if x > 0]
    losses = [x for x in nets if x < 0]
    gl = -sum(losses)
    return {
        "trades": len(rows),
        "wins": len(wins),
        "losses": len(losses),
        "winRatePct": round(len(wins) * 100.0 / len(rows), 2),
        "netProfit": round(sum(nets), 2),
        # None, not 0 or 99: no losing trade yet means UNDEFINED, not perfect.
        "profitFactor": round(sum(wins) / gl, 3) if gl > 0 else None,
        "expectancyPerTrade": round(sum(nets) / len(rows), 2),
        "avgWin": round(sum(wins) / len(wins), 2) if wins else None,
        "avgLoss": round(sum(losses) / len(losses), 2) if losses else None,
        "largestWin": round(max(nets), 2),
        "largestLoss": round(min(nets), 2),
    }


def assistant_trade_permission():
    """PermissionsTrade per terminal, from config/assistant.ini.

    Why it is re-checked every week rather than trusted once: MT5 build 6140 ships its own
    MCP server and a bundled agent (goose.exe, talking to a third-party inference endpoint)
    which held PermissionsTrade=1 on BOTH terminals until 2026-09-04. That is an order path
    outside both halt systems - the bridges read /api/mt5/control, the executors read
    /api/risk-status, and neither covers it. It was set to 0, but MT5 caches these settings
    in memory and rewrites the file on shutdown, so a restart can silently put it back.
    A safety setting nothing re-reads is a safety setting that quietly expires.

    Unknown, never assumed-safe, when a file cannot be read: "cannot tell" and "it is off"
    must not look the same.
    """
    out = {}
    for login, folder in TERMINAL_DIRS.items():
        path = os.path.join(os.environ.get("APPDATA", ""), "MetaQuotes", "Terminal",
                            folder, "config", "assistant.ini")
        try:
            text = open(path, "rb").read().decode("utf-16-le", errors="ignore")
        except OSError:
            out[login] = None          # unreadable - reported as unknown
            continue
        match = re.search(r"PermissionsTrade=(\d)", text)
        out[login] = int(match.group(1)) if match else None
    return out


def latest_sentry_line():
    """The EA's own CONFIG SENTRY output - the only authoritative view of the LIVE inputs.
    Returns (line, logdate) or (None, None) when the EA has not attached recently."""
    try:
        logs = sorted(glob.glob(os.path.join(MT5_LOGS, "2*.log")), reverse=True)
    except OSError:
        return None, None
    for path in logs[:14]:
        try:
            raw = open(path, "rb").read().decode("utf-16-le", errors="ignore")
        except OSError:
            continue
        hits = [ln.strip() for ln in raw.splitlines() if "CRT_AMD" in ln and "CONFIG" in ln]
        if hits:
            return hits[-1], os.path.basename(path)[:8]
    return None, None


def build_findings(recent, all_rows, sentry, perms):
    """Every finding names what it saw and what to do. A check that cannot fire is
    decoration, so each one is derived from a failure this EA has actually had."""
    findings = []

    # 1. SIZING - the most expensive failure this EA has had.
    vols = sorted(r.get("volume") or 0 for r in all_rows)
    if vols:
        median = vols[len(vols) // 2]
        outliers = [r for r in recent
                    if median > 0 and (r.get("volume") or 0) >= median * SIZE_ANOMALY_MULTIPLE]
        if outliers:
            worst = min(outliers, key=lambda r: r.get("netProfit") or 0)
            findings.append({
                "severity": "HIGH", "check": "SIZING_ANOMALY",
                "detail": "%d trade(s) at >=%.1fx the median size of %.2f lots. Worst: %.2f "
                          "lots for %.2f." % (len(outliers), SIZE_ANOMALY_MULTIPLE, median,
                                              worst.get("volume") or 0, worst.get("netProfit") or 0),
                "action": "Check InpUseFixedLot is false and InpRiskPercent is 0.5. A single "
                          "oversized fill cost -436.85 in July, 95% of that run's whole loss.",
            })

    # 2. EXITS - a good win rate with avg win < avg loss on a 2R design means winners
    #    are being cut before target. That is the trailing stop, measured.
    s = summarise(recent)
    if s and s["avgWin"] and s["avgLoss"] and s["winRatePct"] >= 45 \
            and s["avgWin"] < abs(s["avgLoss"]):
        findings.append({
            "severity": "HIGH", "check": "EXITS_CLIPPING_WINNERS",
            "detail": "win rate %.1f%% but average win %.2f is below average loss %.2f."
                      % (s["winRatePct"], s["avgWin"], abs(s["avgLoss"])),
            "action": "Confirm the trailing stop is OFF. Backtested on 13 months of real "
                      "ticks: trail ON -15.28, trail OFF +536.27, maxDD 9.71%% -> 6.77%%.",
        })

    # 3. CONFIG - the EA states its own live inputs. Absence of TRAIL OFF is the losing config.
    if sentry is None:
        findings.append({
            "severity": "INFO", "check": "NO_SENTRY_LINE",
            "detail": "No CONFIG SENTRY line in the last 14 days of MT5 logs.",
            "action": "The EA may not be attached. Confirm it is on XAUUSD M15.",
        })
    elif "TRAIL OFF" not in sentry:
        findings.append({
            "severity": "HIGH", "check": "TRAIL_IS_ON",
            "detail": "Latest sentry line does not report TRAIL OFF: %s" % sentry[-160:],
            "action": "Load the v3.55 build or the GOLD_TRAILOFF preset. The trail is worth "
                      "-551 GBP over 13 months.",
        })
    if sentry and "FIXEDLOT" in sentry:
        findings.append({
            "severity": "HIGH", "check": "FIXED_LOT_ACTIVE",
            "detail": "Sentry reports FIXEDLOT - flat lots instead of risk-based sizing.",
            "action": "Set InpUseFixedLot=false. This is the exact cause of the -436.85 trade.",
        })

    # 4. DUPLICATE COPIES - more than one EA magic trading in the window.
    magics = {r.get("magic") for r in recent}
    if len(magics) > 1:
        findings.append({
            "severity": "HIGH", "check": "MULTIPLE_INSTANCES",
            "detail": "Trades from %d different EA magics this week: %s"
                      % (len(magics), sorted(m for m in magics if m)),
            "action": "Only one copy should be attached. Copies sharing a magic manage each "
                      "other's positions - four were attached at once on 2026-09-04.",
        })

    # 5. SYMBOL DRIFT - the edge measured gold-only.
    off = sorted({r.get("symbol") for r in recent if r.get("symbol") != EXPECTED_SYMBOL})
    if off:
        findings.append({
            "severity": "MEDIUM", "check": "SYMBOL_DRIFT",
            "detail": "Traded outside %s this week: %s" % (EXPECTED_SYMBOL, off),
            "action": "The edge measured gold-only: BTCUSD +51 (PF 1.02), XAGUSD -8.58, "
                      "EURUSD -513. Detach from other symbols unless testing deliberately.",
        })

    # 6. ENVIRONMENT - the bundled MT5 assistant must not hold trade permission.
    for login, value in (perms or {}).items():
        if value == 1:
            findings.append({
                "severity": "HIGH", "check": "MT5_ASSISTANT_CAN_TRADE",
                "detail": "Terminal %s has PermissionsTrade=1 - MetaQuotes' bundled AI "
                          "assistant can place orders on that account." % login,
                "action": "Set it to 0 in the assistant's GUI permissions. It is an order "
                          "path outside BOTH halt systems. It was set to 0 on 2026-09-04; "
                          "MT5 rewrites this file on shutdown, so it can come back.",
            })
        elif value is None:
            findings.append({
                "severity": "MEDIUM", "check": "MT5_ASSISTANT_PERMISSION_UNKNOWN",
                "detail": "Could not read PermissionsTrade for terminal %s." % login,
                "action": "Check config/assistant.ini by hand. Unknown is not the same as off.",
            })

    if not findings:
        findings.append({
            "severity": "OK", "check": "NO_ISSUES",
            "detail": "No sizing anomaly, no exit asymmetry, no config drift, one instance, "
                      "gold only.",
            "action": "Nothing to change. Let the sample grow.",
        })
    return findings


def main():
    all_rows = load_ea_trades()
    cutoff = (datetime.now(timezone.utc) - timedelta(days=LOOKBACK_DAYS)).isoformat()
    recent = [r for r in all_rows if (r.get("closeTime") or "") >= cutoff]
    sentry, sentry_day = latest_sentry_line()
    perms = assistant_trade_permission()

    by_symbol = defaultdict(list)
    for r in recent:
        by_symbol[r.get("symbol")].append(r)

    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "scope": "EA_CRT_AMD_Dashboard only - NOT SmartEntry, never pooled with it",
        "feedsTheGate": False,
        "lookbackDays": LOOKBACK_DAYS,
        "thisWeek": summarise(recent),
        "allTime": summarise(all_rows),
        "thisWeekBySymbol": {k: summarise(v) for k, v in by_symbol.items()},
        "liveConfigSentry": sentry,
        # Environment, not EA performance. Kept in its own key for exactly that reason.
        "mt5AssistantPermissionsTrade": perms,
        "liveConfigSentryLogDay": sentry_day,
        "findings": build_findings(recent, all_rows, sentry, perms),
    }

    for target in (OUT, os.path.abspath(DASH_OUT)):
        try:
            tmp = target + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(payload, fh, indent=1)
            os.replace(tmp, target)
        except OSError as exc:
            print("could not write %s: %s" % (target, exc))

    wk, at = payload["thisWeek"], payload["allTime"]
    print("EA_CRT_AMD_Dashboard - weekly review  (%s)" % payload["generatedAt"][:16])
    print("  this week : %s" % ("no closed trades" if not wk else
          "%d trades, net %.2f, PF %s, win %.1f%%"
          % (wk["trades"], wk["netProfit"],
             wk["profitFactor"] if wk["profitFactor"] is not None else "n/a", wk["winRatePct"])))
    print("  all time  : %s" % ("no closed trades" if not at else
          "%d trades, net %.2f, PF %s, win %.1f%%"
          % (at["trades"], at["netProfit"],
             at["profitFactor"] if at["profitFactor"] is not None else "n/a", at["winRatePct"])))
    print("  live config: %s" % (sentry[-110:] if sentry else "no sentry line found"))
    print("  mt5 assistant PermissionsTrade: %s"
          % ", ".join("%s=%s" % (k, "unknown" if v is None else v) for k, v in perms.items()))
    for f in payload["findings"]:
        print("  [%-6s] %-24s %s" % (f["severity"], f["check"], f["detail"]))
        if f["severity"] != "OK":
            print("           -> %s" % f["action"])
    print("report: %s" % OUT)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
