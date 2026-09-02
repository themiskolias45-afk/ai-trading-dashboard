/**
 * THE ASSET REGISTRY — one place to add an instrument.
 *
 * Until 2026-09-02 the tradeable universe was written out by hand in four places in
 * server/index.js (:757 ASSET_KEY_BY_TICKER, :4051 refreshSignals, :4305
 * ASSET_BROKER_SYMBOLS, :8681 the backtest) plus a fifth in mt5_bridge.py. Adding an
 * instrument meant finding all five and getting every one right; missing one does not
 * fail loudly, it produces an asset that generates signals and cannot be held, or one
 * the bridge pushes bars for that the engine never scores.
 *
 * WHY THIS IS THE BINDING CONSTRAINT, not a tidiness exercise. The system produced 10
 * fills in 34 days across three symbols. getLearningBoost (index.js:1116) needs
 * LEARNING_MIN_TRADES = 5 closed trades in a single setup bucket before it returns
 * anything but zero, and the largest bucket today holds 4. So the self-learning has
 * never once moved a signal — not because it is broken, but because three instruments
 * cannot feed it. Every other lever tried on the flow problem has been measured and
 * made R worse: dropping macd.bullish on MOMENTUM (XAUUSD 5/5 +0.051 -> 4/5 -0.357,
 * reverted within the hour on 2026-09-01) and unblocking SELL_BOUNCE (XAUUSD 5/5
 * +0.086 / 308 trades -> 4/5 -0.087 / 287 trades). More instruments is the only lever
 * that raises sample size WITHOUT lowering the bar on any individual trade.
 *
 * THIS COMMIT ADDS NO INSTRUMENT. The list below is byte-for-byte the three that were
 * already hardcoded, in the same order, with the same labels and the same broker
 * aliases, so /api/signals is unchanged and no setup is admitted or suppressed. It
 * converts "hardcoded in five places" into "one file", which is the prerequisite for
 * the actual expansion, not the expansion itself.
 *
 * BEFORE ADDING ONE, read tasks/analysis or dashboard/instrument-scan.json and the
 * `instrumentscan` claim on the evidence board. 577 instruments were screened on
 * 2026-08-30 — but that screen is YAHOO DAILY, and 948f21e established that Yahoo
 * intraday cannot validate an instrument for this engine: MAX_HOLD is 40 H4 BARS, and
 * a broker 24h CFD yields 6 H4 bars a day against ~1.6 from a resampled 6.5h cash
 * session, so Yahoo hands every trade 3.7x longer to reach target (EXPIRED share 16.3%
 * vs 54.5%). A candidate is a candidate only after a walk-forward ON BROKER BARS.
 */

'use strict';

const ASSETS = [
  {
    key: "btc",
    label: "Bitcoin",
    symbol: "BTC-USD",
    // Accepted broker symbols. The BRIDGE is the authority (mt5_bridge.py:124); this
    // list is a reader, and it stays a superset of the bridge's own aliases plus the
    // Yahoo ticker. Getting it wrong makes a MESSAGE wrong, never a trade — the real
    // DUPLICATE gate lives in the bridge.
    brokerSymbols: ["BTCUSD", "BTC/USD", "BITCOIN", "BTCUSDT", "BTC-USD"],
  },
  {
    key: "gold",
    label: "Gold/XAUUSD",
    symbol: "GC=F",
    brokerSymbols: ["XAUUSD", "GOLD", "XAUUSDM", "GOLDM", "GC=F"],
  },
  {
    key: "spx",
    label: "S&P500",
    symbol: "^GSPC",
    brokerSymbols: ["SP500", "US500", "SPX500", "US.500", "SPY", "^GSPC"],
  },
];

// The shape refreshSignals() and the backtest already consumed, rebuilt rather than
// re-typed. Frozen per element so a caller cannot mutate the registry by accident —
// refreshSignals iterates this on every cycle.
const ASSET_LIST = ASSETS.map(a => Object.freeze({ key: a.key, label: a.label, symbol: a.symbol }));

const ASSET_KEY_BY_TICKER = Object.freeze(
  Object.fromEntries(ASSETS.map(a => [a.symbol, a.key])));

const ASSET_BROKER_SYMBOLS = Object.freeze(
  Object.fromEntries(ASSETS.map(a => [a.key, a.brokerSymbols])));

const ASSET_KEYS = Object.freeze(ASSETS.map(a => a.key));

module.exports = {
  ASSETS,
  ASSET_LIST: Object.freeze(ASSET_LIST),
  ASSET_KEY_BY_TICKER,
  ASSET_BROKER_SYMBOLS,
  ASSET_KEYS,
};
