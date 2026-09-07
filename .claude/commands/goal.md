Set, show, or clear the current system goal. Usage: /goal [set <objective> | show | clear]

The goal is the single most important thing SmartEntry Pro is working toward right now.
It persists across sessions via MCP memory. Every daily/weekly cycle checks progress against it.

═══ /goal set [objective] ═══
  Save the goal to persistent memory:
    mcp__smartentry__write_memory key="current-goal" value="[objective]"
    mcp__memory__create_entities with name="SystemGoal", type="goal", observations=["[objective] — set [date]"]

  Then immediately check current state against the goal:
    mcp__smartentry__get_performance → are we making progress?
    mcp__smartentry__get_signals → what's the current signal state?

  Report:
    GOAL SET: [objective]
    CURRENT STATE: [one sentence — are we close or far?]
    NEXT ACTION: [the single most important thing to do today to advance the goal]

═══ /goal show ═══
  mcp__smartentry__read_memory query="current-goal"
  mcp__memory__search_nodes query="SystemGoal"

  If goal exists:
    CURRENT GOAL: [objective]
    SET: [when]
    PROGRESS: [what's been done toward it — check recent memory entries]
    BLOCKING: [what's preventing progress right now]
    NEXT ACTION: [one sentence]

  If no goal:
    "No goal set. Set one with: /goal set [what you're working toward]"
    Examples:
      /goal set first live trade on BTC
      /goal set 70% win rate sustained over 10 trades
      /goal set H4+Daily BTC signal firing consistently

═══ /goal clear ═══
  mcp__smartentry__write_memory key="current-goal" value=""
  Report: "Goal cleared."

═══ GOAL EXAMPLES ═══
  /goal set first live trade executed on BTC
  /goal set win rate above 65% on 20+ trades
  /goal set all 3 assets firing within 30 days
  /goal set VPS and laptop fully synced and automated
