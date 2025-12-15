import { useEffect, useState } from "react";

/* ===== Helpers ===== */
function calculateRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
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

function calculateEMA(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

/* ===== App ===== */
export default function App() {
  const [price, setPrice] = useState(null);
  const [rsi, setRsi] = useState(null);
  const [ema20, setEma20] = useState(null);
  const [ema50, setEma50] = useState(null);
  const [signal, setSignal] = useState(null);

  useEffect(() => {
    const fetchBTC = async () => {
      try {
        const res = await fetch(
          "https://min-api.cryptocompare.com/data/v2/histominute?fsym=BTC&tsym=USD&limit=120"
        );
        const json = await res.json();
        const closes = json.Data.Data.map(c => c.close);

        const lastPrice = closes[closes.length - 1];
        const rsiVal = calculateRSI(closes);
        const e20 = calculateEMA(closes, 20);
        const e50 = calculateEMA(closes, 50);

        setPrice(lastPrice);
        setRsi(rsiVal?.toFixed(2));
        setEma20(e20?.toFixed(2));
        setEma50(e50?.toFixed(2));

        // ===== TREND + DISTANCE FILTER =====
        const uptrend = e20 && e50 && e20 > e50;
        const downtrend = e20 && e50 && e20 < e50;
        const emaDistance = Math.abs(e20 - e50);

        if (rsiVal !== null && emaDistance > 50) {
          if (rsiVal < 40 && uptrend) {
            setSignal({
              direction: "BUY",
              entry: lastPrice,
              tp1: lastPrice + 1200,
              tp2: lastPrice + 2500,
              sl: lastPrice - 900
            });
          } else if (rsiVal > 60 && downtrend) {
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
        } else {
          setSignal(null);
        }
      } catch (e) {
        console.error(e);
      }
    };

    fetchBTC();
    const interval = setInterval(fetchBTC, 60000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div style={{ background: "#0b0f1a", color: "white", minHeight: "100vh", padding: 24 }}>
      <h1>AI Trading Dashboard</h1>

      {price && <div><strong>BTCUSD:</strong> ${price}</div>}
      {rsi && <div><strong>RSI(14):</strong> {rsi}</div>}
      {ema20 && <div><strong>EMA20:</strong> {ema20}</div>}
      {ema50 && <div><strong>EMA50:</strong> {ema50}</div>}

      {signal ? (
        <div style={{ marginTop: 16, background: "#111827", padding: 16, borderRadius: 10 }}>
          <div><strong>Signal:</strong> {signal.direction}</div>
          <div>Entry: {signal.entry}</div>
          <div>TP1: {signal.tp1}</div>
          <div>TP2: {signal.tp2}</div>
          <div>SL: {signal.sl}</div>
        </div>
      ) : (
        <div style={{ marginTop: 16, color: "#9ca3af" }}>
          No valid signal (tuned filters)
        </div>
      )}
    </div>
  );
}
