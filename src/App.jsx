import { useEffect, useState } from "react";

/* =======================
   SIMPLE SMC ENGINE
   ======================= */

// ---- Helpers ----
function getBias(candles) {
  if (candles.length < 20) return "NO DATA";

  const last = candles.at(-1);
  const prev = candles.at(-10);

  if (last.close > prev.close) return "BULLISH";
  if (last.close < prev.close) return "BEARISH";
  return "RANGE";
}

function getBOS(candles) {
  if (candles.length < 20) return null;

  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);

  const lastHigh = highs.at(-1);
  const lastLow = lows.at(-1);

  const prevHigh = Math.max(...highs.slice(-10, -1));
  const prevLow = Math.min(...lows.slice(-10, -1));

  if (lastHigh > prevHigh) return "BULLISH";
  if (lastLow < prevLow) return "BEARISH";
  return null;
}

function getFVG(candles) {
  if (candles.length < 3) return null;

  const a = candles.at(-3);
  const b = candles.at(-2);
  const c = candles.at(-1);

  // bullish imbalance
  if (a.high < c.low) return "BULLISH";

  // bearish imbalance
  if (a.low > c.high) return "BEARISH";

  return null;
}

function getFinalSignal({ bias, bos, fvg }) {
  if (bias === "BULLISH" && bos === "BULLISH" && fvg === "BULLISH") {
    return "BUY";
  }
  if (bias === "BEARISH" && bos === "BEARISH" && fvg === "BEARISH") {
    return "SELL";
  }
  return "WAIT";
}

/* =======================
   APP
   ======================= */

export default function App() {
  const [price, setPrice] = useState(null);
  const [candles, setCandles] = useState([]);
  const [error, setError] = useState(null);

  // ---- Fetch BTC candles ----
  useEffect(() => {
    async function fetchData() {
      try {
        const res = await fetch(
          "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=15m&limit=100"
        );
        const data = await res.json();

        const parsed = data.map(c => ({
          open: +c[1],
          high: +c[2],
          low: +c[3],
          close: +c[4],
        }));

        setCandles(parsed);
        setPrice(parsed.at(-1).close.toFixed(2));
        setError(null);
      } catch (e) {
        setError("DATA ERROR");
      }
    }

    fetchData();
    const id = setInterval(fetchData, 60_000);
    return () => clearInterval(id);
  }, []);

  // ---- SMC Logic ----
  const bias = getBias(candles);
  const bos = getBOS(candles);
  const fvg = getFVG(candles);
  const signal = getFinalSignal({ bias, bos, fvg });

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#0b1020",
        color: "white",
        padding: "24px",
        fontFamily: "Arial",
      }}
    >
      <h1>AI Trading Dashboard</h1>

      {error && <p style={{ color: "red" }}>{error}</p>}

      {price && (
        <>
          <p><b>BTCUSD:</b> ${price}</p>
          <p><b>HTF Bias:</b> {bias}</p>
          <p><b>BOS:</b> {bos || "None"}</p>
          <p><b>FVG:</b> {fvg || "None"}</p>

          <h2
            style={{
              marginTop: "20px",
              color:
                signal === "BUY"
                  ? "lime"
                  : signal === "SELL"
                  ? "red"
                  : "gray",
            }}
          >
            FINAL SIGNAL: {signal}
          </h2>
        </>
      )}
    </div>
  );
}