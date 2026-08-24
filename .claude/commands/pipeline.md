Safe strategy discovery → backtest → implement pipeline. Usage: /pipeline

This is the controlled, safe path from "could this improve profit?" to "implemented and verified."
Nothing touches live code until it passes every gate. No shortcuts.

═══ GATE 1 — DISCOVER ═══
  Run /discover logic (inline, no separate command needed):
  Read tasks/analysis/strategy-search-latest.txt
  If no proposals: "No candidates from overnight search. Run tomorrow or try /research [topic]."
  If candidates exist: extract the top-scored one (score ≥ 12/20 to proceed).

  GATE 1 PASS condition: candidate exists with score ≥ 12/20
  GATE 1 FAIL: stop here. Report what was found and why it didn't qualify.

═══ GATE 2 — BASELINE BACKTEST ═══
  Run: mcp__smartentry__run_walkforward
  Record: overall WR, worst fold WR, best fold WR.
  This is the CURRENT system baseline — the candidate must beat this to proceed.

  GATE 2 PASS condition: walkforward completes without DEGRADED warning
  GATE 2 FAIL: "Walkforward degraded — insufficient data. Wait for more trades."

═══ GATE 3 — CANDIDATE ANALYSIS ═══
  Spawn analyst agent to answer one question:
  "If we implement [CANDIDATE], what is the estimated WR impact vs the current baseline?
  Base your estimate on: (1) the search file's scoring data, (2) the research findings,
  (3) the current baseline WR [X]% with worst fold [Y]%.
  Answer: ESTIMATED WR CHANGE: [+X% or -X%] | CONFIDENCE: [LOW/MEDIUM/HIGH] | REASON: [one sentence]"

  GATE 3 PASS condition: estimated WR change is positive AND confidence is MEDIUM or HIGH
  GATE 3 FAIL: "Analyst estimates no improvement or low confidence. Reject candidate."

═══ GATE 4 — RISK ASSESSMENT ═══
  Read tasks/pre-flight.md — answer Q3 (CHANGING/NOW/AFTER/RISK) for the candidate.

  If RISK mentions signal generation / risk gate / lot sizing / stop / execution:
    → Show the scaffold to the user.
    → Wait for explicit "APPROVE" before proceeding.
    → Do NOT auto-implement HIGH-RISK changes.

  If RISK is LOW (thresholds, filters, boosts, display):
    → Proceed to Gate 5 automatically.

═══ GATE 5 — IMPLEMENT (LOW-RISK only, or user-approved HIGH-RISK) ═══
  Spawn builder agent:
  - Read tasks/pre-flight.md and answer all 6 questions
  - Implement the candidate change
  - Run node --check [file]
  - Run node tasks/api_snapshot.cjs (if server/index.js)
  - Commit with pathspec (never git add -A)

═══ GATE 6 — POST-IMPLEMENTATION VERIFICATION ═══
  Run: mcp__smartentry__run_walkforward (second run — compare to Gate 2 baseline)
  Compare: new worst fold vs baseline worst fold
  If new worst fold < baseline worst fold: REVERT — the change made things worse.
    → git revert [commit hash]
    → Report: "REVERTED — worst fold degraded from [Y]% to [Z]%"
  If new worst fold ≥ baseline worst fold: KEEP
    → Report: "IMPLEMENTED — worst fold [Y]% → [Z]% (improved / unchanged)"

═══ PIPELINE REPORT ═══
PIPELINE COMPLETE — [date]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CANDIDATE:     [description]
GATE 1 (discover):  PASS — score [X]/20
GATE 2 (baseline):  WR [X]% | worst fold [Y]%
GATE 3 (analysis):  estimated [+/-X%] WR | confidence [LOW/MEDIUM/HIGH]
GATE 4 (risk):      [LOW — auto / HIGH — user approved / REJECTED]
GATE 5 (implement): [DONE — commit [hash] / BLOCKED — reason]
GATE 6 (verify):    worst fold [Y]% → [Z]% | KEPT / REVERTED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Persist:
  mcp__smartentry__write_memory key="pipeline-[date]" value="[candidate + result + WR delta]"
  mcp__memory__create_entities name="[date] pipeline: [candidate short label]"
    entityType: "decision"
    observations: ["implemented [what]", "WR impact [X]%", "decision: KEPT/REVERTED"]
