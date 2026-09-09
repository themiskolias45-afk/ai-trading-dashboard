---
decision_key: 656d759cacbbe446
source: tasks/backup_history_check.cjs:60
status: standing
recorded: 2026-09-09T14:07:14.582Z
---

# STANDING DECISION

KEYED ON FULL PATH, NEVER ON BASENAME.

Governs: `const map = new Map();`

## The reasoning as recorded

KEYED ON FULL PATH, NEVER ON BASENAME.

These archives contain BACKUPS INSIDE BACKUPS. backup_20260908_190002.zip holds
SEVENTEEN files called learning.json: the live one at 1,429 bytes, plus snapshots
under logs\prebridge_*, server\_prerestart_*, and vps-livestate-backup\20260730_*
at 1,138 / 456 / 87 bytes.

The first version of this file keyed on basename with last-wins, so it compared a
JULY 30 snapshot against today's live file and reported a 93% loss of learning.json
and an emptied smartentry.db. Both were false. That is the exact failure this tool
exists to catch, committed by the tool itself - a confident number measured against
the wrong object. Full paths are the only way to compare like with like.

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
