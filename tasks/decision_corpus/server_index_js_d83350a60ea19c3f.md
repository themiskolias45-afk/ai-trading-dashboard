---
decision_key: d83350a60ea19c3f
source: server/index.js:12027
status: standing
recorded: 2026-09-06T07:20:46.724Z
---

# STANDING DECISION

a trade that was NEVER FILLED - no spread, no slippage, a fixed scoring horizon.

Governs: `let engineSetupNamesCache = null;`

## The reasoning as recorded

── /api/strategy-board — every setup, and every source of truth about it ───

The engine emits eight setup names and the evidence about them lived in four
places that never met: learning.json (real fills), learning_shadow.json (forgone
paper trades), the rejection ledger (which gate killed it), and the evidence
register (what has actually been measured). No page joined them, so the honest
answer to "which of my strategies work" was to open four screens and do it by
hand. This is that join, and nothing more: read-only, session-gated by the
/api/ rule, feedsTheGate false.

The one thing it must never do is blur live and paper together. A shadow row is
a trade that was NEVER FILLED - no spread, no slippage, a fixed scoring horizon.
Folding it into a win rate would make a paper result indistinguishable from
money, which is the same mistake that once filed a real -449.72 fill under a
watch-only setup name. They stay in separate columns, always.
The check KNOWN_SETUPS has claimed to have since 2026-08-25 and never actually had.

A hardcoded list is the RIGHT design for this board: a setup that has never fired must
still get a row, and deriving the list from the data would hide precisely those. But
"hardcoded" was quietly doing a second job — it was also unverified. BUY_DIP and
BREAKOUT went missing once, DIVERGENCE went missing for the board's entire life, and
the comment beside the list asserted a count check that did not exist. An assertion
with no code behind it is the same failure as a setting with no reader.

So: the list stays hand-written, and this compares it against the engine. Reads THIS
file and collects every `setup = "NAME";` assignment. Two filters keep it honest —
comment lines are skipped and the assignment must be semicolon-terminated — because
the KNOWN_SETUPS comment itself contains the literal `setup  = "NAME"` and a naive
regex would have invented a setup called NAME out of the prose describing the check.

Cached after the first call: the source cannot change under a running process, and
re-reading a 9,000-line file per request would be real cost for an answer that
cannot move.

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
