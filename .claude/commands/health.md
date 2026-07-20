Run a full system health check on SmartEntry Pro. Do all of these:

1. Bash: curl -s http://localhost:3001/api/risk-status
2. Bash: curl -s http://localhost:3001/api/mode
3. Bash: curl -s http://localhost:3001/api/signals | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); const j=JSON.parse(d); console.log('BTC:',j.btc?.signal,'GOLD:',j.gold?.signal,'SPX:',j.spx?.signal)"
4. Bash: cd server && node --check index.js 2>&1 | head -5
5. Bash: netstat -ano | findstr :3001 | head -3

Report:
- Server: RUNNING or OFFLINE (port 3001)
- Signals: BTC/GOLD/SPX current signal
- Mode: auto or semi-auto
- Regime: current market regime
- Any errors found

One line per check. Flag anything that looks wrong.
