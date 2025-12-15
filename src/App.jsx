import { useEffect, useState } from "react";

export default function App() {
  const [btc, setBtc] = useState("Loading BTC...");
  const [signal, setSignal] = useState("Waiting for signal...");

  useEffect(() => {
    fetch("https://min-api.cryptocompare.com/data/price?fsym=BTC&tsyms=USD")
      .then(res => res.json())
      .then(data => {
        const price = Number(data.USD);
        setBtc(`BTCUSD price: $${price}`);

        // SIMPLE SIGNAL LOGIC (example)
        if (price > 90000) {
          setSignal("SELL ➜ TP: 88000 | SL: 91000");
        } else {
          setSignal("BUY ➜ TP: 92000 | SL: 88000");
        }
      })
      .catch(() => {
        setBtc("BTC error");
        setSignal("Signal error");
      });
  }, []);

  return (
    <div
      style={{
        background: "#0b0f1a",
        color: "white",
        minHeight: "100vh",
        padding: "24px",
        fontFamily: "Arial"
      }}
    >
      <h1>AI Trading Dashboard</h1>

      <div style={{ marginTop: "20px", fontSize: "18px" }}>{btc}</div>
      <div style={{ marginTop: "10px", fontSize: "18px" }}>{signal}</div>
    </div>
  );
}
