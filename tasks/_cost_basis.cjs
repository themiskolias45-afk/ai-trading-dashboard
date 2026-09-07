'use strict';
/**
 * PER-ASSET COST BASIS — cost in R derived from the instrument's spread and the trade's
 * own risk distance, instead of one flat number for three very different instruments.
 *
 * THE PROBLEM IT REPLACES. Every harness in this project hardcodes COST_R = 0.05 and
 * applies it to Gold, Bitcoin and the S&P alike. Cost in R is spread / risk distance, and
 * both halves differ enormously across these three, so one flat number cannot be right
 * for all of them.
 *
 * WHAT WAS MEASURED, 2026-08-22, over the full MTF replay population at the conf-40
 * exposure floor — which is the population the sweeps actually score:
 *
 *   asset    rows   median risk   spread   costR(median)   flat 0.05 is
 *   XAUUSD    265        25.62    $0.22          0.0086    5.8x the spread cost
 *   BTCUSD    387      1278.63   $17.00          0.0133    3.8x
 *   SP500     117        77.10    $0.36          0.0047   10.7x
 *
 * CORRECTED from the first version of this file, which reported 207/138/59 rows and
 * 5.4x/4.7x/11.3x. Those came from runs that used each box's own confidence gate (70)
 * instead of the conf-40 floor, so every population was understated — BTC by 2.8x, the
 * largest error. The conclusion is unchanged in direction and slightly smaller in size.
 * Recorded rather than quietly overwritten: a table that moves without saying so is how
 * a wrong number outlives its correction.
 *
 * THE HEADLINE IS NOT "COSTS ARE TOO HIGH". Read it carefully: the flat number is
 * CONSERVATIVE for all three, so no result in this project is flattered by it. What it
 * distorts is the RELATIVE penalty — SPX is charged 10.7x its spread cost while Gold is
 * charged 5.8x, which quietly biases every cross-asset comparison against the S&P. That
 * is the defect worth fixing, and it is a smaller and less alarming one than "the cost
 * basis is wrong" would suggest.
 *
 * SPREAD IS NOT THE WHOLE COST, AND THIS MODULE DOES NOT PRETEND OTHERWISE. Commission,
 * swap on a held position, and slippage on a stop through a fast market are all real and
 * NONE of them is measured here. The flat 0.05R may well have been chosen to cover them.
 * So: use this to understand the SHAPE of costs across instruments, and keep the flat
 * basis as the default headline until the missing components are measured too. A harness
 * that switches to spread-only costs and reports a better number has not found edge, it
 * has stopped paying for things that still cost money.
 *
 * SPREADS ARE ONE FEED'S TYPICAL VALUES, NOT A TIME SERIES. They come from the measured
 * figures documented at mt5_bridge.py:58 for the VPS's Vantage demo feed — BTCUSD ~1700
 * ticks, XAUUSD 22, SP500 36. Spreads widen at the open, on news and overnight, and none
 * of that is modelled. Override per symbol rather than editing these when a better
 * measurement exists.
 */

// Typical spread per instrument, in PRICE, on the VPS Vantage feed. points x tick size.
// Sourced from mt5_bridge.py:58, which documents the live readings that forced the
// per-symbol MAX_SPREAD_<SYMBOL> override to exist in the first place: a single points
// cap made BTC untradeable because ~$17 reads as ~1700 ticks there.
const SPREAD_PRICE = {
  XAUUSD: 0.22,   //   22 pts x 0.01
  BTCUSD: 17.00,  // 1700 pts x 0.01
  SP500:  0.36,   //   36 pts x 0.01
};

// Aliases, because a row names the symbol as the engine saw it and a Yahoo fallback
// spells the same instrument differently. Matching one spelling silently drops half an
// asset's rows — the same trap the near-miss panel had to handle.
const ALIASES = {
  "GC=F": "XAUUSD", XAUUSD: "XAUUSD", GOLD: "XAUUSD",
  "BTC-USD": "BTCUSD", BTCUSD: "BTCUSD", BTC: "BTCUSD",
  "^GSPC": "SP500", SP500: "SP500", SPX: "SP500",
};

// The house flat basis. Kept as the fallback and as the default everywhere, so a harness
// that does not opt in behaves exactly as it did before this file existed.
const FLAT_COST_R = 0.05;

// A round trip crosses the spread once in the model used here: the entry fills at the
// far side of the quote and the exit is taken at the modelled price. Raise it via the
// multiplier argument to charge entry AND exit if a future measurement supports that —
// do not change this constant to express an opinion.
const SPREAD_CROSSINGS = 1;

function canonicalSymbol(symbol) {
  if (!symbol) return null;
  return ALIASES[String(symbol).toUpperCase()] || ALIASES[String(symbol)] || null;
}

/**
 * Cost in R for one trade.
 *
 * Returns the FLAT basis — not zero, and not a guess — whenever the inputs cannot support
 * a real answer: unknown symbol, missing risk distance, or a non-positive one. Falling
 * back to the flat number keeps an un-costed row conservative; falling back to zero would
 * make a harness look better precisely where it knows least.
 *
 * @param {string} symbol         instrument, in any spelling this project uses
 * @param {number} riskDistance   |entry - stop| in price, from MTF_EMIT_RISK=1
 * @param {number} [multiplier]   spread crossings to charge; defaults to 1
 * @returns {{costR: number, basis: string, symbol: string|null}}
 */
function costFor(symbol, riskDistance, multiplier = SPREAD_CROSSINGS) {
  const canonical = canonicalSymbol(symbol);
  const spread = canonical ? SPREAD_PRICE[canonical] : undefined;
  const risk = Number(riskDistance);

  if (!canonical || !Number.isFinite(spread)) {
    return { costR: FLAT_COST_R, basis: "flat — unknown symbol", symbol: canonical };
  }
  if (!Number.isFinite(risk) || risk <= 0) {
    return { costR: FLAT_COST_R, basis: "flat — no risk distance", symbol: canonical };
  }
  return {
    costR: (spread * multiplier) / risk,
    basis: "spread/risk",
    symbol: canonical,
  };
}

/** What a report should carry so a reader knows which basis produced its numbers. */
function describeBasis(mode) {
  return mode === "perasset"
    ? "PER-ASSET: cost in R = typical spread / this trade's risk distance. Spread is one "
    + "feed's typical value (mt5_bridge.py:58, VPS Vantage). Commission, swap and "
    + "slippage are NOT modelled, so this is a floor on cost, not the whole of it."
    : "FLAT: " + FLAT_COST_R + "R per trade for every instrument. Conservative against "
    + "measured spread cost on all three (5.8x Gold, 3.8x BTC, 10.7x SPX), which is why "
    + "it remains the default headline basis.";
}

module.exports = {
  SPREAD_PRICE, FLAT_COST_R, SPREAD_CROSSINGS,
  canonicalSymbol, costFor, describeBasis,
};
