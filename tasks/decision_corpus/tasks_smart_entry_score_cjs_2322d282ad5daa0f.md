---
decision_key: 2322d282ad5daa0f
source: tasks/smart_entry_score.cjs:84
status: standing
recorded: 2026-09-02T17:52:40.137Z
---

# STANDING DECISION

NEVER score zero on this population

Governs: `const PROFILES = {`

## The reasoning as recorded

--profile proposed : the weights exactly as specified. Kept so the comparison is
                     reproducible and so nobody has to take "it did not separate" on
                     trust -- run it and see the A+ bucket come out below no-trade.
--profile measured : re-weighted onto the components that showed a POSITIVE measured
                     lift on this population, in proportion to that lift.

The proposed weights failed for a specific and fixable reason, not because the idea is
wrong. Measured 2026-09-02 over 790 entries:

  emaAlignment    full +0.0087  zero -0.0948   lift +0.1035
  htfBias         full +0.0999  zero +0.0017   lift +0.0981
  marketStructure full +0.0558  zero +0.0434   lift +0.0124
  session         full +0.0789  zero +0.0866   lift -0.0078   <- costs points
  liquidity, crtStructure, displacement, fvgQuality, volatility
                  NEVER score zero on this population

That last line is the whole failure. Those five are conditions of the entry model
itself -- every trade here already IS a CRT sweep with an FVG retest -- so they add 55
near-constant points and drown the two components that actually discriminate. A score
where 55% of the points are the same for every candidate cannot rank candidates.

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
