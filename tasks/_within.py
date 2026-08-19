import json,collections,datetime
COST=0.05
d=json.load(open('tasks/analysis/facts-20260731-2303.json'))
T=[dict(t, year=datetime.datetime.utcfromtimestamp(t['t']).year) for t in d['trades'] if t['outcome']!='EXPIRED']
def summ(ts):
    w=[t for t in ts if t['outcome']=='WIN']; l=[t for t in ts if t['outcome']=='LOSS']; n=len(w)+len(l)
    if n==0: return None
    gw=sum(t['rr']-COST for t in w); gl=len(l)*(1+COST)
    return dict(n=n,w=len(w),wr=100*len(w)/n,pf=(gw/gl if gl else 99),R=gw-gl,rpt=(gw-gl)/n)
def line(lbl,ts):
    s=summ(ts)
    print(f"  {lbl:38} n={s['n']:4} wr={s['wr']:5.1f}% pf={s['pf']:5.2f} R={s['R']:+8.2f} rpt={s['rpt']:+.3f}" if s else f"  {lbl:38} n=0")
DZ=lambda t: 30<=t['rsi']<50
print("=== WITHIN-SETUP: does rsi30-50 hurt, holding setup fixed? ===")
for st in ['RANGE_TRADE_LONG','SQUEEZE_BREAKOUT','BUY_OVERSOLD','MOMENTUM']:
    sub=[t for t in T if t['setup']==st]
    line(f"{st} IN dz",  [t for t in sub if DZ(t)])
    line(f"{st} OUT dz", [t for t in sub if not DZ(t)])
print("\n  (SQUEEZE_BREAKOUT dz is 100% SELL -> compare SELL-only)")
sb=[t for t in T if t['setup']=='SQUEEZE_BREAKOUT' and t['dir']=='SELL']
line("SQZ_BO SELL IN dz",  [t for t in sb if DZ(t)])
line("SQZ_BO SELL OUT dz", [t for t in sb if not DZ(t)])
print("\n=== WITHIN-SETUP: does Gold rsi<35 hurt, holding setup+dir fixed? ===")
for st,dr in [('BUY_OVERSOLD','BUY'),('SQUEEZE_BREAKOUT','SELL'),('RANGE_TRADE_LONG','BUY')]:
    sub=[t for t in T if t['setup']==st and t['dir']==dr]
    line(f"{st}/{dr} Gold rsi<35",  [t for t in sub if t['asset']=='Gold' and t['rsi']<35])
    line(f"{st}/{dr} Gold rsi>=35", [t for t in sub if t['asset']=='Gold' and t['rsi']>=35])
    line(f"{st}/{dr} nonGold rsi<35",[t for t in sub if t['asset']!='Gold' and t['rsi']<35])
    print()
print("=== RANGE_TRADE_LONG everywhere (is it just RTL?) ===")
rtl=[t for t in T if t['setup']=='RANGE_TRADE_LONG']
for ax in ['regime','asset','year','rsiBucket']:
    g=collections.defaultdict(list)
    for t in rtl:
        k = ('rsi<30' if t['rsi']<30 else 'rsi30-50' if t['rsi']<50 else 'rsi>=50') if ax=='rsiBucket' else t[ax]
        g[k].append(t)
    print(f"  by {ax}: " + " | ".join(f"{k}:n={summ(v)['n']},R={summ(v)['R']:+.1f},rpt={summ(v)['rpt']:+.2f}" for k,v in sorted(g.items(),key=str)))
