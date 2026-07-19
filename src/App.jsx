import { useState, useEffect, useMemo, useReducer, useCallback } from "react";
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, PieChart, Pie, Cell, LineChart, Line, ReferenceLine,
  ComposedChart,
} from "recharts";
import {
  Home, Radio, BarChart2, Cpu, Grid, Award, Ghost, ChevronLeft, RefreshCw,
  Wifi, Play, Download, Settings, Save, Power, LogOut, User, Zap, Brain,
  DollarSign, TrendingUp, TrendingDown, Activity, Target, Flame, Clock,
  Trophy, AlertTriangle, ArrowDownRight, ArrowUpRight, Copy, PanelLeft,
  Circle, CheckCircle2, XCircle, Sparkles, BookOpen, Layers, Shield,
  MessageSquare, Sliders, Database, Send, ChevronRight, Bell,
} from "lucide-react";

// ── THEME ──────────────────────────────────────────────────────────────
const T = {
  bg: "#0a0f1a",
  panel: "#0f1520",
  card: "#111827",
  cardHover: "#151f30",
  border: "#1e2937",
  border2: "#141d2c",
  accent: "#f5a623",
  accentDim: "#c47d10",
  green: "#22c55e",
  red: "#ef4444",
  blue: "#3b82f6",
  purple: "#a855f7",
  gold: "#facc15",
  text: "#e5e7eb",
  textDim: "#9ca3af",
  textFaint: "#4b5563",
  textMuted: "#6b7280",
};

// ── ASSETS ─────────────────────────────────────────────────────────────
const ASSETS = ["XAUUSD", "BTCUSD", "SP500", "MSFT", "AMZN"];
const BASE_PRICES = { XAUUSD: 4831.40, BTCUSD: 76995.66, SP500: 7133.83, MSFT: 422.90, AMZN: 250.93 };
const ASSET_ICON = {
  XAUUSD: { label: "XAU", bg: "#f5a623", fg: "#000" },
  BTCUSD: { label: "₿", bg: "#f7931a", fg: "#000" },
  SP500:  { label: "US500", bg: "#3b82f6", fg: "#fff" },
  MSFT:   { label: "MSFT", bg: "#0ea5e9", fg: "#fff" },
  AMZN:   { label: "AMZN", bg: "#8b5cf6", fg: "#fff" },
};
const ASSET_NAME = { XAUUSD: "Gold", BTCUSD: "Bitcoin", SP500: "S&P 500", MSFT: "Microsoft", AMZN: "Amazon" };

// ── UTILITIES ──────────────────────────────────────────────────────────
const fmt = (n, dp = 2) => Number(n).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
const fmtInt = (n) => Number(n).toLocaleString("en-US");
const randBetween = (a, b) => a + Math.random() * (b - a);
const seedRand = (seed) => { let s = seed; return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; }; };

// ── SHADOW TRADES DATA ─────────────────────────────────────────────────
function genShadowTrades(n = 46) {
  const rand = seedRand(42);
  const list = [];
  const pairs = ["MSFT", "AMZN", "SP500", "XAUUSD", "BTCUSD"];
  for (let i = 0; i < n; i++) {
    const pair = pairs[Math.floor(rand() * pairs.length)];
    const dir = rand() > 0.55 ? "BUY" : "SELL";
    const base = BASE_PRICES[pair];
    const entry = +(base * (1 + (rand() - 0.5) * 0.02)).toFixed(pair === "BTCUSD" ? 2 : pair === "SP500" ? 2 : 2);
    const slDist = base * (0.005 + rand() * 0.008);
    const tpDist = slDist * (1.5 + rand() * 2);
    const sl = dir === "BUY" ? +(entry - slDist).toFixed(3) : +(entry + slDist).toFixed(3);
    const tp1 = dir === "BUY" ? +(entry + tpDist).toFixed(3) : +(entry - tpDist).toFixed(3);
    const now = +(entry + (rand() - 0.45) * slDist * 0.9).toFixed(3);
    const conf = Math.floor(50 + rand() * 30);
    const pips = +((dir === "BUY" ? now - entry : entry - now) / (pair === "BTCUSD" ? 1 : 0.01)).toFixed(2);
    const hours = +(i * 0.5 + rand() * 3).toFixed(1);
    const totalRange = Math.abs(tp1 - sl);
    const currentPos = Math.abs(now - sl);
    const progress = Math.max(0, Math.min(100, (currentPos / totalRange) * 100));
    list.push({ pair, dir, conf, entry, sl, tp1, now, pips, hours, progress, isWin: pips > 0 });
  }
  return list;
}

// ── PERFORMANCE DATA ───────────────────────────────────────────────────
function genDailyPnLBars() {
  const rand = seedRand(101);
  const arr = [];
  for (let i = 0; i < 15; i++) {
    const day = new Date(2026, 3, 3 + i);
    const label = `Apr ${3 + i}`;
    arr.push({ date: label, pips: Math.round((rand() - 0.45) * 1800) });
  }
  return arr;
}

const ASSET_PERF = [
  { sym: "BTCUSD", wr: 40.4, w: 80, l: 118, pips: -213279.7 },
  { sym: "SP500",  wr: 49.0, w: 145, l: 151, pips: 2270.5 },
  { sym: "MSFT",   wr: 75.2, w: 124, l: 41, pips: 72.2 },
  { sym: "XAUUSD", wr: 47.1, w: 120, l: 135, pips: -37292.1 },
  { sym: "AMZN",   wr: 51.2, w: 44, l: 42, pips: 49.6 },
];

// ── EQUITY CURVE + DAILY PNL FOR EA DASH ───────────────────────────────
function genEquityCurve() {
  const rand = seedRand(7);
  const out = [];
  let v = 4900000001;
  const dates = ["09 Apr", "09 Apr", "10 Apr", "12 Apr", "12 Apr", "13 Apr", "14 Apr", "15 Apr", "15 Apr", "16 Apr", "17 Apr", "17 Apr"];
  dates.forEach((d, i) => {
    v += (rand() - 0.5) * 20000000;
    if (i === 4) v -= 800000000;
    out.push({ date: d, equity: Math.round(v) });
  });
  return out;
}

function genDailyPnLEA() {
  return [
    { date: "17 Apr", pnl: 0 }, { date: "16 Apr", pnl: -20 }, { date: "15 Apr", pnl: 10 },
    { date: "14 Apr", pnl: -30 }, { date: "13 Apr", pnl: -230 }, { date: "12 Apr", pnl: 55 },
    { date: "10 Apr", pnl: 65 }, { date: "09 Apr", pnl: 0 },
  ];
}

// ── SIDEBAR ────────────────────────────────────────────────────────────
const NAV = [
  { id: "dashboard",    label: "Dashboard",      icon: Home },
  { id: "command",      label: "Command Center", icon: Radio },
  { id: "charts",       label: "Charts",         icon: BarChart2 },
  { id: "auto",         label: "Auto-Trading",   icon: Cpu },
  { id: "ea",           label: "EA Dashboard",   icon: Grid },
  { id: "performance",  label: "Performance",    icon: Award },
  { id: "shadow",       label: "Shadow Trades",  icon: Ghost },
];

function Sidebar({ page, setPage, onLogout }) {
  return (
    <div style={{ width: 220, background: T.panel, borderRight: `1px solid ${T.border}`, display: "flex", flexDirection: "column", flexShrink: 0, height: "100vh" }}>
      <div style={{ padding: "18px 18px 20px", display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ width: 30, height: 30, borderRadius: 8, background: "linear-gradient(135deg,#f5a623,#c47d10)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <Sparkles size={16} color="#000" />
        </div>
        <div>
          <div style={{ color: T.accent, fontSize: 13, fontWeight: 700, letterSpacing: "0.2px" }}>Smart Entry Pro</div>
          <div style={{ color: T.textFaint, fontSize: 10, marginTop: 1 }}>Revo</div>
        </div>
      </div>
      <div style={{ color: T.textFaint, fontSize: 9, letterSpacing: "1.5px", padding: "10px 18px 6px", fontWeight: 600 }}>NAVIGATION</div>
      <div style={{ flex: 1, overflowY: "auto" }}>
        {NAV.map(({ id, label, icon: Icon }) => (
          <button key={id} onClick={() => setPage(id)} style={{
            width: "100%", display: "flex", alignItems: "center", gap: 12,
            padding: "10px 18px",
            background: page === id ? "rgba(245,166,35,0.10)" : "transparent",
            border: "none",
            borderLeft: page === id ? `3px solid ${T.accent}` : "3px solid transparent",
            color: page === id ? T.accent : T.textDim,
            fontSize: 12, cursor: "pointer", textAlign: "left",
            fontFamily: "inherit", fontWeight: page === id ? 600 : 400,
          }}>
            <Icon size={15} />
            <span>{label}</span>
          </button>
        ))}
      </div>
      <div style={{ padding: "10px 14px", borderTop: `1px solid ${T.border}` }}>
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 6, padding: "6px 10px", display: "flex", alignItems: "center", gap: 6 }}>
          <Zap size={11} color={T.accent} />
          <span style={{ color: T.accent, fontSize: 10, fontWeight: 600 }}>Model Active</span>
        </div>
      </div>
      <div style={{ padding: "10px 14px 18px", display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ width: 28, height: 28, borderRadius: "50%", background: T.card, border: `1px solid ${T.border}`, display: "flex", alignItems: "center", justifyContent: "center", color: T.accent, fontSize: 12, fontWeight: 700 }}>A</div>
        <div style={{ flex: 1, color: T.text, fontSize: 12 }}>Admin</div>
        <button onClick={onLogout} style={{ background: "transparent", border: "none", color: T.textFaint, cursor: "pointer", padding: 4 }}>
          <LogOut size={13} />
        </button>
      </div>
    </div>
  );
}

// ── PAGE HEADER ────────────────────────────────────────────────────────
function PageHeader({ icon: Icon, title, version, subtitle, action, onBack, iconColor = T.accent }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 14, padding: "20px 24px 12px" }}>
      {onBack && (
        <button onClick={onBack} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center", color: T.textDim, cursor: "pointer", marginTop: 4 }}>
          <ChevronLeft size={16} />
        </button>
      )}
      <div style={{ width: 42, height: 42, borderRadius: 10, background: `${iconColor}15`, border: `1px solid ${iconColor}40`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        <Icon size={20} color={iconColor} />
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <h1 style={{ color: T.accent, fontSize: 22, fontWeight: 700, letterSpacing: "-0.3px", margin: 0 }}>{title}</h1>
          {version && <span style={{ color: T.textDim, fontSize: 13 }}>{version}</span>}
        </div>
        {subtitle && <div style={{ color: T.textFaint, fontSize: 11, marginTop: 4 }}>{subtitle}</div>}
      </div>
      {action}
    </div>
  );
}

// ── STAT CARD (Perf-style, centered, icon on top) ──────────────────────
function StatCard({ icon: Icon, value, label, color = T.accent, iconColor }) {
  return (
    <div style={{ flex: 1, minWidth: 120, background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: "18px 14px", textAlign: "center" }}>
      <Icon size={16} color={iconColor || color} style={{ marginBottom: 8 }} />
      <div style={{ color, fontSize: 22, fontWeight: 700, lineHeight: 1.1, letterSpacing: "-0.5px", fontFamily: "'JetBrains Mono',monospace" }}>{value}</div>
      <div style={{ color: T.textFaint, fontSize: 10, marginTop: 6, letterSpacing: "0.3px" }}>{label}</div>
    </div>
  );
}

// ── ASSET ICON ─────────────────────────────────────────────────────────
function AssetIcon({ sym, size = 22 }) {
  const cfg = ASSET_ICON[sym] || { label: sym.slice(0, 3), bg: T.card, fg: T.text };
  const fontSize = cfg.label.length > 3 ? size * 0.32 : size * 0.42;
  return (
    <div style={{
      width: size, height: size, borderRadius: 5, background: cfg.bg, color: cfg.fg,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize, fontWeight: 700, flexShrink: 0, fontFamily: "'JetBrains Mono',monospace",
    }}>
      {cfg.label}
    </div>
  );
}

// ── SHADOW TRADES PAGE ─────────────────────────────────────────────────
function ShadowTradesPage({ onBack }) {
  const [tab, setTab] = useState("open");
  const [trades] = useState(genShadowTrades(46));

  const stats = {
    winRate: 46.3, wins: 442, losses: 512, sharpe: -0.05,
    profitFactor: 0.80, expectancy: -17.8, streak: "4L", avgHold: "22.4h",
  };

  return (
    <div style={{ padding: "0 24px 40px" }}>
      <PageHeader
        icon={Ghost}
        title="Shadow Trades"
        version="v2.0"
        subtitle="Paper trading simulation · No real money"
        onBack={onBack}
        action={
          <button style={{ background: T.accent, border: "none", borderRadius: 8, padding: "10px 18px", color: "#000", fontWeight: 700, fontSize: 12, cursor: "pointer", display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
            <RefreshCw size={13} /> Run Simulation
          </button>
        }
      />

      {/* Stats bar */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(8,1fr)", gap: 10, marginTop: 8 }}>
        <StatCard icon={Trophy}       value={`${stats.winRate}%`} label="Win Rate"      color={T.accent} />
        <StatCard icon={TrendingUp}   value={stats.wins}          label="Wins"          color={T.green} />
        <StatCard icon={TrendingDown} value={stats.losses}        label="Losses"        color={T.red} />
        <StatCard icon={Activity}     value={stats.sharpe}        label="Sharpe"        color={T.blue} />
        <StatCard icon={BarChart2}    value={stats.profitFactor}  label="Profit Factor" color={T.accent} />
        <StatCard icon={DollarSign}   value={stats.expectancy}    label="Expectancy"    color={T.red} />
        <StatCard icon={Flame}        value={stats.streak}        label="Streak"        color={T.red} />
        <StatCard icon={Clock}        value={stats.avgHold}       label="Avg Hold"      color={T.textDim} />
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 6, marginTop: 20 }}>
        {[
          { id: "open",     l: `Open (${trades.length})`, dot: T.green },
          { id: "closed",   l: "Closed (954)",             dot: T.red },
          { id: "analytics", l: "Analytics",               dot: T.blue },
        ].map(({ id, l, dot }) => (
          <button key={id} onClick={() => setTab(id)} style={{
            background: tab === id ? T.card : "transparent",
            border: `1px solid ${tab === id ? T.border : "transparent"}`,
            borderRadius: 8, padding: "8px 14px", color: tab === id ? T.text : T.textDim,
            fontSize: 12, cursor: "pointer", display: "flex", alignItems: "center", gap: 6, fontFamily: "inherit",
          }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: dot, display: "inline-block" }} />
            {l}
          </button>
        ))}
      </div>

      {/* Trades grid */}
      {tab === "open" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginTop: 14 }}>
          {trades.map((t, i) => <TradeCard key={i} t={t} />)}
        </div>
      )}
      {tab !== "open" && (
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: 60, textAlign: "center", color: T.textFaint, marginTop: 14 }}>
          {tab === "closed" ? "954 closed trades" : "Analytics view"} — content coming soon.
        </div>
      )}

      <div style={{ textAlign: "center", color: T.textFaint, fontSize: 10, marginTop: 30 }}>
        <Ghost size={11} style={{ verticalAlign: "middle" }} /> Shadow = paper trading simulation. No real money involved.
      </div>
    </div>
  );
}

function TradeCard({ t }) {
  const isWin = t.pips >= 0;
  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: 14 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 12 }}>
        <AssetIcon sym={t.pair} size={20} />
        <span style={{ color: T.text, fontSize: 12, fontWeight: 700 }}>{t.pair}</span>
        <span style={{
          background: t.dir === "BUY" ? "rgba(34,197,94,0.12)" : "rgba(239,68,68,0.12)",
          color: t.dir === "BUY" ? T.green : T.red,
          padding: "1px 7px", borderRadius: 3, fontSize: 9, fontWeight: 700, letterSpacing: "0.5px",
        }}>{t.dir}</span>
        <div style={{ flex: 1 }} />
        <span style={{ color: T.textDim, fontSize: 11, fontWeight: 600 }}>{t.conf}%</span>
      </div>

      {/* Price row */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 6, marginBottom: 8 }}>
        {[
          { l: "Entry", v: t.entry, c: T.textDim },
          { l: "SL",    v: t.sl,    c: T.red },
          { l: "TP1",   v: t.tp1,   c: T.green },
          { l: "Now",   v: t.now,   c: T.text },
        ].map(({ l, v, c }) => (
          <div key={l}>
            <div style={{ color: T.textFaint, fontSize: 9, marginBottom: 2 }}>{l}</div>
            <div style={{ color: c, fontSize: 11, fontWeight: 600, fontFamily: "'JetBrains Mono',monospace" }}>{fmt(v, v > 1000 ? 2 : 3)}</div>
          </div>
        ))}
      </div>

      {/* Progress bar */}
      <div style={{ background: T.border, borderRadius: 2, height: 3, overflow: "hidden", marginBottom: 10 }}>
        <div style={{ width: `${Math.max(6, Math.min(100, t.progress))}%`, height: "100%", background: isWin ? T.green : T.red }} />
      </div>

      {/* Footer */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ color: isWin ? T.green : T.red, fontSize: 11, fontWeight: 700, fontFamily: "'JetBrains Mono',monospace" }}>
          {isWin ? "+" : ""}{fmt(t.pips, 2)} pips
        </span>
        <span style={{ color: T.textFaint, fontSize: 10, display: "flex", alignItems: "center", gap: 3 }}>
          <Clock size={9} /> {t.hours}h
        </span>
      </div>
    </div>
  );
}

// ── PERFORMANCE PAGE ───────────────────────────────────────────────────
function PerformancePage({ onBack, onOpenShadow }) {
  const [tab, setTab] = useState("overview");
  const stats = { wr: 51.3, wins: 513, losses: 477, totalPips: -248179.6, sharpe: -0.05, maxDD: -1968.3, avgRR: 3.9, shadowWR: 29.3 };
  const dailyBars = useMemo(() => genDailyPnLBars(), []);

  const TABS = [
    { id: "overview", l: "Overview" },
    { id: "pnl",      l: "PnL" },
    { id: "trends",   l: "Trends" },
    { id: "ai",       l: "AI Learning", icon: "🧠" },
    { id: "20d",      l: "20D Engine",  icon: "📊" },
    { id: "history",  l: "History" },
    { id: "ml",       l: "ML Engine",   icon: "🤖" },
  ];

  return (
    <div style={{ padding: "0 24px 40px" }}>
      <PageHeader
        icon={Award}
        title="Performance"
        version="v10.0 — 24D"
        onBack={onBack}
        action={
          <button onClick={onOpenShadow} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, padding: "9px 16px", color: T.text, fontSize: 12, cursor: "pointer", display: "flex", alignItems: "center", gap: 8, marginTop: 4, fontFamily: "inherit" }}>
            <Ghost size={13} /> Shadow Trades
          </button>
        }
      />

      {/* Stats bar */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(8,1fr)", gap: 10, marginTop: 8 }}>
        <StatCard icon={Trophy}       value={`${stats.wr}%`}         label="Win Rate"   color={T.accent} />
        <StatCard icon={TrendingUp}   value={stats.wins}             label="Wins"       color={T.green} />
        <StatCard icon={TrendingDown} value={stats.losses}           label="Losses"     color={T.red} />
        <StatCard icon={Target}       value={fmt(stats.totalPips, 1)} label="Total Pips" color={T.red} />
        <StatCard icon={Activity}     value={stats.sharpe}           label="Sharpe"     color={T.gold} />
        <StatCard icon={ArrowDownRight} value={stats.maxDD}          label="Max DD"     color={T.red} />
        <StatCard icon={BarChart2}    value={stats.avgRR}            label="Avg R:R"    color={T.blue} />
        <StatCard icon={TrendingUp}   value={`${stats.shadowWR}%`}   label="Shadow WR"  color={T.accent} />
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 4, marginTop: 20, borderBottom: `1px solid ${T.border}`, paddingBottom: 0 }}>
        {TABS.map(({ id, l, icon }) => (
          <button key={id} onClick={() => setTab(id)} style={{
            background: tab === id ? T.card : "transparent",
            border: "none",
            borderBottom: tab === id ? `2px solid ${T.accent}` : "2px solid transparent",
            color: tab === id ? T.text : T.textDim,
            fontSize: 12, padding: "10px 16px", cursor: "pointer", fontFamily: "inherit",
            display: "flex", alignItems: "center", gap: 6,
          }}>
            {icon && <span>{icon}</span>}{l}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <>
          {/* Pie + PnL bars */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1.5fr", gap: 14, marginTop: 16 }}>
            <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: 20 }}>
              <div style={{ color: T.text, fontSize: 13, fontWeight: 600, marginBottom: 14 }}>Win/Loss Distribution</div>
              <ResponsiveContainer width="100%" height={280}>
                <PieChart>
                  <Pie data={[{ n: "Wins", v: stats.wins }, { n: "Losses", v: stats.losses }]}
                    dataKey="v" cx="50%" cy="50%" outerRadius={110} label={({ n, v }) => `${n}: ${v}`} labelLine={{ stroke: T.textDim }}>
                    <Cell fill={T.green} />
                    <Cell fill={T.red} />
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: 20 }}>
              <div style={{ color: T.text, fontSize: 13, fontWeight: 600, marginBottom: 14 }}>Daily PnL (pips)</div>
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={dailyBars}>
                  <CartesianGrid strokeDasharray="2 4" stroke={T.border} />
                  <XAxis dataKey="date" tick={{ fill: T.textDim, fontSize: 10 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: T.textDim, fontSize: 10 }} axisLine={false} tickLine={false} domain={[-1800, 1800]} ticks={[-1800, -900, 0, 900, 1800]} />
                  <ReferenceLine y={0} stroke={T.textFaint} />
                  <Bar dataKey="pips" fill={T.accent} radius={[2, 2, 0, 0]} />
                  <Tooltip contentStyle={{ background: T.panel, border: `1px solid ${T.border}`, fontSize: 11 }} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Per-asset cards */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginTop: 14 }}>
            {ASSET_PERF.map(a => (
              <div key={a.sym} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: 20 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
                  <AssetIcon sym={a.sym} size={18} />
                  <span style={{ color: T.text, fontSize: 13, fontWeight: 600 }}>{a.sym}</span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, alignItems: "center" }}>
                  <div style={{ textAlign: "center" }}>
                    <div style={{ color: a.wr >= 55 ? T.green : a.wr >= 45 ? T.accent : T.red, fontSize: 20, fontWeight: 700 }}>{a.wr}%</div>
                    <div style={{ color: T.textFaint, fontSize: 10, marginTop: 4 }}>WR</div>
                  </div>
                  <div style={{ textAlign: "center" }}>
                    <div style={{ color: T.green, fontSize: 18, fontWeight: 700 }}>{a.w}W / <span style={{ color: T.red }}>{a.l}L</span></div>
                    <div style={{ color: T.textFaint, fontSize: 10, marginTop: 4 }}>Record</div>
                  </div>
                  <div style={{ textAlign: "center" }}>
                    <div style={{ color: a.pips >= 0 ? T.green : T.red, fontSize: 16, fontWeight: 700 }}>{a.pips >= 0 ? "+" : ""}{fmt(a.pips, 1)}</div>
                    <div style={{ color: T.textFaint, fontSize: 10, marginTop: 4 }}>Pips</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {tab !== "overview" && (
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: 60, textAlign: "center", color: T.textFaint, marginTop: 16 }}>
          {TABS.find(x => x.id === tab)?.l} view — content coming soon.
        </div>
      )}

      <div style={{ textAlign: "center", color: T.textFaint, fontSize: 10, marginTop: 30 }}>
        DeepTrade AI v8.0 — 20D Learning Engine. Not financial advice.
      </div>
    </div>
  );
}

// ── EA STAT CARD (compact, monospace) ──────────────────────────────────
function EAStat({ icon: Icon, value, label, color = T.accent }) {
  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: "14px 12px", textAlign: "center" }}>
      <Icon size={14} color={color} style={{ marginBottom: 5 }} />
      <div style={{ color, fontSize: 15, fontWeight: 700, fontFamily: "'JetBrains Mono',monospace", letterSpacing: "-0.3px" }}>{value}</div>
      <div style={{ color: T.textFaint, fontSize: 9, marginTop: 4 }}>{label}</div>
    </div>
  );
}

// ── EA COMMAND CENTER PAGE ─────────────────────────────────────────────
function EACommandPage() {
  const [tab, setTab] = useState("overview");
  const equity = useMemo(() => genEquityCurve(), []);
  const daily = useMemo(() => genDailyPnLEA(), []);

  const TABS = [
    { id: "overview",  l: "Overview",   icon: "👁" },
    { id: "trades",    l: "Trades",     icon: "📊" },
    { id: "journal",   l: "Journal",    icon: "📖" },
    { id: "analytics", l: "Analytics",  icon: "📈" },
    { id: "market",    l: "Market",     icon: "📡" },
    { id: "risk",      l: "Risk & Lots", icon: "⚡" },
    { id: "settings",  l: "Settings",   icon: "⚙" },
    { id: "data",      l: "Data Feed",  icon: "🗄" },
    { id: "telegram",  l: "Telegram",   icon: "📤" },
    { id: "controls",  l: "Controls",   icon: "⏻" },
  ];

  return (
    <div style={{ padding: "0 24px 40px" }}>
      <PageHeader
        icon={Grid}
        title="EA Command Center"
        subtitle="Full control & monitoring for DeepTrade EA v3.0"
        action={
          <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
            <button style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, padding: "9px 14px", color: T.text, fontSize: 12, cursor: "pointer", display: "flex", alignItems: "center", gap: 6, fontFamily: "inherit" }}>
              <RefreshCw size={12} /> Refresh
            </button>
            <button style={{ background: "rgba(34,197,94,0.10)", border: `1px solid ${T.green}55`, borderRadius: 8, padding: "9px 14px", color: T.green, fontSize: 12, cursor: "pointer", display: "flex", alignItems: "center", gap: 6, fontFamily: "inherit" }}>
              <Wifi size={12} /> Connected
            </button>
          </div>
        }
      />

      {/* Top stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(8,1fr)", gap: 10, marginTop: 8 }}>
        <EAStat icon={DollarSign} value="$89432"  label="Balance"   color={T.accent} />
        <EAStat icon={Sliders}    value="$89418"  label="Equity"    color={T.accent} />
        <EAStat icon={ArrowDownRight} value="0.0%" label="Drawdown" color={T.accent} />
        <EAStat icon={Play}       value="1"       label="Open"      color={T.accent} />
        <EAStat icon={Trophy}     value="33"      label="Wins"      color={T.green} />
        <EAStat icon={XCircle}    value="10"      label="Losses"    color={T.red} />
        <EAStat icon={Target}     value="67.3%"   label="Win Rate"  color={T.accent} />
        <EAStat icon={DollarSign} value="-160.94" label="Total P&L" color={T.red} />
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 2, marginTop: 16, background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, padding: 4, overflowX: "auto" }}>
        {TABS.map(({ id, l, icon }) => (
          <button key={id} onClick={() => setTab(id)} style={{
            background: tab === id ? T.panel : "transparent",
            border: "none", borderRadius: 6, padding: "8px 14px",
            color: tab === id ? T.text : T.textDim, fontSize: 11, cursor: "pointer",
            display: "flex", alignItems: "center", gap: 5, whiteSpace: "nowrap", fontFamily: "inherit",
          }}>
            <span>{icon}</span>{l}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <>
          {/* Greeting */}
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: 20, marginTop: 14, display: "flex", alignItems: "center", gap: 14 }}>
            <div>
              <div style={{ color: T.text, fontSize: 18, fontWeight: 700 }}>✨ Good morning, Trader</div>
              <div style={{ color: T.textDim, fontSize: 11, marginTop: 4, display: "flex", alignItems: "center", gap: 8 }}>
                📅 Saturday, Apr 18 · <span style={{ background: "rgba(239,68,68,0.12)", color: T.red, padding: "2px 8px", borderRadius: 3, fontSize: 10, fontWeight: 600 }}>📉 Bearish</span>
              </div>
            </div>
            <div style={{ flex: 1 }} />
            <div style={{ display: "flex", gap: 24 }}>
              {[
                { v: "2",    l: "ACTIVE",       c: T.accent },
                { v: "0W/0L", l: "TODAY",        c: T.textDim },
                { v: "29%",  l: "7D WIN RATE", c: T.red },
                { v: "AMZN", l: "TOP ASSET",   c: T.accent },
              ].map(({ v, l, c }) => (
                <div key={l} style={{ textAlign: "center" }}>
                  <div style={{ color: c, fontSize: 16, fontWeight: 700 }}>{v}</div>
                  <div style={{ color: T.textFaint, fontSize: 9, marginTop: 3 }}>{l}</div>
                </div>
              ))}
            </div>
          </div>

          {/* AI Engine row */}
          <div style={{ display: "flex", gap: 14, marginTop: 14, background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: "12px 16px", flexWrap: "wrap", fontSize: 11 }}>
            <span style={{ color: T.accent, fontWeight: 600 }}>⚡ AI ENGINE v10</span>
            <span style={{ color: T.textDim }}><Clock size={10} style={{ verticalAlign: "middle" }} /> SCANNING</span>
            <span style={{ color: T.textDim }}>Learn: <span style={{ color: T.text }}>4m</span> ago</span>
            <span style={{ color: T.textDim }}>24h: <span style={{ color: T.text }}>13</span> outcomes</span>
            <span style={{ color: T.accent, background: "rgba(245,166,35,0.10)", padding: "3px 8px", borderRadius: 4 }}>⚙ TECHNICAL MODE</span>
            <span style={{ color: T.textDim, marginLeft: "auto" }}>⚡ Auto-learn in <span style={{ color: T.text }}>2</span> outcomes</span>
          </div>

          {/* Market Overview */}
          <div style={{ marginTop: 14 }}>
            <div style={{ color: T.accent, fontSize: 10, letterSpacing: "1.5px", marginBottom: 8, fontWeight: 600 }}>▎MARKET OVERVIEW</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 10 }}>
              {ASSETS.map(sym => {
                const p = BASE_PRICES[sym];
                return (
                  <div key={sym} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: 14 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                      <AssetIcon sym={sym} size={30} />
                      <div style={{ flex: 1 }}>
                        <div style={{ color: T.textDim, fontSize: 10 }}>{ASSET_NAME[sym].slice(0, 3)}{ASSET_NAME[sym].length > 3 ? "..." : ""}</div>
                        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                          <span style={{ width: 5, height: 5, borderRadius: "50%", background: T.green }} />
                          <Wifi size={9} color={T.textFaint} />
                          {sym === "BTCUSD" && <span style={{ background: "rgba(245,158,11,0.15)", color: T.accent, padding: "0px 5px", borderRadius: 3, fontSize: 8 }}>BINANCE</span>}
                        </div>
                      </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
                      <span style={{ color: T.green, fontSize: 14, fontWeight: 700, fontFamily: "'JetBrains Mono',monospace" }}>${fmt(p, 2)}</span>
                      <span style={{ color: T.textDim, fontSize: 10 }}>+0.00%</span>
                    </div>
                    <div style={{ color: T.textFaint, fontSize: 9, marginTop: 4 }}>05:29 AM</div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Performance Snapshot */}
          <div style={{ marginTop: 14 }}>
            <div style={{ color: T.accent, fontSize: 10, letterSpacing: "1.5px", marginBottom: 8, fontWeight: 600 }}>▎PERFORMANCE SNAPSHOT</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(8,1fr)", gap: 8 }}>
              <EAStat icon={Zap}          value="2"       label="ACTIVE"        color={T.green} />
              <EAStat icon={BarChart2}    value="560/440" label="BUY / SELL"    color={T.blue} />
              <EAStat icon={Target}       value="67%"     label="AVG CONF"      color={T.green} />
              <EAStat icon={Circle}       value="18%"     label="WIN RATE"      color={T.red} />
              <EAStat icon={TrendingUp}   value="0.6"     label="PROFIT FACTOR" color={T.red} />
              <EAStat icon={TrendingDown} value="160"     label="LOSSES"        color={T.red} />
              <EAStat icon={Flame}        value="4L"      label="STREAK"        color={T.red} />
              <EAStat icon={Clock}        value="—"       label="TODAY HR"      color={T.textDim} />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 10, marginTop: 10 }}>
              {[
                { icon: DollarSign,     l: "TODAY P&L",   v: "+0.0",       sub: "0W / 0L",    c: T.green },
                { icon: TrendingDown,   l: "7D TREND",    v: "-2287.0",    sub: "pips total", c: T.red },
                { icon: BarChart2,      l: "30D P&L",     v: "-247719.0",  sub: "monthly pips", c: T.red },
                { icon: Trophy,         l: "BEST ASSET",  v: "AMZN",       sub: "+0.0 pips",  c: T.accent },
                { icon: AlertTriangle,  l: "WORST ASSET", v: "BTCUSD",     sub: "-1074.8 pips", c: T.red },
              ].map(({ icon: Icon, l, v, sub, c }) => (
                <div key={l} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: 14 }}>
                  <div style={{ color: T.textDim, fontSize: 10, letterSpacing: "1px", display: "flex", alignItems: "center", gap: 5, marginBottom: 6 }}>
                    <Icon size={10} /> {l}
                  </div>
                  <div style={{ color: c, fontSize: 18, fontWeight: 700, fontFamily: "'JetBrains Mono',monospace" }}>{v}</div>
                  <div style={{ color: T.textFaint, fontSize: 9, marginTop: 3 }}>{sub}</div>
                </div>
              ))}
            </div>
          </div>

          {/* EA Connection + System Status */}
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 14, marginTop: 14 }}>
            <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: 18 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
                <Database size={14} color={T.textDim} />
                <span style={{ color: T.text, fontSize: 13, fontWeight: 600 }}>EA Connection</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <Wifi size={12} color={T.green} />
                <span style={{ color: T.text, fontSize: 12, fontWeight: 600 }}>DeepTrade_EA_01</span>
                <span style={{ background: "rgba(34,197,94,0.15)", color: T.green, padding: "2px 8px", borderRadius: 3, fontSize: 9, fontWeight: 700 }}>ONLINE</span>
                <div style={{ flex: 1 }} />
                <span style={{ color: T.textFaint, fontSize: 10 }}>Last ping: 05:28:35 AM</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8, marginTop: 14 }}>
                {[
                  { l: "Broker",  v: "Vantage International Grou..." },
                  { l: "Account", v: "#11581419" },
                  { l: "Balance", v: "$89432.03" },
                  { l: "Equity",  v: "$89417.92" },
                ].map(({ l, v }) => (
                  <div key={l} style={{ background: T.panel, border: `1px solid ${T.border}`, borderRadius: 6, padding: "8px 10px" }}>
                    <div style={{ color: T.textFaint, fontSize: 9 }}>{l}</div>
                    <div style={{ color: T.text, fontSize: 11, marginTop: 3, fontFamily: "'JetBrains Mono',monospace" }}>{v}</div>
                  </div>
                ))}
              </div>
            </div>
            <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: 18 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                <Clock size={14} color={T.textDim} />
                <span style={{ color: T.text, fontSize: 13, fontWeight: 600 }}>System Status</span>
              </div>
              <div style={{ textAlign: "center", marginBottom: 14 }}>
                <div style={{ color: T.accent, fontSize: 22, fontWeight: 700 }}>1m</div>
                <div style={{ color: T.textFaint, fontSize: 10, marginTop: 3 }}>Trading Uptime</div>
              </div>
              {[
                { l: "Lot Mode",      v: "MANUAL",   c: T.accent, badge: true },
                { l: "Min Confidence", v: "70%",     c: T.text },
                { l: "Trail SL",      v: "ON",       c: T.green, badge: true },
                { l: "Data Feeds",    v: "5/5 live", c: T.text },
              ].map(({ l, v, c, badge }) => (
                <div key={l} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: `1px solid ${T.border2}`, fontSize: 11 }}>
                  <span style={{ color: T.textDim }}>{l}</span>
                  {badge
                    ? <span style={{ background: `${c}22`, color: c, padding: "1px 8px", borderRadius: 3, fontSize: 9, fontWeight: 700 }}>{v}</span>
                    : <span style={{ color: c, fontWeight: 600 }}>{v}</span>}
                </div>
              ))}
            </div>
          </div>

          {/* Per-Asset Performance */}
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: 18, marginTop: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
              <Circle size={14} color={T.textDim} />
              <span style={{ color: T.text, fontSize: 13, fontWeight: 600 }}>Per-Asset Performance</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 12 }}>
              {[
                { sym: "XAUUSD", pnl: 0,       t: 0,  wr: "—",  open: 0, lot: "0.01", risk: "0.25%" },
                { sym: "BTCUSD", pnl: 187.36,  t: 25, wr: "56%", open: 1, lot: "0.01", risk: "0.25%" },
                { sym: "SP500",  pnl: -385.47, t: 2,  wr: "50%", open: 0, lot: "0.01", risk: "0.25%" },
                { sym: "MSFT",   pnl: 37.17,   t: 22, wr: "82%", open: 0, lot: "0.05", risk: "0.25%" },
                { sym: "AMZN",   pnl: 0,       t: 1,  wr: "0%",  open: 0, lot: "0.01", risk: "0.25%" },
              ].map(a => (
                <div key={a.sym} style={{ background: T.panel, border: `1px solid ${T.border}`, borderRadius: 8, padding: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
                    <span style={{ color: T.text, fontSize: 11, fontWeight: 600 }}>{a.sym}</span>
                    <span style={{ background: "rgba(245,166,35,0.15)", color: T.accent, padding: "1px 6px", borderRadius: 3, fontSize: 8, fontWeight: 700 }}>ON</span>
                  </div>
                  <div style={{ textAlign: "center" }}>
                    <div style={{ color: a.pnl >= 0 ? T.green : T.red, fontSize: 16, fontWeight: 700, fontFamily: "'JetBrains Mono',monospace" }}>
                      {a.pnl >= 0 ? "+" : ""}{fmt(a.pnl, 2)}
                    </div>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 4, marginTop: 10, fontSize: 9 }}>
                    <div style={{ textAlign: "center" }}><div style={{ color: T.text, fontWeight: 600 }}>{a.t}</div><div style={{ color: T.textFaint }}>Trades</div></div>
                    <div style={{ textAlign: "center" }}><div style={{ color: T.text, fontWeight: 600 }}>{a.wr}</div><div style={{ color: T.textFaint }}>WR</div></div>
                    <div style={{ textAlign: "center" }}><div style={{ color: T.text, fontWeight: 600 }}>{a.open}</div><div style={{ color: T.textFaint }}>Open</div></div>
                  </div>
                  <div style={{ color: T.textFaint, fontSize: 9, textAlign: "center", marginTop: 6 }}>Lot: {a.lot} | Risk: {a.risk}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Equity + Daily P&L charts */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginTop: 14 }}>
            <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: 18 }}>
              <div style={{ color: T.text, fontSize: 13, fontWeight: 600, marginBottom: 14, display: "flex", alignItems: "center", gap: 6 }}>
                <TrendingUp size={14} /> Equity Curve
              </div>
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={equity}>
                  <CartesianGrid strokeDasharray="2 4" stroke={T.border} />
                  <XAxis dataKey="date" tick={{ fill: T.textDim, fontSize: 9 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: T.textDim, fontSize: 9 }} axisLine={false} tickLine={false} />
                  <Line type="monotone" dataKey="equity" stroke={T.accent} strokeWidth={2} dot={false} />
                  <Tooltip contentStyle={{ background: T.panel, border: `1px solid ${T.border}`, fontSize: 11 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: 18 }}>
              <div style={{ color: T.text, fontSize: 13, fontWeight: 600, marginBottom: 14, display: "flex", alignItems: "center", gap: 6 }}>
                <BarChart2 size={14} /> Daily P&L
              </div>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={daily}>
                  <CartesianGrid strokeDasharray="2 4" stroke={T.border} />
                  <XAxis dataKey="date" tick={{ fill: T.textDim, fontSize: 9 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: T.textDim, fontSize: 9 }} axisLine={false} tickLine={false} />
                  <ReferenceLine y={0} stroke={T.textFaint} />
                  <Bar dataKey="pnl" radius={[3, 3, 0, 0]}>
                    {daily.map((d, i) => <Cell key={i} fill={d.pnl >= 0 ? T.green : T.red} />)}
                  </Bar>
                  <Tooltip contentStyle={{ background: T.panel, border: `1px solid ${T.border}`, fontSize: 11 }} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </>
      )}

      {tab !== "overview" && (
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: 60, textAlign: "center", color: T.textFaint, marginTop: 16 }}>
          {TABS.find(x => x.id === tab)?.l} — content coming soon.
        </div>
      )}
    </div>
  );
}

// ── AUTO-TRADING PAGE ──────────────────────────────────────────────────
const initialAutoState = {
  lotMode: "manual",
  lotSize: 0.01,
  minConf: 70,
  closeTP1: 75,
  slProfit: 27,
  trailStep: 20,
  trailingSL: true,
  assets: Object.fromEntries(ASSETS.map(a => [a, { active: true, lot: a === "MSFT" ? 0.05 : 0.01, risk: 0.25, cap: 3.0 }])),
  perPair: Object.fromEntries(ASSETS.map(a => [a, true])),
};

function autoReducer(state, action) {
  switch (action.type) {
    case "SET":  return { ...state, [action.k]: action.v };
    case "SET_ASSET": return { ...state, assets: { ...state.assets, [action.sym]: { ...state.assets[action.sym], [action.k]: action.v } } };
    case "TOGGLE_PAIR": return { ...state, perPair: { ...state.perPair, [action.sym]: !state.perPair[action.sym] } };
    default: return state;
  }
}

function Slider({ value, min, max, onChange, color = T.accent }) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div style={{ position: "relative", height: 8 }}>
      <div style={{ position: "absolute", inset: 0, background: T.border, borderRadius: 99 }} />
      <div style={{ position: "absolute", left: 0, top: 0, height: "100%", width: `${pct}%`, background: `linear-gradient(90deg,${color},${T.accentDim})`, borderRadius: 99 }} />
      <input type="range" min={min} max={max} value={value} onChange={e => onChange(+e.target.value)}
        style={{ position: "absolute", inset: 0, opacity: 0, cursor: "pointer", width: "100%", margin: 0 }} />
      <div style={{ position: "absolute", left: `calc(${pct}% - 8px)`, top: -4, width: 16, height: 16, borderRadius: "50%", background: color, boxShadow: "0 0 0 3px rgba(0,0,0,0.6)", pointerEvents: "none" }} />
    </div>
  );
}

function Toggle({ on, onClick, size = "md" }) {
  const w = size === "sm" ? 30 : 36;
  const h = size === "sm" ? 16 : 20;
  const knob = h - 4;
  return (
    <button onClick={onClick} style={{
      width: w, height: h, borderRadius: 99, background: on ? T.accent : T.border,
      border: "none", cursor: "pointer", position: "relative", flexShrink: 0, transition: "background 0.15s",
    }}>
      <div style={{
        position: "absolute", top: 2, left: on ? w - knob - 2 : 2,
        width: knob, height: knob, borderRadius: "50%", background: "#fff", transition: "left 0.15s",
      }} />
    </button>
  );
}

function AutoTradingPage({ onBack, autoState, autoDispatch }) {
  const [running, setRunning] = useState(true);

  return (
    <div style={{ padding: "0 24px 40px" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 14, padding: "20px 0 12px" }}>
        <button onClick={onBack} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, padding: "8px 14px", color: T.textDim, cursor: "pointer", display: "flex", alignItems: "center", gap: 6, marginTop: 4, fontFamily: "inherit", fontSize: 12 }}>
          <ChevronLeft size={13} /> Dashboard
        </button>
        <div style={{ width: 42, height: 42, borderRadius: 10, background: "rgba(245,166,35,0.12)", border: `1px solid ${T.accent}40`, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Cpu size={20} color={T.accent} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <h1 style={{ color: T.accent, fontSize: 22, fontWeight: 700, margin: 0 }}>Auto-Trading</h1>
            <span style={{ color: T.textDim, fontSize: 13 }}>EA Control Center</span>
          </div>
          <div style={{ color: T.textFaint, fontSize: 11, marginTop: 4 }}>Full remote control for MetaTrader 5 EA</div>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
          <button onClick={() => setRunning(r => !r)} style={{ background: running ? T.red : T.green, border: "none", borderRadius: 8, padding: "10px 18px", color: "#fff", fontWeight: 700, fontSize: 12, cursor: "pointer", display: "flex", alignItems: "center", gap: 8, fontFamily: "inherit" }}>
            <Power size={13} /> {running ? "STOP TRADING" : "START TRADING"}
          </button>
          <button style={{ background: "rgba(34,197,94,0.10)", border: `1px solid ${T.green}55`, borderRadius: 8, padding: "10px 14px", color: T.green, fontSize: 12, cursor: "pointer", display: "flex", alignItems: "center", gap: 6, fontFamily: "inherit" }}>
            <Wifi size={12} /> EA Connected
          </button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 14, marginTop: 8 }}>
        {/* LEFT COLUMN */}
        <div>
          {/* DeepTrade EA Dashboard console */}
          <div style={{ background: "#000", border: `1px solid ${T.border}`, borderRadius: 10, padding: 18, fontFamily: "'JetBrains Mono',monospace", fontSize: 11 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <div>
                <div style={{ color: T.accent, fontSize: 13, fontWeight: 700 }}>DeepTrade EA v3.0 Dashboard</div>
                <div style={{ color: T.green, fontSize: 11 }}>CONNECTED · <span style={{ color: T.accent }}>ACTIVE</span></div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ color: T.green, fontSize: 10, fontWeight: 700 }}>● LIVE</div>
                <div style={{ color: T.textFaint, fontSize: 9 }}>Polls: 15s</div>
              </div>
            </div>

            <ConsoleSection title="ACCOUNT">
              <ConsoleRow k="Balance:" v="$89432.03" />
              <ConsoleRow k="Leverage:" v="—" right />
              <ConsoleRow k="Equity:" v="$89417.92" />
              <ConsoleRow k="Margin Lvl:" v="—" right />
              <ConsoleRow k="Free Margin:" v="$89417.92" />
              <ConsoleRow k="Float P&L:" v="$0.00" vColor={T.green} right />
            </ConsoleSection>

            <ConsoleSection title="DAILY PERFORMANCE">
              <ConsoleRow k="Daily P&L:" v="$0.00" vColor={T.green} />
              <ConsoleRow k="Win Rate:" v="0%" right />
              <ConsoleRow k="Trades:" v="0" />
              <ConsoleRow k="Streak:" v="—" right />
              <ConsoleRow k="W/L:" v="0 / 0" />
              <ConsoleRow k="Session:" v="$0.00" vColor={T.green} right />
            </ConsoleSection>

            <ConsoleSection title="RISK MANAGEMENT">
              <ConsoleRow k="Drawdown:" v="0.0%" />
              <ConsoleRow k="DD Limit:" v="15%" vColor={T.accent} right />
              <ConsoleRow k="Max DD:" v="0.0%" />
              <ConsoleRow k="Daily Lim:" v="OFF" vColor={T.accent} right />
            </ConsoleSection>

            <ConsoleSection title="ACTIVE SETTINGS">
              <ConsoleRow k="Mode:" v="MANUAL" vColor={T.accent} />
              <ConsoleRow k="Min Conf:" v="70" right />
              <ConsoleRow k="Lot:" v="0.01" vColor={T.accent} />
              <ConsoleRow k="Trail:" v="TRAIL 20%" vColor={T.accent} right />
            </ConsoleSection>

            <ConsoleSection title="OPEN TRADES" tail="1">
              <ConsoleRow k="BTCUSD BUY" v="$0.00" vColor={T.green} />
            </ConsoleSection>

            <ConsoleSection title="ASSET STATUS">
              <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 8, textAlign: "center" }}>
                {["XAU", "BTC", "SP500", "MSFT", "AMZN"].map(s => (
                  <div key={s}>
                    <div style={{ color: T.accent, fontSize: 10 }}>{s}</div>
                    <div style={{ color: T.green, fontSize: 10 }}>ON</div>
                  </div>
                ))}
              </div>
            </ConsoleSection>

            <ConsoleSection title="FILTERS">
              <div style={{ color: T.text, fontSize: 10 }}>Spread:ON | Sessions:OFF | ATRs:OFF</div>
              <div style={{ color: T.textFaint, fontSize: 10, marginTop: 3 }}>Last update: 05:28:35 | Session: <span style={{ color: T.accent }}>ASIAN</span></div>
            </ConsoleSection>
          </div>

          {/* Download EA */}
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: 18, marginTop: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
              <div style={{ width: 36, height: 36, borderRadius: 8, background: "rgba(245,166,35,0.15)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <Download size={16} color={T.accent} />
              </div>
              <div>
                <div style={{ color: T.text, fontSize: 13, fontWeight: 600 }}>Download EA v3.0 — Advanced Protection</div>
                <div style={{ color: T.textFaint, fontSize: 10, marginTop: 3 }}>ATR trailing SL, drawdown protection, regime detection + remote control</div>
              </div>
            </div>
            <button style={{ width: "100%", background: T.accent, border: "none", borderRadius: 8, padding: 12, color: "#000", fontWeight: 700, fontSize: 12, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontFamily: "inherit" }}>
              <Download size={13} /> Download DeepTrade EA v3.0
            </button>
          </div>

          {/* EA Configuration */}
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: 18, marginTop: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <div style={{ color: T.text, fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
                <Settings size={14} /> EA Configuration — Remote Control
              </div>
            </div>

            {/* Lot Mode */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                <span style={{ color: T.text, fontSize: 11, display: "flex", alignItems: "center", gap: 5 }}>⚡ Lot Mode</span>
                <span style={{ background: "rgba(245,166,35,0.15)", color: T.accent, padding: "2px 8px", borderRadius: 3, fontSize: 9, fontWeight: 700 }}>{autoState.lotMode.toUpperCase()}</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, background: T.panel, borderRadius: 6, padding: 3 }}>
                {[
                  { id: "manual", l: "Manual lot" },
                  { id: "auto",   l: "Auto risk" },
                ].map(x => (
                  <button key={x.id} onClick={() => autoDispatch({ type: "SET", k: "lotMode", v: x.id })} style={{
                    background: autoState.lotMode === x.id ? T.accent : "transparent",
                    border: "none", borderRadius: 4, padding: "8px 10px",
                    color: autoState.lotMode === x.id ? "#000" : T.textDim,
                    fontSize: 11, cursor: "pointer", fontWeight: 600, fontFamily: "inherit",
                  }}>{x.l}</button>
                ))}
              </div>
              <div style={{ color: T.textFaint, fontSize: 10, marginTop: 6 }}>Manual uses a fixed lot. Auto risk sizes volume from account equity, stop-loss distance, and the risk % below.</div>
            </div>

            {/* Lot Size input */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 11 }}>
                <span style={{ color: T.text, display: "flex", alignItems: "center", gap: 5 }}><DollarSign size={11} /> Lot Size</span>
                <span style={{ color: T.text, fontFamily: "'JetBrains Mono',monospace" }}>{autoState.lotSize.toFixed(2)}</span>
              </div>
              <input type="number" step="0.01" value={autoState.lotSize} onChange={e => autoDispatch({ type: "SET", k: "lotSize", v: parseFloat(e.target.value) || 0 })}
                style={{ width: "100%", background: T.panel, border: `1px solid ${T.border}`, borderRadius: 6, padding: "8px 10px", color: T.text, fontFamily: "'JetBrains Mono',monospace", fontSize: 12, outline: "none", boxSizing: "border-box" }} />
            </div>

            {/* Sliders */}
            <SliderRow label="Min Confidence" icon="📊" value={autoState.minConf} min={0} max={100} suffix="%"
              onChange={v => autoDispatch({ type: "SET", k: "minConf", v })} />

            <SliderRow label="Close at TP1" icon="%" value={autoState.closeTP1} min={0} max={100} suffix="%"
              hint="When TP1 is hit, close 75% and let 25% run to TP2/TP3"
              onChange={v => autoDispatch({ type: "SET", k: "closeTP1", v })} />

            <SliderRow label="SL Profit (after TP1)" icon="🎯" value={autoState.slProfit} min={0} max={100} suffix=" pips"
              hint="After TP1 hit, SL moves to entry + 27 pips profit (safety lock)"
              onChange={v => autoDispatch({ type: "SET", k: "slProfit", v })} />

            {/* Auto-Trailing SL toggle */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 0", marginBottom: 8 }}>
              <div>
                <div style={{ color: T.text, fontSize: 11, fontWeight: 600 }}>Auto-Trailing SL</div>
                <div style={{ color: T.textFaint, fontSize: 10, marginTop: 2 }}>Lock 20% of profit as price moves</div>
              </div>
              <Toggle on={autoState.trailingSL} onClick={() => autoDispatch({ type: "SET", k: "trailingSL", v: !autoState.trailingSL })} />
            </div>

            <SliderRow label="Trail Step %" value={autoState.trailStep} min={0} max={100} suffix="%"
              onChange={v => autoDispatch({ type: "SET", k: "trailStep", v })} />

            <button style={{ width: "100%", background: T.accent, border: "none", borderRadius: 8, padding: 12, color: "#000", fontWeight: 700, fontSize: 12, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, marginTop: 14, fontFamily: "inherit" }}>
              <CheckCircle2 size={13} /> Save All Settings
            </button>
            <div style={{ color: T.textFaint, fontSize: 10, textAlign: "center", marginTop: 8 }}>EA syncs settings every 2 minutes automatically</div>
          </div>

          {/* Per-Asset Lot & Risk Caps */}
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: 18, marginTop: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: T.accent }} />
              <span style={{ color: T.text, fontSize: 13, fontWeight: 600 }}>Per-Asset Lot & Risk Caps</span>
            </div>
            <div style={{ color: T.textFaint, fontSize: 10, marginBottom: 14 }}>Override the global lot size and risk % for each asset individually.</div>

            {ASSETS.map(sym => {
              const a = autoState.assets[sym];
              return (
                <div key={sym} style={{ borderTop: `1px solid ${T.border2}`, padding: "14px 0" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                    <span style={{ color: T.accent, fontSize: 12, fontWeight: 700 }}>{sym}</span>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ color: T.accent, fontSize: 10 }}>Active</span>
                      <Toggle on={a.active} onClick={() => autoDispatch({ type: "SET_ASSET", sym, k: "active", v: !a.active })} size="sm" />
                    </div>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                    {[
                      { l: "Lot Size", k: "lot" },
                      { l: "Risk %", k: "risk" },
                      { l: "Max Risk Cap %", k: "cap" },
                    ].map(({ l, k }) => (
                      <div key={k}>
                        <div style={{ color: T.textFaint, fontSize: 9, marginBottom: 3 }}>{l}</div>
                        <input type="number" step="0.01" value={a[k]} onChange={e => autoDispatch({ type: "SET_ASSET", sym, k, v: parseFloat(e.target.value) || 0 })}
                          style={{ width: "100%", background: T.panel, border: `1px solid ${T.border}`, borderRadius: 6, padding: "7px 10px", color: T.text, fontFamily: "'JetBrains Mono',monospace", fontSize: 11, outline: "none", boxSizing: "border-box" }} />
                      </div>
                    ))}
                  </div>
                  <div style={{ color: T.textFaint, fontSize: 10, marginTop: 6 }}>Fixed lot: {a.lot.toFixed(2)} lots per trade</div>
                </div>
              );
            })}

            <button style={{ width: "100%", background: T.accent, border: "none", borderRadius: 8, padding: 12, color: "#000", fontWeight: 700, fontSize: 12, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, marginTop: 14, fontFamily: "inherit" }}>
              <CheckCircle2 size={13} /> Save Asset Risk Settings
            </button>
          </div>

          {/* Setup Guide */}
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: 18, marginTop: 14 }}>
            <div style={{ color: T.text, fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Setup Guide</div>
            {[
              { n: 1, t: "Download the EA file", d: "Download the DeepTrade_EA_v1.mq5 file to your computer." },
              { n: 2, t: "Copy to MT5 Experts folder", d: "Move the file to your MetaTrader 5 data folder: MQL5/Experts/DeepTrade_EA_v1.mq5" },
              { n: 3, t: "Allow WebRequest in MT5", d: "Go to Tools → Options → Expert Advisors → Check 'Allow WebRequest for listed URL' and add the API URL shown below." },
              { n: 4, t: "Compile & Attach to Chart", d: "Open MetaEditor (F4), compile the EA, then drag it onto any chart in MT5." },
              { n: 5, t: "Configure Inputs & Go Live", d: "The default API URL and key are pre-configured. Adjust lot size, confidence threshold, and TP levels to your preference." },
            ].map(step => (
              <div key={step.n} style={{ display: "flex", gap: 12, padding: "10px 0", borderTop: step.n > 1 ? `1px solid ${T.border2}` : "none" }}>
                <div style={{ width: 22, height: 22, borderRadius: "50%", background: "rgba(245,166,35,0.15)", color: T.accent, fontSize: 10, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{step.n}</div>
                <div>
                  <div style={{ color: T.text, fontSize: 11, fontWeight: 600 }}>{step.t}</div>
                  <div style={{ color: T.textFaint, fontSize: 10, marginTop: 3, lineHeight: 1.6 }}>{step.d}</div>
                </div>
              </div>
            ))}
          </div>

          {/* API Configuration */}
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: 18, marginTop: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 12 }}>
              <Settings size={13} color={T.textDim} />
              <span style={{ color: T.text, fontSize: 13, fontWeight: 600 }}>API Configuration</span>
            </div>
            <div style={{ color: T.textFaint, fontSize: 9, marginBottom: 5, letterSpacing: "1px" }}>API GATEWAY URL</div>
            <div style={{ background: T.panel, border: `1px solid ${T.border}`, borderRadius: 6, padding: "9px 12px", display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ flex: 1, color: T.text, fontFamily: "'JetBrains Mono',monospace", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                https://olrhjxaynvgfoypyndua.supabase.co/functions/v1/api-gateway
              </span>
              <Copy size={12} color={T.textDim} style={{ cursor: "pointer" }} />
            </div>
            <div style={{ display: "flex", gap: 8, background: "rgba(245,158,11,0.06)", border: `1px solid ${T.accent}30`, borderRadius: 6, padding: 10, marginTop: 10 }}>
              <AlertTriangle size={12} color={T.accent} style={{ flexShrink: 0, marginTop: 2 }} />
              <div style={{ color: T.textDim, fontSize: 10, lineHeight: 1.6 }}>
                The API key is pre-configured in the EA file. You must add the API URL to MT5's allowed WebRequest URLs in <span style={{ color: T.text }}>Tools → Options → Expert Advisors</span>.
              </div>
            </div>
          </div>
        </div>

        {/* RIGHT COLUMN */}
        <div>
          {/* EA Connections */}
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: 18 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
              <Database size={14} color={T.textDim} />
              <span style={{ color: T.text, fontSize: 13, fontWeight: 600 }}>EA Connections</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Wifi size={12} color={T.green} />
              <span style={{ color: T.text, fontSize: 12, fontWeight: 600 }}>DeepTrade_EA_01</span>
              <div style={{ flex: 1 }} />
              <span style={{ background: "rgba(34,197,94,0.15)", color: T.green, padding: "2px 8px", borderRadius: 3, fontSize: 9, fontWeight: 700 }}>ONLINE</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", fontSize: 11 }}>
              <span style={{ color: T.textDim, display: "flex", alignItems: "center", gap: 4 }}><Clock size={11} /> Trading for 0m</span>
              <span style={{ color: T.textFaint }}>Last ping: 05:28 AM</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderTop: `1px solid ${T.border2}` }}>
              <div>
                <div style={{ color: T.text, fontSize: 11, fontWeight: 600, display: "flex", alignItems: "center", gap: 5 }}><Power size={11} color={T.accent} /> Trading Active</div>
                <div style={{ color: T.textFaint, fontSize: 10, marginTop: 3 }}>EA will execute new signals</div>
              </div>
              <Toggle on={running} onClick={() => setRunning(r => !r)} />
            </div>
            <div style={{ paddingTop: 10, borderTop: `1px solid ${T.border2}`, fontSize: 11 }}>
              <div style={{ color: T.textDim }}>Vantage International Group Limited</div>
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
                <span style={{ color: T.textFaint }}>Account #11581419</span>
                <span style={{ color: T.text, fontFamily: "'JetBrains Mono',monospace" }}>$ Balance: $89432.03</span>
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 2 }}>
                <span style={{ color: T.text, fontFamily: "'JetBrains Mono',monospace" }}>$ Equity: $89417.92</span>
              </div>
            </div>
          </div>

          {/* Live Data Feed */}
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: 18, marginTop: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
              <Radio size={14} color={T.textDim} />
              <span style={{ color: T.text, fontSize: 13, fontWeight: 600 }}>Live Data Feed</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <span style={{ color: T.textFaint, fontSize: 10 }}>5/5 pairs receiving broker data</span>
              <span style={{ background: "rgba(245,166,35,0.15)", color: T.accent, padding: "1px 8px", borderRadius: 3, fontSize: 9, fontWeight: 700 }}>FEEDING</span>
            </div>
            <div style={{ background: T.border, borderRadius: 2, height: 3, overflow: "hidden", marginBottom: 12 }}>
              <div style={{ width: "100%", height: "100%", background: T.accent }} />
            </div>
            {[
              { sym: "XAUUSD", price: "$4832.47", sprd: "0.2", atr: "7.53", ago: "55s ago" },
              { sym: "BTCUSD", price: "$77000.91", sprd: "17.0", atr: "129.94", ago: "55s ago" },
              { sym: "SP500",  price: "$7133.83", sprd: "0.4", atr: "55s ago" },
              { sym: "MSFT",   price: "$422.90", sprd: "0.1", atr: "1.47", ago: "54s ago" },
              { sym: "AMZN",   price: "$250.93", sprd: "0.1", atr: "0.79", ago: "54s ago" },
            ].map((r, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderTop: i > 0 ? `1px solid ${T.border2}` : "none", fontSize: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ color: T.accent, fontWeight: 600 }}>{r.sym}</span>
                  <span style={{ background: T.panel, color: T.textDim, padding: "1px 6px", borderRadius: 3, fontSize: 8 }}>EA BROKER</span>
                </div>
                <div style={{ color: T.text, fontFamily: "'JetBrains Mono',monospace" }}>{r.price} <span style={{ color: T.textFaint, marginLeft: 5 }}>Sprd: {r.sprd}</span> {r.atr && <span style={{ color: T.textFaint, marginLeft: 5 }}>ATR: {r.atr}</span>} <span style={{ color: T.textFaint, marginLeft: 5 }}>{r.ago}</span></div>
              </div>
            ))}
          </div>

          {/* Per-Pair Controls */}
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: 18, marginTop: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <Sliders size={14} color={T.textDim} />
              <span style={{ color: T.text, fontSize: 13, fontWeight: 600 }}>Per-Pair Controls</span>
            </div>
            <div style={{ color: T.textFaint, fontSize: 10, marginBottom: 12 }}>DEEPTRADE_EA_01</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {ASSETS.map(sym => (
                <div key={sym} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 0" }}>
                  <span style={{ color: T.text, fontSize: 11, display: "flex", alignItems: "center", gap: 5 }}>
                    <span style={{ width: 5, height: 5, borderRadius: "50%", background: autoState.perPair[sym] ? T.green : T.red }} />
                    {sym}
                  </span>
                  <Toggle on={autoState.perPair[sym]} onClick={() => autoDispatch({ type: "TOGGLE_PAIR", sym })} size="sm" />
                </div>
              ))}
            </div>
          </div>

          {/* EA Trades */}
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: 18, marginTop: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <TrendingUp size={14} color={T.textDim} />
                <span style={{ color: T.text, fontSize: 13, fontWeight: 600 }}>EA Trades</span>
              </div>
              <button style={{ background: T.red, border: "none", borderRadius: 6, padding: "5px 10px", color: "#fff", fontSize: 10, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 4 }}>
                <XCircle size={10} /> Close All
              </button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, background: T.panel, borderRadius: 6, padding: 3, marginBottom: 12 }}>
              <button style={{ background: T.card, border: "none", borderRadius: 4, padding: "6px 10px", color: T.text, fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>▷ Active (1)</button>
              <button style={{ background: "transparent", border: "none", borderRadius: 4, padding: "6px 10px", color: T.textDim, fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>○ Closed (29)</button>
            </div>
            <div style={{ background: T.panel, borderRadius: 6, padding: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <TrendingUp size={11} color={T.green} />
                <span style={{ color: T.accent, fontSize: 11, fontWeight: 600 }}>BTCUSD</span>
                <span style={{ background: "rgba(245,166,35,0.15)", color: T.accent, padding: "1px 6px", borderRadius: 3, fontSize: 9, fontWeight: 700 }}>BUY</span>
                <span style={{ color: T.textFaint, fontSize: 10 }}>0.01 lot</span>
                <div style={{ flex: 1 }} />
                <span style={{ color: T.green, fontWeight: 700, fontFamily: "'JetBrains Mono',monospace", fontSize: 11 }}>+0.00</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, marginBottom: 8 }}>
                <span style={{ color: T.textDim }}>Entry: <span style={{ color: T.text, fontFamily: "'JetBrains Mono',monospace" }}>77324.12000</span></span>
                <span style={{ color: T.textDim }}>SL: <span style={{ color: T.red, fontFamily: "'JetBrains Mono',monospace" }}>76674.12000</span></span>
                <span style={{ color: T.textDim }}>TP: <span style={{ color: T.green, fontFamily: "'JetBrains Mono',monospace" }}>79924.12000</span></span>
              </div>
              <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                <button style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 5, padding: "4px 10px", color: T.textDim, fontSize: 10, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 4 }}><Shield size={10} /> Breakeven</button>
                <button style={{ background: T.card, border: `1px solid ${T.green}55`, borderRadius: 5, padding: "4px 10px", color: T.green, fontSize: 10, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 4 }}><Target size={10} /> SL → 50%</button>
                <div style={{ flex: 1 }} />
                <button style={{ background: T.red, border: "none", borderRadius: 5, padding: "4px 10px", color: "#fff", fontSize: 10, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 4 }}><XCircle size={10} /> Close</button>
              </div>
              <div style={{ color: T.textFaint, fontSize: 9 }}>Opened: 17/04/2026, 21:07:13</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ConsoleSection({ title, tail, children }) {
  return (
    <div style={{ marginTop: 14, paddingTop: 8, borderTop: `1px solid ${T.border2}` }}>
      <div style={{ display: "flex", justifyContent: "space-between", color: T.textFaint, fontSize: 10, letterSpacing: "1px", marginBottom: 6 }}>
        <span>{title}</span>
        {tail && <span style={{ color: T.text }}>{tail}</span>}
      </div>
      {children}
    </div>
  );
}

function ConsoleRow({ k, v, vColor = T.text, right }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", fontSize: 11 }}>
      <span style={{ color: T.textDim }}>{k}</span>
      <span style={{ color: vColor, fontFamily: "'JetBrains Mono',monospace", fontWeight: 600 }}>{v}</span>
    </div>
  );
}

function SliderRow({ label, icon, value, min, max, suffix = "", hint, onChange }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8, fontSize: 11 }}>
        <span style={{ color: T.text, display: "flex", alignItems: "center", gap: 5 }}>
          {icon && <span>{icon}</span>}{label}
        </span>
        <span style={{ color: T.text, fontFamily: "'JetBrains Mono',monospace", fontWeight: 600 }}>{value}{suffix}</span>
      </div>
      <Slider value={value} min={min} max={max} onChange={onChange} />
      {hint && <div style={{ color: T.textFaint, fontSize: 10, marginTop: 6 }}>{hint}</div>}
    </div>
  );
}

// ── SIMPLE PLACEHOLDER PAGES ───────────────────────────────────────────
function PlaceholderPage({ icon: Icon, title, subtitle }) {
  return (
    <div style={{ padding: "0 24px 40px" }}>
      <PageHeader icon={Icon} title={title} subtitle={subtitle} />
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: 80, textAlign: "center", color: T.textFaint, marginTop: 20 }}>
        {title} — content coming soon.
      </div>
    </div>
  );
}

function DashboardPage({ setPage }) {
  return (
    <div style={{ padding: "0 24px 40px" }}>
      <PageHeader icon={Home} title="Dashboard" subtitle="Welcome to Smart Entry Pro" />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginTop: 16 }}>
        <StatCard icon={Trophy}     value="51.3%"  label="Win Rate"  color={T.accent} />
        <StatCard icon={TrendingUp} value="513"    label="Wins"      color={T.green} />
        <StatCard icon={TrendingDown} value="477"  label="Losses"    color={T.red} />
        <StatCard icon={DollarSign} value="$89432" label="Balance"   color={T.accent} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginTop: 12 }}>
        {[
          { id: "command",     label: "Command Center", icon: Radio },
          { id: "auto",        label: "Auto-Trading",   icon: Cpu },
          { id: "performance", label: "Performance",    icon: Award },
          { id: "shadow",      label: "Shadow Trades",  icon: Ghost },
        ].map(({ id, label, icon: Icon }) => (
          <button key={id} onClick={() => setPage(id)} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: 24, cursor: "pointer", textAlign: "left", color: T.text, fontFamily: "inherit" }}>
            <Icon size={20} color={T.accent} style={{ marginBottom: 10 }} />
            <div style={{ color: T.text, fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{label}</div>
            <div style={{ color: T.textFaint, fontSize: 10, display: "flex", alignItems: "center", gap: 4 }}>Open <ChevronRight size={11} /></div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── LOGIN ──────────────────────────────────────────────────────────────
function LoginScreen({ onLogin }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState(false);
  const check = () => { if (pw === "lyra2024" || pw === "admin") onLogin(); else { setErr(true); setTimeout(() => setErr(false), 1500); } };
  return (
    <div style={{ height: "100vh", background: T.bg, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'JetBrains Mono',monospace" }}>
      <div style={{ background: T.panel, border: `1px solid ${T.border}`, borderRadius: 16, padding: 44, width: 380, textAlign: "center" }}>
        <div style={{ width: 56, height: 56, background: "linear-gradient(135deg,#f5a623,#c47d10)", borderRadius: 14, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
          <Sparkles size={26} color="#000" />
        </div>
        <div style={{ color: T.accent, fontSize: 20, fontWeight: 700, marginBottom: 4 }}>Smart Entry Pro</div>
        <div style={{ color: T.textFaint, fontSize: 10, marginBottom: 28, letterSpacing: "2px" }}>REVO · TRADING TERMINAL</div>
        <input type="password" placeholder="Enter access password" value={pw} onChange={e => setPw(e.target.value)} onKeyDown={e => e.key === "Enter" && check()}
          style={{ width: "100%", background: T.bg, border: `1px solid ${err ? T.red : T.border}`, borderRadius: 8, padding: "12px 14px", color: T.text, fontSize: 12, fontFamily: "inherit", boxSizing: "border-box", outline: "none", marginBottom: 12 }} />
        <button onClick={check} style={{ width: "100%", background: T.accent, border: "none", borderRadius: 8, padding: 12, color: "#000", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
          ⚡ ACCESS DASHBOARD
        </button>
        {err && <div style={{ color: T.red, fontSize: 10, marginTop: 10 }}>⚠ Invalid access code</div>}
        <div style={{ color: T.textFaint, fontSize: 9, marginTop: 18 }}>Default: lyra2024</div>
      </div>
    </div>
  );
}

// ── ROOT APP ───────────────────────────────────────────────────────────
export default function App() {
  const [authed, setAuthed] = useState(false);
  const [page, setPage] = useState("performance");
  const [autoState, autoDispatch] = useReducer(autoReducer, initialAutoState);

  if (!authed) return <LoginScreen onLogin={() => setAuthed(true)} />;

  return (
    <div style={{ display: "flex", height: "100vh", background: T.bg, fontFamily: "'JetBrains Mono', 'Fira Code', monospace", color: T.text, overflow: "hidden" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap');
        *{box-sizing:border-box;margin:0;padding:0;}
        ::-webkit-scrollbar{width:6px;height:6px;}
        ::-webkit-scrollbar-track{background:${T.bg};}
        ::-webkit-scrollbar-thumb{background:${T.border};border-radius:3px;}
        ::-webkit-scrollbar-thumb:hover{background:${T.textFaint};}
        button:hover{opacity:0.9;transition:opacity .15s;}
        input:focus,select:focus{border-color:${T.accent}!important;outline:none;}
        input[type=number]::-webkit-inner-spin-button,input[type=number]::-webkit-outer-spin-button{-webkit-appearance:none;margin:0;}
        input[type=number]{-moz-appearance:textfield;}
      `}</style>
      <Sidebar page={page} setPage={setPage} onLogout={() => setAuthed(false)} />
      <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden" }}>
        {/* Top bar with panel toggle */}
        <div style={{ padding: "10px 24px 0" }}>
          <button style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 6, width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center", color: T.textDim, cursor: "pointer" }}>
            <PanelLeft size={13} />
          </button>
        </div>

        {page === "dashboard"   && <DashboardPage setPage={setPage} />}
        {page === "command"     && <EACommandPage />}
        {page === "charts"      && <PlaceholderPage icon={BarChart2} title="Charts" subtitle="Live market charts" />}
        {page === "auto"        && <AutoTradingPage onBack={() => setPage("dashboard")} autoState={autoState} autoDispatch={autoDispatch} />}
        {page === "ea"          && <EACommandPage />}
        {page === "performance" && <PerformancePage onBack={() => setPage("dashboard")} onOpenShadow={() => setPage("shadow")} />}
        {page === "shadow"      && <ShadowTradesPage onBack={() => setPage("performance")} />}
      </div>
    </div>
  );
}
