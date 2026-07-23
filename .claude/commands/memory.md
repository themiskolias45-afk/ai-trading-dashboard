JARVIS persistent memory — store, recall, and review what the system has learned across sessions.

$ARGUMENTS is the command. If blank, show recent memory.

Commands:
  /memory add KEY VALUE [CATEGORY]   — store a fact, decision, or lesson
  /memory recall KEYWORD             — search memory by keyword
  /memory today                      — show what was stored today
  /memory summary                    — full memory overview by category
  /memory forget KEY                 — remove an entry

Run the matching command:
```
python memory.py $ARGUMENTS
```

If $ARGUMENTS is blank, run: python memory.py summary

Then format the output clearly:

For SUMMARY: show count by category, then the 5 most recent entries.
For RECALL: list matches with their category tag and date.
For ADD: confirm what was stored: "[CATEGORY] KEY → VALUE"
For FORGET: confirm what was removed.

Memory categories:
  TRADE    — trade setups, outcomes, specific trade lessons
  SYSTEM   — server/config decisions and changes
  MARKET   — market observations, key levels, regime changes
  CODE     — code fixes, patterns, bugs resolved
  RISK     — risk rules, sizing decisions
  LEARNING — strategy tuning, performance patterns
  GENERAL  — anything else

After showing memory, ask: "Want to add something to memory? (or type a keyword to search)"
