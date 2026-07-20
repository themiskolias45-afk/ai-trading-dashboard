Position size calculator and risk check.

Usage: /risk BTC 105000 103500
Arguments: [symbol] [entry price] [stop price]
$ARGUMENTS contains all three, parse them.

Steps:
1. Fetch http://localhost:3001/api/risk-status — get account balance + open risk
2. Calculate:
   - Stop distance in points and %
   - Lot size for exactly 1% account risk
   - Dollar risk in $
   - R/R if target = 2× stop distance (default) — or use provided target
   - Max drawdown impact (current open risk + this trade)
3. Check: does adding this trade breach the 3-loss circuit breaker?

Output format:
---
RISK CALCULATOR — [SYMBOL]
---
Account: $X | Open risk: X% | Available risk: X%

Entry:  $X
Stop:   $X  (distance: $X = X%)
Target: $X  (1:2 R/R default)

LOT SIZE: X.XX lots
DOLLAR RISK: $X (1.0% of account)
EXPECTED GAIN: $X

CIRCUIT BREAKER: [CLEAR / WARNING — X of 3 losses hit]
VERDICT: [SAFE TO TRADE / REDUCE SIZE / SKIP — circuit breaker active]
---

If arguments are missing, ask: "Usage: /risk [symbol] [entry] [stop]"
