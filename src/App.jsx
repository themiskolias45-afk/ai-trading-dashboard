import { useEffect, useState } from "react";

export default function App() {
  const [btc, setBtc] = useState("Loading BTC price...");
  const [xau, setXau] = useState("Loading XAU price...");
  const [btcError, setBtcError] = useState(false);
  const [xauError, setXauError] = useState(false);

  useEffect(() => {
    // BTC
    fetch("https://min-api.cryptocompare.com/data/price?fsym=BTC&tsyms=USD")
      .then(res => res.json())
      .then(data => {
        if (!data.USD) throw new Error();
        setBtc(`BTCUSD price: $${data.USD}`);
      })
      .catch(() => setBtcError(true));

    // GOLD (XAU)
    fetch("https://min-api.cryptocompare.com/data/price?fsym=XAU&tsyms=USD")
      .then(res => res.json())
      .then(data => {
        if (!data.USD) throw new Error();
        setXau(`XAUUSD price: $${data.USD}`);
      })
      .catch(() => setXauError(true));
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

      <div style={{ marginTop: "20px", fontSize: "18px" }}>
        {btcError ? "BTC error" : btc}
      </div>

      <div style={{ marginTop: "12px", fontSize: "18px" }}>
        {xauError ? "XAU error" : xau}
      </div>
    </div>
  );
}
