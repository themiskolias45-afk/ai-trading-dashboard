"""JARVIS Parallel Analysis Engine.

Runs several Claude analysts at once over the SAME measured fact pack, then has a
synthesiser merge them into a ranked list of proposals, and puts every proposal
that names a tunable setting through the existing evidence gate.

Why it is built this way:

  The numbers are computed HERE, in Python, before any agent starts. Agents are
  given the fact pack and told to interpret it; they are never asked to count
  anything. An agent that is asked "how did MOMENTUM do?" will confidently invent
  a win rate, and a confident invented number is worse than no analysis at all.
  Every figure an agent quotes can be traced back to a row in the fact pack.

  The aggregation reuses summarise() and COST_R from tasks/evaluate_change.py, so
  the win rate an analyst reasons about is arithmetically the same one the
  evidence gate will later judge a change by. Two implementations would drift and
  the analysis would slowly start describing a system nobody runs.

  Nothing here edits the trading engine. Proposals come out ranked and, where the
  replay can measure them, carry a verdict from evaluate_change.py. Applying is a
  separate, deliberate act.

Usage:
  python parallel_analysis.py                      # full run, D1 + H4
  python parallel_analysis.py --tf D1              # faster, daily bars only
  python parallel_analysis.py --facts-only         # build the fact pack, no agents
  python parallel_analysis.py --no-gate            # skip the replay verdicts
"""

import argparse
import json
import os
import sys
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.abspath(__file__))
HIST_DIR = os.path.join(ROOT, "tasks", "history")
OUT_DIR = os.path.join(ROOT, "tasks", "analysis")
REPLAY = os.path.join(ROOT, "tasks", "_replay_engine.cjs")
SERVER_URL = "http://localhost:3001"

sys.path.insert(0, os.path.join(ROOT, "tasks"))
from evaluate_change import summarise, COST_R, AUTO_TUNABLE  # noqa: E402

import parallel_agents  # noqa: E402
from parallel_agents import run_agent  # noqa: E402

SYMBOLS = [("BTCUSD", "BTC"), ("XAUUSD", "Gold"), ("SP500", "SPX")]

# Analysts think for longer than the 300s a build agent needs. run_agent reads
# this module global at call time, so raising it here raises it for the pool.
AGENT_TIMEOUT_SEC = 600
parallel_agents.TIMEOUT = AGENT_TIMEOUT_SEC

# A bucket below this many closed trades is noise. Reported, but never used as
# the basis of a recommendation - the same 5-trade floor getLearningBoost uses.
MIN_SAMPLE = 5

# The fact pack goes to the agents as a FILE, never inside the prompt string.
# Windows caps a process command line at ~32K characters; a D1+H4 fact pack is
# several times that, so passing it as an argv made CreateProcess fail instantly
# and every agent "failed in 0s" with what looked like a missing CLI. Handing
# over a path also means the analysts read byte-for-byte the same file that is
# archived next to the report.
PROMPT_SIZE_LIMIT = 8000

REPLAY_TIMEOUT_SEC = 900
MAX_PARALLEL_REPLAYS = 6

# Analysts run from a scratch directory OUTSIDE the project on purpose. An agent
# started inside ai-trading-dashboard loads the project's CLAUDE.md, adopts the
# JARVIS persona, opens with the welcome line instead of an answer, and — because
# that file says to double-confirm before writing anything — refuses to create its
# own output file and asks for permission no one is there to give. Every path the
# analysts touch is absolute, so nothing is lost by starting them elsewhere.
AGENT_SYSTEM_PROMPT = (
    "You are a non-interactive analysis subprocess in an automated pipeline. "
    "There is no human reading your output and no one to answer a question. "
    "Never greet, never introduce yourself, never ask for confirmation. "
    "Write the file you are asked to write, then stop."
)


# ── fact pack ────────────────────────────────────────────────────────────────

def run_replay(symbol, timeframe):
    """Replay one symbol/timeframe. Returns (trades, error)."""
    import subprocess
    path = os.path.join(HIST_DIR, f"{symbol}_{timeframe}.csv")
    if not os.path.exists(path):
        return [], f"no history file {symbol}_{timeframe}.csv"
    try:
        proc = subprocess.run(["node", REPLAY, path], capture_output=True, text=True,
                              timeout=REPLAY_TIMEOUT_SEC, cwd=ROOT)
    except subprocess.TimeoutExpired:
        return [], f"{symbol} {timeframe} replay timed out after {REPLAY_TIMEOUT_SEC}s"
    except FileNotFoundError:
        return [], "node not found on PATH"
    if proc.returncode != 0:
        return [], (proc.stderr or "replay failed").strip()[:200]
    try:
        return json.loads(proc.stdout), None
    except json.JSONDecodeError as exc:
        return [], f"unparseable replay output: {exc}"


def bucket_of(trade, field, edges):
    """Label a numeric field by which band it falls in. None stays None so an
    absent indicator is never silently counted as zero."""
    value = trade.get(field)
    if value is None:
        return None
    for upper, label in edges:
        if value < upper:
            return label
    return edges[-1][1]


ADX_EDGES = [(20, "adx<20"), (30, "adx20-30"), (float("inf"), "adx>=30")]
RSI_EDGES = [(35, "rsi<35"), (50, "rsi35-50"), (65, "rsi50-65"), (float("inf"), "rsi>=65")]
VOL_EDGES = [(0.8, "vol<0.8x"), (1.5, "vol0.8-1.5x"), (float("inf"), "vol>=1.5x")]


def group_stats(trades, key_fn):
    """Aggregate trades by a key, using the evidence gate's own summariser."""
    groups = defaultdict(list)
    for trade in trades:
        key = key_fn(trade)
        if key is not None:
            groups[key].append(trade)
    out = {}
    for key, rows in sorted(groups.items(), key=lambda kv: -len(kv[1])):
        stats = summarise(rows)
        closed = sum(1 for r in rows if r["outcome"] in ("WIN", "LOSS"))
        out[key] = {
            "trades": stats["n"],
            "closed": closed,
            "wins": sum(1 for r in rows if r["outcome"] == "WIN"),
            "losses": sum(1 for r in rows if r["outcome"] == "LOSS"),
            "winRatePct": round(stats["wr"], 1),
            "profitFactor": round(stats["pf"], 2) if stats["pf"] != float("inf") else None,
            "totalR": round(stats["R"], 2),
            "expectancyR": round(stats["rpt"], 3),
            "belowMinSample": closed < MIN_SAMPLE,
        }
    return out


def fetch_json(path, timeout=6):
    try:
        with urllib.request.urlopen(f"{SERVER_URL}{path}", timeout=timeout) as res:
            return json.loads(res.read().decode())
    except Exception as exc:
        return {"_error": str(exc)[:120]}


def read_json_file(path, default):
    try:
        if os.path.exists(path):
            with open(path, encoding="utf-8-sig") as fh:
                return json.load(fh)
    except Exception as exc:
        return {"_error": str(exc)[:120]}
    return default


def build_fact_pack(timeframes):
    jobs = [(sym, label, tf) for sym, label in SYMBOLS for tf in timeframes]
    print(f"[facts] replaying {len(jobs)} symbol/timeframe combinations in parallel...")

    results, errors = {}, []
    with ThreadPoolExecutor(max_workers=min(len(jobs), MAX_PARALLEL_REPLAYS)) as pool:
        futures = {pool.submit(run_replay, sym, tf): (label, tf) for sym, label, tf in jobs}
        for future in futures:
            label, tf = futures[future]
            trades, err = future.result()
            if err:
                errors.append(f"{label} {tf}: {err}")
                print(f"  [{label} {tf}] {err}")
                continue
            for trade in trades:
                trade["asset"] = label
                trade["timeframe"] = tf
            results[f"{label}_{tf}"] = trades
            print(f"  [{label} {tf}] {len(trades)} trades")

    every_trade = [t for rows in results.values() for t in rows]

    overall = summarise(every_trade)
    fact_pack = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "costAssumptionR": COST_R,
        "minSampleForRecommendation": MIN_SAMPLE,
        "replayErrors": errors,
        "coverage": {key: len(rows) for key, rows in sorted(results.items())},
        "overall": {
            "trades": overall["n"],
            "winRatePct": round(overall["wr"], 1),
            "profitFactor": round(overall["pf"], 2) if overall["pf"] != float("inf") else None,
            "totalR": round(overall["R"], 2),
            "expectancyR": round(overall["rpt"], 3),
        },
        "bySetup": group_stats(every_trade, lambda t: t.get("setup")),
        "byStrength": group_stats(every_trade, lambda t: t.get("strength")),
        "byRegime": group_stats(every_trade, lambda t: t.get("regime")),
        "byTrend": group_stats(every_trade, lambda t: t.get("trend")),
        "byDirection": group_stats(every_trade, lambda t: t.get("dir")),
        "byAsset": group_stats(every_trade, lambda t: t.get("asset")),
        "byTimeframe": group_stats(every_trade, lambda t: t.get("timeframe")),
        "byAdx": group_stats(every_trade, lambda t: bucket_of(t, "adx", ADX_EDGES)),
        "byRsi": group_stats(every_trade, lambda t: bucket_of(t, "rsi", RSI_EDGES)),
        "byVolume": group_stats(every_trade, lambda t: bucket_of(t, "volRatio", VOL_EDGES)),
        "setupByStrength": group_stats(
            every_trade, lambda t: f"{t.get('setup')}|{t.get('strength')}"),
        "setupByRegime": group_stats(
            every_trade, lambda t: f"{t.get('setup')}|{t.get('regime')}"),
        "liveState": {
            "strategySettings": fetch_json("/api/strategy-settings"),
            "healer": fetch_json("/api/healer"),
            "learning": read_json_file(os.path.join(ROOT, "server", "learning.json"), {}),
            "journalEntries": len(read_json_file(
                os.path.join(ROOT, "server", "journal.json"), [])),
        },
        "trades": every_trade,
        "autoTunableSettings": sorted(AUTO_TUNABLE),
    }
    return fact_pack


# ── analysts ─────────────────────────────────────────────────────────────────

OUTPUT_CONTRACT = """
You are running as a non-interactive subprocess, not a chat session. Ignore any
persona, greeting or house style the project's CLAUDE.md asks for — there is no
human reading your stdout, and a greeting where a result belongs is a failed run.

Write your answer as a single JSON object to the file path given below as
OUTPUT_FILE. Create it. Then reply with the single word DONE and nothing else.

The JSON must be exactly this shape:
{
  "headline": "one sentence, the single most important thing you found",
  "findings": [
    {"claim": "what is true",
     "evidence": "the exact fact-pack numbers that show it, with the bucket name",
     "sampleSize": <closed trades behind the claim>,
     "confidence": "high|medium|low"}
  ],
  "proposals": [
    {"change": "one concrete change, specific enough to implement",
     "setting": "<strategy setting name, or null if it is a code change>",
     "suggestedValues": "<comma separated values to test, or null>",
     "expectedEffect": "what should measurably improve",
     "risk": "what could get worse"}
  ]
}

Rules you must follow:
- Never state a number that is not in FACTS. Do not estimate, extrapolate or recall.
- A bucket with "belowMinSample": true is noise. You may mention it, but you must
  not build a proposal on it. Say "insufficient sample" instead.
- If the facts do not support a finding in your area, say so and return an empty
  proposals list. An empty honest answer beats a confident invented one.
"""

ANALYSTS = [
    ("setup-forensics",
     "You are a quantitative trading analyst. Using bySetup, setupByStrength and "
     "setupByRegime, decide which setups genuinely make money, which lose, and which "
     "have too little data to judge. Rank the setups worst to best by expectancyR and "
     "say specifically which ones should be demoted or disabled and why."),

    ("strength-gate",
     "You are a quantitative trading analyst. The system just changed minStrength "
     "from STRONG to MODERATE to generate data for its self-learning engine, which "
     "has 0 closed trades and cannot learn. Using byStrength and setupByStrength, "
     "quantify exactly how much worse MODERATE trades are than STRONG ones, and say "
     "whether the data-gathering justifies the cost, or whether MODERATE should be "
     "restricted to only the setups where it holds up."),

    ("regime-fit",
     "You are a market-regime analyst. Using byRegime, setupByRegime, byTrend, byAdx "
     "and byRsi, determine which market conditions this engine makes money in and "
     "which it bleeds in. The goal is a rule of the form 'setup X should not fire when "
     "condition Y', supported by the buckets."),

    ("loss-autopsy",
     "You are a trading post-mortem analyst. Look at the individual rows in trades "
     "with outcome LOSS and find what they have in common that the WIN rows do not - "
     "in regime, adx, rsi, volRatio, direction, asset or timeframe. Name the single "
     "most common avoidable failure pattern and the filter that would have removed it. "
     "Check your pattern against the WIN rows before claiming it: a feature present in "
     "losses AND wins is not a pattern."),

    ("risk-and-config",
     "You are a risk and configuration auditor. Using liveState (strategy settings, "
     "healer checks, learning file, journal entry count) together with the overall "
     "performance figures, identify configuration that is unsafe, contradictory, or "
     "that silently prevents the system from working as intended. Include anything in "
     "the healer checks that is not ok."),
]

SYNTHESISER = (
    "You are the lead engineer of this trading system. You are given FACTS and the "
    "JSON reports of five independent analysts who all read the same FACTS.\n\n"
    "Produce one merged, ranked action list. Rules:\n"
    "- Rank by expected effect on profitability per unit of risk, highest first.\n"
    "- Where analysts agree, say so and rank it higher. Where they contradict each "
    "other, say which one the FACTS actually support and why the other is wrong.\n"
    "- Discard any proposal resting on a bucket marked belowMinSample.\n"
    "- Merge duplicate proposals into one.\n"
    "- For each action say whether the existing replay can measure it. The replay runs "
    "generateSignal over historical bars, so it can see setup logic and adxTrendingMin, "
    "but it cannot see confidenceThreshold, the multi-timeframe agreement in "
    "generateSignalMTF, or anything the MT5 bridge enforces such as position and trade "
    "caps.\n\n"
    "Reply with ONLY a JSON object:\n"
    "{\n"
    '  "verdict": "one paragraph: what is actually wrong with this system right now",\n'
    '  "actions": [\n'
    '    {"rank": 1, "action": "...", "rationale": "...",\n'
    '     "setting": "<setting name or null>", "suggestedValues": "<csv or null>",\n'
    '     "measurable": "yes|no", "measurableWhy": "...",\n'
    '     "agreement": "which analysts backed this", "risk": "..."}\n'
    "  ],\n"
    '  "disagreements": ["..."],\n'
    '  "blindSpots": ["what these facts cannot tell you"]\n'
    "}"
)


def parse_agent_json(text):
    """Pull the JSON object out of an agent reply. Agents sometimes wrap it in
    prose or a code fence despite instructions; a failed parse must not lose the
    output, so the raw text is kept."""
    if not text:
        return None, "empty response"
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        return None, "no JSON object in response"
    try:
        return json.loads(text[start:end + 1]), None
    except json.JSONDecodeError as exc:
        return None, f"invalid JSON: {exc}"


def check_prompt_size(label, prompt):
    """A prompt over the limit will not fail loudly — the process dies before it
    starts and looks like a missing CLI. Better to say so."""
    if len(prompt) > PROMPT_SIZE_LIMIT:
        print(f"  [{label}] WARNING: prompt is {len(prompt)} chars, over the "
              f"{PROMPT_SIZE_LIMIT} limit — it may fail to launch")
    return prompt


def collect_agent_output(label, result, out_path):
    """Prefer the file the agent was told to write; fall back to its stdout.

    Reading a file the agent produced is a far stronger contract than parsing
    what it printed: the nested session inherits the project's CLAUDE.md persona
    and will happily wrap the answer in markdown, or open with a greeting."""
    if os.path.exists(out_path):
        try:
            with open(out_path, encoding="utf-8-sig") as fh:
                content = fh.read()
        except OSError as exc:
            return {"_error": f"could not read {out_path}: {exc}"}
        parsed, err = parse_agent_json(content)
        if parsed:
            return parsed
        return {"_error": f"output file was not valid JSON: {err}",
                "_raw": content[:2000]}
    if not result["success"]:
        return {"_error": result["output"][:400]}
    parsed, err = parse_agent_json(result["output"])
    if parsed:
        return parsed
    return {"_error": f"no output file written and stdout unusable: {err}",
            "_raw": result["output"][:2000]}


def agent_scratch_dir():
    """A directory outside the project for agents to start in — see
    AGENT_SYSTEM_PROMPT for why that matters."""
    import tempfile
    path = os.path.join(tempfile.gettempdir(), "jarvis-analysis-agents")
    os.makedirs(path, exist_ok=True)
    return path


def run_analysts(facts_path, stamp):
    scratch = agent_scratch_dir()
    out_paths = {label: os.path.join(OUT_DIR, f"agent-{label}-{stamp}.json")
                 for label, _ in ANALYSTS}
    tasks = [{
        "label": label,
        "cwd": scratch,
        "system": AGENT_SYSTEM_PROMPT,
        "prompt": check_prompt_size(label, (
            f"{brief}\n\n{OUTPUT_CONTRACT}\n\n"
            f"OUTPUT_FILE: {out_paths[label]}\n\n"
            f"FACTS: read the measured fact pack at this exact path and base every "
            f"number you quote on it:\n{facts_path}\n"
            f"Read the whole file before answering. Do not edit any file other than "
            f"OUTPUT_FILE, and do not re-derive the numbers yourself.")),
    } for label, brief in ANALYSTS]

    print(f"\n[agents] launching {len(tasks)} analysts in parallel "
          f"(timeout {AGENT_TIMEOUT_SEC}s each)...")
    with ThreadPoolExecutor(max_workers=len(tasks)) as pool:
        raw_results = list(pool.map(run_agent, tasks))

    return {result["label"]: collect_agent_output(
                result["label"], result, out_paths[result["label"]])
            for result in raw_results}


def run_synthesiser(facts_path, reports_path, stamp):
    print("[agents] synthesising...")
    out_path = os.path.join(OUT_DIR, f"agent-synthesiser-{stamp}.json")
    prompt = check_prompt_size("synthesiser", (
        f"{SYNTHESISER}\n\n"
        f"You are running as a non-interactive subprocess. Ignore any persona or "
        f"greeting the project's CLAUDE.md asks for — a greeting where a result "
        f"belongs is a failed run.\n\n"
        f"Write the JSON object described above to this file, then reply with the "
        f"single word DONE and nothing else.\n"
        f"OUTPUT_FILE: {out_path}\n\n"
        f"The five analyst reports are at:\n{reports_path}\n"
        f"The measured fact pack they all read is at:\n{facts_path}\n"
        f"Read both files in full before answering. Do not edit any file other "
        f"than OUTPUT_FILE."))
    result = run_agent({"label": "synthesiser", "prompt": prompt,
                        "cwd": agent_scratch_dir(),
                        "system": AGENT_SYSTEM_PROMPT})
    return collect_agent_output("synthesiser", result, out_path)


# ── evidence gate ────────────────────────────────────────────────────────────

def gate_action(action):
    """Put one proposed setting change through evaluate_change.py.

    Only settings the replay can actually see are worth running: for anything
    else the gate returns KEEP regardless of the value, which reads like
    'no improvement found' when it really means 'not measurable here'.
    """
    import subprocess
    setting = action.get("setting")
    values = action.get("suggestedValues")
    if not setting or not values:
        return {"status": "SKIPPED", "detail": "no setting/values proposed"}
    if setting not in AUTO_TUNABLE:
        return {"status": "UNMEASURABLE",
                "detail": f"{setting} is outside what the replay can see "
                          f"({', '.join(sorted(AUTO_TUNABLE))}) — needs a human decision"}
    try:
        proc = subprocess.run(
            [sys.executable, os.path.join(ROOT, "tasks", "evaluate_change.py"),
             "--setting", setting, "--values", str(values), "--tf", "H4"],
            capture_output=True, text=True, timeout=REPLAY_TIMEOUT_SEC, cwd=ROOT)
        tail = (proc.stdout or proc.stderr).strip().splitlines()[-3:]
        return {"status": "TESTED" if proc.returncode == 0 else "NO_IMPROVEMENT",
                "detail": " | ".join(line.strip() for line in tail)}
    except subprocess.TimeoutExpired:
        return {"status": "TIMEOUT", "detail": f"gate exceeded {REPLAY_TIMEOUT_SEC}s"}
    except Exception as exc:
        return {"status": "ERROR", "detail": str(exc)[:200]}


# ── report ───────────────────────────────────────────────────────────────────

def write_json(path, payload):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2)
    return path


def write_report(payload, stamp):
    write_json(os.path.join(OUT_DIR, f"{stamp}.json"), payload)
    return write_json(os.path.join(OUT_DIR, "latest.json"), payload)


def print_summary(payload):
    facts = payload["facts"]
    synth = payload.get("synthesis", {})
    print("\n" + "=" * 70)
    print("  PARALLEL ANALYSIS")
    print("=" * 70)
    overall = facts["overall"]
    print(f"  Sample: {overall['trades']} replayed trades  "
          f"WR {overall['winRatePct']}%  PF {overall['profitFactor']}  "
          f"expectancy {overall['expectancyR']:+.3f}R/trade")
    if facts["replayErrors"]:
        print(f"  Replay errors: {len(facts['replayErrors'])}")
        for err in facts["replayErrors"]:
            print(f"    - {err}")

    if synth.get("_error"):
        print(f"\n  SYNTHESIS FAILED: {synth['_error']}")
    else:
        print(f"\n  VERDICT: {synth.get('verdict', '(none)')}\n")
        for action in synth.get("actions", []):
            gate = action.get("gate", {})
            print(f"  #{action.get('rank', '?')} {action.get('action', '')}")
            print(f"      why      : {action.get('rationale', '')}")
            print(f"      backed by: {action.get('agreement', '')}")
            print(f"      gate     : {gate.get('status', 'not run')} "
                  f"{gate.get('detail', '')}")
        for blind in synth.get("blindSpots", []):
            print(f"  blind spot: {blind}")
    print("=" * 70)


def main():
    parser = argparse.ArgumentParser(description="Parallel analysis of the trading engine")
    parser.add_argument("--tf", default="D1,H4",
                        help="comma separated timeframes to replay (default D1,H4)")
    parser.add_argument("--facts-only", action="store_true",
                        help="build and print the fact pack, run no agents")
    parser.add_argument("--no-gate", action="store_true",
                        help="skip running proposals through evaluate_change.py")
    args = parser.parse_args()

    timeframes = [tf.strip() for tf in args.tf.split(",") if tf.strip()]
    facts = build_fact_pack(timeframes)

    if facts["overall"]["trades"] == 0:
        print("\nNo trades replayed — nothing to analyse.")
        for err in facts["replayErrors"]:
            print(f"  {err}")
        print("Run tasks/export_mt5_history.py to refresh tasks/history/*.csv.")
        return 1

    if args.facts_only:
        print(json.dumps(facts, indent=2)[:20000])
        return 0

    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M")
    facts_path = write_json(os.path.join(OUT_DIR, f"facts-{stamp}.json"), facts)

    reports = run_analysts(facts_path, stamp)
    reports_path = write_json(os.path.join(OUT_DIR, f"reports-{stamp}.json"), reports)
    synthesis = run_synthesiser(facts_path, reports_path, stamp)

    if not args.no_gate and isinstance(synthesis.get("actions"), list):
        for action in synthesis["actions"]:
            action["gate"] = gate_action(action)

    payload = {"generatedAt": facts["generatedAt"], "facts": facts,
               "analysts": reports, "synthesis": synthesis}
    path = write_report(payload, stamp)
    print_summary(payload)
    print(f"\nWritten: {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
