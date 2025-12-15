import { useEffect, useState } from "react";

export default function App() {
  const [btc, setBtc] = useState("Waiting for data...");
  const [xau, setXau] = useState("Waiting for data...");

  useEffect(() => {
    setTimeout(() => {
      setBtc("BTCUSD ➜ BUY @ 42,350 | TP1 42,800 | SL 42,000");
      setXau("XAUUSD ➜ SELL @ 2034 | TP1 2022 | SL 2040");
    }, 1500);
  }, []);

  return (
    <div
      style={{
        background: "#0b0f1a",
        color: "white",
        minHeight: "100vh",
        padding: "20px",
        fontFamily: "Arial",
      }}
    >
      <h1>AI Trading Dashboard</h1>

      <div style={{ marginTop: "20px", padding: "15px", background: "#111827", borderRadius: "8px" }}>
        {btc}
      </div>

      <div style={{ marginTop: "10px", padding: "15px", background: "#111827", borderRadius: "8px" }}>
        {xau}
      </div>
    </div>
  );
}
