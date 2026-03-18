import { useEffect, useState, useCallback, useRef } from 'react';

// ═══════════════════════════════════════════════════════════════
// THEME
// ═══════════════════════════════════════════════════════════════
const C = {
  bg:      '#080d18',
  panel:   '#0d1426',
  panel2:  '#0a1020',
  panel3:  '#111d35',
  border:  '#182035',
  accent:  '#00c8f0',
  accent2: '#7c4dff',
  buy:     '#00e676',
  sell:    '#ff3d57',
  hold:    '#7a8fb0',
  warn:    '#ffb300',
  text:    '#d0e0ff',
  muted:   '#445577',
  dim:     '#2a3a5a',
  header:  '#060b14',
};

const SIG_CLR  = { BUY: C.buy, SELL: C.sell, HOLD: C.hold, ERROR: C.warn, 'N/A': C.muted };
const TRD_ICON = { UP: '▲', DOWN: '▼', RANGE: '◆' };
const TRD_CLR  = { UP: C.buy, DOWN: C.sell, RANGE: C.hold };

const TABS = ['SIGNALS', 'ANALYSIS', 'LOG', 'PAPER', 'HELP'];

const ALL_ASSETS = ['BTC', 'GOLD', 'SP500', 'MSFT', 'AMZN'];

const DEFAULT_SETTINGS = {
  risk:          1.0,
  minConf:       60,
  refreshSec:    120,
  tpLevel:       2,
  soundOn:       true,
  notifOn:       false,
  enabledAssets: [...ALL_ASSETS],
};

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function loadSettings() {
  try {
    const s = localStorage.getItem('sep_v3_settings');
    return s ? { ...DEFAULT_SETTINGS, ...JSON.parse(s) } : { ...DEFAULT_SETTINGS };
  } catch { return { ...DEFAULT_SETTINGS }; }
}

function numFmt(v, d = 2) {
  if (v == null) return '—';
  return Number(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}

function timeStr(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString();
}

function playBeep(freq = 880, dur = 0.3) {
  try {
    const ctx  = new (window.AudioContext || window.webkitAudioContext)();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = freq;
    osc.type            = 'sine';
    gain.gain.setValueAtTime(0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    osc.start();
    osc.stop(ctx.currentTime + dur);
  } catch {}
}

function exportCSV(signals) {
  const headers = ['Asset', 'Name', 'Signal', 'Bias', 'Trend', 'Price', 'Change%', 'Entry', 'SL', 'TP1', 'TP2', 'TP3', 'RSI', 'ATR', 'Confidence', 'Score', 'Updated'];
  const rows    = signals.map(s => [
    s.id, s.name, s.signal, s.bias, s.trend,
    s.price, s.change, s.entry, s.sl, s.tp1, s.tp2, s.tp3,
    s.rsi, s.atr, s.confidence, s.score, s.updated,
  ]);
  const csv  = [headers, ...rows].map(r => r.map(x => `"${x ?? ''}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `sep_signals_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function exportLogCSV(log) {
  const headers = ['Time', 'Asset', 'Signal', 'Previous', 'Price', 'Confidence', 'Bias', 'Trend', 'RSI'];
  const rows    = log.map(e => [e.time, e.asset, e.signal, e.prev, e.price, e.confidence, e.bias, e.trend, e.rsi]);
  const csv     = [headers, ...rows].map(r => r.map(x => `"${x ?? ''}"`).join(',')).join('\n');
  const blob    = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url     = URL.createObjectURL(blob);
  const a       = document.createElement('a');
  a.href = url; a.download = `sep_log_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

function requestNotif() {
  if (Notification.permission === 'default') Notification.requestPermission();
}

function notify(title, body) {
  if (Notification.permission === 'granted') {
    new Notification(title, { body, icon: '' });
  }
}

// ═══════════════════════════════════════════════════════════════
// PRIMITIVE COMPONENTS
// ═══════════════════════════════════════════════════════════════

function Dot({ color = C.buy, glow }) {
  return (
    <span style={{
      display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
      background: color, flexShrink: 0,
      boxShadow: glow ? `0 0 8px ${color}, 0 0 3px ${color}` : 'none',
    }} />
  );
}

function Badge({ label, color = C.accent, small }) {
  return (
    <span style={{
      padding:      small ? '1px 6px' : '2px 8px',
      borderRadius:  3,
      background:    color + '1e',
      color,
      fontWeight:    700,
      fontSize:      small ? 9 : 10,
      border:        `1px solid ${color}44`,
      letterSpacing: 1,
      whiteSpace:    'nowrap',
    }}>{label}</span>
  );
}

function ConfBar({ value = 0, width = 52 }) {
  const color = value >= 70 ? C.buy : value >= 50 ? C.warn : C.sell;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
      <div style={{ width, height: 4, background: C.dim, borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ width: `${value}%`, height: '100%', background: color, transition: 'width .5s' }} />
      </div>
      <span style={{ fontSize: 10, color, fontWeight: 700, minWidth: 28 }}>{value}%</span>
    </div>
  );
}

function Btn({ children, onClick, color = C.accent, small, active, disabled }) {
  const bg = active ? color + '33' : 'transparent';
  return (
    <button onClick={onClick} disabled={disabled} style={{
      background:   bg,
      border:       `1px solid ${active ? color : C.border}`,
      color:         disabled ? C.muted : color,
      padding:       small ? '2px 8px' : '5px 14px',
      borderRadius:   3,
      cursor:         disabled ? 'default' : 'pointer',
      fontSize:       small ? 10 : 11,
      fontFamily:    'inherit',
      fontWeight:     600,
      letterSpacing:  0.5,
      transition:    'all .15s',
      whiteSpace:    'nowrap',
    }}>{children}</button>
  );
}

function Toggle({ value, onChange, label }) {
  return (
    <div onClick={() => onChange(!value)} style={{
      display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none',
    }}>
      <div style={{
        width: 32, height: 18, borderRadius: 9, position: 'relative',
        background: value ? C.buy + 'bb' : C.dim,
        border: `1px solid ${value ? C.buy : C.border}`,
        transition: 'all .2s',
      }}>
        <div style={{
          position: 'absolute', top: 2, left: value ? 15 : 2,
          width: 12, height: 12, borderRadius: '50%',
          background: value ? C.buy : C.muted,
          transition: 'left .2s',
        }} />
      </div>
      {label && <span style={{ fontSize: 11, color: value ? C.text : C.muted }}>{label}</span>}
    </div>
  );
}

function Slider({ label, value, min, max, step, onChange, unit = '', color = C.accent }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10 }}>
        <span style={{ color: C.muted }}>{label}</span>
        <span style={{ color, fontWeight: 700 }}>{value}{unit}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        style={{ width: '100%', accentColor: color, cursor: 'pointer' }}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: C.dim }}>
        <span>{min}{unit}</span><span>{max}{unit}</span>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// PRICE TAG
// ═══════════════════════════════════════════════════════════════

function PriceTag({ id, price, change, signal }) {
  const up   = change != null && change >= 0;
  const sc   = SIG_CLR[signal] || C.muted;
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      padding: '7px 14px', borderRight: `1px solid ${C.border}`, minWidth: 80,
      borderBottom: signal && signal !== 'HOLD' ? `2px solid ${sc}` : '2px solid transparent',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{ fontSize: 10, color: C.muted, fontWeight: 700, letterSpacing: 1 }}>{id}</span>
        {signal && signal !== 'HOLD' && signal !== 'ERROR' && signal !== 'N/A' && (
          <Badge label={signal} color={sc} small />
        )}
      </div>
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

// ═══════════════════════════════════════════════════════════════
// SETTINGS PANEL
// ═══════════════════════════════════════════════════════════════

function SettingsPanel({ settings, onChange, onExport, onExportLog, signals, log }) {
  const upd = (key, val) => onChange({ ...settings, [key]: val });

  const toggleAsset = id => {
    const cur = settings.enabledAssets;
    const next = cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id];
    if (next.length === 0) return; // keep at least one
    upd('enabledAssets', next);
  };

  return (
    <div style={{
      background: C.panel, border: `1px solid ${C.border}`,
      borderRadius: 6, padding: 16, display: 'grid',
      gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
      gap: 20, fontSize: 12,
    }}>
      {/* Risk */}
      <div>
        <div style={{ color: C.accent, fontWeight: 700, marginBottom: 10, fontSize: 10, letterSpacing: 1 }}>RISK MANAGEMENT</div>
        <Slider label="Risk per trade" value={settings.risk}    min={0.5} max={5}   step={0.5} onChange={v => upd('risk', v)}    unit="%" color={C.warn} />
        <div style={{ marginTop: 12 }}>
          <Slider label="Min confidence" value={settings.minConf} min={30}  max={95}  step={5}   onChange={v => upd('minConf', v)} unit="%" color={C.accent} />
        </div>
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 10, color: C.muted, marginBottom: 6 }}>Take Profit Target</div>
          <div style={{ display: 'flex', gap: 6 }}>
            {[1, 2, 3].map(n => (
              <Btn key={n} small active={settings.tpLevel === n} color={C.buy}
                onClick={() => upd('tpLevel', n)}>TP{n}</Btn>
            ))}
          </div>
        </div>
      </div>

      {/* Refresh */}
      <div>
        <div style={{ color: C.accent, fontWeight: 700, marginBottom: 10, fontSize: 10, letterSpacing: 1 }}>REFRESH & DISPLAY</div>
        <Slider label="Auto-refresh interval" value={settings.refreshSec} min={30} max={300} step={30}
          onChange={v => upd('refreshSec', v)} unit="s" color={C.accent} />
        <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Toggle value={settings.soundOn}  onChange={v => upd('soundOn', v)}  label="Sound alerts" />
          <Toggle value={settings.notifOn}  onChange={v => {
            if (v) requestNotif();
            upd('notifOn', v);
          }} label="Browser notifications" />
        </div>
      </div>

      {/* Assets */}
      <div>
        <div style={{ color: C.accent, fontWeight: 700, marginBottom: 10, fontSize: 10, letterSpacing: 1 }}>ASSET FILTER</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {ALL_ASSETS.map(id => {
            const on  = settings.enabledAssets.includes(id);
            const sig = signals.find(s => s.id === id);
            return (
              <div key={id} onClick={() => toggleAsset(id)} style={{
                display: 'flex', alignItems: 'center', gap: 8,
                cursor: 'pointer', userSelect: 'none',
                opacity: on ? 1 : 0.4,
              }}>
                <div style={{
                  width: 14, height: 14, borderRadius: 2,
                  border: `1px solid ${on ? C.buy : C.border}`,
                  background: on ? C.buy + '44' : 'transparent',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 9, color: C.buy,
                }}>{on ? '✓' : ''}</div>
                <span style={{ fontSize: 11, color: on ? C.text : C.muted, fontWeight: 600 }}>{id}</span>
                {sig && <Badge label={sig.signal} color={SIG_CLR[sig.signal] || C.muted} small />}
              </div>
            );
          })}
        </div>
      </div>

      {/* Export */}
      <div>
        <div style={{ color: C.accent, fontWeight: 700, marginBottom: 10, fontSize: 10, letterSpacing: 1 }}>EXPORT & TOOLS</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Btn onClick={() => onExport(signals)} color={C.accent}>⬇ Export Signals CSV</Btn>
          <Btn onClick={() => onExportLog(log)}  color={C.accent}>⬇ Export Signal Log CSV</Btn>
          <Btn onClick={() => { localStorage.removeItem('sep_v3_settings'); window.location.reload(); }} color={C.sell} small>
            ↺ Reset Settings
          </Btn>
        </div>
        <div style={{ marginTop: 14, fontSize: 10, color: C.muted, lineHeight: 1.8 }}>
          <div>Backend: <code style={{ color: C.accent }}>localhost:4000</code></div>
          <div>Version: <span style={{ color: C.text }}>V3</span></div>
          <div>Timeframe: <span style={{ color: C.text }}>5M scalping</span></div>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// TAB: SIGNALS
// ═══════════════════════════════════════════════════════════════

function SignalsTab({ signals, settings }) {
  const filtered    = signals.filter(s => settings.enabledAssets.includes(s.id));
  const minConf     = settings.minConf;
  const activeSignals = filtered.filter(s => (s.signal === 'BUY' || s.signal === 'SELL') && (s.confidence || 0) >= minConf);

  return (
    <div>
      {/* Summary stats */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        {[
          ['TOTAL',    filtered.length,                                                 C.text],
          ['BUY',      filtered.filter(s => s.signal === 'BUY').length,                C.buy],
          ['SELL',     filtered.filter(s => s.signal === 'SELL').length,               C.sell],
          ['HOLD',     filtered.filter(s => s.signal === 'HOLD').length,               C.hold],
          ['≥CONF',    activeSignals.length,                                            C.accent],
        ].map(([label, val, color]) => (
          <div key={label} style={{
            background: C.panel, border: `1px solid ${C.border}`, borderRadius: 6,
            padding: '8px 16px', display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 70,
          }}>
            <span style={{ fontSize: 18, fontWeight: 700, color }}>{val}</span>
            <span style={{ fontSize: 9, color: C.muted, letterSpacing: 1 }}>{label}</span>
          </div>
        ))}
        <div style={{
          background: C.panel, border: `1px solid ${C.border}`, borderRadius: 6,
          padding: '8px 16px', display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 120,
        }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: C.text }}>Min Conf: {minConf}%</span>
          <span style={{ fontSize: 9, color: C.muted }}>TP Level: TP{settings.tpLevel}</span>
        </div>
      </div>

      {/* Table */}
      <div style={{ overflowX: 'auto', borderRadius: 6, border: `1px solid ${C.border}` }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ background: C.panel2 }}>
              {['Asset', 'Signal', 'Bias', 'Trend', 'Entry', 'SL', 'TP1', 'TP2', 'TP3', 'RSI', 'ATR', 'Conf', 'Score'].map(h => (
                <th key={h} style={{ padding: '8px 10px', textAlign: 'left', color: C.muted, fontSize: 9, fontWeight: 700, letterSpacing: 1, whiteSpace: 'nowrap', borderBottom: `1px solid ${C.border}` }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((s, i) => {
              const sc = SIG_CLR[s.signal] || C.muted;
              const tc = TRD_CLR[s.trend]  || C.muted;
              const d  = ['BTC', 'SP500'].includes(s.id) ? 0 : 2;
              const dimmed = (s.confidence || 0) < minConf && s.signal !== 'HOLD';
              const tp = settings.tpLevel === 1 ? s.tp1 : settings.tpLevel === 3 ? s.tp3 : s.tp2;
              const rsiC = s.rsi >= 70 ? C.sell : s.rsi <= 30 ? C.buy : C.text;
              return (
                <tr key={s.id} style={{ background: i % 2 === 0 ? 'transparent' : '#ffffff03', borderBottom: `1px solid ${C.border}`, opacity: dimmed ? 0.45 : 1 }}>
                  <td style={{ padding: '9px 10px', whiteSpace: 'nowrap' }}>
                    <div style={{ fontWeight: 700, color: C.text }}>{s.id}</div>
                    <div style={{ fontSize: 9, color: C.muted }}>{s.name}</div>
                  </td>
                  <td style={{ padding: '9px 10px' }}><Badge label={s.signal} color={sc} /></td>
                  <td style={{ padding: '9px 10px', color: sc, fontWeight: 600, fontSize: 11 }}>{s.bias}</td>
                  <td style={{ padding: '9px 10px', whiteSpace: 'nowrap' }}>
                    <span style={{ color: tc, fontWeight: 600, fontSize: 11 }}>{TRD_ICON[s.trend] || ''} {s.trend}</span>
                  </td>
                  <td style={{ padding: '9px 10px', fontWeight: 700, color: C.text, whiteSpace: 'nowrap' }}>{numFmt(s.entry, d)}</td>
                  <td style={{ padding: '9px 10px', color: C.sell, whiteSpace: 'nowrap' }}>{numFmt(s.sl, d)}</td>
                  <td style={{ padding: '9px 10px', color: C.buy, whiteSpace: 'nowrap' }}>{numFmt(s.tp1, d)}</td>
                  <td style={{ padding: '9px 10px', color: C.buy, fontWeight: settings.tpLevel === 2 ? 700 : 400, whiteSpace: 'nowrap' }}>{numFmt(s.tp2, d)}</td>
                  <td style={{ padding: '9px 10px', color: C.buy, whiteSpace: 'nowrap' }}>{numFmt(s.tp3, d)}</td>
                  <td style={{ padding: '9px 10px', color: rsiC, fontWeight: 700 }}>{s.rsi ?? '—'}</td>
                  <td style={{ padding: '9px 10px', color: C.muted, fontSize: 11 }}>{numFmt(s.atr, d)}</td>
                  <td style={{ padding: '9px 10px', whiteSpace: 'nowrap' }}><ConfBar value={s.confidence || 0} /></td>
                  <td style={{ padding: '9px 10px', color: s.score > 0 ? C.buy : s.score < 0 ? C.sell : C.hold, fontWeight: 700 }}>
                    {s.score > 0 ? '+' : ''}{s.score ?? '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Active Signal Cards */}
      {activeSignals.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <span style={{ color: C.accent, fontWeight: 700, letterSpacing: 2, fontSize: 11 }}>ACTIONABLE SIGNALS</span>
            <Dot color={C.buy} glow />
            <span style={{ fontSize: 10, color: C.muted }}>Conf ≥ {minConf}% · Using TP{settings.tpLevel}</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 10 }}>
            {activeSignals.map(s => {
              const sc = SIG_CLR[s.signal] || C.muted;
              const d  = ['BTC', 'SP500'].includes(s.id) ? 0 : 2;
              const tp = settings.tpLevel === 1 ? s.tp1 : settings.tpLevel === 3 ? s.tp3 : s.tp2;
              const rr = s.atr && s.sl && s.entry
                ? (Math.abs(tp - s.entry) / Math.abs(s.sl - s.entry)).toFixed(1)
                : null;
              return (
                <div key={s.id} style={{ background: C.panel, border: `1px solid ${sc}44`, borderLeft: `3px solid ${sc}`, borderRadius: 6, padding: 14 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                    <div>
                      <div style={{ fontWeight: 700, color: C.text, fontSize: 14 }}>{s.id}</div>
                      <div style={{ fontSize: 9, color: C.muted }}>{s.name}</div>
                    </div>
                    <Badge label={s.signal} color={sc} />
                  </div>
                  {[
                    ['Entry',  numFmt(s.entry, d), C.text],
                    ['SL',     numFmt(s.sl, d),    C.sell],
                    [`TP${settings.tpLevel}`, numFmt(tp, d), C.buy],
                    ['R:R',    rr ? `1:${rr}` : '—', rr && parseFloat(rr) >= 1.5 ? C.buy : C.warn],
                    ['RSI',    s.rsi ?? '—',        s.rsi >= 70 ? C.sell : s.rsi <= 30 ? C.buy : C.text],
                  ].map(([lbl, val, clr]) => (
                    <div key={lbl} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, lineHeight: 1.9 }}>
                      <span style={{ color: C.muted }}>{lbl}</span>
                      <span style={{ color: clr, fontWeight: 600 }}>{val}</span>
                    </div>
                  ))}
                  <div style={{ marginTop: 10 }}><ConfBar value={s.confidence || 0} /></div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// TAB: ANALYSIS (indicator breakdown per asset)
// ═══════════════════════════════════════════════════════════════

function AnalysisTab({ signals, settings }) {
  const filtered = signals.filter(s => settings.enabledAssets.includes(s.id));

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
      {filtered.map(s => {
        const sc   = SIG_CLR[s.signal] || C.muted;
        const d    = ['BTC', 'SP500'].includes(s.id) ? 0 : 2;
        const bullCount = (s.breakdown || []).filter(b => b.bull).length;
        const bearCount = (s.breakdown || []).length - bullCount;
        return (
          <div key={s.id} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 6, padding: 14 }}>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div>
                <span style={{ fontWeight: 700, color: C.text, fontSize: 15 }}>{s.id}</span>
                <span style={{ fontSize: 10, color: C.muted, marginLeft: 6 }}>{s.name}</span>
              </div>
              <Badge label={s.signal} color={sc} />
            </div>

            {/* Price + change */}
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12, fontSize: 13 }}>
              <span style={{ fontWeight: 700, color: C.text }}>${s.price?.toLocaleString() ?? '—'}</span>
              {s.change != null && (
                <span style={{ color: s.change >= 0 ? C.buy : C.sell, fontWeight: 600 }}>
                  {s.change >= 0 ? '+' : ''}{s.change}%
                </span>
              )}
            </div>

            {/* Score bar */}
            <div style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, marginBottom: 4 }}>
                <span style={{ color: C.muted }}>Indicator Score</span>
                <span style={{ color: sc, fontWeight: 700 }}>
                  {s.score > 0 ? '+' : ''}{s.score ?? 0} / 8
                </span>
              </div>
              <div style={{ display: 'flex', height: 6, borderRadius: 3, overflow: 'hidden', background: C.dim }}>
                <div style={{ width: `${((s.score ?? 0) + 8) / 16 * 100}%`, background: sc, transition: 'width .5s' }} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: C.dim, marginTop: 2 }}>
                <span>-8 SELL</span><span>0</span><span>+8 BUY</span>
              </div>
            </div>

            {/* Indicator breakdown */}
            <div style={{ fontSize: 11, display: 'flex', flexDirection: 'column', gap: 5 }}>
              {(s.breakdown || []).map((b, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ width: 6, height: 6, borderRadius: '50%', background: b.bull ? C.buy : C.sell, flexShrink: 0 }} />
                  <span style={{ color: C.muted, minWidth: 90 }}>{b.name}</span>
                  <span style={{ color: b.bull ? C.buy : C.sell, flex: 1 }}>{b.label}</span>
                  <span style={{ color: b.vote > 0 ? C.buy : C.sell, fontWeight: 700, minWidth: 20 }}>
                    {b.vote > 0 ? '+' : ''}{b.vote}
                  </span>
                </div>
              ))}
              {(!s.breakdown || s.breakdown.length === 0) && (
                <span style={{ color: C.muted }}>No breakdown data</span>
              )}
            </div>

            {/* Key levels */}
            <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${C.border}` }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px', fontSize: 11 }}>
                {[
                  ['EMA9',  numFmt(s.ema9,  d), C.text],
                  ['EMA21', numFmt(s.ema21, d), C.text],
                  ['RSI',   s.rsi ?? '—',       s.rsi >= 70 ? C.sell : s.rsi <= 30 ? C.buy : C.text],
                  ['ATR',   numFmt(s.atr, d),   C.muted],
                  ['SL',    numFmt(s.sl, d),    C.sell],
                  ['TP2',   numFmt(s.tp2, d),   C.buy],
                ].map(([lbl, val, clr]) => (
                  <div key={lbl} style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: C.muted }}>{lbl}</span>
                    <span style={{ color: clr, fontWeight: 600 }}>{val}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Confidence */}
            <div style={{ marginTop: 10 }}>
              <ConfBar value={s.confidence || 0} width={80} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// TAB: SIGNAL LOG
// ═══════════════════════════════════════════════════════════════

function LogTab({ log, onExportLog }) {
  const [filter, setFilter] = useState('ALL');
  const filtered = filter === 'ALL' ? log : log.filter(e => e.asset === filter || e.signal === filter);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        <span style={{ color: C.accent, fontWeight: 700, letterSpacing: 2, fontSize: 11 }}>SIGNAL CHANGE LOG</span>
        <Badge label={`${log.length} entries`} color={C.muted} />
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {['ALL', ...ALL_ASSETS, 'BUY', 'SELL'].map(f => (
            <Btn key={f} small active={filter === f} color={f === 'BUY' ? C.buy : f === 'SELL' ? C.sell : C.accent}
              onClick={() => setFilter(f)}>{f}</Btn>
          ))}
          <Btn small color={C.accent} onClick={() => onExportLog(log)}>⬇ CSV</Btn>
        </div>
      </div>

      {log.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 40, color: C.muted }}>
          No signal changes yet. Signals log when they flip (e.g. HOLD → BUY).
        </div>
      ) : (
        <div style={{ overflowX: 'auto', border: `1px solid ${C.border}`, borderRadius: 6 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: C.panel2 }}>
                {['Time', 'Asset', 'Signal', 'Was', 'Price', 'Conf', 'Bias', 'Trend', 'RSI'].map(h => (
                  <th key={h} style={{ padding: '8px 10px', textAlign: 'left', color: C.muted, fontSize: 9, fontWeight: 700, letterSpacing: 1, borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((e, i) => {
                const sc  = SIG_CLR[e.signal] || C.muted;
                const psc = SIG_CLR[e.prev]   || C.muted;
                return (
                  <tr key={i} style={{ borderBottom: `1px solid ${C.border}`, background: i % 2 === 0 ? 'transparent' : '#ffffff03' }}>
                    <td style={{ padding: '8px 10px', color: C.muted, fontSize: 10, whiteSpace: 'nowrap' }}>{timeStr(e.time)}</td>
                    <td style={{ padding: '8px 10px', fontWeight: 700, color: C.text }}>{e.asset}</td>
                    <td style={{ padding: '8px 10px' }}><Badge label={e.signal} color={sc} small /></td>
                    <td style={{ padding: '8px 10px', color: psc, fontSize: 10 }}>{e.prev}</td>
                    <td style={{ padding: '8px 10px', color: C.text, whiteSpace: 'nowrap' }}>
                      {e.price != null ? `$${Number(e.price).toLocaleString()}` : '—'}
                    </td>
                    <td style={{ padding: '8px 10px', color: C.accent }}>{e.confidence}%</td>
                    <td style={{ padding: '8px 10px', color: sc, fontSize: 11 }}>{e.bias}</td>
                    <td style={{ padding: '8px 10px', color: TRD_CLR[e.trend] || C.muted, fontSize: 11 }}>{e.trend}</td>
                    <td style={{ padding: '8px 10px', color: e.rsi >= 70 ? C.sell : e.rsi <= 30 ? C.buy : C.text }}>{e.rsi}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// TAB: PAPER TRADING
// ═══════════════════════════════════════════════════════════════

function PaperTab({ signals, settings }) {
  const [trades,  setTrades]  = useState({});   // assetId → { signal, entry, time }
  const [history, setHistory] = useState([]);

  // Auto-open/close paper trades when signals change
  useEffect(() => {
    if (!signals.length) return;
    const now = new Date().toISOString();
    setTrades(prev => {
      const next = { ...prev };
      signals.forEach(s => {
        if (!settings.enabledAssets.includes(s.id)) return;
        if ((s.confidence || 0) < settings.minConf)  return;
        const existing = next[s.id];

        if ((s.signal === 'BUY' || s.signal === 'SELL') && (!existing || existing.signal !== s.signal)) {
          // Close previous
          if (existing) {
            const pnlPct = existing.signal === 'BUY'
              ? ((s.price - existing.entry) / existing.entry) * 100
              : ((existing.entry - s.price) / existing.entry) * 100;
            setHistory(h => [{ id: s.id, signal: existing.signal, entry: existing.entry, exit: s.price, pnlPct: +pnlPct.toFixed(3), time: now, result: pnlPct >= 0 ? 'WIN' : 'LOSS' }, ...h].slice(0, 100));
          }
          next[s.id] = { signal: s.signal, entry: s.price, time: now };
        } else if (s.signal === 'HOLD' && existing) {
          const pnlPct = existing.signal === 'BUY'
            ? ((s.price - existing.entry) / existing.entry) * 100
            : ((existing.entry - s.price) / existing.entry) * 100;
          setHistory(h => [{ id: s.id, signal: existing.signal, entry: existing.entry, exit: s.price, pnlPct: +pnlPct.toFixed(3), time: now, result: pnlPct >= 0 ? 'WIN' : 'LOSS' }, ...h].slice(0, 100));
          delete next[s.id];
        }
      });
      return next;
    });
  }, [signals, settings.minConf, settings.enabledAssets]);

  const openTrades = Object.entries(trades).map(([id, t]) => {
    const cur = signals.find(s => s.id === id);
    const currentPrice = cur?.price;
    const pnlPct = currentPrice != null
      ? (t.signal === 'BUY'
          ? ((currentPrice - t.entry) / t.entry) * 100
          : ((t.entry - currentPrice) / t.entry) * 100)
      : null;
    return { id, ...t, currentPrice, pnlPct };
  });

  const wins   = history.filter(h => h.result === 'WIN').length;
  const losses = history.filter(h => h.result === 'LOSS').length;
  const totalPnl = history.reduce((s, h) => s + h.pnlPct, 0);

  return (
    <div>
      {/* Stats bar */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        {[
          ['OPEN',     openTrades.length,              C.accent],
          ['WINS',     wins,                            C.buy],
          ['LOSSES',   losses,                          C.sell],
          ['TOTAL P&L', totalPnl.toFixed(2) + '%',     totalPnl >= 0 ? C.buy : C.sell],
          ['WIN RATE', wins + losses > 0 ? Math.round(wins / (wins + losses) * 100) + '%' : '—', C.warn],
        ].map(([lbl, val, clr]) => (
          <div key={lbl} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 6, padding: '8px 16px', textAlign: 'center', minWidth: 80 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: clr }}>{val}</div>
            <div style={{ fontSize: 9, color: C.muted, letterSpacing: 1 }}>{lbl}</div>
          </div>
        ))}
        <Btn small color={C.sell} onClick={() => { setTrades({}); setHistory([]); }}>↺ Reset Paper</Btn>
      </div>

      {/* Open trades */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ color: C.accent, fontWeight: 700, fontSize: 11, letterSpacing: 2, marginBottom: 8 }}>
          OPEN PAPER TRADES
        </div>
        {openTrades.length === 0 ? (
          <div style={{ color: C.muted, fontSize: 12, padding: '10px 0' }}>No open paper trades — waiting for BUY/SELL signal above min confidence.</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10 }}>
            {openTrades.map(t => {
              const sc  = SIG_CLR[t.signal] || C.muted;
              const pnlC = t.pnlPct == null ? C.muted : t.pnlPct >= 0 ? C.buy : C.sell;
              const d   = ['BTC', 'SP500'].includes(t.id) ? 0 : 2;
              return (
                <div key={t.id} style={{ background: C.panel, border: `1px solid ${sc}44`, borderLeft: `3px solid ${sc}`, borderRadius: 6, padding: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                    <span style={{ fontWeight: 700, color: C.text }}>{t.id}</span>
                    <Badge label={t.signal} color={sc} small />
                  </div>
                  {[
                    ['Entry',   numFmt(t.entry, d),        C.text],
                    ['Current', numFmt(t.currentPrice, d), C.text],
                    ['P&L',     t.pnlPct != null ? (t.pnlPct >= 0 ? '+' : '') + t.pnlPct.toFixed(3) + '%' : '—', pnlC],
                    ['Opened',  timeStr(t.time), C.muted],
                  ].map(([lbl, val, clr]) => (
                    <div key={lbl} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, lineHeight: 1.8 }}>
                      <span style={{ color: C.muted }}>{lbl}</span>
                      <span style={{ color: clr, fontWeight: 600 }}>{val}</span>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Trade history */}
      <div>
        <div style={{ color: C.accent, fontWeight: 700, fontSize: 11, letterSpacing: 2, marginBottom: 8 }}>
          TRADE HISTORY ({history.length})
        </div>
        {history.length === 0 ? (
          <div style={{ color: C.muted, fontSize: 12 }}>No closed trades yet.</div>
        ) : (
          <div style={{ overflowX: 'auto', border: `1px solid ${C.border}`, borderRadius: 6 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
              <thead>
                <tr style={{ background: C.panel2 }}>
                  {['Time', 'Asset', 'Side', 'Entry', 'Exit', 'P&L', 'Result'].map(h => (
                    <th key={h} style={{ padding: '7px 10px', textAlign: 'left', color: C.muted, fontSize: 9, fontWeight: 700, borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {history.map((h, i) => {
                  const rc = h.result === 'WIN' ? C.buy : C.sell;
                  const d  = ['BTC', 'SP500'].includes(h.id) ? 0 : 2;
                  return (
                    <tr key={i} style={{ borderBottom: `1px solid ${C.border}` }}>
                      <td style={{ padding: '7px 10px', color: C.muted, fontSize: 10 }}>{timeStr(h.time)}</td>
                      <td style={{ padding: '7px 10px', fontWeight: 700, color: C.text }}>{h.id}</td>
                      <td style={{ padding: '7px 10px' }}><Badge label={h.signal} color={SIG_CLR[h.signal]} small /></td>
                      <td style={{ padding: '7px 10px', color: C.text }}>{numFmt(h.entry, d)}</td>
                      <td style={{ padding: '7px 10px', color: C.text }}>{numFmt(h.exit, d)}</td>
                      <td style={{ padding: '7px 10px', color: h.pnlPct >= 0 ? C.buy : C.sell, fontWeight: 700 }}>
                        {h.pnlPct >= 0 ? '+' : ''}{h.pnlPct}%
                      </td>
                      <td style={{ padding: '7px 10px' }}><Badge label={h.result} color={rc} small /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// TAB: HELP
// ═══════════════════════════════════════════════════════════════

function HelpTab() {
  const section = (title, children) => (
    <div style={{ marginBottom: 20 }}>
      <div style={{ color: C.accent, fontWeight: 700, fontSize: 11, letterSpacing: 2, marginBottom: 10, paddingBottom: 6, borderBottom: `1px solid ${C.border}` }}>{title}</div>
      {children}
    </div>
  );
  const row = (label, desc, color = C.text) => (
    <div style={{ display: 'flex', gap: 12, marginBottom: 6, fontSize: 12 }}>
      <span style={{ color, fontWeight: 700, minWidth: 100 }}>{label}</span>
      <span style={{ color: C.muted }}>{desc}</span>
    </div>
  );
  return (
    <div style={{ maxWidth: 800, fontSize: 12 }}>
      {section('QUICK START — WINDOWS', <>
        <div style={{ background: C.panel2, border: `1px solid ${C.border}`, borderRadius: 6, padding: 12, fontFamily: 'Consolas, monospace', fontSize: 11, color: C.text, lineHeight: 2 }}>
          <div style={{ color: C.muted }}># Step 1: navigate to project folder</div>
          <div>cd C:\Users\th_em\ai-trading-dashboard</div>
          <div style={{ color: C.muted, marginTop: 6 }}># Step 2: install dependencies (first time only)</div>
          <div>npm install</div>
          <div style={{ color: C.muted, marginTop: 6 }}># Step 3: start backend (Terminal 1)</div>
          <div>npm run backend</div>
          <div style={{ color: C.muted, marginTop: 6 }}># Step 4: start dashboard (Terminal 2)</div>
          <div>npm run dev</div>
          <div style={{ color: C.muted, marginTop: 6 }}># Step 5: open browser</div>
          <div style={{ color: C.buy }}>http://localhost:5173</div>
        </div>
      </>)}

      {section('SIGNAL LOGIC', <>
        {row('BUY',  'Score ≥ +3 — at least 3 of 5 indicators aligned bullish', C.buy)}
        {row('SELL', 'Score ≤ -3 — at least 3 of 5 indicators aligned bearish', C.sell)}
        {row('HOLD', 'Score between -2 and +2 — mixed signals, wait', C.hold)}
        {row('EMA Cross', '+2/-2 — EMA9 vs EMA21 crossover (primary trend)')}
        {row('Price/EMA21', '+1/-1 — is price above or below EMA21?')}
        {row('RSI', '+2/-2 — overbought/oversold · +1/-1 — bull/bear zone')}
        {row('Candle', '+1/-1 — last candle direction (close vs prior close)')}
        {row('MACD', '+1/-1 — MACD histogram positive or negative')}
      </>)}

      {section('LEVELS (ATR-BASED)', <>
        {row('Entry',  'Current market price at signal time')}
        {row('SL',     'Entry ± ATR × 1.5 (stop loss buffer)', C.sell)}
        {row('TP1',    'Entry ± ATR × 1.0 (1:0.67 R:R)', C.buy)}
        {row('TP2',    'Entry ± ATR × 2.0 (1:1.33 R:R) ← default', C.buy)}
        {row('TP3',    'Entry ± ATR × 3.5 (1:2.33 R:R)', C.buy)}
        {row('ATR14',  '14-period Average True Range — volatility measure')}
      </>)}

      {section('MT5 EXPERT ADVISOR', <>
        {row('File',     'mt5/SmartEntryPro_EA.mq5')}
        {row('Step 1',   'Copy file to MT5 → MQL5 → Experts folder')}
        {row('Step 2',   'Compile in MetaEditor (F7)')}
        {row('Step 3',   'Tools → Options → Expert Advisors → Allow WebRequest → add http://localhost:4000')}
        {row('Step 4',   'Attach to chart, set InpAsset (BTC/GOLD/SP500/MSFT/AMZN)')}
        {row('Step 5',   'Set InpEnableTrading=false first, test in simulation mode', C.warn)}
        {row('InpSymbol','Match your broker symbol: XAUUSD / BTCUSD / US500 etc.')}
      </>)}

      {section('API ENDPOINTS', <>
        <div style={{ background: C.panel2, border: `1px solid ${C.border}`, borderRadius: 6, padding: 12, fontFamily: 'Consolas, monospace', fontSize: 11, lineHeight: 2 }}>
          <div><span style={{ color: C.accent }}>GET</span> <span style={{ color: C.text }}>/api/signals</span> <span style={{ color: C.muted }}>— all 5 asset signals</span></div>
          <div><span style={{ color: C.accent }}>GET</span> <span style={{ color: C.text }}>/api/signal?asset=BTC</span> <span style={{ color: C.muted }}>— single asset (for MT5 EA)</span></div>
          <div><span style={{ color: C.accent }}>GET</span> <span style={{ color: C.text }}>/api/log?limit=50</span> <span style={{ color: C.muted }}>— signal change log</span></div>
          <div><span style={{ color: C.accent }}>GET</span> <span style={{ color: C.text }}>/api/stats</span> <span style={{ color: C.muted }}>— BUY/SELL/HOLD counts</span></div>
          <div><span style={{ color: C.accent }}>GET</span> <span style={{ color: C.text }}>/api/status</span> <span style={{ color: C.muted }}>— health check</span></div>
        </div>
      </>)}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// ROOT APP
// ═══════════════════════════════════════════════════════════════

export default function App() {
  const [signals,      setSignals]      = useState([]);
  const [log,          setLog]          = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState(null);
  const [lastUpdate,   setLastUpdate]   = useState(null);
  const [countdown,    setCountdown]    = useState(120);
  const [activeTab,    setActiveTab]    = useState('SIGNALS');
  const [showSettings, setShowSettings] = useState(false);
  const [settings,     setSettings]     = useState(loadSettings);
  const prevSigsRef = useRef({});   // track previous signals for change detection
  const refreshRef  = useRef(null); // interval handle

  // Persist settings to localStorage
  useEffect(() => {
    localStorage.setItem('sep_v3_settings', JSON.stringify(settings));
  }, [settings]);

  // Fetch signals + log
  const fetchAll = useCallback(async () => {
    try {
      setError(null);
      const [sigRes, logRes] = await Promise.all([
        fetch('/api/signals'),
        fetch('/api/log?limit=200'),
      ]);
      if (!sigRes.ok) throw new Error(`API ${sigRes.status}`);
      const sigData = await sigRes.json();
      const logData = logRes.ok ? await logRes.json() : { log: [] };

      const newSigs = sigData.signals || [];

      // Check for signal changes → sound/notify
      newSigs.forEach(s => {
        const prev = prevSigsRef.current[s.id];
        if (prev && prev !== s.signal && (s.signal === 'BUY' || s.signal === 'SELL')) {
          if (settings.soundOn) playBeep(s.signal === 'BUY' ? 880 : 440);
          if (settings.notifOn) notify(`${s.id} ${s.signal}`, `Confidence: ${s.confidence}%  Entry: ${s.entry}`);
        }
        prevSigsRef.current[s.id] = s.signal;
      });

      setSignals(newSigs);
      setLog(logData.log || []);
      setLastUpdate(new Date());
      setCountdown(settings.refreshSec);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [settings.soundOn, settings.notifOn, settings.refreshSec]);

  // Restart auto-refresh when interval changes
  useEffect(() => {
    fetchAll();
    if (refreshRef.current) clearInterval(refreshRef.current);
    refreshRef.current = setInterval(fetchAll, settings.refreshSec * 1000);
    return () => clearInterval(refreshRef.current);
  }, [fetchAll, settings.refreshSec]);

  // Countdown timer
  useEffect(() => {
    const id = setInterval(() => setCountdown(c => Math.max(0, c - 1)), 1000);
    return () => clearInterval(id);
  }, []);

  const filteredSignals = signals.filter(s => settings.enabledAssets.includes(s.id));

  return (
    <div style={{ minHeight: '100vh', background: C.bg, color: C.text, fontFamily: '"Courier New", Consolas, monospace', fontSize: 13 }}>

      {/* ── HEADER ─────────────────────────────────────────── */}
      <div style={{ background: C.header, borderBottom: `2px solid ${C.accent}22`, padding: '8px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Dot color={C.buy} glow />
          <span style={{ color: C.accent, fontWeight: 700, fontSize: 15, letterSpacing: 2 }}>SMART ENTRY PRO</span>
          <span style={{ color: C.muted, fontSize: 11 }}>— LIVE DASHBOARD</span>
          <Badge label="V3" color={C.accent2} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 11 }}>
          <span style={{ color: C.muted }}>{lastUpdate?.toLocaleTimeString() ?? '...'}</span>
          <span style={{ color: countdown <= 15 ? C.warn : C.muted }}>⟳ {countdown}s</span>
          <Btn small onClick={fetchAll} color={C.accent}>REFRESH</Btn>
          <Btn small onClick={() => setShowSettings(p => !p)} color={showSettings ? C.accent2 : C.muted} active={showSettings}>
            ⚙ SETTINGS
          </Btn>
        </div>
      </div>

      {/* ── PRICE BAR ──────────────────────────────────────── */}
      <div style={{ background: C.panel, borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'stretch', overflowX: 'auto' }}>
        {(filteredSignals.length > 0 ? filteredSignals : ALL_ASSETS.map(id => ({ id, price: null, change: null, signal: null }))).map(s => (
          <PriceTag key={s.id} id={s.id} price={s.price} change={s.change} signal={s.signal} />
        ))}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', padding: '0 14px', gap: 8, borderLeft: `1px solid ${C.border}`, flexShrink: 0 }}>
          <span style={{ fontSize: 9, color: C.muted, letterSpacing: 1 }}>TIMEFRAME</span>
          <Badge label="5M SCALP" color={C.buy} />
        </div>
      </div>

      {/* ── SETTINGS PANEL (collapsible) ───────────────────── */}
      {showSettings && (
        <div style={{ padding: '12px 16px', borderBottom: `1px solid ${C.border}` }}>
          <SettingsPanel
            settings={settings}
            onChange={setSettings}
            onExport={exportCSV}
            onExportLog={exportLogCSV}
            signals={signals}
            log={log}
          />
        </div>
      )}

      {/* ── ERROR BANNER ───────────────────────────────────── */}
      {error && (
        <div style={{ background: C.sell + '11', border: `1px solid ${C.sell}44`, margin: '12px 16px', padding: '10px 16px', borderRadius: 6, color: C.sell, fontSize: 12 }}>
          ⚠ {error} — Run: <code style={{ color: C.warn }}>cd ai-trading-dashboard && npm run backend</code>
        </div>
      )}

      {/* ── TAB BAR ────────────────────────────────────────── */}
      <div style={{ background: C.panel, borderBottom: `1px solid ${C.border}`, display: 'flex', overflowX: 'auto' }}>
        {TABS.map(tab => (
          <button key={tab} onClick={() => setActiveTab(tab)} style={{
            background:    'none',
            border:        'none',
            borderBottom:  activeTab === tab ? `2px solid ${C.accent}` : '2px solid transparent',
            color:          activeTab === tab ? C.accent : C.muted,
            padding:       '10px 18px',
            cursor:        'pointer',
            fontSize:       11,
            fontWeight:     700,
            fontFamily:    'inherit',
            letterSpacing:  1,
            whiteSpace:    'nowrap',
            transition:    'color .15s',
          }}>{tab}</button>
        ))}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', padding: '0 14px', gap: 8 }}>
          {settings.soundOn && <span style={{ fontSize: 10, color: C.buy }}>🔊 SOUND ON</span>}
          {settings.notifOn && <span style={{ fontSize: 10, color: C.accent }}>🔔 NOTIF ON</span>}
        </div>
      </div>

      {/* ── TAB CONTENT ────────────────────────────────────── */}
      <div style={{ padding: 16 }}>
        {loading && !error && (
          <div style={{ textAlign: 'center', padding: 60, color: C.muted }}>
            <div style={{ fontSize: 28, marginBottom: 8 }}>⟳</div>
            <div>Connecting to signal engine...</div>
          </div>
        )}
        {!loading && (
          <>
            {activeTab === 'SIGNALS'  && <SignalsTab  signals={filteredSignals} settings={settings} />}
            {activeTab === 'ANALYSIS' && <AnalysisTab signals={filteredSignals} settings={settings} />}
            {activeTab === 'LOG'      && <LogTab      log={log} onExportLog={exportLogCSV} />}
            {activeTab === 'PAPER'    && <PaperTab    signals={filteredSignals} settings={settings} />}
            {activeTab === 'HELP'     && <HelpTab />}
          </>
        )}
      </div>
    </div>
  );
}
