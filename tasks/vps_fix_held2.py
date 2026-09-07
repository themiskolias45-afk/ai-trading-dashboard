import io, sys
P = sys.argv[1]
s = io.open(P, encoding="utf-8", newline='').read()
CR = chr(13); LF = chr(10)
NL = CR + LF if s.count(CR + LF) > 0 else LF
def J(*l): return NL.join(l)
if "ASSET_BROKER_SYMBOLS" in s: sys.exit("REFUSE: already applied")

# The map, placed just above generateDailyPlan.
anchor = "function generateDailyPlan() {"
if s.count(anchor) != 1: sys.exit("REFUSE: generateDailyPlan anchor matched %d" % s.count(anchor))
mapsrc = J(
 '// Every broker symbol each asset can legitimately appear as, so "am I already holding',
 '// this?" can be answered without depending on which data source last wrote the signal.',
 '//',
 '// sourceSymbol is NOT stable: it is the MT5 symbol when bars came from the bridge and',
 '// the YAHOO ticker when the signal fell back to Yahoo, which happens for the first',
 '// minute after every server restart. Comparing it directly to an open position means a',
 '// held XAUUSD reads as free the moment the signal says GC=F - the plan then prints',
 '// "TRADEABLE now" for a trade that is already open, which is the single most misleading',
 '// thing this panel can say. Both readers below used to do exactly that.',
 '//',
 '// MIRRORS SYMBOL_CANDIDATES in mt5_bridge.py:106, plus each Yahoo ticker. If a symbol is',
 '// added there, add it here - the bridge is the authority, this is a reader. Getting it',
 '// wrong makes a MESSAGE wrong, never a trade: the real DUPLICATE gate is in the bridge.',
 'const ASSET_BROKER_SYMBOLS = {',
 '  btc:  ["BTCUSD", "BTC/USD", "BITCOIN", "BTCUSDT", "BTC-USD"],',
 '  gold: ["XAUUSD", "GOLD", "XAUUSDM", "GOLDM", "GC=F"],',
 '  spx:  ["SP500", "US500", "SPX500", "US.500", "SPY", "^GSPC"],',
 '};',
 '',
 '// True when an open position matches the asset, on any of its accepted symbols.',
 'function isAssetHeld(assetKey, signal) {',
 '  const accepted = new Set(ASSET_BROKER_SYMBOLS[assetKey] || []);',
 '  const src = String(signal?.sourceSymbol || "").toUpperCase();',
 '  if (src) accepted.add(src);   // never narrower than the old behaviour',
 '  if (!Array.isArray(mt5Positions)) return false;',
 '  return mt5Positions.some(p => accepted.has(String(p.symbol || "").toUpperCase()));',
 '}',
 '',
 anchor)
s = s.replace(anchor, mapsrc, 1)

old_b = '    const held = heldSymbols.has(String(sig.sourceSymbol || "").toUpperCase());'
new_b = '    const held = isAssetHeld(key, sig);'
if s.count(old_b) != 1: sys.exit("REFUSE: buildRules held anchor matched %d" % s.count(old_b))
s = s.replace(old_b, new_b, 1)

old_set = J('  const heldSymbols = new Set(',
            '    (Array.isArray(mt5Positions) ? mt5Positions : []).map(p => String(p.symbol || "").toUpperCase()));')
if s.count(old_set) != 1: sys.exit("REFUSE: heldSymbols anchor matched %d" % s.count(old_set))
s = s.replace(old_set + NL, "", 1)

old_t = J('        const held = Array.isArray(mt5Positions)',
          '          && mt5Positions.some(p => String(p.symbol || "").toUpperCase()',
          '               === String(s.sourceSymbol || "").toUpperCase());')
new_t = J('        // Same trap as the daily plan: sourceSymbol is the Yahoo ticker on a',
          '        // Yahoo-derived signal, so a direct comparison misses a held position and',
          '        // the alert omits the one line that explains why nothing traded.',
          '        const held = isAssetHeld(key, s);')
if s.count(old_t) != 1: sys.exit("REFUSE: telegram held anchor matched %d" % s.count(old_t))
s = s.replace(old_t, new_t, 1)

if chr(0xFFFD) in s: sys.exit("REFUSE: replacement char")
io.open(P, "w", encoding="utf-8", newline='').write(s)
print("both held-checks now use the broker-symbol candidate set")
