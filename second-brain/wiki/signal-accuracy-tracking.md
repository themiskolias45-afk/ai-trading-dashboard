# Signal Accuracy Tracking

tags: signal-quality, analytics, win-rate, confidence-threshold, logging

## Summary

- Currently only executed trades are logged; every signal that fires (including non-executed ones) needs its own accuracy log.
- Tracking fields needed: confidence score, asset, direction, timeframe alignment, outcome (target hit / stop hit / expired), and AI-approved vs non-approved comparison.
- This data is required to tune the 65% confidence threshold and identify which setups actually generate edge.

## Full Notes

**Current Gap**
- Trade journal exists for executed trades only
- Signals that fire but don't execute are not logged
- No way to compare signal quality vs execution quality without this data

**Proposed Signal Log Fields**
- Confidence score at signal time
- Asset and direction
- Timeframe alignment (which of Daily / 4H / 1H contributed)
- Outcome: target reached / stop hit / expired without fill
- AI-approved vs not approved — compare outcomes between the two groups
- False positive tracking: high-confidence signals that still lost

**Analysis Goals**
- Per-asset win rate breakdown
- Threshold calibration: determine if 65% is the right cutoff or should be raised/lowered
- Identify which setup types (timeframe combinations, asset, direction) actually work

## Related

- [smartentry-architecture.md](smartentry-architecture.md) — signal engine that would generate these logs
- [risk-management-rules.md](risk-management-rules.md) — confidence threshold and circuit breakers this data should validate
- [backtest-results-todo.md](backtest-results-todo.md) — historical performance data that complements live signal tracking
- [assets-being-traded.md](assets-being-traded.md) — per-asset breakdown context
