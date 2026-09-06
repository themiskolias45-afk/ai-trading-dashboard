---
decision_key: 3f47347ee79be05f
source: server/index.js:6236
status: standing
recorded: 2026-09-06T07:20:46.724Z
---

# STANDING DECISION

NEVER waits for it: the request always serves whatever the last run wrote, so a slow or

Governs: `const SNAPSHOT_PATH = path.join(__dirname, "..", "tasks", "mt5_positions_snapshot.json");`

## The reasoning as recorded

EVERY position on the account, including the ones the bridge filters out.

The bridge skips `p.magic != MAGIC_NUMBER` in every position path, so third-party EA
trades reach no surface at all - on account 11581419 that was FOUR open positions the
page reported as "0 not managed", which is not "none", it is "not reported". Teaching
the bridge to send them needs a bridge restart, which has been unavailable all day.

tasks/mt5_positions_snapshot.py reads MT5 directly, read-only, and writes every open
position to a JSON file. This spawns it at most once a MIN_SNAPSHOT_INTERVAL_MS and
NEVER waits for it: the request always serves whatever the last run wrote, so a slow or
hung python can delay the data but can never delay the page. A snapshot that cannot be
read is reported as unknown rather than as zero - the whole reason this exists.

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
