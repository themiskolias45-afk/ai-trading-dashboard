# Risk Management Rules

tags: risk, position-sizing, circuit-breaker, drawdown, mt5

## Summary

- Max risk is 1% per trade ($900 on a $90k account) with a 3% daily loss circuit breaker ($2,700) that halts all trading.
- Three consecutive losses or VIX above 30 also triggers a halt; partial profit-taking activates at 1R and trailing stop at 2R.
- Leverage is 1:500 on the MT5 account; news blackout periods prohibit trading.

## Full Notes

**Position Sizing**
- Risk per trade: 1% of account = $900 max loss ($90,000 account)
- Leverage: 1:500 on MT5

**Circuit Breakers**
- Daily loss limit: 3% ($2,700) — halts all trading for the session
- 3 consecutive losses — triggers halt regardless of daily P&L

**Trade Management**
- Partial close: 50% of position at 1R profit
- Trailing stop: activates at 2R profit

**Macro Filters**
- VIX > 30: no longs
- No trading during news blackout periods

## Related

- [signal-accuracy-tracking.md](signal-accuracy-tracking.md) — validating whether the 65% confidence threshold is correctly calibrated
- [backtest-results-todo.md](backtest-results-todo.md) — max drawdown and win rate data needed to validate these rules
- [assets-being-traded.md](assets-being-traded.md) — VIX and DXY macro context used in filters
- [smartentry-architecture.md](smartentry-architecture.md) — system that enforces these rules
