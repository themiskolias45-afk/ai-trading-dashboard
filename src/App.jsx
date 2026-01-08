import { useEffect, useState, useRef } from "react";

/* ==============================
   TELEGRAM (EDIT ONLY THESE)
================================ */
const TELEGRAM_BOT_TOKEN = "8246792368:AAG8bxkAIEulUddX5PnQjnC6BubqM3p-NeA";
const TELEGRAM_CHAT_ID = "7063659034";

/* ==============================
   ASSETS
================================ */
const ASSETS = {
  BTC: {
    label: "BTCUSD",
    weekly: "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1w&limit=120",
    daily:  "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=120",
    htf:    "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=15m&limit=120",
    ltf:    "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=120",
  },
  GOLD: {
    label: "GOLD (PAXG)",
    weekly: "https://api.binance.com/api/v3/klines?symbol=PAXGUSDT&interval=1w&limit=120",
    daily:  "https://api.binance.com/api/v3/klines?symbol=PAXGUSDT&interval=1d&limit=120",
    htf:    "https://api.binance.com/api/v3/klines?symbol=PAXGUSDT&interval=15m&limit=120",
    ltf:    "https://api.binance.com/api/v3/klines?symbol=PAXGUSDT&interval=5m&limit=120",
  },
};

/* ==============================
   HELPERS
================================ */
const parse = (d) =>
  d.map(c => ({ open:+c[1], high:+c[2], low:+c[3], close:+c[4] }));

const bias = (c) => {
  if (!c || c.length < 20) return "RANGE";
  const hh = c.at(-1).high > c.at(-5).high;
  const hl = c.at(-1).low  > c.at(-5).low;
  const lh = c.at(-1).high < c.at(-5).high;
  const ll = c.at(-1).low  < c.at(-5).low;
  if (hh && hl) return "BULLISH";
  if (lh && ll) return "BEARISH";
  return "RANGE";
};

const displacement = (c) => {
  const a=c.at(-1), b=c.at(-2);
  return Math.abs(a.close-a.open) > (b.high-b.low)*1.5;
};

const levels = (p, dir) => {
  const r=p*0.006;
  return dir==="BULLISH"
    ? { entry:p, sl:p-r, tp1:p+r, tp2:p+r*2 }
    : { entry:p, sl:p+r, tp1:p-r, tp2:p-r*2 };
};

const grade = (ok) => ok ? "A" : "C";

/* ==============================
   TELEGRAM
================================ */
async function sendTG(text) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body:JSON.stringify({ chat_id:TELEGRAM_CHAT_ID, text }),
    });
  } catch {}
}

/* ==============================
   AI EXPLANATION ENGINE
================================ */
function aiExplain(asset, s) {
  if (!s) return "No data yet.";
  if (s.grade === "A")
    return `${asset} shows institutional displacement with full alignment. This is a valid execution environment.`;
  if (s.biasD !== s.biasH)
    return `${asset} is in pullback. Higher timeframe bias remains ${s.biasD}. Waiting for execution alignment.`;
  return `${asset} is consolidating. No smart-money commitment. Best action is to wait.`;
}

function aiPlanToday(asset, s) {
  if (!s || s.grade !== "A")
    return `${asset}: No trade today. Wait for displacement and alignment.`;
  return `${asset}: Focus on ${s.biasD} continuation. Entry near ${s.lv.entry.toFixed(2)}.`;
}

function aiPlanTomorrow(asset, s) {
  if (!s)
    return `${asset}: Insufficient data.`;
  return `${asset}: Bias remains ${s.biasD}. Tomorrow, look for displacement on 15m in the same direction.`;
}

/* ==============================
   APP
================================ */
export default function App() {
  const [data,setData]=useState({});
  const [question,setQuestion]=useState("");
  const recRef=useRef(null);

  async function scan(k,a){
    const [w,d,h,l]=await Promise.all([
      fetch(a.weekly).then(r=>r.json()),
      fetch(a.daily).then(r=>r.json()),
      fetch(a.htf).then(r=>r.json()),
      fetch(a.ltf).then(r=>r.json()),
    ]);
    const wc=parse(w), dc=parse(d), hc=parse(h), lc=parse(l);
    const biasW=bias(wc), biasD=bias(dc), biasH=bias(hc), biasL=bias(lc);
    const price=hc.at(-1).close;
    const disp=displacement(hc);
    const ok=disp && biasD===biasH && biasH===biasL && biasD!=="RANGE";
    const lv=levels(price,biasD);
    const g=grade(ok);

    const s={ price, biasD, biasH, biasL, lv, grade:g };
    setData(p=>({...p,[k]:s}));

    if(ok){
      sendTG(
`🚨 TKAI — TRADE SIGNAL

Asset: ${a.label}
Direction: ${biasD}
Entry: ${lv.entry.toFixed(2)}
TP1: ${lv.tp1.toFixed(2)}
TP2: ${lv.tp2.toFixed(2)}
SL: ${lv.sl.toFixed(2)}
Confidence: A

Explanation:
Institutional displacement with full alignment.`
      );
    }
  }

  function dailyReport(){
    const now=new Date();
    const london=new Date(now.toLocaleString("en-US",{timeZone:"Europe/London"}));
    if(london.getHours()!==23) return;
    if(localStorage.getItem("TKAI_DAY")===london.toDateString()) return;
    localStorage.setItem("TKAI_DAY",london.toDateString());

    let msg="🤖 TKAI — DAILY PLAN (23:00 London)\n\n";
    Object.entries(data).forEach(([k,s])=>{
      if(!s) return;
      msg+=`${k}\nBias: ${s.biasD}\nPlan: ${aiPlanTomorrow(k,s)}\n\n`;
    });
    sendTG(msg);
  }

  useEffect(()=>{
    Object.entries(ASSETS).forEach(([k,a])=>scan(k,a));
    const i=setInterval(()=>{
      Object.entries(ASSETS).forEach(([k,a])=>scan(k,a));
      dailyReport();
    },3600000);
    return()=>clearInterval(i);
  },[]);

  const askAI=()=>{
    let ans="🤖 TKAI — AI RESPONSE\n\n";
    Object.entries(data).forEach(([k,s])=>{
      ans+=`${k}\n${aiExplain(k,s)}\nToday: ${aiPlanToday(k,s)}\nTomorrow: ${aiPlanTomorrow(k,s)}\n\n`;
    });
    alert(ans);
  };

  const voice=()=>{
    const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
    if(!SR) return alert("Voice not supported");
    const r=new SR();
    r.lang="en-US";
    r.start();
    r.onresult=e=>setQuestion(e.results[0][0].transcript);
    recRef.current=r;
  };

  return (
    <div style={{minHeight:"100vh",background:"#0b1220",color:"#eaeaea",padding:24}}>
      <h1>TKAI — AI Trading Dashboard</h1>
      <p>Hourly scan • Daily report 23:00 London • Grade A alerts only</p>

      <h2>Ask TKAI</h2>
      <input value={question} onChange={e=>setQuestion(e.target.value)} style={{width:"100%",padding:8}} />
      <br />
      <button onClick={askAI}>Ask</button>
      <button onClick={voice} style={{marginLeft:8}}>🎤 Speak</button>
    </div>
  );
}