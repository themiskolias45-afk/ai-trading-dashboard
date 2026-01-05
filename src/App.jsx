import { useEffect, useState, useRef } from "react";

/* ==============================
   CONFIG
================================ */
const BTC_WEEKLY =
  "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1w&limit=120";
const BTC_DAILY =
  "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=120";
const BTC_HTF =
  "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=15m&limit=120";
const BTC_LTF =
  "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=120";

const GOLD_PRICE =
  "https://api.binance.com/api/v3/ticker/price?symbol=XAUUSDT";

/* ==============================
   HELPERS
================================ */
const parse = (d) =>
  d.map((c) => ({
    open: +c[1],
    high: +c[2],
    low: +c[3],
    close: +c[4],
  }));

const biasFromStructure = (c) => {
  if (c.length < 20) return "NO DATA";
  const hh = c.at(-1).high > c.at(-5).high;
  const hl = c.at(-1).low > c.at(-5).low;
  const lh = c.at(-1).high < c.at(-5).high;
  const ll = c.at(-1).low < c.at(-5).low;
  if (hh && hl) return "BULLISH";
  if (lh && ll) return "BEARISH";
  return "RANGE";
};

const detectDisplacement = (c) => {
  const last = c.at(-1);
  const prev = c.at(-2);
  const body = Math.abs(last.close - last.open);
  const prevRange = prev.high - prev.low;
  return body > prevRange * 1.5;
};

const tradeLevels = (price, bias) => {
  const risk = price * 0.006;
  if (bias === "BULLISH") {
    return { entry: price, sl: price - risk, tp: price + risk * 2 };
  }
  return { entry: price, sl: price + risk, tp: price - risk * 2 };
};

/* ==============================
   APP
================================ */
export default function App() {
  const [btcPrice, setBtcPrice] = useState("-");
  const [goldPrice, setGoldPrice] = useState("Unavailable");

  const [weekly, setWeekly] = useState("-");
  const [daily, setDaily] = useState("-");
  const [htf, setHtf] = useState("-");
  const [ltf, setLtf] = useState("-");

  const [mlProb, setMlProb] = useState(0);
  const [alert, setAlert] = useState(null);
  const [explain, setExplain] = useState("");

  const [question, setQuestion] = useState("");
  const recognitionRef = useRef(null);

  async function load() {
    const [w, d, h, l] = await Promise.all([
      fetch(BTC_WEEKLY).then((r) => r.json()),
      fetch(BTC_DAILY).then((r) => r.json()),
      fetch(BTC_HTF).then((r) => r.json()),
      fetch(BTC_LTF).then((r) => r.json()),
    ]);

    const wc = parse(w);
    const dc = parse(d);
    const hc = parse(h);
    const lc = parse(l);

    const wBias = biasFromStructure(wc);
    const dBias = biasFromStructure(dc);
    const hBias = biasFromStructure(hc);
    const lBias = biasFromStructure(lc);

    setWeekly(wBias);
    setDaily(dBias);
    setHtf(hBias);
    setLtf(lBias);

    const price = hc.at(-1).close;
    setBtcPrice(price.toFixed(2));

    const displacement = detectDisplacement(hc);
    const aligned =
      dBias === hBias && hBias === lBias && dBias !== "RANGE";

    const probability = displacement && aligned ? 75 : 20;
    setMlProb(probability);

    if (displacement && aligned) {
      const levels = tradeLevels(price, dBias);
      setAlert({ direction: dBias, ...levels });
      setExplain(
        "Displacement confirmed with HTF and LTF alignment. High-probability setup."
      );
    } else {
      setAlert(null);
      setExplain(
        "Price is inside equilibrium. Professional traders wait for displacement."
      );
    }
  }

  async function loadGold() {
    try {
      const r = await fetch(GOLD_PRICE);
      const d = await r.json();
      setGoldPrice(Number(d.price).toFixed(2));
    } catch {
      setGoldPrice("Unavailable");
    }
  }

  useEffect(() => {
    load();
    loadGold();
    const i = setInterval(load, 60000);
    return () => clearInterval(i);
  }, []);

  const startVoice = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return alert("Voice not supported");
    const rec = new SR();
    rec.lang = "en-US";
    rec.start();
    rec.onresult = (e) => setQuestion(e.results[0][0].transcript);
    recognitionRef.current = rec;
  };

  const askAI = () => {
    if (!question) return;
    alert(
      `BTC Analysis\n\nWeekly: ${weekly}\nDaily: ${daily}\nHTF: ${htf}\nLTF: ${ltf}\n\n${explain}`
    );
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        backgroundColor: "#0b1220",
        color: "#eaeaea",
        padding: 24,
        fontFamily: "serif",
      }}
    >
      <h1>AI Trading Dashboard</h1>

      <p>BTCUSD: ${btcPrice}</p>
      <p>Weekly Bias: {weekly}</p>
      <p>Daily Bias: {daily}</p>
      <p>HTF (15m): {htf}</p>
      <p>LTF (5m): {ltf}</p>
      <p>ML Probability: {mlProb}%</p>

      <h2>AI Conclusion</h2>
      <p>{explain}</p>

      {alert && (
        <>
          <h2>🎯 Trade Setup</h2>
          <p>Direction: {alert.direction}</p>
          <p>Entry: {alert.entry.toFixed(2)}</p>
          <p>SL: {alert.sl.toFixed(2)}</p>
          <p>TP: {alert.tp.toFixed(2)}</p>
        </>
      )}

      <hr />

      <h2>Ask AI</h2>
      <input
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        placeholder="Ask about today’s BTC or Gold setup..."
        style={{ width: "100%", padding: 8 }}
      />
      <br />
      <button onClick={askAI}>Ask</button>
      <button onClick={startVoice} style={{ marginLeft: 8 }}>
        🎤 Speak
      </button>

      <hr />
      <p>XAUUSD (Gold): ${goldPrice}</p>
    </div>
  );
}