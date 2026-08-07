"""
JARVIS Signal Debate Engine
3 independent AI agents debate every signal before it fires.
Bull vs Bear vs Risk Manager — majority vote decides.
Higher quality decisions through adversarial reasoning.

Usage:
  python debate_agents.py BTC LONG 87 105000 103500 107000
  python debate_agents.py --from-api  # read latest signal from server
"""
import sys, os, json, subprocess, time
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

WORK_DIR = Path(__file__).parent
TIMEOUT  = 300

# The agents answer in prose and use unicode freely (minus signs, em dashes,
# arrows). A Windows console defaults to cp1252 and raises on all of them, so
# make stdout tolerant rather than losing a run to a display character.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

# CLI discovery, environment and working directory all live in claude_agent now —
# they were duplicated across five files and four copies were wrong.

# ─── Single agent runner ──────────────────────────────────────────────────────

def _run_agent(role: str, prompt: str) -> dict:
    """
    Run one debate agent.

    All the CLI handling lives in claude_agent so it cannot drift again: prompt on
    stdin (cmd.exe truncates argv at the first newline), ANTHROPIC_API_KEY stripped
    (it bills credit that has already run dry once), and a working directory
    outside the project (otherwise the agent boots as JARVIS and greets instead of
    voting). needs_project is False — the whole market picture is in the prompt.

    require="VERDICT:" because a clean exit code proves nothing: all three agents
    exited 0 while two of them were answering "I don't have the trade to analyse".
    """
    from claude_agent import run_claude

    print(f"  [{role}] starting...")
    result = run_claude(prompt, timeout=TIMEOUT, needs_project=False,
                        label=role, require="VERDICT:")

    if not result["success"] and "VERDICT" not in result["output"].upper():
        print(f"  [{role}] returned no VERDICT line — prompt may not have arrived")
    status = "done" if result["success"] else "failed"
    print(f"  [{role}] {status} in {result['elapsed']:.0f}s")

    return {"role": role, "output": result["output"],
            "elapsed": result["elapsed"], "success": result["success"]}


# ─── Verdict parser ───────────────────────────────────────────────────────────

def _parse_verdict(output: str) -> str:
    """
    Extract TAKE or SKIP from an agent's output.
    Looks for the last occurrence of 'VERDICT: TAKE' or 'VERDICT: SKIP'
    (case-insensitive) so intro text can't shadow the real verdict.
    Returns 'TAKE', 'SKIP', or 'UNKNOWN' if nothing matched.
    """
    upper = output.upper()
    last_take = upper.rfind("VERDICT: TAKE")
    last_skip = upper.rfind("VERDICT: SKIP")

    if last_take == -1 and last_skip == -1:
        return "UNKNOWN"
    if last_take > last_skip:
        return "TAKE"
    return "SKIP"


# ─── R:R calculator ──────────────────────────────────────────────────────────

def _calc_rr(direction: str, entry: float, stop: float, target: float) -> float:
    """Return Risk:Reward ratio as a float rounded to 2 dp. Returns 0.0 on bad inputs."""
    try:
        if direction.upper() == "LONG":
            risk   = entry - stop
            reward = target - entry
        else:
            risk   = stop - entry
            reward = entry - target

        if risk <= 0:
            return 0.0
        return round(reward / risk, 2)
    except (TypeError, ZeroDivisionError):
        return 0.0


# ─── Market context fetcher ───────────────────────────────────────────────────

def _normalize_symbol_key(symbol: str) -> str:
    s = symbol.lower().replace("-", "").replace("_", "").replace("/", "")
    if s in ("btc", "bitcoin", "btcusd", "btcusdt"):
        return "btc"
    if s in ("gold", "xauusd", "gcf", "xau"):
        return "gold"
    if s in ("spx", "spy", "sp500", "spx500", "gspc"):
        return "spx"
    return s


def _fetch_market_context(symbol: str) -> dict:
    """Fetch full signal + macro data from SmartEntry Pro server."""
    import urllib.request
    sym_key = _normalize_symbol_key(symbol)
    ctx: dict = {"sym_key": sym_key, "signal": {}, "dxy": None, "dxyChange": None, "vix": None,
                 "setup_stats": {}, "cross": {}}
    try:
        with urllib.request.urlopen("http://localhost:3001/api/signals", timeout=5) as r:
            signals = json.loads(r.read().decode())
            ctx["signal"] = signals.get(sym_key, {}) or {}
            # grab cross-asset signals for gate context
            for k in ("btc", "gold", "spx"):
                if k != sym_key:
                    ctx["cross"][k] = signals.get(k, {}).get("signal", "WAIT")
    except Exception:
        pass
    try:
        with urllib.request.urlopen("http://localhost:3001/api/prices", timeout=5) as r:
            prices = json.loads(r.read().decode())
            ctx["dxy"]       = prices.get("dxy")
            ctx["dxyChange"] = prices.get("dxyChange")
            ctx["vix"]       = prices.get("vix")
    except Exception:
        pass
    try:
        with urllib.request.urlopen("http://localhost:3001/api/learning", timeout=5) as r:
            learning = json.loads(r.read().decode())
            setup = ctx["signal"].get("setup", "")
            ctx["setup_stats"] = (learning.get("setupStats") or {}).get(setup, {}) or {}
    except Exception:
        pass
    return ctx


def _build_context_str(symbol: str, direction: str, entry: float, stop: float,
                        target: float, rr: float, confidence: float, ctx: dict) -> str:
    sig  = ctx.get("signal", {}) or {}
    ind  = sig.get("indicators", {}) or {}
    bb   = ind.get("bb", {}) or {}
    macd = ind.get("macd", {}) or {}
    h4   = sig.get("h4") or {}
    h1   = sig.get("h1") or {}
    vol  = sig.get("volume", {}) or {}
    pivs = sig.get("pivots") or {}
    ss   = ctx.get("setup_stats", {}) or {}
    cross = ctx.get("cross", {})

    ema200 = ind.get("ema200")
    price_vs_ema = "ABOVE" if ema200 and entry > ema200 else "BELOW" if ema200 else "N/A"

    setup_line = "No history."
    if ss:
        w = ss.get("wins", 0); l = ss.get("losses", 0); tot = w + l
        wr = round(w / max(tot, 1) * 100, 1)
        setup_line = f"{sig.get('setup','?')}: {tot} trades | {wr}% WR | avg R:R {ss.get('avgRR', 'N/A')}"

    pivot_line = (f"R2:{pivs.get('r2','?')} R1:{pivs.get('r1','?')} "
                  f"PP:{pivs.get('pp','?')} S1:{pivs.get('s1','?')} S2:{pivs.get('s2','?')}"
                  if pivs else "N/A")

    cross_line = " | ".join(f"{k.upper()}={v}" for k, v in cross.items()) or "N/A"

    reasons = "\n  ".join(sig.get("reasons", [])[:10]) or "none"

    return (
        f"=== FULL MARKET PICTURE: {symbol} ===\n"
        f"SIGNAL:     {direction.upper()} | Confidence: {confidence}% | R:R {rr}:1\n"
        f"TRADE:      Entry: {entry} | Stop: {stop} | Target: {target}\n\n"
        f"DAILY TECHNICALS\n"
        f"  Trend:    {sig.get('trend','N/A')} | Regime: {sig.get('regime','N/A')} | Setup: {sig.get('setup','N/A')}\n"
        f"  RSI(14):  {ind.get('rsi','N/A')}\n"
        f"  MACD:     value={macd.get('value','N/A')} signal={macd.get('signal','N/A')} hist={macd.get('histogram','N/A')}\n"
        f"  BB:       bandwidth={bb.get('bandwidth','N/A')}% upper={bb.get('upper','N/A')} lower={bb.get('lower','N/A')}\n"
        f"  EMA200:   {ema200 if ema200 else 'N/A'} | Price {price_vs_ema} EMA200\n"
        f"  Volume:   ratio={vol.get('ratio','N/A')}x | confirmed={vol.get('confirmed',False)}\n\n"
        f"TIMEFRAMES\n"
        f"  4H:  signal={h4.get('signal','N/A')} trend={h4.get('trend','N/A')} RSI={h4.get('rsi','N/A')}\n"
        f"  1H:  signal={h1.get('signal','N/A')} trend={h1.get('trend','N/A')} RSI={h1.get('rsi','N/A')}\n\n"
        f"MACRO\n"
        f"  DXY:  {ctx.get('dxy','N/A')} (change: {ctx.get('dxyChange','N/A')}%)\n"
        f"  VIX:  {ctx.get('vix','N/A')}\n\n"
        f"CROSS-ASSET SIGNALS\n"
        f"  {cross_line}\n\n"
        f"PIVOT LEVELS\n"
        f"  {pivot_line}\n\n"
        f"SETUP HISTORY\n"
        f"  {setup_line}\n\n"
        f"SYSTEM REASONING\n"
        f"  {reasons}"
    )


# ─── Core debate function ─────────────────────────────────────────────────────

def debate_signal(
    symbol: str,
    direction: str,
    confidence: float,
    entry: float,
    stop: float,
    target: float,
    market_data: dict = None,
) -> dict:
    """
    Run Bull, Bear, and Risk Manager agents in parallel to debate a signal.
    Fetches full market data from server so agents reason on real technicals.

    Returns:
        {
            "symbol":     str,
            "direction":  str,
            "confidence": float,
            "entry":      float,
            "stop":       float,
            "target":     float,
            "rr":         float,
            "verdict":    "TAKE" | "SKIP",
            "votes":      {"bull": str, "bear": str, "risk": str},
            "bullCase":   str,
            "bearCase":   str,
            "riskCase":   str,
            "reasoning":  str,
            "wall_time":  float,
        }
    """
    rr = _calc_rr(direction, entry, stop, target)

    ctx = market_data if isinstance(market_data, dict) else _fetch_market_context(symbol)
    context_str = _build_context_str(symbol, direction, entry, stop, target, rr, confidence, ctx)

    bull_prompt = (
        "You are a bull-biased trading analyst with access to the full market picture. "
        "Your job: find every REAL reason this trade SHOULD be taken, grounded in the actual data below.\n\n"
        f"{context_str}\n\n"
        "Make the bull case in 5 bullet points. Use the actual RSI, MACD, BB, trend, "
        "volume, timeframe alignment, and pivot levels shown above — no generic statements. "
        "Address the cross-asset signals and macro picture. "
        "End your response with exactly: VERDICT: TAKE or VERDICT: SKIP"
    )

    bear_prompt = (
        "You are a bear-biased trading analyst and skeptic with access to the full market picture. "
        "Your job: find every REAL reason this trade should NOT be taken, based on the actual data below.\n\n"
        f"{context_str}\n\n"
        "Make the bear case in 5 bullet points. Use the actual RSI, MACD, BB bandwidth, "
        "trend vs timeframe conflicts, volume, macro headwinds, and pivot resistance shown above. "
        "Do not invent risks — point to real signals in the data. "
        "End your response with exactly: VERDICT: TAKE or VERDICT: SKIP"
    )

    risk_prompt = (
        "You are a risk manager evaluating this trade on structural safety. "
        "You have the full market picture below — use it.\n\n"
        f"{context_str}\n\n"
        "Evaluate in 5 bullet points: "
        "(1) R:R adequacy vs the actual pivot levels and volatility (BB bandwidth), "
        "(2) stop placement quality relative to key S/R and ATR, "
        "(3) whether regime and VIX support this risk size, "
        "(4) cross-asset alignment — are other markets confirming or diverging, "
        "(5) setup history win rate — does the track record justify the risk? "
        f"R:R = {rr}:1. Account risk = 1% per trade. "
        "End your response with exactly: VERDICT: TAKE or VERDICT: SKIP"
    )

    agents = [
        {"role": "BULL", "prompt": bull_prompt},
        {"role": "BEAR", "prompt": bear_prompt},
        {"role": "RISK", "prompt": risk_prompt},
    ]

    print(f"\n[DEBATE] {symbol} {direction.upper()} @ {entry} — launching 3 agents...")
    wall_start = time.time()

    raw_results = {}
    with ThreadPoolExecutor(max_workers=3) as pool:
        futures = {pool.submit(_run_agent, a["role"], a["prompt"]): a["role"]
                   for a in agents}
        for future in as_completed(futures):
            res = future.result()
            raw_results[res["role"]] = res

    wall_time = round(time.time() - wall_start, 1)

    bull_output = raw_results["BULL"]["output"]
    bear_output = raw_results["BEAR"]["output"]
    risk_output = raw_results["RISK"]["output"]

    bull_vote = _parse_verdict(bull_output)
    bear_vote = _parse_verdict(bear_output)
    risk_vote = _parse_verdict(risk_output)

    votes = {"bull": bull_vote, "bear": bear_vote, "risk": risk_vote}
    take_count = sum(1 for v in votes.values() if v == "TAKE")
    skip_count = sum(1 for v in votes.values() if v == "SKIP")

    if take_count >= 2:
        verdict = "TAKE"
    elif skip_count >= 2:
        verdict = "SKIP"
    else:
        # All three gave UNKNOWN or a split with unknowns — default to SKIP (safety)
        verdict = "SKIP"

    # Human-readable reasoning summary
    vote_labels = []
    for role, vote in [("Bull", bull_vote), ("Bear", bear_vote), ("Risk Mgr", risk_vote)]:
        vote_labels.append(f"{role}={vote}")
    reasoning = (
        f"Votes: {', '.join(vote_labels)} | "
        f"TAKE={take_count} SKIP={skip_count} | "
        f"Final: {verdict} (majority {'achieved' if max(take_count, skip_count) >= 2 else 'not achieved — defaulted SKIP'})"
    )

    return {
        "symbol":     symbol,
        "direction":  direction.upper(),
        "confidence": confidence,
        "entry":      entry,
        "stop":       stop,
        "target":     target,
        "rr":         rr,
        "verdict":    verdict,
        "votes":      votes,
        "bullCase":   bull_output,
        "bearCase":   bear_output,
        "riskCase":   risk_output,
        "reasoning":  reasoning,
        "wall_time":  wall_time,
    }


# ─── Formatter ────────────────────────────────────────────────────────────────

def format_debate(result: dict) -> str:
    """Return a clean, human-readable summary of the debate result."""
    SEP  = "=" * 65
    LINE = "-" * 65

    def vote_badge(vote: str) -> str:
        return "[ TAKE ]" if vote == "TAKE" else "[ SKIP ]" if vote == "SKIP" else "[  ??  ]"

    lines = [
        "",
        SEP,
        "  JARVIS SIGNAL DEBATE ENGINE",
        SEP,
        f"  Symbol    : {result['symbol']}",
        f"  Direction : {result['direction']}",
        f"  Confidence: {result['confidence']}%",
        f"  Entry     : {result['entry']}",
        f"  Stop      : {result['stop']}",
        f"  Target    : {result['target']}",
        f"  R:R       : {result['rr']}:1",
        LINE,
        "",
        f"  BULL ANALYST  {vote_badge(result['votes']['bull'])}",
        LINE,
        result["bullCase"],
        "",
        LINE,
        f"  BEAR ANALYST  {vote_badge(result['votes']['bear'])}",
        LINE,
        result["bearCase"],
        "",
        LINE,
        f"  RISK MANAGER  {vote_badge(result['votes']['risk'])}",
        LINE,
        result["riskCase"],
        "",
        SEP,
        f"  VOTES : Bull={result['votes']['bull']}  Bear={result['votes']['bear']}  Risk={result['votes']['risk']}",
        f"  TIME  : {result['wall_time']}s wall time",
        "",
    ]

    # Final verdict block
    verdict = result["verdict"]
    if verdict == "TAKE":
        lines.append(f"  *** FINAL VERDICT: TAKE {result['symbol']} {result['direction']} ***")
    else:
        lines.append(f"  *** FINAL VERDICT: SKIP — debate rejected this signal ***")

    lines += [
        f"  {result['reasoning']}",
        SEP,
        "",
    ]

    return "\n".join(lines)


# ─── Entrypoint ───────────────────────────────────────────────────────────────

def main():
    argv = sys.argv[1:]

    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        sys.exit(0)

    # ── --from-api: fetch latest signal from the SmartEntry Pro server ──
    if argv[0] == "--from-api":
        import urllib.request
        url = "http://localhost:3001/api/signals"
        try:
            with urllib.request.urlopen(url, timeout=5) as resp:
                data = json.loads(resp.read().decode())
        except Exception as exc:
            print(f"[ERROR] Could not reach {url}: {exc}")
            sys.exit(1)

        # Accept either a single signal dict or a list; take the first/latest
        if isinstance(data, list):
            if not data:
                print("[INFO] No signals returned from server.")
                sys.exit(0)
            signal = data[0]
        else:
            signal = data

        try:
            symbol     = signal["symbol"]
            direction  = signal["direction"]
            confidence = float(signal.get("confidence", 0))
            entry      = float(signal["entry"])
            stop       = float(signal["stop"])
            target     = float(signal["target"])
        except (KeyError, TypeError, ValueError) as exc:
            print(f"[ERROR] Unexpected signal format from API: {exc}")
            print(f"  Raw response: {json.dumps(signal, indent=2)}")
            sys.exit(1)

    # ── Positional args: symbol direction confidence entry stop target ──
    else:
        if len(argv) < 6:
            print("Usage: python debate_agents.py SYMBOL DIRECTION CONFIDENCE ENTRY STOP TARGET")
            print("       python debate_agents.py --from-api")
            sys.exit(1)

        symbol     = argv[0]
        direction  = argv[1]
        try:
            confidence = float(argv[2])
            entry      = float(argv[3])
            stop       = float(argv[4])
            target     = float(argv[5])
        except ValueError as exc:
            print(f"[ERROR] Numeric argument parse failed: {exc}")
            sys.exit(1)

    # ── Run the debate ──
    result = debate_signal(symbol, direction, confidence, entry, stop, target)

    # ── Save JSON to tasks/ FIRST ──
    # Printing used to come first, and a console that could not encode a unicode
    # minus sign took the whole run down before anything was written — three
    # agents and two minutes of work discarded over a display character.
    tasks_dir = WORK_DIR / "tasks"
    tasks_dir.mkdir(exist_ok=True)

    timestamp   = time.strftime("%Y%m%d_%H%M%S")
    output_path = tasks_dir / f"debate_{symbol}_{timestamp}.json"
    output_path.write_text(json.dumps(result, indent=2), encoding="utf-8")

    # ── Then print ──
    print(format_debate(result))
    print(f"[SAVED] {output_path}")

    # ── Exit code reflects verdict for scripted callers ──
    sys.exit(0 if result["verdict"] == "TAKE" else 1)


if __name__ == "__main__":
    main()
