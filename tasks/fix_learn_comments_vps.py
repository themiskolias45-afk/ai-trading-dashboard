import io, sys
p = "C:/ai-trading-dashboard/server/index.js"
s = io.open(p, encoding="utf-8", newline='').read()
CR = chr(13); LF = chr(10)
NL = CR + LF if s.count(CR + LF) > 0 else LF
def J(*l): return NL.join(l)

if "MEASURED 2026-08-27" in s:
    sys.exit("REFUSE: already applied")

old1 = J("// produces about one trade a month, so that threshold is years away and",
         "// setupStats has sat empty through 42 server sessions.")
new1 = J("// produces about one trade a month, so that threshold is years away and",
         "// setupStats sat empty through 42 server sessions.",
         "//",
         "// MEASURED 2026-08-27 — THIS WORKED, AND THE SENTENCE ABOVE IS NOW HISTORY.",
         "// sessionCount is 287 and setupStats is no longer empty: MOMENTUM 2W/0L,",
         "// BB_SQUEEZE_WATCH 0W/1L, RANGE_TRADE_SHORT 0W/1L, SQUEEZE_BREAKOUT 0W/1L.",
         "// Five closed trades across four setups, where there had been none.",
         "//",
         "// getLearningBoost still returns 0 for every one of them, and that is CORRECT,",
         "// not a dead path: the floor is 5 closed trades PER SETUP and the largest bucket",
         "// holds 2. The learning engine is running and simply has not been given enough",
         "// to say. Do not go looking for a fault here - the constraint is sample size, the",
         "// same one named everywhere else in this system. It clears with time and nothing",
         "// else.")
if s.count(old1) != 1: sys.exit("REFUSE: anchor 1 matched %d" % s.count(old1))
s = s.replace(old1, new1, 1)

old2 = J("  // Flagging a weak trend is useful; refusing to trade at all is what left",
         "  // setupStats empty for 42 sessions.")
new2 = J("  // Flagging a weak trend is useful; refusing to trade at all is what left",
         "  // setupStats empty for 42 sessions.",
         "  //",
         "  // MEASURED 2026-08-27: the demotion-not-refusal choice paid off. setupStats now",
         "  // carries 4 setups and 5 closed trades after 287 sessions. Still short of the",
         "  // 5-per-setup floor getLearningBoost needs, so no boost is live yet - but the",
         "  // table is filling, which is what this change was for. See the note on",
         "  // STRENGTH_LEVELS for the current counts; do not restate them here, because two",
         "  // copies of the same number is how the previous version of this comment went",
         "  // stale and started describing a system that no longer existed.")
if s.count(old2) != 1: sys.exit("REFUSE: anchor 2 matched %d" % s.count(old2))
s = s.replace(old2, new2, 1)

if chr(0xFFFD) in s: sys.exit("REFUSE: replacement char")
io.open(p, "w", encoding="utf-8", newline='').write(s)
print("both stale learning comments corrected")
