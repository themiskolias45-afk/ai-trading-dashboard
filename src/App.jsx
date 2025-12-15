import { useEffect, useState } from "react";

export default function App() {
  const [btc, setBtc] = useState("Loading BTC...");
  const [xau, setXau] = useState("Loading Gold...");

  useEffect(() => {
    async function fetchPrices() {
      try {
        const btcRes = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT");
        const btcData = await btcRes.json();

        const goldRes = await fetch("https://api.metals.live/v1/spot");
        const goldData = await goldRes.json();

        setBtc(`BTCUSD Price: $${Number(btcData.price).toFixed(2)}`);
        setXau(`XAUUSD Price: $${Number(goldData[0].gold).toFixed(2)}`);
      } catch (err) {
        setBtc("BTC error");
        setXau("Gold error");
      }
    }

    fetchPrices();
    const interval = setInterval(fetchPrices, 10000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div style={{ background: "#0f172a", color: "#e5e7eb", minHeight: "100vh", padding: 20 }}>
      <h1>AI Trading Dashboard</h1>
      <div style={{ marginTop: 16 }}>{btc}</div>
      <div style={{ marginTop: 8 }}>{xau}</div>
    </div>
  );
}
