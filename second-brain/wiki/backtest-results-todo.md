# Backtest Results — Analysis TODO

tags: backtest, performance, win-rate, drawdown, validation

## Summary

- The 5-year backtest module exists in `server/index.js` but the results have not been formally reviewed; Claude Opus gives a verdict on results.
- Key metrics to extract: win rate per asset, max drawdown, equity curve shape, and profit factor (target: above 1.5, excellent above 2.0).
- Performance in trending vs ranging markets needs separate analysis to understand strategy fit.

## Full Notes

**Backtest Setup**
- Location: `server/index.js` (backtest module)
- Data source: historical Yahoo Finance candles
- Simulates signal generation + trade execution
- Claude Opus provides a verdict on the backtest output

**Analysis Checklist**
- [ ] Win rate per asset (BTC, Gold, SPY) over 5 years
- [ ] Max drawdown — is it within acceptable risk parameters?
- [ ] Equity curve shape — steady growth or high variance swings?
- [ ] Best performing asset: rank BTC vs Gold vs SPY
- [ ] Trending vs ranging market performance split
- [ ] Profit factor: target ≥1.5, excellent ≥2.0

**Why This Matters**
- Without reviewing backtest data, the 65% confidence threshold and 1% risk rule are untested assumptions on live capital
- Drawdown data should inform whether the current circuit breakers are set correctly

## Related

- [risk-management-rules.md](risk-management-rules.md) — drawdown tolerance and circuit breakers that backtest data should validate
- [signal-accuracy-tracking.md](signal-accuracy-tracking.md) — live signal data that will complement backtest findings
- [assets-being-traded.md](assets-being-traded.md) — per-asset context for interpreting results
- [smartentry-architecture.md](smartentry-architecture.md) — system running the backtest module
