Save or restore the full JARVIS session state. Usage: /state save | /state load | /state show

$ARGUMENTS is: save, load, or show.

═══ /state save ═══
Save everything about this session to tasks/jarvis-state.json:
1. What was being worked on (current task, file being edited)
2. What was found (signals, issues, research results)
3. What was decided (architecture decisions, trade decisions)
4. What's next (pending tasks, approvals needed, open questions)
5. Last 10 git commits (session work summary)
6. Current signal state (BTC/Gold/SPX confidence + signal)
7. Any open issues that weren't fixed yet

Format:
{
  "saved": "[ISO timestamp]",
  "working_on": "[description]",
  "found": ["finding 1", "finding 2"],
  "decided": ["decision 1"],
  "next": ["task 1", "task 2"],
  "open_issues": ["issue 1"],
  "commits": ["hash message", ...],
  "signals": { "btc": {...}, "gold": {...}, "spx": {...} }
}

Report: "State saved. Next session: /state load to resume exactly here."

═══ /state load ═══
If tasks/jarvis-state.json does not exist: output "No saved state found. Run /state save first." and stop.
Read tasks/jarvis-state.json and resume:
1. Report what was saved: when, what was being worked on
2. Show what's next: pending tasks in priority order
3. Fetch current signals and compare with saved state (what changed?)
4. Pick up from where the last session left off
5. Ask: "Resume working on [last task]? (Y/N)"

═══ /state show ═══
Print the current state file contents in a readable format.
If no state file exists, say so and offer to create one.

═══ /state checkpoint [label] ═══
Capture a timestamped snapshot and append it to tasks/jarvis-state-history.jsonl.
Use before major changes (deploys, strategy edits, refactors) so state is auditable.

1. Gather current state exactly as /state save (steps 1-7 above)
2. Add "label": "[label or 'checkpoint']" field to the object
3. Append as a single JSON line to tasks/jarvis-state-history.jsonl (create file if missing)
   — one line per checkpoint, each self-contained — never overwrite existing lines
4. Also overwrite tasks/jarvis-state.json with this snapshot (same as /state save)
5. Report: "Checkpoint '[label]' saved — [N] total checkpoints in history."

To review history: read tasks/jarvis-state-history.jsonl and show each checkpoint's
  saved, label, working_on, and commits fields in a table.
