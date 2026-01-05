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
      confirmation:
        "Wait for bullish reaction from the zone, higher low, or strong bullish candle.",
      explanation:
        "Higher-timeframe structure is bullish. Focus only on long setups."
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
      confirmation:
        "Wait for rejection from the zone, lower high, or strong bearish candle.",
      explanation:
        "Higher-timeframe structure is bearish. Focus only on short setups."
    };
  }

  return {
    price,
    bias: "RANGE",
    zone: "No trade zone",
    invalidation: "N/A",
    confirmation:
      "Wait for clear break and structure shift.",
    explanation:
      "Market is ranging. Best decision is patience."
  };
}

/* ================== APP ================== */
export default function App() {
  const [asset, setAsset] = useState("BTC");
  const [analysis, setAnalysis] = useState(null);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("Ask me about BTC or Gold.");

  useEffect(() => {
    const fetchData = async () => {
      const symbol =
        asset === "BTC"
          ? "BTC"
          : "XAU";

      const res = await fetch(
        `https://min-api.cryptocompare.com/data/v2/histohour?fsym=${symbol}&tsym=USD&limit=120`
      );
      const json = await res.json();
      const data = json.Data.Data;
      setAnalysis(buildAnalysis(data));
    };

    fetchData();
  }, [asset]);

  const askAI = () => {
    if (!analysis) return;

    const q = question.toLowerCase();

    if (q.includes("bias") || q.includes("trend") || q.includes("long or short")) {
      setAnswer(`Bias: ${analysis.bias}\n\n${analysis.explanation}`);
    } else if (q.includes("best") || q.includes("price") || q.includes("zone")) {
      setAnswer(`Best zone: ${analysis.zone}\nInvalidation: ${analysis.invalidation}`);
    } else if (q.includes("confirm")) {
      setAnswer(`Confirmation:\n${analysis.confirmation}`);
    } else {
      setAnswer(
        `${asset} Analysis\n\nBias: ${analysis.bias}\nZone: ${analysis.zone}\nConfirmation: ${analysis.confirmation}`
      );
    }
  };

  return (
    <div style={{ background: "#0b0f1a", color: "white", minHeight: "100vh", padding: 24 }}>
      <h1>AI Market Analyst</h1>

      <div style={{ marginBottom: 12 }}>
        <button onClick={() => setAsset("BTC")}>BTC</button>{" "}
        <button onClick={() => setAsset("XAU")}>XAU</button>
      </div>

      {analysis && (
        <div style={{ marginBottom: 12 }}>
          {asset}USD Price: ${analysis.price}
        </div>
      )}

      <div style={{ background: "#111827", padding: 16, borderRadius: 10 }}>
        <input
          value={question}
          onChange={e => setQuestion(e.target.value)}
          placeholder={`Ask about ${asset}...`}
          style={{ width: "100%", padding: 10, marginBottom: 10 }}
        />
        <button onClick={askAI}>Ask</button>

        <pre style={{ marginTop: 14, whiteSpace: "pre-wrap" }}>
          {answer}
        </pre>
      </div>
    </div>
  );
}