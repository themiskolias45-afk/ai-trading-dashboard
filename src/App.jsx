import { useEffect, useState } from "react";

/* ================== MARKET LOGIC ================== */
function getHighLow(data, lookback = 96) {
  const slice = data.slice(-lookback);
  const high = Math.max(...slice.map(c => c.high));
  const low = Math.min(...slice.map(c => c.low));
  return { high, low };
}

function getBias(data) {
  if (data.length < 10) return "NO DATA";

  const highs = data.map(c => c.high);
  const lows = data.map(c => c.low);

  const hh = highs.at(-1) > highs.at(-5);
  const hl = lows.at(-1) > lows.at(-5);
  const lh = highs.at(-1) < highs.at(-5);
  const ll = lows.at(-1) < lows.at(-5);

  if (hh && hl) return "BULLISH";
  if (lh && ll) return "BEARISH";
  return "RANGE";
}

function buildAnalysis(data) {
  const price = data.at(-1).close;
  const bias = getBias(data);
  const { high, low } = getHighLow(data);

  if (bias === "BULLISH") {
    const z1 = low + (high - low) * 0.25;
    const z2 = low + (high - low) * 0.4;
    return {
      price,
      bias,
      zone: `${z1.toFixed(2)} – ${z2.toFixed(2)}`,
      invalidation: low.toFixed(2),
      confirmation: "Wait for bullish reaction, higher low, or strong bullish candle."
    };
  }

  if (bias === "BEARISH") {
    const z1 = high - (high - low) * 0.4;
    const z2 = high - (high - low) * 0.25;
    return {
      price,
      bias,
      zone: `${z1.toFixed(2)} – ${z2.toFixed(2)}`,
      invalidation: high.toFixed(2),
      confirmation: "Wait for rejection, lower high, or strong bearish candle."
    };
  }

  return {
    price,
    bias: "RANGE",
    zone: "No trade",
    invalidation: "N/A",
    confirmation: "Wait for clear structure break."
  };
}

/* ================== STORAGE ================== */
function loadJournal() {
  return JSON.parse(localStorage.getItem("ai_journal") || "[]");
}

function saveJournal(entries) {
  localStorage.setItem("ai_journal", JSON.stringify(entries));
}

/* ================== APP ================== */
export default function App() {
  const [asset, setAsset] = useState("BTC");
  const [analysis, setAnalysis] = useState(null);
  const [journal, setJournal] = useState(loadJournal());
  const [note, setNote] = useState("");

  useEffect(() => {
    const fetchData = async () => {
      const symbol = asset === "BTC" ? "BTC" : "XAU";
      const res = await fetch(
        `https://min-api.cryptocompare.com/data/v2/histohour?fsym=${symbol}&tsym=USD&limit=120`
      );
      const json = await res.json();
      setAnalysis(buildAnalysis(json.Data.Data));
    };
    fetchData();
  }, [asset]);

  const saveToday = () => {
    if (!analysis) return;

    const today = new Date().toISOString().slice(0, 10);
    const entry = {
      date: today,
      asset,
      ...analysis,
      note
    };

    const filtered = journal.filter(j => !(j.date === today && j.asset === asset));
    const updated = [entry, ...filtered];

    setJournal(updated);
    saveJournal(updated);
    setNote("");
  };

  return (
    <div style={{ background: "#0b0f1a", color: "white", minHeight: "100vh", padding: 24 }}>
      <h1>AI Market Analyst + Journal</h1>

      <div style={{ marginBottom: 12 }}>
        <button onClick={() => setAsset("BTC")}>BTC</button>{" "}
        <button onClick={() => setAsset("XAU")}>XAU</button>
      </div>

      {analysis && (
        <div style={{ background: "#111827", padding: 16, borderRadius: 10, marginBottom: 16 }}>
          <div><strong>Bias:</strong> {analysis.bias}</div>
          <div><strong>Zone:</strong> {analysis.zone}</div>
          <div><strong>Invalidation:</strong> {analysis.invalidation}</div>
          <div><strong>Confirmation:</strong> {analysis.confirmation}</div>

          <textarea
            placeholder="Your note (optional)…"
            value={note}
            onChange={e => setNote(e.target.value)}
            style={{ width: "100%", marginTop: 10 }}
          />

          <button onClick={saveToday} style={{ marginTop: 10 }}>
            Save Today’s Analysis
          </button>
        </div>
      )}

      <h2>Journal History</h2>

      {journal.length === 0 && <div>No entries yet.</div>}

      {journal.map((j, i) => (
        <div key={i} style={{ background: "#020617", padding: 12, marginBottom: 8 }}>
          <div><strong>{j.date} — {j.asset}</strong></div>
          <div>Bias: {j.bias}</div>
          <div>Zone: {j.zone}</div>
          {j.note && <div>Note: {j.note}</div>}
        </div>
      ))}
    </div>
  );
}