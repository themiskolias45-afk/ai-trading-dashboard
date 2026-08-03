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
  python parallel_analysis.py                      # full run on the live MTF path
  python parallel_analysis.py --facts-only         # build the fact pack, no agents
  python parallel_analysis.py --no-gate            # skip the replay verdicts
"""

import argparse
import json
import os
import re
import sys
import tempfile
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.abspath(__file__))
HIST_DIR = os.path.join(ROOT, "tasks", "history")
OUT_DIR = os.path.join(ROOT, "tasks", "analysis")
# The MTF replay, not _replay_engine.cjs.
#
# _replay_engine.cjs replays single-timeframe generateSignal. That is not the path
# the live system trades: production runs generateSignalMTF, which only fires when
# the daily and 4H signals combine. So every finding drawn from the old fact pack
# described a population the live gate can never take, and it recorded no per-trade
# confidence at all — which is why the 2026-08-03 synthesis had to list "the
# multi-timeframe agreement step is invisible" and "confidenceThreshold is invisible
# and possibly decisive" among its own blind spots.
REPLAY = os.path.join(ROOT, "tasks", "_replay_mtf.cjs")

# Lowered so sub-gate cohorts exist in the pack at all. generateSignalMTF returns
# WAIT below strategySettings.confidenceThreshold, so at the live value the fact
# pack could never show what the gate is rejecting — and "why does it never fire"
# is precisely the question the analysts are asked. The trades ARE labelled with
# their confidence, so any analyst can restrict itself to the live population.
REPLAY_CONF_FLOOR = 40
SERVER_URL = "http://localhost:3001"

sys.path.insert(0, os.path.join(ROOT, "tasks"))
from evaluate_change import summarise, COST_R, AUTO_TUNABLE  # noqa: E402

import parallel_agents  # noqa: E402
from parallel_agents import run_agent  # noqa: E402

# (broker symbol, label, Yahoo ticker). The ticker is needed because the engine
# branches on it — `ticker === "GC=F"` selects Gold's DXY-divergence path — so a
# replay that passed the wrong one would silently measure a different engine.
SYMBOLS = [
    ("BTCUSD", "BTC",  "BTC-USD"),
    ("XAUUSD", "Gold", "GC=F"),
    ("SP500",  "SPX",  "^GSPC"),
]

# Analysts think for longer than the 300s a build agent needs. run_agent reads
# this module global at call time, so raising it here raises it for the pool.
AGENT_TIMEOUT_SEC = 600
parallel_agents.TIMEOUT = AGENT_TIMEOUT_SEC

# Every agent in this pipeline runs from OUTSIDE the project directory.
#
# The claude CLI discovers CLAUDE.md by walking up from its working directory. Run
# from the project, each analyst boots as JARVIS: it opens with the mandated welcome
# line instead of a result, and it inherits "double-confirm before any source-code
# edit", so it asks permission rather than writing its own OUTPUT_FILE. That is
# exactly what the 2026-08-01 and 08-02 runs produced - all five analysts and both
# synthesiser attempts failing with "no output file written and stdout unusable: no
# JSON object in response", after 4 to 8 minutes of real work each.
#
# Prompt-level countermeasures were already in place ("Ignore any persona the
# project's CLAUDE.md asks for") and were not enough - a system prompt loaded as
# project configuration outranks an instruction buried in a user turn. run_agent has
# supported a cwd override for exactly this reason; it was simply never passed.
#
# Two further things this had to get right, both learned by running it:
#
# 1. The CLI scopes its file tools to the working directory, so an agent moved out of
#    the project cannot read the fact pack or write its OUTPUT_FILE. It reported
#    exactly that: "my file access here is sandboxed to the Temp directory only".
#    Every task therefore also passes add_dirs=[ROOT].
#
# 2. The directory must be EMPTY, and tempfile.gettempdir() is the worst possible
#    choice. It holds Claude Code's own per-session scratchpads, including old runs
#    on this project, so the analysts globbed their cwd, found convincing stale
#    lookalikes - mod_facts.json, backtest.json, a VPS snapshot from 2026-07-27 -
#    and analysed those instead of the absolute path they were handed. One reported
#    "dozens of leftover scratchpad JSON files from many past Claude Code sessions".
#    Wrong numbers confidently presented is worse than no numbers.
#
# A dedicated empty directory outside the project satisfies both: nothing above it
# defines a CLAUDE.md, and nothing inside it can be mistaken for input.
AGENT_CWD = os.path.join(
    os.environ.get("LOCALAPPDATA") or tempfile.gettempdir(), "SmartEntryAgentCwd")
os.makedirs(AGENT_CWD, exist_ok=True)

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

# The synthesiser is the single point of failure in the whole run: five analysts
# can succeed and the night still yields nothing if it alone returns unusable
# text. One retry with a stricter prompt is cheap insurance; more than one just
# burns another ten minutes against an agent that is clearly not cooperating.
SYNTH_MAX_ATTEMPTS = 2

# How much of an unusable reply to keep in the report. Enough to see what the
# agent actually said, not so much that a runaway reply bloats latest.json.
RAW_EXCERPT_CHARS = 2000
AGENT_ERROR_CHARS = 400

# Exit codes. The nightly task branches on ERRORLEVEL, so a failed synthesis
# must not come back as 0 — that is exactly how a broken run reported success.
EXIT_OK = 0
EXIT_NO_TRADES = 1
EXIT_SYNTHESIS_FAILED = 2

# SUPERSEDED 2026-08-02 - kept for the reasoning, not the conclusion. Analysts now
# run OUTSIDE the project (see AGENT_CWD above). The file-access problem described
# below is real but is solved by add_dirs=[ROOT], not by moving back into the
# project, which reintroduces the JARVIS persona that made every run fail:
# Claude Code scopes file access to its working directory, so an agent launched in
# a scratch dir cannot read the fact pack at all — it replies "could you paste
# them?" and, finding only whatever else is lying in that directory, returns the
# contents of an unrelated file. Verified 2026-07-27.
#
# The problem the scratch dir was meant to solve is real: inside the project an
# agent loads CLAUDE.md, adopts the JARVIS persona, opens with the welcome line,
# and obeys "double-confirm before any edit" by refusing to write its output file.
# The lever for that is this system-prompt override, not the working directory.
AGENT_SYSTEM_PROMPT = (
    "You are a non-interactive analysis subprocess in an automated pipeline. "
    "There is no human reading your output and no one to answer a question. "
    "Never greet, never introduce yourself, never ask for confirmation. "
    "Write the file you are asked to write, then stop."
)


# ── fact pack ────────────────────────────────────────────────────────────────

def run_replay(symbol, ticker):
    """Replay one asset on the LIVE multi-timeframe path. Returns (trades, error).

    The MTF replay reads D1, H4 and H1 for the symbol itself, so there is no
    per-timeframe job any more — the timeframe combination IS the thing under test.
    """
    import subprocess
    missing = [tf for tf in ("D1", "H4", "H1")
               if not os.path.exists(os.path.join(HIST_DIR, f"{symbol}_{tf}.csv"))]
    if missing:
        return [], f"{symbol}: missing history for {', '.join(missing)}"
    try:
        proc = subprocess.run(
            ["node", REPLAY, ROOT, symbol, ticker, str(REPLAY_CONF_FLOOR)],
            capture_output=True, text=True, timeout=REPLAY_TIMEOUT_SEC, cwd=ROOT,
            env={**os.environ, "MTF_CONF_FLOOR": str(REPLAY_CONF_FLOOR)})
    except subprocess.TimeoutExpired:
        return [], f"{symbol} MTF replay timed out after {REPLAY_TIMEOUT_SEC}s"
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
# Bands straddle the live gate (70) so "what the gate rejects" and "what it admits"
# are separate rows rather than a judgement the analyst has to make itself.
CONF_EDGES = [(50, "conf<50"), (65, "conf50-64"), (70, "conf65-69"),
              (80, "conf70-79"), (float("inf"), "conf>=80")]
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


def build_fact_pack():
    print(f"[facts] replaying {len(SYMBOLS)} assets on the LIVE MTF path "
          f"(confidence floor {REPLAY_CONF_FLOOR}) in parallel...")

    results, errors = {}, []
    with ThreadPoolExecutor(max_workers=min(len(SYMBOLS), MAX_PARALLEL_REPLAYS)) as pool:
        futures = {pool.submit(run_replay, sym, ticker): label
                   for sym, label, ticker in SYMBOLS}
        for future in futures:
            label = futures[future]
            trades, err = future.result()
            if err:
                errors.append(f"{label}: {err}")
                print(f"  [{label}] {err}")
                continue
            for trade in trades:
                trade["asset"] = label
            results[label] = trades
            print(f"  [{label}] {len(trades)} trades")

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
        # Replaces byTimeframe, which no longer means anything: the MTF path always
        # reads D1+H4+H1. cohort says WHICH combination produced the entry —
        # DAILY+H4_AGREE, DAILY_ONLY_H4_NEUTRAL, H4_ONLY or DAILY+H4_CONFLICT —
        # the question no previous analysis could ask.
        "byCohort": group_stats(every_trade, lambda t: t.get("cohort")),
        # The gate itself, finally visible. The pack is built at a floor of
        # REPLAY_CONF_FLOOR, so it deliberately contains signals the live gate
        # rejects; this is how an analyst tells the two populations apart.
        "byConfidence": group_stats(every_trade, lambda t: bucket_of(t, "conf", CONF_EDGES)),
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
     "in regime, adx, rsi, volRatio, direction, asset or cohort. Name the single "
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

# Held separately only so the retry prompt can restate the exact same shape
# without a second copy that could drift from this one. The composed
# SYNTHESISER string below is unchanged.
SYNTH_JSON_SHAPE = (
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
    "Reply with ONLY a JSON object:\n" + SYNTH_JSON_SHAPE
)


# A byte-order mark survives an agent writing its file on Windows and makes the
# very first character of an otherwise perfect object unparseable.
BOM = "\ufeff"

# A fenced block, with or without a language tag. The closing fence is optional
# so a reply cut off mid-stream still yields its block instead of nothing.
FENCED_BLOCK_RE = re.compile(r"```[ \t]*[A-Za-z0-9_+-]*[ \t]*\r?\n(.*?)(?:```|\Z)",
                             re.DOTALL)


def _fenced_blocks(text):
    """Every fenced code block in the reply, in the order they appear."""
    return [match.group(1).strip() for match in FENCED_BLOCK_RE.finditer(text)
            if match.group(1).strip()]


def _balanced_objects(text):
    """Every top-level {...} region, ignoring braces inside string literals.

    The naive first-brace/last-brace slice this replaces breaks on the two
    things agents do most: a "}" inside a string value, and a sentence of
    commentary after the object that happens to contain a brace.
    """
    spans, depth, start, in_string, escaped = [], 0, -1, False, False
    for index, char in enumerate(text):
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            if depth == 0:
                start = index
            depth += 1
        elif char == "}" and depth > 0:
            depth -= 1
            if depth == 0:
                spans.append((start, index + 1))
    # Longest first: when prose contributes a stray {word}, the real report is
    # the larger region.
    spans.sort(key=lambda span: span[0] - span[1])
    return [text[begin:end] for begin, end in spans]


def _object_fragments(text):
    """Substrings that might contain the agent's JSON object, best guess first.

    Only used once the reply has failed to parse as a whole document, so these
    are genuinely fragments carved out of surrounding prose.
    """
    fragments = _balanced_objects(text)
    first, last = text.find("{"), text.rfind("}")
    if first != -1 and last > first:
        # The original greedy slice, kept last so nothing that parsed before can
        # stop parsing now.
        fragments.append(text[first:last + 1])
    unique, seen = [], set()
    for fragment in fragments:
        if fragment not in seen:
            seen.add(fragment)
            unique.append(fragment)
    return unique


def _not_an_object_reason(parsed):
    if isinstance(parsed, dict):
        return "JSON object was empty"
    return f"expected a JSON object, got {type(parsed).__name__}"


def parse_agent_json(text):
    """Pull the JSON object out of an agent reply.

    Agents wrap the object in prose or a code fence despite instructions, so a
    fenced block and then the whole reply are tried as complete documents, and
    only if neither parses is an object carved out of the surrounding text.

    Returns (object, None) only for a non-empty dict. A reply that parses
    cleanly but is not an object — a bare list, a string, a number — is a
    failure, not something to dig a fragment out of: the first object inside an
    array is not the report the agent was asked for, and returning it would let
    a broken run look like a good one.
    """
    body = (text or "").lstrip(BOM)
    if not body.strip():
        return None, "empty response"

    whole_document_error = None
    for document in _fenced_blocks(body) + [body.strip()]:
        try:
            parsed = json.loads(document)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict) and parsed:
            return parsed, None
        whole_document_error = _not_an_object_reason(parsed)
    if whole_document_error:
        return None, whole_document_error

    fragment_error = None
    for fragment in _object_fragments(body):
        try:
            parsed = json.loads(fragment)
        except json.JSONDecodeError as exc:
            fragment_error = f"invalid JSON: {exc}"
            continue
        if isinstance(parsed, dict) and parsed:
            return parsed, None
        fragment_error = _not_an_object_reason(parsed)
    return None, fragment_error or "no JSON object in response"


def check_prompt_size(label, prompt):
    """A prompt over the limit will not fail loudly — the process dies before it
    starts and looks like a missing CLI. Better to say so."""
    if len(prompt) > PROMPT_SIZE_LIMIT:
        print(f"  [{label}] WARNING: prompt is {len(prompt)} chars, over the "
              f"{PROMPT_SIZE_LIMIT} limit — it may fail to launch")
    return prompt


def read_agent_file(out_path):
    """Read and parse the file an agent was told to write.

    Returns (report, error, raw). All three are None/"" when no file exists,
    which is not itself a failure — stdout is still worth trying.
    """
    if not os.path.exists(out_path):
        return None, None, ""
    try:
        with open(out_path, encoding="utf-8-sig") as fh:
            content = fh.read()
    except OSError as exc:
        return None, f"could not read {out_path}: {exc}", ""
    report, err = parse_agent_json(content)
    if report:
        return report, None, ""
    return None, f"output file was not valid JSON: {err}", content[:RAW_EXCERPT_CHARS]


def collect_agent_output(label, result, out_path):
    """Prefer the file the agent was told to write; fall back to its stdout.

    Reading a file the agent produced is a far stronger contract than parsing
    what it printed: the nested session inherits the project's CLAUDE.md persona
    and will happily wrap the answer in markdown, or open with a greeting.

    Both routes are tried before giving up. A file that exists but is malformed
    used to end the attempt outright, throwing away a perfectly good copy of the
    same report sitting in stdout — and a timed-out agent that had already
    written its file was discarded for the same reason.
    """
    report, file_error, file_raw = read_agent_file(out_path)
    if report:
        return report

    stdout_text = (result.get("output") or "") if isinstance(result, dict) else ""
    report, stdout_error = parse_agent_json(stdout_text)
    if report:
        if file_error:
            print(f"  [{label}] output file unusable ({file_error}) — "
                  f"recovered the report from stdout")
        return report

    if file_error:
        reason = file_error
    elif not (isinstance(result, dict) and result.get("success")):
        reason = f"agent did not complete: {stdout_text[:AGENT_ERROR_CHARS]}"
    else:
        reason = f"no output file written and stdout unusable: {stdout_error}"
    return {"_error": reason, "_raw": file_raw or stdout_text[:RAW_EXCERPT_CHARS]}


def run_analysts(facts_path, stamp):
    out_paths = {label: os.path.join(OUT_DIR, f"agent-{label}-{stamp}.json")
                 for label, _ in ANALYSTS}
    tasks = [{
        "label": label,
        "cwd": AGENT_CWD,
        "add_dirs": [ROOT],
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


def synthesiser_prompt(facts_path, reports_path, out_path, retry_reason):
    """Build the synthesiser prompt. With a retry_reason, the output rules get
    stricter: the shape is restated and stdout must carry the object too, so the
    attempt survives either the file write or the reply failing, not only both
    succeeding."""
    if retry_reason:
        output_rules = (
            f"THIS IS A RETRY. The previous attempt produced nothing usable: "
            f"{retry_reason}\n"
            f"Follow these output rules exactly.\n"
            f"1. Write the JSON object to OUTPUT_FILE.\n"
            f"2. Then print that same JSON object as your entire reply.\n"
            f"Your reply must start with {{ and end with }}. Nothing before the "
            f"first brace and nothing after the last: no greeting, no explanation, "
            f"no markdown code fence, no closing remark, and not the word DONE.\n"
            f"The required shape again — every key present, actions may be an "
            f"empty list:\n{SYNTH_JSON_SHAPE}\n")
    else:
        output_rules = (
            "Write the JSON object described above to this file, then reply with the "
            "single word DONE and nothing else.\n")
    return check_prompt_size("synthesiser", (
        f"{SYNTHESISER}\n\n"
        f"You are running as a non-interactive subprocess. Ignore any persona or "
        f"greeting the project's CLAUDE.md asks for — a greeting where a result "
        f"belongs is a failed run.\n\n"
        f"{output_rules}"
        f"OUTPUT_FILE: {out_path}\n\n"
        f"The five analyst reports are at:\n{reports_path}\n"
        f"The measured fact pack they all read is at:\n{facts_path}\n"
        f"Read both files in full before answering. Do not edit any file other "
        f"than OUTPUT_FILE."))


def run_synthesiser(facts_path, reports_path, stamp):
    """Synthesise the analyst reports, retrying once with stricter output rules.

    Each attempt writes to its own path: pointing a retry at the first attempt's
    file would just re-read the malformed copy that failed. Nothing is deleted —
    both attempts stay on disk for inspection.
    """
    synthesis = {"_error": "synthesiser was never run"}
    retry_reason = None
    for attempt in range(1, SYNTH_MAX_ATTEMPTS + 1):
        suffix = "" if attempt == 1 else f"-retry{attempt}"
        out_path = os.path.join(OUT_DIR, f"agent-synthesiser-{stamp}{suffix}.json")
        print(f"[agents] synthesising (attempt {attempt} of {SYNTH_MAX_ATTEMPTS})...")
        result = run_agent({
            "label": f"synthesiser{suffix}",
            "cwd": AGENT_CWD,
        "add_dirs": [ROOT],
            "prompt": synthesiser_prompt(facts_path, reports_path, out_path, retry_reason),
            "system": AGENT_SYSTEM_PROMPT,
        })
        synthesis = collect_agent_output("synthesiser", result, out_path)
        if not synthesis.get("_error"):
            return synthesis
        retry_reason = synthesis["_error"]
        print(f"  [synthesiser] attempt {attempt} unusable: {retry_reason}")
    synthesis["_attempts"] = SYNTH_MAX_ATTEMPTS
    return synthesis


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
        print(f"\n  SYNTHESIS FAILED after {synth.get('_attempts', 1)} attempt(s): "
              f"{synth['_error']}")
        print("  The analyst reports below were still produced and are saved:")
        for label, report in sorted(payload.get("analysts", {}).items()):
            if not isinstance(report, dict):
                print(f"    [{label}] unexpected report type {type(report).__name__}")
            elif report.get("_error"):
                print(f"    [{label}] FAILED: {report['_error']}")
            else:
                print(f"    [{label}] {report.get('headline', '(no headline)')}")
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
                        help="timeframes for the auto-tune subprocess only. The fact pack no "
                             "longer uses this: the MTF replay always reads D1+H4+H1.")
    parser.add_argument("--facts-only", action="store_true",
                        help="build and print the fact pack, run no agents")
    parser.add_argument("--no-gate", action="store_true",
                        help="skip running proposals through evaluate_change.py")
    args = parser.parse_args()

    facts = build_fact_pack()

    if facts["overall"]["trades"] == 0:
        print("\nNo trades replayed — nothing to analyse.")
        for err in facts["replayErrors"]:
            print(f"  {err}")
        print("Run tasks/export_mt5_history.py to refresh tasks/history/*.csv.")
        return EXIT_NO_TRADES

    if args.facts_only:
        print(json.dumps(facts, indent=2)[:20000])
        return EXIT_OK

    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M")
    facts_path = write_json(os.path.join(OUT_DIR, f"facts-{stamp}.json"), facts)

    reports = run_analysts(facts_path, stamp)
    reports_path = write_json(os.path.join(OUT_DIR, f"reports-{stamp}.json"), reports)
    synthesis = run_synthesiser(facts_path, reports_path, stamp)

    if not args.no_gate and isinstance(synthesis.get("actions"), list):
        for action in synthesis["actions"]:
            action["gate"] = gate_action(action)

    payload = {"generatedAt": facts["generatedAt"], "facts": facts,
               "analysts": reports, "synthesis": synthesis,
               "analystReportsPath": reports_path}
    path = write_report(payload, stamp)
    print_summary(payload)
    print(f"\nWritten: {path}")

    # The analysts' work is on disk either way — but the run must not report
    # success when the merged action list is missing, or the scheduled task logs
    # result=0 and nobody ever learns the night produced nothing actionable.
    if synthesis.get("_error"):
        print(f"Analyst reports preserved at: {reports_path}")
        print(f"Exiting {EXIT_SYNTHESIS_FAILED}: synthesis failed after "
              f"{SYNTH_MAX_ATTEMPTS} attempts.")
        return EXIT_SYNTHESIS_FAILED
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
