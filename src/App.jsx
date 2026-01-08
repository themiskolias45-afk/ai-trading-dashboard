import { useEffect, useState } from "react";

export default function App() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const BACKEND_URL = "https://tkai-backend.onrender.com/api/status";

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch(BACKEND_URL);
        const json = await res.json();
        setData(json);
      } catch (e) {
        setError("Backend not reachable");
      }
    };

    load();
    const interval = setInterval(load, 10000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div style={{
      background: "#0b0f1a",
      minHeight: "100vh",
      color: "#e5e7eb",
      padding: "20px",
      fontFamily: "Arial"
    }}>
      <h1 style={{ color: "#8b5cf6" }}>TKAI Dashboard</h1>

      {!data && !error && <p>Loading…</p>}
      {error && <p style={{ color: "red" }}>{error}</p>}

      {data && (
        <div style={{
          marginTop: "20px",
          padding: "20px",
          borderRadius: "10px",
          background: "#111827",
          maxWidth: "420px"
        }}>
          <p><b>Asset:</b> {data.asset}</p>
          <p><b>Direction:</b> {data.direction}</p>
          <p><b>Confidence:</b> {data.confidence}%</p>
          <p><b>Explanation:</b></p>
          <p style={{ opacity: 0.9 }}>{data.explanation}</p>
          <p style={{ fontSize: "12px", opacity: 0.6 }}>
            Last update: {new Date(data.time).toLocaleString()}
          </p>
        </div>
      )}
    </div>
  );
}