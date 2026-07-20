Run the morning briefing for SmartEntry Pro. Do this in order:

1. Fetch http://localhost:3001/api/signals
2. Fetch http://localhost:3001/api/risk-status
3. Fetch http://localhost:3001/api/journal (last 10 trades)

Then deliver the morning brief in this format:

---
SMARTENTRY PRO — MORNING BRIEF [today's date]
---

MARKET REGIME: [regime] | SESSION: [session] | NEWS: [any blackout?]

SIGNALS READY:
• BTC: [signal] [setup] [confidence]% — [entry/stop/target if signal, WAIT if not]
• GOLD: [signal] [setup] [confidence]% — [entry/stop/target if signal, WAIT if not]
• SPX: [signal] [setup] [confidence]% — [entry/stop/target if signal, WAIT if not]

RECENT PERFORMANCE (last 10 trades):
• Win rate: X% | P&L: $X

TOP PRIORITY TODAY: [one sentence — what to watch or act on]
---

Keep it tight. No fluff. This is the daily trading plan.
