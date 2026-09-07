#!/usr/bin/env python
"""
would_a_short_have_fired.py -- ask the engine's OWN short branches whether any of them
would have formed, over a window of real broker bars. Read-only; touches nothing live.

    python tasks/would_a_short_have_fired.py [btc|gold|spx] [lookback_bars]

WHY THIS EXISTS. On 2026-08-28 Gold fell 4631 -> 4544 inside ONE H1 bar and the system
produced no short, no rejection row and no near-miss -- and /api/signals still returned
BUY MOMENTUM confidence 74, unchanged. "Why did it not short that" is otherwise answered
by reading if-conditions and guessing. This answers it with a COUNT.

It MIRRORS calcRSI (Wilder), calcBB, calcMACD, emaSeries and the trend ladder at
server/index.js:1354. It is a mirror, NOT the engine: if a branch condition in index.js
changes, change it here too or this tool starts lying. It reads the live bar cache from
/api/mt5/candles/raw, so it measures the same bars the engine measured.
"""
import sys, json, datetime, math, urllib.request

ASSET    = (sys.argv[1] if len(sys.argv) > 1 else 'gold').lower()
LOOKBACK = int(sys.argv[2]) if len(sys.argv) > 2 else 60
SERVER   = 'http://localhost:3001'

try:
    with urllib.request.urlopen(SERVER + '/api/mt5/candles/raw', timeout=20) as resp:
        d = json.load(resp)
except Exception as err:
    sys.exit('cannot read %s/api/mt5/candles/raw -- is the server up? (%s)' % (SERVER, err))

if ASSET not in d.get('assets', {}):
    sys.exit('no such asset %r; have: %s' % (ASSET, ', '.join(d.get('assets', {}))))
g = d['assets'][ASSET]['bars']

# server/index.js EMA_SMA_SEED_MIN_MULTIPLE. Named, not a literal 3: a drift here
# silently changes every EMA and therefore every trend verdict this tool prints.
EMA_SMA_SEED_MIN_MULTIPLE = 3

def ema_series(c, p):
    k = 2/(p+1)
    if len(c) < p*EMA_SMA_SEED_MIN_MULTIPLE:
        out=[c[0]]
        for i in range(1,len(c)): out.append(c[i]*k + out[-1]*(1-k))
        return out
    seed=sum(c[:p])/p
    out=[seed]*p
    for i in range(p,len(c)): out.append(c[i]*k + out[-1]*(1-k))
    return out

def rsi(c, p=14):
    if len(c) < p+1: return None
    ag=al=0.0
    for i in range(1,p+1):
        dd=c[i]-c[i-1]
        if dd>0: ag+=dd
        else: al-=dd
    ag/=p; al/=p
    for i in range(p+1,len(c)):
        dd=c[i]-c[i-1]
        ag=(ag*(p-1)+max(dd,0))/p
        al=(al*(p-1)+max(-dd,0))/p
    if al==0: return 100.0
    return round(100-100/(1+ag/al),1)

def bb(c,p=20,m=2):
    if len(c)<p: return None
    s=c[-p:]; mean=sum(s)/p
    std=math.sqrt(sum((v-mean)**2 for v in s)/p)
    return dict(upper=round(mean+m*std,2), middle=round(mean,2),
                lower=round(mean-m*std,2), bandwidth=round((m*2*std)/mean*100,1))

def macd(c):
    if len(c)<35: return None
    e12=ema_series(c,12); e26=ema_series(c,26)
    ml=[a-b for a,b in zip(e12,e26)]; sl=ema_series(ml,9)
    return dict(macd=round(ml[-1],2), signal=round(sl[-1],2),
                hist=round(ml[-1]-sl[-1],2), bullish=ml[-1]>sl[-1])

def atr(h,l,c,p=14):
    trs=[]
    for i in range(1,len(c)):
        trs.append(max(h[i]-l[i], abs(h[i]-c[i-1]), abs(l[i]-c[i-1])))
    if len(trs)<p: return None
    a=sum(trs[:p])/p
    for i in range(p,len(trs)): a=(a*(p-1)+trs[i])/p
    return a

def state(h,l,c):
    price=c[-1]
    e20=ema_series(c,20)[-1]; e50=ema_series(c,50)[-1]
    e200=ema_series(c,200)[-1] if len(c)>=200 else None
    a20=price>e20; a50=price>e50; a200=(price>e200) if e200 is not None else None
    if   a200 is True  and a50 and a20:            trend="STRONG UPTREND"
    elif a200 is True  and a50:                    trend="UPTREND"
    elif a200 is False and not a50 and not a20:    trend="STRONG DOWNTREND"
    elif a200 is False and not a50:                trend="DOWNTREND"
    else:                                          trend="MIXED"
    return dict(price=price, ema20=e20, ema50=e50, ema200=e200, a20=a20, a50=a50,
                trend=trend, up=trend in("STRONG UPTREND","UPTREND"),
                dn=trend in("STRONG DOWNTREND","DOWNTREND"),
                rsi=rsi(c), bb=bb(c), macd=macd(c), atr=atr(h,l,c))

def short_branches(s):
    """Every SELL branch the live engine has, in chain order. Returns list of (name, matched, failed-conditions)."""
    out=[]
    price,r,b,m = s['price'], s['rsi'], s['bb'], s['macd']
    # SELL_BOUNCE
    f=[]
    if not (s['dn'] or (s['trend']=="MIXED" and not s['a50'])): f.append("needs DOWNTREND (or MIXED & below EMA50); trend is %s"%s['trend'])
    if not s['a20']: f.append("needs price ABOVE EMA20")
    if not (price <= s['ema20']*1.022): f.append("needs price within 2.2%% of EMA20; it is %.2f%% above"%((price/s['ema20']-1)*100))
    if not (r is not None and r>50): f.append("needs RSI>50; RSI %s"%r)
    if not (m and not m['bullish']): f.append("needs MACD NOT bullish; it is bullish (hist %+.2f)"%m['hist'])
    out.append(("SELL_BOUNCE", not f, f))
    # RANGE_TRADE_SHORT
    f=[]
    if not (b and price >= b['upper']*0.992): f.append("needs price at BB upper %.2f; price %.2f (%.2f%% below)"%(b['upper'],price,(1-price/b['upper'])*100))
    if not (r is not None and r>58): f.append("needs RSI>58; RSI %s"%r)
    if s['up']: f.append("blocked: inUptrend (%s)"%s['trend'])
    out.append(("RANGE_TRADE_SHORT", not f, f))
    # BREAKDOWN (mirror of MOMENTUM) — OFF by config on both boxes
    MOM_MAX, MOM_MIN = 88, 50
    BD_MIN, BD_MAX = 100-MOM_MAX, 100-MOM_MIN     # 12 .. 50
    f=["DISABLED: breakdownEnabled absent from strategy_settings.json"]
    if not s['dn']: f.append("would also need DOWNTREND; trend is %s"%s['trend'])
    if not (r is not None and BD_MIN < r < BD_MAX): f.append("would also need RSI in (%d,%d); RSI %s"%(BD_MIN,BD_MAX,r))
    if not (m and not m['bullish']): f.append("would also need MACD bearish")
    out.append(("BREAKDOWN", False, f))
    return out

for tf in ('h1','h4','d1'):
    s_ = g[tf]
    h,l,c,t = s_['highs'], s_['lows'], s_['closes'], s_.get('times')
    st = state(h,l,c)
    when = datetime.datetime.fromtimestamp(t[-1], datetime.UTC).strftime('%m-%d %H:%M') if t else '?'
    print("="*78)
    print("%s %s  last bar(broker) %s   close %.2f  trend %s  RSI %s  ATR %.2f"%(
        ASSET.upper(), tf.upper(), when, st['price'], st['trend'], st['rsi'], st['atr']))
    print("   EMA20 %.2f  EMA50 %.2f  EMA200 %s  BBupper %.2f  MACD %s"%(
        st['ema20'], st['ema50'], ("%.2f"%st['ema200']) if st['ema200'] else "n/a",
        st['bb']['upper'], "bullish" if st['macd']['bullish'] else "bearish"))
    for name, ok, fails in short_branches(st):
        print("   %-19s %s" % (name, "*** WOULD FIRE ***" if ok else "no"))
        for x in fails: print("        - "+x)

print("\n" + "="*78)
print("BACKTRACE: every SELL branch, at the close of each of the last %d %s H1 bars"
      % (LOOKBACK, ASSET.upper()))
print("="*78)
s_ = g['h1']; H,L,C,T = s_['highs'], s_['lows'], s_['closes'], s_['times']
hits = 0
# Never start before bar 200: EMA200 is undefined earlier, and a null EMA200 forces
# the trend ladder to MIXED, which would invent shorts the engine never saw.
first = max(200, len(C)-LOOKBACK)
for i in range(first, len(C)):
    st = state(H[:i+1], L[:i+1], C[:i+1])
    when = datetime.datetime.fromtimestamp(T[i], datetime.UTC).strftime('%m-%d %H:%M')
    for name, ok, fails in short_branches(st):
        if ok:
            hits += 1
            print("  %s  %-19s FIRES  close %.2f  RSI %s  trend %s" % (when, name, st['price'], st['rsi'], st['trend']))
print("  -> %d SELL setups formed on %s H1 over %d bars." % (hits, ASSET.upper(), len(C)-first))
