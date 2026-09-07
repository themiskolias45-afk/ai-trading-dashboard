Systematic debugging. Usage: /debug [description of the problem]
$ARGUMENTS is the problem. If empty, ask: "What's broken?"

═══ STEP 1 — READ THE EVIDENCE FIRST ═══
Do NOT look at code yet. Gather all available error data:

  Logs (read last 100 lines of each that exists):
    tasks\logs\server_log.txt
    tasks\logs\bridge_log.txt
    tasks\logs\startup_log.txt
    tasks\logs\error_log.txt

  Live system state (if server is running):
    mcp__smartentry__get_healer     → which health checks are failing
    mcp__smartentry__get_signals    → are signals generating at all
    mcp__smartentry__get_risk_status → any unexpected halt or regime

  Look for: ERROR, WARN, TypeError, undefined, null, ECONNREFUSED, SyntaxError, Cannot read, 500

  Write down EXACTLY what the error says before moving on.

═══ STEP 2 — FORM A HYPOTHESIS ═══
  From the evidence, write:
    SYMPTOM:    [what the user sees / what's wrong]
    ERROR:      [exact error message or behavior]
    HYPOTHESIS: [root cause — be specific, not "something is wrong with X"]
    CONFIRM BY: [what would prove or disprove this hypothesis]

  Only ONE hypothesis at a time. Most likely first.

═══ STEP 3 — CONFIRM THE ROOT CAUSE ═══
  Now read the code — but only the part the hypothesis points to.
  Read the FULL function/file where the error originates.
  Trace backwards: what was passed in → what was returned → what was expected.
  
  Trace with the ACTUAL failing input:
    Call path: [A called B called C]
    At C: input was [X], returned [Y], caller expected [Z]
    Mismatch at: [exact line]

  If hypothesis is wrong → form a new one, repeat.
  Do NOT patch the code until the root cause is confirmed.

═══ STEP 4 — FIX ═══
  Write the minimal fix that addresses the root cause.
  No unrelated changes. No refactoring while debugging.
  
  Before saving, trace the fix mentally with the failing input:
    Before fix: [input] → [wrong output]
    After fix:  [input] → [correct output]
  
  If the fix touches server/index.js → invoke code-reviewer agent after committing.

═══ STEP 5 — VERIFY ═══
  node --check [file] (JS) or python -m py_compile [file] (Python)
  Restart server if needed, then hit the endpoint that was failing.
  Confirm the original symptom is gone.
  Confirm nothing else broke (hit the 5 key API endpoints).

═══ STEP 6 — REPORT + PERSIST ═══
  ROOT CAUSE: [one sentence]
  FIX: [what changed and why]
  FILE: [path:line]
  COMMIT: [hash]

  mcp__smartentry__log_note tag="BUG-FIX" text="[root cause + fix summary]"
  mcp__smartentry__write_memory key="bug-[date]" value="[root cause] — fixed by [what]"

Never patch around a bug. Never say "this should work now" — verify it does.
