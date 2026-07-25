Fetch live signals and sentiment context. In parallel:
- Fetch http://localhost:3001/api/signals
- Fetch http://localhost:3001/api/risk-status
- Fetch http://localhost:3001/api/sentiment

Report in this exact format:

**BTC** — [SIGNAL] [SETUP] [confidence]% | Entry $X | Stop $X | Target $X | R/R 1:X
**GOLD** — [SIGNAL] [SETUP] [confidence]% | Entry $X | Stop $X | Target $X | R/R 1:X
**SPX** — [SIGNAL] [SETUP] [confidence]% | Entry $X | Stop $X | Target $X | R/R 1:X

Fear & Greed: [score] ([classification]) | Regime: [regime] | Session: [session] | News blackout: YES/NO

If confidence < 65% say WAIT instead of trade levels.
If Fear & Greed is Extreme Fear (<20) or Extreme Greed (>80), add one sentence warning.
One line per asset, no fluff.
