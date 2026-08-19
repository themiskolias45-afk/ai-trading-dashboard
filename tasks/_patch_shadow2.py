"""Records WHICH instrument produced the levels in each R:R rejection.

The first version stamped `ticker`, which is always the Yahoo ticker (GC=F) no matter
which feed supplied the bars. The levels it recorded - entry 4261.71 - were XAUUSD
spot, while GC=F futures was quoting 4322 at the same moment. Scoring that row against
the wrong series would produce a confidently wrong answer about whether the trade won,
which is worse than having no dataset at all.

This is the same instrument ambiguity the dataSource field exists to remove, so the
shadow log has to carry it too.

A module-level "current source" would NOT work here: refreshSignals runs the three
assets concurrently inside Promise.all, so they would overwrite each other. The source
is therefore passed down explicitly. Both parameters are optional with null defaults,
so every existing caller keeps working unchanged.
"""
import io
import sys

PATH = r"C:\ai-trading-dashboard\server\index.js"

# 1. generateSignal accepts the resolved source.
OLD_SIG = "function generateSignal(label, ticker, closes, highs, lows, volumes = [], dxyCloses = null) {"
NEW_SIG = "function generateSignal(label, ticker, closes, highs, lows, volumes = [], dxyCloses = null, barSource = null) {"

# 2. MTF wrapper accepts it and forwards it.
OLD_MTF = "function generateSignalMTF(label, ticker, dailyData, h4Data, h1Data = null, dxyDailyCloses = null) {\n  const daily = generateSignal(label, ticker, dailyData.closes, dailyData.highs, dailyData.lows, dailyData.volumes ?? [], dxyDailyCloses);"
NEW_MTF = "function generateSignalMTF(label, ticker, dailyData, h4Data, h1Data = null, dxyDailyCloses = null, barSource = null) {\n  const daily = generateSignal(label, ticker, dailyData.closes, dailyData.highs, dailyData.lows, dailyData.volumes ?? [], dxyDailyCloses, barSource);"

# 3. refreshSignals passes what it already resolved.
OLD_CALL = "      signalCache[a.key] = generateSignalMTF(a.label, a.symbol, dailyData, h4Data, h1Data, dxyForAsset);"
NEW_CALL = "      // barSource carries the instrument these levels were actually computed from.\n      // Without it the R:R shadow log records GC=F while holding XAUUSD prices.\n      signalCache[a.key] = generateSignalMTF(a.label, a.symbol, dailyData, h4Data, h1Data, dxyForAsset, { dataSource, sourceSymbol });"

# 4. The record carries it.
OLD_REC = """        ticker,
        label,
        setup,"""
NEW_REC = """        ticker,
        label,
        // The instrument these levels were priced on. `ticker` is always the Yahoo
        // symbol regardless of feed, so on its own it would mislabel MT5-derived
        // levels - GC=F futures and XAUUSD spot differ by tens of dollars.
        dataSource:   barSource?.dataSource ?? null,
        sourceSymbol: barSource?.sourceSymbol ?? null,
        setup,"""

BLOCKS = [
    ("generateSignal sig", OLD_SIG, NEW_SIG),
    ("generateSignalMTF", OLD_MTF, NEW_MTF),
    ("refreshSignals call", OLD_CALL, NEW_CALL),
    ("record fields", OLD_REC, NEW_REC),
]

with io.open(PATH, "r", encoding="utf-8") as fh:
    src = fh.read()

failed = False
for name, old, _ in BLOCKS:
    n = src.count(old)
    print("  %-20s: %d match(es)" % (name, n))
    if n != 1:
        failed = True

if failed:
    print("ABORT - expected exactly one match per block")
    sys.exit(1)

for _, old, new in BLOCKS:
    src = src.replace(old, new)

with io.open(PATH, "w", encoding="utf-8", newline="") as fh:
    fh.write(src)

print("patched OK")
