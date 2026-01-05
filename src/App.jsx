import { useEffect, useState } from "react";

/* ===============================
   CONFIG
================================ */
const BTC_WEEKLY =
  "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1w&limit=120";
const BTC_DAILY =
  "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=120";
const BTC_HTF =
  "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=15m&limit=120";
const BTC_LTF =
  "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=120";

/* ===============================
   HELPERS
================================ */
function parseCandles(data) {
  return data.map((c) => ({
    open: +c[1],
    high: +c[2],
    low: +c[3],
    close: +c[4],
  }));
}

function getBias(candles) {
  if (candles.length < 20) return "NO DATA";
  const last = candles.at(-1);
  const prev = candles.at(-20);
  if (last.close > prev.close) return "BULLISH";
  if (last.close < prev.close) return "BEARISH";
  return "RANGE";
}

function marketState(htf) {
  return htf === "RANGE" ? "RANGE" : "TREND";
}

function confidenceScore(w, d, h, l) {
  let score = 0;
  if (w === d) score += 30;
  if (d === h) score += 30;
  if (h === l) score += 20;
  return Math.min(score, 100);
}

/* ===============================
   APP
================================ */
export default function App() {
  const [price, setPrice] = useState(null);

  const [weekly, setWeekly] = useState("...");
  const [daily, setDaily] = useState("...");
  const [htf, setHtf] = useState("...");
  const [ltf, setLtf] = useState("...");

  const [aiAnswer, setAiAnswer] = useState("");

  /* ===============================
     DATA FETCH
  ================================ */
  useEffect(() => {
    async function fetchAll() {
      try {
        const [w, d, h, l] = await Promise.all([
          fetch(BTC_WEEKLY).then((r) => r.json()),
          fetch(BTC_DAILY).then((r) => r.json()),
          fetch(BTC_HTF).then((r) => r.json()),
          fetch(BTC_LTF).then((r) => r.json()),
        ]);

        const wc = parseCandles(w);
        const dc = parseCandles(d);
        const hc = parseCandles(h);
        const lc = parseCandles(l);

        setWeekly(getBias(wc));
        setDaily(getBias(dc));
        setHtf(getBias(hc));
        setLtf(getBias(lc));

        setPrice(hc.at(-1).close.toFixed(2));
      } catch {
        setPrice("Error");
      }
    }

    fetchAll();
    const id = setInterval(fetchAll, 60000);
    return () => clearInterval(id);
  }, []);

  const confidence = confidenceScore(weekly, daily, htf, ltf);

  const aiConclusion =
    daily === "RANGE"
      ? "Price is inside daily equilibrium. Professionals wait for displacement."
      : daily === "BULLISH"
      ? "Bullish day. Look for liquidity sweep + bullish structure."
      : "Bearish day. Look for liquidity grab + bearish continuation.";

  /* ===============================
     UI
  ================================ */
  return (
    <div
      style={{
        background: "#0b0f1a",
        color: "white",
        minHeight: "100vh",
        padding: 20,
        fontFamily: "Arial",
      }}
    >
      <h1>AI Trading Dashboard</h1>

      <div className="card">BTCUSD: ${price}</div>
      <div className="card">Weekly Bias: {weekly}</div>
      <div className="card">Daily Bias: {daily}</div>
      <div className="card">HTF (15m): {htf}</div>
      <div className="card">LTF (5m): {ltf}</div>
      <div className="card">Market State: {marketState(htf)}</div>
      <div className="card">Confidence Score: {confidence}%</div>

      <h3>AI Conclusion</h3>
      <div className="card">{aiConclusion}</div>

      <h3>Ask AI</h3>

      <button
        onClick={() =>
          setAiAnswer(
            daily === "RANGE"
              ? "Best action today is WAIT. No displacement yet."
              : daily === "BULLISH"
              ? "Bias is bullish. Buy only after liquidity sweep and CHOCH."
              : "Bias is bearish. Sell rallies after BOS confirmation."
          )
        }
      >
        What should I do today?
      </button>

      <button
        onClick={() =>
          setAiAnswer(
            "Liquidity is likely above recent highs and below recent lows. Watch for stop hunts."
          )
        }
      >
        Where is liquidity?
      </button>

      <button
        onClick={() =>
          setAiAnswer(
            "You need displacement + BOS/CHOCH aligned with HTF before entry."
          )
        }
      >
        What confirmation is missing?
      </button>

      {aiAnswer && (
        <div className="card" style={{ marginTop: 16 }}>
          {aiAnswer}
        </div>
      )}
    </div>
  );
}