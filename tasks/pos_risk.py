# Money at risk per open position, derived from that position's OWN P/L.
# Lot count is NOT risk on this fleet: SP500 trades 5x the lots of BTCUSD at a
# fraction of the exposure, and reporting lots as risk gets the ranking backwards.
import json, urllib.request, http.cookiejar, os, sys
ROOT = sys.argv[1] if len(sys.argv) > 1 else "."
cj = http.cookiejar.MozillaCookieJar()
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
def post(u, d):
    r = urllib.request.Request(u, json.dumps(d).encode(), {"Content-Type": "application/json"})
    return json.loads(op.open(r, timeout=15).read())
def get(u): return json.loads(op.open(u, timeout=20).read())

env = {}
for line in open(os.path.join(ROOT, "keys.env"), encoding="utf-8", errors="replace"):
    if "=" in line and not line.strip().startswith("#"):
        k, v = line.strip().split("=", 1); env[k.strip()] = v.strip()
post("http://localhost:3001/api/login",
     {"username": env.get("DASHBOARD_USERNAME",""), "password": env.get("DASHBOARD_PASSWORD","")})

raw = get("http://localhost:3001/api/mt5/candles/raw")
broker = {}
for v in (raw.get("assets") or {}).values():
    bars = v.get("bars") or {}
    c = bars.get("m15") or bars.get("h1") or {}
    if c.get("closes"): broker[v["symbol"]] = c["closes"][-1]

pos = get("http://localhost:3001/api/mt5/positions?account=A")["positions"]
tot_r = tot_w = tot_pl = 0.0
risks = []
print(f"positions: {len(pos)}")
for p in pos:
    cur = broker.get(p["symbol"])
    if cur is None or abs(cur - p["price"]) < 1e-9:
        print(f"  {p['symbol']:7} cannot derive $/pt (no broker price or zero move)"); continue
    mpp  = p["profit"] / (cur - p["price"])
    risk = abs(p["price"] - p["sl"]) * mpp
    rew  = abs(p["tp"]   - p["price"]) * mpp
    tosl = abs(cur - p["sl"])
    tot_r += risk; tot_w += rew; tot_pl += p["profit"]; risks.append(risk)
    print(f"  {p['symbol']:7} vol={p['volume']:<5} $/pt={mpp:8.4f}  RISK=${risk:8.2f}  REWARD=${rew:8.2f}  "
          f"P/L=${p['profit']:8.2f}  to SL {tosl:9.2f} ({100*tosl/cur:5.2f}%)  RR={rew/risk:.2f}")
print(f"  TOTAL  risk ${tot_r:.2f}  reward ${tot_w:.2f}  open P/L ${tot_pl:.2f}")

# Is risk-based sizing actually working? riskPercent exists so every position risks
# the SAME cash. Under fixedLotSize this spread 1.46 -> 449.72 (308x), and that alone
# turned +4.44R into a -722 loss. Check the OUTCOME, never just the config.
try:
    st = get("http://localhost:3001/api/strategy-settings")
    rp, fx = st.get("riskPercent"), st.get("fixedLotSize")
    print()
    print(f"  SIZING MODE: riskPercent={rp}  fixedLotSize={fx}"
          + ("   (0 = size from risk)" if not fx else "   (FIXED LOTS - risk will NOT be constant)"))
    if risks:
        lo, hi = min(risks), max(risks)
        spread = (hi / lo) if lo > 0 else float("inf")
        print(f"  per-trade risk: low ${lo:.2f}  high ${hi:.2f}  SPREAD {spread:.1f}x")
        if fx:
            print("  -> fixed lots are on, so a wide spread is EXPECTED, not a fault.")
        elif spread <= 1.5:
            print("  -> CONSISTENT. Risk-based sizing is doing its job.")
        else:
            print(f"  -> STILL UNEVEN at {spread:.1f}x. Positions opened BEFORE the switch keep")
            print(f"     their old size forever - judge this on NEW fills only. Otherwise check")
            print(f"     maxLotSize clamping and the broker volume_min floor.")
except Exception as exc:
    print(f"  (sizing-mode check unavailable: {exc})")
