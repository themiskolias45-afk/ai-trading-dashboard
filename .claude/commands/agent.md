Full autonomous improvement loop for SmartEntry Pro. Runs until clean. Max 5 rounds.

Usage: /agent [--rounds N]

This is the system's self-healing command. It diagnoses, plans, builds, tests, and commits
without asking permission at each step — except for HIGH-RISK changes (signal logic, risk gate,
lot sizing, stop calculation), which always require explicit approval.

═══ SAFETY PRE-CHECK ═══
  Read tasks/tools-manifest.json before ANY autonomous multi-tool operation.
  Select minimum tool set needed. Never call TRADES-tagged tools (execute_trade,
  full_trade_workflow) without the user typing "APPROVE TRADE" explicitly.
  Never call DESTRUCTIVE-tagged tools (memory delete) without "CONFIRM DELETE".

═══ P0.5 — EVIDENCE BOARD SCAN (once per session, not each round) ═══
  mcp__smartentry__get_evidence_board → read all curated claims
  Surface only CANDIDATE claims (status = "CANDIDATE — NEEDS WALK-FORWARD"):
    "CANDIDATE: [id] — [title] — measured [measuredOn] — trigger: [whatWouldChangeThis]"
  Flag any CANDIDATE not re-measured in > 30 days as STALE:
    "STALE CANDIDATE: [id] — [N] days since [measuredOn] — run /backtest to settle"
  Do NOT act on these automatically. Surface for awareness only — they inform the P6/P7 priority below.

═══ ROUND START — read prior attempts first ═══
  Before gathering state, read tasks/agent-round-log.txt (create if missing).
  If same issue appears here from a prior round: diagnose WHY the prior fix failed before retrying.
  Never retry the same approach that was already blocked or errored.
  Append to tasks/agent-round-log.txt: "Round N — [date/time] — evaluating..."
  (Update this line at the end of the round with: "Round N — [issue found] — [fix attempted] — [result]")

═══ ROUND START — gather all state in parallel ═══

  mcp__smartentry__get_brain_status         → time context, fleet verdict, signals, risk, AI work
  mcp__smartentry__get_signals              → confidence per asset vs live gate
  mcp__smartentry__get_performance          → WR, P&L, trade count, worst setup
  mcp__smartentry__get_learning             → setup calibration, win rates
  mcp__smartentry__get_healer               → 6-point health check, last heal time
  mcp__smartentry__get_risk_status          → regime, circuit breaker, consecutive losses
  mcp__smartentry__get_rejection_evidence   → gate verdicts, net R per gate
  mcp__smartentry__get_fleet_status         → both boxes: parity, divergence, unreviewed proposals

═══ EVALUATE — priority order ═══

  P1. Fleet diverges or peer unreachable → surface to user, cannot auto-fix, STOP THIS ROUND
  P2. Server health critical (healer reports stale data) → mcp__smartentry__force_heal
  P3. Circuit breaker open and losses NOT from market conditions → investigate risk gate logic
  P4. Any endpoint returning error → read full file, find root cause, fix with builder agent
  P5. SIGNAL-DEAD asset (no trade > 7 days) → run /diagnose logic, identify cause
  P6. Setup WR < 40% over ≥ 5 trades → spawn profit loop for that setup only
  P7. Gate verdict COSTING MONEY (rejection evidence) → spawn analyst + researcher → fix
  P7b. STALE CANDIDATE from evidence board (P0.5) with ≥ 50 new trades since last measure → run /backtest
  P8. AI employee has unreviewed proposals → read them, implement if LOW-RISK
  P9. Any log error > 24h old and unresolved → trace and fix

  If nothing qualifies at P1-P9: "System clean — nothing to fix. Run /daily for routine check."

═══ FOR EACH ISSUE ═══

  LOW-RISK (health fixes, stale data, parameter tuning, log errors):
    → Spawn builder agent: brief it with CHANGING/NOW/AFTER/RISK scaffold
    → Builder reads full file, edits, runs node --check or python -m py_compile, commits
    → Verify fix landed: re-fetch the relevant endpoint
    → mcp__smartentry__log_note tag="AUTO-AGENT" text="Fixed: [what]"

  HIGH-RISK (signal generation, risk gate, lot sizing, stop logic, execution):
    → Spawn analyst agent to diagnose and write the scaffold
    → Show user: the scaffold + proposed diff
    → Wait for approval — mark "PENDING APPROVAL" in report
    → Do NOT proceed without explicit yes

═══ AFTER EACH ROUND ═══

  Re-fetch brain status and fleet. If new issues appeared → run another round.
  If all clean or max rounds reached → final report.

═══ FINAL REPORT ═══
AUTO-AGENT COMPLETE — [N] rounds — [date]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FIXED AUTO:
  [list — what was fixed, which file, what changed]

PENDING APPROVAL:
  [list — issue + proposed change + why it's high-risk]

SYSTEM STATUS: HEALTHY / NEEDS ATTENTION
SIGNAL STATUS: [per-asset conf vs gate, gap]
FLEET STATUS:  [parity OK / diverged]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

After report: run /learn to persist session lessons to memory.
