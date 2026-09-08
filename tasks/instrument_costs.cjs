'use strict';
/**
 * THE MEASURED SPREAD TABLE - one home, so two harnesses cannot disagree about what a
 * trade costs.
 *
 * WHY THIS FILE EXISTS. The table below lived inside tasks/cost_breakeven.cjs, which
 * cannot be require()d - it runs its whole report at top level. So any second harness
 * wanting real costs had to retype the numbers, and a retyped constant that later drifts
 * is the bug this repo has already paid for more than once. cost_breakeven.cjs now reads
 * the table from here, so there is exactly one copy.
 *
 * THE UNIT IS R, NOT PRICE. costR = spread / |entry - stop|. Both halves differ
 * enormously across instruments: BTC's spread is 17.00 and Gold's is 0.22, while BTC's
 * typical risk distance is 1619 and Gold's is 28.8. Charging a shared PRICE across
 * instruments once inverted the sign of a pooled CRT result, because a Gold trade was
 * billed a BTC-sized spread. Always charge each trade on its own risk distance.
 *
 * WHAT IS NOT MODELLED: commission, swap/overnight financing, and slippage. This is the
 * SPREAD ALONE, so it is a FLOOR on true cost, never an estimate of it. A result whose
 * margin over these numbers is thin is a REJECT, not a pass - the real bill is higher.
 *
 * SPREADS WIDEN. These are one feed's typical values at one moment, on a demo account.
 * They widen at the open, on news, and overnight. Re-measure before leaning on them.
 */

/**
 * Measured from the live terminal 2026-09-02 via symbol_info().spread * point, after
 * selecting each symbol into Market Watch and waiting for a tick -- an unselected symbol
 * reports spread 0, which would read as a free instrument.
 *
 * `price` is the price at which the spread was sampled, kept so a reader can see the
 * spread as a fraction of price without re-deriving it.
 */
const SPREADS = {
  XAUUSD:  { spread: 0.22,    price: 4308.99,  ticker: "GC=F" },
  BTCUSD:  { spread: 17.00,   price: 76649.37, ticker: "BTC-USD" },
  SP500:   { spread: 0.36,    price: 7624.50,  ticker: "^GSPC" },
  ETHUSD:  { spread: 2.47,    price: 2373.35,  ticker: "ETHUSD" },
  XRPUSD:  { spread: 0.0083,  price: 1.3199,   ticker: "XRPUSD" },
  LTCUSD:  { spread: 1.00,    price: 48.34,    ticker: "LTCUSD" },
  XAGUSD:  { spread: 0.021,   price: 63.764,   ticker: "XAGUSD" },
  USOUSD:  { spread: 0.037,   price: 90.51,    ticker: "USOUSD" },
  GBPUSD:  { spread: 0.00015, price: 1.35,     ticker: "GBPUSD" },
  USDJPY:  { spread: 0.019,   price: 159.85,   ticker: "USDJPY" },
  EURUSD:  { spread: 0.00014, price: 1.16,     ticker: "EURUSD" },
  AUDUSD:  { spread: 0.00014, price: 0.71,     ticker: "AUDUSD" },
};

/** When the spreads above were read off the terminal. Printed by every consumer. */
const SPREADS_MEASURED_AT = '2026-09-02 live MT5 symbol_info';

/**
 * Cost of one round trip for `symbol`, expressed in R against THIS trade's own risk.
 *
 * Returns null for an unknown symbol or a non-positive risk distance. Null means
 * "unknown", and a caller must surface that rather than substituting 0 - charging zero
 * for an instrument whose spread was never measured is exactly how a backtest reports a
 * gross number while calling it net.
 *
 * @param {string} symbol        broker symbol, e.g. "XAUUSD"
 * @param {number} riskDistance  |entry - stop| in the instrument's own price units
 * @param {number} [spreadsPerRoundTrip=1]  how many spread widths a round trip pays.
 *        1 is the honest floor for a stop/target exit: the spread is paid crossing in,
 *        and a stop or limit exit is filled on the far side of the book it was resting
 *        on. Pass 2 to charge crossing out as well, which is the right model for a
 *        market-order exit and is the more conservative assumption.
 */
function costR(symbol, riskDistance, spreadsPerRoundTrip) {
  const meta = SPREADS[String(symbol || '').toUpperCase()];
  if (!meta || !Number.isFinite(riskDistance) || !(riskDistance > 0)) return null;
  const widths = Number.isFinite(spreadsPerRoundTrip) && spreadsPerRoundTrip > 0
    ? spreadsPerRoundTrip
    : 1;
  return (meta.spread * widths) / riskDistance;
}

module.exports = { SPREADS, SPREADS_MEASURED_AT, costR };
