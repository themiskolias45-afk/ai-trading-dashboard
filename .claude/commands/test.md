Write and run tests for a function, feature, or the whole system.

Usage: /test [what to test]
If $ARGUMENTS is empty → run the full system test suite (see FULL SYSTEM TEST below).

═══ TARGETED TEST — /test [function or feature] ═══

STEP 1 — UNDERSTAND what's being tested:
  Read the full file containing the target — front to back.
  Identify every code path:
    - Happy path: normal valid input
    - Edge: empty, null, zero, very large, exactly at limit
    - Error: bad input, network down, file missing, API returns non-200
    - Boundary: confidence = 65 (fires) vs 64 (doesn't); lot = 0.01 min; loss streak = 3

STEP 2 — WRITE tests:
  JS → test file in server/tests/test_[name].js, use Node's built-in assert module
  Python → test file next to source, use unittest (built-in)
  Name each test what it proves: test_signal_fires_at_65_not_64()

STEP 3 — RUN:
  JS:     node server/tests/test_[name].js
  Python: python -m unittest [testfile]
  Fix code (not the test) if anything fails. Re-run until all pass.

STEP 4 — REPORT:
  Tests written: X | Passed: X | Failed: 0 (must be 0 to finish)
  Coverage: [which paths are tested vs which aren't]

═══ FULL SYSTEM TEST — /test (no args) ═══

Run all of these in sequence. Stop and report if anything fails.

1. SYNTAX CHECK (all source files):
   node --check server/index.js
   node --check server/autohealer.js
   node --check server/mcp_server.js
   python -m py_compile mt5_bridge.py
   python -m py_compile parallel_analysis.py

2. SECRETS SCAN:
   git ls-files -- 'server/apikey.txt' 'keys.env'  → must return EMPTY
   Grep for sk-ant-, AKIA, password= in all tracked JS/Python files

3. LIVE API TEST (server must be running — skip with [OFFLINE] note if not):
   mcp__smartentry__get_signals              → must return {signals} not null/error
   mcp__smartentry__get_risk_status          → must return {regime, halted} not null/error
   mcp__smartentry__get_healer               → must return ≥ 4/6 green
   mcp__smartentry__get_performance          → must return {totalTrades, winRate}
   mcp__smartentry__get_learning             → must return {setups}

4. SIGNAL INTEGRITY CHECK:
   From mcp__smartentry__get_signals: for each asset
   - confidence ≥ 65 → signal should NOT be WAIT (if regime is not halted)
   - confidence < 65 → signal MUST be WAIT
   - Flag any mismatch as a CRITICAL failure

5. GIT STATE:
   git status → must show no uncommitted changes (warn if dirty)
   git log --oneline -1 → confirm latest commit exists

FULL SYSTEM TEST REPORT:
---
SYNTAX:   PASS / FAIL [which file failed]
SECRETS:  CLEAN / BREACH [which file]
API:      ONLINE/OFFLINE — [endpoints: PASS/FAIL per endpoint]
SIGNALS:  CALIBRATED / MISMATCH [asset, expected, actual]
GIT:      CLEAN / DIRTY [file count]
---
VERDICT: GREEN (all pass) / YELLOW (non-critical issues) / RED (fix required)
