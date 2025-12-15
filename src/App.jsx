import { useEffect, useState } from "react";

export default function App() {
  const [price, setPrice] = useState(null);
  const [signal, setSignal] = useState(null);

  useEffect(() => {
    const fetchBTC = () => {
      fetch("https://min-api.cryptocompare.com/data/price?fsym=BTC&tsyms=USD")
        .then(res => res.json())
        .then(data => {
          const p = Number(data.USD);
          setPrice(p);

          if (p > 90000) {
            setSignal({
              direction: "SELL",
              entry: p,
              tp1: p - 1500,
              tp2: p - 3000,
              sl: p + 1200
            });
          } else {
            setSignal({
              direction: "BUY",
              entry: p,
              tp1: p + 1500,
              tp2: p + 3000,
              sl: p - 1200
            });
          }
        });
    };

    fetchBTC();
    const interval = setInterval(fetchBTC, 15000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div style={{ background: "#0b0f1a", color: "white", minHeight: "100vh", padding: 24 }}>
      <h1>AI Trading Dashboard</h1>

      {price && (
        <div style={{ marginTop: 16 }}>
          <strong>BTCUSD:</strong> ${price}
        </div>
      )}

      {signal && (
        <div style={{ marginTop: 20, background: "#111827", padding: 16, borderRadius: 10 }}>
          <div><strong>Signal:</strong> {signal.direction}</div>
          <div>Entry: {signal.entry}</div>
          <div>TP1: {signal.tp1}</div>
          <div>TP2: {signal.tp2}</div>
          <div>SL: {signal.sl}</div>
        </div>
      )}
    </div>
  );
}
