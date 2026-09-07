import json,collections,datetime
COST=0.05
d=json.load(open('tasks/analysis/facts-20260731-2303.json'))
T=[dict(t, year=datetime.datetime.utcfromtimestamp(t['t']).year) for t in d['trades'] if t['outcome']!='EXPIRED']
def summ(ts):
    w=[t for t in ts if t['outcome']=='WIN']; l=[t for t in ts if t['outcome']=='LOSS']; n=len(w)+len(l)
    gw=sum(t['rr']-COST for t in w); gl=len(l)*(1+COST)
    return dict(n=n,w=len(w),l=len(l),wr=100*len(w)/n,pf=(gw/gl if gl else 99),R=gw-gl,rpt=(gw-gl)/n,gw=gw,gl=gl)
W=[t for t in T if t['outcome']=='WIN']; L=[t for t in T if t['outcome']=='LOSS']
G=lambda t: t['asset']=='Gold' and t['rsi']<35
s=summ([t for t in T if G(t)])
print(f"GOLD rsi<35: n={s['n']} wins={s['w']} losses={s['l']} wr={s['wr']:.1f}% pf={s['pf']:.2f} R={s['R']:+.2f} rpt={s['rpt']:+.3f}")
print(f"  grossWin={s['gw']:+.2f}R  grossLoss={-s['gl']:+.2f}R  (losses capped at -1.05R each -> no outlier trade drives this)")
print(f"  lossShare={s['l']/len(L):.4f}  winShare={s['w']/len(W):.4f}  lift={(s['l']/len(L))/(s['w']/len(W)):.2f}")
print("\nLIFT RANKING, buckets with n>=50 (loss-share / win-share):")
rows=[]
def add(lbl,fn):
    sub=[t for t in T if fn(t)]; ss=summ(sub)
    if ss['n']>=50: rows.append((ss['l']/len(L)/(ss['w']/len(W)),lbl,ss))
add("Gold & rsi<35",G)
add("RANGE_TRADE_LONG & SQUEEZE",lambda t:t['setup']=='RANGE_TRADE_LONG' and t['regime']=='SQUEEZE')
add("rsi30-50 (dead zone)",lambda t:30<=t['rsi']<50)
add("SQZ_BREAKOUT SELL",lambda t:t['setup']=='SQUEEZE_BREAKOUT' and t['dir']=='SELL')
add("dir=SELL",lambda t:t['dir']=='SELL')
add("asset=SPX",lambda t:t['asset']=='SPX')
add("adx<20",lambda t:t['adx']<20)
add("regime=SQUEEZE",lambda t:t['regime']=='SQUEEZE')
for lift,lbl,ss in sorted(rows,reverse=True):
    print(f"  {lbl:30} lift={lift:4.2f} n={ss['n']:4} wr={ss['wr']:5.1f}% R={ss['R']:+8.2f}")
print("\nFILTER: reject any Gold signal with RSI < 35")
b=summ(T); a=summ([t for t in T if not G(t)])
print(f"  before: n={b['n']} wr={b['wr']:.1f}% pf={b['pf']:.2f} totalR={b['R']:+.2f} expR={b['rpt']:+.3f}")
print(f"  after : n={a['n']} wr={a['wr']:.1f}% pf={a['pf']:.2f} totalR={a['R']:+.2f} expR={a['rpt']:+.3f}")
print(f"  delta : {a['R']-b['R']:+.2f}R ({100*(a['R']-b['R'])/b['R']:+.1f}%), signals cost {b['n']-a['n']} ({100*(b['n']-a['n'])/b['n']:.1f}%)")
g=summ([t for t in T if t['asset']=='Gold']); ga=summ([t for t in T if t['asset']=='Gold' and not G(t)])
print(f"  Gold book: {g['R']:+.2f}R expR {g['rpt']:+.3f}  ->  {ga['R']:+.2f}R expR {ga['rpt']:+.3f}")
