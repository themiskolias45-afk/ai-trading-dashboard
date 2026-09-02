---
decision_key: d2224a3bb47162a7
source: server/index.js:47
status: standing
recorded: 2026-09-02T17:52:40.137Z
---

# STANDING DECISION

APPEND-ONLY, NEVER ROTATED, NEVER TRUNCATED — the standing rule is that nothing here

Governs: `const CRASH_LOG_PATH = path.join(__dirname, "..", "tasks", "logs", "server_crash.txt");`

## The reasoning as recorded

── Last-resort process handlers ──────────────────────────────

This file had NO process handlers at all. Since Node 15 the default disposition for
an unhandled promise rejection is to TERMINATE, so one rejected promise in any
fire-and-forget path took the whole server down: the signal cache, /api/signals, the
bridge's only source of levels and the risk endpoints, all at once. Nothing wrote
down why. `tasks/ensure_running.ps1` polls every 10 minutes, so the cost was up to
ten minutes of dead signal path — while positions were open — followed by a silent
restart indistinguishable from a scheduled one.

THE TWO ARE TREATED DIFFERENTLY, ON PURPOSE. They are not the same event.

  unhandledRejection — an async branch failed and nobody awaited it. The rest of the
    process is intact. Killing a healthy server because one background fetch
    rejected is a worse outcome than the rejection itself, so this one is RECORDED
    AND SURVIVED. Nothing is suppressed: it reaches the console and the disk.

  uncaughtException — a synchronous throw escaped every frame. Whatever invariant
    that code was maintaining is now half-applied and the process state is genuinely
    unknown. Staying up would mean serving trades from it. So this one is recorded
    and then EXITS 1 — which is exactly what Node already did. The only thing added
    is that the death now names its cause. The supervisor restarts it.

THE SINK IS A FILE, NOT THE HEALER'S RING BUFFER. autohealer's errorLog lives in
memory and dies with the process, which makes it worthless for precisely the case
that kills the process. This appends synchronously, before any exit can happen.

APPEND-ONLY, NEVER ROTATED, NEVER TRUNCATED — the standing rule is that nothing here
gets deleted. Unbounded growth is held off by rate-limiting instead: a hot loop
emitting the same rejection thousands of times a second writes one line per distinct
message per minute and counts the rest, so the file records that it happened and how
often without itself becoming the next outage.

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
