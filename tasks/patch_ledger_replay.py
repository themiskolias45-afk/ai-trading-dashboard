"""Apply the runBacktest replay-flag fix to a box, IDEMPOTENTLY.

Same rule as the other patchers here: the VPS's server/index.js is PATCHED, never copied,
because it carries commits this repo has never seen. Applies by exact string match,
REFUSES unless each anchor matches exactly once, backs up first and verifies the backup
exists before rewriting, and no-ops if already applied.

  python tasks/patch_ledger_replay.py [--check]
"""

import io
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHECK = "--check" in sys.argv
MARKER = "ledgerEnabled"

# The replacement text is EXTRACTED VERBATIM from the reference box into
# tasks/_ledger_replay_blocks.json rather than retyped. The first version of this
# patcher wrote a SHORTER comment than the laptop carried, and vps_parity.cjs compares
# function TEXT: it immediately reported "ENGINES DIVERGE - generateSignal" on two
# boxes whose behaviour was identical. A patcher that retypes its payload is a patcher
# that forks the fleet.
import json
_BLOCKS = json.load(io.open(os.path.join(ROOT, "tasks", "_ledger_replay_blocks.json"),
                            encoding="utf-8"))
FLAG = _BLOCKS["flag"]
CALL = _BLOCKS["call"]

HUNKS = [
    ("  if (!closes || closes.length < 50) return null;", FLAG),
    ('      if (typeof logGateRejection === "function") logGateRejection({\n        gate:      "MIN_RR",',
     '      if (ledgerEnabled && typeof logGateRejection === "function") logGateRejection({\n        gate:      "MIN_RR",'),
    ('      noteGatePass("MIN_RR");', '      if (ledgerEnabled) noteGatePass("MIN_RR");'),
    ('    if (typeof logGateRejection === "function") logGateRejection({\n      gate:      "ENTRY_RSI",',
     '    if (ledgerEnabled && typeof logGateRejection === "function") logGateRejection({\n      gate:      "ENTRY_RSI",'),
    ('    noteGatePass("ENTRY_RSI");', '    if (ledgerEnabled) noteGatePass("ENTRY_RSI");'),
    ("""    const sig = generateSignal(label, symbol,
      w.map(b => b.close), w.map(b => b.high), w.map(b => b.low), w.map(b => b.volume ?? 0));""",
     CALL),
]

path = os.path.join(ROOT, "server", "index.js")
if not os.path.exists(path):
    print("MISSING  server/index.js")
    sys.exit(1)

src = io.open(path, encoding="utf-8").read()
if MARKER in src:
    print("ALREADY  server/index.js -- replay flag present, nothing to do")
    sys.exit(0)

for old, new in HUNKS:
    found = src.count(old)
    if found != 1:
        print("REFUSED  anchor matched %d times, expected 1:\n         %s"
              % (found, old.strip().splitlines()[0][:88]))
        sys.exit(1)
    src = src.replace(old, new, 1)

if CHECK:
    print("WOULD PATCH  server/index.js")
    sys.exit(0)

backup = path + ".bak-ledgerreplay"
if not os.path.exists(backup):
    io.open(backup, "w", encoding="utf-8", newline="").write(
        io.open(path, encoding="utf-8").read())
    if not os.path.exists(backup):
        print("REFUSED  backup could not be written")
        sys.exit(1)
io.open(path, "w", encoding="utf-8", newline="").write(src)
print("PATCHED  server/index.js  (backup: index.js.bak-ledgerreplay)")
