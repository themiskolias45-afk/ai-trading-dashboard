Need to run and review the 5-year backtest properly. The backtest module exists in server/index.js but I haven't sat down and analyzed the results. Key things to check:
- Win rate per asset over 5 years
- Max drawdown — is it acceptable?
- Equity curve shape — steady growth or wild swings?
- Best performing asset: BTC, Gold, or SPY?
- Does the strategy perform differently in trending vs ranging markets?
- Profit factor target: above 1.5 is good, above 2.0 is excellent
The backtest uses historical Yahoo Finance data and simulates signal generation + trade execution. Claude Opus also gives a verdict on the results.
