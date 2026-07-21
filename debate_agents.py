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

# ─── Claude CLI resolution ────────────────────────────────────────────────────

_CLAUDE_CMD = None  # resolved lazily on first use


def find_claude() -> str:
    """Find the claude CLI executable — checks PATH, APPDATA/npm, and a known fallback."""
    import shutil

    found = shutil.which("claude") or shutil.which("claude.cmd")
    if found:
        return found

    appdata = os.environ.get("APPDATA", "")
    if appdata:
        p = Path(appdata) / "npm" / "claude.cmd"
        if p.exists():
            return str(p)

    # Hardcoded known path for this machine
    p = Path(r"C:\Users\User\AppData\Roaming\npm\claude.cmd")
    if p.exists():
        return str(p)

    raise FileNotFoundError(
        "claude CLI not found. Run: npm install -g @anthropic-ai/claude-code"
    )


def _claude() -> str:
    global _CLAUDE_CMD
    if _CLAUDE_CMD is None:
        _CLAUDE_CMD = find_claude()
    return _CLAUDE_CMD


# ─── Single agent runner ──────────────────────────────────────────────────────

def _run_agent(role: str, prompt: str) -> dict:
    """Call the claude CLI with the given prompt and return raw output."""
    print(f"  [{role}] starting...")
    t0 = time.time()

    try:
        proc = subprocess.run(
            [_claude(), "-p", prompt,
             "--dangerously-skip-permissions",
             "--output-format", "text"],
            capture_output=True,
            text=True,
            cwd=str(WORK_DIR),
            timeout=TIMEOUT,
            env={**os.environ, "NO_COLOR": "1"},
        )
        output  = proc.stdout.strip() or proc.stderr.strip()
        success = proc.returncode == 0
    except subprocess.TimeoutExpired:
        output  = f"[TIMEOUT after {TIMEOUT}s]"
        success = False
    except FileNotFoundError:
        output  = "[ERROR: claude CLI not found — run from JARVIS terminal]"
        success = False

    elapsed = time.time() - t0
    status  = "done" if success else "failed"
    print(f"  [{role}] {status} in {elapsed:.0f}s")

    return {"role": role, "output": output, "elapsed": elapsed, "success": success}


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


# ─── Core debate function ─────────────────────────────────────────────────────

def debate_signal(
    symbol: str,
    direction: str,
    confidence: float,
    entry: float,
    stop: float,
    target: float,
) -> dict:
    """
    Run Bull, Bear, and Risk Manager agents in parallel to debate a signal.

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

    signal_summary = (
        f"Symbol: {symbol} | Direction: {direction.upper()} | "
        f"Confidence: {confidence}% | Entry: {entry} | Stop: {stop} | "
        f"Target: {target} | R:R = {rr}:1"
    )

    bull_prompt = (
        "You are a bull-biased trading analyst. "
        "Find every reason this trade SHOULD be taken. "
        f"Signal: {signal_summary}. "
        "Make the bull case in 5 bullet points covering: trend alignment, momentum, "
        "key support/resistance, pattern confirmation, and timing. "
        "End your response with exactly: VERDICT: TAKE or VERDICT: SKIP"
    )

    bear_prompt = (
        "You are a bear-biased trading analyst and skeptic. "
        "Find every reason this trade should NOT be taken. "
        f"Signal: {signal_summary}. "
        "Make the bear case in 5 bullet points covering: trend risk, "
        "counter-signals, key resistance/support threats, macro headwinds, "
        "and timing concerns. "
        "End your response with exactly: VERDICT: TAKE or VERDICT: SKIP"
    )

    risk_prompt = (
        "You are a risk manager. Evaluate this signal purely on risk/reward and "
        "capital preservation. "
        f"Signal: {signal_summary}. "
        f"R:R = {rr}:1. Account risk = 1% per trade. "
        "Check whether the trade is structurally safe regardless of directional bias. "
        "Evaluate in 5 bullet points: R:R adequacy, stop placement quality, "
        "position sizing feasibility, drawdown scenario, and max adverse excursion risk. "
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

    # ── Print formatted output ──
    print(format_debate(result))

    # ── Save JSON to tasks/ ──
    tasks_dir = WORK_DIR / "tasks"
    tasks_dir.mkdir(exist_ok=True)

    timestamp   = time.strftime("%Y%m%d_%H%M%S")
    output_path = tasks_dir / f"debate_{symbol}_{timestamp}.json"
    output_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(f"[SAVED] {output_path}")

    # ── Exit code reflects verdict for scripted callers ──
    sys.exit(0 if result["verdict"] == "TAKE" else 1)


if __name__ == "__main__":
    main()
