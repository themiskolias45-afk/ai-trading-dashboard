import io, sys
P = sys.argv[1]
s = io.open(P, encoding="utf-8", newline='').read()
CR = chr(13); LF = chr(10)
NL = CR + LF if s.count(CR + LF) > 0 else LF
def J(*l): return NL.join(l)
if "positionsKnown" in s: sys.exit("REFUSE: already applied")

old = J('  const heldSymbols = new Set(',
        '    (Array.isArray(mt5Positions) ? mt5Positions : []).map(p => String(p.symbol || "").toUpperCase()));')
new = J('  // An empty position list means one of two completely different things, and saying',
        '  // "TRADEABLE now" for a symbol that is actually held is the worse of the two.',
        '  // For ~60s after every server restart NO bridge has posted yet, so mt5Positions is',
        '  // [] while the trades are still open at the broker - the documented',
        '  // positions-read-zero-after-a-restart window. mt5LastSeenByAccount is the',
        '  // discriminator: empty means UNKNOWN, not zero.',
        '  const positionsKnown = Object.keys(mt5LastSeenByAccount).length > 0;',
        '  const heldSymbols = new Set(',
        '    (Array.isArray(mt5Positions) ? mt5Positions : []).map(p => String(p.symbol || "").toUpperCase()));')
if s.count(old) != 1: sys.exit("REFUSE: anchor A matched %d" % s.count(old))
s = s.replace(old, new, 1)

oldb = J('    if (Number.isFinite(conf) && conf >= gate && sig.signal !== "WAIT") {',
         '      lines.push(held',
         '        ? `${label}: ${sig.signal} ${conf}% — ABOVE the gate but already held, so the DUPLICATE gate will refuse a new entry. Not a failure.`',
         '        : `${label}: ${sig.signal} ${conf}% — TRADEABLE now (${String(sig.setup || "").replace(/_/g, " ")}).`);',
         '      continue;',
         '    }')
newb = J('    if (Number.isFinite(conf) && conf >= gate && sig.signal !== "WAIT") {',
         '      const setupName = String(sig.setup || "").replace(/_/g, " ");',
         '      if (held) {',
         '        lines.push(`${label}: ${sig.signal} ${conf}% — ABOVE the gate but already held, so the DUPLICATE gate will refuse a new entry. Not a failure.`);',
         '      } else if (!positionsKnown) {',
         '        lines.push(`${label}: ${sig.signal} ${conf}% — above the gate (${setupName}), but NO bridge has reported positions yet, so whether it is already held is UNKNOWN. Do not read this as tradeable until a bridge checks in.`);',
         '      } else {',
         '        lines.push(`${label}: ${sig.signal} ${conf}% — TRADEABLE now (${setupName}).`);',
         '      }',
         '      continue;',
         '    }')
if s.count(oldb) != 1: sys.exit("REFUSE: anchor B matched %d" % s.count(oldb))
s = s.replace(oldb, newb, 1)
if chr(0xFFFD) in s: sys.exit("REFUSE: replacement char")
io.open(P, "w", encoding="utf-8", newline='').write(s)
print("held-vs-unknown now distinguished")
