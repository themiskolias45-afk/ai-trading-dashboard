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
      zone: `${z1.toFixed(0)} – ${z2.toFixed(0)}`,
      invalidation: low.toFixed(0),
      confirmation:
        "Wait for bullish reaction from the zone, higher low, or strong bullish candle.",
      explanation:
        "Market is in a higher-timeframe uptrend. Only look for long setups today."
    };
  }

  if (bias === "BEARISH") {
    const z1 = high - (high - low) * 0.4;
    const z2 = high - (high - low) * 0.25;

    return {
      price,
      bias,
      zone: `${z1.toFixed(0)} – ${z2.toFixed(0)}`,
      invalidation: high.toFixed(0),
      confirmation:
        "Wait for rejection from the zone, lower high, or strong bearish candle.",
      explanation:
        "Market is in a higher-timeframe downtrend. Only look for short setups today."
    };
  }

  return {
    price,
    bias: "RANGE",
    zone: "No trade zone",
    invalidation: "N/A",
    confirmation:
      "Wait for a clear break and structure shift before trading.",
    explanation:
      "Market is ranging. Probability is low. Best decision is to wait."
  };
}

/* ================== APP ================== */
export default function App() {
  const [data, setData] = useState([]);
  const [analysis, setAnalysis] = useState(null);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("Ask me about BTC today.");

  useEffect(() => {
    const fetchData = async () => {
      const res = await fetch(
        "https://min-api.cryptocompare.com/data/v2/histohour?fsym=BTC&tsym=USD&limit=120"
      );
      const json = await res.json();
      const d = json.Data.Data;
      setData(d);
      setAnalysis(buildAnalysis(d));
    };
    fetchData();
  }, []);

  const askAI = () => {
    if (!analysis) return;

    const q = question.toLowerCase();

    if (q.includes("bias") || q.includes("trend") || q.includes("long or short")) {
      setAnswer(
        `Bias: ${analysis.bias}\n\n${analysis.explanation}`
      );
    } else if (q.includes("best") || q.includes("price") || q.includes("zone")) {
      setAnswer(
        `Best zone today: ${analysis.zone}\nInvalidation: ${analysis.invalidation}`
      );
    } else if (q.includes("confirm")) {
      setAnswer(`Confirmation to enter:\n${analysis.confirmation}`);
    } else if (q.includes("trade now")) {
      setAnswer(
        analysis.bias === "RANGE"
          ? "No. Market is ranging. Waiting is the professional choice."
          : "Only trade if price reaches the zone and confirmation appears. Do not chase price."
      );
    } else {
      setAnswer(
        `BTCUSD Analysis\n\nBias: ${analysis.bias}\nZone: ${analysis.zone}\nConfirmation: ${analysis.confirmation}`
      );
    }
  };

  return (
    <div style={{ background: "#0b0f1a", color: "white", minHeight: "100vh", padding: 24 }}>
      <h1>AI Market Analyst</h1>

      {analysis && (
        <div style={{ marginBottom: 12 }}>
          BTCUSD: ${analysis.price}
        </div>
      )}

      <div style={{ background: "#111827", padding: 16, borderRadius: 10 }}>
        <input
          value={question}
          onChange={e => setQuestion(e.target.value)}
          placeholder="Ask: BTC today? Best price? Confirmation?"
          style={{
            width: "100%",
            padding: 10,
            marginBottom: 10,
            borderRadius: 6,
            border: "none"
          }}
        />
        <button
          onClick={askAI}
          style={{
            padding: "10px 16px",
            borderRadius: 6,
            border: "none",
            cursor: "pointer"
          }}
        >
          Ask
        </button>

        <pre style={{
          marginTop: 14,
          whiteSpace: "pre-wrap",
          fontSize: 14
        }}>
          {answer}
        </pre>
      </div>
    </div>
  );
}