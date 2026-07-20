Systematic debugging. Usage: /debug [description of the problem]

$ARGUMENTS is the problem description.

Do this in strict order — no skipping steps:

1. READ THE LOGS FIRST
   - Read tasks\logs\server_log.txt (last 50 lines)
   - Read tasks\logs\bridge_log.txt (last 50 lines)
   - Read tasks\logs\startup_log.txt
   - Look for ERROR, WARN, Exception, undefined, null, TypeError, ECONNREFUSED

2. REPRODUCE THE PROBLEM
   - Identify the exact code path that causes it
   - Read the full file where the error occurs — front to back
   - Find the exact line

3. TRACE THE ROOT CAUSE
   - Use sequential thinking: why did this fail?
   - Work backwards from the error: what was passed in, what was returned, what was expected
   - Find the ROOT cause, not a symptom

4. FIX IT
   - Write the fix — minimal, targeted, no unrelated changes
   - Verify the fix mentally: walk through the code with the inputs that caused the bug
   - Confirm no other code path breaks

5. REPORT
   - What was broken: [one line]
   - Root cause: [one line]  
   - Fix applied: [one line]
   - Files changed: [list]

Never patch around a bug. Find why it happened and fix that.
