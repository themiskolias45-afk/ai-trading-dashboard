import { useEffect, useState } from "react";

export default function App() {
  const [btc, setBtc] = useState("Loading...");
  const [error, setError] = useState(false);

  useEffect(() => {
    fetch("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT")
      .then(res => res.json())
      .then(data => {
        setBtc(`BTCUSD price: $${Number(data.price).toFixed(2)}`);
      })
      .catch(() => {
        setError(true);
      });
  }, []);

  return (
    <div
      style={{
        background: "#0b0f1a",
        color: "white",
        minHeight: "100vh",
        padding: "20px",
        fontFamily: "Arial"
      }}
    >
      <h1>AI Trading Dashboard</h1>

      <div style={{ marginTop: "20px" }}>
        {error ? "BTC error" : btc}
      </div>
    </div>
  );
}
