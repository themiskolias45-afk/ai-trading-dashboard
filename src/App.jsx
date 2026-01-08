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

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#0b0f1a",
        color: "#fff",
        padding: "24px",
        fontFamily: "Arial",
      }}
    >
      <h1 style={{ color: "#8b5cf6" }}>TKAI Dashboard</h1>

      {error && <p style={{ color: "red" }}>Error: {error}</p>}

      {!data && !error && <p>Loading...</p>}

      {data && (
        <>
          <p>Status: {data.status}</p>
          <p>BTC Price: ${data.btc}</p>
          <p>Gold Price: ${data.gold}</p>
          <p>Last Update: {data.updated}</p>
        </>
      )}
    </div>
  );
}