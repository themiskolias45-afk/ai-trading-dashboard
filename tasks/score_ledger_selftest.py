"""Known-answer tests for the universal rejection ledger scorer.

    python tasks/score_ledger_selftest.py

A scorer that agrees with itself proves nothing. Every expectation here is
computed independently of score_rr_rejections.py:

- The price cases are built over named bars of tasks/history/XAUUSD_D1.csv that
  were read by hand. Each case states the bar that must resolve it and the R that
  follows from that bar's printed OHLC by two lines of arithmetic. If the walk
  drifts by one bar, or applies the broker offset the wrong way, or counts the
  bar the levels were derived from, these numbers stop matching.
- The window-alignment cases assert raw epoch integers, so they cannot be
  satisfied by any accidentally-symmetric bug in the fetch path.
- The ledger cases assert classification and grouping, which is where a
  multi-gate ledger silently misattributes one gate's evidence to another.

Requires no MT5: it scores against CSV history through the same code path the
live run uses. It never writes to either source ledger and checks their hashes
to prove it.

Reference bars, read from tasks/history/XAUUSD_D1.csv:
    2023-11-22  O 1998.54  H 2006.38  L 1986.88  C 1989.67
    2023-11-23  O 1989.23  H 1998.48  L 1989.22  C 1992.60
    2023-11-24  O 1992.80  H 2003.61  L 1991.40  C 2002.29
    2023-11-27  O 2001.92  H 2018.09  L 2000.53  C 2014.00
    2023-11-28  O 2014.16  H 2042.95  L 2011.63  C 2040.85
The 20-bar D1 window opening 2023-11-23 holds 15 trading bars, ends 2023-12-13
at close 2027.39, and spans low 1972.99 to high 2146.12.
"""

import hashlib
import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import score_rr_rejections as scorer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HISTORY_DIR = os.path.join(ROOT, "tasks", "history")
SYMBOL = "XAUUSD"

# Hand-read from the reference bars above.
BAR_1123_LOW = 1989.22
BAR_1123_HIGH = 1998.48
BAR_1124_HIGH = 2003.61
BAR_1128_HIGH = 2042.95
BAR_1128_LOW = 2011.63
WINDOW_LAST_CLOSE = 2027.39

# 2023-11-23T00:00:00Z and 2023-11-22T12:44:07Z as raw epochs.
EPOCH_1123_MIDNIGHT = 1700697600
TS_1122_INTRADAY = "2023-11-22T12:44:07.117Z"

FAILURES = []


def check(name, actual, expected):
    if actual == expected:
        print("  ok    %-52s %s" % (name, actual))
    else:
        print("  FAIL  %-52s got %r, expected %r" % (name, actual, expected))
        FAILURES.append(name)


def make_row(**overrides):
    row = {
        "ts": TS_1122_INTRADAY,
        "gate": "MIN_RR",
        "side": "engine",
        "ticker": "GC=F",
        "label": "Gold/XAUUSD",
        "dataSource": "mt5",
        "sourceSymbol": SYMBOL,
        "timeframe": "D1",
        "setup": "RANGE_TRADE_SHORT",
        "direction": "SELL",
        "entry": None,
        "stop": None,
        "target": None,
        "rr": 1.4,
        "confidence": 68,
        "strength": "MODERATE",
        "threshold": 1.5,
        "actual": 1.4,
        "account": None,
        "sourceFile": "selftest",
    }
    row.update(overrides)
    return row


def score(rows):
    source = scorer.CsvBarSource(HISTORY_DIR)
    if not source.open():
        raise SystemExit("CSV history missing at %s" % HISTORY_DIR)
    now_epoch = datetime.now(timezone.utc).timestamp()
    try:
        return scorer.score_ledger(rows, source, 1.0, now_epoch)
    finally:
        source.close()


def sha256(path):
    if not os.path.exists(path):
        return "absent"
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


# ---------------------------------------------------------------------------

def test_window_alignment():
    """The window must skip exactly the bar in progress, in BROKER time.

    A rejection is always stamped intraday - the gates fire on a 30-minute
    refresh - so this is the arithmetic every single row depends on.
    """
    print("\nwindow alignment (raw epochs, hand-computed)")
    ts = scorer.parse_ts(TS_1122_INTRADAY).timestamp()

    start_utc, end_utc, horizon = scorer.walk_window(ts, "D1", 0, 1.0)
    check("D1 window opens on the next bar, not the one after",
          int(start_utc), EPOCH_1123_MIDNIGHT)
    check("D1 window spans exactly HORIZON_BARS bars",
          int(end_utc - start_utc), 86400 * 20)
    check("horizon bars", horizon, 20)

    # A UTC+3 broker stamps the 2023-11-23 session as if it were 00:00 UTC, so
    # the raw integer is unchanged; what changes is which UTC instant falls in it.
    start_broker, _end, _h = scorer.walk_window(ts, "D1", 10800, 1.0)
    check("UTC+3 broker offset keeps the same session bar",
          int(start_broker), EPOCH_1123_MIDNIGHT)

    # An instant late enough that the broker's clock has already rolled over must
    # land on the FOLLOWING session, not the same one.
    late = scorer.parse_ts("2023-11-22T22:30:00.000Z").timestamp()
    start_late, _end, _h = scorer.walk_window(late, "D1", 10800, 1.0)
    check("22:30Z under UTC+3 is already the next broker day",
          int(start_late), EPOCH_1123_MIDNIGHT + 86400)

    start_h1, end_h1, _h = scorer.walk_window(ts, "H1", 0, 1.0)
    check("H1 window opens at 13:00Z", int(start_h1),
          int(scorer.parse_ts("2023-11-22T13:00:00.000Z").timestamp()))
    check("H1 window spans 48 bars", int(end_h1 - start_h1), 3600 * 48)


def test_price_outcomes():
    """Each case names the bar that must resolve it and the R that bar implies."""
    print("\nprice outcomes (expected values derived by hand from the bars above)")

    # 2023-11-23 low 1989.22 reaches the 1990.00 target; its high 1998.48 does
    # not reach the 1999.00 stop. Short: reward 6.00 on risk 3.00.
    # This case is the regression guard for window alignment: starting one bar
    # later instead lands on 2023-11-24, whose high 2003.61 takes out the stop,
    # and the verdict flips from +1.95R to -1.05R.
    scored = score([make_row(direction="SELL", entry=1996.00, stop=1999.00, target=1990.00)])[0]
    check("short resolves TARGET on 2023-11-23", scored["outcome"], "TARGET")
    check("  R = 6.00/3.00 - 0.05", scored["r"], round(6.00 / 3.00 - scorer.COST_R, 3))
    check("  (2023-11-23 low is at or below target)", BAR_1123_LOW <= 1990.00, True)
    check("  (2023-11-23 high is below the stop)", BAR_1123_HIGH < 1999.00, True)

    # 2023-11-23 reaches neither level; 2023-11-24 high 2003.61 takes the 2003.00
    # target. Long: reward 11.00 on risk 22.00.
    scored = score([make_row(direction="BUY", setup="RANGE_TRADE_LONG",
                             entry=1992.00, stop=1970.00, target=2003.00)])[0]
    check("long resolves TARGET on 2023-11-24", scored["outcome"], "TARGET")
    check("  R = 11.00/22.00 - 0.05", scored["r"], round(11.00 / 22.00 - scorer.COST_R, 3))
    check("  (2023-11-24 high clears the target)", BAR_1124_HIGH >= 2003.00, True)

    # Rejected 2023-11-24 intraday, so the walk opens 2023-11-27, whose high
    # 2018.09 takes the 2004.00 stop before the 1980.00 target.
    scored = score([make_row(ts="2023-11-24T09:00:00.000Z", direction="SELL",
                             entry=2000.00, stop=2004.00, target=1980.00)])[0]
    check("short resolves STOP on 2023-11-27", scored["outcome"], "STOP")
    check("  R = -1.00 - 0.05", scored["r"], round(-1.0 - scorer.COST_R, 3))

    # 2023-11-28 spans 2011.63-2042.95, containing both the 2012.00 stop and the
    # 2040.00 target. Daily OHLC cannot order them.
    scored = score([make_row(ts="2023-11-27T09:00:00.000Z", direction="BUY",
                             setup="RANGE_TRADE_LONG", entry=2015.00,
                             stop=2012.00, target=2040.00)])[0]
    check("one bar holding both levels is AMBIGUOUS", scored["outcome"], "AMBIGUOUS")
    check("  and carries no R", scored["r"], None)
    check("  (2023-11-28 contains the stop)", BAR_1128_LOW <= 2012.00, True)
    check("  (2023-11-28 contains the target)", BAR_1128_HIGH >= 2040.00, True)

    # Neither 1800.00 nor 2500.00 is touched in the 15 trading bars of the window,
    # which closes 2023-12-13 at 2027.39. Marked to market on risk 192.00.
    scored = score([make_row(direction="BUY", setup="RANGE_TRADE_LONG",
                             entry=1992.00, stop=1800.00, target=2500.00)])[0]
    check("untouched levels TIMEOUT", scored["outcome"], "TIMEOUT")
    check("  R = (2027.39 - 1992.00)/192.00 - 0.05", scored["r"],
          round((WINDOW_LAST_CLOSE - 1992.00) / 192.00 - scorer.COST_R, 3))
    check("  window held 15 trading bars", scored["barsChecked"], 15)


def test_refusals():
    """The cases where the honest answer is 'not yet' or 'never'."""
    print("\nrefusals - the answers the scorer must decline to give")

    future = (datetime.now(timezone.utc) - timedelta(days=2)).isoformat().replace("+00:00", "Z")
    scored = score([make_row(ts=future, direction="BUY", entry=4100.0,
                             stop=4000.0, target=4300.0)])[0]
    check("horizon not yet elapsed is PENDING", scored["outcome"], "PENDING")
    check("  and carries no R", scored["r"], None)

    # CSV history ends 2026-07-24; a 20-bar D1 walk opened 2026-07-11 needs bars
    # out to 2026-07-31 that do not exist. Marking to market on the truncated
    # window would report a verdict on bars never seen.
    scored = score([make_row(ts="2026-07-10T12:00:00.000Z", direction="BUY",
                             entry=4100.0, stop=1000.0, target=9000.0)])[0]
    check("walk running off the end of history is INCOMPLETE_DATA",
          scored["outcome"], "INCOMPLETE_DATA")
    check("  and carries no R", scored["r"], None)

    scored = score([make_row(sourceSymbol=None, direction="SELL",
                             entry=1996.0, stop=1999.0, target=1990.0)])[0]
    check("no sourceSymbol is UNSCORABLE", scored["outcome"], "UNSCORABLE")

    scored = score([make_row(direction="SELL", entry=None, stop=1999.0, target=1990.0)])[0]
    check("missing entry is UNSCORABLE", scored["outcome"], "UNSCORABLE")

    scored = score([make_row(direction="SELL", entry=1996.0, stop=1996.0, target=1990.0)])[0]
    check("zero stop distance is UNSCORABLE", scored["outcome"], "UNSCORABLE")

    scored = score([make_row(timeframe="M15", direction="SELL",
                             entry=1996.0, stop=1999.0, target=1990.0)])[0]
    check("unsupported timeframe is UNSCORABLE", scored["outcome"], "UNSCORABLE")


def test_episode_grouping():
    """Where a multi-gate ledger loses the plot if the key is wrong."""
    print("\nepisode grouping")

    levels = dict(direction="SELL", entry=1996.0, stop=1999.0, target=1990.0)

    drifting = [
        make_row(ts="2023-11-22T12:44:07.117Z", **levels),
        make_row(ts="2023-11-22T12:49:07.466Z", **dict(levels, entry=1995.5)),
        make_row(ts="2023-11-22T13:00:00.742Z", **dict(levels, entry=1995.0)),
    ]
    episodes = scorer.group_episodes(drifting)
    check("one setup drifting over 16 minutes is 1 episode",
          len(set(episodes.values())), 1)

    separated = [
        make_row(ts="2023-11-22T12:44:07.117Z", **levels),
        make_row(ts="2023-12-04T12:44:07.117Z", **levels),
    ]
    episodes = scorer.group_episodes(separated)
    check("the same setup 12 days later is 2 episodes",
          len(set(episodes.values())), 2)

    # Two gates killing the same drifting setup are two facts about two different
    # constraints. Merged, one gate's R gets billed to the other.
    two_gates = [
        make_row(ts="2023-11-22T12:44:07.117Z", gate="MIN_RR", **levels),
        make_row(ts="2023-11-22T12:44:07.117Z", gate="CONFIDENCE", **levels),
    ]
    episodes = scorer.group_episodes(two_gates)
    check("two gates on one setup are 2 episodes",
          len(set(episodes.values())), 2)


def test_normalisation():
    """Legacy rows are MIN_RR by construction. New rows without a gate are not."""
    print("\nschema normalisation")

    legacy_raw = {
        "ts": TS_1122_INTRADAY, "ticker": "GC=F", "sourceSymbol": "XAUUSD",
        "timeframe": "D1", "setup": "RANGE_TRADE_SHORT", "direction": "SELL",
        "entry": 4266.62, "stop": 4397.55, "target": 4075.53, "rr": 1.459,
        "minRr": 1.5, "trend": "MIXED", "rsi": 69.3,
    }
    row = scorer.normalise_row(legacy_raw, "rr_rejected.jsonl", is_legacy=True)
    check("legacy row becomes MIN_RR", row["gate"], "MIN_RR")
    check("legacy minRr becomes threshold", row["threshold"], 1.5)
    check("legacy rr becomes actual", row["actual"], 1.459)
    check("legacy row is engine-side", row["side"], "engine")
    check("legacy row has no account", row["account"], None)

    row = scorer.normalise_row({"ts": TS_1122_INTRADAY, "sourceSymbol": "XAUUSD"},
                               "rejections.jsonl", is_legacy=False)
    check("new row with no gate is NOT assumed MIN_RR", row["gate"], "UNSPECIFIED")

    row = scorer.normalise_row({"gate": "SPREAD", "account": "A", "side": "bridge"},
                               "rejections.jsonl", is_legacy=False)
    check("bridge row keeps its account", row["account"], "A")

    duplicated = os.path.join(tempfile.mkdtemp(), "dupes.jsonl")
    with open(duplicated, "w", encoding="utf-8") as handle:
        handle.write(json.dumps(legacy_raw) + "\n")
        handle.write(json.dumps(legacy_raw) + "\n")
    rows, provenance = scorer.load_ledger(duplicated, duplicated)
    check("an exact duplicate row is counted once", len(rows), 1)
    check("  and the suppression is reported", provenance["duplicatesSuppressed"], 3)


def test_gate_classification():
    """No gate may sit in the wrong table, and no verdict below the floor."""
    print("\ngate classification and verdicts")

    for gate in ("MIN_RR", "ENTRY_RSI", "CONFIDENCE", "COHORT_FLOOR", "AI_FILTER"):
        check("%s is a setup-quality gate" % gate, scorer.GATE_CLASS.get(gate), "QUALITY")
    for gate in ("NEWS_BLACKOUT", "STALE_SOURCE", "SPREAD", "MAX_POSITIONS"):
        check("%s is state/execution, not scoreable as a gate" % gate,
              scorer.GATE_CLASS.get(gate), "CONTEXT")
    check("DUPLICATE is not a forgone trade", scorer.GATE_CLASS.get("DUPLICATE"), "NOT_FORGONE")

    def episodes(rs):
        return [{"r": r, "outcome": "TARGET" if r and r > 0 else "STOP"} for r in rs]

    four_losers = scorer.gate_stats(episodes([-1.05] * 4))
    check("4 resolved episodes gets no verdict",
          scorer.quality_verdict(four_losers), "INSUFFICIENT EVIDENCE (4/5)")

    five_losers = scorer.gate_stats(episodes([-1.05] * 5))
    check("5 losing rejections means the gate saved that money",
          scorer.quality_verdict(five_losers).startswith("EARNING ITS KEEP"), True)

    five_winners = scorer.gate_stats(episodes([1.45] * 5))
    check("5 winning rejections means the gate is charging for nothing",
          scorer.quality_verdict(five_winners).startswith("COSTING MONEY"), True)

    noise = scorer.gate_stats(episodes([0.04, -0.03, 0.02, -0.01, 0.03]))
    check("a total inside the noise band is not a finding",
          scorer.quality_verdict(noise), "NO MEASURABLE EFFECT")

    ambiguous_heavy = scorer.gate_stats(
        episodes([-1.05, 1.45]) + [{"r": None, "outcome": "AMBIGUOUS"}] * 3)
    check("ambiguous episodes are counted, not dropped", ambiguous_heavy["ambiguous"], 3)
    check("  and excluded from resolved", ambiguous_heavy["resolved"], 2)


def test_source_files_untouched():
    """The ledgers are evidence. A scoring run must not alter a byte."""
    print("\nsource ledger integrity")

    before = {path: sha256(path) for path in (scorer.LEGACY_PATH, scorer.LEDGER_PATH)}

    output = os.path.join(tempfile.mkdtemp(), "scored.jsonl")
    result = subprocess.run(
        [sys.executable, os.path.join(ROOT, "tasks", "score_rr_rejections.py"),
         "--bars-from-csv", HISTORY_DIR, "--output", output],
        capture_output=True, text=True, cwd=ROOT)
    check("full CLI run exits clean", result.returncode, 0)

    after = {path: sha256(path) for path in (scorer.LEGACY_PATH, scorer.LEDGER_PATH)}
    check("rr_rejected.jsonl is byte-identical",
          after[scorer.LEGACY_PATH], before[scorer.LEGACY_PATH])
    check("rejections.jsonl is byte-identical",
          after[scorer.LEDGER_PATH], before[scorer.LEDGER_PATH])
    check("scored output was written", os.path.exists(output), True)

    bad = subprocess.run(
        [sys.executable, os.path.join(ROOT, "tasks", "score_rr_rejections.py"),
         "--horizon-mult"],
        capture_output=True, text=True, cwd=ROOT)
    check("a flag with no value fails loudly", bad.returncode, 1)


def main():
    print("=" * 78)
    print("REJECTION LEDGER SCORER - KNOWN-ANSWER TESTS")
    print("=" * 78)

    test_window_alignment()
    test_price_outcomes()
    test_refusals()
    test_episode_grouping()
    test_normalisation()
    test_gate_classification()
    test_source_files_untouched()

    print("")
    print("=" * 78)
    if FAILURES:
        print("FAILED %d check(s): %s" % (len(FAILURES), ", ".join(FAILURES)))
        return 1
    print("ALL CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
