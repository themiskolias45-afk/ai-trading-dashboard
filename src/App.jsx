import { useEffect, useState } from "react";

export default function App() {
  const [btcPrice, setBtcPrice] = useState("-");
  const [goldPrice, setGoldPrice] = useState("-");
  const [status, setStatus] = useState("Loading market data…");

  useEffect(() => {
    async function load() {
      try {
        const btc = await fetch(
          "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT"
        ).then(r => r.json());

        const gold = await fetch(
          "https://api.binance.com/api/v3/ticker/price?symbol=PAXGUSDT"
        ).then(r => r.json());

        setBtcPrice(Number(btc.price).toFixed(2));
        setGoldPrice(Number(gold.price).toFixed(2));
        setStatus("Market data live");
      } catch (e) {
        setStatus("Error loading data");
      }
    }

    load();
    const i = setInterval(load, 60000);
    return () => clearInterval(i);
  }, []);

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#0b1220",
        color: "#eaeaea",
        padding: 24,
        fontFamily: "Arial"
      }}
    >
      <h1>TKAI — Trading Dashboard</h1>

      <p>Status: {status}</p>

      <hr />

      <h2>BTCUSD</h2>
      <p>Price: ${btcPrice}</p>

      <hr />

      <h2>Gold (PAXG)</h2>
      <p>Price: ${goldPrice}</p>

      <hr />

      <p>
        Dashboard is stable.<br />
        Analysis & alerts handled by backend.
      </p>
    </div>
  );
}