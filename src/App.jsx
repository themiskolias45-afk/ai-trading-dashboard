import { useEffect, useState } from "react";

/* =========================
   CONFIG
========================= */
const BTC_WEEKLY =
  "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1w&limit=120";
const BTC_DAILY =
  "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=120";
const BTC_HTF =
  "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=15m&limit=120";
const BTC_LTF =
  "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=120";

/* =========================
   HELPERS
========================= */
const parse = (d) =>
  d.map((c) => ({
    open: +c[1],
    high: +c[2],
    low: +c[3],
    close: +c[4],
  }));

const biasFromStructure = (c) => {
  if (c.length < 20) return "NO DATA";
  const hi = c.at(-1).high > c.at(-5).high;
  const lo = c.at(-1).low < c.at(-5).low;
  if (hi && !lo) return "BULLISH";
  if (lo && !hi) return "BEARISH";
  return "RANGE";
};

const detectDisplacement = (c) => {
  const last = c.at(-1);
  const prev = c.at(-2);
  const body = Math.abs(last.close - last.open);
  const prevBody = Math.abs(prev.close - prev.open);
  if (body > prevBody * 1.8) {
    return last.close > last.open ? "BULLISH" : "BEARISH";
  }
  return null;
};

const detectFVG = (c) => {
  if (c.length < 4) return null;
  const a = c.at(-3);
  const b = c.at(-2);
  const d = c.at(-1);
  if (d.low > a.high)
    return { type: "BULLISH", low: a.high, high: d.low };
  if (d.high < a.low)
    return { type: "BEARISH", low: d.high, high: a.low };
  return null;
};

const mlScore = ({
  weekly,
  daily,
  htf,
  ltf,
  displacement,
  fvg,
}) => {
  let score = 0;
  if (weekly === daily) score += 20;
  if (daily === htf) score += 20;
  if (htf === ltf) score += 15;
  if (displacement) score += 25;
  if (fvg) score += 20;
  return Math.min(score, 100);
};

/* =========================
   APP
========================= */
export default function App() {
  const [btc, setBTC] = useState(null);
  const [state, setState] = useState("Loading...");
  const [analysis, setAnalysis] = useState(null);

  useEffect(() => {
    async function run() {
      try {
        const [
          w,
          d,
          h,
          l,
        ] = await Promise.all([
          fetch(BTC_WEEKLY).then((r) => r.json()),
          fetch(BTC_DAILY).then((r) => r.json()),
          fetch(BTC_HTF).then((r) => r.json()),
          fetch(BTC_LTF).then((r) => r.json()),
        ]);

        const W = parse(w);
        const D = parse(d);
        const H = parse(h);
        const L = parse(l);

        const weeklyBias = biasFromStructure(W);
        const dailyBias = biasFromStructure(D);
        const htfBias = biasFromStructure(H);
        const ltfBias = biasFromStructure(L);

        const displacement = detectDisplacement(L);
        const fvg = detectFVG(L);

        if (!displacement || !fvg) {
          setState("WAIT (No displacement)");
          setBTC(L.at(-1).close);
          setAnalysis({
            weeklyBias,
            dailyBias,
            htfBias,
            ltfBias,
            conclusion:
              "Price inside equilibrium. Professionals wait for displacement.",
          });
          return;
        }

        if (displacement !== htfBias) {
          setState("WAIT (HTF not aligned)");
          setBTC(L.at(-1).close);
          return;
        }

        const confidence = mlScore({
          weekly: weeklyBias,
          daily: dailyBias,
          htf: htfBias,
          ltf: ltfBias,
          displacement,
          fvg,
        });

        if (confidence < 70) {
          setState("WAIT (Low confidence)");
          setBTC(L.at(-1).close);
          return;
        }

        const entry = (fvg.low + fvg.high) / 2;
        const sl =
          displacement === "BULLISH"
            ? Math.min(...L.slice(-10).map((c) => c.low))
            : Math.max(...L.slice(-10).map((c) => c.high));

        const tp1 =
          displacement === "BULLISH"
            ? entry + (entry - sl) * 1.5
            : entry - (sl - entry) * 1.5;

        const tp2 =
          displacement === "BULLISH"
            ? entry + (entry - sl) * 3
            : entry - (sl - entry) * 3;

        setBTC(L.at(-1).close);
        setState("ALERT");
        setAnalysis({
          weeklyBias,
          dailyBias,
          htfBias,
          ltfBias,
          displacement,
          entry,
          sl,
          tp1,
          tp2,
          confidence,
        });
      } catch {
        setState("ERROR");
      }
    }

    run();
    const i = setInterval(run, 60000);
    return () => clearInterval(i);
  }, []);

  return (
    <div style={ui.bg}>
      <h1>AI Trading Dashboard</h1>

      <div style={ui.card}>BTCUSD: ${btc?.toFixed(2)}</div>
      <div style={ui.card}>System State: {state}</div>

      {analysis && (
        <>
          <div style={ui.card}>Weekly Bias: {analysis.weeklyBias}</div>
          <div style={ui.card}>Daily Bias: {analysis.dailyBias}</div>
          <div style={ui.card}>HTF (15m): {analysis.htfBias}</div>
          <div style={ui.card}>LTF (5m): {analysis.ltfBias}</div>

          {analysis.entry && (
            <>
              <div style={ui.card}>Entry: {analysis.entry.toFixed(2)}</div>
              <div style={ui.card}>SL: {analysis.sl.toFixed(2)}</div>
              <div style={ui.card}>TP1: {analysis.tp1.toFixed(2)}</div>
              <div style={ui.card}>TP2: {analysis.tp2.toFixed(2)}</div>
              <div style={ui.card}>
                ML Confidence: {analysis.confidence}% (A-grade)
              </div>
            </>
          )}

          {analysis.conclusion && (
            <div style={ui.card}>{analysis.conclusion}</div>
          )}
        </>
      )}
    </div>
  );
}

/* =========================
   UI
========================= */
const ui = {
  bg: {
    background: "#0b1020",
    minHeight: "100vh",
    padding: 20,
    color: "white",
    fontFamily: "Arial",
  },
  card: {
    background: "#11172a",
    padding: 14,
    margin: "10px 0",
    borderRadius: 10,
  },
};