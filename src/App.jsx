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
   SMART EXPLANATION ENGINE
================================ */
const explainMarket = (asset, bias, grade, displacement) => {
  if (grade === "A") {
    return `${asset} shows strong institutional conditions. Multi-timeframe alignment with displacement suggests continuation. Focus on precision entries only.`;
  }
  if (displacement) {
    return `${asset} printed displacement, but structure is not fully aligned. This is often a stop-hunt or transition phase. Patience is required.`;
  }
  if (bias.h !== bias.l) {
    return `${asset} is in pullback mode. Higher timeframe bias remains ${bias.d}, but execution timeframes are opposing. Wait for confirmation.`;
  }
  return `${asset} is consolidating in equilibrium. No commitment from smart money. Best action is to wait.`;
};

/* ==============================
   APP
================================ */
export default function App() {
  const [btc, setBtc] = useState({ price:"-", bias:{}, grade:"C", explain:"", alert:null });
  const [gold, setGold] = useState({ price:"-", bias:{}, grade:"C", explain:"", alert:null });
  const [question, setQuestion] = useState("");
  const [dailySummary, setDailySummary] = useState("");
  const recognitionRef = useRef(null);

  async function loadAsset(cfg, name, setter) {
    const [w,d,h,l] = await Promise.all([
      fetch(cfg.weekly).then(r=>r.json()),
      fetch(cfg.daily).then(r=>r.json()),
      fetch(cfg.htf).then(r=>r.json()),
      fetch(cfg.ltf).then(r=>r.json()),
    ]);

    const wc=parse(w), dc=parse(d), hc=parse(h), lc=parse(l);
    const bias={ w:biasFromStructure(wc), d:biasFromStructure(dc), h:biasFromStructure(hc), l:biasFromStructure(lc) };
    const price=hc.at(-1).close;
    const displacement=detectDisplacement(hc);
    const alignedHTF=(bias.d===bias.h && bias.h===bias.l && bias.d!=="RANGE");
    const alignedW=(bias.w===bias.d && bias.d!=="RANGE");

    let score=0;
    if(alignedHTF) score+=30;
    if(displacement) score+=30;
    if(alignedW) score+=20;
    const grade=gradeFromScore(score);

    const explanation=explainMarket(name,bias,grade,displacement);
    let alert=null;
    if(displacement && alignedHTF){
      alert={ direction:bias.d, ...levelsFromRisk(price,bias.d) };
    }

    const snapshot={
      time:new Date().toISOString(),
      asset:name,
      price:price.toFixed(2),
      ...bias,
      grade,
      note:explanation
    };
    const hist=JSON.parse(localStorage.getItem("AI_HISTORY")||"[]");
    hist.push(snapshot);
    localStorage.setItem("AI_HISTORY",JSON.stringify(hist));

    setter({ price:price.toFixed(2), bias, grade, explain:explanation, alert });
  }

  const dailySummaryEngine=()=>{
    const today=new Date().toDateString();
    const last=localStorage.getItem("DAILY_SUMMARY_DATE");
    if(last===today) return;
    const text=`Daily AI Summary:\nBTC: ${btc.explain}\nGold: ${gold.explain}`;
    localStorage.setItem("DAILY_SUMMARY",text);
    localStorage.setItem("DAILY_SUMMARY_DATE",today);
    setDailySummary(text);
  };

  useEffect(()=>{
    loadAsset(BTC,"BTC",setBtc);
    loadAsset(GOLD,"GOLD",setGold);
    dailySummaryEngine();
    const i=setInterval(()=>{
      loadAsset(BTC,"BTC",setBtc);
      loadAsset(GOLD,"GOLD",setGold);
    },60000);
    return()=>clearInterval(i);
  },[]);

  const askAI=()=>{
    alert(`BTC:\n${btc.explain}\n\nGOLD:\n${gold.explain}`);
  };

  const startVoice=()=>{
    const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
    if(!SR) return alert("Voice not supported");
    const rec=new SR();
    rec.lang="en-US";
    rec.start();
    rec.onresult=e=>setQuestion(e.results[0][0].transcript);
    recognitionRef.current=rec;
  };

  const downloadCSV=()=>{
    const rows=JSON.parse(localStorage.getItem("AI_HISTORY")||"[]");
    if(!rows.length) return alert("No data yet");
    const header=Object.keys(rows[0]).join(",");
    const body=rows.map(r=>Object.values(r).join(",")).join("\n");
    const blob=new Blob([header+"\n"+body],{type:"text/csv"});
    const a=document.createElement("a");
    a.href=URL.createObjectURL(blob);
    a.download="AI_Trading_History.csv";
    a.click();
  };

  return (
    <div style={{minHeight:"100vh",background:"#0b1220",color:"#eaeaea",padding:24,fontFamily:"serif"}}>
      <h1>AI Trading Dashboard</h1>

      <h2>BTCUSD</h2>
      <p>Price: ${btc.price}</p>
      <p>Weekly {btc.bias.w} | Daily {btc.bias.d}</p>
      <p>HTF {btc.bias.h} | LTF {btc.bias.l}</p>
      <p>Grade: {btc.grade}</p>
      <p>{btc.explain}</p>

      {btc.alert && <p>🎯 Entry {btc.alert.entry.toFixed(2)} | SL {btc.alert.sl.toFixed(2)} | TP {btc.alert.tp.toFixed(2)}</p>}

      <hr />

      <h2>Gold (PAXG)</h2>
      <p>Price: ${gold.price}</p>
      <p>Weekly {gold.bias.w} | Daily {gold.bias.d}</p>
      <p>HTF {gold.bias.h} | LTF {gold.bias.l}</p>
      <p>Grade: {gold.grade}</p>
      <p>{gold.explain}</p>

      {gold.alert && <p>🎯 Entry {gold.alert.entry.toFixed(2)} | SL {gold.alert.sl.toFixed(2)} | TP {gold.alert.tp.toFixed(2)}</p>}

      <hr />

      <h2>Ask AI</h2>
      <input value={question} onChange={e=>setQuestion(e.target.value)} style={{width:"100%",padding:8}} />
      <br />
      <button onClick={askAI}>Ask</button>
      <button onClick={startVoice} style={{marginLeft:8}}>🎤 Speak</button>

      <br /><br />
      <button onClick={downloadCSV}>📥 Download AI History</button>

      {dailySummary && <pre style={{marginTop:20,whiteSpace:"pre-wrap"}}>{dailySummary}</pre>}
    </div>
  );
}