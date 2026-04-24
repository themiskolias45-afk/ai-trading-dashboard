import { useEffect, useState } from "react";

export default function App() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const BACKEND_URL = "https://tkai-backend.onrender.com/api/status";

  useEffect(() => {
    fetch(BACKEND_URL)
      .then((res) => {
        if (!res.ok) {
          throw new Error("Backend not responding");
        }
        return res.json();
      })
      .then((json) => {
        setData(json);
      })
      .catch((err) => {
        setError(err.message);
      });
  }, []);

  const biasLabel = () => {
    const c = data?.btcChange ?? 0;
    if (c > 2)  return { text: "STRONG BUY",  color: "#22c55e" };
    if (c > 0)  return { text: "BULLISH",     color: "#22c55e" };
    if (c < -2) return { text: "STRONG SELL", color: "#ef4444" };
    if (c < 0)  return { text: "BEARISH",     color: "#ef4444" };
    return { text: "NEUTRAL", color: "#94a3b8" };
  };

  const bias = biasLabel();

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#0b0f1a",
        color: "#e2e8f0",
        padding: "32px 16px",
        fontFamily: "'Segoe UI', Arial, sans-serif",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
      }}
    >
      <div style={{ width: "100%", maxWidth: 720, marginBottom: 32, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1 style={{ color: "#8b5cf6", fontSize: "1.6rem" }}>SmartEntry</h1>
        <span style={{ color: "#4a5568", fontSize: "0.75rem" }}>v7</span>
      </div>

      {error && <p style={{ color: "#ef4444", fontSize: "0.85rem" }}>Error: {error}</p>}
      {!data && !error && <p style={{ color: "#64748b" }}>Loading…</p>}

      {data && (
        <div style={{ width: "100%", maxWidth: 720, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 16 }}>
          {[
            { label: "BTC Price",  value: data.btc  != null ? `$${Number(data.btc).toLocaleString()}` : "N/A", sub: `${data.btcChange >= 0 ? "+" : ""}${(data.btcChange ?? 0).toFixed(2)}% (24h)`, subColor: data.btcChange >= 0 ? "#22c55e" : "#ef4444" },
            { label: "Gold Price", value: data.gold != null ? `$${Number(data.gold).toLocaleString()}` : "N/A", sub: "per troy oz" },
            { label: "BTC Bias",   value: bias.text, valueColor: bias.color, sub: "24h momentum" },
          ].map(({ label, value, valueColor, sub, subColor }) => (
            <div key={label} style={{ background: "#151c2c", border: "1px solid #1e293b", borderRadius: 12, padding: "20px 24px" }}>
              <div style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.08em", color: "#64748b", marginBottom: 8 }}>{label}</div>
              <div style={{ fontSize: "1.5rem", fontWeight: 700, color: valueColor ?? "#f1f5f9" }}>{value}</div>
              <div style={{ fontSize: "0.8rem", color: subColor ?? "#64748b", marginTop: 4 }}>{sub}</div>
            </div>
          ))}
        </div>
      )}

      {data && (
        <div style={{ width: "100%", maxWidth: 720, marginTop: 16, background: "#151c2c", border: "1px solid #1e293b", borderRadius: 10, padding: "10px 16px", display: "flex", justifyContent: "space-between", fontSize: "0.78rem", color: "#64748b" }}>
          <span>
            <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: "#22c55e", marginRight: 6, verticalAlign: "middle" }} />
            Online
          </span>
          <span>Updated {data.updated ? new Date(data.updated).toLocaleTimeString() : "—"}</span>
        </div>
      )}
    </div>
  );
}