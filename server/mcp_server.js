'use strict';
/**
 * SmartEntry Pro — MCP Server v2
 * 19 native tools. Claude calls these directly — no HTTP fetches, no subprocesses in prompts.
 *
 * READ TOOLS (instant):
 *   get_signals          — live BTC / GOLD / SPX (S&P 500) signals
 *   get_risk_status      — regime, circuit breaker, daily P&L, news blackout
 *   get_healer           — 6-point system health check
 *   get_journal          — trade history with filters
 *   get_learning         — setup win rates and calibration
 *   get_performance      — aggregate stats: WR, P&L, best/worst setup, equity curve
 *   read_memory          — search JARVIS persistent memory
 *   get_daily_note       — read today's or any date's session log
 *   analyze_symbol       — deep compound analysis (signals + learning + journal in 1 call)
 *
 * WRITE TOOLS:
 *   write_memory         — store a fact / lesson / decision permanently
 *   log_note             — append to today's session log
 *   send_alert           — push toast / email / webhook notification
 *   force_heal           — trigger auto-healer immediately
 *
 * ACTION TOOLS (slow — run AI agents):
 *   run_debate           — 3-agent Bull/Bear/Risk debate → TAKE or SKIP
 *   size_position        — Kelly-based lot size + trade validation
 *   execute_trade        — send trade to MT5 bridge (with circuit breaker guard)
 *   screenshot_chart     — take chart screenshot + Claude Vision analysis
 *   run_scan             — parallel multi-asset opportunity scan
 *   full_trade_workflow  — compound: scan → debate → size → execute → alert → log
 */

const readline  = require('readline');
const https     = require('https');
const http      = require('http');
const path      = require('path');
const fs        = require('fs');
const { execFile } = require('child_process');

const ROOT       = path.join(__dirname, '..');
const SERVER_URL = 'http://localhost:3001';
const PYTHON     = process.platform === 'win32' ? 'python' : 'python3';

// ── Cache (30 s TTL for frequently-polled endpoints) ─────────────────────────

const _cache = new Map();

function cached(key, ttlMs, fn) {
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.ts < ttlMs) return Promise.resolve(hit.value);
  return fn().then(v => { _cache.set(key, { value: v, ts: Date.now() }); return v; });
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

function fetchJSON(urlPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const fullUrl = SERVER_URL + urlPath;
    const lib     = fullUrl.startsWith('https') ? https : http;
    const req     = lib.request(
      fullUrl,
      { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json' }, timeout: 6000 },
      (res) => {
        let body = '';
        res.on('data', d => (body += d));
        res.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch (_) { resolve({ _raw: body }); }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`timeout fetching ${urlPath}`)); });
    if (opts.body) req.write(JSON.stringify(opts.body));
    req.end();
  });
}

// ── Python runner ─────────────────────────────────────────────────────────────

function runPython(script, args = [], timeout = 60000) {
  return new Promise((resolve, reject) => {
    execFile(
      PYTHON, [path.join(ROOT, script), ...args],
      { cwd: ROOT, timeout, env: { ...process.env, NO_COLOR: '1' } },
      (err, stdout, stderr) => {
        const out = (stdout || '').trim() || (stderr || '').trim();
        if (err && !out) reject(new Error(stderr || err.message));
        else resolve(out);
      }
    );
  });
}

// ── Parallel fetch helper ─────────────────────────────────────────────────────

async function fetchParallel(paths) {
  const results = await Promise.allSettled(paths.map(p => fetchJSON(p)));
  return results.map(r => (r.status === 'fulfilled' ? r.value : { _error: r.reason?.message }));
}

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS = [

  // ─────────────── READ TOOLS ────────────────────────────────────────────────

  {
    name: 'get_signals',
    description:
      'Get live trading signals for BTC (Bitcoin), GOLD, and SPX (S&P 500). ' +
      'Returns signal direction (LONG/SHORT/WAIT), confidence %, entry, stop, target, setup name, and last-updated time. ' +
      'Cached 30 s — use this before any trade decision.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'btc | gold | spx — omit for all three' },
      },
    },
    async handler({ symbol } = {}) {
      const data = await cached('signals', 30000, () => fetchJSON('/api/signals'));
      if (symbol) return data[symbol.toLowerCase()] ?? { error: `No signal for ${symbol.toUpperCase()}` };
      return data;
    },
  },

  {
    name: 'get_risk_status',
    description:
      'Get current risk management status: market regime (BULL/BEAR/NEUTRAL), ' +
      'circuit breaker state (fires after 3 consecutive losses), daily P&L, news blackout windows, ' +
      'trading session (London/NY/Asian), and max daily loss limit.',
    inputSchema: { type: 'object', properties: {} },
    async handler() {
      return cached('risk', 30000, () => fetchJSON('/api/risk-status'));
    },
  },

  {
    name: 'get_healer',
    description:
      'Get auto-healer status. Runs 6 checks: signal freshness, price freshness, ' +
      'learning file, journal file, memory usage, and error rate. ' +
      'healthy=true means all checks green. Use this to confirm system is ready to trade.',
    inputSchema: { type: 'object', properties: {} },
    async handler() {
      return cached('healer', 30000, () => fetchJSON('/api/healer'));
    },
  },

  {
    name: 'get_journal',
    description:
      'Get trade journal entries. Each entry has: symbol, direction, setup, entry/stop/target prices, ' +
      'P&L, outcome (WIN/LOSS/BREAKEVEN), and timestamp. Use to review recent performance.',
    inputSchema: {
      type: 'object',
      properties: {
        limit:   { type: 'number',  description: 'Max entries (default 20, max 100)' },
        symbol:  { type: 'string',  description: 'Filter by symbol e.g. BTC' },
        outcome: { type: 'string',  enum: ['WIN', 'LOSS', 'BREAKEVEN'] },
      },
    },
    async handler({ limit = 20, symbol, outcome } = {}) {
      let url = `/api/journal?limit=${Math.min(limit, 100)}`;
      if (symbol)  url += `&symbol=${encodeURIComponent(symbol)}`;
      if (outcome) url += `&outcome=${encodeURIComponent(outcome)}`;
      return fetchJSON(url);
    },
  },

  {
    name: 'get_learning',
    description:
      'Get self-learning engine data: per-setup win rates, confidence calibration ' +
      '(does 85% confidence really produce 85% WR?), boost/penalty applied to each setup, ' +
      'and total sessions tracked.',
    inputSchema: { type: 'object', properties: {} },
    async handler() {
      return cached('learning', 60000, () => fetchJSON('/api/learning'));
    },
  },

  {
    name: 'get_performance',
    description:
      'Get aggregate trading performance: total trades, win rate %, gross and net P&L, ' +
      'average win/loss size, expectancy per trade, best and worst setups, ' +
      'and consecutive loss/win streaks.',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Lookback in days (default 30)' },
      },
    },
    async handler({ days = 30 } = {}) {
      const [stats, journal] = await fetchParallel([
        '/api/stats/by-setup',
        `/api/journal?limit=500`,
      ]);

      const raw    = journal;
      const trades = Array.isArray(raw) ? raw : Array.isArray(raw?.journal) ? raw.journal : [];
      const cutoff = new Date(Date.now() - days * 86400000).toISOString();
      const recent = trades.filter(t => (t.opened_at || t.openTime || '') >= cutoff);

      const wins   = recent.filter(t => t.pnl > 0).length;
      const losses = recent.filter(t => t.pnl < 0).length;
      const total  = wins + losses;
      const pnls   = recent.map(t => t.pnl ?? 0);
      const grossPnl = pnls.reduce((a, b) => a + b, 0);

      const winPnls  = recent.filter(t => t.pnl > 0).map(t => t.pnl ?? 0);
      const lossPnls = recent.filter(t => t.pnl < 0).map(t => t.pnl ?? 0);
      const avgWin   = winPnls.length ? winPnls.reduce((a, b) => a + b, 0) / winPnls.length : 0;
      const avgLoss  = lossPnls.length ? lossPnls.reduce((a, b) => a + b, 0) / lossPnls.length : 0;

      // Max streak
      let maxWinStreak = 0, maxLossStreak = 0, curW = 0, curL = 0;
      for (const t of recent) {
        if (t.pnl > 0) { curW++; curL = 0; maxWinStreak  = Math.max(maxWinStreak,  curW); }
        if (t.pnl < 0) { curL++; curW = 0; maxLossStreak = Math.max(maxLossStreak, curL); }
      }

      return {
        period_days:       days,
        total_trades:      total,
        wins,
        losses,
        win_rate_pct:      total ? Math.round(wins / total * 1000) / 10 : 0,
        gross_pnl:         Math.round(grossPnl * 100) / 100,
        avg_win:           Math.round(avgWin * 100) / 100,
        avg_loss:          Math.round(avgLoss * 100) / 100,
        expectancy:        total ? Math.round((grossPnl / total) * 100) / 100 : 0,
        max_win_streak:    maxWinStreak,
        max_loss_streak:   maxLossStreak,
        setups:            stats,
      };
    },
  },

  {
    name: 'read_memory',
    description:
      'Search or read JARVIS persistent memory — facts, lessons, and decisions stored across sessions. ' +
      'Use this at session start to recall what matters. Omit query for a full summary.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keyword to search (omit for summary)' },
        limit: { type: 'number', description: 'Max entries (default 10)' },
      },
    },
    async handler({ query, limit = 10 } = {}) {
      const memFile = path.join(ROOT, 'tasks', 'jarvis_memory.json');
      if (!fs.existsSync(memFile)) return { entries: [], total: 0 };
      let data;
      try { data = JSON.parse(fs.readFileSync(memFile, 'utf8')); }
      catch (_) { return { entries: [], total: 0, error: 'memory file corrupt' }; }
      let entries = data.entries || [];
      if (query) {
        const q = query.toLowerCase();
        entries = entries.filter(e =>
          e.key.toLowerCase().includes(q) || e.value.toLowerCase().includes(q) ||
          (e.category || '').toLowerCase().includes(q)
        );
      }
      return {
        entries:      entries.slice(0, limit),
        total:        (data.entries || []).length,
        last_updated: data.last_updated,
      };
    },
  },

  {
    name: 'get_daily_note',
    description: 'Read the daily session log (signals, trades, notes) for today or any past date.',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD (default today)' },
      },
    },
    async handler({ date } = {}) {
      const args = date ? ['date', date] : ['today'];
      const output = await runPython('daily_notes.py', args);
      return { output };
    },
  },

  {
    name: 'analyze_symbol',
    description:
      'Deep compound analysis of one asset. Fetches signals + learning + recent trades in parallel, ' +
      'then returns a structured report: current signal, historical setup WR, last 10 trades on this symbol, ' +
      'risk regime, and a ready-to-use trade plan. ' +
      'Use this instead of calling get_signals + get_learning + get_journal separately.',
    inputSchema: {
      type: 'object',
      required: ['symbol'],
      properties: {
        symbol: { type: 'string', description: 'BTC | GOLD | SPX' },
      },
    },
    async handler({ symbol } = {}) {
      const sym = symbol.toUpperCase();
      const key = sym.toLowerCase();

      const [signals, learning, journal, risk] = await fetchParallel([
        '/api/signals',
        '/api/learning',
        `/api/journal?symbol=${sym}&limit=10`,
        '/api/risk-status',
      ]);

      const sig  = signals[key] || {};
      const setup = sig.setup || '';

      // Win rate for this setup
      const setups = (learning?.setups) || {};
      const st     = setups[setup] || {};
      const total  = (st.wins || 0) + (st.losses || 0);
      const wr     = total ? Math.round((st.wins || 0) / total * 100) : null;

      // Recent trades
      const rawJ = journal;
      const trades = Array.isArray(rawJ) ? rawJ : Array.isArray(rawJ?.journal) ? rawJ.journal : [];
      const recentW = trades.filter(t => t.pnl > 0).length;
      const recentL = trades.filter(t => t.pnl < 0).length;

      // R:R
      let rr = 0;
      if (sig.entry && sig.stop && sig.target) {
        const dir = (sig.signal || '').toUpperCase();
        const risk_pts   = dir === 'LONG' ? sig.entry - sig.stop   : sig.stop   - sig.entry;
        const reward_pts = dir === 'LONG' ? sig.target - sig.entry : sig.entry  - sig.target;
        if (risk_pts > 0) rr = Math.round(reward_pts / risk_pts * 100) / 100;
      }

      return {
        symbol:         sym,
        signal:         sig.signal  || 'WAIT',
        confidence:     sig.confidence || 0,
        setup,
        entry:          sig.entry  || null,
        stop:           sig.stop   || null,
        target:         sig.target || null,
        rr,
        setup_win_rate: wr,
        setup_trades:   total,
        recent_10: {
          wins:   recentW,
          losses: recentL,
          trades: trades.slice(0, 10).map(t => ({
            date: (t.opened_at || '').slice(0, 10),
            outcome: t.outcome,
            pnl: t.pnl,
          })),
        },
        risk_regime:   risk?.regime || 'UNKNOWN',
        circuit_open:  risk?.circuitBreakerOpen || false,
        news_blackout: risk?.newsBlackout || false,
        trade_ready:   (sig.confidence || 0) >= 65 && !risk?.circuitBreakerOpen && !risk?.newsBlackout,
      };
    },
  },

  // ─────────────── WRITE TOOLS ───────────────────────────────────────────────

  {
    name: 'write_memory',
    description:
      'Store a fact, lesson, or decision in JARVIS persistent memory. Survives all sessions. ' +
      'Use after every trade outcome, code fix, or market insight worth keeping.',
    inputSchema: {
      type: 'object',
      required: ['key', 'value'],
      properties: {
        key:      { type: 'string', description: 'Short identifier e.g. "BTC_SUPPORT_JULY"' },
        value:    { type: 'string', description: 'The fact or lesson to remember' },
        category: {
          type: 'string',
          enum: ['TRADE', 'SYSTEM', 'MARKET', 'CODE', 'RISK', 'LEARNING', 'GENERAL'],
        },
      },
    },
    async handler({ key, value, category = 'GENERAL' } = {}) {
      if (!key || !value) return { ok: false, error: 'key and value are required' };
      const output = await runPython('memory.py', ['add', key, value, category]);
      return { ok: true, output };
    },
  },

  {
    name: 'log_note',
    description: 'Append an entry to today\'s daily session log. Use to record signal decisions, trade outcomes, or observations.',
    inputSchema: {
      type: 'object',
      required: ['text'],
      properties: {
        text: { type: 'string', description: 'The note text' },
        tag:  { type: 'string', description: 'NOTE | TRADE | SIGNAL | ALERT | SYSTEM (default NOTE)' },
      },
    },
    async handler({ text, tag = 'NOTE' } = {}) {
      if (!text) return { ok: false, error: 'text is required' };
      const output = await runPython('daily_notes.py', ['log', text, tag]);
      return { ok: true, output };
    },
  },

  {
    name: 'send_alert',
    description:
      'Send a notification via Windows toast, email, or webhook (Discord/Slack). ' +
      'Use for trade signals, system alerts, and important events. All channels fail-silent.',
    inputSchema: {
      type: 'object',
      required: ['message'],
      properties: {
        message: { type: 'string', description: 'Alert message text' },
        title:   { type: 'string', description: 'Notification title (default: JARVIS Alert)' },
        channel: {
          type: 'string',
          enum: ['all', 'toast', 'email', 'webhook'],
          description: 'Which channel to use (default all)',
        },
      },
    },
    async handler({ message, title = 'JARVIS Alert', channel = 'all' } = {}) {
      if (!message) return { ok: false, error: 'message is required' };
      const args = ['alert', message, '--title', title];
      if (channel !== 'all') args.push('--channel', channel);
      try {
        const output = await runPython('notifications.py', args, 15000);
        return { ok: true, output };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
  },

  {
    name: 'force_heal',
    description: 'Trigger the auto-healer immediately — refreshes signals, prices, and validates all data. Use when system feels stale.',
    inputSchema: { type: 'object', properties: {} },
    async handler() {
      const result = await fetchJSON('/api/healer/heal', { method: 'POST', body: {} });
      _cache.delete('healer');
      _cache.delete('signals');
      return result;
    },
  },

  // ─────────────── ACTION TOOLS ──────────────────────────────────────────────

  {
    name: 'run_debate',
    description:
      'Run the 3-agent debate engine: Bull analyst, Bear analyst, and Risk Manager debate the signal in parallel. ' +
      'Majority vote (2/3) decides TAKE or SKIP. Takes 2–4 minutes. ' +
      'Always run this before execute_trade when confidence < 90%.',
    inputSchema: {
      type: 'object',
      required: ['symbol', 'direction', 'confidence', 'entry', 'stop', 'target'],
      properties: {
        symbol:     { type: 'string' },
        direction:  { type: 'string', enum: ['LONG', 'SHORT'] },
        confidence: { type: 'number', description: '0–100' },
        entry:      { type: 'number' },
        stop:       { type: 'number' },
        target:     { type: 'number' },
      },
    },
    async handler({ symbol, direction, confidence, entry, stop, target } = {}) {
      const output = await runPython(
        'debate_agents.py',
        [symbol, direction, String(confidence), String(entry), String(stop), String(target)],
        360000
      );
      const verdict = /VERDICT:\s*(TAKE|SKIP)/i.exec(output)?.[1]?.toUpperCase() || 'UNKNOWN';
      return { verdict, output };
    },
  },

  {
    name: 'size_position',
    description:
      'Calculate Kelly-based position size for a trade. Returns: recommended lot size, ' +
      'dollar risk, risk % of account, R:R ratio, and validation (approved/rejected with reason). ' +
      'Clamps between 0.5% and 5% of account. Min R:R 1.5:1 required.',
    inputSchema: {
      type: 'object',
      required: ['accountBalance', 'symbol', 'direction', 'entry', 'stop', 'target', 'confidence'],
      properties: {
        accountBalance: { type: 'number' },
        symbol:         { type: 'string' },
        direction:      { type: 'string', enum: ['LONG', 'SHORT'] },
        entry:          { type: 'number' },
        stop:           { type: 'number' },
        target:         { type: 'number' },
        confidence:     { type: 'number' },
      },
    },
    async handler({ accountBalance, symbol, direction, entry, stop, target, confidence } = {}) {
      return fetchJSON('/api/size', {
        method: 'POST',
        body: {
          accountBalance,
          signal: { symbol, direction, entry, stop, target, confidence },
          openPositions: [],
        },
      });
    },
  },

  {
    name: 'execute_trade',
    description:
      'Send a trade to the MT5 bridge for execution. ' +
      'Guards: checks circuit breaker before sending — refuses if 3 consecutive losses. ' +
      'Always call size_position first to get the lot size. ' +
      'Set source="manual" for direct trades, source="debate" if debate said TAKE.',
    inputSchema: {
      type: 'object',
      required: ['symbol', 'direction', 'entry', 'stop', 'target', 'lots'],
      properties: {
        symbol:     { type: 'string' },
        direction:  { type: 'string', enum: ['LONG', 'SHORT'] },
        entry:      { type: 'number' },
        stop:       { type: 'number' },
        target:     { type: 'number' },
        lots:       { type: 'number', description: 'Position size in lots from size_position' },
        confidence: { type: 'number', description: 'Signal confidence 0–100 (default 80)' },
        source:     { type: 'string', description: 'manual | debate | auto (default manual)' },
      },
    },
    async handler({ symbol, direction, entry, stop, target, lots, confidence = 80, source = 'manual' } = {}) {
      // Circuit breaker check first
      const risk = await cached('risk', 10000, () => fetchJSON('/api/risk-status'));
      if (risk?.circuitBreakerOpen) {
        return {
          executed: false,
          blocked:  true,
          reason:   'Circuit breaker is open — 3 consecutive losses. Trading halted until manual reset.',
        };
      }
      if (risk?.newsBlackout) {
        return {
          executed: false,
          blocked:  true,
          reason:   'News blackout active — no trades allowed during high-impact news.',
        };
      }

      const result = await fetchJSON('/api/claude-approve-trade', {
        method: 'POST',
        body: {
          symbol,
          direction: direction.toUpperCase(),
          entry,
          stop,
          target,
          lots:       Math.max(0.01, Math.round(lots * 100) / 100),
          confidence,
          source:    `mcp-${source}`,
        },
      });

      // Log to daily notes
      await runPython('daily_notes.py', [
        'log',
        `Trade executed: ${symbol} ${direction} entry=${entry} stop=${stop} target=${target} lots=${lots} source=${source}`,
        'TRADE',
      ]).catch(() => {});

      return result;
    },
  },

  {
    name: 'screenshot_chart',
    description:
      'Take a screenshot of the TradingView chart for a symbol and analyze it with Claude Vision. ' +
      'Returns pattern analysis: trend, key levels, setup confirmation, and trade recommendation. ' +
      'Requires TradingView to be open in Edge browser.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'BTC | GOLD | SPX (default BTC)' },
      },
    },
    async handler({ symbol = 'BTC' } = {}) {
      const output = await runPython('chart_vision.py', [symbol.toUpperCase()], 120000);
      return { output };
    },
  },

  {
    name: 'run_scan',
    description:
      'Parallel market scan: scores each asset by opportunity (confidence + R:R + historical WR + recent form). ' +
      'Returns ranked list. Fast (~3 s). Use before the trading session to find the best setup.',
    inputSchema: {
      type: 'object',
      properties: {
        assets: {
          type: 'array',
          items: { type: 'string' },
          description: 'Default: [BTC, GOLD, SPX]. Add ETH, NASDAQ, OIL for full scan.',
        },
        debate: {
          type: 'boolean',
          description: 'Auto-run debate on any live signal found (adds ~3 min per signal)',
        },
      },
    },
    async handler({ assets, debate = false } = {}) {
      const args = [];
      if (debate) args.push('--debate');
      if (assets?.length) args.push(...assets.map(a => a.toUpperCase()));
      const output = await runPython('market_scanner.py', args, debate ? 360000 : 30000);
      return { output };
    },
  },

  {
    name: 'full_trade_workflow',
    description:
      'Complete automated trade workflow: scan → find best signal → debate → size → execute → alert → log. ' +
      'One call replaces 6 separate steps. Takes 3–5 minutes due to debate. ' +
      'Set dry_run=true to see what would happen without actually sending to MT5.',
    inputSchema: {
      type: 'object',
      required: ['accountBalance'],
      properties: {
        accountBalance: { type: 'number', description: 'Account size in USD for position sizing' },
        symbol:         { type: 'string',  description: 'Force a specific symbol (default: auto-scan)' },
        dry_run:        { type: 'boolean', description: 'If true, plan the trade but do not execute (default false)' },
        min_confidence: { type: 'number',  description: 'Min confidence % to proceed (default 65)' },
      },
    },
    async handler({ accountBalance, symbol, dry_run = false, min_confidence = 65 } = {}) {
      const log = [];
      const step = (msg) => { log.push(msg); process.stderr.write(`[MCP workflow] ${msg}\n`); };

      // 1. Get best signal
      step('Scanning for signals...');
      let sig;
      if (symbol) {
        const data = await cached('signals', 10000, () => fetchJSON('/api/signals'));
        sig = { ...(data[symbol.toLowerCase()] || {}), symbol: symbol.toUpperCase() };
      } else {
        const scan = await runPython('market_scanner.py', [], 30000);
        // Parse top pick from scan output
        const match = /★\s+(\w+)\s+(LONG|SHORT)\s+(\d+)%.*Entry\s+([\d.]+)\s+Stop\s+([\d.]+)\s+Target\s+([\d.]+)/i.exec(scan);
        if (!match) return { ok: false, reason: 'No signals ready — all assets in WAIT', log };
        sig = {
          symbol:     match[1],
          signal:     match[2],
          confidence: parseFloat(match[3]),
          entry:      parseFloat(match[4]),
          stop:       parseFloat(match[5]),
          target:     parseFloat(match[6]),
        };
      }

      if (!sig.signal || sig.signal === 'WAIT' || (sig.confidence || 0) < min_confidence) {
        return { ok: false, reason: `No signal or confidence too low (${sig.confidence}% < ${min_confidence}%)`, log };
      }
      step(`Signal: ${sig.symbol} ${sig.signal} @ ${sig.entry} conf=${sig.confidence}%`);

      // 2. Circuit breaker
      const risk = await fetchJSON('/api/risk-status');
      if (risk?.circuitBreakerOpen) {
        return { ok: false, reason: 'Circuit breaker open — trading halted', log };
      }

      // 3. Debate
      step('Running debate (Bull vs Bear vs Risk)...');
      const debateOut = await runPython(
        'debate_agents.py',
        [sig.symbol, sig.signal, String(sig.confidence), String(sig.entry), String(sig.stop), String(sig.target)],
        360000
      );
      const verdict = /VERDICT:\s*(TAKE|SKIP)/i.exec(debateOut)?.[1]?.toUpperCase() || 'SKIP';
      step(`Debate verdict: ${verdict}`);

      if (verdict !== 'TAKE') {
        await runPython('daily_notes.py', ['log', `Debate SKIP: ${sig.symbol} ${sig.signal} @ ${sig.entry}`, 'SIGNAL']).catch(() => {});
        return { ok: false, reason: `Debate voted SKIP — trade rejected`, verdict, signal: sig, log };
      }

      // 4. Size
      step('Calculating position size...');
      const sizing = await fetchJSON('/api/size', {
        method: 'POST',
        body: {
          accountBalance,
          signal: { symbol: sig.symbol, direction: sig.signal, entry: sig.entry, stop: sig.stop, target: sig.target, confidence: sig.confidence },
          openPositions: [],
        },
      });

      if (!sizing?.approved) {
        return { ok: false, reason: `Position sizing rejected: ${sizing?.reason || 'unknown'}`, sizing, log };
      }
      step(`Size: ${sizing.lots} lots | Risk: $${sizing.riskAmount} (${sizing.riskPct}%)`);

      if (dry_run) {
        return { ok: true, dry_run: true, verdict, signal: sig, sizing, reason: 'dry_run=true — not executed', log };
      }

      // 5. Execute
      step('Sending to MT5...');
      const execResult = await fetchJSON('/api/claude-approve-trade', {
        method: 'POST',
        body: {
          symbol:     sig.symbol,
          direction:  sig.signal,
          entry:      sig.entry,
          stop:       sig.stop,
          target:     sig.target,
          lots:       sizing.lots,
          confidence: sig.confidence,
          source:     'mcp-workflow',
        },
      });
      step(`Execute result: ${JSON.stringify(execResult)}`);

      // 6. Alert + log
      const alertMsg = `TRADE: ${sig.symbol} ${sig.signal} @ ${sig.entry} | Lots: ${sizing.lots} | Stop: ${sig.stop} | Target: ${sig.target}`;
      await runPython('notifications.py', ['alert', alertMsg, '--title', 'JARVIS Trade Executed'], 15000).catch(() => {});
      await runPython('daily_notes.py', ['log', alertMsg, 'TRADE']).catch(() => {});
      await runPython('memory.py', ['add', `TRADE_${sig.symbol}_${Date.now()}`, alertMsg, 'TRADE']).catch(() => {});

      return {
        ok:      true,
        verdict,
        signal:  sig,
        sizing,
        execute: execResult,
        log,
      };
    },
  },
];

// ── MCP protocol ──────────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin });

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

rl.on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch (_) { return; }

  const { id, method, params } = msg;

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities:    { tools: {} },
        serverInfo:      { name: 'smartentry', version: '2.0.0' },
      },
    });
    return;
  }

  if (method === 'tools/list') {
    send({
      jsonrpc: '2.0', id,
      result: {
        tools: TOOLS.map(t => ({
          name:        t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      },
    });
    return;
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const args     = params?.arguments || {};
    const tool     = TOOLS.find(t => t.name === toolName);

    if (!tool) {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${toolName}` } });
      return;
    }

    const t0 = Date.now();
    try {
      const result = await tool.handler(args);
      const text   = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      send({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text }] },
      });
      process.stderr.write(`[MCP] ${toolName} → ${Date.now() - t0}ms\n`);
    } catch (err) {
      send({
        jsonrpc: '2.0', id,
        result: {
          content: [{ type: 'text', text: `[ERROR in ${toolName}] ${err.message}` }],
          isError: true,
        },
      });
      process.stderr.write(`[MCP] ${toolName} ERROR: ${err.message}\n`);
    }
    return;
  }

  if (!id) return; // one-way notifications need no reply
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
});

process.stderr.write('[SmartEntry MCP v2] Started — 19 tools ready\n');
