"""Score the setups the minimum-R:R gate threw away.

    python tasks/score_rr_rejections.py [--horizon-mult N] [--quiet]

WHY
MIN_RR = 1.5 has never been measured. The walk-forward harness sweeps confidence
gates only, so the R:R bar is the one live constraint standing on nothing but a
round number - and it is currently what keeps Gold untradeable for days at a time.

server/index.js records every rejected setup to tasks/rr_rejected.jsonl with the
levels it would have traded. A rejection is a fully specified trade: entry, stop
and target are all computed before the gate fires. This walks real bars forward
from each rejection and asks which came first, the target or the stop. That turns
a guess into a measurement without funding the experiment.

READS the broker's own bars, live from the terminal, keyed on each row's
`sourceSymbol` - never `ticker`. `ticker` is always the Yahoo symbol regardless of
which feed supplied the bars, and GC=F futures sat ~60 dollars away from XAUUSD
spot when the first rows were written. Scoring a row against the wrong series
gives a confidently wrong answer, which is worse than having no answer.

WRITES tasks/rr_rejected_scored.jsonl (derived, rewritten each run) and a summary
to stdout. Never touches rr_rejected.jsonl, which is append-only source data.

HONESTY RULES BUILT IN
- A row whose horizon has not elapsed scores PENDING, not a guess.
- A bar that contains BOTH the stop and the target scores AMBIGUOUS. Daily OHLC
  cannot say which was touched first and this script will not pretend otherwise.
- The gate re-fires every refresh, so one real setup drifting over a few hours
  produces many near-identical rows. Rows are grouped into EPISODES and the
  summary leads with the episode count, because seven rows of one Gold short are
  one piece of evidence, not seven.
"""

import json
import os
import sys
from collections import defaultdict
from datetime import datetime, timezone

try:
    import MetaTrader5 as mt5
except ImportError:
    print("MetaTrader5 package not installed. Run: pip install MetaTrader5")
    sys.exit(1)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REJECTED_PATH = os.path.join(ROOT, "tasks", "rr_rejected.jsonl")
SCORED_PATH = os.path.join(ROOT, "tasks", "rr_rejected_scored.jsonl")

# Seconds per bar, and how many bars a setup gets to resolve. A D1 mean-reversion
# short that has not touched either level in a month was not the trade the setup
# described, so it is marked to market rather than left open forever.
BAR_SECONDS = {"D1": 86400, "H4": 14400, "H1": 3600}
HORIZON_BARS = {"D1": 20, "H4": 30, "H1": 48}

MT5_TIMEFRAME = {"D1": mt5.TIMEFRAME_D1, "H4": mt5.TIMEFRAME_H4, "H1": mt5.TIMEFRAME_H1}

# Same cost basis the rest of the project measures against (see mtf_walkforward.cjs).
COST_R = 0.05

# Two rows belong to the same episode when they share instrument, timeframe, setup
# and direction AND are no further apart than this many bars. The gate re-fires on
# every 30-minute refresh, so consecutive rows are minutes apart; a genuinely new
# occurrence of the same setup days later is a separate piece of evidence.
EPISODE_GAP_BARS = 2

RR_BANDS = [
    ("< 1.20", 0.00, 1.20),
    ("1.20-1.34", 1.20, 1.35),
    ("1.35-1.49", 1.35, 1.50),
]


def log(msg):
    print(msg, flush=True)


def load_rows(path):
    """Read the append-only rejection log. A malformed line is reported and skipped
    rather than aborting the run - this file is written by a swallowed-error logger
    on the signal path, so a truncated final line is a realistic outcome of a crash
    mid-append and must not cost us every row before it."""
    if not os.path.exists(path):
        log("No rejections logged yet: %s does not exist." % path)
        log("It is written by server/index.js when a setup fails the R:R gate.")
        return []

    rows = []
    with open(path, "r", encoding="utf-8") as fh:
        for lineno, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as err:
                log("  skipping malformed line %d: %s" % (lineno, err))
    return rows


def parse_ts(value):
    """ISO-8601 with a trailing Z, as written by JavaScript's toISOString()."""
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def broker_offset_seconds(symbol):
    """Broker server time minus UTC, in seconds.

    MT5 stamps every bar in the broker's server timezone but hands it over as a
    plain unix integer, so comparing a bar's `time` against a UTC timestamp is off
    by the server offset - typically 2-3 hours, which is enough to pick the wrong
    daily bar as "the one after the rejection". Measured from a live tick rather
    than hardcoded, because brokers change it at DST.
    """
    tick = mt5.symbol_info_tick(symbol)
    if tick is None or not tick.time:
        return 0
    now_utc = datetime.now(timezone.utc).timestamp()
    # Round to the nearest half hour: the raw difference carries tick latency, and
    # no broker runs an offset finer than that.
    return int(round((tick.time - now_utc) / 1800.0) * 1800)


def fetch_bars(symbol, timeframe, start_epoch, end_epoch):
    """Bars in [start, end], in broker epoch seconds. Returns [] on any failure so a
    single unavailable symbol cannot take the whole run down."""
    tf = MT5_TIMEFRAME.get(timeframe)
    if tf is None:
        return []
    rates = mt5.copy_rates_range(
        symbol, tf,
        datetime.fromtimestamp(start_epoch, tz=timezone.utc),
        datetime.fromtimestamp(end_epoch, tz=timezone.utc),
    )
    if rates is None:
        log("  copy_rates_range failed for %s %s: %s" % (symbol, timeframe, mt5.last_error()))
        return []
    return list(rates)


def score_row(row, bars, horizon_end_epoch, now_epoch):
    """Walk bars forward and decide which level price reached first.

    Returns (outcome, realised_R, detail). realised_R is None when the row cannot
    be scored yet or at all.
    """
    entry = row.get("entry")
    stop = row.get("stop")
    target = row.get("target")
    direction = str(row.get("direction") or "").upper()

    if not all(isinstance(v, (int, float)) for v in (entry, stop, target)):
        return "UNSCORABLE", None, "row is missing entry, stop or target"

    risk = abs(entry - stop)
    if risk == 0:
        return "UNSCORABLE", None, "stop distance is zero"

    is_short = direction.startswith("S")

    for bar in bars:
        hit_target = bar["low"] <= target if is_short else bar["high"] >= target
        hit_stop = bar["high"] >= stop if is_short else bar["low"] <= stop

        if hit_target and hit_stop:
            # OHLC records the extremes of the bar, not their order. Guessing here
            # would quietly bias the whole dataset toward whichever level the guess
            # favours, so the row is set aside instead.
            return "AMBIGUOUS", None, "stop and target both inside the bar at %s" % (
                datetime.fromtimestamp(int(bar["time"]), tz=timezone.utc).isoformat())
        if hit_target:
            reward = abs(target - entry)
            return "TARGET", round(reward / risk - COST_R, 3), "target first"
        if hit_stop:
            return "STOP", round(-1.0 - COST_R, 3), "stop first"

    if now_epoch < horizon_end_epoch:
        return "PENDING", None, "horizon has not elapsed yet"

    if not bars:
        return "NO_DATA", None, "no bars returned for this window"

    # Neither level reached inside the horizon. Mark to market so a setup that
    # drifted nowhere counts as the near-nothing it was, rather than vanishing.
    last_close = bars[-1]["close"]
    movement = (entry - last_close) if is_short else (last_close - entry)
    return "TIMEOUT", round(movement / risk - COST_R, 3), "neither level reached in %d bars" % len(bars)


def group_episodes(rows):
    """Assign an episode id to each row. One real setup drifting across refreshes is
    one piece of evidence; counting its rows as independent would inflate every
    sample size in the summary."""
    keyed = defaultdict(list)
    for row in rows:
        key = (
            row.get("sourceSymbol") or row.get("ticker"),
            row.get("timeframe"),
            row.get("setup"),
            row.get("direction"),
        )
        keyed[key].append(row)

    episode_of = {}
    counter = 0
    for key, group in keyed.items():
        group.sort(key=lambda r: r.get("ts") or "")
        gap_limit = BAR_SECONDS.get(key[1], 86400) * EPISODE_GAP_BARS
        previous_ts = None
        for row in group:
            ts = parse_ts(row.get("ts"))
            if previous_ts is None or ts is None or (ts.timestamp() - previous_ts) > gap_limit:
                counter += 1
            episode_of[id(row)] = counter
            if ts is not None:
                previous_ts = ts.timestamp()
    return episode_of


def band_for(rr):
    if not isinstance(rr, (int, float)):
        return "unknown"
    for label, low, high in RR_BANDS:
        if low <= rr < high:
            return label
    return ">= 1.50"


def summarise(scored):
    """Episode-level first, because that is the number that describes how much
    independent evidence exists."""
    # One verdict per episode: the earliest row in it that actually resolved to an
    # R figure. Later rows are the same trade seen again a few minutes later, at
    # levels that drifted with price. If nothing in the episode resolved, the first
    # row stands so the episode still appears in the outcome counts.
    by_episode = {}
    for entry in scored:
        eid = entry["episode"]
        held = by_episode.get(eid)
        if held is None or (held["r"] is None and entry["r"] is not None):
            by_episode[eid] = entry

    log("")
    log("=" * 74)
    log("R:R REJECTION SCORECARD")
    log("=" * 74)
    log("%d rejection rows, %d independent episodes" % (len(scored), len(by_episode)))

    outcomes = defaultdict(int)
    for entry in by_episode.values():
        outcomes[entry["outcome"]] += 1
    log("Episode outcomes: " + ", ".join(
        "%s %d" % (name, count) for name, count in sorted(outcomes.items())))

    resolved = [e for e in by_episode.values() if e["r"] is not None]
    if not resolved:
        log("")
        log("VERDICT: INSUFFICIENT EVIDENCE - nothing has resolved yet.")
        log("This is the expected answer for the first days of collection, and it is")
        log("a real answer. Do not move MIN_RR on the strength of it.")
        return

    log("")
    log("%-12s %6s %6s %6s %8s %8s" % ("R:R BAND", "EPIS", "WIN", "LOSS", "TOTAL R", "R/EPIS"))
    log("-" * 74)

    bands = defaultdict(list)
    for entry in resolved:
        bands[band_for(entry["rr"])].append(entry)

    for label, _, _ in RR_BANDS + [(">= 1.50", 0, 0), ("unknown", 0, 0)]:
        group = bands.get(label)
        if not group:
            continue
        wins = sum(1 for e in group if e["r"] > 0)
        losses = sum(1 for e in group if e["r"] <= 0)
        total_r = sum(e["r"] for e in group)
        log("%-12s %6d %6d %6d %8.2f %8.2f" % (
            label, len(group), wins, losses, total_r, total_r / len(group)))

    log("-" * 74)
    total_r = sum(e["r"] for e in resolved)
    log("%-12s %6d %6s %6s %8.2f %8.2f" % (
        "ALL", len(resolved), "", "", total_r, total_r / len(resolved)))
    log("")
    log("Costed at %.2fR per trade. A positive band is a band MIN_RR is currently" % COST_R)
    log("refusing for free. Five resolved episodes in a band is the project's own")
    log("floor for drawing any conclusion from it - below that, report the number")
    log("and change nothing.")


def main():
    argv = sys.argv[1:]
    horizon_mult = 1.0
    if "--horizon-mult" in argv:
        try:
            horizon_mult = float(argv[argv.index("--horizon-mult") + 1])
        except (IndexError, ValueError):
            log("--horizon-mult needs a number, e.g. --horizon-mult 2")
            return 1
    if horizon_mult <= 0:
        log("--horizon-mult must be positive")
        return 1

    # --input exists so the other box's log can be scored here without merging the
    # two files. Rows from two machines in one file would destroy the provenance
    # the whole exercise depends on.
    input_path = REJECTED_PATH
    output_path = SCORED_PATH
    if "--input" in argv:
        try:
            input_path = argv[argv.index("--input") + 1]
        except IndexError:
            log("--input needs a path")
            return 1
        output_path = os.path.splitext(input_path)[0] + "_scored.jsonl"
    if "--output" in argv:
        try:
            output_path = argv[argv.index("--output") + 1]
        except IndexError:
            log("--output needs a path")
            return 1

    rows = load_rows(input_path)
    if not rows:
        return 0

    terminal_path = os.environ.get("MT5_TERMINAL_PATH", "")
    initialised = mt5.initialize(terminal_path) if terminal_path else mt5.initialize()
    if not initialised:
        log("MT5 initialize() failed: %s" % (mt5.last_error(),))
        log("Run this on a machine whose MT5 terminal is logged in; the broker's own")
        log("bars are the only series these levels were priced on.")
        return 1

    try:
        episode_of = group_episodes(rows)
        now_epoch = datetime.now(timezone.utc).timestamp()
        offsets = {}
        scored = []

        for row in rows:
            symbol = row.get("sourceSymbol")
            timeframe = row.get("timeframe")
            ts = parse_ts(row.get("ts"))

            base = {
                "ts": row.get("ts"),
                "episode": episode_of.get(id(row)),
                "symbol": symbol,
                "timeframe": timeframe,
                "setup": row.get("setup"),
                "direction": row.get("direction"),
                "entry": row.get("entry"),
                "stop": row.get("stop"),
                "target": row.get("target"),
                "rr": row.get("rr"),
            }

            if not symbol:
                # dataSource was yahoo, or the row predates barSource threading.
                # Scoring it against the Yahoo ticker would price XAUUSD levels on
                # GC=F bars, so it is dropped with its reason recorded.
                scored.append(dict(base, outcome="UNSCORABLE", r=None,
                                   detail="no sourceSymbol - cannot know which instrument these levels belong to"))
                continue
            if timeframe not in BAR_SECONDS or ts is None:
                scored.append(dict(base, outcome="UNSCORABLE", r=None,
                                   detail="unknown timeframe %r or unparseable ts %r" % (timeframe, row.get("ts"))))
                continue

            if symbol not in offsets:
                offsets[symbol] = broker_offset_seconds(symbol)
            offset = offsets[symbol]

            bar_seconds = BAR_SECONDS[timeframe]
            horizon = int(HORIZON_BARS[timeframe] * horizon_mult)
            # Start one full bar after the rejection: the bar in progress when the
            # gate fired already contains the price that produced these levels, so
            # counting it would let a setup "hit" a level it was derived from.
            start_utc = ts.timestamp() + bar_seconds
            end_utc = ts.timestamp() + bar_seconds * (horizon + 1)

            bars = fetch_bars(symbol, timeframe, start_utc + offset, end_utc + offset)
            outcome, realised_r, detail = score_row(row, bars, end_utc, now_epoch)
            scored.append(dict(base, outcome=outcome, r=realised_r, detail=detail,
                               barsChecked=len(bars), brokerOffsetHours=offset / 3600.0))

        with open(output_path, "w", encoding="utf-8") as fh:
            for entry in scored:
                fh.write(json.dumps(entry) + "\n")

        log("Wrote %d scored rows to %s" % (len(scored), output_path))
        summarise(scored)
        return 0
    finally:
        mt5.shutdown()


if __name__ == "__main__":
    sys.exit(main())
