Deep stack error check — validates server, APIs, file integrity, code syntax, and security. Usage: /check [server|code|files|git]

$ARGUMENTS selects what to check. If blank, runs everything.

Run:
```
python check_errors.py $ARGUMENTS
```

Then interpret and report the results:

**SYSTEM CHECK — [timestamp]**

Group results by status:
  FAIL: [list every failure — these need immediate action]
  WARN: [list warnings — review but not blocking]
  PASS: [count only, e.g. "42 checks passed"]

For each FAIL:
  - State the exact problem in one line
  - State the fix in one line
  - Ask if I want to apply the fix now

Security flags to escalate immediately:
  - Any secret file (apikey.txt, keys.env) appearing in git diff → "STOP — secrets at risk of being committed"
  - Wrong git branch → "WARNING: not on development branch"

If all checks pass: "System clean — X checks, 0 failures."
If failures exist: "X failure(s) found — [list them]. Fix now?"

Checks performed:
  server — API health, all required routes reachable
  files  — critical files exist and are non-empty, secrets are gitignored
  code   — Python syntax (py_compile), JS syntax (node --check)
  git    — branch correct, no secrets in working tree
