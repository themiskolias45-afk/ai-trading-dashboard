# CLAUDE.md — AI Trading Dashboard

This file provides guidance for AI assistants working in this repository.

---

## Project Overview

**AI Trading Dashboard** is a React + Node.js application that combines:
- A React frontend for displaying live cryptocurrency trading data (BTC price, gold price, bot status).
- A Node.js Telegram bot backend that fetches BTC data from CoinGecko and provides market analysis via Telegram commands.

The frontend reads from a deployed backend at `https://tkai-backend.onrender.com`.

---

## Repository Structure

```
ai-trading-dashboard/
├── src/
│   ├── main.jsx          # React app entry point — mounts <App /> into #root
│   ├── App.jsx           # Main dashboard component — fetches + displays trading data
│   └── bot.js            # Alternative webhook-based Telegram bot (Express.js, port 3000)
├── tkai_backend.js       # Primary polling-based Telegram bot + backend server
├── index.html            # HTML shell — <div id="root"> mount point
├── vite.config.js        # Vite configuration (React plugin, dist/ output)
├── package.json          # Dependencies and npm scripts
└── README.md             # Minimal notes (currently near-empty)
```

---

## Key Files

### `src/App.jsx`
- Single React functional component using `useState` + `useEffect`.
- On mount, fetches `https://tkai-backend.onrender.com/api/status`.
- Expected response shape: `{ status, btc, gold, updated }`.
- Inline dark-theme styles (`#0b0f1a` background, white text).
- Displays loading state, error state, and dashboard data.

### `tkai_backend.js`
- **Primary backend** — run with `npm run backend`.
- Polls Telegram API every 3 seconds (no webhook required).
- Commands supported: `/start`, `/btc` (or `btc`), `/daily`.
- Fetches live BTC data from CoinGecko: `https://api.coingecko.com/api/v3/simple/price`.
- Calculates trading bias (BULLISH / BEARISH / NEUTRAL) from 24h price change.
- Exposes `/api/status` endpoint consumed by the React frontend.

### `src/bot.js`
- Alternative, minimal webhook-based bot using Express.js.
- Only handles `/start` command.
- Listens on `PORT` env var (default 3000).
- Webhook path: `POST /webhook/<TELEGRAM_TOKEN>`.
- Less feature-complete than `tkai_backend.js`; treat as supplementary.

---

## Development Workflow

### Prerequisites
- Node.js (v18+ recommended for ES module support)
- npm

### Install dependencies
```bash
npm install
```

### Run the frontend (Vite dev server)
```bash
npm run dev
```

### Run the backend bot
```bash
npm run backend
# Equivalent to: node tkai_backend.js
```

### Build for production
```bash
npm run build
# Output goes to dist/
```

### Preview production build
```bash
npm run preview
```

> There is **no single command** to start both frontend and backend simultaneously. Run them in separate terminals.

---

## Architecture & Conventions

### Language & Modules
- JavaScript only — **no TypeScript**.
- ES module syntax (`import`/`export`) throughout — `"type": "module"` in `package.json`.
- JSX used in React files (`.jsx` extension).

### Frontend
- React 18 with **functional components and hooks only** — no class components.
- State management via `useState` / `useEffect` — no Redux, Zustand, or Context API.
- HTTP calls use the native `fetch` API — no Axios or other HTTP libraries.
- Styling is done with **inline JavaScript style objects** — no CSS files, no CSS modules, no Tailwind.
- Charts use **Recharts** (`recharts` package).

### Backend
- `tkai_backend.js` uses `node-fetch` for external HTTP calls (CoinGecko, Telegram).
- Scheduled tasks use `node-cron`.
- `src/bot.js` uses Express.js (listed as a dependency in package.json via implied usage — verify if `express` is installed before extending it).

### No testing infrastructure
- There are **no test files, no test runner, and no test scripts** configured.
- When adding features, manually verify behavior.

### No linting or formatting tooling
- No ESLint, Prettier, or similar tools are configured.
- Follow the existing code style: 2-space indentation, single quotes, concise inline functions.

---

## External APIs

| API | Usage | Auth |
|-----|-------|------|
| CoinGecko (`api.coingecko.com`) | BTC/USD price + 24h change | None (public) |
| Telegram Bot API | Polling + send messages | Bot token |
| Render backend (`tkai-backend.onrender.com`) | Frontend data source | None |

---

## Security Issues (Must Fix Before Production)

**Hardcoded Telegram bot token** exists in two files:
- `tkai_backend.js`
- `src/bot.js`

This token should be moved to an environment variable immediately:

```js
// Replace hardcoded token with:
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
```

Then create a `.env` file (and add it to `.gitignore`):
```
TELEGRAM_TOKEN=your_token_here
```

Do **not** commit `.env` files or real credentials to the repository.

---

## Common Gotchas

- The frontend fetches data from the **deployed** Render backend, not a local server. If the backend is down, the dashboard will show an error.
- `tkai_backend.js` and `src/bot.js` are **two separate bot implementations** — only one should be running at a time to avoid duplicate Telegram message handling.
- The `README.md` contains only a single line of developer notes and should not be treated as authoritative documentation — refer to this file instead.
- `node-fetch` v3 is ESM-only; do not use `require()` to import it.

---

## Deployment

- **Frontend**: Built with Vite → `dist/` directory. Can be hosted on any static host (Netlify, Vercel, GitHub Pages, etc.).
- **Backend**: Deployed on [Render](https://render.com) at `tkai-backend.onrender.com`. Run with `node tkai_backend.js`.
- No Docker, CI/CD, or infrastructure-as-code configuration currently exists.

---

## Git Conventions

- Branch format observed: `claude/<description>-<id>` for AI-assisted branches.
- Commit messages are short and imperative (e.g., `"Create bot.js"`, `"Update tkai_backend.js"`).
- Main development branch: `master`.
