"""Add the check_decision MCP tool to a box, IDEMPOTENTLY.

Anchor-based, never scp: server/mcp_server.js is a tracked engine-adjacent file and the
VPS carries commits this repo has never seen. Verified before writing this that the VPS
copy is byte-identical to the laptop's pre-change version once line endings are
normalised, so the anchor is sound.

The payload is EXTRACTED VERBATIM into tasks/_mcp_check_decision_block.json rather than
retyped. Learned the hard way the same day: a patcher that retypes its payload wrote a
shorter comment than the laptop carried and vps_parity immediately reported ENGINES
DIVERGE on two boxes whose behaviour was identical.

  python tasks/patch_mcp_check_decision.py [--check]
"""
import io, json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHECK = "--check" in sys.argv
MARKER = "check_decision"

blocks = json.load(io.open(os.path.join(ROOT, "tasks", "_mcp_check_decision_block.json"),
                           encoding="utf-8"))
path = os.path.join(ROOT, "server", "mcp_server.js")
if not os.path.exists(path):
    print("MISSING  server/mcp_server.js"); sys.exit(1)

src = io.open(path, encoding="utf-8").read()
if MARKER in src:
    print("ALREADY  server/mcp_server.js -- check_decision present"); sys.exit(0)

anchor = blocks["anchor"]
if src.count(anchor) != 1:
    print("REFUSED  anchor matched %d times, expected 1" % src.count(anchor)); sys.exit(1)

if CHECK:
    print("WOULD PATCH  server/mcp_server.js"); sys.exit(0)

backup = path + ".bak-checkdecision"
if not os.path.exists(backup):
    io.open(backup, "w", encoding="utf-8", newline="").write(
        io.open(path, encoding="utf-8").read())
    if not os.path.exists(backup):
        print("REFUSED  backup could not be written"); sys.exit(1)

io.open(path, "w", encoding="utf-8", newline="").write(
    src.replace(anchor, blocks["block"] + anchor, 1))
print("PATCHED  server/mcp_server.js  (backup: mcp_server.js.bak-checkdecision)")
