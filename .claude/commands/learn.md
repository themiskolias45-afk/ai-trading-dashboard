End-of-session learning — persist what was built, fixed, or discovered today. Usage: /learn

Run this before closing JARVIS. Takes 2 minutes. Makes every future session smarter.

═══ STEP 1 — GATHER TODAY'S WORK ═══
  Read tasks/jarvis_memory.json (last 5 entries)
  mcp__smartentry__get_journal limit=20 → any trades since last session?
  mcp__smartentry__get_performance → did any metric improve today?
  mcp__smartentry__read_memory query="today improvement fix" → what was noted during the session?
  git log --oneline -5 → what was actually committed today?

═══ STEP 2 — EXTRACT LESSONS ═══
  For each commit today: what problem did it fix and why?
  For each trade today: what setup fired, what was the result?
  For any error fixed: what was the root cause, what prevents it recurring?
  For any decision made: what was the reasoning, is it still valid?

  Look for patterns:
    - Same error fixed twice → needs a permanent guard
    - Good trade setup → note the exact conditions
    - Failed approach → note why, don't repeat next session

═══ STEP 3 — PERSIST TO MEMORY ═══
  mcp__memory__create_entities:
    For each significant lesson:
      name: "[YYYY-MM-DD] [short label]"
      entityType: "lesson" | "fix" | "trade" | "decision"
      observations: ["[what happened]", "[root cause or reason]", "[what to do differently / keep doing]"]

  mcp__smartentry__write_memory key="session-[date]" value="[3-line summary of what changed today]"
  mcp__smartentry__write_memory key="last-session-state" value="[what was being built: file/feature] | [open issues] | [pending approvals] | [commits: last 3 hashes]"
  mcp__smartentry__log_note tag="SESSION-END" text="[what was built/fixed/learned — one paragraph]"

  If goal is set (check /goal show):
    Did today advance the goal? Update progress:
    mcp__smartentry__write_memory key="goal-progress-[date]" value="[progress toward goal today]"

═══ STEP 4 — TOMORROW'S PRIORITIES ═══
  Based on today's work, what needs to happen tomorrow?
  Write 3 priorities:
    mcp__smartentry__write_memory key="tomorrow-[date]" value="[priority 1 | priority 2 | priority 3]"

═══ REPORT ═══
LEARNING PERSISTED — [date]
━━━━━━━━━━━━━━━━━━━━━━━━
COMMITS TODAY: [list]
TRADES TODAY:  [count, WR, P&L]
LESSONS SAVED: [count]
GOAL PROGRESS: [advancing / blocked / no goal set]

TOMORROW'S PRIORITIES:
  [1] [top priority]
  [2] [second]
  [3] [third]
━━━━━━━━━━━━━━━━━━━━━━━━
Session closed cleanly. Next JARVIS boot will load these lessons.
