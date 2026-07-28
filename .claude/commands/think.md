Deep analysis mode — force explicit reasoning before implementing anything complex.
Use before any non-trivial code change, architecture decision, or debugging session.

Usage: /think [what you want to build or fix]

═══ MANDATORY REASONING SEQUENCE ═══

Do NOT touch any file until all four blocks below are complete.

BLOCK 1 — UNDERSTAND THE CURRENT STATE
  Read EVERY file that will be touched — full content, front to back.
  For each function you'll change, write out:
    - What it does NOW (one sentence)
    - What calls it (trace up the call chain)
    - What it returns (exact type and shape)
    - What would break if the return changed

BLOCK 2 — TRACE WITH REAL VALUES
  Pick 3 concrete inputs and walk through the current code step by step:
    Input A: [normal case]     → walks through as: ... → returns: ...
    Input B: [edge case]       → walks through as: ... → returns: ...
    Input C: [failure case]    → walks through as: ... → returns: ...
  If the current behavior surprises you anywhere, flag it before proceeding.

BLOCK 3 — DESIGN THE CHANGE
  State precisely:
    CHANGE: [what you will modify — function name, line range, parameter]
    FROM:   [current behaviour]
    TO:     [new behaviour]
    WHY:    [root cause this solves — not symptom, not description]
    RISK:   [what could break — be specific, not "could cause issues"]

  If RISK is HIGH (signal logic, risk gate, execution) → stop and show the user before continuing.
  If RISK is LOW (thresholds, display, logging) → proceed but document it.

BLOCK 4 — VERIFY PLAN
  Trace through the same 3 inputs again with the CHANGED code:
    Input A → now returns: ... (correct: YES/NO)
    Input B → now returns: ... (correct: YES/NO)
    Input C → now returns: ... (correct: YES/NO)
  If any returns NO → redesign before writing a single line.

═══ ONLY THEN ═══
  Write the code.
  Run node --check [file] or python -m py_compile [file].
  Run the relevant API endpoint and verify the response.
  Commit.
  If server/index.js was changed → invoke code-reviewer agent on the diff.

Report format:
THINK COMPLETE — [what was analyzed]
• Understood: [files read, functions traced]
• Design: [exact change, risk level]
• Verified: [3 inputs × expected vs actual]
• Ready to implement: YES/NO
