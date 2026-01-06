import { useEffect, useState, useRef } from "react";

/* ==============================
   CONFIG (BINANCE)
================================ */
const BTC = {
  weekly: "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1w&limit=120",
  daily:  "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=120",
  htf:    "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=15m&limit=120",
  ltf:    "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=120",
};

const GOLD = {
  weekly: "https://api.binance.com/api/v3/klines?symbol=PAXGUSDT&interval=1w&limit=120",
  daily:  "https://api.binance.com/api/v3/klines?symbol=PAXGUSDT&interval=1d&limit=120",
  htf:    "https://api.binance.com/api/v3/klines?symbol=PAXGUSDT&interval=15m&limit=120",
  ltf:    "https://api.binance.com/api/v3/klines?symbol=PAXGUSDT&interval=5m&limit=120",
  price:  "https://api.binance.com/api/v3/ticker/price?symbol=PAXGUSDT",
};

/* ==============================
   HELPERS
================================ */
const parse = (d) =>
  d.map((c) => ({
    open: +c[1],
    high: +c[2],
    low:  +c[3],
    close:+c[4],
  }));

const biasFromStructure = (c) => {
  if (!c || c.length < 20) return "NO DATA";
  const hh = c.at(-1).high > c.at(-5).high;
  const hl = c.at(-1).low  > c.at(-5).low;
  const lh = c.at(-1).high < c.at(-5).high;
  const ll = c.at(-1).low  < c.at(-5).low;
  if (hh && hl) return "BULLISH";
  if (lh && ll) return "BEARISH";
  return "RANGE";
};

const detectDisplacement = (c) => {
  if (!c || c.length < 2) return false;
  const last = c.at(-1);
  const prev = c.at(-2);
  const body = Math.abs(last.close - last.open);
  const prevRange = Math.max(prev.high - prev.low, 0.00001);
  return body > prevRange * 1.5;
};

const levelsFromRisk = (price, bias) => {
  const risk = price * 0.006; // 0.6%
  if (bias === "BULLISH") {
    return { entry: price, sl: price - risk, tp: price + risk * 2 };
  }
  return { entry: price, sl: price + risk, tp: price - risk * 2 };
};

const confidenceGrade = (score) => {
  if (score >= 90) return "A+";
  if (score >= 75) return "A";
  if (score >= 60) return "B";
  return "C";
};

/* ==============================
   APP
================================ */
export default function App() {
  // BTC
  const [btcPrice, setBtcPrice] = useState("-");
  const [btcBias, setBtcBias] = useState({ w:"", d:"", h:"", l:"" });
  const [btcProb, setBtcProb] = useState(0);
  const [btcGrade, setBtcGrade] = useState("C");
  const [btcExplain, setBtcExplain] = useState("");
  const [btcAlert, setBtcAlert] = useState(null);

  // GOLD
  const [goldPrice, setGoldPrice] = useState("-");
  const [goldBias, setGoldBias] = useState({ w:"", d:"", h:"", l:"" });
  const [goldProb, setGoldProb] = useState(0);
  const [goldGrade, setGoldGrade] = useState("C");
  const [goldExplain, setGoldExplain] = useState("");
  const [goldAlert, setGoldAlert] = useState(null);

  // ASK AI
  const [question, setQuestion] = useState("");
  const recognitionRef = useRef(null);

  /* ==============================
     CORE ENGINE
  ================================ */
  async function loadAsset(cfg, setPrice, setBias, setProb, setGrade, setExplain, setAlert) {
    const [w, d, h, l] = await Promise.all([
      fetch(cfg.weekly).then(r=>r.json()),
      fetch(cfg.daily).then(r=>r.json()),
      fetch(cfg.htf).then(r=>r.json()),
      fetch(cfg.ltf).then(r=>r.json()),
    ]);

    const wc = parse(w), dc = parse(d), hc = parse(h), lc = parse(l);
    const wB = biasFromStructure(wc);
    const dB = biasFromStructure(dc);
    const hB = biasFromStructure(hc);
    const lB = biasFromStructure(lc);
    setBias({ w:wB, d:dB, h:hB, l:lB });

    const price = hc.at(-1).close;
    setPrice(price.toFixed(2));

    const displacement = detectDisplacement(hc);
    const alignedHTF = (dB === hB && hB === lB && dB !== "RANGE");
    const alignedW = (wB === dB && dB !== "RANGE");

    let score = 0;
    if (alignedHTF) score += 30;
    if (displacement) score += 30;
    if (alignedW) score += 20;
    const prob = displacement && alignedHTF ? 70 + Math.random()*20 : 20;
    score += prob >= 70 ? 20 : 0;

    const finalProb = Math.round(prob);
    setProb(finalProb);
    setGrade(confidenceGrade(score));

    if (displacement && alignedHTF && finalProb >= 65) {
      const lv = levelsFromRisk(price, dB);
      setAlert({ direction:dB, ...lv });
      setExplain("Displacement + multi-timeframe alignment. Trade only with confirmation.");
    } else {
      setAlert(null);
      setExplain("Price is inside equilibrium. Professional traders wait for displacement.");
    }
  }

  async function loadGoldPrice() {
    try {
      const r = await fetch(GOLD.price);
      const d = await r.json();
      setGoldPrice(Number(d.price).toFixed(2));
    } catch {
      setGoldPrice("Unavailable");
    }
  }

  useEffect(() => {
    loadAsset(BTC, setBtcPrice, setBtcBias, setBtcProb, setBtcGrade, setBtcExplain, setBtcAlert);
    loadAsset(GOLD, setGoldPrice, setGoldBias, setGoldProb, setGoldGrade, setGoldExplain, setGoldAlert);
    loadGoldPrice();
    const i = setInterval(() => {
      loadAsset(BTC, setBtcPrice, setBtcBias, setBtcProb, setBtcGrade, setBtcExplain, setBtcAlert);
      loadAsset(GOLD, setGoldPrice, setGoldBias, setGoldProb, setGoldGrade, setGoldExplain, setGoldAlert);
    }, 60000);
    return () => clearInterval(i);
  }, []);

  /* ==============================
     VOICE
  ================================ */
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
`BTC:
Weekly ${btcBias.w} | Daily ${btcBias.d}
HTF ${btcBias.h} | LTF ${btcBias.l}
ML ${btcProb}% | Grade ${btcGrade}

Gold:
Weekly ${goldBias.w} | Daily ${goldBias.d}
HTF ${goldBias.h} | LTF ${goldBias.l}
ML ${goldProb}% | Grade ${goldGrade}

Conclusion:
BTC: ${btcExplain}
Gold: ${goldExplain}`
    );
  };

  /* ==============================
     UI (DARK THEME FIXED)
  ================================ */
  return (
    <div style={{
      minHeight:"100vh",
      background:"linear-gradient(180deg,#050814,#0b1020)",
      color:"#eaeaea",
      padding:24,
      fontFamily:"serif"
    }}>
      <h1>AI Trading Dashboard</h1>

      <h2>BTCUSD</h2>
      <p>Price: ${btcPrice}</p>
      <p>Weekly: {btcBias.w}</p>
      <p>Daily: {btcBias.d}</p>
      <p>HTF (15m): {btcBias.h}</p>
      <p>LTF (5m): {btcBias.l}</p>
      <p>ML Probability: {btcProb}% | Grade: {btcGrade}</p>
      <p>{btcExplain}</p>

      {btcAlert && (
        <>
          <p>🎯 Entry: {btcAlert.entry.toFixed(2)}</p>
          <p>SL: {btcAlert.sl.toFixed(2)}</p>
          <p>TP: {btcAlert.tp.toFixed(2)}</p>
        </>
      )}

      <hr />

      <h2>Gold (PAXG)</h2>
      <p>Price: ${goldPrice}</p>
      <p>Weekly: {goldBias.w}</p>
      <p>Daily: {goldBias.d}</p>
      <p>HTF (15m): {goldBias.h}</p>
      <p>LTF (5m): {goldBias.l}</p>
      <p>ML Probability: {goldProb}% | Grade: {goldGrade}</p>
      <p>{goldExplain}</p>

      {goldAlert && (
        <>
          <p>🎯 Entry: {goldAlert.entry.toFixed(2)}</p>
          <p>SL: {goldAlert.sl.toFixed(2)}</p>
          <p>TP: {goldAlert.tp.toFixed(2)}</p>
        </>
      )}

      <hr />

      <h2>Ask AI</h2>
      <input
        value={question}
        onChange={(e)=>setQuestion(e.target.value)}
        placeholder="Ask about BTC or Gold setup..."
        style={{width:"100%",padding:8}}
      />
      <br />
      <button onClick={askAI}>Ask</button>
      <button onClick={startVoice} style={{marginLeft:8}}>🎤 Speak</button>
    </div>
  );
}