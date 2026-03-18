/**
 * SMART ENTRY PRO — BACKEND ENGINE V2
 * Multi-Asset Signal Engine: BTC, GOLD, SP500, MSFT, AMZN
 * Indicators: EMA9, EMA21, RSI14, ATR14, MACD
 * Output: BUY/SELL/HOLD with Entry, SL, TP1, TP2, TP3 + Confidence
 * API: /api/status  /api/signals  /api/signal?asset=BTC
 * Telegram: /start /signals /btc /gold /sp500 /msft /amzn /daily
 */

import fetch from 'node-fetch';
import http  from 'http';
import cron  from 'node-cron';
import { URL } from 'url';

// ============================================================
// CONFIG
// ============================================================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '8246792368:AAG8bxkAIEulUddX5PnQjnC6BubqM3p-NeA';
const PORT           = process.env.PORT || 4000;

// Asset definitions — symbol is the Yahoo Finance ticker
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
  if (prices.length === 0) return 0;
  const len = Math.min(period, prices.length);
  const k   = 2 / (len + 1);
  // Seed with SMA of first `len` values
  let ema = prices.slice(0, len).reduce((a, b) => a + b, 0) / len;
  for (let i = len; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcRSI(prices, period = 14) {
  if (prices.length < period + 1) return 50;
  let gains = 0, losses = 0;
  const start = prices.length - period;
  for (let i = start; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff > 0) gains  += diff;
    else          losses += Math.abs(diff);
  }
  const avgGain = gains  / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function calcATR(highs, lows, closes, period = 14) {
  const trs = [];
  for (let i = 1; i < highs.length; i++) {
    trs.push(Math.max(
      highs[i]  - lows[i],
      Math.abs(highs[i]  - closes[i - 1]),
      Math.abs(lows[i]   - closes[i - 1])
    ));
  }
  const slice = trs.slice(-period);
  if (slice.length === 0) return 0;
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function calcMACD(prices) {
  if (prices.length < 27) return { macd: 0, signal: 0, hist: 0 };
  const ema12 = calcEMA(prices, 12);
  const ema26 = calcEMA(prices, 26);
  const macd  = ema12 - ema26;
  // Approximate signal line with a further smoothed value
  const macdSeries = [macd * 0.95, macd]; // simplified
  const signal = calcEMA(macdSeries, 2);
  return { macd, signal, hist: macd - signal };
}

// ============================================================
// SIGNAL GENERATION
// ============================================================

function generateSignal(closes, highs, lows, asset) {
  const n = closes.length;
  if (n < 30) {
    return { signal: 'N/A', bias: 'N/A', trend: 'N/A', confidence: 0 };
  }

  const ema9  = calcEMA(closes, 9);
  const ema21 = calcEMA(closes, 21);
  const rsi   = calcRSI(closes, 14);
  const atr   = calcATR(highs, lows, closes, 14);
  const macd  = calcMACD(closes);

  const current    = closes[n - 1];
  const prev       = closes[n - 2];
  const bullCandle = current > prev;

  // Trend
  const diff = ema9 - ema21;
  const trend =
    diff >  ema21 * 0.001 ? 'UP'   :
    diff < -ema21 * 0.001 ? 'DOWN' : 'RANGE';

  // Scoring system (max ±7)
  let score = 0;

  if (ema9 > ema21)        score += 2; else score -= 2;   // EMA cross (+2)
  if (current > ema21)     score += 1; else score -= 1;   // Price vs EMA21 (+1)
  if (rsi > 50 && rsi < 70) score += 1;                    // RSI bull zone
  if (rsi < 50 && rsi > 30) score -= 1;                    // RSI bear zone
  if (rsi >= 70)            score -= 2;                    // Overbought
  if (rsi <= 30)            score += 2;                    // Oversold
  if (bullCandle)           score += 1; else score -= 1;   // Candle direction
  if (macd.hist > 0)        score += 1; else score -= 1;   // MACD histogram

  let signal, bias;
  if      (score >= 3)  { signal = 'BUY';  bias = 'BULLISH'; }
  else if (score <= -3) { signal = 'SELL'; bias = 'BEARISH'; }
  else                  { signal = 'HOLD'; bias = 'NEUTRAL'; }

  // Confidence: how strongly the score leans
  const maxScore  = 8;
  const confidence = Math.min(95, Math.max(30,
    Math.round((Math.abs(score) / maxScore) * 100)
  ));

  // SL/TP levels based on ATR
  const atrMult = 1.5;
  const d       = asset.decimals;
  let entry, sl, tp1, tp2, tp3;

  entry = current;

  if (signal === 'BUY') {
    sl  = entry - atr * atrMult;
    tp1 = entry + atr * 1.0;
    tp2 = entry + atr * 2.0;
    tp3 = entry + atr * 3.5;
  } else if (signal === 'SELL') {
    sl  = entry + atr * atrMult;
    tp1 = entry - atr * 1.0;
    tp2 = entry - atr * 2.0;
    tp3 = entry - atr * 3.5;
  } else {
    // HOLD — show pending levels based on current trend
    if (ema9 >= ema21) {
      sl  = entry - atr * atrMult;
      tp1 = entry + atr * 1.0;
      tp2 = entry + atr * 2.0;
      tp3 = entry + atr * 3.5;
    } else {
      sl  = entry + atr * atrMult;
      tp1 = entry - atr * 1.0;
      tp2 = entry - atr * 2.0;
      tp3 = entry - atr * 3.5;
    }
  }

  return {
    signal, bias, trend, confidence,
    entry:    +entry.toFixed(d),
    sl:       +sl.toFixed(d),
    tp1:      +tp1.toFixed(d),
    tp2:      +tp2.toFixed(d),
    tp3:      +tp3.toFixed(d),
    rsi:      +rsi.toFixed(1),
    ema9:     +ema9.toFixed(d),
    ema21:    +ema21.toFixed(d),
    atr:      +atr.toFixed(d),
    macdHist: +macd.hist.toFixed(d),
    score,
  };
}

// ============================================================
// DATA FETCHER — Yahoo Finance 5m candles
// ============================================================

async function fetchOHLCV(symbol) {
  const encoded = encodeURIComponent(symbol);
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}` +
    `?interval=5m&range=2d&includePrePost=false`;

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept':     'application/json',
      'Referer':    'https://finance.yahoo.com',
    },
  });

  if (!res.ok) throw new Error(`Yahoo Finance HTTP ${res.status} for ${symbol}`);

  const data   = await res.json();
  const result = data.chart?.result?.[0];
  if (!result) throw new Error(`No chart result for ${symbol}`);

  const quotes     = result.indicators.quote[0];
  const timestamps = result.timestamp || [];

  // Build candle array, drop nulls
  const candles = timestamps
    .map((t, i) => ({
      t, o: quotes.open[i], h: quotes.high[i],
      l: quotes.low[i],  c: quotes.close[i], v: quotes.volume[i],
    }))
    .filter(x => x.c != null && x.h != null && x.l != null && x.o != null);

  if (candles.length === 0) throw new Error(`Empty candles for ${symbol}`);

  return {
    candles,
    currentPrice: result.meta.regularMarketPrice ?? candles[candles.length - 1].c,
  };
}

// ============================================================
// ANALYZE ONE ASSET
// ============================================================

async function analyzeAsset(asset) {
  try {
    const { candles, currentPrice } = await fetchOHLCV(asset.symbol);

    const closes = candles.map(x => x.c);
    const highs  = candles.map(x => x.h);
    const lows   = candles.map(x => x.l);
    const n      = closes.length;

    const change = n > 1
      ? ((closes[n - 1] - closes[0]) / closes[0]) * 100
      : 0;

    const sigData = generateSignal(closes, highs, lows, asset);

    return {
      id:      asset.id,
      name:    asset.name,
      symbol:  asset.symbol,
      price:   currentPrice,
      change:  +change.toFixed(2),
      ...sigData,
      updated: new Date().toISOString(),
      ok:      true,
    };
  } catch (e) {
    console.error(`[${asset.id}] Analysis error:`, e.message);
    return {
      id:         asset.id,
      name:       asset.name,
      symbol:     asset.symbol,
      price:      null,
      change:     null,
      signal:     'ERROR',
      bias:       'N/A',
      trend:      'N/A',
      confidence: 0,
      error:      e.message,
      updated:    new Date().toISOString(),
      ok:         false,
    };
  }
}

// ============================================================
// SIGNAL CACHE
// ============================================================

let signalsCache = [];
let lastRefresh  = 0;

async function refreshAllSignals() {
  console.log('[Engine] Refreshing signals for all assets...');
  try {
    const settled = await Promise.allSettled(ASSETS.map(analyzeAsset));
    signalsCache  = settled.map((r, i) =>
      r.status === 'fulfilled'
        ? r.value
        : { id: ASSETS[i].id, name: ASSETS[i].name, signal: 'ERROR', ok: false }
    );
    lastRefresh = Date.now();
    const summary = signalsCache
      .map(s => `${s.id}:${s.signal}(${s.confidence ?? 0}%)`)
      .join(' | ');
    console.log('[Engine]', summary);
  } catch (e) {
    console.error('[Engine] Refresh failed:', e.message);
  }
  return signalsCache;
}

// Refresh every 2 minutes
cron.schedule('*/2 * * * *', refreshAllSignals);

// ============================================================
// HTTP API SERVER
// ============================================================

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type':                 'application/json',
};

function jsonRes(res, code, data) {
  res.writeHead(code, CORS_HEADERS);
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(200, CORS_HEADERS);
    res.end();
    return;
  }

  const parsed = new URL(req.url, `http://localhost:${PORT}`);
  const path   = parsed.pathname;

  // Auto-refresh stale cache (>3 min)
  if (path.startsWith('/api/') && Date.now() - lastRefresh > 180_000) {
    await refreshAllSignals();
  }

  if (path === '/api/status') {
    const btc  = signalsCache.find(s => s.id === 'BTC');
    const gold = signalsCache.find(s => s.id === 'GOLD');
    jsonRes(res, 200, {
      status:  'online',
      version: 'SmartEntryPro-V2',
      btc:     btc?.price  ?? null,
      gold:    gold?.price ?? null,
      updated: new Date().toISOString(),
    });
    return;
  }

  if (path === '/api/signals') {
    jsonRes(res, 200, {
      signals:     signalsCache,
      lastRefresh: lastRefresh ? new Date(lastRefresh).toISOString() : null,
      assetCount:  signalsCache.length,
    });
    return;
  }

  if (path === '/api/signal') {
    const assetId = parsed.searchParams.get('asset')?.toUpperCase();
    if (!assetId) { jsonRes(res, 400, { error: 'asset param required' }); return; }
    const data = signalsCache.find(s => s.id === assetId);
    if (!data)  { jsonRes(res, 404, { error: `Asset ${assetId} not found` }); return; }
    jsonRes(res, 200, data);
    return;
  }

  jsonRes(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`\n✅ Smart Entry Pro API → http://localhost:${PORT}`);
  console.log('   /api/status   — system health');
  console.log('   /api/signals  — all asset signals');
  console.log('   /api/signal?asset=BTC  — single asset\n');
});

// ============================================================
// TELEGRAM BOT
// ============================================================

async function sendTelegram(chatId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        chat_id:                  chatId,
        text,
        parse_mode:               'HTML',
        disable_web_page_preview: true,
      }),
    });
  } catch (e) {
    console.error('[Telegram] Send error:', e.message);
  }
}

function formatSignal(s) {
  if (!s.ok || s.signal === 'ERROR') return `❌ ${s.id}: unavailable`;
  const icon = s.signal === 'BUY' ? '🟢' : s.signal === 'SELL' ? '🔴' : '⚪';
  let msg = `${icon} <b>${s.id}</b> — ${s.signal} (${s.confidence}%)\n`;
  msg    += `  💲 ${s.price?.toLocaleString()}\n`;
  if (s.signal !== 'HOLD') {
    msg  += `  Entry: ${s.entry}  SL: ${s.sl}\n`;
    msg  += `  TP1: ${s.tp1}  TP2: ${s.tp2}  TP3: ${s.tp3}\n`;
  }
  msg    += `  RSI: ${s.rsi} | Trend: ${s.trend}`;
  return msg;
}

async function handleMessage(msg) {
  if (!msg?.text) return;
  const chatId = msg.chat.id;
  const text   = msg.text.trim().toLowerCase();

  if (text === '/start') {
    await sendTelegram(chatId,
      '✅ <b>Smart Entry Pro V2</b>\n\n' +
      'Multi-asset AI signal engine\n\n' +
      'Commands:\n' +
      '/signals — all asset signals\n' +
      '/btc /gold /sp500 /msft /amzn — single asset\n' +
      '/daily — market summary'
    );
    return;
  }

  if (text === '/signals') {
    if (signalsCache.length === 0) {
      await sendTelegram(chatId, '⏳ Fetching signals...');
      await refreshAllSignals();
    }
    const body = signalsCache.map(formatSignal).join('\n\n');
    await sendTelegram(chatId, `📊 <b>LIVE SIGNALS</b>\n\n${body}`);
    return;
  }

  const cmdMap = { '/btc': 'BTC', '/gold': 'GOLD', '/sp500': 'SP500', '/msft': 'MSFT', '/amzn': 'AMZN' };
  if (cmdMap[text]) {
    const sig = signalsCache.find(s => s.id === cmdMap[text]);
    if (sig) await sendTelegram(chatId, formatSignal(sig));
    else     await sendTelegram(chatId, '⏳ Loading, try /signals');
    return;
  }

  if (text === '/daily') {
    const buys  = signalsCache.filter(s => s.signal === 'BUY').map(s => s.id).join(', ')  || 'None';
    const sells = signalsCache.filter(s => s.signal === 'SELL').map(s => s.id).join(', ') || 'None';
    await sendTelegram(chatId,
      '🗓 <b>DAILY REPORT</b>\n\n' +
      `🟢 BUY:  ${buys}\n` +
      `🔴 SELL: ${sells}\n\n` +
      'Rules:\n' +
      '• Max 1-2% risk per trade\n' +
      '• Always use SL\n' +
      '• Take partials at TP1'
    );
    return;
  }
}

let lastUpdateId = 0;

async function pollTelegram() {
  try {
    const res  = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=10`
    );
    const data = await res.json();
    if (!data.result) return;
    for (const update of data.result) {
      lastUpdateId = update.update_id;
      if (update.message) await handleMessage(update.message);
    }
  } catch (e) {
    console.error('[Telegram] Poll error:', e.message);
  }
}

setInterval(pollTelegram, 5000);

// ============================================================
// STARTUP
// ============================================================
console.log('🚀 Smart Entry Pro V2 starting up...');
refreshAllSignals().then(() => {
  console.log('✅ Initial signals loaded. System ready.\n');
});
