---
decision_key: ec694c4c47175818
source: server/index.js:6155
status: standing
recorded: 2026-09-06T07:20:46.724Z
---

# STANDING DECISION

SAFE BECAUSE connected IS null, NEVER true. Callers that act on this route are

Governs: `const expectedAccounts = (process.env.MT5_EXPECTED_ACCOUNTS ?? "A,B")`

## The reasoning as recorded

An account this box does not own is not a fault, and reporting it as one is
worse than saying nothing: a status surface that carries a permanent RED trains
you to skim past the row that matters, and every expensive failure this fleet
has had was a real divergence sitting behind checks nobody read closely.
MT5_EXPECTED_ACCOUNTS is the single source of truth, shared with the healer
(autohealer.js:33), the watchdog and ensure_running.ps1.

SAFE BECAUSE connected IS null, NEVER true. Callers that act on this route are
gated on the same variable BEFORE they call it — watchdog.bat reads
MT5_EXPECTED_ACCOUNTS and jumps past the bridge-B branch entirely, so a 200 here
cannot start a duplicate bridge on an account this box does not own, which is
the one outcome that would double every trade. The {connected:null} + 200 shape
is not new: it is exactly what the startup-grace branch above already returns,
so every existing reader already handles it.
Default "A,B" matches the healer, so a box with no keys.env behaves as today.

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
