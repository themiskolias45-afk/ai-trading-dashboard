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
# Terminal data folders are DISCOVERED, never hardcoded. The hash differs per install and
# per machine: the laptop's is 5B9C24F1..., the VPS's is D0E8209F.... A hardcoded hash makes
# this file silently find nothing the moment it runs on the other box - it would report "no
# sentry line" and "permission unknown" forever while looking like it was working.
MT5_ROOT = os.path.join(os.environ.get("APPDATA", ""), "MetaQuotes", "Terminal")


def terminal_dirs():
    """Every MT5 data folder on THIS machine. Common/Community are not terminals."""
    try:
        names = os.listdir(MT5_ROOT)
    except OSError:
        return []
    out = []
    for n in names:
        if n in ("Common", "Community", "Help"):
            continue
        d = os.path.join(MT5_ROOT, n)
        if os.path.isdir(os.path.join(d, "config")) or os.path.isdir(os.path.join(d, "MQL5")):
            out.append(d)
    return out

EA_MAGICS = {26070401, 26070402, 26070455}

# THE ERAS MUST NOT BE POOLED. Every trade this EA has ever closed (36, net -457.52) was
# placed 2026-07-05..07-15 by v3.51 and its unlabelled twin, BEFORE the 2026-09-04
# measurement that found the trailing stop was clipping winners. v3.55 ships that fix
# (trail OFF: -15.28 -> +536.27, PF 1.00 -> 1.18, maxDD 9.71% -> 6.77%) under its OWN
# magic, precisely so its record can be read on its own.
#
# A single blended "all time" would average the new build into a loss it did not cause and
# cannot undo -- and the blend gets MORE misleading as v3.55 trades, never less. The whole
# point of giving v3.55 a distinct magic is defeated by pooling it back together in the
# report. So the eras are reported side by side and never summed.
PREFIX_MAGICS  = {26070401, 26070402}   # pre-fix: trail ON, 1-point ratchet
CURRENT_MAGICS = {26070455}             # v3.55: trail OFF by default

# The two MT5 data folders on this box. Checked for one thing only: whether MetaQuotes'
# bundled AI assistant is allowed to place orders. This is NOT an EA performance metric -
# it is the environment the EA runs inside, reported in its own section and never mixed
# into the EA's trading record.

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



def open_ea_positions():
    """The EA's OPEN positions, read from MT5 directly.

    WHY NOT /api/mt5/positions. That endpoint is assembled from BRIDGE reports, and the
    bridge only reports positions on its own magic - byAccount.A carried exactly one SP500
    trade while MT5 held eight. The EA's positions are invisible to it BY CONSTRUCTION, so
    the dashboard panel reading its `unmanaged` array printed "No open EA trades" while two
    XAUUSD 0.12 positions on magic 26070455 were open and in profit. A panel that cannot
    ever be right is worse than no panel.

    Returns a LIST when MT5 answered (possibly empty - genuinely no open EA trades), and
    None when it could not be asked. The caller must not collapse those two into each
    other: "none open" and "could not look" are different facts.
    """
    try:
        import MetaTrader5 as mt5
    except Exception:
        return None
    try:
        if not mt5.initialize():
            return None
    except Exception:
        return None
    try:
        raw = mt5.positions_get()
        if raw is None:
            return None
        out = []
        for pos in raw:
            if pos.magic not in EA_MAGICS:
                continue
            out.append({
                "ticket": pos.ticket,
                "symbol": pos.symbol,
                "type": "BUY" if pos.type == 0 else "SELL",
                "volume": pos.volume,
                "price": pos.price_open,
                "sl": pos.sl or None,
                "tp": pos.tp or None,
                "profit": round(pos.profit, 2),
                "magic": pos.magic,
            })
        return out
    except Exception:
        return None
    finally:
        try: mt5.shutdown()
        except Exception: pass


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
    for d in terminal_dirs():
        # Keyed by folder hash, since the login is not in this file. Short prefix: enough
        # to tell two terminals apart, short enough to read.
        login = os.path.basename(d)[:8]
        path = os.path.join(d, "config", "assistant.ini")
        # NO assistant.ini means this terminal has no bundled assistant at all - the MT4
        # installs on this box, and any MT5 older than the build that added it. Not
        # applicable, so skipped silently. Only a file that EXISTS and cannot be read or
        # parsed is reported as unknown; three standing MEDIUMs about MT4 folders would
        # train the reader to skim past the one that matters.
        if not os.path.exists(path):
            continue
        try:
            text = open(path, "rb").read().decode("utf-16-le", errors="ignore")
        except OSError:
            out[login] = None          # unreadable - reported as unknown
            continue
        # No [Assistant] section means the assistant is not configured on this terminal
        # at all - true of a portable/throwaway install, which carries only the MCP block.
        # Not applicable, so skipped rather than reported as an unknown.
        if "[Assistant]" not in text:
            continue
        match = re.search(r"PermissionsTrade=(\d)", text)
        out[login] = int(match.group(1)) if match else None
    return out


def _local_sentry_line():
    """The newest CONFIG SENTRY line in THIS box's MT5 logs, or (None, None)."""
    logs = []
    for d in terminal_dirs():
        logs.extend(glob.glob(os.path.join(d, "MQL5", "Logs", "2*.log")))
    # Newest first across EVERY terminal, so the EA is found wherever it is attached.
    logs.sort(key=lambda p: os.path.basename(p), reverse=True)
    for path in logs[:28]:
        try:
            raw = open(path, "rb").read().decode("utf-16-le", errors="ignore")
        except OSError:
            continue
        hits = [ln.strip() for ln in raw.splitlines() if "CRT_AMD" in ln and "CONFIG" in ln]
        if hits:
            return hits[-1], os.path.basename(path)[:8]
    return None, None


def _pulled_sentry_line():
    """The sentry line from dashboard/mt5-runtime-status.json, with its host and age.

    On the laptop that file is PULLED FROM THE VPS by pull_vps_status.ps1, and the VPS is
    where the EA actually trades. Returns (line, logday, host, ageHours) or Nones.
    """
    path = os.path.join(HERE, "..", "dashboard", "mt5-runtime-status.json")
    try:
        with open(path, encoding="utf-8") as fh:
            d = json.load(fh)
    except (OSError, ValueError):
        return None, None, None, None
    line = d.get("lastSentryLine")
    if not line:
        return None, None, None, None
    age_h = None
    checked = d.get("checkedAt")
    if checked:
        try:
            ts = datetime.fromisoformat(str(checked).replace("Z", "+00:00"))
            age_h = (datetime.now(timezone.utc) - ts).total_seconds() / 3600.0
        except ValueError:
            age_h = None
    return line, d.get("lastSentryLogDay"), d.get("host"), age_h


def latest_sentry_line():
    """The EA's own CONFIG SENTRY output - the authoritative view of the LIVE inputs.

    READS THE BOX WHERE THE EA ACTUALLY RUNS, not merely the box this happens to execute on.
    The laptop also has MT5 with an older EA attached, so reading only local logs made this
    review report v3.55 CONFIG DRIFT on the laptop while the VPS - the machine that trades -
    had been running v3.56 with a clean sentry for hours. Both readings were true of their
    own box; only one of them was about the EA that matters.

    Prefers the pulled runtime status when it names a DIFFERENT host and is fresh, because
    that file is the VPS's own reading. Falls back to local logs when there is no pulled
    status, when it is stale, or when it describes this same machine.
    Returns (line, logday).
    """
    local_line, local_day = _local_sentry_line()
    pulled_line, pulled_day, pulled_host, pulled_age = _pulled_sentry_line()

    this_host = (os.environ.get("COMPUTERNAME") or "").strip().upper()
    pulled_is_remote = bool(pulled_host) and pulled_host.strip().upper() != this_host
    pulled_is_fresh = pulled_age is not None and pulled_age <= 6.0

    if pulled_line and pulled_is_remote and pulled_is_fresh:
        return pulled_line, (pulled_day or "pulled")
    return local_line, local_day


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
    elif "TRAIL:ON" in sentry:
        # v3.56+ states the trail outright on EVERY sentry line, drift or not, so this is
        # read rather than inferred. Checked BEFORE the v3.55 wordings below because it is
        # the only unambiguous form.
        findings.append({
            "severity": "HIGH", "check": "TRAIL_IS_ON",
            "detail": "Sentry reports TRAIL:ON. Sentry: %s" % sentry[-160:],
            "action": "Set InpUseTrailingStop=false or load the GOLD_TRAILOFF preset. The "
                      "trail is worth -551 GBP over 13 months.",
        })
    elif "TRAIL:OFF" in sentry:
        pass  # v3.56+, stated explicitly. Nothing to infer.
    elif "TRAIL OFF" in sentry:
        pass  # v3.55 wording: it lists trail-off as a "drift", so its presence means off.
    elif "CONFIG: VALIDATED" in sentry:
        # READ THIS BEFORE "FIXING" EITHER SIDE. The EA's ValidateConfigSentry() still
        # scores against the profile validated BEFORE 2026-09-04, in which the trailing
        # stop was ON. Its line 3958 is literally:
        #
        #     if(!InpUseTrailingStop) issues += "TRAIL OFF  ";
        #
        # so it files the FIX as drift, and "CONFIG: VALIDATED" (issues empty) can only be
        # printed when InpUseTrailingStop is TRUE -- i.e. VALIDATED means the LOSING config.
        # The words mean the opposite of what they look like.
        findings.append({
            "severity": "HIGH", "check": "TRAIL_IS_ON",
            "detail": "Sentry reports CONFIG: VALIDATED with no TRAIL: token, i.e. a v3.55 "
                      "or earlier build, which can only print VALIDATED when "
                      "the trailing stop is ON -- its baseline profile predates the "
                      "2026-09-04 measurement. Sentry: %s" % sentry[-160:],
            "action": "Load the v3.55 build or the GOLD_TRAILOFF preset. The trail is worth "
                      "-551 GBP over 13 months.",
        })
    else:
        # Neither wording. If the EA sentry is ever corrected to stop calling trail-off a
        # drift, the substring "TRAIL OFF" disappears and the old check here would have
        # shouted TRAIL_IS_ON at a correctly configured EA -- a false HIGH caused by fixing
        # the bug, which is the fastest way to train someone to ignore a real one. Unknown
        # is reported as unknown.
        findings.append({
            "severity": "UNKNOWN", "check": "SENTRY_WORDING_UNRECOGNISED",
            "detail": "Sentry line matches neither 'TRAIL OFF' nor 'CONFIG: VALIDATED', so "
                      "the trail state cannot be read from it: %s" % sentry[-160:],
            "action": "The EA's sentry wording changed. Re-read ValidateConfigSentry() and "
                      "update this check -- do not assume the trail is off.",
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
        # Split so the fix can be judged on its own evidence. Never sum these.
        "preFix": summarise([r for r in all_rows if r.get("magic") in PREFIX_MAGICS]),
        "current": summarise([r for r in all_rows if r.get("magic") in CURRENT_MAGICS]),
        "eraNote": ("preFix = v3.51 + twin, 2026-07-05..07-15, trailing stop ON. "
                    "current = v3.55, trail OFF, distinct magic 26070455. "
                    "Backtest for the current config: +536.27 GBP, PF 1.18, "
                    "maxDD 6.77%, XAUUSD M15, 13 months real ticks."),
        "thisWeekBySymbol": {k: summarise(v) for k, v in by_symbol.items()},
        "liveConfigSentry": sentry,
        # Environment, not EA performance. Kept in its own key for exactly that reason.
        "mt5AssistantPermissionsTrade": perms,
        # LIST = MT5 answered (empty means genuinely none). None = could not ask.
        "openPositions": open_ea_positions(),
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
    pre, cur = payload["preFix"], payload["current"]
    fmt = lambda d: ("%d trades, net %.2f, PF %s, win %.1f%%"
                     % (d["trades"], d["netProfit"],
                        d["profitFactor"] if d["profitFactor"] is not None else "n/a",
                        d["winRatePct"]))
    print("  --- the two eras, never pooled ---")
    print("  pre-fix   : %s" % ("no closed trades" if not pre else fmt(pre))
          + "   (v3.51 + twin, trail ON)")
    print("  v3.55 live: %s" % ("NO CLOSED TRADES YET - the fix has no live record"
                                if not cur else fmt(cur))
          + "   (trail OFF; backtest +536.27, PF 1.18)")
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
