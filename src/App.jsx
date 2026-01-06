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
  const risk = price * 0.006;
  return bias === "BULLISH"
    ? { entry: price, sl: price - risk, tp: price + risk * 2 }
    : { entry: price, sl: price + risk, tp: price - risk * 2 };
};

const gradeFromScore = (score) => {
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
  const [btcGrade, setBtcGrade] = useState("C");
  const [btcExplain, setBtcExplain] = useState("");
  const [btcAlert, setBtcAlert] = useState(null);

  // GOLD
  const [goldPrice, setGoldPrice] = useState("-");
  const [goldBias, setGoldBias] = useState({ w:"", d:"", h:"", l:"" });
  const [goldGrade, setGoldGrade] = useState("C");
  const [goldExplain, setGoldExplain] = useState("");
  const [goldAlert, setGoldAlert] = useState(null);

  // ASK AI
  const [question, setQuestion] = useState("");
  const recognitionRef = useRef(null);

  /* ==============================
     CORE ENGINE + SAVE DATA
  ================================ */
  async function loadAsset(cfg, name, setPrice, setBias, setGrade, setExplain, setAlert) {
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
    const alignedW   = (wB === dB && dB !== "RANGE");

    let score = 0;
    if (alignedHTF) score += 30;
    if (displacement) score += 30;
    if (alignedW) score += 20;

    setGrade(gradeFromScore(score));

    let explanation = "Equilibrium. Waiting for displacement.";
    let alert = null;

    if (displacement && alignedHTF) {
      alert = { direction:dB, ...levelsFromRisk(price, dB) };
      explanation = "Displacement + multi-timeframe alignment.";
    }

    setAlert(alert);
    setExplain(explanation);

    /* ===== SAVE SNAPSHOT ===== */
    const snapshot = {
      time: new Date().toISOString(),
      asset: name,
      price: price.toFixed(2),
      weekly: wB,
      daily: dB,
      htf: hB,
      ltf: lB,
      grade: gradeFromScore(score),
      note: explanation,
    };

    const history = JSON.parse(localStorage.getItem("AI_HISTORY") || "[]");
    history.push(snapshot);
    localStorage.setItem("AI_HISTORY", JSON.stringify(history));
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
    loadAsset(BTC, "BTC", setBtcPrice, setBtcBias, setBtcGrade, setBtcExplain, setBtcAlert);
    loadAsset(GOLD, "GOLD", setGoldPrice, setGoldBias, setGoldGrade, setGoldExplain, setGoldAlert);
    loadGoldPrice();
    const i = setInterval(() => {
      loadAsset(BTC, "BTC", setBtcPrice, setBtcBias, setBtcGrade, setBtcExplain, setBtcAlert);
      loadAsset(GOLD, "GOLD", setGoldPrice, setGoldBias, setGoldGrade, setGoldExplain, setGoldAlert);
    }, 60000);
    return () => clearInterval(i);
  }, []);

  /* ==============================
     DOWNLOAD CSV
  ================================ */
  const downloadCSV = () => {
    const rows = JSON.parse(localStorage.getItem("AI_HISTORY") || "[]");
    if (!rows.length) return alert("No data yet");

    const header = Object.keys(rows[0]).join(",");
    const body = rows.map(r => Object.values(r).join(",")).join("\n");
    const csv = header + "\n" + body;

    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "AI_Trading_History.csv";
    a.click();
  };

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
    alert(
`BTC: ${btcExplain} (Grade ${btcGrade})
GOLD: ${goldExplain} (Grade ${goldGrade})`
    );
  };

  /* ==============================
     UI
  ================================ */
  return (
    <div style={{ minHeight:"100vh", background:"#0b1220", color:"#eaeaea", padding:24, fontFamily:"serif" }}>
      <h1>AI Trading Dashboard</h1>

      <h2>BTCUSD</h2>
      <p>Price: ${btcPrice}</p>
      <p>Weekly {btcBias.w} | Daily {btcBias.d}</p>
      <p>HTF {btcBias.h} | LTF {btcBias.l}</p>
      <p>Grade: {btcGrade}</p>
      <p>{btcExplain}</p>

      {btcAlert && (
        <p>🎯 Entry {btcAlert.entry.toFixed(2)} | SL {btcAlert.sl.toFixed(2)} | TP {btcAlert.tp.toFixed(2)}</p>
      )}

      <hr />

      <h2>Gold (PAXG)</h2>
      <p>Price: ${goldPrice}</p>
      <p>Weekly {goldBias.w} | Daily {goldBias.d}</p>
      <p>HTF {goldBias.h} | LTF {goldBias.l}</p>
      <p>Grade: {goldGrade}</p>
      <p>{goldExplain}</p>

      {goldAlert && (
        <p>🎯 Entry {goldAlert.entry.toFixed(2)} | SL {goldAlert.sl.toFixed(2)} | TP {goldAlert.tp.toFixed(2)}</p>
      )}

      <hr />

      <h2>Ask AI</h2>
      <input value={question} onChange={(e)=>setQuestion(e.target.value)} style={{width:"100%",padding:8}} />
      <br />
      <button onClick={askAI}>Ask</button>
      <button onClick={startVoice} style={{marginLeft:8}}>🎤 Speak</button>
      <br /><br />
      <button onClick={downloadCSV}>📥 Download AI History</button>
    </div>
  );
}