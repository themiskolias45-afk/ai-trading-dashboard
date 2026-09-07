"""Apply the TREND_FOLLOW_REQUIRE_MACD_BULLISH flag to a box, IDEMPOTENTLY.

WHY A PATCH SCRIPT AND NOT scp. The VPS's server/index.js carries commits this repo has
never seen -- CLAUDE.md is explicit that it is PATCHED, not copied, and that hand-patching
it once took seven edits and left nine .bak files. Copying the laptop's file over would
silently revert whatever only exists there. This applies the same two hunks by exact
string match and refuses if either is not found exactly once.

It also patches tasks/_replay_mtf.cjs, which is NOT optional on any box that runs a
replay: the const is read inside the TREND_FOLLOW branch, so a harness that does not
extract it throws on every bar reaching that branch, and the run reads as "TREND_FOLLOW
never fired" -- the very claim under test.

Behaviour at the default (true) is byte-identical to the branch as it has always run.

  python tasks/patch_tf_macd_flag.py [--check]

--check reports what it would do and writes nothing. Re-running after a successful patch
is a no-op, so it is safe on a box that already has it.
"""

import io
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHECK = "--check" in sys.argv

FLAG = "TREND_FOLLOW_REQUIRE_MACD_BULLISH"

COMMENT = """
// Does TREND_FOLLOW still require macd.bullish? UNTIL 2026-09-02 THIS WAS NOT EVEN A
// QUESTION ANYONE COULD ASK -- the condition was inline with no name, so no harness could
// flip it and no measurement could reach it.
//
// It is the LARGEST SINGLE BLOCKER IN THE CENSUS: 24 of the 92 rows in
// tasks/near_misses.jsonl are TREND_FOLLOW dying on MACD_NOT_BULLISH and nothing else,
// ahead of RANGE_TRADE_SHORT's RSI floor (23) and both RSI ceilings (14 each). BUY_DIP
// and MOMENTUM each got a flag and a measurement on 2026-09-01; this one got neither,
// and it is the condition actually holding Gold and SP500 at confidence 0 -- SP500's
// daily MACD sat under its signal line for TEN consecutive bars from 2026-08-20.
//
// TRUE REPRODUCES THE LIVE ENGINE EXACTLY. The flag exists so the two worlds can be
// replayed and compared instead of argued about. tasks/_replay_mtf.cjs flips it via
// MTF_TREND_FOLLOW_REQUIRE_MACD, measurement-only; the server is never edited to run a
// measurement.
//
// DO NOT flip this on a bar-return screen. That instrument gave the WRONG ANSWER TWICE on
// 2026-09-01 -- it cleared BUY_DIP and MOMENTUM, both were flipped false, and the
// per-asset walk-forward on realised R reverted both within the hour, because a forward
// return on a BAR has no stop, no target and no position sequencing.
""".rstrip("\n")

ENGINE_HUNKS = [
    ("    macd?.bullish &&\n    ema200 && price > ema200 * 1.005",
     "    (!" + FLAG + " || macd?.bullish) &&\n    ema200 && price > ema200 * 1.005"),
    ("const MOMENTUM_REQUIRE_MACD_BULLISH = true;",
     "const MOMENTUM_REQUIRE_MACD_BULLISH = true;\n" + COMMENT + "\nconst " + FLAG + " = true;"),
]

HARNESS_HUNKS = [
    ('  "SELL_BOUNCE_REQUIRE_DOWNTREND",\n];',
     '  "SELL_BOUNCE_REQUIRE_DOWNTREND",\n'
     '  // Added 2026-09-02. The const is read inside the TREND_FOLLOW branch, so omitting\n'
     '  // it throws on every bar that reaches that branch and the run reads as\n'
     '  // "TREND_FOLLOW never fired" -- the very claim being tested.\n'
     '  "' + FLAG + '",\n];'),
    ('if (process.env.MTF_SELL_BOUNCE_REQUIRE_DOWNTREND === "false") {\n'
     '  CONST_OVERRIDES.SELL_BOUNCE_REQUIRE_DOWNTREND = "false";\n}',
     'if (process.env.MTF_SELL_BOUNCE_REQUIRE_DOWNTREND === "false") {\n'
     '  CONST_OVERRIDES.SELL_BOUNCE_REQUIRE_DOWNTREND = "false";\n}\n'
     'if (process.env.MTF_TREND_FOLLOW_REQUIRE_MACD === "false") {\n'
     '  CONST_OVERRIDES.' + FLAG + ' = "false";\n}'),
]


def apply(rel_path, hunks):
    path = os.path.join(ROOT, rel_path)
    if not os.path.exists(path):
        print("MISSING  " + rel_path)
        return 1
    src = io.open(path, encoding="utf-8").read()
    if FLAG in src:
        print("ALREADY  " + rel_path + " -- flag present, nothing to do")
        return 0
    for old, new in hunks:
        found = src.count(old)
        if found != 1:
            # Refuse rather than guess. A patch that half-applies to an engine file is
            # worse than one that does not apply at all.
            print("REFUSED  " + rel_path + " -- anchor matched %d times, expected 1:\n         %s"
                  % (found, old.splitlines()[0][:90]))
            return 1
        src = src.replace(old, new, 1)
    if CHECK:
        print("WOULD PATCH  " + rel_path)
        return 0
    backup = path + ".bak-tfmacd"
    if not os.path.exists(backup):
        # Copy before rewrite, per the standing rule. Verified to exist before the
        # rewrite happens, not after.
        io.open(backup, "w", encoding="utf-8", newline="").write(
            io.open(path, encoding="utf-8").read())
        if not os.path.exists(backup):
            print("REFUSED  " + rel_path + " -- backup could not be written")
            return 1
    io.open(path, "w", encoding="utf-8", newline="").write(src)
    print("PATCHED  " + rel_path + "  (backup: " + os.path.basename(backup) + ")")
    return 0


rc = 0
rc |= apply(os.path.join("server", "index.js"), ENGINE_HUNKS)
rc |= apply(os.path.join("tasks", "_replay_mtf.cjs"), HARNESS_HUNKS)
sys.exit(rc)
