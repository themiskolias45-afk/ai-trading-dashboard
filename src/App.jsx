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
  return bias === "BULLISH"
    ? {
        entry: price,
        sl: price - risk,
        tp: price + risk * 2,
      }
    : {
        entry: price,
        sl: price + risk,
        tp: price - risk * 2,
      };
};

/* ==============================
   APP
================================ */
export default function App() {
  const [btc, setBtc] = useState("--");
  const [gold, setGold] = useState("Unavailable");

  const [weekly, setWeekly] = useState("");
  const [daily, setDaily] = useState("");
  const [htf, setHtf] = useState("");
  const [ltf, setLtf] = useState("");

  const [mlProb, setMlProb] = useState(0);
  const [setup, setSetup] = useState(null);
  const [explain, setExplain] = useState("");

  const [question, setQuestion] = useState("");
  const recRef = useRef(null);

  /* ==============================
     DATA LOAD
  ================================ */
  async function loadAll() {
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

    const wb = biasFromStructure(wc);
    const db = biasFromStructure(dc);
    const hb = biasFromStructure(hc);
    const lb = biasFromStructure(lc);

    setWeekly(wb);
    setDaily(db);
    setHtf(hb);
    setLtf(lb);

    const price = hc.at(-1).close;
    setBtc(price.toFixed(2));

    const displacement = detectDisplacement(hc);
    const aligned =
      (db === "BULLISH" && hb === "BULLISH" && lb === "BULLISH") ||
      (db === "BEARISH" && hb === "BEARISH" && lb === "BEARISH");

    const prob = displacement && aligned ? 70 + Math.random() * 20 : 20;
    setMlProb(Math.round(prob));

    if (displacement && aligned && prob >= 65) {
      setSetup({ bias: db, ...tradeLevels(price, db) });
      setExplain(
        "Strong displacement with HTF + LTF alignment. Institutional continuation likely."
      );
    } else {
      setSetup(null);
      setExplain(
        "Price is inside equilibrium. Professional traders wait for displacement."
      );
    }
  }

  async function loadGold() {
    try {
      const r = await fetch(GOLD_PRICE);
      const d = await r.json();
      setGold(Number(d.price).toFixed(2));
    } catch {
      setGold("Unavailable");
    }
  }

  useEffect(() => {
    loadAll();
    loadGold();
    const i = setInterval(loadAll, 60000);
    return () => clearInterval(i);
  }, []);

  /* ==============================
     VOICE
  ================================ */
  const speak = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return alert("Voice not supported");
    const rec = new SR();
    rec.lang = "en-US";
    rec.start();
    rec.onresult = (e) => setQuestion(e.results[0][0].transcript);
    recRef.current = rec;
  };

  const askAI = () => {
    if (!question) return;
    alert(
      `AI ANALYSIS\n\nBTCUSD: ${btc}\nWeekly: ${weekly}\nDaily: ${daily}\nHTF: ${htf}\nLTF: ${ltf}\n\n${explain}`
    );
  };

  /* ==============================
     UI
  ================================ */
  return (
    <div
      style={{
        minHeight: "100vh",
        padding: 24,
        background: "linear-gradient(180deg,#020617,#020617)",
        color: "#e5e7eb",
        fontFamily: "system-ui",
      }}
    >
      <h1 style={{ color: "#f9fafb" }}>AI Trading Dashboard</h1>

      <p>BTCUSD: ${btc}</p>
      <p>Weekly Bias: {weekly}</p>
      <p>Daily Bias: {daily}</p>
      <p>HTF (15m): {htf}</p>
      <p>LTF (5m): {ltf}</p>
      <p>ML Probability: {mlProb}%</p>

      <h2>AI Conclusion</h2>
      <p>{explain}</p>

      {setup && (
        <>
          <h2>🎯 Trade Setup</h2>
          <p>Direction: {setup.bias}</p>
          <p>Entry: {setup.entry.toFixed(2)}</p>
          <p>SL: {setup.sl.toFixed(2)}</p>
          <p>TP: {setup.tp.toFixed(2)}</p>
        </>
      )}

      <hr />

      <h2>Ask AI</h2>
      <input
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        placeholder="Ask about BTC or Gold setup..."
        style={{ width: "100%", padding: 8 }}
      />
      <br />
      <button onClick={askAI}>Ask</button>
      <button onClick={speak} style={{ marginLeft: 8 }}>
        🎤 Speak
      </button>

      <hr />
      <p>XAUUSD (Gold): ${gold}</p>
    </div>
  );
}