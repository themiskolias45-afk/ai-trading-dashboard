---
decision_key: 145541220ab91865
source: server/index.js:1617
status: standing
recorded: 2026-09-06T07:20:46.724Z
---

# STANDING DECISION

BOOLEANS ARE NOT IN STRATEGY_LIMITS AND WERE THEREFORE NEVER LOADED.

Governs: `for (const flag of ["partialCloseEnabled", "breakdownEnabled"]) {`

## The reasoning as recorded

BOOLEANS ARE NOT IN STRATEGY_LIMITS AND WERE THEREFORE NEVER LOADED.

STRATEGY_LIMITS entries are numeric clamps (min/max/def/decimals), so a boolean
cannot live there, and the loop above is the only thing that reads the file. That
left `partialCloseEnabled` in the worst possible state: a default at the top of
this module, a reader in the partial-close path, and a POST handler that sets it
and saves it - so it worked, persisted to disk, and then SILENTLY REVERTED TO
FALSE on the next restart, with nothing logged. A setting that works until you
restart is harder to trust than one that never worked.

`breakdownEnabled` had the same gap and it is the reason it could not be armed at
all: the engine reads strategySettings.breakdownEnabled === true, and nothing ever
put the key on that object.

`=== true` and not a truthy test, for the same reason the engine uses it: a stray
"false" string in a hand-edited config must never arm a live short-selling setup.
A missing key leaves the module default rather than forcing false, so a config
that predates either key behaves exactly as it did before.

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
