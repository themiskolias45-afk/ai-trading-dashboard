import json,collections,datetime,math
COST=0.05
d=json.load(open('tasks/analysis/facts-20260731-2303.json'))
T=[dict(t, year=datetime.datetime.utcfromtimestamp(t['t']).year) for t in d['trades'] if t['outcome']!='EXPIRED']
def summ(ts):
    w=[t for t in ts if t['outcome']=='WIN']; l=[t for t in ts if t['outcome']=='LOSS']; n=len(w)+len(l)
    if n==0: return None
    gw=sum(t['rr']-COST for t in w); gl=len(l)*(1+COST)
    return dict(n=n,w=len(w),wr=100*len(w)/n,pf=(gw/gl if gl else 99),R=gw-gl,rpt=(gw-gl)/n)
def p(lbl,ts):
    s=summ(ts)
    print(f"  {lbl:32} n={s['n']:4} wins={s['w']:3} wr={s['wr']:5.1f}% pf={s['pf']:5.2f} R={s['R']:+8.2f} rpt={s['rpt']:+.3f}" if s else f"  {lbl:32} EMPTY")

print("Gold, RSI ladder (fine):")
for lo,hi in [(0,25),(25,30),(30,35),(35,40),(40,50),(50,65),(65,75),(75,200)]:
    p(f"Gold rsi {lo}-{hi}", [t for t in T if t['asset']=='Gold' and lo<=t['rsi']<hi])
print("\nSame ladder, BTC and SPX (control):")
for a in ('BTC','SPX'):
    for lo,hi in [(0,30),(30,35),(35,50)]:
        p(f"{a} rsi {lo}-{hi}", [t for t in T if t['asset']==a and lo<=t['rsi']<hi])

gold35=[t for t in T if t['asset']=='Gold' and t['rsi']<35]
print(f"\nThe 16 WIN rows in Gold rsi<35:")
for t in sorted([x for x in gold35 if x['outcome']=='WIN'], key=lambda x:x['rsi']):
    print(f"   {datetime.datetime.utcfromtimestamp(t['t']).date()} {t['setup']:18} {t['dir']:4} rsi={t['rsi']:5.1f} adx={t['adx']:5.1f} vol={t['volRatio']:.2f} rr={t['rr']:.2f} {t['regime']}")

# binomial: is 16/88 wins significantly below Gold's base rate?
goldrest=[t for t in T if t['asset']=='Gold' and t['rsi']>=35]
sr=summ(goldrest); print(f"\nGold rsi>=35 (the rest): n={sr['n']} wr={sr['wr']:.1f}% R={sr['R']:+.2f} rpt={sr['rpt']:+.3f}")
pbase=sr['w']/sr['n']; n=88; k=16
from math import comb
pv=sum(comb(n,i)*pbase**i*(1-pbase)**(n-i) for i in range(0,k+1))
print(f"binomial P(X<=16 | n=88, p={pbase:.3f}) = {pv:.5f}")

print("\nOverlap with known RANGE_TRADE_LONG&SQUEEZE ban:")
rtl=lambda t: t['setup']=='RANGE_TRADE_LONG' and t['regime']=='SQUEEZE'
g35=lambda t: t['asset']=='Gold' and t['rsi']<35
p("RTL&SQUEEZE only", [t for t in T if rtl(t) and not g35(t)])
p("Gold rsi<35 only",  [t for t in T if g35(t) and not rtl(t)])
p("both",              [t for t in T if g35(t) and rtl(t)])
tot=summ(T); print(f"\nBASELINE all: n={tot['n']} wr={tot['wr']:.1f}% pf={tot['pf']:.2f} R={tot['R']:+.2f} rpt={tot['rpt']:+.3f}")
p("AFTER Gold rsi<35 filter",      [t for t in T if not g35(t)])
p("AFTER RTL&SQUEEZE filter",      [t for t in T if not rtl(t)])
p("AFTER both filters",            [t for t in T if not g35(t) and not rtl(t)])
