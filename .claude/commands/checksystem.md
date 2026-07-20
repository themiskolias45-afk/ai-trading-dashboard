Run a deep system check on SmartEntry Pro. Fetch http://localhost:3001/api/checksystem

Report in this format:

SYSTEM CHECK — [timestamp]
══════════════════════════
SERVER: ONLINE | Uptime: Xh Xm
SIGNALS: BTC:[signal] GOLD:[signal] SPX:[signal] (updated X min ago)
RISK: Daily P&L $X | Consecutive losses: X | Halted: YES/NO
MODE: [auto/semi-auto]

PERFORMANCE:
• Total trades: X | Win rate: X% | Total P&L: $X
• Recent form: X of last 5 are losses [ALERT if ≥3]

SELF-LEARNING (X sessions):
• [SETUP]: X% WR → [BOOSTED +X / PENALISED -X / LEARNING / NEUTRAL]
  (list all setups tracked)

CONFIDENCE CALIBRATION:
• 65-74%: X% actual WR [GOOD if close to 70%, OVERCONFIDENT if much lower]
• 75-84%: X% actual WR
• 85%+:   X% actual WR

IMPROVEMENT PROPOSAL: [if one exists, show worstSetup + winRate + ask if I want to implement it]

VERDICT: [ONE LINE — is the system healthy, what's the main concern]
