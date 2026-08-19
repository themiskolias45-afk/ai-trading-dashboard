import json,collections,datetime
from math import comb
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
    print(f"  {lbl:30} n={s['n']:4} w={s['w']:3} wr={s['wr']:5.1f}% pf={s['pf']:5.2f} R={s['R']:+8.2f} rpt={s['rpt']:+.3f}" if s else f"  {lbl:30} -")
DZ=lambda t: 30<=t['rsi']<50
print("=== GLOBAL RSI LADDER (all assets) ===")
for lo,hi in [(0,25),(25,30),(30,35),(35,40),(40,45),(45,50),(50,55),(55,65),(65,75),(75,200)]:
    line(f"rsi {lo}-{hi}", [t for t in T if lo<=t['rsi']<hi])
dz=[t for t in T if DZ(t)]
print("\n=== DEAD ZONE rsi 30-50 : robustness ===")
line("ALL", dz)
for ax in ['asset','dir','setup','year','regime','timeframe','strength','trend']:
    print(f"  -- by {ax} --")
    g=collections.defaultdict(list)
    for t in dz: g[t[ax]].append(t)
    for k in sorted(g,key=str): line(f"     {k}", g[k])
print("\n=== WIN-SIDE CHECK: is 30-50 present in the winners? ===")
W=[t for t in T if t['outcome']=='WIN']; L=[t for t in T if t['outcome']=='LOSS']
inW=sum(1 for t in W if DZ(t)); inL=sum(1 for t in L if DZ(t))
print(f"  winShare={inW/len(W):.4f} ({inW}/{len(W)})   lossShare={inL/len(L):.4f} ({inL}/{len(L)})  lift={(inL/len(L))/(inW/len(W)):.2f}")
rest=summ([t for t in T if not DZ(t)]); pbase=rest['w']/rest['n']
s=summ(dz); pv=sum(comb(s['n'],i)*pbase**i*(1-pbase)**(s['n']-i) for i in range(0,s['w']+1))
print(f"  outside dead zone: n={rest['n']} wr={rest['wr']:.1f}% R={rest['R']:+.2f} rpt={rest['rpt']:+.3f}")
print(f"  binomial P(X<={s['w']} | n={s['n']}, p={pbase:.3f}) = {pv:.6f}")
print("\n=== FILTER IMPACT ===")
line("baseline", T)
line("block rsi30-50", [t for t in T if not DZ(t)])
g35=lambda t: t['asset']=='Gold' and t['rsi']<35
rtl=lambda t: t['setup']=='RANGE_TRADE_LONG' and t['regime']=='SQUEEZE'
line("block rsi30-50 + RTL/SQUEEZE", [t for t in T if not DZ(t) and not rtl(t)])
line("block rsi30-50 + RTL/SQ + Gold<35", [t for t in T if not DZ(t) and not rtl(t) and not g35(t)])
print("\n=== overlap ===")
line("dz only (not RTL/SQ, not Gold<35)", [t for t in T if DZ(t) and not rtl(t) and not g35(t)])
