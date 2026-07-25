Run a full autonomous improvement loop on SmartEntry Pro. Runs continuously until all issues are resolved.

Do everything automatically without asking permission at each step. Act like a senior engineer doing a full system audit.

═══ LOOP — repeat until nothing left to fix ═══

ROUND START: fetch all system data in parallel:
- GET http://localhost:3001/api/checksystem
- GET http://localhost:3001/api/signals
- GET http://localhost:3001/api/learning
- GET http://localhost:3001/api/healer
- GET http://localhost:3001/api/risk-status

EVALUATE — check all of these:
1. Any setup with win rate < 40% over ≥ 5 trades → tighten entry criteria in server/index.js
2. Confidence miscalibrated (65-74% tier with < 50% actual WR) → adjust threshold
3. Healer reporting stale data → force heal: POST http://localhost:3001/api/healer/heal
4. Any server error in checksystem → find root cause and fix it
5. Risk gate tripped when it shouldn't be (or vice versa) → fix risk logic
6. Any signal engine producing WAIT when market is trending clearly → fix signal logic
7. Any endpoint returning errors → fix the endpoint

FOR EACH ISSUE FOUND:
- If fix is clear and low-risk → implement it immediately, commit, note what changed
- If fix is risky or changes core logic → describe it, show the proposed diff, ask for approval
- If no fix needed → mark as healthy and move on

AFTER EACH ROUND:
- Re-fetch all data and check if the fix worked
- If new issues appeared → run another round
- If everything is clean → stop and report

═══ FINAL REPORT ═══
Report in this format:
- Issues found: [list]
- Fixed automatically: [list with commit hashes]
- Awaiting approval: [list with proposed changes]
- System status: HEALTHY / NEEDS ATTENTION

This is full autonomous mode — keep looping until the system is clean.
Maximum 5 rounds before stopping and reporting.
