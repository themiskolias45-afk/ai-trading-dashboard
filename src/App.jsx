import { useEffect, useMemo, useState } from "react";

/**
 * Swing detection (fractal)
 * A swing high: high is greater than N highs left and right
 * A swing low: low is lower than N lows left and right
 */
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

    if (isHigh) swings.push({ type: "H", price: c.high, time: c.time, idx: i });
    if (isLow) swings.push({ type: "L", price: c.low, time: c.time, idx: i });
  }

  // Remove duplicates / keep alternating structure (H-L-H-L...)
  swings.sort((a, b) => a.idx - b.idx);
  const filtered = [];
  for (const s of swings) {
    const last = filtered[filtered.length - 1];
    if (!last) {
      filtered.push(s);
      continue;
    }
    if (last.type === s.type) {
      // keep the more extreme one (higher high / lower low)
      if (s.type === "H") {
        if (s.price > last.price) filtered[filtered.length - 1] = s;
      } else {
        if (s.price < last.price) filtered[filtered.length - 1] = s;
      }
    } else {
      filtered.push(s);
    }
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

function calcBias(labeled) {
  // Use last 2 highs and last 2 lows to infer structure
  const highs = labeled.filter(x => x.type === "H");
  const lows = labeled.filter(x => x.type === "L");
  if (highs.length < 2 || lows.length < 2) return "UNKNOWN";

  const h1 = highs[highs.length - 2].price;
  const h2 = highs[highs.length - 1].price;
  const l1 = lows[lows.length - 2].price;
  const l2 = lows[lows.length - 1].price;

  const higherHigh = h2 > h1;
  const higherLow = l2 > l1;
  const lowerHigh = h2 < h1;
  const lowerLow = l2 < l1;

  if (higherHigh && higherLow) return "BULLISH";
  if (lowerHigh && lowerLow) return "BEARISH";
  return "RANGE";
}

export default function App() {
  const [price, setPrice] = useState(null);
  const [candles, setCandles] = useState([]);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const res = await fetch(
          "https://min-api.cryptocompare.com/data/v2/histominute?fsym=BTC&tsym=USD&limit=200"
        );
        const json = await res.json();
        const data = json?.Data?.Data || [];
        setCandles(data);
        if (data.length) setPrice(data[data.length - 1].close);
      } catch (e) {
        console.error(e);
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 60000);
    return () => clearInterval(interval);
  }, []);

  const { labeled, bias } = useMemo(() => {
    const swings = detectSwings(candles, 2);
    const lab = labelStructure(swings);
    const b = calcBias(lab);
    return { labeled: lab, bias: b };
  }, [candles]);

  const last10 = labeled.slice(-10);

  return (
    <div style={{ background: "#0b0f1a", color: "white", minHeight: "100vh", padding: 24, fontFamily: "Arial" }}>
      <h1>AI Trading Dashboard</h1>

      <div style={{ marginTop: 10 }}>
        <strong>BTCUSD:</strong> {price ? `$${price}` : "Loading..."}
      </div>

      <div style={{ marginTop: 10 }}>
        <strong>Structure Bias:</strong> {bias}
      </div>

      <div style={{ marginTop: 18, background: "#111827", padding: 16, borderRadius: 10 }}>
        <div style={{ fontWeight: "bold", marginBottom: 10 }}>Last Swings (HH/HL/LH/LL)</div>

        {last10.length === 0 ? (
          <div style={{ color: "#9ca3af" }}>Waiting for enough candles to detect swings…</div>
        ) : (
          last10.map((s, i) => (
            <div key={i} style={{ padding: "6px 0", borderBottom: i === last10.length - 1 ? "none" : "1px solid #1f2937" }}>
              <strong>{s.label}</strong> — {s.type === "H" ? "High" : "Low"} @ {s.price.toFixed(2)}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
