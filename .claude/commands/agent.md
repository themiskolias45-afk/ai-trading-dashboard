Run a full autonomous improvement loop on SmartEntry Pro. Loops until all issues resolved.

Does everything automatically without asking permission at each step.

═══ LOOP — repeat until nothing left to fix (max 5 rounds) ═══

ROUND START — gather all state in parallel (MCP tools directly):
  mcp__smartentry__get_signals              → signal quality per asset
  mcp__smartentry__get_learning             → setup win rates, calibration
  mcp__smartentry__get_healer               → 6-point health check
  mcp__smartentry__get_risk_status          → regime, P&L, circuit breaker, consecutive losses
  mcp__smartentry__get_performance          → total trades, WR, worst setup

EVALUATE — check all of these in order:
  1. Setup WR < 40% over ≥ 5 trades → tighten entry criteria in server/index.js
  2. Confidence tier mismatch (65-74% tier < 50% actual WR) → adjust threshold
  3. Healer reports stale data → mcp__smartentry__force_heal
  4. Consecutive losses ≥ 3 and circuit breaker NOT halted → fix risk gate
  5. Any endpoint returning errors → find root cause and fix it (read full file first)
  6. Signal stuck at WAIT when regime is trending → fix signal logic

FOR EACH ISSUE:
  LOW-RISK (thresholds, boosts, parameters):
    → Implement immediately
    → node --check [file] — verify syntax
    → git add [specific file] && git commit
    → mcp__smartentry__log_note tag="AUTO-FIX" text="[what was fixed]"

  HIGH-RISK (core signal logic, risk gate, execution):
    → Describe issue, show exact proposed diff
    → Wait for approval — DO NOT auto-apply
    → Mark as "awaiting approval" in final report

AFTER EACH ROUND:
  Re-fetch all data and confirm fix worked.
  New issues appeared → run another round.
  Everything clean → stop and report.

═══ FINAL REPORT ═══
AUTO-AGENT COMPLETE — [N] rounds
---
Issues found:    [list]
Fixed auto:      [list with what changed]
Awaiting approval: [list with proposed diffs]
System status:   HEALTHY / NEEDS ATTENTION
---

Never auto-fix anything that could cause a trade to fire incorrectly or a stop to be calculated wrong.
