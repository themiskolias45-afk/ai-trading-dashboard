Clean up and optimize a file. Usage: /refactor [filename]

$ARGUMENTS is the file path.

Read the full file first, then apply these in order:

1. DEAD CODE — remove anything that is never called, never reached, or commented out
2. DUPLICATE CODE — if the same logic appears twice, extract it into one function
3. NAMING — rename any variable/function that doesn't clearly say what it holds/does
   (bad: data, result, temp, x, val / good: signalConfidence, tradeEntry, setupWinRate)
4. FUNCTION SIZE — any function over 40 lines does too many things. Split it.
5. ERROR HANDLING — every async call, every file read, every API call must handle failure
6. MAGIC NUMBERS — replace raw numbers with named constants at the top of the file
7. SIMPLIFY — if a condition can be written in half the lines without losing clarity, do it

Rules:
- Do NOT change behavior. Only change structure.
- Do NOT add features. This is cleanup only.
- After each change, verify the call paths still work correctly.
- Run node --check (JS) or python -m py_compile (Python) after each edit — actually run it, not mentally.

Report:
- Lines removed: X
- Functions split: X
- Names improved: X
- Dead code removed: [what]
- Behavior changed: NONE

After all changes verified:
  git add [specific file] && git commit -m "refactor: [what was cleaned up in file]"
