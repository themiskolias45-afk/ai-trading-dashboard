import io, sys
P = sys.argv[1]
s = io.open(P, encoding="utf-8", newline='').read()
CR = chr(13); LF = chr(10)
NL = CR + LF if s.count(CR + LF) > 0 else LF
def J(*l): return NL.join(l)
if "planNeedsRebuild" in s: sys.exit("REFUSE: already applied")

# 1. stamp the plan with whether positions were knowable when it was built
old = J('    watchlist: buildWatchlist(),',
        '    rules: buildRules(regime)',
        '  };')
new = J('    watchlist: buildWatchlist(),',
        '    // Whether ANY bridge had checked in when this plan was built. buildRules uses the',
        '    // same test to decide between "already held" and "holdings UNKNOWN", and the read',
        '    // paths below use it to rebuild once the answer becomes knowable.',
        '    positionsKnown: Object.keys(mt5LastSeenByAccount).length > 0,',
        '    rules: buildRules(regime)',
        '  };')
if s.count(old) != 1: sys.exit("REFUSE: anchor 1 matched %d" % s.count(old))
s = s.replace(old, new, 1)

# 2. the shared predicate, defined right after generateDailyPlan
old2 = J('  console.log(`[plan] ${regime} — ${now.toISOString()}`);',
         '  return dailyPlan;',
         '}')
new2 = J('  console.log(`[plan] ${regime} — ${now.toISOString()}`);',
         '  return dailyPlan;',
         '}',
         '',
         '/**',
         ' * The boot plan is ALWAYS built before any bridge has reported - startup calls',
         ' * generateDailyPlan directly, and the first bridge POST lands seconds later. Without',
         ' * this the cached plan says "holdings UNKNOWN" until the half-hourly cron rebuilds it, so for',
         ' * up to half an hour the panel a human reads first cannot tell them whether the',
         ' * tradeable signal in front of them is already open.',
         ' *',
         ' * Rebuild exactly once, when the answer becomes knowable. generateDailyPlan reads',
         ' * caches only - no network, no disk - so this cannot slow or fail a request, and',
         ' * after the single rebuild positionsKnown is true and this returns false forever.',
         ' */',
         'function planNeedsRebuild() {',
         '  if (!dailyPlan) return true;',
         '  return dailyPlan.positionsKnown === false && Object.keys(mt5LastSeenByAccount).length > 0;',
         '}')
# HARD GUARD: a block comment that closes itself is a syntax error, and the first attempt
# at this edit did exactly that - "*/30" written inside /** */ ended the comment on the
# word "cron". Refuse if any line of the new text closes a block comment where it should
# not, rather than trusting the wording.
STAR = chr(42) + chr(47)
for line in new2.split(NL):
    body = line.strip()
    if body.startswith(chr(42)) and STAR in body and body != STAR:
        sys.exit("REFUSE: this line closes the block comment early: " + body)
if s.count(old2) != 1: sys.exit("REFUSE: anchor 2 matched %d" % s.count(old2))
s = s.replace(old2, new2, 1)

# 3. both read paths
old3 = J('    app.get("/api/plan",    (_, res) => {',
         '      if (!dailyPlan) generateDailyPlan();').replace("    ", "", 1)
old3 = J('app.get("/api/plan",    (_, res) => {',
         '  if (!dailyPlan) generateDailyPlan();')
new3 = J('app.get("/api/plan",    (_, res) => {',
         '  if (planNeedsRebuild()) generateDailyPlan();')
if s.count(old3) != 1: sys.exit("REFUSE: anchor 3 matched %d" % s.count(old3))
s = s.replace(old3, new3, 1)

old4 = J('    "/plan": async () => {',
         '      if (!dailyPlan) generateDailyPlan();')
new4 = J('    "/plan": async () => {',
         '      if (planNeedsRebuild()) generateDailyPlan();')
if s.count(old4) != 1: sys.exit("REFUSE: anchor 4 matched %d" % s.count(old4))
s = s.replace(old4, new4, 1)

if chr(0xFFFD) in s: sys.exit("REFUSE: replacement char")
io.open(P, "w", encoding="utf-8", newline='').write(s)
print("plan rebuilds once when holdings become knowable")
