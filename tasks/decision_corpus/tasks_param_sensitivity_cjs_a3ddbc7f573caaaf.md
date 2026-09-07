---
decision_key: a3ddbc7f573caaaf
source: tasks/param_sensitivity.cjs:303
status: standing
recorded: 2026-09-06T07:20:46.724Z
---

# STANDING DECISION

MERGE, NEVER OVERWRITE. Running one axis used to erase every other axis already on

Governs: `fs.mkdirSync(path.dirname(OUT), { recursive: true });`

## The reasoning as recorded

MERGE, NEVER OVERWRITE. Running one axis used to erase every other axis already on
disk, so `--axis momentumRsi` silently destroyed the gate, minrr and adx results
measured minutes earlier. That is data loss in a tool whose whole job is preserving
evidence. Axes from this run replace their own entries; everything else is kept,
carrying the timestamp it was measured at so a stale axis is visible as stale.

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
