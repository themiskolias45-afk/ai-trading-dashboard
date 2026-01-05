import { useEffect, useState } from "react";

/* =========================
   DATA FETCH
========================= */
async function fetchBTC() {
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

/* =========================
   MARKET LOGIC
========================= */
function getMarketState(candles) {
  const last = candles.slice(-20);
  const highs = last.map(c => c.high);
  const lows = last.map(c => c.low);

  const hh = highs.at(-1) > highs.at(-5);
  const hl = lows.at(-1) > lows.at(-5);
  const ll = lows.at(-1) < lows.at(-5);

  if (hh && hl) return "TREND";
  if (ll) return "BREAKDOWN";
  return "RANGE";
}

function getHTFBias(candles) {
  const last = candles.slice(-40);
  const highs = last.map(c => c.high);
  const lows = last.map(c => c.low);

  if (highs.at(-1) > highs.at(-10)) return "BULLISH";
  if (lows.at(-1) < lows.at(-10)) return "BEARISH";
  return "NEUTRAL";
}

function getContext(state) {
  if (state === "TREND") return "Trend continuation day";
  if (state === "BREAKDOWN") return "Expansion / volatility day";
  return "Range / rotation day";
}

function buildPlan(price, state, bias) {
  return {
    buy:
      bias === "BULLISH"
        ? `IF pullback holds above ${(price * 0.995).toFixed(0)}
AND bullish displacement appears
THEN BUY toward ${(price * 1.01).toFixed(0)}`
        : "Wait for structure shift before buying",

    sell:
      bias === "BEARISH"
        ? `IF liquidity taken above ${(price * 1.005).toFixed(0)}
AND bearish CHOCH forms
THEN SELL toward ${(price * 0.99).toFixed(0)}`
        : "Sell only after rejection + CHOCH",

    wait:
      "Price is inside equilibrium. No displacement yet."
  };
}

/* =========================
   APP
========================= */
export default function App() {
  const [candles, setCandles] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchBTC()
      .then(setCandles)
      .catch(() => setError("Data fetch error"));
  }, []);

  if (error) return <Screen title="AI Trading Dashboard">{error}</Screen>;
  if (candles.length === 0)
    return <Screen title="AI Trading Dashboard">Loading market data…</Screen>;

  const price = candles.at(-1).close;
  const state = getMarketState(candles);
  const bias = getHTFBias(candles);
  const context = getContext(state);
  const plan = buildPlan(price, state, bias);

  return (
    <Screen title="AI Trading Dashboard">
      <Block>BTCUSD: ${price.toFixed(2)}</Block>
      <Block>Market State: {state}</Block>
      <Block>HTF Bias: {bias}</Block>
      <Block>Context: {context}</Block>

      <Divider />

      <BlockTitle>BUY SCENARIO</BlockTitle>
      <Block>{plan.buy}</Block>

      <BlockTitle>SELL SCENARIO</BlockTitle>
      <Block>{plan.sell}</Block>

      <BlockTitle>AI CONCLUSION</BlockTitle>
      <Block>{plan.wait}</Block>
    </Screen>
  );
}

/* =========================
   UI HELPERS
========================= */
function Screen({ title, children }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#0b1020",
        color: "#fff",
        padding: 20,
        fontFamily: "Arial"
      }}
    >
      <h1>{title}</h1>
      {children}
    </div>
  );
}

function Block({ children }) {
  return (
    <div
      style={{
        background: "#111831",
        padding: 12,
        borderRadius: 8,
        marginBottom: 10,
        whiteSpace: "pre-line"
      }}
    >
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