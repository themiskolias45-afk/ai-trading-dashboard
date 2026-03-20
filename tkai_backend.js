/**
 * SMART ENTRY PRO — BACKEND ENGINE V3
 * Multi-Asset Signal Engine: BTC, GOLD, SP500, MSFT, AMZN
 * Indicators : EMA9/21, RSI14, ATR14, MACD
 * Output     : BUY/SELL/HOLD · Entry · SL · TP1/TP2/TP3 · Confidence · Score breakdown
 * API        : /api/status  /api/signals  /api/signal?asset=  /api/log  /api/stats
 * Telegram   : /start /signals /btc /gold /sp500 /msft /amzn /daily
 */

import fetch    from 'node-fetch';
import http     from 'http';
import cron     from 'node-cron';
import crypto   from 'crypto';
import fs       from 'fs';
import path     from 'path';
import { URL, fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============================================================
// CONFIG
// ============================================================
const TELEGRAM_TOKEN  = process.env.TELEGRAM_TOKEN  || '8246792368:AAG8bxkAIEulUddX5PnQjnC6BubqM3p-NeA';
const PORT            = process.env.PORT || 4000;
const MAX_LOG         = 300;
const SERVE_STATIC    = process.env.SERVE_STATIC === 'true';

// Binance API credentials (set in .env for live trading)
const BINANCE_KEY     = process.env.BINANCE_KEY    || '';
const BINANCE_SECRET  = process.env.BINANCE_SECRET || '';
const BINANCE_BASE    = 'https://api.binance.com';

// Binance symbol map (assetId → Binance trading pair)
const BINANCE_SYMBOLS = { BTC: 'BTCUSDT' };

const ASSETS = [
  { id: 'BTC',   symbol: 'BTC-USD', name: 'Bitcoin',   decimals: 0 },
  { id: 'GOLD',  symbol: 'GC=F',    name: 'Gold',      decimals: 2 },
  { id: 'SP500', symbol: '^GSPC',   name: 'S&P 500',   decimals: 2 },
  { id: 'MSFT',  symbol: 'MSFT',    name: 'Microsoft', decimals: 2 },
  { id: 'AMZN',  symbol: 'AMZN',    name: 'Amazon',    decimals: 2 },
];

// ============================================================
// TECHNICAL INDICATORS
// ============================================================

function calcEMA(prices, period) {
  if (!prices.length) return 0;
  const len = Math.min(period, prices.length);
  const k   = 2 / (len + 1);
  let ema   = prices.slice(0, len).reduce((a, b) => a + b, 0) / len;
  for (let i = len; i < prices.length; i++) ema = prices[i] * k + ema * (1 - k);
  return ema;
}

function calcRSI(prices, period = 14) {
  if (prices.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const d = prices[i] - prices[i - 1];
    if (d > 0) gains += d; else losses += Math.abs(d);
  }
  const avg = gains / period, avl = losses / period;
  if (avl === 0) return 100;
  return 100 - 100 / (1 + avg / avl);
}

function calcATR(highs, lows, closes, period = 14) {
  const trs = [];
  for (let i = 1; i < highs.length; i++) {
    trs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i]  - closes[i - 1])
    ));
  }
  const s = trs.slice(-period);
  return s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0;
}

function calcMACD(prices) {
  if (prices.length < 27) return { macd: 0, signal: 0, hist: 0 };
  const ema12 = calcEMA(prices, 12);
  const ema26 = calcEMA(prices, 26);
  const macd  = ema12 - ema26;
  const sig   = macd * 0.9;   // simplified signal
  return { macd, signal: sig, hist: macd - sig };
}

// ============================================================
// SIGNAL ENGINE
// ============================================================

function generateSignal(closes, highs, lows, asset) {
  const n = closes.length;
  if (n < 30) return { signal: 'N/A', bias: 'N/A', trend: 'N/A', confidence: 0, breakdown: [] };

  const ema9  = calcEMA(closes, 9);
  const ema21 = calcEMA(closes, 21);
  const rsi   = calcRSI(closes, 14);
  const atr   = calcATR(highs, lows, closes, 14);
  const macd  = calcMACD(closes);
  const price = closes[n - 1];
  const prev  = closes[n - 2];

  // Trend label
  const emaDiff = ema9 - ema21;
  const trend   = emaDiff >  ema21 * 0.001 ? 'UP'   :
                  emaDiff < -ema21 * 0.001 ? 'DOWN' : 'RANGE';

  // Scored breakdown (each criterion: name, vote +1/-1/0, label)
  const criteria = [
    {
      name: 'EMA Cross',
      vote: ema9 > ema21 ? 2 : -2,
      label: ema9 > ema21 ? 'EMA9 > EMA21 ▲' : 'EMA9 < EMA21 ▼',
      bull: ema9 > ema21,
    },
    {
      name: 'Price vs EMA21',
      vote: price > ema21 ? 1 : -1,
      label: price > ema21 ? 'Above EMA21 ▲' : 'Below EMA21 ▼',
      bull: price > ema21,
    },
    {
      name: 'RSI Zone',
      vote: rsi >= 70 ? -2 : rsi <= 30 ? 2 : rsi > 50 ? 1 : -1,
      label: rsi >= 70 ? 'Overbought ▼' : rsi <= 30 ? 'Oversold ▲' : rsi > 50 ? 'Bull zone ▲' : 'Bear zone ▼',
      bull: rsi <= 30 || (rsi > 50 && rsi < 70),
    },
    {
      name: 'Candle',
      vote: price > prev ? 1 : -1,
      label: price > prev ? 'Bullish candle ▲' : 'Bearish candle ▼',
      bull: price > prev,
    },
    {
      name: 'MACD',
      vote: macd.hist > 0 ? 1 : -1,
      label: macd.hist > 0 ? 'Histogram+ ▲' : 'Histogram- ▼',
      bull: macd.hist > 0,
    },
  ];

  const score    = criteria.reduce((s, c) => s + c.vote, 0);
  const maxScore = 8;
  const signal   = score >= 3 ? 'BUY' : score <= -3 ? 'SELL' : 'HOLD';
  const bias     = signal === 'BUY' ? 'BULLISH' : signal === 'SELL' ? 'BEARISH' : 'NEUTRAL';
  const confidence = Math.min(95, Math.max(30, Math.round((Math.abs(score) / maxScore) * 100)));

  // ATR-based levels
  const d = asset.decimals;
  let entry = price, sl, tp1, tp2, tp3;
  if (signal === 'BUY') {
    sl = entry - atr * 1.5; tp1 = entry + atr; tp2 = entry + atr * 2; tp3 = entry + atr * 3.5;
  } else if (signal === 'SELL') {
    sl = entry + atr * 1.5; tp1 = entry - atr; tp2 = entry - atr * 2; tp3 = entry - atr * 3.5;
  } else if (ema9 >= ema21) {
    sl = entry - atr * 1.5; tp1 = entry + atr; tp2 = entry + atr * 2; tp3 = entry + atr * 3.5;
  } else {
    sl = entry + atr * 1.5; tp1 = entry - atr; tp2 = entry - atr * 2; tp3 = entry - atr * 3.5;
  }

  const f = v => +v.toFixed(d);
  return {
    signal, bias, trend, confidence, score,
    entry: f(entry), sl: f(sl), tp1: f(tp1), tp2: f(tp2), tp3: f(tp3),
    rsi:      +rsi.toFixed(1),
    ema9:     f(ema9),
    ema21:    f(ema21),
    atr:      f(atr),
    macdHist: f(macd.hist),
    breakdown: criteria.map(c => ({ name: c.name, label: c.label, bull: c.bull, vote: c.vote })),
  };
}

// ============================================================
// DATA FETCHER
// ============================================================

async function fetchOHLCV(symbol) {
  const enc = encodeURIComponent(symbol);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${enc}?interval=5m&range=2d&includePrePost=false`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Accept:       'application/json',
      Referer:      'https://finance.yahoo.com',
    },
  });
  if (!res.ok) throw new Error(`Yahoo Finance HTTP ${res.status}`);
  const data   = await res.json();
  const result = data.chart?.result?.[0];
  if (!result)  throw new Error(`No data for ${symbol}`);
  const q       = result.indicators.quote[0];
  const candles = (result.timestamp || [])
    .map((t, i) => ({ t, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i] }))
    .filter(x => x.c != null && x.h != null && x.l != null && x.o != null);
  if (!candles.length) throw new Error(`Empty candles for ${symbol}`);
  return { candles, currentPrice: result.meta.regularMarketPrice ?? candles.at(-1).c };
}

async function analyzeAsset(asset) {
  try {
    const { candles, currentPrice } = await fetchOHLCV(asset.symbol);
    const closes = candles.map(x => x.c);
    const highs  = candles.map(x => x.h);
    const lows   = candles.map(x => x.l);
    const change = closes.length > 1
      ? ((closes.at(-1) - closes[0]) / closes[0]) * 100
      : 0;
    const sig = generateSignal(closes, highs, lows, asset);
    return { id: asset.id, name: asset.name, symbol: asset.symbol, price: currentPrice, change: +change.toFixed(2), ...sig, updated: new Date().toISOString(), ok: true };
  } catch (e) {
    console.error(`[${asset.id}]`, e.message);
    return { id: asset.id, name: asset.name, symbol: asset.symbol, price: null, change: null, signal: 'ERROR', bias: 'N/A', trend: 'N/A', confidence: 0, breakdown: [], error: e.message, updated: new Date().toISOString(), ok: false };
  }
}

// ============================================================
// SIGNAL CACHE + LOG
// ============================================================

let signalsCache = [];
let lastRefresh  = 0;

// Signal change log — fires when an asset's signal changes value
const signalLog     = [];
const prevSignalMap = {};   // assetId → last signal string

// Stats: track BUY/SELL counts per asset
const signalStats = {};   // assetId → { buy, sell, hold, errors }

function recordSignal(s) {
  // Stats
  if (!signalStats[s.id]) signalStats[s.id] = { buy: 0, sell: 0, hold: 0, errors: 0 };
  const st = signalStats[s.id];
  if (s.signal === 'BUY')   st.buy++;
  else if (s.signal === 'SELL') st.sell++;
  else if (s.signal === 'HOLD') st.hold++;
  else st.errors++;

  // Log change
  if (prevSignalMap[s.id] !== s.signal) {
    signalLog.unshift({
      time:       new Date().toISOString(),
      asset:      s.id,
      name:       s.name,
      signal:     s.signal,
      prev:       prevSignalMap[s.id] || 'NONE',
      price:      s.price,
      confidence: s.confidence,
      bias:       s.bias,
      trend:      s.trend,
      rsi:        s.rsi,
    });
    if (signalLog.length > MAX_LOG) signalLog.pop();
    prevSignalMap[s.id] = s.signal;
  }
}

async function refreshAllSignals() {
  console.log('[Engine] Refreshing...');
  try {
    const settled = await Promise.allSettled(ASSETS.map(analyzeAsset));
    signalsCache  = settled.map((r, i) =>
      r.status === 'fulfilled'
        ? r.value
        : { id: ASSETS[i].id, name: ASSETS[i].name, signal: 'ERROR', ok: false, breakdown: [] }
    );
    signalsCache.forEach(recordSignal);
    lastRefresh = Date.now();
    console.log('[Engine]', signalsCache.map(s => `${s.id}:${s.signal}(${s.confidence ?? 0}%)`).join(' | '));
    await checkAutoTrade(signalsCache);
  } catch (e) {
    console.error('[Engine] Refresh error:', e.message);
  }
  return signalsCache;
}

cron.schedule('*/2 * * * *', refreshAllSignals);

// ============================================================
// BINANCE API HELPERS
// ============================================================

function bnSign(params) {
  const q = new URLSearchParams(params).toString();
  return crypto.createHmac('sha256', BINANCE_SECRET).update(q).digest('hex');
}

async function bnGet(endpoint, params = {}) {
  const p = { ...params, timestamp: Date.now() };
  p.signature = bnSign(p);
  const res = await fetch(`${BINANCE_BASE}${endpoint}?${new URLSearchParams(p)}`, {
    headers: { 'X-MBX-APIKEY': BINANCE_KEY },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Binance GET ${endpoint}: ${data.msg || res.status}`);
  return data;
}

async function bnPost(endpoint, params = {}) {
  const p = { ...params, timestamp: Date.now() };
  p.signature = bnSign(p);
  const res = await fetch(`${BINANCE_BASE}${endpoint}`, {
    method:  'POST',
    headers: { 'X-MBX-APIKEY': BINANCE_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams(p).toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Binance POST ${endpoint}: ${data.msg || res.status}`);
  return data;
}

async function bnGetUsdtBalance() {
  const data = await bnGet('/api/v3/account');
  const bal  = (data.balances || []).find(b => b.asset === 'USDT');
  return parseFloat(bal?.free || 0);
}

async function bnGetBtcBalance() {
  const data = await bnGet('/api/v3/account');
  const bal  = (data.balances || []).find(b => b.asset === 'BTC');
  return parseFloat(bal?.free || 0);
}

// ============================================================
// AUTO-TRADE ENGINE
// ============================================================

const AT = {
  enabled:   false,
  mode:      'PAPER',   // 'PAPER' | 'LIVE'
  assets:    ['BTC'],   // which assets to auto-trade
  minConf:   70,
  riskPct:   1,
  tpLevel:   2,
  positions: {},        // assetId → { side, entry, qty, sl, tp, openTime, orderId? }
  history:   [],        // { asset, side, entry, exit, qty, pnlPct, pnlUsdt, result, openTime, closeTime, reason }
  logs:      [],        // execution log lines
  stats:     { wins: 0, losses: 0, totalPnlPct: 0, totalPnlUsdt: 0 },
};

function atLog(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log('[AutoTrade]', msg);
  AT.logs.unshift(line);
  if (AT.logs.length > 200) AT.logs.pop();
}

function atGetTp(sig) {
  return AT.tpLevel === 1 ? sig.tp1 : AT.tpLevel === 3 ? sig.tp3 : sig.tp2;
}

async function atOpenPosition(sig) {
  const { id, signal, entry, sl, atr } = sig;
  const tp  = atGetTp(sig);
  const qty = AT.mode === 'LIVE' ? null : 0;   // qty computed below

  if (AT.mode === 'LIVE') {
    if (!BINANCE_KEY || !BINANCE_SECRET) {
      atLog(`LIVE trade skipped — no Binance credentials (set BINANCE_KEY + BINANCE_SECRET in .env)`);
      return;
    }
    if (!BINANCE_SYMBOLS[id]) {
      atLog(`${id}: not supported for LIVE Binance trading (only BTC)`);
      return;
    }
    try {
      const balance   = await bnGetUsdtBalance();
      const riskUsdt  = balance * (AT.riskPct / 100);
      const rawQty    = riskUsdt / entry;
      const liveQty   = Math.floor(rawQty * 100000) / 100000;   // 5 decimals for BTC
      if (liveQty < 0.00001) { atLog(`${id}: qty too small (${liveQty}) — increase balance or risk`); return; }

      const side  = signal === 'BUY' ? 'BUY' : 'SELL';
      const order = await bnPost('/api/v3/order', {
        symbol:    BINANCE_SYMBOLS[id],
        side,
        type:      'MARKET',
        quantity:  liveQty,
      });
      AT.positions[id] = { side: signal, entry, qty: liveQty, sl, tp, openTime: new Date().toISOString(), orderId: order.orderId };
      atLog(`LIVE ${signal} ${id} qty=${liveQty} @ ${entry} | SL:${sl} TP:${tp} | orderId:${order.orderId}`);
    } catch (e) {
      atLog(`LIVE open error ${id}: ${e.message}`);
    }
    return;
  }

  // PAPER mode — all 5 assets supported
  const paperQty = atr > 0 ? +(1000 / entry).toFixed(6) : 0.001;
  AT.positions[id] = { side: signal, entry, qty: paperQty, sl, tp, openTime: new Date().toISOString() };
  atLog(`PAPER ${signal} ${id} @ ${entry} | SL:${sl} TP:${tp}`);
}

async function atClosePosition(assetId, exitPrice, reason) {
  const pos = AT.positions[assetId];
  if (!pos) return;

  if (AT.mode === 'LIVE' && pos.orderId && BINANCE_SYMBOLS[assetId]) {
    try {
      await bnPost('/api/v3/order', {
        symbol:   BINANCE_SYMBOLS[assetId],
        side:     pos.side === 'BUY' ? 'SELL' : 'BUY',
        type:     'MARKET',
        quantity: pos.qty,
      });
    } catch (e) {
      atLog(`LIVE close error ${assetId}: ${e.message}`);
    }
  }

  const pnlPct  = pos.side === 'BUY'
    ? ((exitPrice - pos.entry) / pos.entry) * 100
    : ((pos.entry - exitPrice) / pos.entry) * 100;
  const pnlUsdt = AT.mode === 'PAPER' ? +(pnlPct / 100 * pos.qty * pos.entry).toFixed(4) : 0;
  const result  = pnlPct >= 0 ? 'WIN' : 'LOSS';

  AT.history.unshift({
    asset:     assetId,
    side:      pos.side,
    entry:     pos.entry,
    exit:      exitPrice,
    qty:       pos.qty,
    pnlPct:    +pnlPct.toFixed(3),
    pnlUsdt,
    result,
    openTime:  pos.openTime,
    closeTime: new Date().toISOString(),
    reason,
  });
  if (AT.history.length > 500) AT.history.pop();

  AT.stats[result === 'WIN' ? 'wins' : 'losses']++;
  AT.stats.totalPnlPct  = +(AT.stats.totalPnlPct  + pnlPct).toFixed(3);
  AT.stats.totalPnlUsdt = +(AT.stats.totalPnlUsdt + pnlUsdt).toFixed(4);

  atLog(`CLOSE ${assetId} ${pos.side} @ ${exitPrice} | P&L: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(3)}% | ${result} | ${reason}`);
  delete AT.positions[assetId];
}

async function checkAutoTrade(signals) {
  if (!AT.enabled) return;
  for (const sig of signals) {
    if (!AT.assets.includes(sig.id)) continue;
    if (!sig.ok || sig.signal === 'ERROR') continue;

    const pos = AT.positions[sig.id];

    // Check stop-loss / take-profit on open positions
    if (pos && sig.price != null) {
      const hitSL = pos.side === 'BUY'  ? sig.price <= pos.sl : sig.price >= pos.sl;
      const hitTP = pos.side === 'BUY'  ? sig.price >= pos.tp : sig.price <= pos.tp;
      if (hitSL) { await atClosePosition(sig.id, sig.price, 'SL HIT'); continue; }
      if (hitTP) { await atClosePosition(sig.id, sig.price, 'TP HIT'); continue; }
    }

    if (sig.signal === 'BUY' || sig.signal === 'SELL') {
      const confOk = (sig.confidence || 0) >= AT.minConf;
      if (!confOk) continue;

      if (pos && pos.side !== sig.signal) {
        // Signal flipped — close old, open new
        await atClosePosition(sig.id, sig.price, 'SIGNAL FLIP');
        await atOpenPosition(sig);
      } else if (!pos) {
        await atOpenPosition(sig);
      }
    } else if (sig.signal === 'HOLD' && pos) {
      await atClosePosition(sig.id, sig.price, 'HOLD SIGNAL');
    }
  }
}

// ============================================================
// HTTP API SERVER
// ============================================================

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type':                 'application/json',
};

function jsonRes(res, code, data) {
  res.writeHead(code, CORS);
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(200, CORS); res.end(); return; }

  const parsed = new URL(req.url, `http://localhost:${PORT}`);
  const path   = parsed.pathname;

  // Auto-refresh stale cache
  if (path.startsWith('/api/') && Date.now() - lastRefresh > 180_000) {
    await refreshAllSignals();
  }

  if (path === '/api/status') {
    const btc  = signalsCache.find(s => s.id === 'BTC');
    const gold = signalsCache.find(s => s.id === 'GOLD');
    jsonRes(res, 200, { status: 'online', version: 'SmartEntryPro-V3', btc: btc?.price ?? null, gold: gold?.price ?? null, lastRefresh: lastRefresh ? new Date(lastRefresh).toISOString() : null, updated: new Date().toISOString() });
    return;
  }

  if (path === '/api/signals') {
    jsonRes(res, 200, { signals: signalsCache, lastRefresh: lastRefresh ? new Date(lastRefresh).toISOString() : null, assetCount: signalsCache.length });
    return;
  }

  if (path === '/api/signal') {
    const id   = parsed.searchParams.get('asset')?.toUpperCase();
    if (!id)   { jsonRes(res, 400, { error: 'asset param required' }); return; }
    const data = signalsCache.find(s => s.id === id);
    if (!data) { jsonRes(res, 404, { error: `${id} not found` }); return; }
    jsonRes(res, 200, data);
    return;
  }

  if (path === '/api/log') {
    const limit  = Math.min(parseInt(parsed.searchParams.get('limit') || '100'), MAX_LOG);
    const asset  = parsed.searchParams.get('asset')?.toUpperCase();
    const entries = asset ? signalLog.filter(e => e.asset === asset) : signalLog;
    jsonRes(res, 200, { log: entries.slice(0, limit), total: entries.length });
    return;
  }

  if (path === '/api/stats') {
    const stats = ASSETS.map(a => ({
      id:    a.id,
      name:  a.name,
      ...signalStats[a.id] ?? { buy: 0, sell: 0, hold: 0, errors: 0 },
      current: signalsCache.find(s => s.id === a.id)?.signal ?? 'N/A',
    }));
    jsonRes(res, 200, { stats, totalLogs: signalLog.length });
    return;
  }

  // ── AUTO-TRADE ROUTES ──────────────────────────────────────

  if (path === '/api/autotrade/status') {
    const openList = Object.entries(AT.positions).map(([id, p]) => {
      const cur = signalsCache.find(s => s.id === id);
      const pnlPct = cur?.price != null
        ? (p.side === 'BUY'
            ? ((cur.price - p.entry) / p.entry) * 100
            : ((p.entry - cur.price) / p.entry) * 100)
        : null;
      return { id, ...p, currentPrice: cur?.price ?? null, pnlPct: pnlPct != null ? +pnlPct.toFixed(3) : null };
    });
    jsonRes(res, 200, {
      enabled: AT.enabled, mode: AT.mode, assets: AT.assets,
      minConf: AT.minConf, riskPct: AT.riskPct, tpLevel: AT.tpLevel,
      positions: openList, history: AT.history.slice(0, 100),
      stats: AT.stats, logs: AT.logs.slice(0, 50),
      hasCredentials: !!(BINANCE_KEY && BINANCE_SECRET),
    });
    return;
  }

  if (path === '/api/autotrade/toggle' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const d = JSON.parse(body || '{}');
        AT.enabled = typeof d.enabled === 'boolean' ? d.enabled : !AT.enabled;
        if (typeof d.mode    === 'string')  AT.mode    = d.mode;
        if (Array.isArray(d.assets))        AT.assets  = d.assets;
        if (typeof d.minConf === 'number')  AT.minConf = d.minConf;
        if (typeof d.riskPct === 'number')  AT.riskPct = d.riskPct;
        if (typeof d.tpLevel === 'number')  AT.tpLevel = d.tpLevel;
        atLog(`Auto-trade ${AT.enabled ? 'ENABLED' : 'DISABLED'} | mode:${AT.mode} assets:${AT.assets} conf:${AT.minConf}% risk:${AT.riskPct}%`);
        jsonRes(res, 200, { ok: true, enabled: AT.enabled, mode: AT.mode });
      } catch { jsonRes(res, 400, { error: 'invalid JSON' }); }
    });
    return;
  }

  if (path === '/api/autotrade/closeall' && req.method === 'POST') {
    const ids = Object.keys(AT.positions);
    for (const id of ids) {
      const cur = signalsCache.find(s => s.id === id);
      await atClosePosition(id, cur?.price ?? AT.positions[id]?.entry, 'MANUAL CLOSE ALL');
    }
    jsonRes(res, 200, { ok: true, closed: ids.length });
    return;
  }

  // ── STATIC FILE SERVING (production / phone access) ───────

  if (SERVE_STATIC) {
    const distDir  = path.join(__dirname, 'dist');
    let   filePath = path.join(distDir, parsed.pathname === '/' ? 'index.html' : parsed.pathname);
    // SPA fallback
    if (!fs.existsSync(filePath)) filePath = path.join(distDir, 'index.html');
    if (fs.existsSync(filePath)) {
      const ext  = path.extname(filePath);
      const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
      res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
      fs.createReadStream(filePath).pipe(res);
      return;
    }
  }

  jsonRes(res, 404, { error: 'Not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ Smart Entry Pro V3 API → http://localhost:${PORT}`);
  console.log('   /api/status   /api/signals   /api/signal?asset=BTC');
  console.log('   /api/log      /api/log?asset=BTC&limit=50');
  console.log('   /api/stats');
  console.log('   /api/autotrade/status   /api/autotrade/toggle   /api/autotrade/closeall');
  if (SERVE_STATIC) console.log(`\n📱 Phone access → http://<your-pc-ip>:${PORT}`);
  console.log('');
});

// ============================================================
// TELEGRAM BOT
// ============================================================

async function sendTg(chatId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
  } catch (e) { console.error('[TG]', e.message); }
}

function fmtSig(s) {
  if (!s.ok || s.signal === 'ERROR') return `❌ ${s.id}: unavailable`;
  const icon = s.signal === 'BUY' ? '🟢' : s.signal === 'SELL' ? '🔴' : '⚪';
  let m = `${icon} <b>${s.id}</b> — ${s.signal} (${s.confidence}%)\n  💲${s.price?.toLocaleString()}\n`;
  if (s.signal !== 'HOLD') m += `  Entry:${s.entry}  SL:${s.sl}\n  TP1:${s.tp1}  TP2:${s.tp2}  TP3:${s.tp3}\n`;
  m += `  RSI:${s.rsi} | ${s.trend}`;
  return m;
}

async function handleMsg(msg) {
  if (!msg?.text) return;
  const id   = msg.chat.id;
  const text = msg.text.trim().toLowerCase();
  if (text === '/start') {
    await sendTg(id, '✅ <b>Smart Entry Pro V3</b>\nCommands:\n/signals /btc /gold /sp500 /msft /amzn /daily /log /stats');
    return;
  }
  if (text === '/signals') {
    if (!signalsCache.length) { await sendTg(id, '⏳ Loading...'); await refreshAllSignals(); }
    await sendTg(id, '📊 <b>LIVE SIGNALS</b>\n\n' + signalsCache.map(fmtSig).join('\n\n'));
    return;
  }
  const map = { '/btc': 'BTC', '/gold': 'GOLD', '/sp500': 'SP500', '/msft': 'MSFT', '/amzn': 'AMZN' };
  if (map[text]) { const s = signalsCache.find(x => x.id === map[text]); await sendTg(id, s ? fmtSig(s) : '⏳ try /signals'); return; }
  if (text === '/log') {
    const recent = signalLog.slice(0, 10).map(e => `${e.asset} → ${e.signal} (was ${e.prev}) @ $${e.price?.toLocaleString()}`).join('\n');
    await sendTg(id, `📋 <b>SIGNAL LOG</b> (last 10)\n\n${recent || 'No changes yet'}`);
    return;
  }
  if (text === '/stats') {
    const lines = ASSETS.map(a => {
      const st = signalStats[a.id];
      return st ? `${a.id}: BUY×${st.buy} SELL×${st.sell} HOLD×${st.hold}` : `${a.id}: no data`;
    });
    await sendTg(id, '📈 <b>SIGNAL STATS</b>\n\n' + lines.join('\n'));
    return;
  }
  if (text === '/daily') {
    const buys  = signalsCache.filter(s => s.signal === 'BUY').map(s => s.id).join(', ')  || 'None';
    const sells = signalsCache.filter(s => s.signal === 'SELL').map(s => s.id).join(', ') || 'None';
    await sendTg(id, `🗓 <b>DAILY REPORT</b>\n🟢 BUY: ${buys}\n🔴 SELL: ${sells}\n\n• Max 1-2% risk\n• Always SL\n• Partial at TP1`);
    return;
  }
}

let lastUpdateId = 0;
async function pollTg() {
  try {
    const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=10`);
    const d = await r.json();
    for (const u of d.result || []) { lastUpdateId = u.update_id; if (u.message) await handleMsg(u.message); }
  } catch (e) { console.error('[TG poll]', e.message); }
}
setInterval(pollTg, 5000);

// ============================================================
// STARTUP
// ============================================================
console.log('🚀 Smart Entry Pro V3 starting...');
refreshAllSignals().then(() => console.log('✅ Ready.\n'));
