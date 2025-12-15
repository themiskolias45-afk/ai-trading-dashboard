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
    <div style={{ background: "#0f172a", color: "#e5e7eb", minHeight: "100vh", padding: 20 }}>
      <h1>AI Trading Dashboard</h1>
      <div style={{ marginTop: 16 }}>{btc}</div>
      <div style={{ marginTop: 8 }}>{xau}</div>
    </div>
  );
}
