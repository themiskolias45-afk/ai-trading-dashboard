import { useEffect, useState } from "react";

export default function App() {
  const [btc, setBtc] = useState("Loading BTC...");
  const [xau, setXau] = useState("Loading XAU...");
  const [btcError, setBtcError] = useState(false);
  const [xauError, setXauError] = useState(false);

  useEffect(() => {
    // ======================
    // BTC PRICE (CryptoCompare)
    // ======================
    fetch("https://min-api.cryptocompare.com/data/price?fsym=BTC&tsyms=USD")
      .then(res => res.json())
      .then(data => {
        if (!data.USD) throw new Error();
        setBtc(`BTCUSD price: $${data.USD}`);
      })
      .catch(() => setBtcError(true));

    // ======================
    // XAU PRICE (Metals.live)
    // ======================
    fetch("https://api.metals.live/v1/spot")
      .then(res => res.json())
      .then(data => {
        if (!data[0]?.gold) throw new Error();
        setXau(`XAUUSD price: $${data[0].gold}`);
      })
      .catch(() => setXauError(true));
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
      <h1 style={{ marginBottom: "24px" }}>AI Trading Dashboard</h1>

      <div
        style={{
          background: "#111827",
          padding: "16px",
          borderRadius: "10px",
          marginBottom: "16px"
        }}
      >
        {btcError ? "BTC error" : btc}
      </div>

      <div
        style={{
          background: "#111827",
          padding: "16px",
          borderRadius: "10px"
        }}
      >
        {xauError ? "XAU error" : xau}
      </div>
    </div>
  );
}
