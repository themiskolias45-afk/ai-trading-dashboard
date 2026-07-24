'use strict';
/**
 * SmartEntry Pro — MCP Server
 * Exposes JARVIS trading tools as native MCP tools that Claude can call directly.
 * Run alongside the main server: node server/mcp_server.js
 *
 * Tools exposed:
 *   get_signals       — current BTC/GOLD/SPX signals
 *   get_risk_status   — regime, circuit breaker, daily P&L
 *   get_healer        — auto-healer health status
 *   get_journal       — recent trades
 *   get_learning      — setup win rates
 *   read_memory       — search persistent JARVIS memory
 *   write_memory      — store a fact in JARVIS memory
 *   get_daily_note    — read a daily session note
 *   log_note          — add entry to today's daily note
 *   run_debate        — run Bull/Bear/Risk debate on a signal
 *   size_position     — calculate Kelly-based position size
 *   run_scan          — parallel multi-asset market scan
 */

const readline = require('readline');
const https    = require('https');
const http     = require('http');
const path     = require('path');
const fs       = require('fs');
const { execFile, execFileSync } = require('child_process');

const ROOT       = path.join(__dirname, '..');
const SERVER_URL = 'http://localhost:3001';
const PYTHON     = process.platform === 'win32' ? 'python' : 'python3';

// ── HTTP helper ──────────────────────────────────────────────────────────────

function fetchJSON(urlPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const fullUrl = SERVER_URL + urlPath;
    const lib = fullUrl.startsWith('https') ? https : http;
    const options = {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      timeout: 5000,
    };

    const req = lib.request(fullUrl, options, (res) => {
      let body = '';
      res.on('data', d => (body += d));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (_) { resolve({ _raw: body }); }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });

    if (opts.body) req.write(JSON.stringify(opts.body));
    req.end();
  });
}

// ── Python runner ────────────────────────────────────────────────────────────

function runPython(script, args = [], timeout = 60000) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(ROOT, script);
    const child = execFile(
      PYTHON, [scriptPath, ...args],
      { cwd: ROOT, timeout, env: { ...process.env, NO_COLOR: '1' } },
      (err, stdout, stderr) => {
        if (err && !stdout) {
          reject(new Error(stderr || err.message));
        } else {
          resolve((stdout || '').trim() || (stderr || '').trim());
        }
      }
    );
  });
}

// ── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'get_signals',
    description: 'Get current trading signals for BTC, GOLD, and SPX from SmartEntry Pro.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Optional: btc, gold, spx — returns all if omitted',
        },
      },
    },
    async handler({ symbol } = {}) {
      const data = await fetchJSON('/api/signals');
      if (symbol) return data[symbol.toLowerCase()] || { error: `No signal for ${symbol}` };
      return data;
    },
  },

  {
    name: 'get_risk_status',
    description: 'Get current risk status: market regime, circuit breaker, daily P&L, news blackout.',
    inputSchema: { type: 'object', properties: {} },
    async handler() {
      return fetchJSON('/api/risk-status');
    },
  },

  {
    name: 'get_healer',
    description: 'Get auto-healer status: all system health checks, uptime, last heal time.',
    inputSchema: { type: 'object', properties: {} },
    async handler() {
      return fetchJSON('/api/healer');
    },
  },

  {
    name: 'get_journal',
    description: 'Get trade journal entries from SmartEntry Pro.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max entries to return (default 20)' },
        symbol: { type: 'string', description: 'Filter by symbol' },
        outcome: { type: 'string', enum: ['WIN', 'LOSS', 'BREAKEVEN'], description: 'Filter by outcome' },
      },
    },
    async handler({ limit = 20, symbol, outcome } = {}) {
      let url = `/api/journal?limit=${limit}`;
      if (symbol) url += `&symbol=${symbol}`;
      if (outcome) url += `&outcome=${outcome}`;
      return fetchJSON(url);
    },
  },

  {
    name: 'get_learning',
    description: 'Get self-learning data: win rates per setup, confidence calibration.',
    inputSchema: { type: 'object', properties: {} },
    async handler() {
      return fetchJSON('/api/learning');
    },
  },

  {
    name: 'read_memory',
    description: 'Search or read JARVIS persistent memory. Survives across sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keyword to search for. Omit to get a summary.' },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
    },
    async handler({ query, limit = 10 } = {}) {
      const memFile = path.join(ROOT, 'tasks', 'jarvis_memory.json');
      if (!fs.existsSync(memFile)) return { entries: [], total: 0 };
      const data = JSON.parse(fs.readFileSync(memFile, 'utf8'));
      let entries = data.entries || [];
      if (query) {
        const q = query.toLowerCase();
        entries = entries.filter(
          e => e.key.toLowerCase().includes(q) || e.value.toLowerCase().includes(q)
        );
      }
      return { entries: entries.slice(0, limit), total: entries.length };
    },
  },

  {
    name: 'write_memory',
    description: 'Store a fact, lesson, or decision in JARVIS persistent memory.',
    inputSchema: {
      type: 'object',
      required: ['key', 'value'],
      properties: {
        key:      { type: 'string', description: 'Short identifier for this memory' },
        value:    { type: 'string', description: 'The fact, lesson, or decision to remember' },
        category: {
          type: 'string',
          enum: ['TRADE', 'SYSTEM', 'MARKET', 'CODE', 'RISK', 'LEARNING', 'GENERAL'],
          description: 'Memory category (default GENERAL)',
        },
      },
    },
    async handler({ key, value, category = 'GENERAL' } = {}) {
      const output = await runPython('memory.py', ['add', key, value, category]);
      return { ok: true, output };
    },
  },

  {
    name: 'get_daily_note',
    description: 'Read the daily session note for today or a specific date.',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD (default: today)' },
      },
    },
    async handler({ date } = {}) {
      const args = date ? ['date', date] : ['today'];
      const output = await runPython('daily_notes.py', args);
      return { output };
    },
  },

  {
    name: 'log_note',
    description: 'Add an entry to today\'s daily session note.',
    inputSchema: {
      type: 'object',
      required: ['text'],
      properties: {
        text: { type: 'string', description: 'The note text to log' },
        tag:  { type: 'string', description: 'Tag: NOTE, TRADE, SIGNAL, ALERT, SYSTEM (default NOTE)' },
      },
    },
    async handler({ text, tag = 'NOTE' } = {}) {
      const output = await runPython('daily_notes.py', ['log', text, tag]);
      return { ok: true, output };
    },
  },

  {
    name: 'run_debate',
    description: 'Run the 3-agent Bull/Bear/Risk debate on a trading signal. Returns TAKE or SKIP verdict.',
    inputSchema: {
      type: 'object',
      required: ['symbol', 'direction', 'confidence', 'entry', 'stop', 'target'],
      properties: {
        symbol:     { type: 'string', description: 'Asset symbol e.g. BTC' },
        direction:  { type: 'string', enum: ['LONG', 'SHORT'] },
        confidence: { type: 'number', description: 'Signal confidence 0-100' },
        entry:      { type: 'number', description: 'Entry price' },
        stop:       { type: 'number', description: 'Stop loss price' },
        target:     { type: 'number', description: 'Take profit price' },
      },
    },
    async handler({ symbol, direction, confidence, entry, stop, target } = {}) {
      const output = await runPython(
        'debate_agents.py',
        [symbol, direction, String(confidence), String(entry), String(stop), String(target)],
        300000  // 5 min timeout — 3 agents in parallel
      );
      return { output };
    },
  },

  {
    name: 'size_position',
    description: 'Calculate Kelly-based position size for a trade. Returns lot size and validation.',
    inputSchema: {
      type: 'object',
      required: ['accountBalance', 'symbol', 'direction', 'entry', 'stop', 'target', 'confidence'],
      properties: {
        accountBalance: { type: 'number', description: 'Total account balance in USD' },
        symbol:         { type: 'string' },
        direction:      { type: 'string', enum: ['LONG', 'SHORT'] },
        entry:          { type: 'number' },
        stop:           { type: 'number' },
        target:         { type: 'number' },
        confidence:     { type: 'number', description: 'Signal confidence 0-100' },
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
    name: 'run_scan',
    description: 'Run parallel market scan across assets. Returns ranked opportunity list.',
    inputSchema: {
      type: 'object',
      properties: {
        assets: {
          type: 'array',
          items: { type: 'string' },
          description: 'Assets to scan (default: [BTC, GOLD, SPX])',
        },
        debate: {
          type: 'boolean',
          description: 'Also run debate on any live signal found (slow — ~3 min)',
        },
      },
    },
    async handler({ assets, debate = false } = {}) {
      const args = [];
      if (debate) args.push('--debate');
      if (assets && assets.length > 0) args.push(...assets.map(a => a.toUpperCase()));
      const output = await runPython('market_scanner.py', args, debate ? 300000 : 30000);
      return { output };
    },
  },
];

// ── MCP protocol implementation ──────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin });

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function errorResponse(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

rl.on('line', async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (_) {
    return;
  }

  const { id, method, params } = msg;

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'smartentry', version: '1.0.0' },
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
      errorResponse(id, -32601, `Unknown tool: ${toolName}`);
      return;
    }

    try {
      const result = await tool.handler(args);
      send({
        jsonrpc: '2.0', id,
        result: {
          content: [{
            type: 'text',
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          }],
        },
      });
    } catch (err) {
      send({
        jsonrpc: '2.0', id,
        result: {
          content: [{ type: 'text', text: `[ERROR] ${err.message}` }],
          isError: true,
        },
      });
    }
    return;
  }

  // notifications/initialized and other one-way messages — no response needed
  if (!id) return;

  errorResponse(id, -32601, `Method not found: ${method}`);
});

process.stderr.write('[SmartEntry MCP] Server started — 12 tools ready\n');
