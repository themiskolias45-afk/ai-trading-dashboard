import { useEffect, useState } from "react";

/* =========================
   DATA FETCH
========================= */
async function fetchBTC_HTF() {
  const r = await fetch(
    "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=15m&limit=120"
  );
  const d = await r.json();
  return d.map(c => ({
    open: +c[1],
    high: +c[2],
    low: +c[3],
    close: +c[4]
  }));
}

async function fetchBTC_LTF() {
  const r = await fetch(
    "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=120"
  );
  const d = await r.json();
  return d.map(c => ({
    open: +c[1],
    high: +c[2],
    low: +c[3],
    close: +c[4]
  }));
}

/* =========================
   TECH HELPERS
========================= */
function getEMA(values, period) {
  const k = 2 / (period + 1);
  let ema = values[0];
  for (let i = 1; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

/* =========================
   HTF ANALYSIS
========================= */
function getHTFBias(candles) {
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);

  if (highs.at(-1) > highs.at(-10)) return "BULLISH";
  if (lows.at(-1) < lows.at(-10)) return "BEARISH";
  return "RANGE";
}

function detectLiquidity(candles) {
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);

  if (highs.at(-1) > Math.max(...highs.slice(-20, -1)))
    return "BUY-SIDE TAKEN";

  if (lows.at(-1) < Math.min(...lows.slice(-20, -1)))
    return "SELL-SIDE TAKEN";

  return "NONE";
}

function detectDisplacement(candles) {
  const last = candles.at(-1);
  const prev = candles.at(-2);

  if (Math.abs(last.close - last.open) > Math.abs(prev.close - prev.open) * 1.5)
    return "YES";

  return "NO";
}

function getConfidence(bias, liquidity, displacement) {
  let score = 0;
  if (bias !== "RANGE") score++;
  if (liquidity !== "NONE") score++;
  if (displacement === "YES") score++;

  if (score === 3) return "A";
  if (score === 2) return "B";
  return "C";
}

/* =========================
   LTF CONFIRMATION
========================= */
function getLTFConfirmation(candles, direction) {
  if (candles.length < 60) return "WAIT";

  const closes = candles.map(c => c.close);
  const ema20 = getEMA(closes.slice(-25), 20);
  const ema50 = getEMA(closes.slice(-55), 50);
  const lastClose = closes.at(-1);

  if (direction === "SELL" && ema20 < ema50 && lastClose < ema20)
    return "CONFIRMED";

  if (direction === "BUY" && ema20 > ema50 && lastClose > ema20)
    return "CONFIRMED";

  return "WAIT";
}

/* =========================
   APP
========================= */
export default function App() {
  const [htf, setHTF] = useState([]);
  const [ltf, setLTF] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    async function load() {
      try {
        setHTF(await fetchBTC_HTF());
        setLTF(await fetchBTC_LTF());
      } catch {
        setError("Data fetch error");
      }
    }
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, []);

  if (error)
    return <Screen>ERROR: {error}</Screen>;

  if (htf.length === 0 || ltf.length === 0)
    return <Screen>Loading market data…</Screen>;

  const price = htf.at(-1).close;
  const bias = getHTFBias(htf);
  const liquidity = detectLiquidity(htf);
  const displacement = detectDisplacement(htf);
  const confidence = getConfidence(bias, liquidity, displacement);

  let direction = "WAIT";
  if (bias === "BULLISH") direction = "BUY";
  if (bias === "BEARISH") direction = "SELL";

  const ltfConfirm =
    confidence !== "C"
      ? getLTFConfirmation(ltf, direction)
      : "WAIT";

  let finalSignal = "WAIT";
  if (confidence === "A" && ltfConfirm === "CONFIRMED")
    finalSignal = direction;

  if (confidence === "B" && ltfConfirm === "CONFIRMED")
    finalSignal = direction + " (Early)";

  return (
    <Screen>
      <Block>BTCUSD: ${price.toFixed(2)}</Block>
      <Block>HTF Bias: {bias}</Block>
      <Block>Liquidity: {liquidity}</Block>
      <Block>Displacement: {displacement}</Block>
      <Block>Confidence: {confidence}</Block>
      <Block>LTF (5m) Confirmation: {ltfConfirm}</Block>

      <Divider />

      <BlockTitle>AI CONCLUSION</BlockTitle>
      <Block>
        {finalSignal === "WAIT"
          ? "WAIT — Market is not ready. Let liquidity + structure complete."
          : finalSignal}
      </Block>
    </Screen>
  );
}

/* =========================
   UI
========================= */
function Screen({ children }) {
  return (
    <div style={{
      minHeight: "100vh",
      background: "#0b1020",
      color: "white",
      padding: 20,
      fontFamily: "Arial"
    }}>
      <h1>AI Trading Analyst</h1>
      {children}
    </div>
  );
}

function Block({ children }) {
  return (
    <div style={{
      background: "#111831",
      padding: 12,
      borderRadius: 8,
      marginBottom: 10,
      whiteSpace: "pre-line"
    }}>
      {children}
    </div>
  );
}

function BlockTitle({ children }) {
  return (
    <div style={{ marginTop: 14, fontWeight: "bold", color: "#6ee7ff" }}>
      {children}
    </div>
  );
}

function Divider() {
  return <hr style={{ opacity: 0.2, margin: "16px 0" }} />;
}