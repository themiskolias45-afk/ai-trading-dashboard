Autonomous overnight brief + self-healing cycle. Runs without user input. Usage: /auto

Designed to run every morning before the user opens JARVIS — or via `claude -p "/auto"` from
a Windows scheduled task. Produces a concise overnight brief and auto-fixes what's safe.

═══ STEP 1 — OVERNIGHT CONTEXT (all in parallel, max 3s each) ═══
  mcp__smartentry__get_brain_status         → time, fleet, signals, risk, proposals
  mcp__smartentry__get_fleet_status         → both boxes: parity, divergence, bridges
  mcp__smartentry__get_performance          → WR, P&L, trades since yesterday
  mcp__smartentry__get_journal limit=5      → last 5 trades — anything executed overnight?
  mcp__smartentry__get_rejection_evidence   → any gate flip to COSTING MONEY since last check?
  mcp__smartentry__read_memory query="tomorrow priorities" → what did yesterday's session plan?

═══ STEP 2 — TRIAGE (priority order) ═══
  P1. Fleet diverges or bridge down → log_note tag="AUTO-ALERT" + surface in brief
  P2. Circuit breaker tripped overnight → log_note + surface in brief
  P3. Server health degraded (healer stale > 10 min) → mcp__smartentry__force_heal
  P4. New trade(s) executed overnight → note outcome, check if stop was respected
  P5. Gate flipped to COSTING MONEY → flag for /profit run
  P6. "tomorrow priorities" from memory → surface top 3

═══ STEP 3 — AUTO-FIX (LOW-RISK only, no approval needed) ═══
  - Stale healer data → force_heal
  - Log errors > 1 hour old in /api/healer → force_heal
  NOTHING ELSE auto-fixed. All other issues surfaced in brief only.

═══ STEP 4 — PERSIST ═══
  mcp__smartentry__write_memory key="auto-[YYYY-MM-DD]" value="[brief summary — trades + issues + actions]"
  mcp__smartentry__log_note tag="AUTO-BRIEF" text="[one paragraph — what happened overnight]"

═══ BRIEF FORMAT ═══
AUTO-BRIEF — [date] [time]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OVERNIGHT:   [trades executed: count + P&L | or: no trades]
FLEET:       [HEALTHY / DIVERGED — what differs]
SIGNALS NOW: BTC [X]% | GOLD [X]% | SPX [X]%
ISSUES:      [list — or NONE]
AUTO-FIXED:  [what was healed — or NONE]

TODAY'S PRIORITIES (from /learn yesterday):
  [1] [priority]
  [2] [priority]
  [3] [priority]

RECOMMENDED: [single most important action right now — one sentence]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Total runtime: < 30 seconds. No user input required.

═══ TO SCHEDULE (Windows Task Scheduler) ═══
Run this command every morning at 07:00:
  claude -p "/auto" --cwd "C:\Users\User\ai-trading-dashboard"
Or on VPS (C:\ai-trading-dashboard):
  claude -p "/auto" --cwd "C:\ai-trading-dashboard"
Output pipes to: tasks\logs\auto_brief.txt
