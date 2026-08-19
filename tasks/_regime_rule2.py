"""Second pass: overlap, subslice and stacked-impact checks for the candidate rules."""
import json
import collections
from datetime import datetime, timezone

FACTS = 'tasks/analysis/facts-20260801-2302.json'
COST_R, LOSS_R = 0.05, -1.05
facts = json.load(open(FACTS))
trades = [t for t in facts['trades'] if t['outcome'] in ('WIN', 'LOSS')]


def r_of(t):
    return t['rr'] - COST_R if t['outcome'] == 'WIN' else LOSS_R


def year(t):
    return datetime.fromtimestamp(t['t'], tz=timezone.utc).year


def adx_band(t):
    return 'adx<20' if t['adx'] < 20 else ('adx20-30' if t['adx'] < 30 else 'adx>=30')


def rsi_band(t):
    r = t['rsi']
    return 'rsi<35' if r < 35 else ('rsi35-50' if r < 50 else ('rsi50-65' if r < 65 else 'rsi>=65'))


def agg(rows):
    if not rows:
        return 'n=0'
    w = [r_of(x) for x in rows if x['outcome'] == 'WIN']
    tot = sum(w) + LOSS_R * (len(rows) - len(w))
    gl = -LOSS_R * (len(rows) - len(w))
    pf = round(sum(w) / gl, 2) if gl else float('inf')
    return 'n=%-4d wr=%-5.1f pf=%-5s R=%-8.2f expR=%.3f' % (
        len(rows), 100 * len(w) / len(rows), pf, tot, tot / len(rows))


RTL_SQ = lambda t: t['setup'] == 'RANGE_TRADE_LONG' and t['regime'] == 'SQUEEZE'
RTS_RANGE = lambda t: t['setup'] == 'RANGE_TRADE_SHORT' and t['regime'] == 'RANGING'
GOLD_RSI = lambda t: t['asset'] == 'Gold' and t['rsi'] < 35

print('### 1. MOMENTUM|SPX -- is any condition subslice stably negative?')
mom_spx = [t for t in trades if t['setup'] == 'MOMENTUM' and t['asset'] == 'SPX']
for name, fn in (('regime', lambda t: t['regime']), ('trend', lambda t: t['trend']),
                 ('adx', adx_band), ('rsi', rsi_band), ('strength', lambda t: t['strength']),
                 ('timeframe', lambda t: t['timeframe'])):
    g = collections.defaultdict(list)
    for t in mom_spx:
        g[fn(t)].append(t)
    print(' ' + name)
    for k in sorted(g, key=str):
        rows = g[k]
        yr = collections.defaultdict(list)
        for t in rows:
            yr[year(t)].append(t)
        pos = sum(1 for y in yr if sum(r_of(x) for x in yr[y]) > 0)
        print('   %-18s %s  [pos yrs %d/%d]' % (k, agg(rows), pos, len(yr)))

print()
print('### 2. overlap between the candidate rules')
sets = {'RTL|SQUEEZE': RTL_SQ, 'RTS|RANGING': RTS_RANGE, 'Gold&rsi<35': GOLD_RSI,
        'RTS|adx<20': lambda t: t['setup'] == 'RANGE_TRADE_SHORT' and t['adx'] < 20}
names = list(sets)
for i, a in enumerate(names):
    for b in names[i + 1:]:
        both = [t for t in trades if sets[a](t) and sets[b](t)]
        print('  %-14s n %-14s overlap=%d' % (a, b, len(both)))

print()
print('### 3. stacked impact (blocking each rule, cumulative)')
base = sum(r_of(t) for t in trades)
print('  baseline                        R=%.2f  expR=%.3f  n=%d'
      % (base, base / len(trades), len(trades)))
kept = trades
for label, fn in (('RTL|SQUEEZE', RTL_SQ), ('+ RTS|RANGING', RTS_RANGE), ('+ Gold&rsi<35', GOLD_RSI)):
    kept = [t for t in kept if not fn(t)]
    tot = sum(r_of(t) for t in kept)
    w = [r_of(x) for x in kept if x['outcome'] == 'WIN']
    pf = sum(w) / (-LOSS_R * (len(kept) - len(w)))
    print('  block %-24s R=%.2f  expR=%.3f  pf=%.3f  n=%d (-%d)'
          % (label, tot, tot / len(kept), pf, len(kept), len(trades) - len(kept)))

print()
print('### 4. RTL|SQUEEZE vs RTL elsewhere -- is SQUEEZE the condition or is the setup just broken?')
rtl = [t for t in trades if t['setup'] == 'RANGE_TRADE_LONG']
g = collections.defaultdict(list)
for t in rtl:
    g[t['regime']].append(t)
for k in sorted(g):
    print('  RTL|%-10s %s' % (k, agg(g[k])))
print()
print('### 5. RTS by regime, and does adx<20 add anything beyond RANGING?')
rts = [t for t in trades if t['setup'] == 'RANGE_TRADE_SHORT']
g = collections.defaultdict(list)
for t in rts:
    g[t['regime']].append(t)
for k in sorted(g):
    print('  RTS|%-10s %s' % (k, agg(g[k])))
rest = [t for t in rts if t['regime'] != 'RANGING']
print('  RTS non-RANGING, adx<20   %s' % agg([t for t in rest if t['adx'] < 20]))
print('  RTS non-RANGING, adx>=20  %s' % agg([t for t in rest if t['adx'] >= 20]))

print()
print('### 6. binomial sanity on the two rules (vs engine base win rate)')
try:
    from math import comb
    base_wr = sum(1 for t in trades if t['outcome'] == 'WIN') / len(trades)
    for label, fn in (('RTL|SQUEEZE', RTL_SQ), ('RTS|RANGING', RTS_RANGE)):
        rows = [t for t in trades if fn(t)]
        k = sum(1 for t in rows if t['outcome'] == 'WIN')
        n = len(rows)
        p = sum(comb(n, i) * base_wr ** i * (1 - base_wr) ** (n - i) for i in range(k + 1))
        print('  %-14s %d wins / %d, base wr %.3f -> P(<=k) = %.5f' % (label, k, n, base_wr, p))
except ImportError:
    print('  comb unavailable')
