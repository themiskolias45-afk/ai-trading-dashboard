import { useEffect, useState } from "react";

/* =========================
   CONFIG
========================= */
const BTC_HTF = "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=15m&limit=120";
const BTC_LTF = "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=120";

const XAU_PRICE_API = "https://api.metals.live/v1/spot/gold";

/* =========================
   HELPERS
========================= */
function parseCandles(raw) {
  return raw.map(c => ({
    open: +c[1],
    high: +c[2],
    low: +c[3],
    close: +c[4],
  }));
}

function getRange(candles, n = 20) {
  const slice = candles.slice(-n);
  const high = Math.max(...slice.map(c => c.high));
  const low = Math.min(...slice.map(c => c.low));
  return { high, low, range: high - low };
}

function getBias(candles) {
  if (candles.length < 30) return "NO DATA";
  const r1 = getRange(candles, 10);
  const r2 = getRange(candles, 30);
  if (r1.high > r2.high && r1.low > r2.low) return "BULLISH";
  if (r1.high < r2.high && r1.low < r2.low) return "BEARISH";
  return "RANGE";
}

function marketState(candles) {
  const r = getRange(candles, 20);
  return r.range > r.high * 0.004 ? "TREND" : "RANGE";
}

function buildLevels(price, bias, atr) {
  if (bias === "BULLISH") {
    return {
      entry: price,
      tp1: price + atr * 1.2,
      tp2: price + atr * 2.2,
      sl: price - atr * 1.0,
    };
  }
  if (bias === "BEARISH") {
    return {
      entry: price,
      tp1: price - atr * 1.2,
      tp2: price - atr * 2.2,
      sl: price + atr * 1.0,
    };
  }
  return null;
}

function explain({ price, htf, ltf, state }) {
  if (htf === "RANGE")
    return "Price is inside equilibrium. Professional traders wait for displacement.";

  if (htf === "BULLISH" && ltf === "BULLISH")
    return "Bullish HTF with LTF confirmation. Look for pullbacks into premium demand.";

  if (htf === "BEARISH" && ltf === "BEARISH")
    return "Bearish HTF with LTF continuation. Shorts preferred after liquidity grabs.";

  return "HTF bias exists but LTF confirmation is missing. Patience required.";
}

/* =========================
   APP
========================= */
export default function App() {
  const [btc, setBTC] = useState(null);
  const [btcInfo, setBTCInfo] = useState("Loading BTC…");
  const [xau, setXAU] = useState(null);

  useEffect(() => {
    async function fetchBTC() {
      const htfRaw = await fetch(BTC_HTF).then(r => r.json());
      const ltfRaw = await fetch(BTC_LTF).then(r => r.json());

      const htf = parseCandles(htfRaw);
      const ltf = parseCandles(ltfRaw);

      const price = htf.at(-1).close;
      const htfBias = getBias(htf);
      const ltfBias = getBias(ltf);
      const state = marketState(htf);

      const atr = getRange(htf, 20).range;
      const levels = buildLevels(price, htfBias, atr);
      const text = explain({ price, htf: htfBias, ltf: ltfBias, state });

      setBTC({
        price,
        htfBias,
        ltfBias,
        state,
        levels,
        text,
      });

      setBTCInfo("OK");
    }

    async function fetchXAU() {
      try {
        const r = await fetch(XAU_PRICE_API).then(r => r.json());
        setXAU(r[0].gold);
      } catch {
        setXAU("Unavailable");
      }
    }

    fetchBTC();
    fetchXAU();
    const t = setInterval(fetchBTC, 60000);
    return () => clearInterval(t);
  }, []);

  /* =========================
     UI
  ========================= */
  return (
    <div style={{ background: "#0b1020", minHeight: "100vh", color: "#e5e7eb", padding: 20 }}>
      <h1>AI Trading Dashboard</h1>

      {/* BTC */}
      {btc && (
        <>
          <div className="card">BTCUSD: ${btc.price.toFixed(2)}</div>
          <div className="card">Market State: {btc.state}</div>
          <div className="card">HTF Bias (15m): {btc.htfBias}</div>
          <div className="card">LTF Bias (5m): {btc.ltfBias}</div>

          {btc.levels && btc.htfBias !== "RANGE" && (
            <>
              <div className="card">Entry: {btc.levels.entry.toFixed(2)}</div>
              <div className="card">TP1: {btc.levels.tp1.toFixed(2)}</div>
              <div className="card">TP2: {btc.levels.tp2.toFixed(2)}</div>
              <div className="card">SL: {btc.levels.sl.toFixed(2)}</div>
            </>
          )}

          <div className="card">
            <strong>AI Conclusion</strong>
            <p>{btc.text}</p>
          </div>
        </>
      )}

      {/* GOLD */}
      <hr />
      <div className="card">XAUUSD (Gold): {xau ? `$${xau}` : "Loading…"}</div>

      <style>{`
        .card {
          background: #111827;
          padding: 14px;
          border-radius: 10px;
          margin: 10px 0;
        }
      `}</style>
    </div>
  );
}