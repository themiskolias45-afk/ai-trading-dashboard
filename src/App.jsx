import { useEffect, useState } from "react";

/* ===============================
   CONFIG
================================ */
const SYMBOL = "BTCUSDT";

/* ===============================
   DATA FETCH
================================ */
async function fetchKlines(interval, limit = 200) {
  const r = await fetch(
    `https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=${interval}&limit=${limit}`
  );
  const d = await r.json();
  return d.map(c => ({
    time: c[0],
    open: +c[1],
    high: +c[2],
    low: +c[3],
    close: +c[4]
  }));
}

async function fetchPrice() {
  const r = await fetch(
    `https://api.binance.com/api/v3/ticker/price?symbol=${SYMBOL}`
  );
  const d = await r.json();
  return +d.price;
}

/* ===============================
   MARKET STRUCTURE
================================ */
function structureBias(candles) {
  if (candles.length < 10) return "NO DATA";
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);

  const hh = highs.at(-1) > highs.at(-5);
  const hl = lows.at(-1) > lows.at(-5);
  const lh = highs.at(-1) < highs.at(-5);
  const ll = lows.at(-1) < lows.at(-5);

  if (hh && hl) return "BULLISH";
  if (lh && ll) return "BEARISH";
  return "RANGE";
}

/* ===============================
   RANGE + EQUILIBRIUM
================================ */
function rangeInfo(candles) {
  const high = Math.max(...candles.map(c => c.high));
  const low = Math.min(...candles.map(c => c.low));
  const eq = (high + low) / 2;
  return { high, low, eq };
}

/* ===============================
   SESSION LEVELS
================================ */
function sessionLevels(candles, startUTC, endUTC) {
  const session = candles.filter(c => {
    const h = new Date(c.time).getUTCHours();
    return h >= startUTC && h < endUTC;
  });
  if (!session.length) return null;
  return {
    high: Math.max(...session.map(c => c.high)),
    low: Math.min(...session.map(c => c.low))
  };
}

/* ===============================
   AI ANALYST ENGINE
================================ */
function aiAnalysis({
  price,
  daily,
  weekly,
  htf,
  ltf,
  london,
  ny
}) {
  if (!daily || !weekly) return "Waiting for market data...";

  if (price > daily.eq && price < daily.high)
    return "Price is inside daily equilibrium. Professionals wait for displacement.";

  if (price < daily.eq && htf === "BULLISH")
    return "Price is in discount but HTF bullish. Wait for LTF confirmation.";

  if (price > daily.eq && htf === "BEARISH")
    return "Price is in premium with bearish HTF. Sell setup possible after liquidity.";

  return "No high-probability setup. Discipline = no trade.";
}

/* ===============================
   APP
================================ */
export default function App() {
  const [price, setPrice] = useState(null);

  const [daily, setDaily] = useState(null);
  const [weekly, setWeekly] = useState(null);
  const [htfBias, setHTFBias] = useState(null);
  const [ltfBias, setLTFBias] = useState(null);

  const [london, setLondon] = useState(null);
  const [ny, setNY] = useState(null);

  useEffect(() => {
    async function load() {
      const p = await fetchPrice();
      setPrice(p);

      const d1 = await fetchKlines("1d", 30);
      const w1 = await fetchKlines("1w", 30);
      const htf = await fetchKlines("15m", 120);
      const ltf = await fetchKlines("5m", 120);

      setDaily(rangeInfo(d1));
      setWeekly(rangeInfo(w1));

      setHTFBias(structureBias(htf));
      setLTFBias(structureBias(ltf));

      setLondon(sessionLevels(ltf, 7, 12));
      setNY(sessionLevels(ltf, 12, 17));
    }

    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, []);

  const analysis = aiAnalysis({
    price,
    daily,
    weekly,
    htf: htfBias,
    ltf: ltfBias,
    london,
    ny
  });

  return (
    <div style={{
      background: "#0b1220",
      color: "#e5e7eb",
      minHeight: "100vh",
      padding: "20px",
      fontFamily: "Arial"
    }}>
      <h1>AI Trading Dashboard</h1>

      <div className="card">BTCUSD: ${price?.toFixed(2)}</div>
      <div className="card">Weekly Bias: {weekly ? (price > weekly.eq ? "BULLISH" : "BEARISH") : "—"}</div>
      <div className="card">Daily Bias: {daily ? (price > daily.eq ? "BULLISH" : "BEARISH") : "—"}</div>
      <div className="card">HTF (15m): {htfBias}</div>
      <div className="card">LTF (5m): {ltfBias}</div>

      <h3>AI Conclusion</h3>
      <div className="card">{analysis}</div>

      <style>{`
        .card {
          background: #020617;
          padding: 14px;
          border-radius: 10px;
          margin-bottom: 12px;
        }
      `}</style>
    </div>
  );
}