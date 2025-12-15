import { useEffect, useMemo, useState } from "react";

/* ===== Swing Detection ===== */
function detectSwings(candles, n = 2) {
  const swings = [];
  for (let i = n; i < candles.length - n; i++) {
    const c = candles[i];
    let isHigh = true;
    let isLow = true;

    for (let k = 1; k <= n; k++) {
      if (candles[i - k].high >= c.high) isHigh = false;
      if (candles[i + k].high >= c.high) isHigh = false;
      if (candles[i - k].low <= c.low) isLow = false;
      if (candles[i + k].low <= c.low) isLow = false;
    }

    if (isHigh) swings.push({ type: "H", price: c.high, idx: i });
    if (isLow) swings.push({ type: "L", price: c.low, idx: i });
  }

  swings.sort((a, b) => a.idx - b.idx);
  const filtered = [];
  for (const s of swings) {
    const last = filtered[filtered.length - 1];
    if (!last) filtered.push(s);
    else if (last.type === s.type) {
      if (s.type === "H" && s.price > last.price) filtered[filtered.length - 1] = s;
      if (s.type === "L" && s.price < last.price) filtered[filtered.length - 1] = s;
    } else filtered.push(s);
  }
  return filtered;
}

function labelStructure(swings) {
  let lastHigh = null;
  let lastLow = null;
  return swings.map(s => {
    if (s.type === "H") {
      const label = lastHigh === null ? "H" : s.price > lastHigh ? "HH" : "LH";
      lastHigh = s.price;
      return { ...s, label };
    } else {
      const label = lastLow === null ? "L" : s.price > lastLow ? "HL" : "LL";
      lastLow = s.price;
      return { ...s, label };
    }
  });
}

function detectBOS(labeled, lastPrice) {
  const highs = labeled.filter(x => x.type === "H");
  const lows = labeled.filter(x => x.type === "L");

  if (highs.length < 1 || lows.length < 1) return null;

  const lastHigh = highs[highs.length - 1];
  const lastLow = lows[lows.length - 1];

  if (lastPrice > lastHigh.price) {
    return { type: "BULLISH BOS", level: lastHigh.price };
  }
  if (lastPrice < lastLow.price) {
    return { type: "BEARISH BOS", level: lastLow.price };
  }
  return null;
}

export default function App() {
  const [candles, setCandles] = useState([]);
  const [price, setPrice] = useState(null);

  useEffect(() => {
    const fetchData = async () => {
      const res = await fetch(
        "https://min-api.cryptocompare.com/data/v2/histominute?fsym=BTC&tsym=USD&limit=220"
      );
      const json = await res.json();
      const data = json.Data.Data;
      setCandles(data);
      setPrice(data[data.length - 1].close);
    };
    fetchData();
    const i = setInterval(fetchData, 60000);
    return () => clearInterval(i);
  }, []);

  const { labeled, bos } = useMemo(() => {
    const swings = detectSwings(candles, 2);
    const labeled = labelStructure(swings);
    const bos = price ? detectBOS(labeled, price) : null;
    return { labeled, bos };
  }, [candles, price]);

  const lastSwings = labeled.slice(-8);

  return (
    <div style={{ background: "#0b0f1a", color: "white", minHeight: "100vh", padding: 24 }}>
      <h1>AI Trading Dashboard</h1>

      <div><strong>BTCUSD:</strong> {price ? `$${price}` : "Loading…"}</div>

      <div style={{ marginTop: 10 }}>
        <strong>Last BOS:</strong>{" "}
        {bos ? `${bos.type} above/below ${bos.level.toFixed(2)}` : "No BOS"}
      </div>

      <div style={{ marginTop: 16, background: "#111827", padding: 16, borderRadius: 10 }}>
        <div style={{ fontWeight: "bold", marginBottom: 10 }}>Recent Structure</div>
        {lastSwings.map((s, i) => (
          <div key={i}>
            {s.label} — {s.type === "H" ? "High" : "Low"} @ {s.price.toFixed(2)}
          </div>
        ))}
      </div>
    </div>
  );
}
