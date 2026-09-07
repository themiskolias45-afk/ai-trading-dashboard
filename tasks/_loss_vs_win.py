import json, itertools, collections
COST=0.05
d=json.load(open('tasks/analysis/facts-20260731-2303.json'))
def band(v,edges):
    if v is None: return None
    for u,l in edges:
        if v<u: return l
    return edges[-1][1]
ADX=[(20,'adx<20'),(30,'adx20-30'),(float('inf'),'adx>=30')]
RSI=[(35,'rsi<35'),(50,'rsi35-50'),(65,'rsi50-65'),(float('inf'),'rsi>=65')]
VOL=[(0.8,'vol<0.8x'),(1.5,'vol0.8-1.5x'),(float('inf'),'vol>=1.5x')]
import datetime
T=[]
for x in d['trades']:
    if x['outcome']=='EXPIRED': continue
    y=dict(x)
    y['adxBand']=band(x['adx'],ADX); y['rsiBand']=band(x['rsi'],RSI); y['volBand']=band(x['volRatio'],VOL)
    y['year']=datetime.datetime.utcfromtimestamp(x['t']).year
    T.append(y)
W=[t for t in T if t['outcome']=='WIN']; L=[t for t in T if t['outcome']=='LOSS']
print(f"closed={len(T)} wins={len(W)} losses={len(L)} baseLossRate={len(L)/len(T):.3f}")
def summ(ts):
    w=[t for t in ts if t['outcome']=='WIN']; l=[t for t in ts if t['outcome']=='LOSS']
    n=len(w)+len(l)
    if n==0: return None
    gw=sum(t['rr']-COST for t in w); gl=len(l)*(1+COST)
    return dict(n=n,w=len(w),l=len(l),wr=100*len(w)/n,pf=(gw/gl if gl else float('inf')),R=gw-gl,rpt=(gw-gl)/n)
FIELDS=['setup','dir','strength','regime','trend','asset','timeframe','adxBand','rsiBand','volBand']
print("\n=== SINGLE AXIS: loss-share vs win-share (lift) ===")
rows=[]
for f in FIELDS:
    for v in sorted({t[f] for t in T}, key=str):
        sub=[t for t in T if t[f]==v]
        s=summ(sub)
        lshare=s['l']/len(L); wshare=s['w']/len(W)
        rows.append((f,v,s,lshare,wshare,lshare/wshare if wshare else 99))
rows.sort(key=lambda r:-r[5])
for f,v,s,ls,ws,lift in rows:
    print(f"{f:10} {str(v):20} n={s['n']:5} wr={s['wr']:5.1f}% pf={s['pf']:5.2f} R={s['R']:8.2f} rpt={s['rpt']:+.3f} | lossShare={ls:.3f} winShare={ws:.3f} lift={lift:5.2f}")

print("\n=== PAIRS / TRIPLES: worst R, closed>=25 ===")
res=[]
for k in (2,3):
    for combo in itertools.combinations(FIELDS,k):
        groups=collections.defaultdict(list)
        for t in T: groups[tuple(t[f] for f in combo)].append(t)
        for key,sub in groups.items():
            s=summ(sub)
            if s and s['n']>=25 and s['R']<0:
                res.append((s['R'],combo,key,s))
res.sort(key=lambda r:r[0])
seen=0
for R,combo,key,s in res[:25]:
    lab=' & '.join(f"{f}={v}" for f,v in zip(combo,key))
    print(f"R={s['R']:8.2f} rpt={s['rpt']:+.3f} n={s['n']:4} wr={s['wr']:5.1f}% pf={s['pf']:4.2f}  {lab}")
