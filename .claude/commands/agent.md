Run a full autonomous agent cycle on SmartEntry Pro. Do all of this automatically without asking permission at each step:

STEP 1 — CHECK SYSTEM
Fetch http://localhost:3001/api/checksystem. Note any problems.

STEP 2 — CHECK SIGNALS
Fetch http://localhost:3001/api/signals. Check if any signal has confidence ≥ 65%.

STEP 3 — CHECK LEARNING
Fetch http://localhost:3001/api/learning. Identify any setup with WR < 40% over ≥ 5 trades.

STEP 4 — DECIDE ACTION
Based on what you found:
- If a setup has WR < 40% over ≥ 5 trades → propose tightening its entry criteria in server/index.js
- If confidence is miscalibrated (65-74% tier showing < 50% actual WR) → propose adjusting the confidence threshold
- If system is healthy → report that and suggest next improvement area

STEP 5 — IMPLEMENT (only if there is a clear improvement with low risk)
If you found something fixable: implement it, commit it, report what changed and expected impact.
If the fix is risky or unclear: describe it and ask for approval.

STEP 6 — REPORT
One paragraph: what you found, what you did (or propose), expected outcome.

This is full autonomous mode. Act like a senior engineer doing a system review.
