Run a backtest check on SmartEntry Pro. Do this:

1. Fetch http://localhost:3001/api/backtest (GET request — may take 30-60 seconds, be patient)
2. If cached results exist, use them. If not, wait for fresh results.

Report in this format:

BACKTEST RESULTS — [years] YEARS
-----
BTC:  [totalTrades] trades | WR [winRate]% | Return $[finalEquity] ([returnPct]%) | Max DD [maxDrawdown]%
GOLD: [totalTrades] trades | WR [winRate]% | Return $[finalEquity] ([returnPct]%) | Max DD [maxDrawdown]%
SPX:  [totalTrades] trades | WR [winRate]% | Return $[finalEquity] ([returnPct]%) | Max DD [maxDrawdown]%

VERDICT: [pass/fail each asset — need >50% WR and positive return to pass]

WEAKEST ASSET: [which one to fix]
SUGGESTED FIX: [one concrete improvement to the signal engine]

If results show a problem, ask if I want to fix it now.
