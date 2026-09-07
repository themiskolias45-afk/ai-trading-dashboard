Force-execute a trade manually. Usage: /execute BTC LONG 105000 103500 107000
Arguments: [symbol] [direction] [entry] [stop] [target]

This bypasses the CONFIDENCE GATE. It does not bypass the risk guards, and must not.

Go through the MCP tools, never raw HTTP. This command used to POST to
`/api/execute-trade`, a route that does not exist — so it 404'd rather than traded —
and it hand-calculated its own lot size and invented a confidence of 100. Each of
those is a bug this project has already paid for once. The tools below are the same
guarded path the rest of the system uses; a second path drifts from the first, which
is how this codebase ended up with five copies of the confidence gate.

Steps:

1. Parse $ARGUMENTS: symbol, direction, entry, stop, target.
   Refuse if any is missing or unparseable. Do not guess a target from the entry.

2. `mcp__smartentry__get_risk_status` — read `halted` and `haltReason`.
   The field is `halted`. It is NOT `circuitBreakerOpen`; that name has never existed
   in the payload and three guards that used it silently never fired.
   If `halted` is true, REFUSE and quote `haltReason`. Do not offer to reset it.

3. `mcp__smartentry__size_position` with entry and stop — take the lots it returns.
   Never compute lots yourself. Sizing needs the instrument's contract size and the
   account currency; assuming 1.0 once made a Gold position 74x oversize.

4. Sanity-check before sending, and say the numbers out loud:
   - stop on the correct side of entry for the direction — refuse if inverted
   - stop more than 3% from entry: warn, and ask before continuing
   - reward:risk below 1.5 — say so; the live MIN_RR gate would reject it

5. State it in one line and get an explicit yes:
   "Executing: [SYMBOL] [DIRECTION] | Entry $X | Stop $X | Target $X | Risk $X | Lots X.XX"

6. `mcp__smartentry__execute_trade` with symbol, direction, entry, stop, target, lots,
   and `source: "manual"`.
   Do NOT pass `confidence: 100`. There is no model confidence for a hand-entered
   trade, and a fabricated one lands in the journal and then in the calibration table,
   where it becomes indistinguishable from a real reading. Leave it to the tool's
   default and let `source` mark what this was.

7. Report exactly what the tool returned, including `blocked` and `reason` if it
   refused. A refusal is a successful outcome of this command, not a failure to work
   around.

Never place a second order because the first "looked like it did not go through" —
check `mcp__smartentry__get_journal` first. Duplicate fills on one signal are the most
expensive mistake available here.
