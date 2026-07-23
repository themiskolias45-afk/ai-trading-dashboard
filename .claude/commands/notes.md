JARVIS daily notes — log events, view today's session, and auto-sync from server.

$ARGUMENTS is the command. If blank, shows today's notes.

Commands:
  /notes                    — show today's full log
  /notes log "text"         — add a manual note (freeform)
  /notes auto               — pull today's signals/trades/healer status from server and log them
  /notes yesterday          — show yesterday's log
  /notes summary            — last 7 days overview

Run the matching command:
```
python daily_notes.py $ARGUMENTS
```

If $ARGUMENTS is blank, run: python daily_notes.py today

Format the output:

**DAILY LOG — [date]**

SIGNALS today: [list any signals with direction, confidence, entry levels]
TRADES today: [list any closed trades with outcome and P&L]
LOG ENTRIES: [chronological list — timestamp | tag | text]

If the log is empty: "No entries yet today. Run /notes auto to pull from server."

After showing today's note, offer: "Want to log something? (type it, or type 'auto' to sync from server)"
