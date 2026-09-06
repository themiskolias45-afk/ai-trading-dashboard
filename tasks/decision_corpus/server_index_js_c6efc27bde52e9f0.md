---
decision_key: c6efc27bde52e9f0
source: server/index.js:1026
status: standing
recorded: 2026-09-06T07:20:46.724Z
---

# STANDING DECISION

Start empty rather than crash, and DO NOT write over the unreadable file —

Governs: `console.error("[alerts] Load error, starting with an empty feed. The file on disk"`

## The reasoning as recorded

Start empty rather than crash, and DO NOT write over the unreadable file —
the next successful save would otherwise erase whatever is still in it.

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
