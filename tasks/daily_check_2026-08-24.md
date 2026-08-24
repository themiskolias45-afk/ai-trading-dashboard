# DAILY-2026-08-24 — action items from /daily

Created by the /daily cycle. TaskCreate was not available in that session, so the
HIGH items are recorded here instead. Nothing below has been implemented.

## [HIGH] tv_daily_plan.py sends no auth, so the daily plan has had no prices for 21+ days

WHAT: `/api/daily-plan` is session-gated and returns `{"error":"Not logged in."}`.
`_fetch` (tv_daily_plan.py:31-37) catches nothing useful — it returns that dict, and
`plan_data.get("prices", {})` then yields `{}`. Every asset gets `price=None`,
`_key_levels(None)` returns `{}`, and the script exits 0.

WHY: verified 2026-08-24 — every `tasks/daily_plan_*.json` from 2026-08-03 through
today has `prices: {}` and `levels: {}` for btc, gold and spx. Reproduced live:
`python tv_daily_plan.py --no-tv --silent` printed `BTC: WAIT | price:None` for all
three and exited 0. `/api/signals` IS reachable unauthenticated, so only the
daily-plan leg is affected.

HOW: tv_daily_plan.py `_fetch` — attach the same session/API auth the other callers
use, and make `_fetch` treat a payload containing `error` as a failure rather than
returning it as data. The silent-success behaviour is the actual defect.

IMPACT: restores S/R levels and pivots on the morning plan and the /daily-plan page.
No trading impact — this path has feedsTheGate false and touches no gate.

EFFORT: Simple (<30 min)

## [HIGH] MIN_RR's rejection sample has more than doubled and still reads COSTING MONEY

WHAT: re-run the MIN_RR walk-forward against the grown sample. Do NOT move the gate
on ledger evidence alone.

WHY: 2026-08-24 the ledger reports MIN_RR at 54 resolved episodes, 78% would have
won, +15.33R. On 2026-08-09 the same gate read 22 episodes / +7.14R. The 4-year
sweep says lowering MIN_RR costs 6.6R. That contradiction is now carrying twice the
sample it had when it was last left unresolved. Concentrated in RANGE_TRADE_LONG
(28W/7L) and BUY_OVERSOLD (9W/0L, netR +5.715).

HOW: `run_walkforward` (MCP) or `node tasks/mtf_walkforward.cjs` scoped to minRr.
Compare candidates on BEST WORST FOLD, not on mean — the same standard that kept the
confidence gate at 70.

IMPACT: MIN_RR has killed 3 of the 4 gate decisions since the 03:08 restart. If the
sweep flips, this is the single largest source of forgone setups in the system.

EFFORT: Medium (~90 s per walk-forward run, plus reading)

## [MEDIUM] Exa search key returns 401

Reproduced 2026-08-24T03:15:23Z — `web_search_exa error (401): Invalid API key`.
Known since 2026-08-22. One of the three research legs in /daily and /research
returns nothing. Fix is a key rotation in keys.env.
