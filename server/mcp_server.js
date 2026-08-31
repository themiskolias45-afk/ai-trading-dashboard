'use strict';
/**
 * SmartEntry Pro — MCP Server v2
 * Claude calls these directly — no HTTP fetches, no subprocesses in prompts. The tool
 * count is not written here on purpose: it was stale within a week last time, and
 * /api/ai-registry counts the catalogue below by parsing this file.
 *
 * READ TOOLS (instant):
 *   get_signals          — live BTC / GOLD / SPX (S&P 500) signals
 *   get_risk_status      — regime, circuit breaker, daily P&L, news blackout
 *   get_healer           — 6-point system health check
 *   get_fleet_status     — BOTH boxes: what is armed, both gates, parity, check-ins
 *   get_journal          — trade history with filters
 *   get_learning         — setup win rates and calibration
 *   get_performance      — aggregate stats: WR, P&L, best/worst setup, equity curve
 *   get_gate_health      — per-gate kill/pass counts (FIRING, not whether it should)
 *   get_evidence_board   — what is measured vs assumed, and what would change it
 *   get_ai_work          — did the scheduled agents run, and did anyone read them
 *   read_memory          — search JARVIS persistent memory
 *   get_daily_note       — read today's or any date's session log
 *   analyze_symbol       — deep compound analysis (signals + learning + journal in 1 call)
 *
 * Every tool above is READ-ONLY. The four that describe fleet state reach
 * session-gated routes and this process logs itself in — see the HTTP helper.
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
// Resolved by probing, not by PATH order. This used to be the bare string 'python',
// which on 2026-08-23 meant a Smart-App-Control-blocked uv trampoline. See
// server/python_path.js for what that cost. Lazy so nothing is spawned at import.
const { pythonBin, pythonEnv, tried: pythonCandidates } = require('./python_path');
// The walk-forward replays 5 folds x 3 assets through the live engine. Measured at
// roughly 90s on this machine; 10 minutes leaves headroom for a slower VPS without
// letting a hung run hold an MCP call open indefinitely.
const WALKFORWARD_TIMEOUT_MS = 10 * 60 * 1000;

// ── Cache (30 s TTL for frequently-polled endpoints) ─────────────────────────

const _cache = new Map();

function cached(key, ttlMs, fn) {
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.ts < ttlMs) return Promise.resolve(hit.value);
  return fn().then(v => { _cache.set(key, { value: v, ts: Date.now() }); return v; });
}

// ── HTTP helper ───────────────────────────────────────────────────────────────
//
// Session-aware. Half the interesting state on this server — the Systems Plan, the
// fleet comparison — sits behind the dashboard login, and the owner's standing
// decision is that it STAYS there until the system is stable. So the fix for an MCP
// session that could not see them is for this process to hold a login, not for the
// server to open a route. Credentials come from keys.env, the same file the server
// reads, and this process only ever runs on the same machine as the server.
//
// A 401 that parses cleanly reads as a successful response, so status is checked
// here rather than left to each caller.
let _sessionCookie = null;

function readKeysEnvValue(key) {
  try {
    const text = fs.readFileSync(path.join(ROOT, 'keys.env'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const idx = line.indexOf('=');
      if (idx === -1) continue;
      if (line.slice(0, idx).trim() === key) return line.slice(idx + 1).trim();
    }
  } catch (_) { /* no keys.env — treated as unconfigured */ }
  return null;
}

function httpRequest(urlPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const fullUrl = SERVER_URL + urlPath;
    const lib     = fullUrl.startsWith('https') ? https : http;
    const headers = { 'Content-Type': 'application/json' };
    if (_sessionCookie) headers.Cookie = _sessionCookie;
    const req = lib.request(
      fullUrl,
      { method: opts.method || 'GET', headers, timeout: opts.timeout || 6000 },
      (res) => {
        let body = '';
        res.on('data', d => (body += d));
        res.on('end', () => {
          let data;
          try { data = JSON.parse(body); } catch (_) { data = { _raw: body }; }
          resolve({ status: res.statusCode, headers: res.headers, data });
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`timeout fetching ${urlPath}`)); });
    if (opts.body) req.write(JSON.stringify(opts.body));
    req.end();
  });
}

async function ensureSession() {
  const username = readKeysEnvValue('DASHBOARD_USERNAME');
  const password = readKeysEnvValue('DASHBOARD_PASSWORD');
  if (!username || !password) return false;
  try {
    const res = await httpRequest('/api/login', { method: 'POST', body: { username, password } });
    const setCookie = res.headers && res.headers['set-cookie'];
    if (res.status === 200 && setCookie && setCookie.length) {
      _sessionCookie = String(setCookie[0]).split(';')[0];
      return true;
    }
  } catch (_) { /* fall through to the explicit error below */ }
  return false;
}

async function fetchJSON(urlPath, opts = {}) {
  let res = await httpRequest(urlPath, opts);
  // One retry, and only on 401: a stale SESSION_SECRET (the server regenerates it
  // when apikey.txt is deleted) looks identical to never having logged in.
  if (res.status === 401 && await ensureSession()) {
    res = await httpRequest(urlPath, opts);
  }
  if (res.status === 401) {
    return {
      error: 'Not logged in, and this MCP server could not obtain a session.',
      detail: 'Set DASHBOARD_USERNAME and DASHBOARD_PASSWORD in keys.env. The route is deliberately session-gated — do not expect it to be public.',
      path: urlPath,
    };
  }
  return res.data;
}

// ── Python runner ─────────────────────────────────────────────────────────────

function execPython(script, args = [], timeout = 60000) {
  return new Promise((resolve, reject) => {
    // "No interpreter at all" is a DIFFERENT failure from "the script ran and exited
    // non-zero after doing its work", and the two must not be reported the same way.
    // The tolerance below is deliberate - a script can write its file and then die on
    // a cp1252 encoding error in its final print, and that work is not lost - but it
    // also meant that when the interpreter itself could not start, the spawn error
    // arrived on stderr, became `out`, and was resolved as if it were the script's
    // output. That is precisely how log_note and write_memory answered {ok: true}
    // while writing nothing at all on 2026-08-23. Checked first, so it cannot recur.
    const binary = pythonBin();
    if (!binary) {
      return reject(new Error(
        'No working Python interpreter found on this machine. Tried: ' +
        pythonCandidates().join(', ') +
        '. Set SMARTENTRY_PYTHON in keys.env to point at one.'
      ));
    }
    execFile(
      binary, [path.join(ROOT, script), ...args],
      // pythonEnv() forces UTF-8 stdout on the child. Without it every MCP python
      // tool inherits the host console code page and dies on the first non-cp1252
      // character it prints -- reported to the caller as an ordinary script failure.
      { cwd: ROOT, timeout, env: pythonEnv({ NO_COLOR: '1' }) },
      (err, stdout, stderr) => {
        const stdoutText = (stdout || '').trim();
        const stderrText = (stderr || '').trim();
        // execFile's err.code is the EXIT CODE for a child that ran and failed, but a
        // STRING like 'ENOENT' when the process could not be spawned at all. Only the
        // number is an exit code; anything else is reported as null so a caller cannot
        // print 'ENOENT' where a number belongs.
        resolve({
          ok:       !err,
          exitCode: !err ? 0 : (typeof err.code === 'number' ? err.code : null),
          timedOut: Boolean(err && err.killed),
          stdout:   stdoutText,
          stderr:   stderrText,
          output:   stdoutText || stderrText,
        });
      }
    );
  });
}

/**
 * The string contract, unchanged, kept as a thin wrapper over execPython.
 *
 * Every existing caller reads a string and several are fire-and-forget, so this
 * deliberately keeps the ORIGINAL behaviour including its tolerance: a script that
 * writes its file and then dies on a cp1252 error in its final print has still done
 * the work, and that output is still returned rather than thrown away. Only the
 * no-output case rejects, exactly as before.
 *
 * What that tolerance CANNOT do is tell a caller the child failed — which is why any
 * tool whose job is to PERSIST something must call execPython and read `ok`.
 */
function runPython(script, args = [], timeout = 60000) {
  return execPython(script, args, timeout).then(result => {
    if (!result.ok && !result.output) {
      throw new Error(result.stderr || `${script} exited with code ${result.exitCode}`);
    }
    return result.output;
  });
}

// A write tool that answers ok:true when its child failed is worse than one that
// throws: the caller records the note or the memory as saved, moves on, and the loss is
// discovered only when someone goes looking for it. On 2026-08-23 log_note and
// write_memory answered {ok: true} while writing nothing at all for hours, because
// runPython resolves whenever the child printed ANYTHING — a python traceback goes to
// stderr, becomes the "output", and reads as success.
//
// The interpreter-missing case was fixed separately and is caught before spawn. This
// covers the other half: the interpreter starts, the script runs, and it exits non-zero.
function pythonFailure(script, result) {
  const cause = result.timedOut
    ? 'timed out'
    : result.exitCode === null ? 'could not be run' : `exited with code ${result.exitCode}`;
  return {
    ok: false,
    error: `${script} ${cause} — nothing was written. Read 'output' for what it printed.`,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    output: result.output,
  };
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
      'and total sessions tracked. ' +
      'setupStats counts REAL FILLS and is small because the system is WEEKS OLD, not ' +
      'because it refuses to trade - it fills about once every 4 days. Most setups ' +
      'sit below the 5-trade floor and carry boost 0. Never quote a fill count from ' +
      'this text; call get_performance for the live one. ' +
      'The separate `shadow` key holds per-setup outcomes from REJECTED setups walked ' +
      'forward on real broker bars: far more of them, but they are forgone PAPER trades ' +
      'with no slippage and no spread, on entries that were never filled. ' +
      'Never present shadow numbers as realised edge and never merge the two - ' +
      'shadow.feedsTheGate is false, meaning it changes no confidence and no signal.',
    inputSchema: { type: 'object', properties: {} },
    async handler() {
      return cached('learning', 60000, () => fetchJSON('/api/learning'));
    },
  },

  {
    name: 'get_rejection_evidence',
    description:
      'Per-gate verdict on every setup the gates threw away: did rejecting it SAVE ' +
      'money or COST money? Each rejection is a fully priced paper trade walked ' +
      'forward on real broker bars, so a gate whose rejections would have LOST is ' +
      'earning its keep and one whose rejections would have WON is charging the ' +
      'account for nothing. ' +
      'Returns per gate: resolved count, would-have-won %, net R, pending, and a ' +
      'verdict of EARNING ITS KEEP / COSTING MONEY / NO MEASURABLE COST / TOO FEW ' +
      'TO JUDGE (floor is 5 resolved). Also a cross-gate per-setup view showing ' +
      'which setups are being discarded regardless of which gate killed them. ' +
      'THIS IS THE ANSWER TO "why does the system never trade" — use it before ' +
      'proposing any threshold change. ' +
      'These are forgone PAPER trades: no spread, no slippage, entries never ' +
      'filled, fixed scoring horizon. Never present them as realised P&L, never ' +
      'merge them with get_performance, and where they contradict a walk-forward ' +
      'the walk-forward wins. feedsTheGate is false — this changes no threshold ' +
      'and no signal.',
    inputSchema: { type: 'object', properties: {} },
    async handler() {
      return cached('rejectionEvidence', 60000, () => fetchJSON('/api/rejection-evidence'));
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
        // Guarded because tasks/jarvis_memory.json has TWO WRITERS and therefore two
        // row shapes. memory.py writes {key, value, category, ...}; server/index.js
        // appends session notes in its own {ts, tag, text} shape onto the same file —
        // memory.py:44 and :95 both say so in their own comments. A note-shaped row has
        // no key and no value, so the unguarded e.key.toLowerCase() below threw
        // "Cannot read properties of undefined (reading 'toLowerCase')" and took the
        // ENTIRE query path down. Measured 2026-08-28: ONE such row against 69 good
        // ones killed recall across all 70, and CLAUDE.md startup steps 2c and 2e both
        // call this with a query, so both had been silently erroring every session.
        //
        // The fix is the READER, not the row. The row is real data and is never
        // removed; guarding here also survives the NEXT note-shaped append, whereas
        // repairing the file leaves the same bug armed for the next one.
        entries = entries.filter(e =>
          (e.key || '').toLowerCase().includes(q) ||
          (e.value || '').toLowerCase().includes(q) ||
          (e.category || '').toLowerCase().includes(q) ||
          // Note-shaped rows carry their content in `text` and their label in `tag`.
          // Searching them too means a session note is FINDABLE rather than merely
          // non-fatal — the file's second half stops being invisible to recall.
          (e.text || '').toLowerCase().includes(q) ||
          (e.tag || '').toLowerCase().includes(q)
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

      const [signals, learning, journal, risk, settings] = await fetchParallel([
        '/api/signals',
        '/api/learning',
        `/api/journal?symbol=${sym}&limit=10`,
        '/api/risk-status',
        '/api/strategy-settings',
      ]);

      // The gate in force, never a literal. This tool used to compare confidence
      // against a hardcoded 65 while the live gate has been 70 since 2026-08-02, so it
      // reported trade_ready:true for setups the engine would refuse. Falls back to 70
      // rather than 65 if settings are unreadable — the conservative direction, since
      // guessing low invents readiness that does not exist.
      const gateThreshold = Number.isFinite(settings?.confidenceThreshold)
        ? settings.confidenceThreshold : 70;

      const sig  = signals[key] || {};
      const setup = sig.setup || '';

      // Win rate for this setup.
      // /api/learning serialises this map as `setupStats` and always has —
      // `learning?.setups` is undefined on every call, so `wr` below was
      // permanently null and analyze_symbol has never reported a win rate.
      // `setups` is kept as a fallback for any older payload still in flight.
      const setups = (learning?.setupStats) || (learning?.setups) || {};
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
        // `circuitBreakerOpen` and `newsBlackout` are not fields /api/risk-status
        // returns, so these two reported a confident FALSE at all times — including
        // while the box was actually halted — and trade_ready ignored the breaker
        // entirely. `halted` is the real field.
        circuit_open:  risk?.halted || false,
        halt_reason:   risk?.haltReason || null,
        // The blackout is on /api/newsfilter, which this tool does not fetch. Say that
        // rather than report a false, which is what made the old line dangerous: a
        // reader cannot tell "checked and clear" from "never looked".
        news_blackout: 'not checked here — see get_gate_health or /api/newsfilter',
        // Was hardcoded 65 while the live gate has been 70 since 2026-08-02, so this
        // called setups ready that the engine would refuse. Read from the live config.
        trade_ready:   (sig.confidence || 0) >= gateThreshold && !risk?.halted,
        gate_used:     gateThreshold,
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
      const result = await execPython('memory.py', ['add', key, value, category]);
      if (!result.ok) return pythonFailure('memory.py', result);
      return { ok: true, output: result.output };
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
      const result = await execPython('daily_notes.py', ['log', text, tag]);
      if (!result.ok) return pythonFailure('daily_notes.py', result);
      return { ok: true, output: result.output };
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
      // Circuit breaker check first.
      //
      // This guard was DEAD. It read `risk.circuitBreakerOpen` and `risk.newsBlackout`,
      // and /api/risk-status has never returned either field — it returns dailyPnl,
      // consecutiveLosses, halted, haltReason and accounts. Both reads were permanently
      // undefined, so neither branch could ever be taken, and a tool whose own
      // description promises "refuses if 3 consecutive losses" would happily place a
      // trade with the breaker open. The bridge's own gates were the only thing
      // actually stopping it.
      const risk = await cached('risk', 10000, () => fetchJSON('/api/risk-status'));
      if (risk?.halted) {
        return {
          executed: false,
          blocked:  true,
          reason:   `Circuit breaker is open — ${risk.haltReason || 'trading halted'}. `
                  + 'Trading is halted until it resets or a human clears it.',
        };
      }
      // The blackout lives on /api/newsfilter, not on risk-status. Fetched separately
      // and FAILING OPEN: the bridge enforces NEWS_BLACKOUT itself before every order,
      // so a transient fetch error here must not stop a trade that the real gate would
      // allow. Reported rather than swallowed, so a permanently failing fetch is
      // visible instead of quietly reducing this to no guard at all.
      let newsNote = null;
      try {
        const news = await cached('newsfilter', 60000, () => fetchJSON('/api/newsfilter'));
        if (news?.enabled && news?.blackout) {
          return {
            executed: false,
            blocked:  true,
            reason:   `News blackout active — ${news.reason || 'high-impact event window'}.`,
          };
        }
      } catch (e) {
        newsNote = `news blackout NOT checked here (${e.message}) — the bridge still enforces it`;
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
          description:
            'BTC, GOLD and SPX — those are the only three the server computes. ' +
            'ETH, NASDAQ and OIL are accepted by the scanner but /api/signals carries ' +
            'no key for them and mt5_bridge.py has no SYMBOL_CANDIDATES entry, so they ' +
            'come back as UNSUPPORTED (never evaluated), not as a quiet market. This ' +
            'description used to read "Add ETH, NASDAQ, OIL for full scan", advertising ' +
            'a capability that does not exist.',
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
      //
      // Same dead guard as execute_trade had: `circuitBreakerOpen` is not a field
      // /api/risk-status returns, so this step was a no-op in a workflow that ends by
      // placing a real order. `halted` is the field.
      const risk = await fetchJSON('/api/risk-status');
      if (risk?.halted) {
        return { ok: false, reason: `Circuit breaker open — ${risk.haltReason || 'trading halted'}`, log };
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

  {
    name: 'get_strategy_settings',
    description:
      'Get the LIVE trading configuration actually in force: confidence gate, max positions, ' +
      'max trades per day, fixed lot size, min strength, plus the allowed range for each. ' +
      'ALWAYS check settingsError before trusting the numbers - if it is non-null the server ' +
      'could not read strategy_settings.json and these are built-in DEFAULTS, not the saved ' +
      'config, which silently changes live position sizing. Use before answering any question ' +
      'about why a signal did or did not fire.',
    inputSchema: { type: 'object', properties: {} },
    async handler() {
      return cached('strategy-settings', 15000, () => fetchJSON('/api/strategy-settings'));
    },
  },

  {
    name: 'get_mt5_health',
    description:
      'Check whether a specific MT5 bridge is alive, by ACCOUNT TAG (A, B, or default). ' +
      'This is the only authoritative test: the field is written solely by POST /api/mt5/positions, ' +
      'so connected=true proves that bridge is talking to BOTH MetaTrader and the server. ' +
      'Process lists are NOT a substitute - Windows returns an empty command line for these ' +
      'python processes, so they can look absent while trading normally. A "default" tag that ' +
      'is connected means an UNTAGGED bridge is running, which can double positions on an ' +
      'account a tagged bridge already owns.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Account tag: A, B, or default. Omitting it reports a tag no bridge uses.' },
      },
      required: ['account'],
    },
    async handler({ account }) {
      const tag = String(account || '').trim();
      if (!tag) throw new Error('account tag required (A, B, or default)');
      return fetchJSON(`/api/mt5/health?account=${encodeURIComponent(tag)}`);
    },
  },

  {
    name: 'get_time_context',
    description:
      'WHAT TIME IT IS, and how long ago everything happened. Call this before any ' +
      'reasoning that involves when: staleness, "has this fired in N days", which ' +
      'session is live, whether it is the weekend, what yesterday\'s date was for a ' +
      'daily-note lookup. This system stores LOCAL time in its logs and UTC in every ' +
      'API, and on 2026-08-10 that read as a corrupt log — bridge_log_A.txt said ' +
      '16:17 while /api/status said 13:38Z, and the difference was BST. Both clocks, ' +
      'the offset and the DST state are returned together so that cannot happen ' +
      'again. Also returns year, month, ISO week, quarter, day-of-year, weekday, ' +
      'today/yesterday/tomorrow as ISO dates, the current and next trading session ' +
      'with minutes until it changes, and the age of every moving part — signal ' +
      'cache, each bridge heartbeat, last trade, last parity run, last backup, ' +
      'server uptime — each as a timestamp, a millisecond age, AND in words. ' +
      'Sessions here are UTC clock boundaries; whether a market is really trading is ' +
      'answered by feed freshness, not by that schedule.',
    inputSchema: { type: 'object', properties: {} },
    async handler() {
      return cached('now', 5000, () => fetchJSON('/api/now'));
    },
  },

  {
    name: 'get_brain_status',
    description:
      'EVERYTHING, IN ONE CALL — the widest read available, for the start of a ' +
      'session or any question of the form "what is going on". Composes: the time ' +
      'context; the fleet verdict across BOTH boxes (what is armed, both gates, ' +
      'engine parity, peer check-ins); live signals and the confidence gate they are ' +
      'measured against; risk and circuit-breaker state; the AI employee\'s verdicts ' +
      'and anything it proposed that nobody has read; and the evidence board\'s ' +
      'account of what is MEASURED versus merely assumed. Every part is read-only ' +
      'and none of it feeds the gate. Prefer this over firing six tools separately, ' +
      'and read the `blocking` field first: it names the constraint that actually ' +
      'limits this system, which is sample size, not ideas.',
    inputSchema: {
      type: 'object',
      properties: {
        full: { type: 'boolean', description: 'Include the raw payloads as well as the summary' },
      },
    },
    async handler({ full } = {}) {
      const [now, plan, fleet, signals, risk, work, board, settings, ctx] = await fetchParallel([
        '/api/now', '/api/system-plan', '/api/fleet', '/api/signals',
        '/api/risk-status', '/api/ai-work', '/api/evidence-board', '/api/strategy-settings',
        '/api/market-context',
      ]);

      const gate = typeof settings?.confidenceThreshold === 'number' ? settings.confidenceThreshold : null;
      const assets = ['btc', 'gold', 'spx'];
      const signalSummary = {};
      for (const asset of assets) {
        const s = signals?.[asset];
        if (!s) continue;
        const zones = ctx?.[asset]?.zones;
        const zoneProximity = zones ? {
          nearestAbove: zones.nearestAbove ? {
            score: zones.nearestAbove.score ?? null,
            distanceAtr: zones.nearestAbove.distanceAtr ?? null,
            low: zones.nearestAbove.low ?? null,
            high: zones.nearestAbove.high ?? null,
            methods: zones.nearestAbove.methods ?? [],
          } : null,
          nearestBelow: zones.nearestBelow ? {
            score: zones.nearestBelow.score ?? null,
            distanceAtr: zones.nearestBelow.distanceAtr ?? null,
            low: zones.nearestBelow.low ?? null,
            high: zones.nearestBelow.high ?? null,
            methods: zones.nearestBelow.methods ?? [],
          } : null,
          priceInside: zones.priceInside ?? null,
        } : null;
        signalSummary[asset] = {
          signal: s.signal ?? null,
          confidence: s.confidence ?? null,
          gapToGate: gate !== null && typeof s.confidence === 'number'
            ? Math.max(0, gate - s.confidence) : null,
          setup: s.setup ?? null,
          h1Agree: s.h1Agree ?? null,
          zoneProximity,
        };
      }

      const peer = fleet?.peer ?? plan?.peer ?? {};
      const divergence = plan?.divergence ?? {};

      // The honest constraint. The sample is small because the system is WEEKS OLD
      // - it fills roughly once every 4 days, against ~218/yr for the same engine
      // in replay - so every threshold argument is under-powered until TIME passes.
      // That is arithmetic, not a fault, and the fix is to let it run. The rejection
      // ledger is the only thing that manufactures evidence without waiting. Do NOT
      // write a fill count here: it went stale at 'one' and stayed wrong for weeks.
      const blocking = {
        constraint: 'sample size',
        detail: 'Threshold and edge claims are under-powered until far more trades resolve. '
              + 'The rejection ledger prices every gate rejection as a paper trade at zero risk — '
              + 'read it before proposing any threshold change, and remember a walk-forward '
              + 'beats it wherever they disagree.',
        unreviewedProposals: fleet?.proposals?.fleetUnreviewed ?? null,
      };

      const summary = {
        time: now?.error ? { error: now.error } : {
          utc: now?.now?.utc, local: now?.now?.local, timeZone: now?.now?.localTimeZone,
          weekday: now?.calendar?.weekday, today: now?.calendar?.today,
          isWeekend: now?.calendar?.isWeekend, isoWeek: now?.calendar?.isoWeek,
          session: now?.session?.current?.name, nextSession: now?.session?.next,
          ages: now?.ages,
        },
        fleet: {
          verdict: !peer.configured ? 'SINGLE BOX'
                 : !peer.reachable ? 'PEER UNREACHABLE'
                 : (divergence.gate?.differs || divergence.engine?.differs) ? 'FLEET DIVERGES'
                 : 'FLEET AGREES',
          thisBoxGate: plan?.thisBox?.gate ?? null,
          peerGate: peer.gate ?? null,
          parity: plan?.parity ?? null,
          heartbeats: plan?.heartbeats ?? null,
          actionItems: (plan?.actionItems || []).map(i => `[${i.severity}] ${i.title}`),
        },
        trading: {
          gate,
          minStrength: settings?.minStrength ?? null,
          halted: risk?.halted ?? null,
          haltReason: risk?.haltReason || '',
          dailyPnl: risk?.dailyPnl ?? null,
          consecutiveLosses: risk?.consecutiveLosses ?? null,
          signals: signalSummary,
        },
        employee: {
          jobs: (work?.jobs || []).map(j => `${j.label}: ${j.verdict}`),
          unreviewedHere: work?.totals?.unreviewed ?? null,
          unappraisedTasks: work?.totals?.unappraisedTasks ?? null,
        },
        evidence: {
          claims: Array.isArray(board?.claims) ? board.claims.length : null,
          note: 'Each claim carries its verdict, evidence, caveat and what would change the answer.',
        },
        blocking,
        feedsTheGate: false,
      };

      return full ? { summary, now, plan, fleet, signals, risk, work, board, settings } : summary;
    },
  },

  {
    name: 'get_fleet_status',
    description:
      'THE FLEET, BOTH BOXES, IN ONE CALL — the tool to reach for before trusting any number ' +
      'that pools the laptop and the VPS. Every other health tool here describes ONE machine ' +
      'while presenting itself as the system, and every expensive failure this system has had ' +
      'was a divergence while both boxes reported healthy: AutoTrading disabled on the VPS for ' +
      '11 days behind green checks, a per-machine strategy_settings.json running a different ' +
      'gate off the same commit, cohort_table.js absent so the box that trades was the one box ' +
      'that never named a dead cohort. Returns: a one-word verdict, what is ARMED per account ' +
      'per box (config.autoMode, reported by the bridge that enforces it), the confidence gate ' +
      'on each box, circuit-breaker state, engine-parity verdict with its age, peer check-ins, ' +
      'unreviewed AI-employee proposals across BOTH boxes, and the action items that can ' +
      'actually clear. A gate mismatch means the two boxes admit different trades from ' +
      'identical bars and their journals cannot be pooled.',
    inputSchema: {
      type: 'object',
      properties: {
        full: { type: 'boolean', description: 'Return the raw plan and fleet payloads as well as the summary' },
      },
    },
    async handler({ full } = {}) {
      const [plan, fleet] = await fetchParallel(['/api/system-plan', '/api/fleet']);
      if (plan && plan.error) return { error: plan.error, detail: plan.detail ?? null };

      const peer = fleet && fleet.peer ? fleet.peer : (plan.peer || {});
      const divergence = plan.divergence || {};
      const gateDiffers     = !!(divergence.gate             && divergence.gate.differs);
      const engineDiffers   = !!(divergence.engine           && divergence.engine.differs);
      const cooldownDiffers = !!(divergence.haltCooldownHours && divergence.haltCooldownHours.differs);

      let verdict;
      if (!peer.configured)            verdict = 'SINGLE BOX — no peer configured, everything below is one machine';
      else if (!peer.reachable)        verdict = 'PEER UNREACHABLE — the other box did not answer';
      else if (gateDiffers || engineDiffers || cooldownDiffers) verdict = 'FLEET DIVERGES — the two boxes do not agree';
      else                             verdict = 'FLEET AGREES';

      const summary = {
        verdict,
        actionItems: (plan.actionItems || []).map(i => `[${i.severity}] ${i.title}`),
        standingNotes: (plan.standingNotes || []).length,
        thisBox: {
          label: plan.thisBox?.label ?? null,
          gate: plan.thisBox?.gate ?? null,
          halted: plan.thisBox?.halted ?? null,
          settingsError: plan.thisBox?.settingsError ?? null,
          bridgesLive: plan.thisBox?.bridges?.reporting ?? [],
          bridgesSilent: plan.thisBox?.bridges?.silent ?? [],
          armed: (fleet?.thisBox?.arming || []).filter(a => a.autoMode).map(a => a.tag),
        },
        peer: {
          url: peer.url ?? null,
          reachable: peer.reachable ?? false,
          gate: peer.gate ?? null,
          halted: peer.halted ?? null,
          settingsError: peer.settingsError ?? null,
          bridgesLive: peer.bridges?.reporting ?? [],
          bridgesSilent: peer.bridges?.silent ?? [],
          armed: (peer.arming || []).filter(a => a.autoMode).map(a => a.tag),
        },
        divergence,
        parity: plan.parity ?? null,
        heartbeats: plan.heartbeats ?? null,
        unreviewedProposals: fleet?.proposals ?? null,
        settingsComparison: (fleet?.settingsComparison || []).filter(f => f.differs),
        feedsTheGate: false,
      };
      return full ? { summary, plan, fleet } : summary;
    },
  },

  {
    name: 'get_ai_work',
    description:
      'The AI employee\'s timesheet and appraisal: did the scheduled agents run, did they ' +
      'succeed, and did anyone read what they wrote. Verdict per job — HEALTHY, FAILING, STALE, ' +
      'INCOMPLETE, NO COMPLETION MARKER, or OUTPUT IGNORED, which means the agent is working and ' +
      'nobody is reading it and costs exactly what failing costs. Also lists every PROPOSED FIX ' +
      'harvested from the job logs with its decision status. Read-only over logs those jobs ' +
      'already write: runs nothing, spawns nothing, spends no tokens. NOTE this covers THIS box ' +
      'only — use get_fleet_status for the other box\'s unreviewed proposals, which is where they ' +
      'have historically piled up unseen.',
    inputSchema: {
      type: 'object',
      properties: {
        unreviewedOnly: { type: 'boolean', description: 'Return only proposals nobody has decided on yet' },
      },
    },
    async handler({ unreviewedOnly } = {}) {
      const data = await cached('ai-work', 30000, () => fetchJSON('/api/ai-work'));
      if (!unreviewedOnly || !data || !Array.isArray(data.proposals)) return data;
      // DEFERRED counts as still-owed work, not as read. `unreviewedOnly` means "show me
      // what still needs me", and a proposal accepted-but-unapplied needs someone as much
      // as an undecided one — filtering to UNREVIEWED alone would hide exactly the work
      // the deferred status was added to keep visible, which is the same disappearing act
      // the OUTPUT IGNORED verdict exists to prevent.
      const stillOwed = p => p.status === 'UNREVIEWED'
        || String(p.status || '').trim().toLowerCase() === 'deferred';
      return { ...data, proposals: data.proposals.filter(stillOwed) };
    },
  },

  {
    name: 'get_gate_health',
    description:
      'Per-gate kill/pass counts — which gate is actually stopping trades. Says a gate is FIRING; ' +
      'it does NOT say whether it should have, which is get_rejection_evidence\'s job. Never merge ' +
      'the two. Known and verified 2026-08-09: the funnel dies at CONFIDENCE (killed 5, passed 1) ' +
      'and 6 of the 10 gates look silent for correct reasons — ENTRY_RSI is disarmed by config, ' +
      'COHORT_FLOOR only records when a setup CLEARS the global gate first, and the bridge gates ' +
      'fire only on a real trade attempt so they are silent on the laptop and not on the VPS. ' +
      'NONE of the ten gates is broken. Do not "fix" them.',
    inputSchema: { type: 'object', properties: {} },
    async handler() {
      return cached('gate-health', 30000, () => fetchJSON('/api/gate-health'));
    },
  },

  {
    name: 'get_evidence_board',
    description:
      'What this system KNOWS versus what it merely assumes. Every curated claim carries its ' +
      'verdict, the evidence behind it, its caveat, and WHAT WOULD CHANGE THE ANSWER — joined to ' +
      'the live per-gate verdicts, so any number on the dashboard can be traced to whether it was ' +
      'ever tested. Read this before proposing a threshold change or repeating a claim about this ' +
      'system\'s edge. Curated claims live in server/evidence_register.js and MUST be updated ' +
      'whenever something new is measured, or the board goes stale and starts lying.',
    inputSchema: { type: 'object', properties: {} },
    async handler() {
      return cached('evidence-board', 60000, () => fetchJSON('/api/evidence-board'));
    },
  },

  {
    name: 'run_walkforward',
    description:
      'Run the 5-fold walk-forward validation of the confidence gate against the LIVE signal ' +
      'engine and return the fold-by-fold expectancy table. This is how an edge claim gets ' +
      'settled: a gate is only worth acting on if it is positive in MOST folds, because one ' +
      'lucky stretch carrying a strong average is the exact failure this catches. Deterministic, ' +
      'no network, writes only under tasks/analysis. SLOW - takes minutes. Watch for a DEGRADED ' +
      'line in the output: it means the engine threw on some steps and the table is incomplete, ' +
      'usually because a new module-level constant is missing from SCALAR_CONSTS in _replay_mtf.cjs.',
    inputSchema: { type: 'object', properties: {} },
    async handler() {
      const stdout = await new Promise((resolve, reject) => {
        execFile(
          process.execPath, [path.join(ROOT, 'tasks', 'mtf_walkforward.cjs')],
          { cwd: ROOT, timeout: WALKFORWARD_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024,
            env: { ...process.env, NO_COLOR: '1' } },
          (err, out, stderr) => {
            const text = (out || '').trim() || (stderr || '').trim();
            if (err && !text) reject(new Error(stderr || err.message));
            else resolve(text);
          }
        );
      });
      // The census lines are one huge JSON blob per asset and swamp the table that
      // actually answers the question. Kept only as a degraded/throw indicator.
      const degraded = stdout.split('\n').filter(l => l.includes('DEGRADED'));
      const table    = stdout.split('\n').filter(l => !l.startsWith('MTF_CENSUS'));
      return { degraded: degraded.length > 0, warnings: degraded, report: table.join('\n') };
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

// Counted, not hardcoded. This banner read "19 tools" while 23 were registered —
// a number that only drifts in one direction and misreports the surface area of
// everything the AI can reach.
process.stderr.write(`[SmartEntry MCP v2] Started — ${TOOLS.length} tools ready\n`);

// Test seam. This file is the ENTIRE surface the AI can reach and had no test of any
// kind, because requiring it was the only way in and nothing was exported. The stdio
// listener above is deliberately left running on require rather than guarded: guarding
// it would change how this process starts in production, where .mcp.json launches it
// directly, and a test can simply exit when it is done.
module.exports = { execPython, runPython, pythonFailure };
