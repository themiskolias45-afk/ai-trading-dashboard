# Assets Being Traded

tags: assets, btc, gold, spy, macro-context, data-feeds

## Summary

- Three assets monitored: BTC/USD (CoinGecko, 24/7), Gold/XAUUSD (Yahoo Finance), and SPY/S&P500 (Yahoo Finance, market hours only).
- Macro context includes DXY (strong dollar bearish for Gold and BTC) and VIX (above 20 = caution, above 30 = no longs).
- EUR/USD and crude oil (WTI) are under consideration but deferred until the current three are mastered.

## Full Notes

**Active Assets**

| Asset | Feed | Hours | Notes |
|---|---|---|---|
| BTC/USD | CoinGecko | 24/7 | Highest volatility |
| Gold/XAUUSD | Yahoo Finance | Market hours | Driven by DXY and geopolitics |
| SPY/S&P500 | Yahoo Finance | Market hours only | Equity market proxy |

**Macro Overlays**
- DXY (US Dollar Index): strong dollar = bearish pressure on Gold and BTC
- VIX (Fear Index): above 20 = caution mode; above 30 = no longs allowed

**Expansion Roadmap**
- EUR/USD: under consideration
- Crude oil (WTI): under consideration
- Decision: focus on mastering the current three before adding assets

## Related

- [smartentry-architecture.md](smartentry-architecture.md) — data feed implementation details
- [risk-management-rules.md](risk-management-rules.md) — VIX thresholds that gate trading
- [backtest-results-todo.md](backtest-results-todo.md) — per-asset performance needs analysis
- [signal-accuracy-tracking.md](signal-accuracy-tracking.md) — per-asset win rate tracking needed
