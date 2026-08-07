"""Score every setup the gates threw away — the universal rejection ledger.

    python tasks/score_rr_rejections.py [--horizon-mult N] [--input PATH]
                                        [--output PATH] [--bars-from-csv DIR]

WHY
Nine gates can kill a setup and until now one of them left evidence. A rejection
is a fully specified paper trade: entry, stop and target are all computed before
any gate fires. Walking real bars forward from each rejection asks the question
nobody can answer today - what did this constraint cost, or save? A gate whose
rejections would have LOST money is earning its keep. A gate whose rejections
would have WON is charging the account for nothing.

That turns a guess into a measurement without funding the experiment, which
matters because the binding constraint on this system is sample size.

READS both ledgers, never writes to either:
  tasks/rejections.jsonl   - the new schema, every gate
  tasks/rr_rejected.jsonl  - frozen, old schema, real historical MIN_RR evidence
Old rows carry no `gate` field and are normalised to MIN_RR, which is what they
are by construction. A row in the NEW file with no `gate` is NOT assumed to be
MIN_RR - it is reported as UNSPECIFIED, because crediting the R:R gate with
another gate's evidence is exactly the kind of quiet misattribution this ledger
exists to end.

Bars come from the broker's own terminal, keyed on each row's `sourceSymbol` -
never `ticker`. `ticker` is always the Yahoo symbol regardless of which feed
supplied the bars, and GC=F futures sat ~60 dollars away from XAUUSD spot when
the first rows were written. Scoring a row against the wrong series gives a
confidently wrong answer, which is worse than having no answer.

WRITES tasks/rejections_scored.jsonl (derived, rewritten each run) and a summary
to stdout.

HONESTY RULES BUILT IN
- A row whose horizon has not elapsed scores PENDING, not a guess.
- A bar that contains BOTH the stop and the target scores AMBIGUOUS. Daily OHLC
  cannot say which was touched first and this script will not pretend otherwise.
- A window that runs past the end of the available history scores INCOMPLETE_DATA
  rather than being marked to market on a truncated walk.
- Gates re-fire every refresh, so one real setup drifting over a few hours
  produces many near-identical rows. Rows are grouped into EPISODES and every
  table counts episodes, because seven rows of one Gold short are one piece of
  evidence, not seven.
- No verdict is rendered for a gate below MIN_RESOLVED_EPISODES resolved
  episodes. INSUFFICIENT EVIDENCE is a real answer and for most gates it will be
  the answer for weeks. The failure mode this guards against is loosening a gate
  so that something - anything - happens.
- Not every gate is scoreable the same way. See GATE_CLASS below.
"""

import bisect
import csv
import json
import os
import sys
from collections import defaultdict
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LEDGER_PATH = os.path.join(ROOT, "tasks", "rejections.jsonl")
LEGACY_PATH = os.path.join(ROOT, "tasks", "rr_rejected.jsonl")
SCORED_PATH = os.path.join(ROOT, "tasks", "rejections_scored.jsonl")
HISTORY_DIR = os.path.join(ROOT, "tasks", "history")

# Seconds per bar, and how many bars a setup gets to resolve. A D1 mean-reversion
# short that has not touched either level in a month was not the trade the setup
# described, so it is marked to market rather than left open forever.
BAR_SECONDS = {"D1": 86400, "H4": 14400, "H1": 3600}
HORIZON_BARS = {"D1": 20, "H4": 30, "H1": 48}

# Same cost basis the rest of the project measures against (see mtf_walkforward.cjs).
COST_R = 0.05

# Two rows belong to the same episode when they share gate, instrument, timeframe,
# setup and direction AND are no further apart than this many bars. The gates
# re-fire on every 30-minute refresh, so consecutive rows are minutes apart; a
# genuinely new occurrence of the same setup days later is separate evidence.
EPISODE_GAP_BARS = 2

# The project's own floor for drawing any conclusion. Below this, a gate gets a
# number and no verdict.
MIN_RESOLVED_EPISODES = 5

# R per episode inside this band is noise, not a finding. Without it, a gate that
# came out at +0.02R/episode over five episodes reads as "costing money".
NEUTRAL_R_PER_EPISODE = 0.10

# Above this share of ambiguous episodes the resolved subset is no longer a fair
# sample: an AMBIGUOUS bar is a wide, volatile bar, so excluding them keeps the
# calm ones and quietly flatters whatever the remainder says.
AMBIGUITY_WARN_SHARE = 0.25

RR_BANDS = [
    ("< 1.20", 0.00, 1.20),
    ("1.20-1.34", 1.20, 1.35),
    ("1.35-1.49", 1.35, 1.50),
]

# ---------------------------------------------------------------------------
# Gate scoreability. This is the heart of the honest reading of the ledger.
#
# QUALITY   - the gate's claim is "this setup is not good enough". Walking it
#             forward tests exactly that claim, so the walk-forward scores THE
#             GATE. Rejections that lose money mean the gate is earning its keep.
#
# CONTEXT   - the gate rejects on state, not on the setup's merit. The levels are
#             real and can be walked forward, but the result answers "what would
#             this have done", NOT "was this gate right". A NEWS_BLACKOUT
#             rejection that would have won does not make the blackout wrong; it
#             makes that one draw lucky, and the gate exists because of the
#             variance, not the mean. These get numbers and no verdict, ever.
#
# NOT_FORGONE - the setup was not skipped. DUPLICATE means the position was
#             already open, so the outcome is already in the journal. Scoring it
#             as forgone profit would double-count a trade the system did make.
#             Episode counts only, no R.
# ---------------------------------------------------------------------------
GATE_CLASS = {
    "MIN_RR": "QUALITY",
    "ENTRY_RSI": "QUALITY",
    "CONFIDENCE": "QUALITY",
    "COHORT_FLOOR": "QUALITY",
    "AI_FILTER": "QUALITY",
    "NEWS_BLACKOUT": "CONTEXT",
    "STALE_SOURCE": "CONTEXT",
    "SPREAD": "CONTEXT",
    "MAX_POSITIONS": "CONTEXT",
    "DUPLICATE": "NOT_FORGONE",
}

GATE_CAVEAT = {
    "NEWS_BLACKOUT": "rejects on event risk, not setup merit - the gate buys variance reduction, which a mean cannot price",
    "STALE_SOURCE": "the levels were priced on data the engine itself distrusted, so the inputs to this walk are suspect too",
    "SPREAD": "R is OPTIMISTIC - the quoted entry was never available; the spread that killed it is not modelled here",
    "MAX_POSITIONS": "forgone, but taking it would have changed portfolio exposure - this is not a like-for-like counterfactual",
}

UNSPECIFIED_GATE = "UNSPECIFIED"
LEGACY_GATE = "MIN_RR"


def log(msg):
    print(msg, flush=True)


# ---------------------------------------------------------------------------
# Loading and normalising
# ---------------------------------------------------------------------------

def load_rows(path):
    """Read one append-only rejection log. A malformed line is reported and
    skipped rather than aborting the run - these files are written by a
    swallowed-error logger on the signal path, so a truncated final line is a
    realistic outcome of a crash mid-append and must not cost us every row
    before it."""
    if not os.path.exists(path):
        return []

    rows = []
    with open(path, "r", encoding="utf-8") as handle:
        for lineno, line in enumerate(handle, 1):
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as err:
                log("  %s: skipping malformed line %d: %s" % (os.path.basename(path), lineno, err))
    return rows


def normalise_row(raw, source_file, is_legacy):
    """Bring a row of either schema into one shape.

    Legacy rows predate the `gate` field entirely and were written by exactly one
    call site, the R:R gate, so MIN_RR is a fact about them rather than a guess.
    A new-schema row with no gate is a schema violation and is labelled as such.
    """
    if is_legacy:
        gate = LEGACY_GATE
        threshold = raw.get("minRr")
        actual = raw.get("rr")
        side = "engine"
    else:
        gate = raw.get("gate") or UNSPECIFIED_GATE
        threshold = raw.get("threshold")
        actual = raw.get("actual")
        side = raw.get("side")

    return {
        "ts": raw.get("ts"),
        "gate": gate,
        "side": side,
        "ticker": raw.get("ticker"),
        "label": raw.get("label"),
        "dataSource": raw.get("dataSource"),
        "sourceSymbol": raw.get("sourceSymbol"),
        "timeframe": raw.get("timeframe"),
        "setup": raw.get("setup"),
        "direction": raw.get("direction"),
        "entry": raw.get("entry"),
        "stop": raw.get("stop"),
        "target": raw.get("target"),
        "rr": raw.get("rr"),
        "confidence": raw.get("confidence"),
        "strength": raw.get("strength"),
        "threshold": threshold,
        "actual": actual,
        "account": raw.get("account"),
        "sourceFile": source_file,
    }


def identity_signature(row):
    """What makes two rows the same recorded event. Used only to suppress an
    exact duplicate appearing in both files - if the frozen legacy log were ever
    migrated into the new one, every sample size below would silently double."""
    return (
        row.get("ts"), row.get("gate"), row.get("sourceSymbol"), row.get("timeframe"),
        row.get("setup"), row.get("direction"), row.get("entry"), row.get("stop"),
        row.get("target"),
    )


def load_ledger(ledger_path, legacy_path):
    """Both files, normalised into one list. Returns (rows, provenance)."""
    provenance = {"ledger": 0, "legacy": 0, "duplicatesSuppressed": 0}
    rows = []
    seen = set()

    for path, is_legacy, key in ((legacy_path, True, "legacy"), (ledger_path, False, "ledger")):
        if not path:
            continue
        for raw in load_rows(path):
            if not isinstance(raw, dict):
                continue
            row = normalise_row(raw, os.path.basename(path), is_legacy)
            signature = identity_signature(row)
            if signature in seen:
                provenance["duplicatesSuppressed"] += 1
                continue
            seen.add(signature)
            rows.append(row)
            provenance[key] += 1

    return rows, provenance


def parse_ts(value):
    """ISO-8601 with a trailing Z, as written by JavaScript's toISOString()."""
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).replace(tzinfo=timezone.utc)
    except ValueError:
        return None


# ---------------------------------------------------------------------------
# Bar sources
# ---------------------------------------------------------------------------

class Mt5BarSource:
    """The broker's own terminal. These levels were priced on this series and no
    other, so this is the default and the only source used for live reporting."""

    name = "MT5 terminal (broker bars)"

    def __init__(self):
        self._mt5 = None
        self._timeframes = {}
        self._offsets = {}

    def open(self):
        try:
            import MetaTrader5 as mt5
        except ImportError:
            log("MetaTrader5 package not installed. Run: pip install MetaTrader5")
            return False

        self._mt5 = mt5
        self._timeframes = {
            "D1": mt5.TIMEFRAME_D1,
            "H4": mt5.TIMEFRAME_H4,
            "H1": mt5.TIMEFRAME_H1,
        }
        terminal_path = os.environ.get("MT5_TERMINAL_PATH", "")
        initialised = mt5.initialize(terminal_path) if terminal_path else mt5.initialize()
        if not initialised:
            log("MT5 initialize() failed: %s" % (mt5.last_error(),))
            log("Run this on a machine whose MT5 terminal is logged in; the broker's own")
            log("bars are the only series these levels were priced on.")
            return False
        return True

    def offset_seconds(self, symbol):
        """Broker server time minus UTC, in seconds.

        MT5 stamps every bar in the broker's server timezone but hands it over as
        a plain unix integer, so comparing a bar's `time` against a UTC timestamp
        is off by the server offset - typically 2-3 hours, which is enough to pick
        the wrong daily bar as "the one after the rejection". Measured from a live
        tick rather than hardcoded, because brokers change it at DST.
        """
        if symbol in self._offsets:
            return self._offsets[symbol]

        offset = 0
        tick = self._mt5.symbol_info_tick(symbol)
        if tick is not None and tick.time:
            now_utc = datetime.now(timezone.utc).timestamp()
            # Round to the nearest half hour: the raw difference carries tick
            # latency, and no broker runs an offset finer than that.
            offset = int(round((tick.time - now_utc) / 1800.0) * 1800)
        self._offsets[symbol] = offset
        return offset

    def bars(self, symbol, timeframe, start_broker_epoch, end_broker_epoch):
        """Bars in [start, end], in BROKER epoch seconds. Returns [] on any
        failure so one unavailable symbol cannot take the whole run down."""
        tf = self._timeframes.get(timeframe)
        if tf is None:
            return []
        rates = self._mt5.copy_rates_range(
            symbol, tf,
            datetime.fromtimestamp(start_broker_epoch, tz=timezone.utc),
            datetime.fromtimestamp(end_broker_epoch, tz=timezone.utc),
        )
        if rates is None:
            log("  copy_rates_range failed for %s %s: %s" % (symbol, timeframe, self._mt5.last_error()))
            return []
        return list(rates)

    def coverage_end(self, symbol, timeframe):
        """The terminal streams to the present, so nothing is truncated. None
        means "coverage is not the limiting factor here"."""
        return None

    def close(self):
        if self._mt5 is not None:
            self._mt5.shutdown()


class CsvBarSource:
    """Bars from tasks/history/<SYMBOL>_<TF>.csv.

    This exists for verification: synthetic rows can be built over known bars and
    checked against answers computed by hand, which is the only way to show the
    walk-forward is right rather than merely self-consistent. It is never a
    fallback - if MT5 is down the run fails loudly instead of silently reporting
    a clean result off a different series.
    """

    name = "CSV history"

    def __init__(self, directory):
        self.directory = directory
        self._series = {}

    def open(self):
        if not os.path.isdir(self.directory):
            log("CSV history directory not found: %s" % self.directory)
            return False
        return True

    def offset_seconds(self, symbol):
        """CSV timestamps are the file's own epochs; there is no second clock to
        reconcile them with."""
        return 0

    def _load(self, symbol, timeframe):
        key = (symbol, timeframe)
        if key in self._series:
            return self._series[key]

        path = os.path.join(self.directory, "%s_%s.csv" % (symbol, timeframe))
        times = []
        bars = []
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8", newline="") as handle:
                for record in csv.DictReader(handle):
                    try:
                        bar = {
                            "time": int(record["time"]),
                            "open": float(record["open"]),
                            "high": float(record["high"]),
                            "low": float(record["low"]),
                            "close": float(record["close"]),
                        }
                    except (KeyError, TypeError, ValueError):
                        continue
                    times.append(bar["time"])
                    bars.append(bar)
        else:
            log("  no CSV history for %s %s" % (symbol, timeframe))

        self._series[key] = (times, bars)
        return self._series[key]

    def bars(self, symbol, timeframe, start_broker_epoch, end_broker_epoch):
        times, bars = self._load(symbol, timeframe)
        left = bisect.bisect_left(times, int(start_broker_epoch))
        right = bisect.bisect_right(times, int(end_broker_epoch))
        return bars[left:right]

    def coverage_end(self, symbol, timeframe):
        times, _bars = self._load(symbol, timeframe)
        return times[-1] if times else None

    def close(self):
        return None


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------

def score_row(row, bars, horizon_end_utc, now_epoch, data_end_epoch=None,
              horizon_end_broker=None):
    """Walk bars forward and decide which level price reached first.

    Returns (outcome, realised_R, detail). realised_R is None when the row cannot
    be scored yet or at all.
    """
    entry = row.get("entry")
    stop = row.get("stop")
    target = row.get("target")
    direction = str(row.get("direction") or "").upper()

    if not all(isinstance(value, (int, float)) for value in (entry, stop, target)):
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

    if now_epoch < horizon_end_utc:
        return "PENDING", None, "horizon has not elapsed yet"

    if data_end_epoch is not None and horizon_end_broker is not None \
            and data_end_epoch < horizon_end_broker:
        # The walk ran off the end of the series. Marking this to market would
        # report a verdict on a window we never actually saw.
        return "INCOMPLETE_DATA", None, "history ends before the horizon does"

    if not bars:
        return "NO_DATA", None, "no bars returned for this window"

    # Neither level reached inside the horizon. Mark to market so a setup that
    # drifted nowhere counts as the near-nothing it was, rather than vanishing.
    last_close = bars[-1]["close"]
    movement = (entry - last_close) if is_short else (last_close - entry)
    return "TIMEOUT", round(movement / risk - COST_R, 3), "neither level reached in %d bars" % len(bars)


def group_episodes(rows):
    """Assign an episode id to each row. One real setup drifting across refreshes
    is one piece of evidence; counting its rows as independent would inflate
    every sample size in the summary.

    `gate` is part of the key. Two gates rejecting the same drifting setup within
    the same window are two separate facts about two separate constraints, and
    merging them would attribute one gate's R to whichever gate happened to sort
    first - the precise kind of misattribution this ledger exists to end.
    """
    keyed = defaultdict(list)
    for row in rows:
        key = (
            row.get("gate"),
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
        gap_limit = BAR_SECONDS.get(key[2], 86400) * EPISODE_GAP_BARS
        previous_ts = None
        for row in group:
            ts = parse_ts(row.get("ts"))
            if previous_ts is None or ts is None or (ts.timestamp() - previous_ts) > gap_limit:
                counter += 1
            episode_of[id(row)] = counter
            if ts is not None:
                previous_ts = ts.timestamp()
    return episode_of


def walk_window(ts_utc_epoch, timeframe, offset_seconds, horizon_mult):
    """The bar-aligned window a rejection is scored over, in BROKER epoch seconds.

    The bar in progress when the gate fired already contains the price that
    produced these levels, so counting it would let a setup "hit" a level derived
    from it. Skip exactly that one bar - floor to the bar boundary in broker time
    and start at the next. Adding a raw bar-width to an intraday timestamp
    instead lands mid-way through the following bar and silently discards it too,
    which for a D1 row threw away a whole trading day of the walk.
    """
    bar_seconds = BAR_SECONDS[timeframe]
    horizon = max(1, int(HORIZON_BARS[timeframe] * horizon_mult))

    ts_broker = ts_utc_epoch + offset_seconds
    current_bar_open = ts_broker - (ts_broker % bar_seconds)
    start_broker = current_bar_open + bar_seconds
    end_broker = start_broker + bar_seconds * horizon
    return start_broker, end_broker, horizon


def score_ledger(rows, source, horizon_mult, now_epoch):
    """Score every row. Returns the list of scored records."""
    episode_of = group_episodes(rows)
    scored = []

    for row in rows:
        symbol = row.get("sourceSymbol")
        timeframe = row.get("timeframe")
        ts = parse_ts(row.get("ts"))

        base = {
            "ts": row.get("ts"),
            "episode": episode_of.get(id(row)),
            "gate": row.get("gate"),
            "gateClass": GATE_CLASS.get(row.get("gate"), "UNKNOWN"),
            "side": row.get("side"),
            "symbol": symbol,
            "timeframe": timeframe,
            "setup": row.get("setup"),
            "direction": row.get("direction"),
            "entry": row.get("entry"),
            "stop": row.get("stop"),
            "target": row.get("target"),
            "rr": row.get("rr"),
            "confidence": row.get("confidence"),
            "threshold": row.get("threshold"),
            "actual": row.get("actual"),
            "sourceFile": row.get("sourceFile"),
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

        offset = source.offset_seconds(symbol)
        start_broker, end_broker, horizon = walk_window(
            ts.timestamp(), timeframe, offset, horizon_mult)
        end_utc = end_broker - offset

        bars = source.bars(symbol, timeframe, start_broker, end_broker)
        outcome, realised_r, detail = score_row(
            row, bars, end_utc, now_epoch,
            data_end_epoch=source.coverage_end(symbol, timeframe),
            horizon_end_broker=end_broker)

        scored.append(dict(base, outcome=outcome, r=realised_r, detail=detail,
                           barsChecked=len(bars), horizonBars=horizon,
                           brokerOffsetHours=offset / 3600.0))

    return scored


def episodes_from_scored(scored):
    """One verdict per episode: the earliest row in it that actually resolved to
    an R figure. Later rows are the same trade seen again a few minutes later, at
    levels that drifted with price. If nothing in the episode resolved, the first
    row stands so the episode still appears in the outcome counts."""
    by_episode = {}
    for entry in scored:
        eid = entry["episode"]
        held = by_episode.get(eid)
        if held is None or (held["r"] is None and entry["r"] is not None):
            by_episode[eid] = entry
    return by_episode


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------

def band_for(rr):
    if not isinstance(rr, (int, float)):
        return "unknown"
    for label, low, high in RR_BANDS:
        if low <= rr < high:
            return label
    return ">= 1.50"


def gate_stats(episodes):
    """Counts and R totals for one gate's episodes."""
    resolved = [e for e in episodes if e["r"] is not None]
    total_r = sum(e["r"] for e in resolved)
    return {
        "episodes": len(episodes),
        "resolved": len(resolved),
        "wins": sum(1 for e in resolved if e["r"] > 0),
        "losses": sum(1 for e in resolved if e["r"] <= 0),
        "ambiguous": sum(1 for e in episodes if e["outcome"] == "AMBIGUOUS"),
        "pending": sum(1 for e in episodes if e["outcome"] == "PENDING"),
        "unscorable": sum(1 for e in episodes
                          if e["outcome"] in ("UNSCORABLE", "NO_DATA", "INCOMPLETE_DATA")),
        "totalR": total_r,
        "rPerEpisode": (total_r / len(resolved)) if resolved else 0.0,
    }


def quality_verdict(stats):
    """The only place a verdict is rendered, and it refuses more often than not.

    Rejections that LOST money mean the gate saved that loss - it is earning its
    keep. Rejections that WON mean the gate is charging the account for nothing.
    """
    if stats["resolved"] < MIN_RESOLVED_EPISODES:
        return "INSUFFICIENT EVIDENCE (%d/%d)" % (stats["resolved"], MIN_RESOLVED_EPISODES)
    per_episode = stats["rPerEpisode"]
    if abs(per_episode) < NEUTRAL_R_PER_EPISODE:
        return "NO MEASURABLE EFFECT"
    if per_episode < 0:
        return "EARNING ITS KEEP (saved %.2fR)" % (-stats["totalR"])
    return "COSTING MONEY (forgone %.2fR)" % stats["totalR"]


HEADER_FORMAT = "%-16s %5s %5s %4s %5s %6s %5s %8s %8s  %s"
ROW_FORMAT = "%-16s %5d %5d %4d %5d %6d %5d %8.2f %8.2f  %s"


def print_gate_table(title, gate_groups, verdict_for):
    log("")
    log(title)
    log("-" * 110)
    log(HEADER_FORMAT % ("GATE", "EPIS", "RSLV", "WIN", "LOSS", "AMBIG", "PEND",
                         "TOTAL R", "R/EPIS", "READING"))
    for gate in sorted(gate_groups):
        stats = gate_stats(gate_groups[gate])
        log(ROW_FORMAT % (
            gate[:16], stats["episodes"], stats["resolved"], stats["wins"],
            stats["losses"], stats["ambiguous"], stats["pending"],
            stats["totalR"], stats["rPerEpisode"], verdict_for(gate, stats)))

        if stats["episodes"] and stats["ambiguous"] / float(stats["episodes"]) > AMBIGUITY_WARN_SHARE:
            log("%-16s   ^ %d of %d episodes are AMBIGUOUS. An ambiguous bar is a wide bar,"
                % ("", stats["ambiguous"], stats["episodes"]))
            log("%-16s     so what remains is the calm half of the sample. Read the R above"
                % "")
            log("%-16s     as biased, not merely thin." % "")


def summarise(scored, provenance, source_name):
    by_episode = episodes_from_scored(scored)
    episodes = list(by_episode.values())

    log("")
    log("=" * 110)
    log("UNIVERSAL REJECTION LEDGER - GATE SCORECARD")
    log("=" * 110)
    log("bars: %s" % source_name)
    log("rows: %d from rejections.jsonl, %d from rr_rejected.jsonl (legacy -> MIN_RR)%s"
        % (provenance["ledger"], provenance["legacy"],
           ", %d exact duplicates suppressed" % provenance["duplicatesSuppressed"]
           if provenance["duplicatesSuppressed"] else ""))
    log("%d rejection rows -> %d independent episodes" % (len(scored), len(episodes)))

    outcomes = defaultdict(int)
    for entry in episodes:
        outcomes[entry["outcome"]] += 1
    log("episode outcomes: " + ", ".join(
        "%s %d" % (name, count) for name, count in sorted(outcomes.items())))

    by_class = defaultdict(lambda: defaultdict(list))
    for entry in episodes:
        gate = entry["gate"] or UNSPECIFIED_GATE
        by_class[GATE_CLASS.get(gate, "UNKNOWN")][gate].append(entry)

    if by_class["QUALITY"]:
        print_gate_table(
            "SETUP-QUALITY GATES - the walk-forward tests the gate's own claim",
            by_class["QUALITY"],
            lambda gate, stats: quality_verdict(stats))
        log("")
        log("  These gates all claim the same thing: 'this setup is not good enough'.")
        log("  Walking the rejected levels forward tests exactly that claim. Negative R")
        log("  means the gate saved that money; positive R means it charged for nothing.")

    if by_class["CONTEXT"]:
        print_gate_table(
            "STATE & EXECUTION GATES - what these WOULD have done, not whether the gate was RIGHT",
            by_class["CONTEXT"],
            lambda gate, stats: GATE_CAVEAT.get(gate, "state-based - outcome only")[:40])
        log("")
        log("  These gates do not reject on the setup's merit, so their rejections cannot")
        log("  score them. NEWS_BLACKOUT buys variance reduction - a mean cannot price")
        log("  that, and one lucky draw through a release is not evidence the gate is")
        log("  wrong. STALE_SOURCE distrusted the very prices these levels came from.")
        log("  SPREAD's R is optimistic: the quoted entry was never available and the")
        log("  spread that killed it is not modelled. No verdict is rendered here at any")
        log("  sample size. The numbers describe outcomes; they do not judge the gate.")

    if by_class["NOT_FORGONE"]:
        log("")
        log("NOT FORGONE - the trade was already taken")
        log("-" * 110)
        for gate in sorted(by_class["NOT_FORGONE"]):
            group = by_class["NOT_FORGONE"][gate]
            log("  %-16s %d episodes - position already open; the outcome is in the journal." % (gate, len(group)))
        log("  Scoring these as forgone profit would double-count trades the system made.")
        log("  No R is reported for them, at any sample size.")

    if by_class["UNKNOWN"]:
        log("")
        log("UNRECOGNISED GATES - not in the ledger enum, reported rather than silently binned")
        log("-" * 110)
        for gate in sorted(by_class["UNKNOWN"]):
            log("  %-16s %d episodes" % (gate, len(by_class["UNKNOWN"][gate])))
        log("  A row landing here means a writer emitted a gate name the spec does not")
        log("  define, or omitted `gate` from the new-schema file. Fix the writer; these")
        log("  are NOT folded into MIN_RR.")

    summarise_rr_bands(by_class["QUALITY"].get("MIN_RR", []))

    log("")
    log("=" * 110)
    log("Costed at %.2fR per trade. %d resolved episodes is this project's floor for"
        % (COST_R, MIN_RESOLVED_EPISODES))
    log("drawing any conclusion, applied PER GATE - a gate with one episode does not")
    log("borrow credibility from a gate with forty. INSUFFICIENT EVIDENCE is the")
    log("expected reading for most gates for weeks, and it is a success: it means the")
    log("ledger is honest about how little it knows yet. The failure this guards")
    log("against is loosening a gate so that something - anything - happens.")


def summarise_rr_bands(min_rr_episodes):
    """The original measurement this script was written for, preserved: which R:R
    band the 1.5 bar is refusing, and what those refusals were worth."""
    resolved = [e for e in min_rr_episodes if e["r"] is not None]
    if not resolved:
        return

    log("")
    log("MIN_RR BY R:R BAND - which slice of the 1.5 bar is doing the work")
    log("-" * 110)
    log("%-12s %6s %6s %6s %8s %8s" % ("R:R BAND", "EPIS", "WIN", "LOSS", "TOTAL R", "R/EPIS"))

    bands = defaultdict(list)
    for entry in resolved:
        bands[band_for(entry["rr"])].append(entry)

    for label in [band[0] for band in RR_BANDS] + [">= 1.50", "unknown"]:
        group = bands.get(label)
        if not group:
            continue
        wins = sum(1 for e in group if e["r"] > 0)
        losses = sum(1 for e in group if e["r"] <= 0)
        total_r = sum(e["r"] for e in group)
        flag = "" if len(group) >= MIN_RESOLVED_EPISODES else "  (below floor - number only)"
        log("%-12s %6d %6d %6d %8.2f %8.2f%s" % (
            label, len(group), wins, losses, total_r, total_r / len(group), flag))

    total_r = sum(e["r"] for e in resolved)
    log("%-12s %6d %6s %6s %8.2f %8.2f" % (
        "ALL", len(resolved), "", "", total_r, total_r / len(resolved)))


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def read_option(argv, flag):
    """Value following `flag`, or None if absent. Raises ValueError if the flag is
    present with nothing after it, so a typo fails loudly instead of silently
    scoring the defaults."""
    if flag not in argv:
        return None
    index = argv.index(flag) + 1
    if index >= len(argv):
        raise ValueError("%s needs a value" % flag)
    return argv[index]


def main():
    argv = sys.argv[1:]

    try:
        horizon_raw = read_option(argv, "--horizon-mult")
        input_path = read_option(argv, "--input")
        output_path = read_option(argv, "--output")
        csv_dir = read_option(argv, "--bars-from-csv")
    except ValueError as err:
        log(str(err))
        return 1

    horizon_mult = 1.0
    if horizon_raw is not None:
        try:
            horizon_mult = float(horizon_raw)
        except ValueError:
            log("--horizon-mult needs a number, e.g. --horizon-mult 2")
            return 1
        if horizon_mult <= 0:
            log("--horizon-mult must be positive")
            return 1

    # --input scores one file instead of both. The other box's log can be scored
    # here without merging the two - rows from two machines in one file would
    # destroy the provenance the whole exercise depends on.
    if input_path:
        rows, provenance = load_ledger(input_path, None)
        provenance["legacy"], provenance["ledger"] = provenance["ledger"], 0
        if output_path is None:
            output_path = os.path.splitext(input_path)[0] + "_scored.jsonl"
    else:
        rows, provenance = load_ledger(LEDGER_PATH, LEGACY_PATH)
        if output_path is None:
            output_path = SCORED_PATH

    if not rows:
        log("No rejections logged yet.")
        log("  %s" % LEDGER_PATH)
        log("  %s" % LEGACY_PATH)
        log("Neither file has any rows. They are written by the gate call sites in")
        log("server/index.js and mt5_bridge.py.")
        return 0

    # CSV is explicit-only and never a fallback: silently scoring broker-priced
    # levels against a different series would report a clean run on the wrong
    # answer, which is worse than reporting that MT5 is down.
    source = CsvBarSource(csv_dir) if csv_dir else Mt5BarSource()
    if not source.open():
        return 1

    try:
        now_epoch = datetime.now(timezone.utc).timestamp()
        scored = score_ledger(rows, source, horizon_mult, now_epoch)

        with open(output_path, "w", encoding="utf-8") as handle:
            for entry in scored:
                handle.write(json.dumps(entry) + "\n")

        log("Wrote %d scored rows to %s" % (len(scored), output_path))
        summarise(scored, provenance, source.name)
        return 0
    finally:
        source.close()


if __name__ == "__main__":
    sys.exit(main())
