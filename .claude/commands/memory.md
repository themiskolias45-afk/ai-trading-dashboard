JARVIS persistent memory — store, recall, and review what the system has learned.
Usage: /memory add KEY VALUE [CATEGORY] | /memory recall KEYWORD | /memory summary

$ARGUMENTS is the command. If blank, run summary.

Uses BOTH the memory MCP AND python memory.py for redundancy. If one fails, the other still works.

═══ /memory add KEY VALUE [CATEGORY] ═══
1. Store in memory MCP:
   mcp__memory__create_entities with:
     name: KEY
     entityType: CATEGORY (default: GENERAL)
     observations: [VALUE, timestamp]
2. Also run: python memory.py add KEY VALUE [CATEGORY]
3. Confirm: "[CATEGORY] KEY → VALUE stored."

═══ /memory recall KEYWORD ═══
1. Search memory MCP: mcp__memory__search_nodes with query=KEYWORD
2. Also run: python memory.py recall KEYWORD
3. Show all matches: category | date | key → value

═══ /memory summary ═══
1. mcp__memory__read_graph to get full memory graph
2. Also run: python memory.py summary
3. Show: total entries, count by category, 10 most recent entries

═══ /memory today ═══
Show entries added in the last 24 hours.

═══ /memory forget KEY ═══
1. mcp__memory__delete_entities with entityNames=[KEY]
2. Also run: python memory.py forget KEY
3. Confirm what was removed.

═══ CATEGORIES ═══
TRADE    — trade setups, outcomes, specific trade lessons
SYSTEM   — server/config decisions and changes
MARKET   — market observations, key levels, regime changes
CODE     — code fixes, patterns, bugs resolved
RISK     — risk rules, sizing decisions
LEARNING — strategy tuning, performance patterns
GENERAL  — anything else

After every session where something was built or learned:
USE /memory add automatically — do not wait for user to ask.

After showing memory, ask: "Want to add something? (or type a keyword to search)"
