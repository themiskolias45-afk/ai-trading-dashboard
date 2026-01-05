import { useEffect, useState } from "react";

/* =========================
   CONFIG
========================= */
const BTC_WEEKLY =
  "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1w&limit=120";
const BTC_DAILY =
  "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=120";
const BTC_HTF =
  "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=15m&limit=120";
const BTC_LTF =
  "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=120";

/* =========================
   HELPERS
========================= */
const mapCandle = (c) => ({
  open: +c[1],
  high: +c[2],
  low: +c[3],
  close: +c[4],
});

function bias(candles) {
  if (candles.length < 10) return "NO DATA";
  const last = candles.at(-1);
  const prev = candles.at(-5);
  if (last.close > prev.high) return "BULLISH";
  if (last.close < prev.low) return "BEARISH";
  return "RANGE";
}

function equilibrium(candles) {
  const h = Math.max(...candles.map((c) => c.high));
  const l = Math.min(...candles.map((c) => c.low));
  return (h + l) / 2;
}

function displacement(candles) {
  const last = candles.at(-1);
  const prev = candles.at(-2);
  return Math.abs(last.close - prev.close) > (prev.high - prev.low) * 1.5;
}

/* =========================
   ML PROBABILITY (RULE-BASED)
========================= */
function probability({ w, d, h, l, disp }) {
  let score = 0;
  if (w === d) score += 25;
  if (d === h) score += 25;
  if (h === l) score += 20;
  if (disp) score += 30;
  return Math.min(score, 100);
}

/* =========================
   AI EXPLANATION ENGINE
========================= */
function aiExplain(state) {
  const { weekly, daily, htf, ltf, prob, disp } = state;

  if (!disp)
    return "Price is inside equilibrium. Professional traders wait for displacement.";

  if (prob < 60)
    return "Structure exists but probability is low. No professional entry.";

  return `Displacement confirmed with multi-timeframe alignment.
Weekly: ${weekly}, Daily: ${daily}, HTF: ${htf}, LTF: ${ltf}.
Probability ${prob}%. Entry allowed.`;
}

/* =========================
   MAIN APP
========================= */
export default function App() {
  const [price, setPrice] = useState(null);
  const [state, setState] = useState({});
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");

  useEffect(() => {
    async function load() {
      const [w, d, h, l] = await Promise.all([
        fetch(BTC_WEEKLY).then((r) => r.json()),
        fetch(BTC_DAILY).then((r) => r.json()),
        fetch(BTC_HTF).then((r) => r.json()),
        fetch(BTC_LTF).then((r) => r.json()),
      ]);

      const wc = w.map(mapCandle);
      const dc = d.map(mapCandle);
      const hc = h.map(mapCandle);
      const lc = l.map(mapCandle);

      const disp = displacement(hc);
      const prob = probability({
        w: bias(wc),
        d: bias(dc),
        h: bias(hc),
        l: bias(lc),
        disp,
      });

      setPrice(hc.at(-1).close);
      setState({
        weekly: bias(wc),
        daily: bias(dc),
        htf: bias(hc),
        ltf: bias(lc),
        prob,
        disp,
        eq: equilibrium(dc),
      });
    }

    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, []);

  function askAI() {
    setAnswer(aiExplain(state));
  }

  return (
    <div style={{ padding: 24, color: "#fff", background: "#0b1220", minHeight: "100vh" }}>
      <h1>AI Trading Dashboard</h1>

      <div>BTCUSD: ${price}</div>
      <div>Weekly Bias: {state.weekly}</div>
      <div>Daily Bias: {state.daily}</div>
      <div>HTF (15m): {state.htf}</div>
      <div>LTF (5m): {state.ltf}</div>
      <div>ML Probability: {state.prob}%</div>

      <h3>AI Conclusion</h3>
      <p>{aiExplain(state)}</p>

      <h3>Ask AI</h3>
      <input
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        placeholder="Ask about today’s BTC price, entry, confirmation..."
        style={{ width: "100%", padding: 8 }}
      />
      <button onClick={askAI} style={{ marginTop: 8 }}>
        Ask
      </button>

      {answer && (
        <>
          <h4>AI Answer</h4>
          <p>{answer}</p>
        </>
      )}
    </div>
  );
}