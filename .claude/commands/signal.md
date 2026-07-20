Fetch http://localhost:3001/api/signals and http://localhost:3001/api/risk-status.

Report in this exact format — one block per asset:

**BTC** — [SIGNAL] [SETUP] [confidence]% | Entry $X | Stop $X | Target $X | R/R 1:X
**GOLD** — [SIGNAL] [SETUP] [confidence]% | Entry $X | Stop $X | Target $X | R/R 1:X
**SPX** — [SIGNAL] [SETUP] [confidence]% | Entry $X | Stop $X | Target $X | R/R 1:X

Risk status: [regime] | Session: [session] | News blackout: YES/NO

If confidence < 65% say WAIT instead of the trade levels. One line per asset, no fluff.
