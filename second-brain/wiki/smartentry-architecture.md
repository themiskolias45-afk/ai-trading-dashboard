# SmartEntry Pro System Architecture

tags: architecture, mt5, claude-opus, signal-engine, infrastructure

## Summary

- Node.js + Express backend on port 3001 with Python mt5_bridge.py handling MT5 order execution via the MetaTrader5 Python package.
- Signals require ≥65% confidence across three timeframes (Daily + 4H + 1H) before Claude Opus approves a trade.
- Market data is sourced from Yahoo Finance v8 (Gold/SPY/DXY/VIX) and CoinGecko (BTC live price), with multi-timeframe refresh using parallel Promise.all.

## Full Notes

**Stack**
- Runtime: Node.js + Express, port 3001
- AI layer: Claude Opus (`claude-opus-4-8`) — approves every trade
- MT5 bridge: `python mt5_bridge.py` — connects to MetaTrader 5 via the MetaTrader5 Python package
- MT5 bridge modes: `--auto` for full-auto, no flag for semi-auto

**Data Feeds**
- Yahoo Finance v8 API: Gold (XAUUSD), SPY, DXY, VIX candles
- CoinGecko: BTC live price

**Signal Engine**
- Confidence threshold: ≥65% required across Daily + 4H + 1H timeframes
- Multi-timeframe refresh: parallel `Promise.all` calls
- MT5 bridge: `ThreadPoolExecutor` for parallel BTC + Gold processing

**Execution**
- Orders sent via `mt5.order_send()`
- `MAGIC_NUMBER=20250101` tags all SmartEntry trades for identification

## Related

- [mt5-bridge-stability.md](mt5-bridge-stability.md) — bridge reliability, reconnection gaps
- [assets-being-traded.md](assets-being-traded.md) — data feed details per asset
- [signal-accuracy-tracking.md](signal-accuracy-tracking.md) — signal engine accuracy logging
- [risk-management-rules.md](risk-management-rules.md) — thresholds that gate signal execution
