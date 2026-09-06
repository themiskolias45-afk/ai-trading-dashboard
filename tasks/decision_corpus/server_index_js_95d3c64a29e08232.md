---
decision_key: 95d3c64a29e08232
source: server/index.js:703
status: standing
recorded: 2026-09-06T07:20:46.724Z
---

# STANDING DECISION

NAMES THAT MUST NEVER BE SETTABLE OVER HTTP.

Governs: `const PROTECTED_ENV_KEYS = new Set([`

## The reasoning as recorded

NAMES THAT MUST NEVER BE SETTABLE OVER HTTP.

The keys.env boot loader (top of this file) assigns a variable only when it is
UNDEFINED. PATH, COMSPEC, PROGRAMFILES and LOCALAPPDATA are always defined, so a
poisoned keys.env was INERT at startup — that guard was the containment, and it is
invisible unless you go looking for it. /api/settings applies saved keys to
process.env so they work without a restart, which means it must re-impose the
containment the loader provided for free.

The sanitiser CREATES these names rather than blocking them: safeKey uppercases and
strips to [A-Z0-9_], so "path" becomes PATH and "comspec" becomes COMSPEC. And
process.env on Windows is CASE-INSENSITIVE, so assigning PATH overwrites the real Path.

Why each group is here — every one is reached WITHOUT a restart:
  COMSPEC          spawn(process.env.COMSPEC || "cmd.exe", ...) for the Claude CLI,
                   read at call time, no memoisation.
  PATH / PATHEXT   `schtasks` is spawned as a bare command name and resolved through PATH.
  SMARTENTRY_PYTHON, PROGRAMFILES, LOCALAPPDATA
                   server/python_path.js re-reads these on recheck(), which autohealer
                   calls every 10 minutes, and the probe EXECUTES each candidate.
  NODE_OPTIONS, PYTHONPATH, PYTHONHOME, PYTHONSTARTUP
                   inherited by every child; pythonEnv() spreads { ...process.env }.
  MT5_EXPECTED_ACCOUNTS
                   the duplicate-bridge control. ensure_running.ps1 starts one bridge
                   per expected tag on a 10-minute schedule, so this decides whether a
                   second bridge is launched on an account this box does not own —
                   the one outcome that would double every trade.
  PEER_SERVER_URL, PEER_HEARTBEAT_EXPECT
                   the fleet-divergence verdict. Repointing these silently makes every
                   parity answer describe a different machine.

Refused at safeKey time, so a blocked name never reaches the FILE either — otherwise
it would lie dormant and apply at the next restart, which is the same bug delayed.

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
