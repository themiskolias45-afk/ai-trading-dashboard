import { useEffect, useState } from "react";

/**
 * Simple RSI calculation (period = 14)
 */
function calculateRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;

  let gains = 0;
  let losses = 0;

  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export default function App() {
  const [price, setPrice] = useState(null);
  const [signal, setSignal] = useState(null);
  const [rsi, setRsi] = useState(null);

  useEffect(() => {
    const fetchBTC = async () => {
      try {
        // Get last 100 1m candles
        const res = await fetch(
          "https://min-api.cryptocompare.com/data/v2/histominute?fsym=BTC&tsym=USD&limit=100"
        );
        const json = await res.json();
        const closes = json.Data.Data.map(c => c.close);

        const lastPrice = closes[closes.length - 1];
        const rsiValue = calculateRSI(closes);

        setPrice(lastPrice);
        setRsi(rsiValue?.toFixed(2));

        // === TREND FILTER (simple) ===
        const trendUp = closes[closes.length - 1] > closes[closes.length - 20];

        // === SIGNAL LOGIC ===
        if (rsiValue !== null) {
          if (rsiValue < 30 && trendUp) {
            setSignal({
              direction: "BUY",
              entry: lastPrice,
              tp1: lastPrice + 1200,
              tp2: lastPrice + 2500,
              sl: lastPrice - 900
            });
          } else if (rsiValue > 70 && !trendUp) {
            setSignal({
              direction: "SELL",
              entry: lastPrice,
              tp1: lastPrice - 1200,
              tp2: lastPrice - 2500,
              sl: lastPrice + 900
            });
          } else {
            setSignal(null);
          }
        }
      } catch (e) {
        console.error(e);
      }
    };

    fetchBTC();
    const interval = setInterval(fetchBTC, 60000); // every 1 minute
    return () => clearInterval(interval);
  }, []);

  return (
    <div style={{ background: "#0b0f1a", color: "white", minHeight: "100vh", padding: 24 }}>
      <h1>AI Trading Dashboard</h1>

      {price && (
        <div style={{ marginTop: 12 }}>
          <strong>BTCUSD:</strong> ${price}
        </div>
      )}

      {rsi && (
        <div style={{ marginTop: 6 }}>
          <strong>RSI(14):</strong> {rsi}
        </div>
      )}

      {signal ? (
        <div style={{ marginTop: 20, background: "#111827", padding: 16, borderRadius: 10 }}>
          <div><strong>Signal:</strong> {signal.direction}</div>
          <div>Entry: {signal.entry}</div>
          <div>TP1: {signal.tp1}</div>
          <div>TP2: {signal.tp2}</div>
          <div>SL: {signal.sl}</div>
        </div>
      ) : (
        <div style={{ marginTop: 20, color: "#9ca3af" }}>
          No valid signal (waiting for RSI + trend confirmation)
        </div>
      )}
    </div>
  );
}
