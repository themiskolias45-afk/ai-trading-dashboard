Deep error scan — finds ALL errors in logs, source code, and live system. Usage: /errors

Goes deeper than /check. /check does quick syntax. /errors finds runtime problems, anti-patterns, and recurring failures.

═══ SCAN 1 — ALL LOGS (full content, not just last 50 lines) ═══
Read completely:
  tasks\logs\server_log.txt
  tasks\logs\bridge_log.txt
  tasks\logs\error_log.txt
  tasks\logs\startup_log.txt
  (any other .log or .txt in tasks\logs\)

For each log, find EVERY occurrence of:
  ERROR, WARN, TypeError, ReferenceError, SyntaxError, UnhandledPromiseRejection,
  Cannot read prop, undefined is not, null is not, ECONNREFUSED, ENOENT,
  500, 502, 503, Timeout, socket hang up, ETIMEDOUT, heap out of memory

For each match: note [file][timestamp][message][count — how many times?]
Classify: TRADING-IMPACT / SYSTEM / COSMETIC
Sort: most frequent first.

═══ SCAN 2 — SOURCE CODE ANTI-PATTERNS ═══
Read server/index.js and server/autohealer.js fully.
Flag every instance of:

a) SILENT FAILURES — empty catch blocks:
   } catch (e) { }   or   } catch { }   or   .catch(() => {})
   These swallow errors without logging — bugs become invisible.

b) UNHANDLED PROMISES — .then() without .catch():
   Pattern: .then(fn) with no .catch( before the next .then or ;

c) MEMORY LEAKS — unbounded growth:
   Pattern: array.push inside a loop or interval with no trim/splice/limit

d) INTERVAL LEAKS — never cleared:
   setInterval( or setTimeout( that stores no reference (can't be cleared)

e) MISSING TIMEOUT on external calls:
   axios.get( or fetch( without timeout option

f) HARDCODED THRESHOLDS that should be configurable:
   Numbers like 65, 0.01, 3 (circuit breaker) used directly in logic

g) UNVALIDATED INPUT — any route reading req.body or req.query without type check

h) MISSING null CHECK before .length, .map, .filter, .forEach on API response data

═══ SCAN 3 — LIVE API ERROR TEST ═══
Call each endpoint and check for errors:
  mcp__smartentry__get_signals        → PASS if {signals} | FAIL with error message
  mcp__smartentry__get_risk_status    → PASS if {regime} | FAIL
  mcp__smartentry__get_healer         → PASS if ≥4/6 green | WARN if <4 | FAIL if error
  mcp__smartentry__get_performance    → PASS if {totalTrades} | FAIL
  mcp__smartentry__get_learning       → PASS if {setups} | FAIL

  HTTP extras (if server running):
  GET /api/journal → check for 500 or malformed JSON
  GET /api/setup-health → check for 500

═══ SCAN 4 — SIGNAL INTEGRITY ═══
From mcp__smartentry__get_signals:
  For each asset: if confidence ≥ the live gate AND not halted → direction must NOT be WAIT
  For each asset: if confidence < the live gate → direction MUST be WAIT
  Flag MISMATCH: [asset] confidence=[X] but direction=[Y]

Also: check that entry, stop, target are all non-zero and target > entry (for BUY) or target < entry (for SELL).
Flag any signal where the math doesn't make sense.

═══ REPORT ═══

DEEP ERROR SCAN — [timestamp]
═══════════════════════════════════════════════
LOG ERRORS:
  TRADING-IMPACT ([count]):
    [error message] — seen [X] times in [log file]
  SYSTEM ([count]):
    [error] — [count] × [file]
  COSMETIC ([count]): [list briefly]

CODE ANTI-PATTERNS:
  [pattern type]: [file:line] — [one-line explanation of why it's dangerous]

API STATUS:
  [endpoint]: PASS / FAIL / OFFLINE
  Signal integrity: CLEAN / MISMATCH [details]

SUMMARY:
  Total errors found: [X]
  Blocking (fix before trading): [X]
  Should fix soon: [X]
  Low priority: [X]

PRIORITY FIX LIST:
  [1] [BLOCKING] [specific error or anti-pattern] — [exact file:line] — fix: [one sentence]
  [2] [HIGH] ...
  [3] [MEDIUM] ...
═══════════════════════════════════════════════

After report: "Fix the blocking issues now? (Y/N)"
If yes → run /fix targeting each blocking item in order.
