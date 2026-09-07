"""Scan setup x condition cells for bleeds, then stress-test each survivor.

Run: python tasks/_regime_rule.py [facts.json]
Not a production file - analysis scratch for the regime-fit question.
"""
import json
import sys
import collections
from datetime import datetime, timezone

FACTS = sys.argv[1] if len(sys.argv) > 1 else 'tasks/analysis/facts-20260801-2302.json'
COST_R = 0.05
LOSS_R = -1.05
MIN_CELL = 20

facts = json.load(open(FACTS))
trades = [t for t in facts['trades'] if t['outcome'] in ('WIN', 'LOSS')]


def r_of(trade):
    return trade['rr'] - COST_R if trade['outcome'] == 'WIN' else LOSS_R


def year_of(trade):
    return datetime.fromtimestamp(trade['t'], tz=timezone.utc).year


def adx_band(trade):
    a = trade['adx']
    return 'adx<20' if a < 20 else ('adx20-30' if a < 30 else 'adx>=30')


def rsi_band(trade):
    r = trade['rsi']
    if r < 35:
        return 'rsi<35'
    if r < 50:
        return 'rsi35-50'
    return 'rsi50-65' if r < 65 else 'rsi>=65'


CONDITIONS = {
    'regime': lambda x: x['regime'],
    'trend': lambda x: x['trend'],
    'adx': adx_band,
    'rsi': rsi_band,
    'asset': lambda x: x['asset'],
    'dir': lambda x: x['dir'],
    'timeframe': lambda x: x['timeframe'],
    'strength': lambda x: x['strength'],
}


def stats(rows):
    if not rows:
        return dict(n=0, wr=0.0, pf=0.0, totalR=0.0, expR=0.0)
    wins = [r_of(x) for x in rows if x['outcome'] == 'WIN']
    gross_win = sum(wins)
    gross_loss = -LOSS_R * (len(rows) - len(wins))
    total = gross_win + LOSS_R * (len(rows) - len(wins))
    return dict(
        n=len(rows),
        wr=round(100 * len(wins) / len(rows), 1),
        pf=round(gross_win / gross_loss, 2) if gross_loss else float('inf'),
        totalR=round(total, 2),
        expR=round(total / len(rows), 3),
    )


def line(label, s):
    return '%-40s n=%-5d wr=%-5s pf=%-5s R=%-8s expR=%s' % (
        label, s['n'], s['wr'], s['pf'], s['totalR'], s['expR'])


print('=== every setup x condition cell with n>=%d and negative R ===' % MIN_CELL)
cells = []
for cond_name, fn in CONDITIONS.items():
    groups = collections.defaultdict(list)
    for x in trades:
        groups[(x['setup'], fn(x))].append(x)
    for (setup, val), rows in groups.items():
        s = stats(rows)
        if s['n'] >= MIN_CELL and s['totalR'] < 0:
            cells.append((s['totalR'], cond_name, setup, val, s, rows))
cells.sort()
for totalR, cond_name, setup, val, s, rows in cells:
    print(line('%s | %s=%s' % (setup, cond_name, val), s))

print()
print('=== stress test: by year / dir / asset, and collinearity ===')
for totalR, cond_name, setup, val, s, rows in cells:
    print('\n--- %s when %s=%s : %s' % (setup, cond_name, val, line('', s).strip()))
    for axis, fn in (('year', year_of), ('dir', lambda x: x['dir']),
                     ('asset', lambda x: x['asset'])):
        g = collections.defaultdict(list)
        for x in rows:
            g[fn(x)].append(x)
        parts = []
        for k in sorted(g, key=str):
            st = stats(g[k])
            parts.append('%s:%s(n%d)' % (k, st['totalR'], st['n']))
        collin = ' COLLINEAR' if len(g) == 1 else ''
        print('   %-6s %s%s' % (axis, '  '.join(parts), collin))
