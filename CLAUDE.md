# CLAUDE.md — Smart Entry Pro Trading System

This file provides guidance for AI assistants working in this repository.

---

## Project Overview

**Smart Entry Pro V2** is a multi-asset algorithmic trading system combining:
- A **React dashboard** displaying live scalping signals for BTC, Gold, SP500, MSFT, Amazon.
- A **Node.js signal engine** that fetches 5-minute OHLCV data from Yahoo Finance, calculates
  technical indicators (EMA9/21, RSI14, ATR14, MACD), and produces BUY/SELL/HOLD signals
  with Entry, SL, TP1/TP2/TP3 levels and a confidence score.
- A **Telegram bot** for push alerts.
- An **MT5 Expert Advisor** (`mt5/SmartEntryPro_EA.mq5`) that polls the API and auto-trades.

---

## Repository Structure

```
ai-trading-dashboard/
├── src/
│   ├── main.jsx               # React entry point
│   ├── App.jsx                # Smart Entry Pro dashboard (live signals, table, cards)
│   └── bot.js                 # Legacy webhook bot (minimal, not the primary backend)
├── mt5/
│   └── SmartEntryPro_EA.mq5   # MT5 MQL5 Expert Advisor — polls API and trades
├── tkai_backend.js            # PRIMARY backend: signal engine + HTTP API + Telegram bot
├── index.html                 # HTML shell
├── vite.config.js             # Vite config — includes /api proxy to localhost:4000
├── package.json               # Dependencies and scripts
└── CLAUDE.md                  # This file
```

---

## Key Files

### `tkai_backend.js` — Signal Engine + API Server + Telegram Bot

The heart of the system. Runs with `npm run backend`.

**Signal generation pipeline:**
1. Fetch 5m OHLCV candles from Yahoo Finance for each asset.
2. Calculate `EMA(9)`, `EMA(21)`, `RSI(14)`, `ATR(14)`, `MACD(12,26,9)`.
3. Score each asset on 8 criteria (max ±8). Score ≥ +3 → BUY, ≤ -3 → SELL, else HOLD.
4. Calculate `Entry` (current price), `SL` (ATR×1.5), `TP1/TP2/TP3` (ATR×1/2/3.5).
5. Derive `confidence` percentage from score strength.
6. Cache results; refresh every 2 minutes via `node-cron`.

**HTTP API (port 4000):**
| Endpoint | Description |
|---|---|
| `GET /api/status` | System health + BTC & Gold price |
| `GET /api/signals` | All 5 asset signals (full data) |
| `GET /api/signal?asset=BTC` | Single asset signal |

**Telegram commands:**
`/start` · `/signals` · `/btc` · `/gold` · `/sp500` · `/msft` · `/amzn` · `/daily`

### `src/App.jsx` — Dashboard

- Fetches `/api/signals` (proxied via Vite in dev).
- Auto-refreshes every 2 minutes with a countdown timer.
- Shows: price bar, full signal table (Signal/Bias/Trend/Entry/SL/TP1/TP2/TP3/RSI/Conf), active signal cards.
- Color coding: green=BUY, red=SELL, gray=HOLD.
- All styling inline (dark theme `#0a0e1a`).

### `mt5/SmartEntryPro_EA.mq5` — MT5 Expert Advisor

- Written in MQL5 for MetaTrader 5.
- Uses `WebRequest()` to poll `/api/signal?asset=<ASSET>` every N seconds.
- Parses JSON response with simple string extraction.
- Opens/closes trades with risk-based lot sizing (default 1% risk/trade).
- Parameters: `InpApiBase`, `InpAsset`, `InpRiskPct`, `InpMinConfidence`, `InpTPLevel`, etc.
- **Setup required:** Tools → Options → Expert Advisors → Allow WebRequest → add your API URL.

### `vite.config.js`

Proxies `/api/*` → `http://localhost:4000` in development so the React app always uses
relative paths (`/api/signals`) without needing to know the backend port.

---

## Asset Coverage

| ID | Yahoo Symbol | MT5 Default Symbol | Description |
|---|---|---|---|
| BTC | BTC-USD | BTCUSD | Bitcoin/USD |
| GOLD | GC=F | XAUUSD | Gold Spot/Futures |
| SP500 | ^GSPC | US500 | S&P 500 Index |
| MSFT | MSFT | MSFT | Microsoft Corp |
| AMZN | AMZN | AMZN | Amazon.com Inc |

---

## Signal Logic

```
Score = 0
+ EMA9 > EMA21         → +2 (trend bullish)
+ Price > EMA21        → +1 (above mid MA)
+ RSI 50-70            → +1 (bull momentum)
- RSI 30-50            → -1 (bear momentum)
- RSI ≥ 70             → -2 (overbought)
+ RSI ≤ 30             → +2 (oversold)
+ Last candle bullish  → +1
+ MACD histogram > 0   → +1

Signal:
  Score ≥ +3  → BUY   (BULLISH)
  Score ≤ -3  → SELL  (BEARISH)
  else        → HOLD  (NEUTRAL)

Confidence = (|score| / 8) × 100  [clamped 30–95%]

Levels (BUY):  SL = Entry - ATR×1.5,  TP1/TP2/TP3 = Entry + ATR × 1/2/3.5
Levels (SELL): SL = Entry + ATR×1.5,  TP1/TP2/TP3 = Entry - ATR × 1/2/3.5
```

---

## Development Workflow

### Prerequisites
- Node.js v18+
- npm
- MetaTrader 5 (for EA only)

### Install
```bash
npm install
```

### Run the backend (in one terminal)
```bash
npm run backend
# Starts signal engine + API on :4000 + Telegram polling
```

### Run the frontend (in another terminal)
```bash
npm run dev
# Vite dev server at http://localhost:5173
# /api/* proxied → localhost:4000
```

### Build for production
```bash
npm run build
# Output → dist/
```

---

## Architecture & Conventions

### Language & Modules
- JavaScript only — no TypeScript.
- ES modules (`import`/`export`) throughout — `"type": "module"` in `package.json`.
- JSX in `.jsx` files.

### Frontend
- React 18, functional components + hooks only — no class components.
- State: `useState` / `useEffect` / `useCallback` — no Redux, Zustand, or Context.
- HTTP: native `fetch` only — no Axios.
- Styling: **inline JS style objects only** — no CSS files, no CSS modules, no Tailwind.
- Charts: `recharts` (available but currently unused — ready for future use).

### Backend
- `node-fetch` for HTTP calls (Yahoo Finance, Telegram, CoinGecko).
- `node-cron` for scheduled signal refresh.
- Built-in `http` module for API server (no Express dependency).

### No testing, no linting
- No test runner, no ESLint, no Prettier.
- Follow existing style: 2-space indent, single quotes, concise inline functions.

---

## MT5 Setup

1. Copy `mt5/SmartEntryPro_EA.mq5` to your MT5 `Experts` folder.
2. Compile in MetaEditor (F7).
3. In MT5: **Tools → Options → Expert Advisors** → check **Allow WebRequest** → add `http://localhost:4000` (or your deployed API URL).
4. Attach to any chart. Set inputs:
   - `InpApiBase` — API URL (e.g., `http://localhost:4000` or deployed URL)
   - `InpAsset` — one of: `BTC`, `GOLD`, `SP500`, `MSFT`, `AMZN`
   - `InpMtSymbol` — your broker's symbol name (e.g., `XAUUSD` for Gold)
   - `InpRiskPct` — risk per trade (default 1%)
   - `InpMinConfidence` — only trade if confidence ≥ this value (default 60%)
   - `InpTPLevel` — 1, 2, or 3 (default 2 = TP2)
5. Use `InpEnableTrading = false` for simulation/testing first.

> **Note:** Attach one EA instance per asset (each needs its own chart and `InpAsset`).

---

## External APIs

| API | Usage | Auth | Notes |
|---|---|---|---|
| Yahoo Finance | 5m OHLCV candles (all assets) | None | Unofficial — may require User-Agent header |
| CoinGecko | Legacy BTC price (removed from main flow) | None | Kept as fallback option |
| Telegram Bot API | Send alerts, receive commands | Bot token | Polling mode, no webhook |

---

## Security Issues (Fix Before Production)

**Hardcoded Telegram bot token** in `tkai_backend.js` and `src/bot.js`:
```js
// Replace with:
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
```

Create `.env` (add to `.gitignore`):
```
TELEGRAM_TOKEN=your_token_here
PORT=4000
```

---

## Improvement Roadmap

### Phase 1 — DONE ✅
- Multi-asset signal engine (BTC, Gold, SP500, MSFT, AMZN)
- EMA9/21 + RSI14 + ATR14 + MACD indicators
- Entry / SL / TP1 / TP2 / TP3 calculation
- Confidence scoring
- HTTP API (`/api/signals`, `/api/signal?asset=`)
- Smart Entry Pro dashboard with signal table + cards
- MT5 Expert Advisor

### Phase 2 — Next
- [ ] AI trade explanation via Claude API (why BUY/SELL, key levels)
- [ ] Win/loss trade tracker (in-memory → file persistence)
- [ ] Backtesting mode (replay historical signals)
- [ ] Multi-timeframe confluence (1m + 5m + 15m)
- [ ] Token-gated dashboard (simple API key auth)

### Phase 3 — Future
- [ ] Binance live execution (bypass MT5)
- [ ] Portfolio risk monitor (total open exposure)
- [ ] Smart Trade Planner AI (position sizing advisor)
- [ ] Mobile push notifications
- [ ] Docker + CI/CD pipeline

---

## Common Gotchas

- Yahoo Finance is an unofficial API. If it goes down, signals will show `ERROR`. Consider
  adding a paid fallback (Twelve Data, Polygon.io, Alpha Vantage).
- `tkai_backend.js` and `src/bot.js` must NOT run simultaneously — they share the same
  Telegram token and will conflict.
- `node-fetch` v3 is ESM-only — never use `require()` to import it.
- The MT5 EA requires explicit WebRequest permission in MT5 settings.
- MT5 symbol names vary by broker (`XAUUSD` vs `GOLD` vs `GOLD.m` etc.) — set `InpMtSymbol`
  to match your broker exactly.

---

## Git Conventions

- Branch format: `claude/<description>-<id>` for AI-assisted branches.
- Short, imperative commit messages.
- Main branch: `master`.
