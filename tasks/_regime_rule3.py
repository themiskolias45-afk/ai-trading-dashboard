"""Third pass: is the SPX momentum bleed an ADX interaction or an asset fact?"""
import json
import collections
from datetime import datetime, timezone
from math import comb

facts = json.load(open('tasks/analysis/facts-20260801-2302.json'))
trades = [t for t in facts['trades'] if t['outcome'] in ('WIN', 'LOSS')]
COST_R, LOSS_R = 0.05, -1.05


def r_of(t):
    return t['rr'] - COST_R if t['outcome'] == 'WIN' else LOSS_R


def year(t):
    return datetime.fromtimestamp(t['t'], tz=timezone.utc).year


def adx_band(t):
    return 'adx<20' if t['adx'] < 20 else ('adx20-30' if t['adx'] < 30 else 'adx>=30')


def agg(rows):
    if not rows:
        return 'n=0'
    w = [r_of(x) for x in rows if x['outcome'] == 'WIN']
    tot = sum(w) + LOSS_R * (len(rows) - len(w))
    gl = -LOSS_R * (len(rows) - len(w))
    return 'n=%-4d wr=%-5.1f pf=%-5s R=%-8.2f expR=%.3f' % (
        len(rows), 100 * len(w) / len(rows),
        round(sum(w) / gl, 2) if gl else 'inf', tot, tot / len(rows))


mom = [t for t in trades if t['setup'] == 'MOMENTUM']
print('### MOMENTUM: asset x adx band (is low ADX bad everywhere, or only on SPX?)')
for asset in ('BTC', 'Gold', 'SPX'):
    for band in ('adx<20', 'adx20-30', 'adx>=30'):
        rows = [t for t in mom if t['asset'] == asset and adx_band(t) == band]
        yr = collections.defaultdict(list)
        for t in rows:
            yr[year(t)].append(t)
        pos = sum(1 for y in yr if sum(r_of(x) for x in yr[y]) > 0)
        print('  %-5s %-9s %s  [pos yrs %d/%d]' % (asset, band, agg(rows), pos, len(yr)))
    print()

print('### MOMENTUM non-SPX vs SPX at adx<20 (the interaction test)')
low = [t for t in mom if t['adx'] < 20]
print('  SPX     %s' % agg([t for t in low if t['asset'] == 'SPX']))
print('  non-SPX %s' % agg([t for t in low if t['asset'] != 'SPX']))

print()
print('### MOMENTUM|SPX|adx<20 by year / timeframe / strength / rsi')
cand = [t for t in mom if t['asset'] == 'SPX' and t['adx'] < 20]
for name, fn in (('year', year), ('timeframe', lambda t: t['timeframe']),
                 ('strength', lambda t: t['strength']),
                 ('rsi', lambda t: 'rsi>=65' if t['rsi'] >= 65 else 'rsi<65')):
    g = collections.defaultdict(list)
    for t in cand:
        g[fn(t)].append(t)
    print(' ' + name)
    for k in sorted(g, key=str):
        print('   %-10s %s' % (k, agg(g[k])))

base_wr = sum(1 for t in trades if t['outcome'] == 'WIN') / len(trades)
k = sum(1 for t in cand if t['outcome'] == 'WIN')
n = len(cand)
p = sum(comb(n, i) * base_wr ** i * (1 - base_wr) ** (n - i) for i in range(k + 1))
print('\n  binomial: %d wins / %d, base wr %.3f -> P(<=k) = %.5f' % (k, n, base_wr, p))

print()
print('### stacked impact incl. the SPX momentum rule')
rules = [
    ('RTL|SQUEEZE', lambda t: t['setup'] == 'RANGE_TRADE_LONG' and t['regime'] == 'SQUEEZE'),
    ('RTS|RANGING', lambda t: t['setup'] == 'RANGE_TRADE_SHORT' and t['regime'] == 'RANGING'),
    ('MOMENTUM|SPX&adx<20', lambda t: t['setup'] == 'MOMENTUM' and t['asset'] == 'SPX' and t['adx'] < 20),
]
kept = trades
for label, fn in rules:
    kept = [t for t in kept if not fn(t)]
    tot = sum(r_of(t) for t in kept)
    w = [r_of(x) for x in kept if x['outcome'] == 'WIN']
    print('  after blocking %-22s R=%.2f expR=%.3f pf=%.3f n=%d'
          % (label, tot, tot / len(kept), sum(w) / (-LOSS_R * (len(kept) - len(w))), len(kept)))
