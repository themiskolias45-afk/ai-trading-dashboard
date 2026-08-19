"""Makes the AI trade filter read the live confidence gate instead of a hardcoded 60.

The prompt at /api/claude-approve-trade hardcoded "confidence >= 60%". The bridge
treats a rejection there as final, so the EFFECTIVE live gate was
max(strategySettings.confidenceThreshold, 60) regardless of what the dashboard said.

This is the third invisible copy of the gate. The first was the engine's own
threshold; the second was sizing.js's MIN_CONFIDENCE = 65, removed in d320785 -
which is precisely what let confidenceThreshold=50 become real, whereupon this 60
silently took its place.
"""
import io
import sys

PATH = r"C:\ai-trading-dashboard\server\index.js"

OLD = """    `APPROVE the trade if ALL of: confidence >= 60%, R/R >= 1.5, no news blackout, macro not strongly against.\\n` +
    `REJECT if: confidence < 60%, R/R < 1.5, news blackout active, strong macro headwind (strong DXY against Gold/BTC long), or VIX > 30 on a BUY.\\n\\n` +"""

NEW = """    `APPROVE the trade if ALL of: confidence >= ${aiMinConfidence}%, R/R >= 1.5, no news blackout, macro not strongly against.\\n` +
    `REJECT if: confidence < ${aiMinConfidence}%, R/R < 1.5, news blackout active, strong macro headwind (strong DXY against Gold/BTC long), or VIX > 30 on a BUY.\\n\\n` +"""

OLD_ANCHOR = """  const newsCheck = isNewsBlackout();
  const macro = `DXY ${priceCache.dxy ?? "N/A"} | VIX ${priceCache.vix ?? "N/A"}`;
"""

NEW_ANCHOR = """  const newsCheck = isNewsBlackout();
  const macro = `DXY ${priceCache.dxy ?? "N/A"} | VIX ${priceCache.vix ?? "N/A"}`;

  // The confidence bar below used to be a hardcoded 60, which made this prompt a
  // THIRD invisible copy of the gate - after strategySettings.confidenceThreshold
  // and sizing.js's MIN_CONFIDENCE = 65. The bridge calls this endpoint before every
  // execution and treats a rejection as final, so the EFFECTIVE live gate was
  // max(confidenceThreshold, 60) no matter what the dashboard said.
  //
  // That mattered the moment d320785 removed the sizing.js clamp: confidenceThreshold
  // = 50 finally became real, and this 60 stepped straight into the vacancy. Measured
  // 2026-08-06 - BTC at confidence 50 was approved by the engine and vetoed here every
  // 15-30 minutes for a full day, on both machines, with the reason logged only to the
  // bridge log and nowhere a dashboard would show it.
  //
  // Falls back to the shipped default rather than 0 so a missing/unreadable settings
  // file cannot silently drop the AI filter's bar to "approve everything".
  const aiMinConfidence = Number.isFinite(Number(strategySettings?.confidenceThreshold))
    ? Number(strategySettings.confidenceThreshold)
    : AI_FILTER_FALLBACK_CONFIDENCE;
"""

# Named constant - no magic numbers. Placed beside the endpoint it serves.
OLD_ROUTE = 'app.post("/api/claude-approve-trade", async (req, res) => {'
NEW_ROUTE = """// Used only when strategy_settings.json cannot be read. Matches the shipped default
// for confidenceThreshold, so a settings failure degrades to the documented gate
// rather than to no gate at all.
const AI_FILTER_FALLBACK_CONFIDENCE = 70;

app.post("/api/claude-approve-trade", async (req, res) => {"""

with io.open(PATH, "r", encoding="utf-8") as fh:
    src = fh.read()

blocks = [("prompt", OLD, NEW), ("anchor", OLD_ANCHOR, NEW_ANCHOR), ("route", OLD_ROUTE, NEW_ROUTE)]

failed = False
for name, old, _ in blocks:
    n = src.count(old)
    print("  %-8s %d match(es)" % (name, n))
    if n != 1:
        failed = True

if failed:
    print("ABORT - expected exactly one match per block; file differs from expectation")
    sys.exit(1)

for _, old, new in blocks:
    src = src.replace(old, new)

with io.open(PATH, "w", encoding="utf-8", newline="") as fh:
    fh.write(src)

print("patched OK")
