import { useEffect, useState } from "react";

/* ================= MARKET DATA ================= */

async function fetchBTC() {
  const r = await fetch(
    "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT"
  );
  const j = await r.json();
  return parseFloat(j.price);
}

/* ================= SMC HELPERS ================= */

function detectBias(data) {
  if (data.length < 5) return "RANGE";
  const last = data.at(-1);
  const prev = data.at(-3);
  if (last > prev) return "BULLISH";
  if (last < prev) return "BEARISH";
  return "RANGE";
}

function detectFVG(data) {
  if (data.length < 3) return null;
  const a = data.at(-3);
  const b = data.at(-2);
  const c = data.at(-1);

  if (a < c && a < b && b < c)
    return { side: "BULLISH", from: a, to: c };

  if (a > c && a > b && b > c)
    return { side: "BEARISH", from: c, to: a };

  return null;
}

function calcTradeLevels({ side, price }) {
  if (side === "WAIT") return null;

  const risk = price * 0.01;

  if (side === "BUY") {
    return {
      entry: price,
      sl: price - risk,
      tp1: price + risk * 1.5,
      tp2: price + risk * 3
    };
  }

  return {
    entry: price,
    sl: price + risk,
    tp1: price - risk * 1.5,
    tp2: price - risk * 3
  };
}

/* ================= MAIN APP ================= */

export default function App() {
  const [price, setPrice] = useState(null);
  const [history, setHistory] = useState([]);
  const [signal, setSignal] = useState("WAIT");

  useEffect(() => {
    const run = async () => {
      const p = await fetchBTC();
      setPrice(p);
      setHistory(h => [...h.slice(-20), p]);
    };

    run();
    const t = setInterval(run, 15000);
    return () => clearInterval(t);
  }, []);

  const bias = detectBias(history);
  const fvg = detectFVG(history);

  useEffect(() => {
    if (!price) return;

    if (bias === "BULLISH" && fvg?.side === "BULLISH") {
      setSignal("BUY");
    } else if (bias === "BEARISH" && fvg?.side === "BEARISH") {
      setSignal("SELL");
    } else {
      setSignal("WAIT");
    }
  }, [bias, fvg, price]);

  const trade = calcTradeLevels({ side: signal, price });

  return (
    <div style={styles.page}>
      <h1>AI Trading Dashboard</h1>

      <div className="card">BTCUSD: ${price?.toFixed(2)}</div>
      <div className="card">HTF Bias: {bias}</div>
      <div className="card">Signal: {signal}</div>

      {trade && (
        <div className="card">
          <div>ENTRY: {trade.entry.toFixed(2)}</div>
          <div>SL: {trade.sl.toFixed(2)}</div>
          <div>TP1: {trade.tp1.toFixed(2)}</div>
          <div>TP2: {trade.tp2.toFixed(2)}</div>
        </div>
      )}
    </div>
  );
}

/* ================= STYLES ================= */

const styles = {
  page: {
    background: "#0b1220",
    minHeight: "100vh",
    color: "white",
    padding: "20px",
    fontFamily: "Arial"
  }
};