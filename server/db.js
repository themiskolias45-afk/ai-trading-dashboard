'use strict';
// SQLite database layer for SmartEntry Pro
// Tables: trades, signals, learning, alerts, performance
// Falls back to JSON files if SQLite not available

let Database;
try {
  Database = require('better-sqlite3');
} catch (e) {
  console.warn('[DB] better-sqlite3 not installed — run: npm install better-sqlite3');
  Database = null;
}

let db = null;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS trades (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol      TEXT,
  direction   TEXT,
  setup       TEXT,
  entry       REAL,
  stop        REAL,
  target      REAL,
  size        REAL,
  confidence  INTEGER,
  opened_at   TEXT,
  closed_at   TEXT,
  pnl         REAL,
  outcome     TEXT,
  notes       TEXT
);

CREATE TABLE IF NOT EXISTS signals (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol       TEXT,
  direction    TEXT,
  setup        TEXT,
  confidence   INTEGER,
  strength     TEXT,
  entry        REAL,
  stop         REAL,
  target       REAL,
  generated_at TEXT,
  fired        INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS learning (
  setup        TEXT PRIMARY KEY,
  wins         INTEGER DEFAULT 0,
  losses       INTEGER DEFAULT 0,
  total_pnl    REAL    DEFAULT 0,
  last_updated TEXT
);

CREATE TABLE IF NOT EXISTS performance (
  date         TEXT PRIMARY KEY,
  total_trades INTEGER,
  wins         INTEGER,
  losses       INTEGER,
  gross_pnl    REAL,
  net_pnl      REAL,
  win_rate     REAL,
  best_setup   TEXT,
  worst_setup  TEXT
);
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function notAvailable(fnName) {
  console.warn(`[DB] ${fnName}() called but better-sqlite3 is not available`);
}

function isReady(fnName) {
  if (!Database) {
    notAvailable(fnName);
    return false;
  }
  if (!db) {
    console.warn(`[DB] ${fnName}() called before init()`);
    return false;
  }
  return true;
}

function buildWhereClause(filters) {
  const conditions = [];
  const values = [];

  if (filters.symbol) {
    conditions.push('symbol = ?');
    values.push(filters.symbol);
  }
  if (filters.outcome) {
    conditions.push('outcome = ?');
    values.push(filters.outcome);
  }
  if (filters.direction) {
    conditions.push('direction = ?');
    values.push(filters.direction);
  }
  if (filters.setup) {
    conditions.push('setup = ?');
    values.push(filters.setup);
  }
  if (filters.from) {
    conditions.push('opened_at >= ?');
    values.push(filters.from);
  }
  if (filters.to) {
    conditions.push('opened_at <= ?');
    values.push(filters.to);
  }

  const clause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  return { clause, values };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Open or create the SQLite database and run schema migrations.
 * @param {string} dbPath - Absolute path to the .db file.
 */
function init(dbPath) {
  if (!Database) {
    notAvailable('init');
    return;
  }
  if (!dbPath) {
    throw new Error('[DB] init() requires a dbPath argument');
  }

  try {
    db = new Database(dbPath);

    // WAL mode: better write concurrency, safe on Windows
    db.pragma('journal_mode = WAL');
    // Enforce foreign key constraints
    db.pragma('foreign_keys = ON');
    // Reasonable busy timeout so concurrent writers don't crash immediately
    db.pragma('busy_timeout = 5000');

    // Create all tables in a single transaction
    db.exec(SCHEMA);

    console.log(`[DB] Opened: ${dbPath}`);
  } catch (err) {
    console.error('[DB] init() failed:', err.message);
    db = null;
    throw err;
  }
}

/**
 * Insert a trade record. Returns the new row id, or null on failure.
 * @param {object} trade
 */
function insertTrade(trade) {
  if (!isReady('insertTrade')) return null;

  const sql = `
    INSERT INTO trades
      (symbol, direction, setup, entry, stop, target, size, confidence,
       opened_at, closed_at, pnl, outcome, notes)
    VALUES
      (@symbol, @direction, @setup, @entry, @stop, @target, @size, @confidence,
       @opened_at, @closed_at, @pnl, @outcome, @notes)
  `;

  try {
    const stmt = db.prepare(sql);
    const result = stmt.run({
      symbol:     trade.symbol     ?? null,
      direction:  trade.direction  ?? null,
      setup:      trade.setup      ?? null,
      entry:      trade.entry      ?? null,
      stop:       trade.stop       ?? null,
      target:     trade.target     ?? null,
      size:       trade.size       ?? null,
      confidence: trade.confidence ?? null,
      opened_at:  trade.openTime ?? trade.opened_at ?? new Date().toISOString(),
      closed_at:  trade.closed_at  ?? null,
      pnl:        trade.pnl        ?? null,
      outcome:    trade.outcome    ?? null,
      notes:      trade.notes      ?? null,
    });
    return result.lastInsertRowid;
  } catch (err) {
    console.error('[DB] insertTrade() failed:', err.message);
    return null;
  }
}

/**
 * Update fields on an existing trade.
 * @param {number} id
 * @param {object} updates - Only the keys to change.
 * @returns {number} rows changed
 */
function updateTrade(id, updates) {
  if (!isReady('updateTrade')) return 0;
  if (!id || typeof updates !== 'object' || updates === null) {
    console.warn('[DB] updateTrade() requires id and updates object');
    return 0;
  }

  const ALLOWED = new Set([
    'symbol', 'direction', 'setup', 'entry', 'stop', 'target',
    'size', 'confidence', 'opened_at', 'closed_at', 'pnl', 'outcome', 'notes',
  ]);

  const fields = Object.keys(updates).filter(k => ALLOWED.has(k));
  if (fields.length === 0) {
    console.warn('[DB] updateTrade() — no valid fields to update');
    return 0;
  }

  const setClause = fields.map(f => `${f} = @${f}`).join(', ');
  const sql = `UPDATE trades SET ${setClause} WHERE id = @id`;

  try {
    const stmt = db.prepare(sql);
    const result = stmt.run({ ...updates, id });
    return result.changes;
  } catch (err) {
    console.error('[DB] updateTrade() failed:', err.message);
    return 0;
  }
}

/**
 * Query trades with optional filters.
 * @param {object} opts - { symbol, outcome, direction, setup, from, to, limit, orderBy }
 * @returns {Array}
 */
function getTrades(opts = {}) {
  if (!isReady('getTrades')) return [];

  const { clause, values } = buildWhereClause(opts);
  const order = opts.orderBy || 'opened_at DESC';
  const limit = opts.limit ? `LIMIT ${parseInt(opts.limit, 10)}` : '';

  const sql = `SELECT * FROM trades ${clause} ORDER BY ${order} ${limit}`.trim();

  try {
    const stmt = db.prepare(sql);
    return stmt.all(...values);
  } catch (err) {
    console.error('[DB] getTrades() failed:', err.message);
    return [];
  }
}

/**
 * Log a signal.
 * @param {object} signal
 * @returns {number|null} new row id
 */
function insertSignal(signal) {
  if (!isReady('insertSignal')) return null;

  const sql = `
    INSERT INTO signals
      (symbol, direction, setup, confidence, strength, entry, stop, target,
       generated_at, fired)
    VALUES
      (@symbol, @direction, @setup, @confidence, @strength, @entry, @stop, @target,
       @generated_at, @fired)
  `;

  try {
    const stmt = db.prepare(sql);
    const result = stmt.run({
      symbol:       signal.symbol       ?? null,
      direction:    signal.direction    ?? null,
      setup:        signal.setup        ?? null,
      confidence:   signal.confidence   ?? null,
      strength:     signal.strength     ?? null,
      entry:        signal.entry        ?? null,
      stop:         signal.stop         ?? null,
      target:       signal.target       ?? null,
      generated_at: signal.generated_at ?? new Date().toISOString(),
      fired:        signal.fired        ?? 0,
    });
    return result.lastInsertRowid;
  } catch (err) {
    console.error('[DB] insertSignal() failed:', err.message);
    return null;
  }
}

/**
 * Increment wins or losses and accumulate PnL for a setup.
 * Creates the row if it doesn't exist.
 * @param {string} setup
 * @param {'WIN'|'LOSS'|'BREAKEVEN'} outcome
 * @param {number} pnl
 */
function updateLearning(setup, outcome, pnl) {
  if (!isReady('updateLearning')) return;
  if (!setup) {
    console.warn('[DB] updateLearning() requires a setup name');
    return;
  }

  const winDelta  = outcome === 'WIN'  ? 1 : 0;
  const lossDelta = outcome === 'LOSS' ? 1 : 0;
  const pnlDelta  = typeof pnl === 'number' ? pnl : 0;
  const now       = new Date().toISOString();

  const sql = `
    INSERT INTO learning (setup, wins, losses, total_pnl, last_updated)
      VALUES (@setup, @wins, @losses, @pnl, @now)
    ON CONFLICT(setup) DO UPDATE SET
      wins         = wins + @wins,
      losses       = losses + @losses,
      total_pnl    = total_pnl + @pnl,
      last_updated = @now
  `;

  try {
    const stmt = db.prepare(sql);
    stmt.run({ setup, wins: winDelta, losses: lossDelta, pnl: pnlDelta, now });
  } catch (err) {
    console.error('[DB] updateLearning() failed:', err.message);
  }
}

/**
 * Get learning stats for one setup.
 * @param {string} setup
 * @returns {object|null}
 */
function getLearning(setup) {
  if (!isReady('getLearning')) return null;
  if (!setup) return null;

  try {
    const stmt = db.prepare('SELECT * FROM learning WHERE setup = ?');
    return stmt.get(setup) ?? null;
  } catch (err) {
    console.error('[DB] getLearning() failed:', err.message);
    return null;
  }
}

/**
 * All setup stats, ordered by total trades descending.
 * @returns {Array}
 */
function getAllLearning() {
  if (!isReady('getAllLearning')) return [];

  try {
    const stmt = db.prepare('SELECT * FROM learning ORDER BY (wins + losses) DESC');
    return stmt.all();
  } catch (err) {
    console.error('[DB] getAllLearning() failed:', err.message);
    return [];
  }
}

/**
 * Insert or replace a daily performance record.
 * @param {string} date - ISO date string e.g. '2026-07-21'
 * @param {object} stats
 */
function upsertPerformance(date, stats) {
  if (!isReady('upsertPerformance')) return;
  if (!date || typeof stats !== 'object' || stats === null) {
    console.warn('[DB] upsertPerformance() requires date and stats object');
    return;
  }

  const sql = `
    INSERT INTO performance
      (date, total_trades, wins, losses, gross_pnl, net_pnl, win_rate,
       best_setup, worst_setup)
    VALUES
      (@date, @total_trades, @wins, @losses, @gross_pnl, @net_pnl, @win_rate,
       @best_setup, @worst_setup)
    ON CONFLICT(date) DO UPDATE SET
      total_trades = @total_trades,
      wins         = @wins,
      losses       = @losses,
      gross_pnl    = @gross_pnl,
      net_pnl      = @net_pnl,
      win_rate     = @win_rate,
      best_setup   = @best_setup,
      worst_setup  = @worst_setup
  `;

  try {
    const stmt = db.prepare(sql);
    stmt.run({
      date,
      total_trades: stats.total_trades ?? 0,
      wins:         stats.wins         ?? 0,
      losses:       stats.losses       ?? 0,
      gross_pnl:    stats.gross_pnl    ?? 0,
      net_pnl:      stats.net_pnl      ?? 0,
      win_rate:     stats.win_rate     ?? 0,
      best_setup:   stats.best_setup   ?? null,
      worst_setup:  stats.worst_setup  ?? null,
    });
  } catch (err) {
    console.error('[DB] upsertPerformance() failed:', err.message);
  }
}

/**
 * Last N days of performance data.
 * @param {number} days
 * @returns {Array}
 */
function getPerformance(days = 30) {
  if (!isReady('getPerformance')) return [];

  const limit = Math.max(1, parseInt(days, 10) || 30);

  try {
    const stmt = db.prepare(
      'SELECT * FROM performance ORDER BY date DESC LIMIT ?'
    );
    return stmt.all(limit);
  } catch (err) {
    console.error('[DB] getPerformance() failed:', err.message);
    return [];
  }
}

/**
 * Execute a raw SQL query. Returns rows for SELECT, info object otherwise.
 * @param {string} sql
 * @param {Array} params
 * @returns {Array|object|null}
 */
function query(sql, params = []) {
  if (!isReady('query')) return null;
  if (typeof sql !== 'string' || !sql.trim()) {
    console.warn('[DB] query() requires a non-empty SQL string');
    return null;
  }

  try {
    const stmt = db.prepare(sql);
    const isSelect = sql.trimStart().toUpperCase().startsWith('SELECT');
    return isSelect ? stmt.all(...params) : stmt.run(...params);
  } catch (err) {
    console.error('[DB] query() failed:', err.message, '|', sql);
    return null;
  }
}

/**
 * Close the database connection.
 */
function close() {
  if (!db) return;
  try {
    db.close();
    db = null;
    console.log('[DB] Connection closed');
  } catch (err) {
    console.error('[DB] close() failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  init,
  insertTrade,
  updateTrade,
  getTrades,
  insertSignal,
  updateLearning,
  getLearning,
  getAllLearning,
  upsertPerformance,
  getPerformance,
  query,
  close,
};
