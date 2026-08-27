"""Turn scored rejections into per-setup learning evidence.

    python tasks/learning_from_rejections.py [--scored PATH] [--out PATH] [--dry-run]

WHY THIS EXISTS

The learning engine is starved, not broken. `updateLearning()` is called from exactly
one place -- /api/trade-closed -- so the only thing that can ever teach it is a real
closed fill. There is one of those in the system's entire history, and
`getLearningBoost()` refuses to act below five per setup. At roughly a trade a week
that threshold is months away, and every conclusion the system might draw is stalled
behind it.

Meanwhile the rejection ledger holds fully-priced paper trades that
tasks/score_rr_rejections.py already walks forward against real broker bars. As of
2026-08-07 that is 8 resolved episodes, and RANGE_TRADE_LONG alone has 5 -- already at
the threshold the live engine cannot reach. That evidence was sitting on disk feeding
nothing.

WHAT IT DOES NOT DO, DELIBERATELY

- It NEVER writes server/learning.json. Not one byte. The server holds that file in
  memory and rewrites the whole object on every saveLearning(), so anything added
  from outside would be silently clobbered on the next closed trade -- and it is
  protected data besides. Shadow evidence lives in its own file and the two are never
  merged on disk.
- It does NOT feed getLearningBoost(), so it changes no confidence, no gate and no
  signal. Wiring paper outcomes into live sizing is a trading-behaviour change and
  needs its own walk-forward before anyone believes it.
- It deletes nothing and rewrites nothing but its own output.

HONESTY RULES

- QUALITY gates only. Those are the ones claiming "this setup is not good enough", so
  walking their rejections forward tests a claim about the SETUP. CONTEXT gates
  (STALE_SOURCE, SPREAD, NEWS_BLACKOUT) rejected on state, not merit -- their outcomes
  say nothing about the setup and are excluded. NOT_FORGONE (DUPLICATE) is excluded
  because the position was already open and its real outcome is in the journal;
  counting it here would double-count a trade the system actually made.
- Episodes, not rows. Gates re-fire on every refresh, so one Gold short drifting over
  four hours writes seven near-identical rows. That is one piece of evidence.
- PENDING / AMBIGUOUS / INCOMPLETE_DATA are carried as counts and never as outcomes.
- These are PAPER results. The entry was never actually filled, so there is no
  slippage and no spread in them. They are evidence about geometry, not execution,
  and the output says so on every record.
"""

import argparse
import json
import os
from collections import defaultdict
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

DEFAULT_SCORED = os.path.join(ROOT, "tasks", "rejections_scored.jsonl")
DEFAULT_OUT    = os.path.join(ROOT, "server", "learning_shadow.json")

# Only these judge the setup itself. See the scorer's own GATE_CLASS table.
COUNTABLE_CLASS = "QUALITY"
RESOLVED = ("TARGET", "STOP")

# Same floor the live engine uses in getLearningBoost(), repeated here so a reader of
# this file can see what "enough" means without cross-referencing server/index.js.
MIN_EPISODES_FOR_READING = 5


def load_scored(path):
    """Every scored row. [] when the file is absent — that is 'not scored yet', not an error."""
    if not os.path.exists(path):
        print(f"[shadow] {path} not found — run tasks/score_rr_rejections.py first.")
        return []
    rows = []
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue          # one bad line must not discard the rest
            if isinstance(row, dict):
                rows.append(row)
    return rows


def build_shadow(rows):
    """Per-setup evidence from resolved QUALITY episodes."""
    # One row per episode. Gates re-fire every refresh; seven rows of one drifting
    # setup are one piece of evidence, not seven.
    episodes = {}
    unresolved = defaultdict(lambda: defaultdict(int))
    # PENDING MUST BE COUNTED IN EPISODES, LIKE EVERY OTHER FIELD BESIDE IT.
    #
    # `unresolved` above increments once per ROW, and it does so BEFORE the episode
    # dedup a few lines below - so `pending` was in rows while wins, losses, totalR
    # and episodes in the same record were all in episodes. Two units in one dict,
    # with nothing saying so.
    #
    # The live symptom on 2026-08-27: RANGE_TRADE_LONG read 44 episodes against 699
    # pending, which makes the shadow ledger look as though it has barely scored
    # anything, when the real ratio is 44 against roughly 43. A reader comparing those
    # two numbers - which is the obvious thing to do, they sit side by side - draws the
    # opposite conclusion about how much evidence exists.
    #
    # The row counts are KEPT as pendingRows so nothing is lost and the old figure
    # stays auditable; `pending` becomes the episode count so it is comparable with
    # the field next to it.
    unresolved_episodes = defaultdict(lambda: defaultdict(set))
    excluded = defaultdict(int)

    for row in rows:
        if row.get("gateClass") != COUNTABLE_CLASS:
            excluded[row.get("gateClass") or "UNKNOWN"] += 1
            continue

        setup = row.get("setup")
        if not setup:
            excluded["NO_SETUP_NAME"] += 1
            continue

        outcome = row.get("outcome")
        if outcome not in RESOLVED:
            unresolved[setup][outcome or "UNKNOWN"] += 1
            # Same key the resolved path uses below, so the two are counted in the
            # same unit. A row with no episode id falls back to the same synthetic
            # tuple, which keeps genuinely distinct rows distinct.
            ep_key = row.get("episode")
            if ep_key is None:
                ep_key = ("row", row.get("ts"), setup, row.get("entry"))
            unresolved_episodes[setup][outcome or "UNKNOWN"].add(ep_key)
            continue

        key = row.get("episode")
        if key is None:
            key = ("row", row.get("ts"), setup, row.get("entry"))
        episodes.setdefault(key, row)

    stats = {}
    for row in episodes.values():
        setup = row["setup"]
        entry = stats.setdefault(setup, {
            "wins": 0, "losses": 0, "totalR": 0.0, "episodes": 0,
            "gates": set(), "symbols": set(),
        })
        if row["outcome"] == "TARGET":
            entry["wins"] += 1
        else:
            entry["losses"] += 1
        try:
            entry["totalR"] += float(row.get("r") or 0.0)
        except (TypeError, ValueError):
            pass
        entry["episodes"] += 1
        if row.get("gate"):   entry["gates"].add(row["gate"])
        if row.get("symbol"): entry["symbols"].add(row["symbol"])

    shadow = {}
    for setup, entry in sorted(stats.items()):
        total = entry["wins"] + entry["losses"]
        shadow[setup] = {
            "wins":     entry["wins"],
            "losses":   entry["losses"],
            "episodes": entry["episodes"],
            "totalR":   round(entry["totalR"], 3),
            "rPerEpisode": round(entry["totalR"] / total, 3) if total else 0.0,
            "winRate":  round(entry["wins"] / total * 100, 1) if total else 0.0,
            "gates":    sorted(entry["gates"]),
            "symbols":  sorted(entry["symbols"]),
            # Stated per record so nothing downstream can read these as fills.
            "enoughForReading": total >= MIN_EPISODES_FOR_READING,
            # EPISODES, matching wins / losses / episodes in this same record.
            "pending": {k: len(v) for k, v in unresolved_episodes.get(setup, {}).items()},
            # The raw row tally, kept so the previous figure stays auditable and
            # nothing is lost. Never compare this with `episodes` - different units.
            "pendingRows": dict(unresolved.get(setup, {})),
        }

    return shadow, dict(excluded), {k: dict(v) for k, v in unresolved.items()}


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--scored", default=DEFAULT_SCORED)
    parser.add_argument("--out",    default=DEFAULT_OUT)
    parser.add_argument("--dry-run", action="store_true",
                        help="print what would be written and write nothing")
    args = parser.parse_args()

    rows = load_scored(args.scored)
    if not rows:
        return 1

    shadow, excluded, unresolved = build_shadow(rows)

    payload = {
        "shadowStats": shadow,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "source": os.path.relpath(args.scored, ROOT).replace("\\", "/"),
        "basis": {
            "countedGateClass": COUNTABLE_CLASS,
            "excludedRowsByClass": excluded,
            "minEpisodesForReading": MIN_EPISODES_FOR_READING,
            "whatTheseAre":
                "Forgone PAPER trades: levels a gate rejected, walked forward on real "
                "broker bars. No slippage and no spread — the entry was never filled. "
                "Evidence about geometry, not execution.",
            "whatTheseAreNot":
                "NOT live fills and NOT merged into server/learning.json, which this "
                "tool never writes. They do not feed getLearningBoost(), so no "
                "confidence, gate or signal changes from this file.",
        },
    }

    print(f"{'setup':<24} {'W':>3} {'L':>3} {'eps':>4} {'totalR':>8} {'R/ep':>7} {'wr%':>6}  reading")
    print("-" * 88)
    if not shadow:
        print("  (no resolved QUALITY episodes yet — that is the expected reading early on)")
    for setup, s in shadow.items():
        reading = "USABLE" if s["enoughForReading"] else f"insufficient ({s['wins']+s['losses']}/{MIN_EPISODES_FOR_READING})"
        print(f"  {setup:<22} {s['wins']:>3} {s['losses']:>3} {s['episodes']:>4} "
              f"{s['totalR']:>+8.2f} {s['rPerEpisode']:>+7.2f} {s['winRate']:>5.1f}%  {reading}")
    print("-" * 88)
    print(f"excluded rows by gate class: {excluded or '{}'}")

    if args.dry_run:
        print("\n[dry-run] nothing written.")
        return 0

    # Its own file. server/learning.json is never opened, let alone written.
    tmp = args.out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
    os.replace(tmp, args.out)
    print(f"\nwrote {os.path.relpath(args.out, ROOT)} "
          f"({len(shadow)} setup(s)) — server/learning.json untouched.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
