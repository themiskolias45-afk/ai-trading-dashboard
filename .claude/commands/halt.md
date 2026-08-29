Emergency stop — kill all active agents and pause automation. Usage: /halt

This is the kill-switch. One command stops everything. Use when:
- An autonomous loop is doing something unexpected
- /profit or /agent is running and you want it stopped NOW
- You see a risk event and need all AI activity frozen immediately

═══ STEP 1 — STOP ALL ACTIVE AGENTS ═══
  TaskList → get all in-progress tasks
  For each in-progress task: TaskUpdate status=cancelled reason="HALT command issued"
  Report: "[N] agents stopped."

═══ STEP 2 — FREEZE AUTOMATION FLAG ═══
  Write to tasks/jarvis-halt.json:
  { "halted": true, "reason": "$ARGUMENTS or 'manual halt'", "ts": "[ISO timestamp]" }
  
  mcp__smartentry__write_memory key="jarvis-halt" value="HALTED at [timestamp] — [reason]"
  mcp__smartentry__log_note tag="HALT" text="HALT issued at [timestamp] — [reason]. All agents stopped."

═══ STEP 3 — CHECK FOR OPEN TRADES ═══
  mcp__smartentry__get_risk_status → check halted, open positions
  If trading is LIVE (positions open):
    Report: "⚠ WARNING: [N] position(s) open. Bridge continues — broker SL/TP remain live.
             HALT only stops AI agents. To halt trading execution: 
             GET http://localhost:3001/api/risk-status and check circuit breaker."
  If no positions: "Trading: no open positions."

═══ STEP 4 — REPORT ═══
HALT COMPLETE — [timestamp]
━━━━━━━━━━━━━━━━━━━━━━━━
AGENTS STOPPED:   [N]
REASON:           [reason or 'manual']
OPEN POSITIONS:   [N — bridge still running, SL/TP live]
AUTOMATION FLAG:  tasks/jarvis-halt.json written
━━━━━━━━━━━━━━━━━━━━━━━━
To resume: delete tasks/jarvis-halt.json and run /status

NOTE: The MT5 bridge is NOT stopped by this command. It continues managing open positions.
      SL and TP stay live on the broker. To stop the bridge: use tasks/safe_bridge_restart.cjs --dry-run first.
      Never kill the bridge with open positions — the broker SL remains live but the trailing ladder stops.
