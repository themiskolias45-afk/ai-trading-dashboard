Force-execute a trade manually. Usage: /execute BTC LONG 105000 103500 107000
Arguments: [symbol] [direction] [entry] [stop] [target]

This bypasses the confidence gate and sends directly to MT5 bridge.

Steps:
1. Parse $ARGUMENTS: symbol, direction, entry, stop, target
2. Fetch http://localhost:3001/api/risk-status — verify circuit breaker is clear
3. Calculate lot size (1% risk based on entry/stop)
4. POST to http://localhost:3001/api/execute-trade with:
   {
     "symbol": "[symbol]",
     "direction": "[LONG/SHORT]",
     "entry": [entry],
     "stop": [stop],
     "target": [target],
     "lots": [calculated],
     "source": "manual-jarvis",
     "confidence": 100
   }
5. Report result

Before executing, state the trade clearly and confirm:
"Executing: [SYMBOL] [DIRECTION] | Entry $X | Stop $X | Target $X | Risk $X | Lots X.XX"

If circuit breaker is active (3 consecutive losses), refuse and say why.
If stop is more than 3% from entry, warn and ask to confirm.
