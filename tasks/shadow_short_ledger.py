#!/usr/bin/env python
"""
SHADOW SHORT LEDGER -- make the system stop being blind to the moves it has no setup for.

    python tasks/shadow_short_ledger.py            # log new candidates, score resolved ones
    python tasks/shadow_short_ledger.py --dry-run  # print what it would do, write nothing

WHY THIS EXISTS. On 2026-08-28 Gold fell 4631 -> 4530 inside one H1 bar. The engine
produced no short, no rejection row and no near-miss, and /api/signals still returned BUY
MOMENTUM confidence 74, unchanged. That is not a broken learning engine: EVERY learning
surface this system has is keyed off a setup that FORMED, and none did. A move that
leaves no row cannot be learned from, argued about, or priced -- it is simply invisible,
and the next session hears "it should have caught that" with nothing to check it against.

This is the rejection-ledger pattern (tasks/score_rr_rejections.py) applied one level
earlier: not "a setup formed and a gate killed it", but "no setup existed and here is
what one would have been worth". Every downside break becomes a fully priced paper trade
at zero risk, scored forward on real broker bars.

WHAT IT WILL NOT DO. It never touches the gate, the engine, a threshold, or a live order.
feedsTheGate is false in every row and stays false. It never deletes: the ledger is
append-only and the scored file is derived and rewritten. It never scores a bar that has
not closed -- the crush bar above was still forming when it was first looked at, and a
half-formed bar is a wrong row, not a late one.

WHAT IT IS NOT EVIDENCE OF. The break-down family was walk-forwarded over 5.1 years of
H1 on 2026-08-28 and does NOT survive out of sample: nested walk-forward gave GOLD 2/4
folds and mean +0.005R, BTC 2/4 / +0.185R, SPX 1/4 / -0.063R, with in-sample means of
+0.26R to +0.93R collapsing to zero. So this ledger is NOT a proposal to trade the setup.
It is the instrument that will say, from LIVE bars months from now, whether that verdict
still holds -- the same way the rejection ledger prices gates nobody would otherwise
question. Where it ever contradicts a walk-forward, the walk-forward wins.

Reads GET /api/mt5/candles/raw (the bars the bridge already pushed; no second MT5 client,
so it is safe with positions open). Writes tasks/shadow_shorts.jsonl (append-only) and
tasks/shadow_shorts_scored.jsonl (derived).
"""

import os
import sys
import json
import math
import datetime
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LEDGER_PATH = os.path.join(ROOT, "tasks", "shadow_shorts.jsonl")
SCORED_PATH = os.path.join(ROOT, "tasks", "shadow_shorts_scored.jsonl")
SERVER = os.environ.get("SMARTENTRY_SERVER", "http://localhost:3001")

# The candidate definition. These are REFERENCE parameters, not tuned ones -- the row
# stores the raw features (break level, ATR, expansion) so a later scorer can re-price
# the same episode under different parameters without needing the bars again.
LOOKBACK_BARS = 10        # Donchian window: close below the lowest low of the prior N
STOP_ATR_MULT = 1.0       # stop distance above entry, in ATR14
TARGET_R = 2.0            # target at N x risk below entry
MAX_HOLD_BARS = 48        # give up after this many H1 bars and mark it out at market
COST_R = 0.05             # round-trip cost charged to every episode, in R
ATR_PERIOD = 14

DRY_RUN = "--dry-run" in sys.argv


def log(message):
    print(message)


def fetch_bars():
    """The bars the engine itself used. Fails loudly rather than guessing."""
    url = SERVER + "/api/mt5/candles/raw"
    try:
        with urllib.request.urlopen(url, timeout=25) as response:
            if response.status != 200:
                raise RuntimeError("HTTP %s" % response.status)
            payload = json.load(response)
    except Exception as err:
        raise SystemExit("cannot read %s -- is the server up? (%s)" % (url, err))
    assets = payload.get("assets")
    if not isinstance(assets, dict) or not assets:
        raise SystemExit("%s returned no assets" % url)
    return assets


def series_from(asset_payload):
    """(times, opens, highs, lows, closes) for H1, or None if the series is unusable."""
    bars = (asset_payload or {}).get("bars", {}).get("h1")
    if not isinstance(bars, dict):
        return None
    times = bars.get("times")
    opens, highs = bars.get("opens"), bars.get("highs")
    lows, closes = bars.get("lows"), bars.get("closes")
    parts = [times, opens, highs, lows, closes]
    if any(not isinstance(p, list) or not p for p in parts):
        return None
    # A series missing a column is refused by name rather than completed with a guess --
    # tasks/persist_bars.cjs refuses on the same principle and for the same reason.
    if len(set(len(p) for p in parts)) != 1:
        return None
    return times, opens, highs, lows, closes


def wilder_atr_at(highs, lows, closes, index, period=ATR_PERIOD):
    """ATR14 as of bar `index` inclusive. None when it is not yet defined."""
    if index < period:
        return None
    true_ranges = []
    for i in range(1, index + 1):
        prev_close = closes[i - 1]
        true_ranges.append(max(highs[i] - lows[i],
                               abs(highs[i] - prev_close),
                               abs(lows[i] - prev_close)))
    if len(true_ranges) < period:
        return None
    value = sum(true_ranges[:period]) / period
    for i in range(period, len(true_ranges)):
        value = (value * (period - 1) + true_ranges[i]) / period
    return value


def read_jsonl(path):
    """Existing rows. A corrupt line is skipped and counted, never allowed to wipe the file."""
    rows, bad = [], 0
    if not os.path.exists(path):
        return rows, bad
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except ValueError:
                bad += 1
    return rows, bad


def find_candidates(asset, times, opens, highs, lows, closes, already_logged):
    """Every downside break on a CLOSED bar that is not already in the ledger."""
    found = []
    # The final bar is still forming. copy_rates_from_pos includes it, and a partial bar
    # gives a wrong answer that looks right -- so it is excluded by index, every run.
    last_closed = len(closes) - 2
    first = max(LOOKBACK_BARS, ATR_PERIOD + 1)
    for i in range(first, last_closed + 1):
        if (asset, times[i]) in already_logged:
            continue
        atr = wilder_atr_at(highs, lows, closes, i - 1)
        if atr is None or atr <= 0:
            continue
        break_level = min(lows[i - LOOKBACK_BARS:i])
        if closes[i] >= break_level:
            continue
        entry = closes[i]
        stop = entry + STOP_ATR_MULT * atr
        target = entry - TARGET_R * (stop - entry)
        prior_range = highs[i - 1] - lows[i - 1]
        found.append({
            "ts": datetime.datetime.fromtimestamp(times[i], datetime.timezone.utc)
                          .strftime("%Y-%m-%dT%H:%M:%SZ"),
            "barTime": times[i],
            "asset": asset,
            "timeframe": "H1",
            "setup": "SHADOW_BREAK_SHORT",
            "direction": "SELL",
            "entry": round(entry, 4),
            "stop": round(stop, 4),
            "target": round(target, 4),
            "riskPoints": round(stop - entry, 4),
            "atr14": round(atr, 4),
            "breakLevel": round(break_level, 4),
            "lookbackBars": LOOKBACK_BARS,
            "priorBarRangeAtr": round(prior_range / atr, 3),
            "brokeBelowBy": round(break_level - entry, 4),
            # Never true. This ledger observes; it does not admit or suppress anything.
            "feedsTheGate": False,
        })
    return found


def score(row, times, highs, lows, closes):
    """Walk the episode forward on real bars. Stop before target when both land in one."""
    try:
        start = times.index(row["barTime"]) + 1
    except ValueError:
        return None  # its bars have aged out of the cache; leave it unresolved
    entry, stop, target = row["entry"], row["stop"], row["target"]
    risk = row["riskPoints"]
    if risk <= 0:
        return None
    last_closed = len(closes) - 2
    horizon = min(start + MAX_HOLD_BARS, last_closed + 1)
    for i in range(start, horizon):
        if highs[i] >= stop:
            return {"outcome": "STOPPED", "r": round(-1.0 - COST_R, 3), "bars": i - start + 1}
        if lows[i] <= target:
            return {"outcome": "TARGET", "r": round(TARGET_R - COST_R, 3), "bars": i - start + 1}
    if horizon - start < MAX_HOLD_BARS:
        return None  # not enough closed bars yet -- genuinely still open
    movement = entry - closes[horizon - 1]
    return {"outcome": "TIMEOUT", "r": round(movement / risk - COST_R, 3),
            "bars": horizon - start}


def write_scored(scored):
    """Replace the derived file WITHOUT a moment in which it does not exist.

    `open(path, "w")` truncates before the first byte is written, so a crash, a lock or
    a killed process leaves an empty file where a complete one was -- the exact shape of
    [[swallowed_parse_error_wipes_the_file]]. Instead: write a sibling temp file in full,
    keep a timestamped copy of the outgoing version and VERIFY that copy exists before
    anything is replaced, then swap. Nothing is ever deleted; superseded versions stay on
    disk under .bak-* for a human to remove deliberately.
    """
    payload = "".join(json.dumps(row) + "\n" for row in scored)

    # Most nights nothing has resolved and the output is byte-identical. Backing that up
    # would leave a year of duplicate .bak files nobody may delete under the standing
    # rules, so an unchanged file is left alone entirely rather than rewritten.
    if os.path.exists(SCORED_PATH):
        with open(SCORED_PATH, "r", encoding="utf-8") as handle:
            if handle.read() == payload:
                log("  scored file unchanged -- left as is")
                return

    temp_path = SCORED_PATH + ".tmp"
    with open(temp_path, "w", encoding="utf-8") as handle:
        handle.write(payload)
    if os.path.getsize(temp_path) == 0 and scored:
        raise SystemExit("refusing to install an empty %s" % os.path.basename(SCORED_PATH))

    if os.path.exists(SCORED_PATH):
        stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        backup_path = "%s.bak-%s" % (SCORED_PATH, stamp)
        with open(SCORED_PATH, "rb") as src, open(backup_path, "wb") as dst:
            dst.write(src.read())
        # Verified, not assumed: a backup nobody checked is not a backup.
        if not os.path.exists(backup_path) or os.path.getsize(backup_path) == 0:
            raise SystemExit("backup %s missing or empty -- not replacing the original"
                             % os.path.basename(backup_path))
        log("  backed up previous scored file -> %s" % os.path.basename(backup_path))

    os.replace(temp_path, SCORED_PATH)


def main():
    assets = fetch_bars()
    existing, corrupt = read_jsonl(LEDGER_PATH)
    if corrupt:
        log("WARNING: %d unparseable line(s) in %s -- skipped, not removed"
            % (corrupt, os.path.basename(LEDGER_PATH)))
    already = set((r.get("asset"), r.get("barTime")) for r in existing)
    log("ledger: %d existing row(s)" % len(existing))

    new_rows = []
    series_by_asset = {}
    for asset in sorted(assets):
        series = series_from(assets[asset])
        if series is None:
            log("  %-5s series unusable (missing or ragged columns) -- refused, not guessed"
                % asset.upper())
            continue
        series_by_asset[asset] = series
        times, opens, highs, lows, closes = series
        found = find_candidates(asset, times, opens, highs, lows, closes, already)
        new_rows.extend(found)
        log("  %-5s %d H1 bars, last closed %s -- %d new candidate(s)"
            % (asset.upper(), len(closes),
               datetime.datetime.fromtimestamp(times[-2], datetime.timezone.utc)
                       .strftime("%m-%d %H:%M"), len(found)))

    if new_rows and not DRY_RUN:
        with open(LEDGER_PATH, "a", encoding="utf-8") as handle:
            for row in new_rows:
                handle.write(json.dumps(row) + "\n")
    log("%s %d new row(s)" % ("would append" if DRY_RUN else "appended", len(new_rows)))

    all_rows = existing + new_rows
    scored, unresolved = [], 0
    for row in all_rows:
        series = series_by_asset.get(row.get("asset"))
        if series is None:
            unresolved += 1
            continue
        times, opens, highs, lows, closes = series
        result = score(row, times, highs, lows, closes)
        if result is None:
            unresolved += 1
            continue
        merged = dict(row)
        merged.update(result)
        scored.append(merged)

    if scored and not DRY_RUN:
        write_scored(scored)

    log("")
    log("=" * 74)
    log("SHADOW SHORT LEDGER -- %d resolved, %d still open" % (len(scored), unresolved))
    log("=" * 74)
    if not scored:
        log("  nothing resolved yet. This accumulates; it is not meant to answer today.")
        return
    by_asset = {}
    for row in scored:
        by_asset.setdefault(row["asset"], []).append(row["r"])
    for asset in sorted(by_asset):
        values = by_asset[asset]
        mean = sum(values) / len(values)
        wins = sum(1 for v in values if v > 0)
        # The floor mirrors the rejection ledger's: below it, a mean is an anecdote.
        verdict = ("TOO FEW TO JUDGE" if len(values) < 5
                   else "WOULD HAVE PAID" if mean > 0 else "WOULD HAVE COST")
        log("  %-5s n=%-4d  mean %+.3fR  total %+.1fR  win%% %.0f  -> %s"
            % (asset.upper(), len(values), mean, sum(values),
               wins / len(values) * 100, verdict))
    log("")
    log("  These are FORGONE PAPER trades: no spread beyond the flat %.2fR, no slippage,"
        % COST_R)
    log("  entries never filled. A screening signal, not realised P&L. Where this ever")
    log("  contradicts a walk-forward, the walk-forward wins.")


if __name__ == "__main__":
    main()
