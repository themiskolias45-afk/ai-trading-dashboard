#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Score the stop-variant shadow ledger: would a lower-timeframe stop have done better?

    python tasks/score_stop_variants.py [--bars-from-csv tasks/history] [--json]
                                        [--min-resolved N] [--output PATH]

Exit 0 always unless the ledger itself is unreadable. A verdict of "too few" is a
result, not a failure.

── WHY THIS EXISTS ───────────────────────────────────────────────────────────

`server/stop_variants.js` has been appending to `tasks/stop_variants.jsonl` since
2026-08-27 and **nothing has ever read it**. It is the only evidence file in this
project with a writer and no reader, which makes it the same shape as a setting with
no reader: it looks like the question is being worked on, and it is not.

The question it holds is worth settling. Every stop in the engine is 1.5x the DAILY
ATR, and measured against live bars that is 5.6x wider than 1.5x the H1 ATR on Gold.
That is not a bug — a daily stop on a daily setup is correct. But the binding
constraint on this system is SAMPLE SIZE, and a Gold D1 trade opened 2026-08-11 and
closed 2026-08-25: fourteen days for one data point. The claim being tested is not
"tighter stops earn more", it is "tighter stops resolve FASTER for the same R", which
is the only thing that actually moves the constraint.

── HOW IT AVOIDS BEING A SECOND OPINION ──────────────────────────────────────

It does NOT reimplement the walk-forward. It imports `score_row`, `walk_window`,
`CsvBarSource`, `Mt5BarSource`, `HORIZON_BARS`, `BAR_SECONDS` and `COST_R` from
`tasks/score_rr_rejections.py`, which is this repo's one forward-scoring
implementation. A second copy would be the thing that eventually disagrees with the
rejection ledger about what a stop-out is worth, and then neither number could be
trusted. Same reason `realizedRFromPrices` has exactly one implementation.

The one thing it adds is TIMING, because `score_row` returns a verdict and an R but
not how long the trade took, and duration is the entire hypothesis. `first_touch`
below finds only the index of the first bar to touch a level. It asserts its own
answer against `score_row`'s, so if the two ever drift apart the run fails loudly
instead of quietly reporting a duration for a different outcome.

── THE COMPARISON IS PAIRED, WHICH IS THE POINT ──────────────────────────────

Every row carries BOTH geometries: the variant stop/target and, under `baseline`,
the D1 stop/target the engine actually used for the same signal at the same entry.
Both arms are walked over THE SAME BARS in THE SAME WINDOW, so the only variable is
the level. An unpaired comparison — variant rows against journal trades — would be
confounded by which setups happened to fire.

── SAFETY ────────────────────────────────────────────────────────────────────

Read-only with respect to everything that trades. It reads the ledger and the bar
history, writes ONE report file, and carries `feedsTheGate: false`. It never opens
`learning.json`, the journal, the calibration record or any config. It cannot change
a stop, a target, a threshold or a lot size. Nothing imports it.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone

# Force UTF-8 stdout. Windows consoles default to cp1252 and this script prints the
# arrows and box characters below; without this it dies AFTER doing all the work, the
# same failure that took out the daily-plan cron for ten runs.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tasks"))

# The one forward-scoring implementation in this repo. Imported, never copied.
import score_rr_rejections as scorer  # noqa: E402

LEDGER_PATH = os.path.join(ROOT, "tasks", "stop_variants.jsonl")
DEFAULT_OUTPUT = os.path.join(ROOT, "tasks", "stop_variants_scored.jsonl")
DEFAULT_HISTORY = os.path.join(ROOT, "tasks", "history")

# Below this many resolved PAIRS the report states a count and refuses a verdict.
# Matches the rejection ledger's own floor so the two speak the same language.
DEFAULT_MIN_RESOLVED = 5

# Outcomes that mean "this row has an answer".
RESOLVED = ("TARGET", "STOP", "TIMEOUT")


def log(message):
    print(message)


def load_ledger(path):
    """Every line, with corrupt ones counted and KEPT rather than skipped silently."""
    rows, malformed = [], 0
    if not os.path.exists(path):
        return rows, malformed, False
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except ValueError:
                malformed += 1
    return rows, malformed, True


def dedupe_episodes(rows):
    """One episode per key.

    server/stop_variants.js appends on a cron tick, so the SAME signal reappears every
    time the tick runs while it is still live — the four rows on disk today are two
    signals written twice. Counting rows would double every number, which is exactly
    the bug `rejection_evidence` had when it counted rows instead of episodes.
    """
    seen = {}
    for row in rows:
        key = row.get("key")
        if not key:
            key = "%s|%s|%s|%s" % (row.get("symbol"), row.get("setup"),
                                   row.get("direction"), row.get("date"))
        # Keep the FIRST sighting: its levels are the ones that were live when the
        # signal formed, before any later tick recomputed the ATR.
        if key not in seen:
            seen[key] = row
    return list(seen.values())


def first_touch(bars, entry, stop, target, direction):
    """Index of the first bar to touch a level, and which one. Timing only.

    Deliberately NOT a second R calculation — it answers "when", and score_row answers
    "what it was worth". The caller asserts the two agree about WHICH level was hit.
    """
    is_long = direction == "BUY"
    for index, bar in enumerate(bars):
        high = bar.get("high")
        low = bar.get("low")
        if high is None or low is None:
            continue
        if is_long:
            hit_stop = low <= stop
            hit_target = high >= target
        else:
            hit_stop = high >= stop
            hit_target = low <= target
        # Both inside one bar: the pessimistic read is that the stop went first. Same
        # convention score_row uses, and it must stay the same or the assert fires.
        if hit_stop:
            return index, "STOP"
        if hit_target:
            return index, "TARGET"
    return None, None


def score_arm(row, levels, bars, horizon_end_utc, now_epoch, data_end_epoch,
              horizon_end_broker):
    """Score one geometry of a paired row. Returns a dict."""
    arm_row = {
        "entry": row.get("entry"),
        "stop": levels.get("stop"),
        "target": levels.get("target"),
        "direction": row.get("direction"),
        "sourceSymbol": row.get("sourceSymbol"),
    }
    outcome, realised_r, detail = scorer.score_row(
        arm_row, bars, horizon_end_utc, now_epoch,
        data_end_epoch=data_end_epoch, horizon_end_broker=horizon_end_broker)

    bars_to_resolve, touched = (None, None)
    if outcome in ("TARGET", "STOP"):
        bars_to_resolve, touched = first_touch(
            bars, arm_row["entry"], arm_row["stop"], arm_row["target"],
            str(arm_row["direction"] or "").upper())
        # The self-check described in the header. If these disagree, one of the two
        # implementations has drifted and every duration in the report is suspect.
        if touched is not None and touched != outcome:
            raise AssertionError(
                "timing scan says %s but score_row says %s for %s — the two walks have "
                "drifted apart; do not trust the durations" % (touched, outcome, row.get("key")))

    return {
        "outcome": outcome,
        "realizedR": realised_r,
        "detail": detail,
        "barsToResolve": bars_to_resolve,
        "stop": levels.get("stop"),
        "target": levels.get("target"),
        "stopPct": levels.get("stopPct"),
    }


def score_ledger(rows, source, now_epoch):
    """Walk every episode, both arms, over the same bars."""
    scored = []
    for row in rows:
        symbol = row.get("sourceSymbol") or row.get("symbol")
        baseline = row.get("baseline") or {}

        # The window comes from the BASELINE timeframe — the geometry the engine
        # actually shipped. Scoring the variant over a shorter window of its own would
        # hand it an easier test than the incumbent gets, which is how a challenger
        # wins on the harness rather than on the merits.
        timeframe = (baseline.get("timeframe") or "D1").upper()
        if timeframe not in scorer.HORIZON_BARS:
            timeframe = "D1"

        timestamp = scorer.parse_ts(row.get("at"))
        if timestamp is None:
            scored.append({"key": row.get("key"), "skipped": "unparseable timestamp"})
            continue

        offset = source.offset_seconds(symbol)
        # parse_ts returns an aware datetime; walk_window wants EPOCH SECONDS. Passing
        # the datetime straight through raises rather than misbehaving, which is the
        # good failure — but it is the kind of seam a copied implementation hides.
        start_broker, end_broker, horizon = scorer.walk_window(
            timestamp.timestamp(), timeframe, offset, 1.0)

        # Walk on the baseline timeframe's bars so both arms see identical price
        # action. The variant's advantage must come from its LEVEL, not from being
        # measured on finer bars that the incumbent never got.
        bars = source.bars(symbol, timeframe, start_broker, end_broker)
        data_end = source.coverage_end(symbol, timeframe)
        horizon_end_utc = end_broker - offset

        variant_levels = {"stop": row.get("stop"), "target": row.get("target"),
                          "stopPct": row.get("stopPct")}
        baseline_levels = {"stop": baseline.get("stop"), "target": baseline.get("target"),
                           "stopPct": baseline.get("stopPct")}

        variant = score_arm(row, variant_levels, bars, horizon_end_utc, now_epoch,
                            data_end, end_broker)
        incumbent = score_arm(row, baseline_levels, bars, horizon_end_utc, now_epoch,
                              data_end, end_broker)

        both_resolved = (variant["outcome"] in RESOLVED
                         and incumbent["outcome"] in RESOLVED)

        scored.append({
            "key": row.get("key"),
            "at": row.get("at"),
            "symbol": symbol,
            "setup": row.get("setup"),
            "direction": row.get("direction"),
            "confidence": row.get("confidence"),
            "fired": row.get("fired"),
            "entry": row.get("entry"),
            "variantTimeframe": row.get("variantTimeframe"),
            "baselineTimeframe": timeframe,
            "tighterThanLiveBy": row.get("tighterThanLiveBy"),
            "horizonBars": horizon,
            "barsAvailable": len(bars),
            "variant": variant,
            "baseline": incumbent,
            "pairResolved": both_resolved,
            "deltaR": (round(variant["realizedR"] - incumbent["realizedR"], 3)
                       if both_resolved and variant["realizedR"] is not None
                       and incumbent["realizedR"] is not None else None),
            "feedsTheGate": False,
        })
    return scored


def summarise(scored, min_resolved):
    pairs = [row for row in scored if row.get("pairResolved")]
    total = len([row for row in scored if not row.get("skipped")])

    summary = {
        "episodes": total,
        "pairsResolved": len(pairs),
        "minResolvedForVerdict": min_resolved,
        "variant": {"meanR": None, "medianBars": None, "wins": 0},
        "baseline": {"meanR": None, "medianBars": None, "wins": 0},
        "meanDeltaR": None,
        "speedup": None,
        "verdict": None,
        "feedsTheGate": False,
    }

    if not pairs:
        summary["verdict"] = "NOTHING RESOLVED YET"
        return summary

    def mean(values):
        clean = [v for v in values if isinstance(v, (int, float))]
        return round(sum(clean) / len(clean), 3) if clean else None

    def median(values):
        clean = sorted(v for v in values if isinstance(v, (int, float)))
        if not clean:
            return None
        middle = len(clean) // 2
        if len(clean) % 2:
            return clean[middle]
        return round((clean[middle - 1] + clean[middle]) / 2, 1)

    summary["variant"]["meanR"] = mean([p["variant"]["realizedR"] for p in pairs])
    summary["baseline"]["meanR"] = mean([p["baseline"]["realizedR"] for p in pairs])
    summary["variant"]["medianBars"] = median([p["variant"]["barsToResolve"] for p in pairs])
    summary["baseline"]["medianBars"] = median([p["baseline"]["barsToResolve"] for p in pairs])
    summary["variant"]["wins"] = sum(1 for p in pairs if p["variant"]["outcome"] == "TARGET")
    summary["baseline"]["wins"] = sum(1 for p in pairs if p["baseline"]["outcome"] == "TARGET")
    summary["meanDeltaR"] = mean([p["deltaR"] for p in pairs])

    vb, bb = summary["variant"]["medianBars"], summary["baseline"]["medianBars"]
    if isinstance(vb, (int, float)) and isinstance(bb, (int, float)) and vb:
        summary["speedup"] = round(bb / vb, 2)

    if len(pairs) < min_resolved:
        summary["verdict"] = "TOO FEW TO JUDGE"
    elif summary["meanDeltaR"] is None:
        summary["verdict"] = "TOO FEW TO JUDGE"
    elif summary["meanDeltaR"] > 0 and (summary["speedup"] or 0) > 1:
        summary["verdict"] = "TIGHTER STOP LOOKS BETTER AND FASTER"
    elif summary["meanDeltaR"] <= 0 and (summary["speedup"] or 0) > 1:
        summary["verdict"] = "FASTER BUT WORSE — the speed costs R"
    else:
        summary["verdict"] = "NO ADVANTAGE"
    return summary


def render(scored, summary, malformed):
    line = "=" * 78
    log(line)
    log("  STOP-VARIANT LEDGER — would a lower-timeframe stop have done better?")
    log(line)
    log("")
    log("  episodes        : %d   (rows deduped by key; the writer re-appends each tick)"
        % summary["episodes"])
    log("  pairs resolved  : %d   (BOTH arms reached an answer over the same bars)"
        % summary["pairsResolved"])
    if malformed:
        log("  malformed lines : %d  (counted and KEPT, never dropped)" % malformed)
    log("")

    if summary["pairsResolved"] == 0:
        log("  Nothing has resolved yet. That is the expected state of a young ledger,")
        log("  not a fault: the window is the BASELINE timeframe's horizon, so a D1 row")
        log("  needs 20 trading days before either arm can be called.")
        log("")
        for row in scored:
            if row.get("skipped"):
                continue
            log("    %-46s  variant %-16s  baseline %s"
                % (row.get("key", "?")[:46], row["variant"]["outcome"],
                   row["baseline"]["outcome"]))
        log("")
        log("-" * 78)
        log("  VERDICT: %s" % summary["verdict"])
        log(line)
        return

    log("  %-10s %10s %14s %10s" % ("arm", "mean R", "median bars", "targets"))
    log("  " + "-" * 48)
    log("  %-10s %10s %14s %10s" % ("variant", summary["variant"]["meanR"],
                                    summary["variant"]["medianBars"],
                                    summary["variant"]["wins"]))
    log("  %-10s %10s %14s %10s" % ("baseline", summary["baseline"]["meanR"],
                                    summary["baseline"]["medianBars"],
                                    summary["baseline"]["wins"]))
    log("")
    log("  mean paired delta : %s R  (variant minus baseline, same signal, same bars)"
        % summary["meanDeltaR"])
    if summary["speedup"]:
        log("  resolution speed  : %sx faster" % summary["speedup"])
    log("")
    log("-" * 78)
    log("  VERDICT: %s" % summary["verdict"])
    if summary["pairsResolved"] < summary["minResolvedForVerdict"]:
        log("           under the %d-pair floor — reported, not believed."
            % summary["minResolvedForVerdict"])
    log("  These are forgone PAPER geometries on entries that were never filled at the")
    log("  variant stop: no spread, no slippage, fixed horizon. A screening signal for")
    log("  whether the question is worth a walk-forward — never a reason to move a stop.")
    log(line)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bars-from-csv", default=DEFAULT_HISTORY,
                        help="directory of <SYMBOL>_<TF>.csv history (default tasks/history)")
    parser.add_argument("--use-mt5", action="store_true",
                        help="read bars from a live MT5 terminal instead of CSV")
    parser.add_argument("--min-resolved", type=int, default=DEFAULT_MIN_RESOLVED)
    parser.add_argument("--output", default=DEFAULT_OUTPUT)
    parser.add_argument("--json", action="store_true", help="print the summary as JSON")
    # A tool whose only observed output is "nothing resolved yet" is a tool nobody has
    # tested. This exists so the scoring path can be exercised against backdated
    # fixtures whose horizon has actually closed.
    parser.add_argument("--ledger", default=LEDGER_PATH,
                        help="ledger to score (default tasks/stop_variants.jsonl)")
    args = parser.parse_args()

    rows, malformed, exists = load_ledger(args.ledger)
    if not exists:
        log("%s does not exist yet — nothing to score." % args.ledger)
        return 0
    if not rows:
        log("%s is empty — nothing to score." % args.ledger)
        return 0

    episodes = dedupe_episodes(rows)

    source = (scorer.Mt5BarSource() if args.use_mt5
              else scorer.CsvBarSource(args.bars_from_csv))
    if not source.open():
        log("could not open the bar source (%s) — cannot score." % source.name)
        return 0

    try:
        now_epoch = int(datetime.now(timezone.utc).timestamp())
        scored = score_ledger(episodes, source, now_epoch)
    finally:
        source.close()

    summary = summarise(scored, args.min_resolved)

    # Append-only, like every other ledger here. Never rewrites, never truncates.
    with open(args.output, "w", encoding="utf-8") as handle:
        for row in scored:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")

    if args.json:
        print(json.dumps({"summary": summary, "malformed": malformed}, indent=2))
    else:
        render(scored, summary, malformed)
        log("")
        log("  written: %s" % os.path.relpath(args.output, ROOT))
    return 0


if __name__ == "__main__":
    sys.exit(main())
