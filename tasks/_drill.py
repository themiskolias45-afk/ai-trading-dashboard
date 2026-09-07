import json,collections,datetime,sys
COST=0.05
d=json.load(open('tasks/analysis/facts-20260731-2303.json'))
def band(v,e):
    for u,l in e:
        if v<u: return l
    return e[-1][1]
ADX=[(20,'adx<20'),(30,'adx20-30'),(float('inf'),'adx>=30')]
RSI=[(35,'rsi<35'),(50,'rsi35-50'),(65,'rsi50-65'),(float('inf'),'rsi>=65')]
VOL=[(0.8,'vol<0.8x'),(1.5,'vol0.8-1.5x'),(float('inf'),'vol>=1.5x')]
T=[]
for x in d['trades']:
    if x['outcome']=='EXPIRED': continue
    y=dict(x); y['adxBand']=band(x['adx'],ADX); y['rsiBand']=band(x['rsi'],RSI)
    y['volBand']=band(x['volRatio'],VOL); y['year']=datetime.datetime.utcfromtimestamp(x['t']).year
    T.append(y)
def summ(ts):
    w=[t for t in ts if t['outcome']=='WIN']; l=[t for t in ts if t['outcome']=='LOSS']
    n=len(w)+len(l)
    if n==0: return None
    gw=sum(t['rr']-COST for t in w); gl=len(l)*(1+COST)
    return dict(n=n,wr=100*len(w)/n,pf=(gw/gl if gl else 99),R=gw-gl,rpt=(gw-gl)/n,avgWinRR=(sum(t['rr'] for t in w)/len(w) if w else 0))
def show(title,sub,axes=('setup','dir','asset','year','timeframe','regime','strength')):
    s=summ(sub); print(f"\n### {title}: n={s['n']} wr={s['wr']:.1f}% pf={s['pf']:.2f} R={s['R']:+.2f} rpt={s['rpt']:+.3f} avgWinRR={s['avgWinRR']:.2f}")
    for a in axes:
        parts=[]
        g=collections.defaultdict(list)
        for t in sub: g[t[a]].append(t)
        for k in sorted(g,key=str):
            ss=summ(g[k])
            if ss: parts.append(f"{k}:n={ss['n']},R={ss['R']:+.1f},rpt={ss['rpt']:+.2f}")
        print(f"  {a:10} " + " | ".join(parts))
F=lambda fn:[t for t in T if fn(t)]
show("rsi<35 & vol>=1.5x", F(lambda t:t['rsiBand']=='rsi<35' and t['volBand']=='vol>=1.5x'))
show("rsi<35 (all vol)", F(lambda t:t['rsiBand']=='rsi<35'))
show("Gold & rsi<35", F(lambda t:t['asset']=='Gold' and t['rsiBand']=='rsi<35'))
show("SELL & vol>=1.5x", F(lambda t:t['dir']=='SELL' and t['volBand']=='vol>=1.5x'))
show("SQUEEZE_BREAKOUT & SELL", F(lambda t:t['setup']=='SQUEEZE_BREAKOUT' and t['dir']=='SELL'))
show("RANGE_TRADE_LONG & SQUEEZE", F(lambda t:t['setup']=='RANGE_TRADE_LONG' and t['regime']=='SQUEEZE'))
