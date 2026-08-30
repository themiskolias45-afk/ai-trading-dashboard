"""
JARVIS Daily Plan Generator
Runs every morning (or on demand). Builds a full trade plan for the day.

What it does:
  1. Fetches live signals + prices + economic calendar from server
  2. Computes key S/R levels from recent price data
  3. Generates a structured daily plan JSON
  4. Saves the plan to tasks/daily_plan_YYYYMMDD.json
  5. Optionally takes TradingView chart screenshots (node tv_screenshot.cjs)
  6. Draws the plan onto the TradingView charts (tradingview_bot.py plan)
  7. Logs to daily notes + sends morning notification

Usage:
  python tv_daily_plan.py                # full plan + draw + notification
  python tv_daily_plan.py --no-tv        # skip TV screenshots
  python tv_daily_plan.py --no-draw      # skip drawing on the charts
  python tv_daily_plan.py --silent       # no toast
  python tv_daily_plan.py --4h           # include 4H screenshots
"""
import sys, os, json, subprocess, math, time, socket
from pathlib import Path
from datetime import datetime, timezone

ROOT       = Path(__file__).parent
TASKS_DIR  = ROOT / "tasks"
SERVER_URL = "http://localhost:3001"
PYTHON     = sys.executable


def _session_cookie() -> str:
    """The session cookie value IS server/session_secret.txt.

    Same helper as check_errors.py — the routes are not opened, this script simply
    holds its own login the way the MCP server does. Missing file is NOT fatal: the
    cookie goes empty and the public routes still answer, which is exactly the
    behaviour this script had before.
    """
    try:
        return (ROOT / "server" / "session_secret.txt").read_text(encoding="utf-8").strip()
    except Exception:
        return ""


def _fetch(path: str):
    """GET one endpoint. On failure returns {"_error": ...} — and CALLERS MUST READ IT.

    Without the cookie, /api/daily-plan and /api/prices answer 401. urllib raises on
    a 401, so this function has always reported the failure correctly. The defect was
    at the other end: `_error` was written here and read NOWHERE, so every call site
    did `.get("prices", {})`, took the empty dict as data, and wrote a structurally
    valid plan carrying nothing. 22 days of morning plans with price:null for all
    three assets, exiting 0 every time. An error field with no reader is decoration.
    """
    import urllib.request
    try:
        request = urllib.request.Request(f"{SERVER_URL}{path}")
        secret = _session_cookie()
        if secret:
            request.add_header("Cookie", f"smartentry_session={secret}")
        with urllib.request.urlopen(request, timeout=6) as r:
            return json.loads(r.read().decode())
    except Exception as e:
        return {"_error": str(e)}


def _fetch_error(payload) -> str:
    """The one place that decides whether a _fetch result is usable."""
    if not isinstance(payload, dict):
        return "response was not an object"
    return payload.get("_error", "")


def _run(script: str, args: list = [], timeout: int = 30) -> str:
    try:
        result = subprocess.run(
            [PYTHON, str(ROOT / script)] + args,
            capture_output=True, text=True, timeout=timeout,
            cwd=str(ROOT), env={**os.environ, "NO_COLOR": "1"},
        )
        return (result.stdout or result.stderr or "").strip()
    except Exception as e:
        return f"[ERROR: {e}]"


def _round_band(price: float, pct: float = 0.02) -> dict:
    """Round-number band around spot. THE LAST RESORT, and it says so.

    This WAS `_key_levels` and it was the plan's only source of levels for the whole
    life of the file. It is arithmetic on spot: it knows nothing about where price
    has actually traded. On 2026-08-30 it wrote BTC "R1 80000 / S1 76000" while the
    engine's own pivots, sitting unread in the same /api/signals response, said
    r1 78544 / s1 77465. Two level systems existed and every consumer of the plan
    artifact read the invented one.

    Kept rather than deleted because it is the only source that needs no server at
    all, so a plan built with the API down still has a scale on it. It is now third
    in line and every level it produces is labelled with its source.
    """
    if not price:
        return {}
    step = price * pct
    # Round to nearest 'nice' number
    magnitude = 10 ** math.floor(math.log10(step))
    step = round(step / magnitude) * magnitude
    r1 = round((price + step) / step) * step
    r2 = round((price + step * 2) / step) * step
    s1 = round((price - step) / step) * step
    s2 = round((price - step * 2) / step) * step
    return {
        "R2": round(r2, 2), "R1": round(r1, 2),
        "pivot": round(price, 2),
        "S1": round(s1, 2), "S2": round(s2, 2),
        "source": "round-numbers",
        "caveat": "arithmetic on spot — no market structure behind these",
    }


def _zone_levels(asset_context: dict, price: float) -> dict:
    """R1/R2/S1/S2 from the CONFLUENCE ZONES, nearest first.

    A zone is a band, not a point, so the level published is the edge price meets
    FIRST: the bottom of a zone above, the top of a zone below. Publishing the
    midpoint would put every level inside the band price is meant to react at.

    Returns {} when there are not enough ranked zones, so the caller can fall
    through rather than pad the set with invented numbers.
    """
    ranked = (asset_context or {}).get("zones") or {}
    ordered = ranked.get("byConfluence") or []
    if not ordered:
        return {}

    above = sorted((z for z in ordered if z.get("side") == "above"),
                   key=lambda z: z.get("distance", 0))
    below = sorted((z for z in ordered if z.get("side") == "below"),
                   key=lambda z: z.get("distance", 0))
    if not above and not below:
        return {}

    def edge(zone, side):
        return round(zone["low"] if side == "above" else zone["high"], 2)

    def describe(zone, side):
        return {
            "price": edge(zone, side),
            "zoneLow": round(zone["low"], 2),
            "zoneHigh": round(zone["high"], 2),
            # The number that separates a level four methods agree on from one
            # pivot arithmetic invented. It is why this module exists.
            "confluence": zone.get("score"),
            "methods": zone.get("families", []),
            "distanceAtr": zone.get("distanceAtr"),
        }

    levels = {"pivot": round(price, 2), "source": "confluence-zones"}
    for index, name in enumerate(("R1", "R2")):
        if index < len(above):
            levels[name] = edge(above[index], "above")
            levels[name + "_detail"] = describe(above[index], "above")
    for index, name in enumerate(("S1", "S2")):
        if index < len(below):
            levels[name] = edge(below[index], "below")
            levels[name + "_detail"] = describe(below[index], "below")

    inside = ranked.get("priceInside")
    if inside:
        levels["insideZone"] = describe(inside, "above")
        levels["insideZone"]["price"] = round(inside["mid"], 2)
    return levels


def _pivot_levels(signal: dict, price: float) -> dict:
    """The engine's own pivots — second choice, and always better than arithmetic.

    These were in every /api/signals response the plan ever fetched and were never
    read. No server round-trip beyond the one already made.
    """
    pivots = (signal or {}).get("pivots") or {}
    if not any(pivots.get(k) is not None for k in ("r1", "r2", "s1", "s2")):
        return {}
    levels = {"pivot": round(pivots.get("pp") or price, 2), "source": "engine-pivots"}
    for out_name, in_name in (("R1", "r1"), ("R2", "r2"), ("S1", "s1"), ("S2", "s2")):
        if pivots.get(in_name) is not None:
            levels[out_name] = round(pivots[in_name], 2)
    return levels


# How many ranked zones to keep in the artifact. Enough to draw and to grade; not
# the whole clustered set, which runs to a dozen bands per asset and would triple
# the size of a file written every day and kept forever.
CONTEXT_ZONES_KEPT = 6


def _context_summary(asset_context: dict) -> dict:
    """Trim the per-asset context to what a plan needs to state and to be graded on.

    Returns {"available": False, ...} rather than None when there is no context, so
    a reader never has to distinguish "key missing" from "context missing" — the
    same reason the fetch layer here returns a dict with `_error` instead of None.
    """
    if not asset_context:
        return {"available": False, "why": "no market context for this asset"}

    zones = asset_context.get("zones") or {}
    ordered = (zones.get("byConfluence") or [])[:CONTEXT_ZONES_KEPT]
    periods = asset_context.get("periods") or {}
    prev_day = periods.get("prevDay") if periods.get("available") else None
    prev_week = (periods.get("prevWeek") or {}) if periods.get("available") else {}
    swings = asset_context.get("swings") or {}

    return {
        "available":   True,
        "atr":         asset_context.get("atr"),
        "projection":  asset_context.get("projection"),
        "priorDay":    prev_day,
        "priorWeek":   prev_week if prev_week.get("available") else None,
        "swingCounts": {
            "daily": len((swings.get("daily") or {}).get("highs", []))
                     + len((swings.get("daily") or {}).get("lows", [])),
            "h4":    len((swings.get("h4") or {}).get("highs", []))
                     + len((swings.get("h4") or {}).get("lows", [])),
        },
        "roundStep":   (asset_context.get("roundNumbers") or {}).get("step"),
        "fvgZoneCount": len(asset_context.get("fvgLevels") or []),
        "zones": [{
            "low": round(z["low"], 4), "high": round(z["high"], 4),
            "mid": round(z["mid"], 4), "side": z.get("side"),
            "confluence": z.get("score"), "methods": z.get("families", []),
            "distanceAtr": z.get("distanceAtr"),
            "members": [m.get("label") for m in (z.get("members") or [])],
        } for z in ordered],
        "zonesRelevant": zones.get("relevantCount"),
        "zonesTotal":    zones.get("totalCount"),
        # Every leg that came back empty, by name. A thin context that does not say
        # why it is thin reads exactly like a quiet market.
        "warnings":    asset_context.get("warnings", []),
        "feedsTheGate": False,
    }


def _key_levels(price: float, asset_context: dict = None, signal: dict = None) -> dict:
    """The plan's levels, best available source first.

    ORDER IS THE WHOLE POINT:
      1. confluence zones  — prior day/week, swings, EMAs, pivots, FVG edges and
                             round numbers, clustered and scored by how many
                             INDEPENDENT methods agree
      2. engine pivots     — real, computed from real bars, already in the response
      3. round-number band — arithmetic on spot, labelled as such

    Every returned dict carries `source`, so a thin plan says which rung it fell to
    instead of looking like a confident one. That is the same rule the fetch layer
    in this file already follows: an error with no reader is decoration.
    """
    if not price:
        return {}
    levels = _zone_levels(asset_context, price)
    if levels:
        return levels
    levels = _pivot_levels(signal, price)
    if levels:
        return levels
    return _round_band(price)


def build_plan():
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    now   = datetime.now(timezone.utc).isoformat()

    print(f"\n{'='*55}")
    print(f"  JARVIS DAILY PLAN — {today}")
    print(f"{'='*55}\n")

    # ── Fetch data ───────────────────────────────────────────────
    print("[plan] Fetching server data…")
    signals   = _fetch("/api/signals")
    risk      = _fetch("/api/risk-status")
    learning  = _fetch("/api/learning")
    plan_data = _fetch("/api/daily-plan")
    # Its own leg, with its own error line, rather than reached through
    # plan_data["marketContext"]. The two endpoints fail independently — /api/daily-plan
    # is gated and /api/market-context is gated separately — and a plan that lost its
    # levels because a DIFFERENT endpoint was down would report the wrong cause.
    context   = _fetch("/api/market-context")

    # Read every _error rather than letting a failed leg pass as an empty dict. These
    # become warnings on the plan itself, so a thin plan says WHY it is thin instead
    # of looking like a quiet market.
    fetch_failures = []
    for label, payload in (("/api/signals", signals), ("/api/risk-status", risk),
                           ("/api/learning", learning), ("/api/daily-plan", plan_data),
                           ("/api/market-context", context)):
        problem = _fetch_error(payload)
        if problem:
            fetch_failures.append(f"{label}: {problem}")
            print(f"  [plan] FETCH FAILED {label} — {problem}")

    prices = plan_data.get("prices", {}) if isinstance(plan_data, dict) else {}
    calendar = plan_data.get("calendar", []) if isinstance(plan_data, dict) else []

    context_ok = isinstance(context, dict) and context.get("available") is True
    context_assets = context.get("assets", {}) if context_ok else {}
    macro = context.get("macro") if context_ok else None
    if context_ok:
        # Say which rung the levels came from, once, rather than making a reader
        # infer it from the artifact. A plan whose levels came from spot arithmetic
        # and one built on four-method confluence must not read the same.
        print("[plan] market context available — levels from confluence zones")
    else:
        why = _fetch_error(context) or "unavailable"
        print(f"  [plan] NO MARKET CONTEXT ({why}) — levels fall back to engine pivots")

    # ── Build per-asset plans ────────────────────────────────────
    assets = {}
    for sym in ["btc", "gold", "spx"]:
        sig   = (signals or {}).get(sym) or {}
        asset_context = context_assets.get(sym) if isinstance(context_assets, dict) else None
        if not (isinstance(asset_context, dict) and asset_context.get("available")):
            asset_context = None
        # /api/signals is ungated and already carries a live price per asset, so if the
        # gated leg is unavailable the plan degrades to real levels rather than to
        # nothing. Same broker price, one hop earlier.
        price = prices.get(sym)
        if price is None:
            price = sig.get("price")
        levels = _key_levels(price, asset_context, sig)

        trade_plan = None
        if sig.get("signal") and sig["signal"] != "WAIT" and sig.get("entry"):
            pnl_risk   = abs((sig.get("entry") or 0) - (sig.get("stop") or 0))
            pnl_reward = abs((sig.get("target") or 0) - (sig.get("entry") or 0))
            trade_plan = {
                "direction":  sig["signal"],
                "confidence": sig.get("confidence", 0),
                "setup":      sig.get("setup", ""),
                "regime":     sig.get("regime", ""),
                "entry":      sig.get("entry"),
                "stop":       sig.get("stop"),
                "target":     sig.get("target"),
                "rr":         sig.get("rr"),
                "risk_pts":   round(pnl_risk, 2),
                "reward_pts": round(pnl_reward, 2),
            }
            print(f"  [{sym.upper()}] {sig['signal']} conf:{sig.get('confidence',0)}% "
                  f"entry:{sig.get('entry')} stop:{sig.get('stop')} target:{sig.get('target')}")
        else:
            print(f"  [{sym.upper()}] WAIT — {sig.get('regime','no regime')}")

        assets[sym] = {
            "price":      price,
            "levels":     levels,
            "trade_plan": trade_plan,
            # The depth behind the four levels above. Kept in the artifact rather
            # than recomputed later, because tasks/plan_review.cjs grades yesterday's
            # plan against what it ACTUALLY said — a level re-derived at review time
            # from today's bars would be grading a different plan.
            "context":    _context_summary(asset_context),
        }

    # ── Setup health summary ─────────────────────────────────────
    setup_stats = {}
    if isinstance(learning, dict):
        raw = learning.get("setupStats") or learning.get("setups") or {}
        for name, s in raw.items():
            wr = s.get("winRate") or (s.get("wins", 0) / max(1, s.get("wins", 0) + s.get("losses", 0)) * 100)
            setup_stats[name] = {"winRate": round(wr, 1), "total": s.get("total", 0)}

    # ── High-impact calendar events ──────────────────────────────
    hv_events = [
        {"time": e.get("date", ""), "name": e.get("title") or e.get("name", ""), "currency": e.get("currency", "")}
        for e in calendar if e.get("impact", "").lower() == "high"
    ]

    # ── Risk checks ──────────────────────────────────────────────
    warnings = []
    for failure in fetch_failures:
        warnings.append(f"⚠ this plan is incomplete — {failure}")
    risk_obj = risk if isinstance(risk, dict) else {}
    if risk_obj.get("halted"):
        warnings.append(f"TRADING HALTED: {risk_obj.get('haltReason', 'risk limit')}")
    if risk_obj.get("consecutiveLosses", 0) >= 2:
        warnings.append(f"⚠ {risk_obj['consecutiveLosses']} consecutive losses — reduce size")
    vix = prices.get("vix")
    if vix and vix > 25:
        warnings.append(f"⚠ VIX={vix:.1f} — high volatility, widen stops or skip")
    if hv_events:
        warnings.append(f"⚠ {len(hv_events)} high-impact events today — check calendar")
    if not context_ok:
        warnings.append("⚠ levels are NOT confluence-ranked — market context was unavailable")
    else:
        # A day that has already travelled its whole normal range is a fact worth
        # putting on the plan. It is a DESCRIPTION, not an instruction: nothing here
        # suppresses a setup, and the engine never sees it. Rule 3 stands.
        for sym, block in assets.items():
            projection = ((block.get("context") or {}).get("projection")) or {}
            if projection.get("available") and (projection.get("rangeUsedPct") or 0) >= 100:
                warnings.append(
                    f"{sym.upper()}: {projection['rangeUsedPct']}% of a normal day's ATR range "
                    f"already travelled — {projection.get('reading')}")

    # ── Assemble plan ────────────────────────────────────────────
    plan = {
        "date":        today,
        "generatedAt": now,
        "assets":      assets,
        "prices":      prices,
        "risk":        risk_obj,
        "setup_health": setup_stats,
        "calendar":    hv_events,
        "warnings":    warnings,
        # The dollar's DIRECTION, the volatility regime in words, and the
        # cross-asset correlations. DXY and VIX were fetched every cycle and
        # interpreted nowhere — a Gold plan that does not know where the dollar is
        # going is missing the other half of its own instrument.
        "macro":       macro,
        # Which rung the levels came from, at plan level, so a reader does not have
        # to open an asset block to find out.
        "levelsSource": (assets.get("btc", {}).get("levels", {}) or {}).get("source"),
    }

    # ── Save ─────────────────────────────────────────────────────
    TASKS_DIR.mkdir(exist_ok=True)
    out = TASKS_DIR / f"daily_plan_{today}.json"
    out.write_text(json.dumps(plan, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\n[plan] Saved: {out}")

    return plan


def run_tv_screenshots(do_4h: bool = False):
    """Take TradingView screenshots using the Node.js tool."""
    node_script = ROOT / "tv_screenshot.cjs"
    if not node_script.exists():
        print("[plan] tv_screenshot.cjs not found — skipping screenshots")
        return

    import shutil
    node = shutil.which("node") or shutil.which("node.exe") or "node"
    args = [node, str(node_script)]
    if do_4h:
        args.append("--4h")

    print("[plan] Taking TradingView screenshots…")
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=120, cwd=str(ROOT))
        output = (result.stdout or result.stderr or "").strip()
        print(output[:400] if output else "  [no output]")
    except subprocess.TimeoutExpired:
        print("[plan] Screenshot timeout — charts may be slow to load")
    except Exception as e:
        print(f"[plan] Screenshot error: {e}")


def _cdp_is_up(port: int = 9222) -> bool:
    """tradingview_bot drives Edge over CDP, so the port is the real precondition."""
    with socket.socket() as probe:
        probe.settimeout(2)
        return probe.connect_ex(("127.0.0.1", port)) == 0


def run_tv_draw():
    """
    Draw the plan onto the TradingView charts.

    Starts the debugging Edge if it is not already up, because an unattended
    morning run has nobody to launch it. Skips rather than fails: a missing chart
    drawing must never take down the plan, the notes, or the notification.
    """
    if not (ROOT / "tradingview_bot.py").exists():
        print("[plan] tradingview_bot.py not found — skipping chart drawing")
        return

    if not _cdp_is_up():
        launcher = TASKS_DIR / "launch_chrome_tv.bat"
        if not launcher.exists():
            print("[plan] Edge is not on CDP 9222 and launch_chrome_tv.bat is missing — skipping")
            return
        print("[plan] Edge not on 9222 — launching it…")
        try:
            subprocess.Popen(["cmd", "/c", str(launcher)], cwd=str(ROOT),
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception as exc:
            print(f"[plan] Could not launch Edge: {exc}")
            return
        for _ in range(20):
            time.sleep(2)
            if _cdp_is_up():
                break
        else:
            print("[plan] Edge never opened port 9222 — skipping chart drawing")
            return

    print("[plan] Drawing the daily plan on TradingView…")
    output = _run("tradingview_bot.py", ["plan"], timeout=420)
    print(output[-600:] if output else "  [no output]")


def notify(plan: dict, silent: bool = False):
    if silent:
        return
    assets = plan.get("assets", {})
    signals_str = " | ".join(
        f"{sym.upper()} {a['trade_plan']['direction']} {a['trade_plan']['confidence']}%"
        if a.get("trade_plan") else f"{sym.upper()} WAIT"
        for sym, a in assets.items()
    )
    warnings = plan.get("warnings", [])
    w_str = " | " + warnings[0] if warnings else ""
    msg = f"Daily Plan ready: {signals_str}{w_str}"
    _run("notifications.py", ["alert", msg, "--title", "JARVIS Daily Plan"], timeout=15)


def log_to_notes(plan: dict):
    today = plan.get("date", "")
    assets = plan.get("assets", {})
    lines = [f"Daily Plan {today} (levels: {plan.get('levelsSource', 'unknown')}):"]
    for sym, a in assets.items():
        tp = a.get("trade_plan")
        levels = a.get("levels") or {}
        # The two levels price has to deal with next, on the note itself. The note is
        # the durable record — it survives when the artifact is regenerated — so the
        # levels belong in it, not only in the JSON.
        band = " ".join(f"{name} {levels[name]}" for name in ("R1", "S1") if levels.get(name) is not None)
        if tp:
            lines.append(f"  {sym.upper()} {tp['direction']} {tp['confidence']}% entry:{tp['entry']} stop:{tp['stop']} target:{tp['target']} | {band}")
        else:
            lines.append(f"  {sym.upper()} WAIT | {band}")
    for note in (plan.get("macro") or {}).get("notes", []):
        lines.append(f"  MACRO {note}")
    for w in plan.get("warnings", []):
        lines.append(f"  {w}")
    note = " | ".join(lines)
    _run("daily_notes.py", ["log", note, "PLAN"], timeout=15)
    _run("memory.py", ["add", f"PLAN_{today.replace('-','')}", note[:200], "TRADE"], timeout=15)


def main():
    argv    = sys.argv[1:]
    silent  = "--silent" in argv
    no_tv   = "--no-tv" in argv
    no_draw = "--no-draw" in argv
    do_4h   = "--4h" in argv

    plan = build_plan()

    # ORDER IS A DURABILITY DECISION, NOT A STYLE ONE.
    #
    # This used to run the browser work FIRST and the record-keeping after it. The
    # scheduled caller (server/index.js, DAILY_PLAN_TIMEOUT_MS = 60s) then killed the
    # process inside run_tv_draw, which takes ~2.5 minutes -- so log_to_notes() and
    # notify() never ran, on every scheduled run. build_plan() had already written the
    # JSON artifact, so the file on disk said the plan SUCCEEDED while the daily note
    # and the PLAN_YYYYMMDD memory row were silently lost. That is why "daily plan
    # history 64% over 14 days" survived a fix already recorded as done.
    #
    # Cheap and irreplaceable work now happens BEFORE expensive and repeatable work.
    # A timeout can still truncate the charts; it can no longer eat the record.
    log_to_notes(plan)
    notify(plan, silent=silent)

    if not no_tv:
        run_tv_screenshots(do_4h=do_4h)

    if not no_draw:
        run_tv_draw()

    # Print morning briefing
    print("\nMORNING BRIEFING:")
    print("-" * 55)
    for sym, a in plan.get("assets", {}).items():
        tp = a.get("trade_plan")
        if tp:
            print(f"  {sym.upper()}: {tp['direction']} | conf:{tp['confidence']}% | "
                  f"entry:{tp['entry']} stop:{tp['stop']} target:{tp['target']} R:R 1:{tp['rr']}")
        else:
            p = a.get("price")
            print(f"  {sym.upper()}: WAIT | price:{p}")
        # The levels, with the number that says how much to trust each one. A level
        # four independent methods agree on and one pivot arithmetic invented used
        # to print identically; the confluence count is the whole difference.
        levels = a.get("levels") or {}
        for name in ("R2", "R1", "S1", "S2"):
            if levels.get(name) is None:
                continue
            detail = levels.get(name + "_detail") or {}
            if detail.get("confluence"):
                print(f"      {name} {levels[name]}  x{detail['confluence']} "
                      f"[{', '.join(detail.get('methods', []))}]  {detail.get('distanceAtr')} ATR away")
            else:
                print(f"      {name} {levels[name]}  ({levels.get('source', 'unknown source')})")
        projection = ((a.get("context") or {}).get("projection")) or {}
        if projection.get("available"):
            print(f"      day range {projection['rangeUsedPct']}% used — {projection['reading']} "
                  f"(ATR band {round(projection['expectedLow'], 2)}–{round(projection['expectedHigh'], 2)})")
    macro_block = plan.get("macro") or {}
    for note in macro_block.get("notes", []):
        print(f"  MACRO: {note}")
    for correlation in macro_block.get("correlations", []):
        print(f"  MACRO: {correlation.get('note')}")
    for w in plan.get("warnings", []):
        print(f"  {w}")
    print("-" * 55)
    print(f"\n  Dashboard: http://localhost:3001/daily-plan\n")


if __name__ == "__main__":
    main()
