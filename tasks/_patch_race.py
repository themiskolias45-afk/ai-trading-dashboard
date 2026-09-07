"""Serialises refreshSignals() so two concurrent passes cannot fight over the cache.

refreshSignals() is called from six places - boot, the 6:45 cron, the 30-minute
cron, the candle-ingest flip, POST /api/plan/refresh, and the Telegram commands -
but only the candle-ingest path ever checked signalRefreshInFlight, and that flag was
only ever guarding that path against ITSELF.

Measured on the VPS 2026-08-06 07:33:56. The server booted with an empty MT5 candle
cache, so its startup refresh took the slow Yahoo network path for all three assets.
The bridge pushed candles seconds later, the flip handler started a SECOND concurrent
refresh which computed fast on MT5 bars and wrote gold=mt5 conf 0. Then the boot
refresh's GC=F fetch - the slowest of the network calls - resolved and overwrote gold
with yahoo conf 74.

The served signal's data source was therefore decided by network timing. For Gold the
two feeds disagree by 74 points of confidence and price different instruments (GC=F
futures vs XAUUSD spot), so this can publish a Gold signal carrying futures levels
while the account fills spot - the exact ambiguity dataSource was added to remove.

Chained, not coalesced: a caller must never JOIN an in-flight pass, because the
candle-flip trigger exists specifically to recompute with bars the running pass did
not have.
"""
import io
import sys

PATH = r"C:\ai-trading-dashboard\server\index.js"

OLD_GUARD = """let signalRefreshInFlight = false;"""

NEW_GUARD = """let signalRefreshInFlight = false;

// Serialises EVERY caller of the refresh. The flag above only ever guarded the
// candle-ingest path against itself, while refreshSignals is called from six places.
// Two passes running concurrently means last-writer-wins on signalCache, per asset,
// decided by network latency.
//
// That is not theoretical. On 2026-08-06 the server booted with an empty candle cache
// so its startup pass took the slow Yahoo path; the bridge pushed candles seconds
// later and the flip handler started a second pass that wrote gold=mt5 conf 0; then
// the boot pass's GC=F fetch - the slowest call in either pass - resolved and
// overwrote gold with yahoo conf 74. Gold then served futures-derived levels while the
// account fills spot, which is precisely the ambiguity dataSource exists to stop.
//
// Chained, NOT coalesced: a caller must never join an in-flight pass, because the
// candle-flip trigger exists specifically to recompute with bars the running pass did
// not have. The .catch keeps one failed refresh from breaking the chain forever.
let signalRefreshChain = Promise.resolve();
function queueSignalRefresh() {
  signalRefreshChain = signalRefreshChain
    .catch(() => {})
    .then(() => refreshSignals());
  return signalRefreshChain;
}"""

OLD_INGEST = """    refreshSignals()
      .catch(e => console.error("[mt5-candles] post-ingest refresh failed:", e.message))"""
NEW_INGEST = """    queueSignalRefresh()
      .catch(e => console.error("[mt5-candles] post-ingest refresh failed:", e.message))"""

with io.open(PATH, "r", encoding="utf-8") as fh:
    src = fh.read()

if src.count(OLD_GUARD) != 1:
    print("ABORT - guard declaration not found exactly once")
    sys.exit(1)
if src.count(OLD_INGEST) != 1:
    print("ABORT - ingest call site not found exactly once")
    sys.exit(1)

awaits = src.count("await refreshSignals();")
print("await refreshSignals() call sites:", awaits)
if awaits < 1:
    print("ABORT - no awaited call sites found")
    sys.exit(1)

src = src.replace(OLD_GUARD, NEW_GUARD)
src = src.replace(OLD_INGEST, NEW_INGEST)
src = src.replace("await refreshSignals();", "await queueSignalRefresh();")

# Expect exactly two references left: the function definition, and the single call
# inside queueSignalRefresh. Anything else is a call site that escaped the rewrite.
remaining = src.count("refreshSignals()")
print("refreshSignals() references remaining:", remaining, "(expect 2)")
if remaining != 2:
    print("ABORT - unexpected refreshSignals() references still present")
    sys.exit(1)

with io.open(PATH, "w", encoding="utf-8", newline="") as fh:
    fh.write(src)

print("patched OK")
