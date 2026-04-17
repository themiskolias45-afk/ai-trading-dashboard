import { useState, useEffect, useCallback, useRef } from 'react'

const SYMBOLS_DEFAULT = ['EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD', 'BTCUSD', 'US30', 'NAS100']

const fmt = (n, d = 2) => (n == null ? '—' : Number(n).toFixed(d))
const fmtTime = (ts) => ts ? new Date(ts * 1000).toLocaleTimeString() : '—'
const profitColor = (n) => (n > 0 ? '#22c55e' : n < 0 ? '#ef4444' : '#94a3b8')

const s = {
  app: { minHeight: '100vh', background: '#0b0f1a', color: '#e2e8f0', fontFamily: 'monospace', fontSize: 13 },
  header: { background: 'linear-gradient(90deg,#1e1b4b,#312e81)', padding: '12px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid #312e81' },
  title: { color: '#a78bfa', fontWeight: 700, fontSize: 18, letterSpacing: 1 },
  dot: (on) => ({ width: 10, height: 10, borderRadius: '50%', background: on ? '#22c55e' : '#ef4444', display: 'inline-block', marginRight: 6 }),
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', gap: 12, padding: 12 },
  card: { background: '#111827', border: '1px solid #1f2937', borderRadius: 8, padding: 14 },
  cardTitle: { color: '#7c3aed', fontWeight: 700, fontSize: 11, letterSpacing: 2, textTransform: 'uppercase', marginBottom: 10, borderBottom: '1px solid #1f2937', paddingBottom: 6 },
  row: { display: 'flex', justifyContent: 'space-between', padding: '3px 0', borderBottom: '1px solid #1f2937' },
  label: { color: '#64748b' },
  value: { color: '#e2e8f0', fontWeight: 600 },
  input: { background: '#0b0f1a', border: '1px solid #374151', borderRadius: 4, color: '#e2e8f0', padding: '5px 8px', width: '100%', fontSize: 12, boxSizing: 'border-box' },
  select: { background: '#0b0f1a', border: '1px solid #374151', borderRadius: 4, color: '#e2e8f0', padding: '5px 8px', width: '100%', fontSize: 12 },
  btn: (color = '#7c3aed', outline = false) => ({
    background: outline ? 'transparent' : color,
    border: `1px solid ${color}`,
    borderRadius: 4,
    color: outline ? color : '#fff',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 700,
    padding: '6px 14px',
    letterSpacing: 1,
  }),
  btnBuy: { background: '#16a34a', border: '1px solid #16a34a', borderRadius: 4, color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 700, padding: '7px 18px', flex: 1 },
  btnSell: { background: '#dc2626', border: '1px solid #dc2626', borderRadius: 4, color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 700, padding: '7px 18px', flex: 1 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
  th: { color: '#64748b', padding: '4px 6px', textAlign: 'left', borderBottom: '1px solid #1f2937', fontSize: 10, letterSpacing: 1 },
  td: { padding: '5px 6px', borderBottom: '1px solid #1f2937' },
  tag: (type) => ({ background: type === 'BUY' ? '#14532d' : '#7f1d1d', color: type === 'BUY' ? '#86efac' : '#fca5a5', borderRadius: 3, padding: '1px 6px', fontSize: 10, fontWeight: 700 }),
  error: { background: '#450a0a', border: '1px solid #7f1d1d', borderRadius: 6, color: '#fca5a5', margin: '0 12px 8px', padding: '8px 12px', fontSize: 12 },
  toggle: (on) => ({ background: on ? '#7c3aed' : '#1f2937', border: `1px solid ${on ? '#7c3aed' : '#374151'}`, borderRadius: 20, cursor: 'pointer', height: 22, position: 'relative', transition: 'background 0.2s', width: 42 }),
  toggleThumb: (on) => ({ background: '#fff', borderRadius: '50%', height: 16, left: on ? 22 : 4, position: 'absolute', top: 3, transition: 'left 0.2s', width: 16 }),
  formRow: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 },
  formLabel: { color: '#64748b', fontSize: 11, marginBottom: 3 },
}

function Toggle({ on, onChange }) {
  return (
    <button style={s.toggle(on)} onClick={() => onChange(!on)}>
      <div style={s.toggleThumb(on)} />
    </button>
  )
}

function StatRow({ label, value, color }) {
  return (
    <div style={s.row}>
      <span style={s.label}>{label}</span>
      <span style={{ ...s.value, color: color || '#e2e8f0' }}>{value}</span>
    </div>
  )
}

export default function App() {
  const [connected, setConnected] = useState(false)
  const [account, setAccount] = useState(null)
  const [prices, setPrices] = useState({})
  const [prevPrices, setPrevPrices] = useState({})
  const [positions, setPositions] = useState([])
  const [history, setHistory] = useState([])
  const [autoState, setAutoState] = useState({
    enabled: false, symbol: 'EURUSD', lot: 0.01,
    sl_pips: 50, tp_pips: 100, max_trades: 3,
    strategy: 'ma_crossover', trades_today: 0, last_signal: null,
  })
  const [loginForm, setLoginForm] = useState({ login: '', password: '', server: '' })
  const [tradeForm, setTradeForm] = useState({ symbol: 'EURUSD', lot: 0.01, sl_pips: 50, tp_pips: 100 })
  const [error, setError] = useState(null)
  const [connecting, setConnecting] = useState(false)
  const [symbols, setSymbols] = useState(SYMBOLS_DEFAULT)
  const [watchSymbols] = useState(SYMBOLS_DEFAULT)
  const [activeTab, setActiveTab] = useState('dashboard')
  const pricesRef = useRef({})
  pricesRef.current = prices

  const fetchLive = useCallback(async () => {
    try {
      const [accRes, posRes, pricesRes] = await Promise.all([
        fetch('/api/account'),
        fetch('/api/positions'),
        fetch(`/api/prices?symbols=${watchSymbols.join(',')}`),
      ])
      if (accRes.ok) setAccount(await accRes.json())
      if (posRes.ok) setPositions(await posRes.json())
      if (pricesRes.ok) {
        const data = await pricesRes.json()
        setPrevPrices({ ...pricesRef.current })
        setPrices(data)
      }
    } catch { /* silent while bridge starts */ }
  }, [watchSymbols])

  useEffect(() => {
    if (!connected) return
    fetchLive()
    const id = setInterval(fetchLive, 2000)
    return () => clearInterval(id)
  }, [connected, fetchLive])

  const handleConnect = async (e) => {
    e.preventDefault()
    setConnecting(true)
    setError(null)
    try {
      const res = await fetch('/api/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(loginForm),
      })
      const data = await res.json()
      if (data.success) {
        setConnected(true)
        setAccount(data.account)
        const [symRes, histRes, autoRes] = await Promise.all([
          fetch('/api/symbols'),
          fetch('/api/history?days=7'),
          fetch('/api/autotrade'),
        ])
        if (symRes.ok) setSymbols(await symRes.json())
        if (histRes.ok) setHistory(await histRes.json())
        if (autoRes.ok) setAutoState(await autoRes.json())
      } else {
        setError(data.error || 'Connection failed')
      }
    } catch (err) {
      setError(`Cannot reach MT5 bridge (${err.message}). Make sure mt5_bridge.py is running on port 5000.`)
    }
    setConnecting(false)
  }

  const handleDisconnect = async () => {
    await fetch('/api/disconnect', { method: 'POST' }).catch(() => {})
    setConnected(false)
    setAccount(null)
    setPrices({})
    setPositions([])
  }

  const handleTrade = async (action) => {
    setError(null)
    try {
      const res = await fetch('/api/trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...tradeForm, action }),
      })
      const data = await res.json()
      if (!data.success) setError(`Trade error: ${data.error}`)
      else fetchLive()
    } catch (err) {
      setError(`Trade error: ${err.message}`)
    }
  }

  const handleClose = async (ticket) => {
    setError(null)
    try {
      const res = await fetch('/api/close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticket }),
      })
      const data = await res.json()
      if (!data.success) setError(`Close error: ${data.error}`)
      else fetchLive()
    } catch (err) {
      setError(`Close error: ${err.message}`)
    }
  }

  const handleAutoTrade = async (updates) => {
    const next = { ...autoState, ...updates }
    setAutoState(next)
    try {
      const res = await fetch('/api/autotrade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      })
      if (res.ok) setAutoState(await res.json())
    } catch (err) {
      setError(`AutoTrade error: ${err.message}`)
    }
  }

  const totalProfit = positions.reduce((sum, p) => sum + p.profit, 0)

  // ── Login screen ───────────────────────────────────────────────────────────
  if (!connected) {
    return (
      <div style={{ ...s.app, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ ...s.card, width: 340 }}>
          <div style={{ ...s.cardTitle, textAlign: 'center', fontSize: 14 }}>AI Trading Dashboard</div>
          <div style={{ color: '#64748b', fontSize: 11, marginBottom: 14, textAlign: 'center' }}>
            Connect to MetaTrader 5 demo account
          </div>
          {error && <div style={{ ...s.error, margin: '0 0 12px' }}>{error}</div>}
          <form onSubmit={handleConnect}>
            <div style={{ marginBottom: 8 }}>
              <div style={s.formLabel}>Account Login (leave blank to use open MT5)</div>
              <input style={s.input} placeholder="12345678" value={loginForm.login}
                onChange={e => setLoginForm(f => ({ ...f, login: e.target.value }))} />
            </div>
            <div style={{ marginBottom: 8 }}>
              <div style={s.formLabel}>Password</div>
              <input style={s.input} type="password" placeholder="••••••••" value={loginForm.password}
                onChange={e => setLoginForm(f => ({ ...f, password: e.target.value }))} />
            </div>
            <div style={{ marginBottom: 14 }}>
              <div style={s.formLabel}>Server (e.g. MetaQuotes-Demo)</div>
              <input style={s.input} placeholder="MetaQuotes-Demo" value={loginForm.server}
                onChange={e => setLoginForm(f => ({ ...f, server: e.target.value }))} />
            </div>
            <button type="submit" style={{ ...s.btn('#7c3aed'), width: '100%', padding: '9px' }} disabled={connecting}>
              {connecting ? 'Connecting…' : 'Connect to MT5'}
            </button>
          </form>
          <div style={{ color: '#374151', fontSize: 10, marginTop: 12, textAlign: 'center' }}>
            Start mt5_bridge.py first · MT5 terminal must be running on Windows
          </div>
        </div>
      </div>
    )
  }

  // ── Main dashboard ─────────────────────────────────────────────────────────
  return (
    <div style={s.app}>
      {/* Header */}
      <div style={s.header}>
        <div style={s.title}>
          <span style={s.dot(true)} />
          AI TRADING DASHBOARD
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          {account && (
            <span style={{ color: '#94a3b8', fontSize: 12 }}>
              {account.name} · {account.server} ·{' '}
              <span style={{ color: '#a78bfa' }}>{account.currency} {fmt(account.balance)}</span>
            </span>
          )}
          <div style={{ display: 'flex', gap: 4 }}>
            {['dashboard', 'trade', 'auto', 'history'].map(tab => (
              <button key={tab} style={s.btn('#7c3aed', activeTab !== tab)}
                onClick={() => setActiveTab(tab)}>
                {tab.toUpperCase()}
              </button>
            ))}
          </div>
          <button style={s.btn('#374151', true)} onClick={handleDisconnect}>DISCONNECT</button>
        </div>
      </div>

      {error && (
        <div style={s.error}>
          {error}
          <button style={{ background: 'none', border: 'none', color: '#fca5a5', cursor: 'pointer', float: 'right' }}
            onClick={() => setError(null)}>✕</button>
        </div>
      )}

      {/* ── DASHBOARD TAB ── */}
      {activeTab === 'dashboard' && (
        <div style={s.grid}>
          {/* Account */}
          <div style={s.card}>
            <div style={s.cardTitle}>Account</div>
            {account ? (
              <>
                <StatRow label="Balance" value={`${account.currency} ${fmt(account.balance)}`} />
                <StatRow label="Equity" value={`${account.currency} ${fmt(account.equity)}`} />
                <StatRow label="Free Margin" value={`${account.currency} ${fmt(account.free_margin)}`} />
                <StatRow label="Margin Used" value={`${account.currency} ${fmt(account.margin)}`} />
                <StatRow label="Open P/L" value={`${account.currency} ${fmt(totalProfit)}`} color={profitColor(totalProfit)} />
                <StatRow label="Leverage" value={`1:${account.leverage}`} />
                <StatRow label="Open Positions" value={positions.length} />
                <StatRow label="Auto Trading" value={autoState.enabled ? '● ON' : '○ OFF'} color={autoState.enabled ? '#22c55e' : '#64748b'} />
              </>
            ) : <div style={{ color: '#64748b' }}>Loading…</div>}
          </div>

          {/* Live Prices */}
          <div style={{ ...s.card, gridColumn: 'span 2' }}>
            <div style={s.cardTitle}>Live Prices · updates every 2s</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(155px,1fr))', gap: 8 }}>
              {watchSymbols.map(sym => {
                const tick = prices[sym]
                const prev = prevPrices[sym]
                const dir = tick && prev ? (tick.bid > prev.bid ? 1 : tick.bid < prev.bid ? -1 : 0) : 0
                return (
                  <div key={sym} style={{ background: '#0b0f1a', border: '1px solid #1f2937', borderRadius: 6, padding: '8px 10px' }}>
                    <div style={{ color: '#7c3aed', fontWeight: 700, fontSize: 11 }}>{sym}</div>
                    {tick ? (
                      <>
                        <div style={{ color: dir === 1 ? '#22c55e' : dir === -1 ? '#ef4444' : '#e2e8f0', fontSize: 15, fontWeight: 700 }}>
                          {dir === 1 ? '▲ ' : dir === -1 ? '▼ ' : ''}{fmt(tick.bid, sym.includes('JPY') ? 3 : 5)}
                        </div>
                        <div style={{ color: '#64748b', fontSize: 10 }}>
                          Ask {fmt(tick.ask, sym.includes('JPY') ? 3 : 5)} · {fmtTime(tick.time)}
                        </div>
                      </>
                    ) : (
                      <div style={{ color: '#374151', fontSize: 12 }}>No data</div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          {/* Open Positions */}
          <div style={{ ...s.card, gridColumn: '1 / -1' }}>
            <div style={s.cardTitle}>Open Positions ({positions.length})</div>
            {positions.length === 0 ? (
              <div style={{ color: '#374151', padding: '8px 0' }}>No open positions</div>
            ) : (
              <table style={s.table}>
                <thead>
                  <tr>
                    {['Ticket', 'Symbol', 'Type', 'Lot', 'Open', 'Current', 'SL', 'TP', 'P/L', 'Time', ''].map(h => (
                      <th key={h} style={s.th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {positions.map(p => (
                    <tr key={p.ticket}>
                      <td style={s.td}>{p.ticket}</td>
                      <td style={{ ...s.td, color: '#a78bfa', fontWeight: 700 }}>{p.symbol}</td>
                      <td style={s.td}><span style={s.tag(p.type)}>{p.type}</span></td>
                      <td style={s.td}>{p.volume}</td>
                      <td style={s.td}>{fmt(p.open_price, 5)}</td>
                      <td style={s.td}>{fmt(p.current_price, 5)}</td>
                      <td style={{ ...s.td, color: '#ef4444' }}>{p.sl ? fmt(p.sl, 5) : '—'}</td>
                      <td style={{ ...s.td, color: '#22c55e' }}>{p.tp ? fmt(p.tp, 5) : '—'}</td>
                      <td style={{ ...s.td, color: profitColor(p.profit), fontWeight: 700 }}>
                        {p.profit >= 0 ? '+' : ''}{fmt(p.profit)}
                      </td>
                      <td style={{ ...s.td, color: '#64748b' }}>{fmtTime(p.time)}</td>
                      <td style={s.td}>
                        <button style={{ ...s.btn('#7f1d1d'), fontSize: 10, padding: '3px 8px' }}
                          onClick={() => handleClose(p.ticket)}>CLOSE</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* ── TRADE TAB ── */}
      {activeTab === 'trade' && (
        <div style={s.grid}>
          <div style={s.card}>
            <div style={s.cardTitle}>Manual Trade</div>
            <div style={{ marginBottom: 8 }}>
              <div style={s.formLabel}>Symbol</div>
              <select style={s.select} value={tradeForm.symbol}
                onChange={e => setTradeForm(f => ({ ...f, symbol: e.target.value }))}>
                {symbols.map(sym => <option key={sym}>{sym}</option>)}
              </select>
            </div>
            <div style={s.formRow}>
              <div>
                <div style={s.formLabel}>Lot Size</div>
                <input style={s.input} type="number" step="0.01" min="0.01" value={tradeForm.lot}
                  onChange={e => setTradeForm(f => ({ ...f, lot: parseFloat(e.target.value) }))} />
              </div>
              <div>
                <div style={s.formLabel}>SL (pips, 0 = none)</div>
                <input style={s.input} type="number" min="0" value={tradeForm.sl_pips}
                  onChange={e => setTradeForm(f => ({ ...f, sl_pips: parseFloat(e.target.value) }))} />
              </div>
            </div>
            <div style={{ marginBottom: 14 }}>
              <div style={s.formLabel}>TP (pips, 0 = none)</div>
              <input style={s.input} type="number" min="0" value={tradeForm.tp_pips}
                onChange={e => setTradeForm(f => ({ ...f, tp_pips: parseFloat(e.target.value) }))} />
            </div>

            {prices[tradeForm.symbol] && (
              <div style={{ background: '#0b0f1a', border: '1px solid #1f2937', borderRadius: 6, display: 'flex', justifyContent: 'space-between', marginBottom: 12, padding: '8px 10px' }}>
                <span style={{ color: '#22c55e' }}>BUY @ {fmt(prices[tradeForm.symbol]?.ask, 5)}</span>
                <span style={{ color: '#ef4444' }}>SELL @ {fmt(prices[tradeForm.symbol]?.bid, 5)}</span>
              </div>
            )}

            <div style={{ display: 'flex', gap: 8 }}>
              <button style={s.btnBuy} onClick={() => handleTrade('BUY')}>▲ BUY</button>
              <button style={s.btnSell} onClick={() => handleTrade('SELL')}>▼ SELL</button>
            </div>
          </div>

          <div style={{ ...s.card, gridColumn: 'span 2' }}>
            <div style={s.cardTitle}>Open Positions</div>
            {positions.length === 0 ? (
              <div style={{ color: '#374151' }}>No open positions</div>
            ) : (
              <table style={s.table}>
                <thead>
                  <tr>
                    {['Ticket', 'Symbol', 'Type', 'Lot', 'Open Price', 'P/L', 'Comment', ''].map(h => (
                      <th key={h} style={s.th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {positions.map(p => (
                    <tr key={p.ticket}>
                      <td style={s.td}>{p.ticket}</td>
                      <td style={{ ...s.td, color: '#a78bfa' }}>{p.symbol}</td>
                      <td style={s.td}><span style={s.tag(p.type)}>{p.type}</span></td>
                      <td style={s.td}>{p.volume}</td>
                      <td style={s.td}>{fmt(p.open_price, 5)}</td>
                      <td style={{ ...s.td, color: profitColor(p.profit), fontWeight: 700 }}>
                        {p.profit >= 0 ? '+' : ''}{fmt(p.profit)}
                      </td>
                      <td style={{ ...s.td, color: '#64748b', fontSize: 11 }}>{p.comment}</td>
                      <td style={s.td}>
                        <button style={{ ...s.btn('#7f1d1d'), fontSize: 10, padding: '3px 8px' }}
                          onClick={() => handleClose(p.ticket)}>CLOSE</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* ── AUTO TRADE TAB ── */}
      {activeTab === 'auto' && (
        <div style={s.grid}>
          <div style={s.card}>
            <div style={s.cardTitle}>Auto Trading</div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, padding: '10px 0', borderBottom: '1px solid #1f2937' }}>
              <div>
                <div style={{ fontWeight: 700, color: autoState.enabled ? '#22c55e' : '#94a3b8' }}>
                  {autoState.enabled ? '● RUNNING' : '○ STOPPED'}
                </div>
                <div style={{ color: '#64748b', fontSize: 11 }}>Trades today: {autoState.trades_today || 0}</div>
              </div>
              <Toggle on={autoState.enabled} onChange={v => handleAutoTrade({ enabled: v })} />
            </div>

            <div style={{ marginBottom: 10 }}>
              <div style={s.formLabel}>Symbol</div>
              <select style={s.select} value={autoState.symbol}
                onChange={e => handleAutoTrade({ symbol: e.target.value })}>
                {symbols.map(sym => <option key={sym}>{sym}</option>)}
              </select>
            </div>

            <div style={{ marginBottom: 10 }}>
              <div style={s.formLabel}>Strategy</div>
              <select style={s.select} value={autoState.strategy}
                onChange={e => handleAutoTrade({ strategy: e.target.value })}>
                <option value="ma_crossover">MA Crossover (MA20/MA50 · M15)</option>
                <option value="rsi">RSI Oversold/Overbought (H1)</option>
              </select>
            </div>

            <div style={s.formRow}>
              <div>
                <div style={s.formLabel}>Lot Size</div>
                <input style={s.input} type="number" step="0.01" min="0.01" value={autoState.lot}
                  onChange={e => handleAutoTrade({ lot: parseFloat(e.target.value) })} />
              </div>
              <div>
                <div style={s.formLabel}>Max Open Trades</div>
                <input style={s.input} type="number" min="1" max="20" value={autoState.max_trades}
                  onChange={e => handleAutoTrade({ max_trades: parseInt(e.target.value) })} />
              </div>
            </div>

            <div style={s.formRow}>
              <div>
                <div style={s.formLabel}>Stop Loss (pips)</div>
                <input style={s.input} type="number" min="0" value={autoState.sl_pips}
                  onChange={e => handleAutoTrade({ sl_pips: parseFloat(e.target.value) })} />
              </div>
              <div>
                <div style={s.formLabel}>Take Profit (pips)</div>
                <input style={s.input} type="number" min="0" value={autoState.tp_pips}
                  onChange={e => handleAutoTrade({ tp_pips: parseFloat(e.target.value) })} />
              </div>
            </div>

            {autoState.enabled && (
              <div style={{ background: '#0b1a0b', border: '1px solid #14532d', borderRadius: 6, marginTop: 12, padding: 10 }}>
                <div style={{ color: '#22c55e', fontWeight: 700, marginBottom: 4 }}>● Auto Trading Active</div>
                <div style={{ color: '#64748b', fontSize: 11 }}>
                  Scanning every 30s · Last signal: {autoState.last_signal || 'none yet'}
                </div>
              </div>
            )}

            <div style={{ background: '#1a1500', border: '1px solid #713f12', borderRadius: 6, marginTop: 12, padding: 10, fontSize: 11, color: '#fbbf24' }}>
              ⚠ Demo account only · Test strategies before live use · Past signals do not guarantee future results
            </div>
          </div>

          <div style={s.card}>
            <div style={s.cardTitle}>Strategy Details</div>
            {autoState.strategy === 'ma_crossover' ? (
              <>
                <StatRow label="Timeframe" value="M15" />
                <StatRow label="Fast MA" value="20 periods" />
                <StatRow label="Slow MA" value="50 periods" />
                <StatRow label="Filter" value="±0.02% separation" />
                <div style={{ color: '#64748b', fontSize: 11, marginTop: 10, lineHeight: 1.6 }}>
                  BUY when MA20 {'>'} MA50 · SELL when MA20 {'<'} MA50.<br />
                  Fires once per direction change. New signal only after previous reverses.
                </div>
              </>
            ) : (
              <>
                <StatRow label="Timeframe" value="H1" />
                <StatRow label="RSI Period" value="14" />
                <StatRow label="Oversold" value="RSI < 30 → BUY" />
                <StatRow label="Overbought" value="RSI > 70 → SELL" />
                <div style={{ color: '#64748b', fontSize: 11, marginTop: 10, lineHeight: 1.6 }}>
                  Mean reversion strategy. Buys when price is deeply oversold, sells when overbought.
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── HISTORY TAB ── */}
      {activeTab === 'history' && (
        <div style={{ padding: 12 }}>
          <div style={s.card}>
            <div style={s.cardTitle}>Trade History (last 7 days · {history.length} deals)</div>
            {history.length === 0 ? (
              <div style={{ color: '#374151' }}>No closed trades in this period</div>
            ) : (
              <table style={s.table}>
                <thead>
                  <tr>
                    {['Ticket', 'Symbol', 'Type', 'Lot', 'Price', 'Profit', 'Time', 'Comment'].map(h => (
                      <th key={h} style={s.th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[...history].reverse().map((d, i) => (
                    <tr key={i}>
                      <td style={s.td}>{d.ticket}</td>
                      <td style={{ ...s.td, color: '#a78bfa' }}>{d.symbol}</td>
                      <td style={s.td}><span style={s.tag(d.type)}>{d.type}</span></td>
                      <td style={s.td}>{d.volume}</td>
                      <td style={s.td}>{fmt(d.price, 5)}</td>
                      <td style={{ ...s.td, color: profitColor(d.profit), fontWeight: 700 }}>
                        {d.profit >= 0 ? '+' : ''}{fmt(d.profit)}
                      </td>
                      <td style={{ ...s.td, color: '#64748b' }}>{fmtTime(d.time)}</td>
                      <td style={{ ...s.td, color: '#64748b', fontSize: 11 }}>{d.comment}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
