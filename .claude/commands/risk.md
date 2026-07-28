Position size calculator and risk check.

Usage: /risk BTC 105000 103500
Arguments: [symbol] [entry price] [stop price]
Parse all three from $ARGUMENTS.

STEP 1 — Get account state:
  mcp__smartentry__get_risk_status          → account balance, open risk %, consecutive losses

STEP 2 — Calculate position:
  mcp__smartentry__size_position symbol=[SYMBOL] entry=[ENTRY] stop=[STOP] risk_pct=1.0

  Also calculate manually to verify:
  - Stop distance = |entry − stop| in points and %
  - Dollar risk   = balance × 0.01 (1% rule)
  - Lot size      = dollar_risk / stop_distance_in_dollars
  - Target        = entry + (2 × stop_distance) for 1:2 R:R default

STEP 3 — Circuit breaker check:
  If consecutive losses ≥ 3 → HALT (do not trade regardless of lot size)
  If open risk + new trade risk > 3% → REDUCE SIZE

Output:
---
RISK CALCULATOR — [SYMBOL]
---
Account: $X | Open risk: X% | Available risk: X%

Entry:  $X
Stop:   $X  (distance: $X = X%)
Target: $X  (1:2 R:R)

LOT SIZE: X.XX lots
DOLLAR RISK: $X (1.0% of account)
EXPECTED GAIN: $X

CIRCUIT BREAKER: [CLEAR / WARNING — X of 3 losses]
VERDICT: [SAFE TO TRADE / REDUCE SIZE / SKIP — circuit breaker active]
---

If arguments are missing: "Usage: /risk [symbol] [entry] [stop]"
