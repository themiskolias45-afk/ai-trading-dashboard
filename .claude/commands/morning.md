Run the morning briefing for SmartEntry Pro. Usage: /morning

Use SmartEntry MCP tools directly. All steps required — no skipping.

STEP 1 — Load memory and yesterday (in parallel):
  mcp__smartentry__read_memory query="recent trade"    → most recent lessons
  mcp__smartentry__get_daily_note date=yesterday       → yesterday's session log
  mcp__smartentry__get_performance                     → recent performance stats

STEP 1b — SIGNAL-DEAD CHECK (run immediately, before anything else):
  mcp__smartentry__get_journal limit=200 → find last trade date per asset
  Calculate days since last confidence ≥ the live gate fired per asset.
  If any asset > 5 days: flag — this goes at the TOP of the morning brief, not buried.
  If any asset > 7 days: this is SIGNAL-DEAD — morning brief opens with a WARNING block.

STEP 2 — Get live data (in parallel):
  mcp__smartentry__get_signals       → all three assets
  mcp__smartentry__get_risk_status   → regime, session, circuit breaker
  mcp__smartentry__get_healer        → system health
  mcp__smartentry__get_journal limit=10  → last 10 trades
  Brave search: "market outlook [today's date] BTC gold SPX"

STEP 3 — Log today's session start:
  mcp__smartentry__log_note tag="SESSION_START" text="Morning brief — [summary of signals]"

STEP 4 — Deliver the brief:

---
SMARTENTRY PRO — MORNING BRIEF [today's date]
---

[If any asset is SIGNAL-DEAD (> 7 days) — show this block FIRST:]
⚠ SIGNAL-DEAD: [asset] has not fired in [N] days. Run /diagnose to find root cause.

SIGNAL STATUS:
• BTC:  [conf]% | [READY/WAIT — gap Xpt] | last traded [N days ago]
• GOLD: [conf]% | [READY/WAIT — gap Xpt] | last traded [N days ago]
• SPX:  [conf]% | [READY/WAIT — gap Xpt] | last traded [N days ago]

[Only show trade levels for assets where confidence ≥ the live gate:]
SIGNALS READY:
• [ASSET]: [signal] [setup] [confidence]% — Entry $X | Stop $X | Target $X | R/R 1:X

[If no signals ready:]
NO SIGNALS READY — closest: [asset] at [conf]% ([gap]pt from threshold)

FROM MEMORY:
• [1-2 most relevant lessons or open setups from memory]

YESTERDAY RECAP:
• [signals that fired, trades closed, any lessons from daily note]

MARKET REGIME: [regime] | SESSION: [session] | News blackout: [YES/NO]
PRE-MARKET: [key context from web search]

RECENT PERFORMANCE (last 10 trades):
• Win rate: X% | P&L: $X | [streak if any]

TOP PRIORITY TODAY:
• [one sentence — the single most important thing to watch or act on]
---

After the brief, ask: "Run a full scan? (Y/N)"
