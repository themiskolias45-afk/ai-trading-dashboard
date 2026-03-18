import { useEffect, useState, useCallback } from 'react';

// ============================================================
// THEME
// ============================================================
const C = {
  bg:      '#0a0e1a',
  panel:   '#0f1527',
  panel2:  '#0b1220',
  border:  '#1a2540',
  accent:  '#00d4ff',
  buy:     '#00e676',
  sell:    '#ff3d57',
  hold:    '#8899bb',
  warn:    '#ffb700',
  text:    '#d8e4ff',
  muted:   '#4d6490',
  header:  '#080d1a',
};

const SIG_COLOR = { BUY: C.buy, SELL: C.sell, HOLD: C.hold, ERROR: C.warn, 'N/A': C.muted };
const TREND_ICON  = { UP: '▲', DOWN: '▼', RANGE: '◆' };
const TREND_COLOR = { UP: C.buy, DOWN: C.sell, RANGE: C.hold };

// ============================================================
// SMALL COMPONENTS
// ============================================================

function Dot({ color, glow }) {
  return (
    <span style={{
      display:     'inline-block',
      width:        8, height: 8,
      borderRadius: '50%',
      background:   color,
      boxShadow:    glow ? `0 0 8px ${color}` : 'none',
      flexShrink:   0,
    }} />
  );
}

function Badge({ label, color }) {
  return (
    <span style={{
      padding:      '2px 8px',
      borderRadius:  3,
      background:    color + '22',
      color,
      fontWeight:    700,
      fontSize:      10,
      border:        `1px solid ${color}44`,
      letterSpacing: 1,
      whiteSpace:    'nowrap',
    }}>
      {label}
    </span>
  );
}

function ConfBar({ value = 0 }) {
  const color = value >= 70 ? C.buy : value >= 50 ? C.warn : C.sell;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
      <div style={{ width: 46, height: 3, background: C.border, borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ width: `${value}%`, height: '100%', background: color }} />
      </div>
      <span style={{ fontSize: 10, color, fontWeight: 700 }}>{value}%</span>
    </div>
  );
}

function PriceTag({ id, price, change }) {
  const up = change != null && change >= 0;
  return (
    <div style={{
      display:        'flex',
      flexDirection:  'column',
      alignItems:     'center',
      padding:        '6px 16px',
      borderRight:    `1px solid ${C.border}`,
      minWidth:        80,
    }}>
      <span style={{ fontSize: 10, color: C.muted, fontWeight: 700, letterSpacing: 1 }}>{id}</span>
      <span style={{ fontSize: 13, color: C.text, fontWeight: 700, marginTop: 2 }}>
        {price != null ? `$${Number(price).toLocaleString()}` : '—'}
      </span>
      {change != null && (
        <span style={{ fontSize: 10, color: up ? C.buy : C.sell, marginTop: 1 }}>
          {up ? '+' : ''}{change}%
        </span>
      )}
    </div>
  );
}

function numFmt(v, d = 2) {
  if (v == null) return '—';
  return Number(v).toLocaleString(undefined, {
    minimumFractionDigits:  d,
    maximumFractionDigits:  d,
  });
}

// ============================================================
// SIGNALS TABLE
// ============================================================

function SignalsTable({ signals }) {
  const cols = ['Asset', 'Signal', 'Bias', 'Trend', 'Entry', 'SL', 'TP1', 'TP2', 'TP3', 'Conf', 'RSI'];

  return (
    <div style={{ overflowX: 'auto', borderRadius: 6, border: `1px solid ${C.border}` }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ background: C.panel2 }}>
            {cols.map(h => (
              <th key={h} style={{
                padding:       '8px 12px',
                textAlign:     'left',
                color:          C.muted,
                fontWeight:     700,
                fontSize:        9,
                letterSpacing:   1,
                whiteSpace:     'nowrap',
                borderBottom:   `1px solid ${C.border}`,
              }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {signals.map((s, i) => {
            const sc   = SIG_COLOR[s.signal] || C.muted;
            const tc   = TREND_COLOR[s.trend] || C.muted;
            const d    = ['BTC', 'SP500'].includes(s.id) ? 0 : 2;
            const rsiColor =
              s.rsi >= 70 ? C.sell :
              s.rsi <= 30 ? C.buy  : C.text;
            return (
              <tr key={s.id} style={{
                background:  i % 2 === 0 ? 'transparent' : '#ffffff03',
                borderBottom: `1px solid ${C.border}`,
              }}>
                {/* Asset */}
                <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                  <div style={{ fontWeight: 700, color: C.text }}>{s.id}</div>
                  <div style={{ fontSize: 9, color: C.muted }}>{s.name}</div>
                </td>
                {/* Signal */}
                <td style={{ padding: '10px 12px' }}>
                  <Badge label={s.signal} color={sc} />
                </td>
                {/* Bias */}
                <td style={{ padding: '10px 12px', color: sc, fontWeight: 600, fontSize: 11 }}>
                  {s.bias}
                </td>
                {/* Trend */}
                <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                  <span style={{ color: tc, fontWeight: 600, fontSize: 11 }}>
                    {TREND_ICON[s.trend] || ''} {s.trend}
                  </span>
                </td>
                {/* Entry */}
                <td style={{ padding: '10px 12px', fontWeight: 700, color: C.text, whiteSpace: 'nowrap' }}>
                  {numFmt(s.entry, d)}
                </td>
                {/* SL */}
                <td style={{ padding: '10px 12px', color: C.sell, whiteSpace: 'nowrap' }}>
                  {numFmt(s.sl, d)}
                </td>
                {/* TP1 */}
                <td style={{ padding: '10px 12px', color: C.buy, whiteSpace: 'nowrap' }}>
                  {numFmt(s.tp1, d)}
                </td>
                {/* TP2 */}
                <td style={{ padding: '10px 12px', color: C.buy, whiteSpace: 'nowrap' }}>
                  {numFmt(s.tp2, d)}
                </td>
                {/* TP3 */}
                <td style={{ padding: '10px 12px', color: C.buy, whiteSpace: 'nowrap' }}>
                  {numFmt(s.tp3, d)}
                </td>
                {/* Confidence */}
                <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                  <ConfBar value={s.confidence || 0} />
                </td>
                {/* RSI */}
                <td style={{ padding: '10px 12px', color: rsiColor, fontWeight: 700, fontSize: 12 }}>
                  {s.rsi ?? '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ============================================================
// SIGNAL CARD (for active BUY/SELL)
// ============================================================

function SignalCard({ s }) {
  const sc = SIG_COLOR[s.signal] || C.muted;
  const d  = ['BTC', 'SP500'].includes(s.id) ? 0 : 2;

  const rows = [
    ['Entry',  numFmt(s.entry, d), C.text],
    ['SL',     numFmt(s.sl,    d), C.sell],
    ['TP1',    numFmt(s.tp1,   d), C.buy],
    ['TP2',    numFmt(s.tp2,   d), C.buy],
    ['TP3',    numFmt(s.tp3,   d), C.buy],
    ['RSI',    s.rsi ?? '—',       s.rsi >= 70 ? C.sell : s.rsi <= 30 ? C.buy : C.text],
    ['ATR',    numFmt(s.atr,   d), C.muted],
  ];

  return (
    <div style={{
      background:  C.panel,
      border:      `1px solid ${sc}44`,
      borderLeft:  `3px solid ${sc}`,
      borderRadius: 6,
      padding:      14,
      minWidth:      160,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div>
          <div style={{ fontWeight: 700, color: C.text, fontSize: 14 }}>{s.id}</div>
          <div style={{ fontSize: 9, color: C.muted }}>{s.name}</div>
        </div>
        <Badge label={s.signal} color={sc} />
      </div>
      <div style={{ fontSize: 11, lineHeight: 1.9 }}>
        {rows.map(([label, val, color]) => (
          <div key={label} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ color: C.muted }}>{label}</span>
            <span style={{ color, fontWeight: 600 }}>{val}</span>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 10 }}>
        <ConfBar value={s.confidence || 0} />
      </div>
    </div>
  );
}

// ============================================================
// MAIN APP
// ============================================================

export default function App() {
  const [signals,    setSignals]    = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState(null);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [countdown,  setCountdown]  = useState(120);

  const fetchSignals = useCallback(async () => {
    try {
      setError(null);
      const res  = await fetch('/api/signals');
      if (!res.ok) throw new Error(`API ${res.status}`);
      const data = await res.json();
      setSignals(data.signals || []);
      setLastUpdate(new Date());
      setCountdown(120);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch + auto-refresh every 2 min
  useEffect(() => {
    fetchSignals();
    const id = setInterval(fetchSignals, 120_000);
    return () => clearInterval(id);
  }, [fetchSignals]);

  // Countdown timer
  useEffect(() => {
    const id = setInterval(() => setCountdown(c => Math.max(0, c - 1)), 1000);
    return () => clearInterval(id);
  }, []);

  const activeSignals = signals.filter(s => s.signal === 'BUY' || s.signal === 'SELL');

  return (
    <div style={{
      minHeight:  '100vh',
      background:  C.bg,
      color:       C.text,
      fontFamily: '"Courier New", Consolas, monospace',
      fontSize:    13,
    }}>

      {/* ── HEADER ─────────────────────────────────────── */}
      <div style={{
        background:   C.header,
        borderBottom: `2px solid ${C.accent}33`,
        padding:      '8px 16px',
        display:      'flex',
        justifyContent: 'space-between',
        alignItems:   'center',
        flexWrap:     'wrap',
        gap:           8,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Dot color={C.buy} glow />
          <span style={{ color: C.accent, fontWeight: 700, fontSize: 15, letterSpacing: 2 }}>
            SMART ENTRY PRO
          </span>
          <span style={{ color: C.muted, fontSize: 11 }}>— LIVE DASHBOARD</span>
          <Badge label="V2" color={C.accent} />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 11 }}>
          <span style={{ color: C.muted }}>
            {lastUpdate ? `${lastUpdate.toLocaleTimeString()}` : 'Loading...'}
          </span>
          <span style={{ color: countdown < 20 ? C.warn : C.muted }}>
            ⟳ {countdown}s
          </span>
          <button
            onClick={fetchSignals}
            style={{
              background:   C.accent + '22',
              border:       `1px solid ${C.accent}55`,
              color:         C.accent,
              padding:      '3px 12px',
              borderRadius:  3,
              cursor:       'pointer',
              fontSize:      11,
              fontFamily:   'inherit',
            }}
          >
            REFRESH
          </button>
        </div>
      </div>

      {/* ── PRICE BAR ──────────────────────────────────── */}
      <div style={{
        background:   C.panel,
        borderBottom: `1px solid ${C.border}`,
        display:      'flex',
        alignItems:   'stretch',
        overflowX:    'auto',
      }}>
        {signals.length > 0
          ? signals.map(s => (
              <PriceTag key={s.id} id={s.id} price={s.price} change={s.change} />
            ))
          : ['BTC', 'GOLD', 'SP500', 'MSFT', 'AMZN'].map(id => (
              <PriceTag key={id} id={id} price={null} change={null} />
            ))
        }
        <div style={{
          marginLeft:  'auto',
          display:     'flex',
          alignItems:  'center',
          padding:     '0 16px',
          gap:          8,
          borderLeft:  `1px solid ${C.border}`,
          flexShrink:   0,
        }}>
          <span style={{ fontSize: 9, color: C.muted, letterSpacing: 1 }}>TIMEFRAME</span>
          <Badge label="5M SCALP" color={C.buy} />
        </div>
      </div>

      {/* ── CONTENT ────────────────────────────────────── */}
      <div style={{ padding: 16 }}>

        {/* Error banner */}
        {error && (
          <div style={{
            background:   '#ff3d5711',
            border:       `1px solid ${C.sell}44`,
            borderRadius:  6,
            padding:      '10px 16px',
            marginBottom:  12,
            color:         C.sell,
            fontSize:      12,
          }}>
            ⚠ {error} — Make sure the backend is running: <code>npm run backend</code>
          </div>
        )}

        {/* Loading */}
        {loading && !error && (
          <div style={{ textAlign: 'center', padding: 60, color: C.muted }}>
            <div style={{ fontSize: 24, marginBottom: 8 }}>⟳</div>
            <div>Loading live signals...</div>
          </div>
        )}

        {/* ── LIVE SIGNALS TABLE ─────────────────────── */}
        {!loading && signals.length > 0 && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <span style={{ color: C.accent, fontWeight: 700, letterSpacing: 2, fontSize: 12 }}>
                LIVE SIGNALS
              </span>
              <Dot color={C.buy} glow />
              <span style={{ fontSize: 10, color: C.muted }}>
                EMA9/21 · RSI14 · ATR · MACD · 5M candles
              </span>
            </div>

            <SignalsTable signals={signals} />

            {/* ── ACTIVE SIGNAL CARDS ──────────────────── */}
            {activeSignals.length > 0 && (
              <>
                <div style={{
                  display:       'flex',
                  alignItems:    'center',
                  gap:            10,
                  margin:        '20px 0 10px',
                }}>
                  <span style={{ color: C.accent, fontWeight: 700, letterSpacing: 2, fontSize: 12 }}>
                    ACTIVE SIGNALS
                  </span>
                  <Badge label={`${activeSignals.length} TRADE${activeSignals.length > 1 ? 'S' : ''}`} color={C.buy} />
                </div>
                <div style={{
                  display:             'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
                  gap:                  12,
                }}>
                  {activeSignals.map(s => <SignalCard key={s.id} s={s} />)}
                </div>
              </>
            )}

            {/* ── LEGEND ───────────────────────────────── */}
            <div style={{
              marginTop:    20,
              padding:     '12px 16px',
              background:   C.panel,
              border:       `1px solid ${C.border}`,
              borderRadius:  6,
              display:      'flex',
              gap:           20,
              flexWrap:     'wrap',
              fontSize:      10,
              color:         C.muted,
            }}>
              <span>
                <span style={{ color: C.buy,  fontWeight: 700 }}>▲ BUY  </span>
                score ≥ +3/8 indicators aligned
              </span>
              <span>
                <span style={{ color: C.sell, fontWeight: 700 }}>▼ SELL </span>
                score ≤ -3/8 indicators aligned
              </span>
              <span>
                <span style={{ color: C.hold, fontWeight: 700 }}>◆ HOLD </span>
                mixed / waiting for confirmation
              </span>
              <span>
                SL = ATR×1.5 · TP1 = ATR×1 · TP2 = ATR×2 · TP3 = ATR×3.5
              </span>
              <span style={{ marginLeft: 'auto', color: C.muted }}>
                MT5 EA available — see <code style={{ color: C.accent }}>mt5/SmartEntryPro_EA.mq5</code>
              </span>
            </div>
          </>
        )}

        {/* No data state */}
        {!loading && !error && signals.length === 0 && (
          <div style={{ textAlign: 'center', padding: 60, color: C.muted }}>
            No signals loaded. Check the backend connection.
          </div>
        )}

      </div>
    </div>
  );
}
