Episodic memory recall — find similar past trades and surface the pattern.
Usage: /recall [symbol] [setup] [direction] — e.g. /recall Gold squeeze long

$ARGUMENTS is the trade context to search for. If blank, use the current live signal.

═══ STEPS ═══

1. If $ARGUMENTS is blank, fetch http://localhost:3001/api/signals and use the
   highest-confidence asset as context: "[symbol] [direction] [setup]".

2. Run: python tasks/rag_recall.py "$ARGUMENTS" --top 5

3. Parse and surface the output:
   - Pattern verdict (BULLISH / BEARISH / MIXED / INSUFFICIENT) in bold
   - Each past trade: date | symbol | direction | outcome — one line each
   - Summary win rate
   - If INSUFFICIENT: say "fewer than 3 similar trades on record — not enough to judge"

4. Interpret the pattern:
   - ≥ 60% wins: "Historical edge supports this direction."
   - ≤ 40% wins: "Historical edge argues against this direction."
   - MIXED: "Past similar trades split — no clear directional edge."
   - INSUFFICIENT: "Not enough history yet — judge on setup merit alone."

5. End with one line: "Recall complete. [N] similar episodes found."

WHAT THIS DOES NOT DO:
- Never changes the signal, gate, or confidence
- Never blocks a trade based on recall — it is context, not a gate
- Never modifies journal, learning, or any data file
