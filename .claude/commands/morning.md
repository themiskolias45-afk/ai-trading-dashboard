Run the morning briefing for SmartEntry Pro. Do this in order — no steps skipped:

1. Load memory context: run `python memory.py summary` — note the most recent TRADE and MARKET entries
2. Load yesterday's notes: run `python daily_notes.py yesterday` — note any open signals or trades from yesterday
3. Auto-log today's start: run `python daily_notes.py auto` to sync server data into today's note
4. Fetch http://localhost:3001/api/signals
5. Fetch http://localhost:3001/api/risk-status
6. Fetch http://localhost:3001/api/journal (last 10 trades)

Then deliver the morning brief in this format:

---
SMARTENTRY PRO — MORNING BRIEF [today's date]
---

FROM MEMORY:
• [1-2 most relevant facts from memory — open trades, pending setups, risk notes]

YESTERDAY RECAP:
• [from yesterday's daily note — any signals that fired, trades closed, lessons]

MARKET REGIME: [regime] | SESSION: [session] | NEWS: [any blackout?]

SIGNALS READY:
• BTC:  [signal + setup + confidence% — entry/stop/target if signal, WAIT if not]
• GOLD: [signal + setup + confidence% — entry/stop/target if signal, WAIT if not]
• SPX:  [signal + setup + confidence% — entry/stop/target if signal, WAIT if not]

RECENT PERFORMANCE (last 10 trades):
• Win rate: X% | P&L: $X | [any streak worth noting]

TOP PRIORITY TODAY:
• [one sentence — the single most important thing to watch or act on]
---

Keep it tight. No fluff. This is the daily trading plan.
After the brief, ask: "Run a full scan? (Y/N)"
