# SmartEntry Pro v14

Professional algorithmic trading dashboard powered by Claude AI (Opus).  
Monitors BTC, Gold (XAUUSD), and S&P 500 (SPY) 24/7 and executes trades automatically via MetaTrader 5.

---

## Features

- **Multi-timeframe analysis** — Daily + 4H + 1H alignment required before any signal fires
- **Claude AI signal approver** — Claude Opus evaluates every trade before execution in AUTO mode
- **Parallel AI brains** — 3 simultaneous Claude Opus instances, one dedicated per asset
- **Volume confirmation** — signal must have 1.4x average volume to be valid
- **DXY + VIX macro filter** — strong dollar / high fear reduces confidence automatically
- **Market regime detector** — TRENDING / RANGING / SQUEEZE / VOLATILE
- **Partial profit at 1R** — closes 50% of position, moves SL to breakeven
- **Trailing stop** — trails to +1R once 2R profit is reached
- **Risk circuit breaker** — halts trading after 3% daily loss or 3 consecutive losses
- **News filter** — 30-minute blackout around high-impact economic events
- **5/10-year backtest engine** — historical simulation with Claude Opus verdict
- **Trade journal** — logs every trade with AI commentary
- **Live dashboard** — real-time prices, charts, signals, MT5 positions

---

## Project Structure

```
ai-trading-dashboard/
├── START.bat              # One-click start (FULL-AUTO mode)
├── stop.bat               # Stop everything
├── run_all.bat            # Start with mode selection (semi/full-auto)
├── setup_autostart.bat    # Configure Windows boot auto-start
├── start_mt5.bat          # Start MT5 bridge only
├── mt5_bridge.py          # Python bridge to MetaTrader 5
├── server/
│   └── index.js           # Express.js backend (port 3001)
└── dashboard/
    └── index.html         # Trading dashboard UI
```

---

## Quick Start

### 1. Install dependencies
```
cd server
npm install
cd ..
pip install MetaTrader5 requests
```

### 2. Add your Anthropic API key
```
echo YOUR_API_KEY_HERE > server\apikey.txt
```

### 3. Start the system
```
START.bat
```

This starts the server, opens the dashboard at `http://localhost:3001`, and runs the MT5 bridge in full-auto mode.

### 4. Auto-start on Windows boot (optional)
```
setup_autostart.bat
```

---

## Trading Modes

| Command | Mode | Behaviour |
|---|---|---|
| `START.bat` | Full-auto | Strong signals execute automatically |
| `run_all.bat` → 1 | Semi-auto | Prompts Y/N before each trade |
| `run_all.bat` → 2 | Full-auto | Same as START.bat |

---

## Signal Logic

A signal fires only when **all** of the following are true:

1. Daily + 4H + 1H timeframes aligned (STRONG BUY or STRONG SELL)
2. Confidence score ≥ 65%
3. Volume ≥ 1.4x 20-bar average
4. No high-impact news in the next 30 minutes
5. Circuit breaker not triggered
6. Claude AI approves the trade (AUTO mode only)

---

## Risk Management

- Risk per trade: **1% of balance**
- Stop-loss: set before entry, no exceptions
- Partial profit: 50% closed at 1R, SL moved to breakeven
- Trailing stop: moves to +1R once 2R is reached
- Daily loss limit: **3%** — trading halts automatically
- Consecutive losses: **3** — trading halts automatically

---

## Requirements

- Windows 10/11
- Node.js 18+
- Python 3.10+
- MetaTrader 5 (with broker account)
- Anthropic API key (Claude Opus)

---

## Security

`server/apikey.txt` and `keys.env` are gitignored and never committed.
