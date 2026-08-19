"""Forwards the bar source to the H4/H1 sub-calls and stamps the timeframe.

generateSignalMTF calls generateSignal three times - daily, H4, H1 - but only the
daily call was forwarding barSource, so any rejection raised on H4 or H1 landed in the
shadow log with a blank instrument. Observed immediately: SPX logged RANGE_TRADE_LONG
at R:R 0.879 with an empty sourceSymbol while Gold's daily rejection was stamped
XAUUSD correctly.

Timeframe rides on the same object rather than adding a fourth positional parameter.
Without it the dataset cannot distinguish a daily setup from an H1 one, and those have
completely different hold times - which makes "would this have won" unanswerable.
"""
import io
import sys

PATH = r"C:\ai-trading-dashboard\server\index.js"

OLD_DAILY = "  const daily = generateSignal(label, ticker, dailyData.closes, dailyData.highs, dailyData.lows, dailyData.volumes ?? [], dxyDailyCloses, barSource);"
NEW_DAILY = "  const daily = generateSignal(label, ticker, dailyData.closes, dailyData.highs, dailyData.lows, dailyData.volumes ?? [], dxyDailyCloses, { ...(barSource ?? {}), timeframe: \"D1\" });"

OLD_H4 = "      h4 = generateSignal(label, ticker, h4Data.closes, h4Data.highs, h4Data.lows, h4Data.volumes ?? []);"
NEW_H4 = "      h4 = generateSignal(label, ticker, h4Data.closes, h4Data.highs, h4Data.lows, h4Data.volumes ?? [], null, { ...(barSource ?? {}), timeframe: \"H4\" });"

OLD_H1 = "      h1 = generateSignal(label, ticker, h1Data.closes, h1Data.highs, h1Data.lows, h1Data.volumes ?? []);"
NEW_H1 = "      h1 = generateSignal(label, ticker, h1Data.closes, h1Data.highs, h1Data.lows, h1Data.volumes ?? [], null, { ...(barSource ?? {}), timeframe: \"H1\" });"

OLD_REC = """        dataSource:   barSource?.dataSource ?? null,
        sourceSymbol: barSource?.sourceSymbol ?? null,"""
NEW_REC = """        dataSource:   barSource?.dataSource ?? null,
        sourceSymbol: barSource?.sourceSymbol ?? null,
        // Which chart produced this. A daily setup and an H1 setup have completely
        // different hold times, so without this "would it have won" is unanswerable.
        timeframe:    barSource?.timeframe ?? null,"""

# Dedupe key must include the timeframe, or a D1 and an H1 rejection on the same
# instrument would suppress each other.
OLD_SIG = """    const signature = [
      record.ticker, record.setup, record.direction,
      record.entry, record.stop, record.target,
    ].join("|");
    if (rrRejectedLastSignature.get(record.ticker) === signature) return;
    rrRejectedLastSignature.set(record.ticker, signature);"""
NEW_SIG = """    // Keyed per instrument AND timeframe: the same asset can reject a D1 and an H1
    // setup in one pass, and a shared key would silently drop the second.
    const scope = `${record.ticker}|${record.timeframe ?? "?"}`;
    const signature = [
      record.setup, record.direction,
      record.entry, record.stop, record.target,
    ].join("|");
    if (rrRejectedLastSignature.get(scope) === signature) return;
    rrRejectedLastSignature.set(scope, signature);"""

BLOCKS = [
    ("daily call", OLD_DAILY, NEW_DAILY),
    ("h4 call", OLD_H4, NEW_H4),
    ("h1 call", OLD_H1, NEW_H1),
    ("record field", OLD_REC, NEW_REC),
    ("dedupe key", OLD_SIG, NEW_SIG),
]

with io.open(PATH, "r", encoding="utf-8") as fh:
    src = fh.read()

failed = False
for name, old, _ in BLOCKS:
    n = src.count(old)
    print("  %-13s: %d match(es)" % (name, n))
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
