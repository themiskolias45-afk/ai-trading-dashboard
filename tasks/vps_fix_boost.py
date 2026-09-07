import io, sys
P = sys.argv[1]
s = io.open(P, encoding="utf-8", newline='').read()
CR = chr(13); LF = chr(10)
NL = CR + LF if s.count(CR + LF) > 0 else LF
def J(*l): return NL.join(l)
if "LEARNING_SHRINK_PSEUDO_TRADES" in s:
    sys.exit("REFUSE: already applied")

old = J('function getLearningBoost(setup) {',
        '  if (!setup || !learning.setupStats[setup]) return 0;',
        '  const s = learning.setupStats[setup];',
        '  const total = s.wins + s.losses;',
        '  if (total < 5) return 0;  // need minimum 5 trades before adjusting',
        '  const wr = s.wins / total;',
        '  // WR > 60% → positive boost up to +15, WR < 40% → negative down to -15',
        '  const boost = Math.round((wr - 0.5) * 30);',
        '  return Math.max(-15, Math.min(15, boost));',
        '}')
if s.count(old) != 1:
    sys.exit("REFUSE: getLearningBoost anchor matched %d" % s.count(old))

new = J(
'// Minimum closed trades on a setup before learning adjusts its confidence at all.',
'const LEARNING_MIN_TRADES = 5;',
'',
'// How far a boost can move confidence, and the span the win rate is stretched over.',
'const LEARNING_BOOST_CAP  = 15;',
'const LEARNING_BOOST_SPAN = 30;',
'',
'// Pseudo-trades at a 50% win rate, mixed into the NEGATIVE side only. Ten of them means',
'// a setup must out-lose the prior on real volume before it costs a full 15 points.',
'const LEARNING_SHRINK_PSEUDO_TRADES = 10;',
'',
'/**',
" * Confidence adjustment learned from this setup's own closed trades.",
' *',
' * THE NEGATIVE SIDE IS SHRUNK TOWARD THE PRIOR; THE POSITIVE SIDE IS NOT. That asymmetry',
" * is deliberate and it is the whole point of this function's current shape.",
' *',
' * A negative boost is the ONLY thing here that can stop a setup firing, and it used to',
' * reach its full -15 on FIVE closed trades: 0W/5L took fifteen points off confidence on',
' * what is, at that sample, five coin flips. That costs twice over - it suppresses the',
' * signal, and it suppresses the closed trade that would have told us whether the setup is',
' * actually bad. Sample size is the binding constraint on this system, so a rule that',
' * slows accumulation in order to act on noise is the most expensive kind of wrong.',
' *',
' * A positive boost can only ever ADMIT a trade, and an admitted trade produces evidence.',
' * There is no symmetric harm to correct, so the positive branch is left exactly as it was',
' * - shrinking it would make setups fire LESS often, which is the one thing this must not',
' * do.',
' *',
' * Traced exhaustively over every win/loss split to n=200 before it was written: the new',
' * boost is >= the old one in EVERY case, so no setup can fire less often than it does',
' * today. Worked examples:',
' *',
' *     0W/5L    -15 -> -5     five coin flips no longer cost fifteen points',
' *     1W/4L     -9 -> -3',
' *     2W/3L     -3 -> -1',
' *     0W/20L   -15 -> -10    sustained losing still bites, on real volume',
' *     0W/50L   -15 -> -12    converges toward the cap as evidence accumulates',
' *     3W/2L     +3 -> +3     positive side untouched',
' *     5W/0L    +15 -> +15',
' *     45W/5L   +12 -> +12',
' *',
' * LIVE EFFECT ON THE DAY THIS SHIPPED: none. The largest bucket held 2 closed trades',
' * (MOMENTUM 2W/0L), so every boost was already 0 and the firing set was provably',
' * unchanged. It takes effect only as evidence accumulates, which is when it should.',
' */',
'function getLearningBoost(setup) {',
'  if (!setup || !learning.setupStats[setup]) return 0;',
'  const s = learning.setupStats[setup];',
'  const total = s.wins + s.losses;',
'  if (total < LEARNING_MIN_TRADES) return 0;',
'  const winRate = s.wins / total;',
'',
'  // At or above break-even: unchanged from the original, deliberately.',
'  if (winRate >= 0.5) {',
'    return Math.max(-LEARNING_BOOST_CAP,',
'           Math.min(LEARNING_BOOST_CAP, Math.round((winRate - 0.5) * LEARNING_BOOST_SPAN)));',
'  }',
'',
'  // Below break-even: judge against a prior of LEARNING_SHRINK_PSEUDO_TRADES break-even',
'  // trades, so thin evidence moves confidence a little and real volume moves it a lot.',
'  const k = LEARNING_SHRINK_PSEUDO_TRADES;',
'  const shrunkWinRate = (s.wins + k / 2) / (total + k);',
'  return Math.max(-LEARNING_BOOST_CAP,',
'         Math.min(0, Math.round((shrunkWinRate - 0.5) * LEARNING_BOOST_SPAN)));',
'}')

# Guard: a doc block that closes itself early is a syntax error. Refuse rather than
# trust the wording - "*/30" inside /** */ already caused exactly that earlier today.
STAR = chr(42) + chr(47)
for line in new.split(NL):
    body = line.strip()
    if body.startswith(chr(42)) and STAR in body and body != STAR:
        sys.exit("REFUSE: this line closes the block comment early: " + body)

s = s.replace(old, new, 1)
if chr(0xFFFD) in s:
    sys.exit("REFUSE: replacement char introduced")
io.open(P, "w", encoding="utf-8", newline='').write(s)
print("getLearningBoost: negative side shrunk, positive side untouched")
