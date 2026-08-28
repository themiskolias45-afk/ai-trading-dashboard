Autonomous profitability improvement loop. Researches, analyses, implements, verifies — up to N rounds.

Usage: /profit [--rounds N]  (default 5 rounds)

═══ EACH ROUND ═══

STEP 1 — DIAGNOSE (parallel, max 3s each):
  mcp__smartentry__get_performance          → WR, P&L, worst setup
  mcp__smartentry__get_learning             → setup calibration, win rates, boosts
  mcp__smartentry__get_journal limit=100    → last 100 trades, P&L breakdown
  mcp__smartentry__get_risk_status          → regime, circuit breaker, consecutive losses
  mcp__smartentry__get_signals              → current signal quality and confidence
  mcp__smartentry__get_rejection_evidence   → gate verdicts — EARNING ITS KEEP / COSTING MONEY

  Identify WEAKEST LINK — worst WR setup or gate that is COSTING MONEY.
  If nothing qualifies (all WR ≥ 55%, all gates EARNING ITS KEEP) → DONE, report and stop.

STEP 2 — RESEARCH (spawn researcher agent):
  Agent type: researcher
  Prompt: "Research the following SmartEntry Pro weakness: [WEAKEST_LINK from Step 1].
  Current WR: [X]%. Asset: [ASSET]. Setup type: [SETUP].
  Find: (1) quantitative strategies to improve this specific weakness, (2) parameter tuning evidence,
  (3) risk filters that consistently help. Return: top 3 findings, each with direct applicability score
  1-5 and estimated WR improvement range. External sources only. Be specific — no general advice."

STEP 3 — ANALYSE (spawn analyst agent):
  Agent type: analyst
  Prompt: "Analyse this SmartEntry Pro weakness using the data below and the research findings.
  Performance data: [STEP 1 results]
  Research findings: [STEP 2 results]
  Task: (1) identify root cause of the weakness, (2) select the single best fix from the research
  that has: WR improvement ≥ 5%, implementable without breaking live trades, supported by evidence.
  (3) Write the exact CHANGING/NOW/AFTER/RISK scaffold for the proposed fix. (4) Rate risk: LOW / HIGH.
  If risk is HIGH (touches signal generation, risk gate, lot sizing, stop logic) — flag explicitly."

STEP 4 — IMPLEMENT:
  If analyst rated risk HIGH:
    → Show scaffold + proposed diff to user
    → Wait for explicit approval — do NOT proceed
    → Mark as "awaiting approval" and move to next round

  If risk LOW (thresholds, boosts, filters, display):
    → Spawn builder agent:
      Agent type: builder
      Prompt: "[CHANGING/NOW/AFTER/RISK scaffold from analyst]
      Implement this change to [FILE]. Read the full file first.
      Verify: node --check [file] after edit.
      Commit: git commit -m 'profit: [what changed and why]' -- [FILE]
      (pathspec form ONLY — never git add; /profit may spawn multiple builders sharing one working tree)
      Report: DONE or FAILED with reason."

STEP 5 — VERIFY:
  mcp__smartentry__get_performance          → compare metrics post-fix
  mcp__smartentry__get_learning             → confirm calibration updated
  mcp__smartentry__log_note tag="PROFIT-LOOP" text="Round [X]: fixed [what] on [setup/asset] — [result]"
  mcp__smartentry__write_memory key="profit-[date]-r[X]" value="[fix summary + estimated impact]"

═══ BETWEEN ROUNDS ═══
One-line status:
  Round X/N: Fixed [what] on [asset/setup] → expected +[X]% WR | Weakest remaining: [next]

Stop early if:
- All setups WR ≥ 55% and no gate is COSTING MONEY
- 2 consecutive rounds found nothing implementable
- User types /stop

═══ FINAL REPORT ═══
PROFIT LOOP COMPLETE — [N] rounds
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CHANGES MADE:
  1. [fix] — [estimated +X% WR on ASSET/SETUP]
  2. [fix] — [estimated impact]

AWAITING APPROVAL:
  1. [high-risk fix] — [proposed diff summarised]

OVERALL EXPECTED: [+X% win rate / +X% avg R / -X% drawdown]
SYSTEM WR NOW:    [X]%
NEXT WEAKNESS:    [one sentence]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

After report: offer to run /backtest to validate the changes against walk-forward data.
